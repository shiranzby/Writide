import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { spawn } from 'node:child_process';
import { createLocalImageService } from './server/local-image-service.mjs';
import { createWebdavService, webdavError } from './server/webdav-service.mjs';
import { createCredentialStore } from './server/webdav-credentials.mjs';
import { writeWorkspaceFile } from './server/workspace-file-write.mjs';
import { createImageCache } from './server/webdav-image-cache.mjs';
import { homedir } from 'node:os';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.join(projectRoot, 'Workspace');
/* Keep app bookkeeping outside the user-visible workspace. The workspace may
   then be truly empty, while revisions and deletion tombstones remain durable. */
const metadataPath = path.join(projectRoot, '.typora-web-workspace-state.json');
const legacyMetadataPath = path.join(workspaceRoot, '.typora-web.json');
const port = Number(process.env.PORT || 5173);
const localImageToken = randomUUID();
const davToken = randomUUID();
const webdav = createWebdavService({
  credentials: createCredentialStore(process.env.PLAYWRIGHT_TEST_SERVER ? path.join(projectRoot, 'test-results', 'webdav-test.dpapi') : undefined),
  imageCache: createImageCache({ directory: process.env.WRITIDE_CACHE_DIR || process.env.INKQUAY_CACHE_DIR || (process.env.PLAYWRIGHT_TEST_SERVER
    ? path.join(projectRoot, 'test-results', 'image-cache') : path.join(homedir(), '.writide', 'image-cache')) }),
});
const localImages = createLocalImageService({ workspaceRoot, reveal: file => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') return reject(new Error('当前本地桥接仅支持Windows资源管理器'));
  const child = spawn('explorer.exe', ['/select,', file], { windowsHide: true, stdio: 'ignore' });
  child.once('error', reject); child.once('spawn', resolve);
}) });
/* PUT requests can arrive from pagehide while a new page or test is seeding
   the workspace. Serialize the revision check together with all file writes;
   otherwise two requests can both validate the same revision and overwrite
   each other's Markdown bytes. */
let workspaceSaveQueue = Promise.resolve();

await mkdir(workspaceRoot, { recursive: true });

const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function safeName(value, fallback) {
  const cleaned = String(value || '').replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || fallback;
}

function uniqueName(name, used, suffix) {
  let result = name;
  if (used.has(result.toLocaleLowerCase())) result = name + '-' + suffix.slice(0, 6);
  used.add(result.toLocaleLowerCase());
  return result;
}

function buildLayout(workspace) {
  const folderPaths = new Map();
  const managedFiles = [];
  const managedFolders = [];
  const managedFolderEntries = [];
  const visit = parentId => {
    const parentPath = parentId ? folderPaths.get(parentId) : '';
    const used = new Set();
    for (const folder of workspace.folders.filter(item => item.parentId === parentId)) {
      const diskName = uniqueName(safeName(folder.name, 'Folder'), used, folder.id);
      const rp = path.join(parentPath, diskName);
      folderPaths.set(folder.id, rp);
      managedFolders.push(rp);
      managedFolderEntries.push({ id: folder.id, relativePath: rp });
      visit(folder.id);
    }
    for (const document of workspace.documents.filter(item => item.parentId === parentId)) {
      const base = uniqueName(safeName(document.name, 'Untitled'), used, document.id);
      managedFiles.push({ id: document.id, relativePath: path.join(parentPath, base + '.md'), content: String(document.content || '') });
    }
  };
  visit(null);
  return { managedFiles, managedFolders, managedFolderEntries };
}

function readBodyJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(); reject(new Error('Body too large')); } chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function assetExtension(fileName, mime) {
  if (fileName) { const ext = path.extname(fileName).toLowerCase(); if (MIME_TYPES[ext]) return ext; }
  if (mime) { for (const [ext, mt] of Object.entries(MIME_TYPES)) { if (mt === mime) return ext; } }
  return '.png';
}

/* ── Resolve the on-disk folder+name for a document using same uniqueName logic as buildLayout ── */
function resolveDocPath(documentId, workspace) {
  const folderPaths = new Map();
  const visit = parentId => {
    const parentPath = parentId ? folderPaths.get(parentId) : '';
    const used = new Set();
    for (const f of workspace.folders.filter(f => f.parentId === parentId)) {
      const diskName = uniqueName(safeName(f.name, 'Folder'), used, f.id);
      const rp = parentId ? path.join(parentPath, diskName) : diskName;
      folderPaths.set(f.id, rp.replace(/\\/g, '/'));
      visit(f.id);
    }
  };
  visit(null);
  const doc = workspace.documents.find(d => d.id === documentId);
  if (!doc) return null;
  const usedDocNames = new Set();
  for (const sib of workspace.documents.filter(d => d.parentId === doc.parentId)) {
    if (sib.id === doc.id) continue;
    usedDocNames.add(safeName(sib.name, 'Untitled').toLowerCase());
  }
  const safeName2 = safeName(doc.name, 'Untitled');
  const docDiskName = usedDocNames.has(safeName2.toLowerCase())
    ? safeName2 + '-' + doc.id.slice(0, 6)
    : safeName2;
  const parentDiskPath = doc.parentId ? (folderPaths.get(doc.parentId) || '') : '';
  return { docDiskName, parentDiskPath };
}

async function saveAssetApi(req, res) {
  let body;
  try { body = await readBodyJson(req, 10 * 1024 * 1024); }
  catch (error) { return json(res, 400, { error: 'Invalid request body' }); }
  if (!body || typeof body !== 'object') return json(res, 400, { error: 'Invalid request body' });
  const { documentId, fileName, mime, pathMode = 'document-assets', customPath = '' } = body;
  let raw = body.data;
  if (!documentId || typeof raw !== 'string' || !raw) return json(res, 400, { error: 'Missing documentId or data' });
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    if (comma < 0) return json(res, 400, { error: 'Invalid image data' });
    raw = raw.slice(comma + 1);
  }
  raw = raw.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) return json(res, 400, { error: 'Invalid image data' });
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) return json(res, 400, { error: 'Empty image data' });
  if (!['current', 'assets', 'document-assets', 'custom'].includes(pathMode)) return json(res, 400, { error: 'Invalid asset path mode' });
  /* Compute document's folder path using same uniqueName logic as buildLayout */
  const stored = await readMetadata();
  let safeDocName, docFolder = '';
  if (stored?.workspace?.documents) {
    const resolved = resolveDocPath(documentId, stored.workspace);
    if (!resolved) return json(res, 404, { error: 'Document not found' });
    safeDocName = resolved.docDiskName;
    docFolder = resolved.parentDiskPath;
  } else {
    safeDocName = safeName('doc-' + documentId.slice(0, 8), 'Untitled');
  }
  const customParts = String(customPath).split(/[\\/]+/).filter(part => part && part !== '.' && part !== '..').map(part => safeName(part, 'images')).slice(0, 6);
  const targetDirName = pathMode === 'current' ? '' : pathMode === 'assets' ? 'assets' : pathMode === 'custom' && customParts.length ? path.join(...customParts) : safeDocName + '.assets';
  const assetsDir = path.resolve(workspaceRoot, docFolder, targetDirName);
  const workspacePrefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (assetsDir !== workspaceRoot && !assetsDir.startsWith(workspacePrefix)) return json(res, 400, { error: 'Invalid asset path' });
  await mkdir(assetsDir, { recursive: true });

  const ext = assetExtension(fileName, mime);
  const baseName = fileName ? path.basename(fileName, path.extname(fileName)) : 'image';
  const uniqueImgName = baseName + '-' + Date.now() + ext;
  const targetPath = path.join(assetsDir, uniqueImgName);
  await writeFile(targetPath, buffer);
  /* Return path relative to workspace root so browser can resolve it via .assets/ handler */
  const urlPath = (docFolder ? docFolder.replace(/\\/g, '/') + '/' : '') + (targetDirName ? targetDirName.replace(/\\/g, '/') + '/' : '') + uniqueImgName;
  const documentRelativePath = './' + (targetDirName ? targetDirName.replace(/\\/g, '/') + '/' : '') + uniqueImgName;
  json(res, 200, { relativePath: './' + urlPath, documentRelativePath });
}

async function serveWorkspaceAsset(pathname, res) {
  const relativePart = pathname.replace(/^\/+/, '');
  const fullPath = path.resolve(workspaceRoot, relativePart);
  const rootWithSeparator = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  if (fullPath !== workspaceRoot && !fullPath.startsWith(rootWithSeparator)) return false;
  try {
    const stats = await stat(fullPath);
    if (!stats.isFile()) return false;
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await readFile(fullPath);
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stats.size, 'Cache-Control': 'no-cache' });
    res.end(data);
    return true;
  } catch { return false; }
}

async function readMetadata() {
  try { return JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch {
    try { return JSON.parse(await readFile(legacyMetadataPath, 'utf8')); }
    catch { return null; }
  }
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLocaleLowerCase();
}

async function scanWorkspace(stored = null) {
  const folders = [];
  const documents = [];
  const storedLayout = stored?.workspace ? buildLayout(stored.workspace) : null;
  const storedFolders = new Map((storedLayout?.managedFolderEntries || []).map(item => [normalizeRelativePath(item.relativePath), item.id]));
  const removedFilePaths = new Set((stored?.externallyRemovedFiles || []).map(item => normalizeRelativePath(item.relativePath)));
  const removedFolderPaths = new Set((stored?.externallyRemovedFolders || []).map(item => normalizeRelativePath(item.relativePath)));
  const storedFiles = new Map((storedLayout?.managedFiles || [])
    .filter(item => !removedFilePaths.has(normalizeRelativePath(item.relativePath)) && ![...removedFolderPaths].some(folder => isSameOrChildPath(item.relativePath, folder)))
    .map(item => [normalizeRelativePath(item.relativePath), item.id]));
  async function visit(relativePath, parentId) {
    const entries = await readdir(path.join(workspaceRoot, relativePath), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      if (entry.name.startsWith('.')) continue;
      const childPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.assets')) continue;
        const folder = { id: storedFolders.get(normalizeRelativePath(childPath)) || randomUUID(), name: entry.name, parentId, expanded: true };
        folders.push(folder); await visit(childPath, folder.id);
      } else if (entry.isFile() && /\.(md|markdown|txt)$/i.test(entry.name)) {
        const info = await stat(path.join(workspaceRoot, childPath));
        const extension = entry.name.match(/\.(md|markdown|txt)$/i)?.[0] || '.md';
        documents.push({ id: storedFiles.get(normalizeRelativePath(childPath)) || randomUUID(), name: entry.name.slice(0, -extension.length), content: await readFile(path.join(workspaceRoot, childPath), 'utf8'), parentId, updatedAt: info.mtimeMs, sourcePath: childPath.replace(/\\/g, '/'), sourceExtension: extension });
      }
    }
  }
  await visit('', null);
  const activeId = stored?.workspace?.activeId && documents.some(document => document.id === stored.workspace.activeId)
    ? stored.workspace.activeId
    : documents[0]?.id || null;
  const activeFolderId = stored?.workspace?.activeFolderId && folders.some(folder => folder.id === stored.workspace.activeFolderId)
    ? stored.workspace.activeFolderId
    : documents.find(document => document.id === activeId)?.parentId || null;
  return { documents, folders, activeId, activeFolderId, _revision: Number(stored?.revision) || 0 };
}

async function pathExists(relativePath, type) {
  try {
    const info = await stat(path.join(workspaceRoot, relativePath));
    return type === 'folder' ? info.isDirectory() : info.isFile();
  } catch { return false; }
}

function isSameOrChildPath(candidate, parent) {
  const normalizedCandidate = normalizeRelativePath(candidate);
  const normalizedParent = normalizeRelativePath(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(normalizedParent + '/');
}

async function discardExternallyRemovedEntries(workspace, old) {
  const oldLayout = old?.workspace ? buildLayout(old.workspace) : { managedFiles: [], managedFolderEntries: [] };
  const externallyRemovedFiles = new Map((old?.externallyRemovedFiles || []).map(item => [item.id, { id: item.id, relativePath: item.relativePath }]));
  const externallyRemovedFolders = new Map((old?.externallyRemovedFolders || []).map(item => [item.id, { id: item.id, relativePath: item.relativePath }]));
  const missingFiles = new Set((await Promise.all((old?.managedFiles || []).map(async relativePath => ({ relativePath, missing: !(await pathExists(relativePath, 'file')) })))).filter(item => item.missing).map(item => normalizeRelativePath(item.relativePath)));
  const missingFolders = new Set((await Promise.all((old?.managedFolders || []).map(async relativePath => ({ relativePath, missing: !(await pathExists(relativePath, 'folder')) })))).filter(item => item.missing).map(item => normalizeRelativePath(item.relativePath)));
  for (const item of oldLayout.managedFiles) if (missingFiles.has(normalizeRelativePath(item.relativePath))) externallyRemovedFiles.set(item.id, { id: item.id, relativePath: item.relativePath });
  for (const item of oldLayout.managedFolderEntries) if (missingFolders.has(normalizeRelativePath(item.relativePath))) externallyRemovedFolders.set(item.id, { id: item.id, relativePath: item.relativePath });

  const layout = buildLayout(workspace);
  const removedIds = new Set();
  for (const item of layout.managedFiles) {
    const document = workspace.documents.find(value => value.id === item.id);
    const sourcePath = document?.sourcePath;
    const isNewDocument = !sourcePath;
    if ((externallyRemovedFiles.has(item.id) && !isNewDocument) || (!isNewDocument && missingFiles.has(normalizeRelativePath(item.relativePath))) || [...missingFolders].some(folder => isSameOrChildPath(item.relativePath, folder)) || (sourcePath && !(await pathExists(sourcePath, 'file')))) {
      removedIds.add(item.id);
      externallyRemovedFiles.set(item.id, { id: item.id, relativePath: item.relativePath });
    }
  }
  const removedFolderIds = new Set();
  for (const item of layout.managedFolderEntries) {
    const folder = workspace.folders.find(value => value.id === item.id);
    const sourcePath = folder?.sourcePath;
    const isNewFolder = !sourcePath;
    if ((externallyRemovedFolders.has(item.id) && !isNewFolder) || (!isNewFolder && missingFolders.has(normalizeRelativePath(item.relativePath))) || (sourcePath && !(await pathExists(sourcePath, 'folder')))) {
      removedFolderIds.add(item.id);
      externallyRemovedFolders.set(item.id, { id: item.id, relativePath: item.relativePath });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of workspace.folders) {
      if (removedFolderIds.has(folder.id) || !removedFolderIds.has(folder.parentId)) continue;
      removedFolderIds.add(folder.id); changed = true;
    }
  }
  for (const document of workspace.documents) if (removedFolderIds.has(document.parentId)) removedIds.add(document.id);
  for (const folder of workspace.folders) {
    if (removedFolderIds.has(folder.id)) externallyRemovedFolders.set(folder.id, { id: folder.id, relativePath: layout.managedFolderEntries.find(item => item.id === folder.id)?.relativePath || folder.sourcePath || folder.name });
  }
  for (const document of workspace.documents) {
    if (removedFolderIds.has(document.parentId)) {
      removedIds.add(document.id);
      externallyRemovedFiles.set(document.id, { id: document.id, relativePath: layout.managedFiles.find(item => item.id === document.id)?.relativePath || document.sourcePath || document.name });
    }
  }
  /* A document without sourcePath is an explicit new document. It may reuse a
     filename whose previous resource was removed, but never clears a tombstone
     for the same old ID. */
  for (const item of layout.managedFiles) {
    const document = workspace.documents.find(value => value.id === item.id);
    if (!document?.sourcePath) {
      for (const [id, removed] of externallyRemovedFiles) if (id !== item.id && normalizeRelativePath(removed.relativePath) === normalizeRelativePath(item.relativePath)) externallyRemovedFiles.delete(id);
    }
  }
  for (const item of layout.managedFolderEntries) {
    const folder = workspace.folders.find(value => value.id === item.id);
    if (!folder?.sourcePath) {
      for (const [id, removed] of externallyRemovedFolders) if (id !== item.id && normalizeRelativePath(removed.relativePath) === normalizeRelativePath(item.relativePath)) externallyRemovedFolders.delete(id);
    }
  }
  if (!removedIds.size && !removedFolderIds.size) return { workspace, externallyRemovedFiles: [...externallyRemovedFiles.values()], externallyRemovedFolders: [...externallyRemovedFolders.values()] };

  const folders = workspace.folders.filter(folder => !removedFolderIds.has(folder.id));
  const folderIds = new Set(folders.map(folder => folder.id));
  const documents = workspace.documents.filter(document => !removedIds.has(document.id) && (!document.parentId || folderIds.has(document.parentId)));
  const activeId = documents.some(document => document.id === workspace.activeId) ? workspace.activeId : documents[0]?.id || null;
  const activeFolderId = folders.some(folder => folder.id === workspace.activeFolderId) ? workspace.activeFolderId : documents.find(document => document.id === activeId)?.parentId || null;
  return {
    workspace: { ...workspace, documents, folders, activeId, activeFolderId },
    externallyRemovedFiles: [...externallyRemovedFiles.values()],
    externallyRemovedFolders: [...externallyRemovedFolders.values()],
  };
}

async function saveWorkspace(workspace) {
  if (!Array.isArray(workspace.documents) || !Array.isArray(workspace.folders)) throw new Error('Invalid workspace data');
  const folderIds = new Set(workspace.folders.map(folder => folder.id));
  const documentIds = new Set(workspace.documents.map(document => document.id));
  if (folderIds.size !== workspace.folders.length || documentIds.size !== workspace.documents.length) throw new Error('Duplicate workspace ids');
  if (workspace.folders.some(folder => folder.parentId && !folderIds.has(folder.parentId)) || workspace.documents.some(document => document.parentId && !folderIds.has(document.parentId))) throw new Error('Invalid workspace parent');
  for (const folder of workspace.folders) {
    const seen = new Set([folder.id]); let parentId = folder.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error('Workspace folder cycle');
      seen.add(parentId); parentId = workspace.folders.find(item => item.id === parentId)?.parentId || null;
    }
  }
  const old = await readMetadata();
  const expectedRevision = Number.isInteger(workspace._revision) ? workspace._revision : null;
  const currentRevision = Number(old?.revision) || 0;
  /* Once a manifest exists, every write must carry the revision observed by
     the caller. An unversioned pagehide snapshot is stale by definition and
     must not be allowed to resurrect or overwrite a newer workspace. */
  if (old && (expectedRevision === null || expectedRevision !== currentRevision)) {
    const error = new Error('Workspace changed externally');
    error.code = 'WORKSPACE_CONFLICT';
    throw error;
  }
  const { _revision: ignoredRevision, ...cleanWorkspace } = workspace;
  workspace = cleanWorkspace;
  const discarded = await discardExternallyRemovedEntries(workspace, old);
  workspace = discarded.workspace;
  const layout = buildLayout(workspace);
  const previousPaths = new Map(old?.workspace ? buildLayout(old.workspace).managedFiles.map(file => [file.id, file.relativePath]) : []);
  for (const folder of layout.managedFolders) await mkdir(path.join(workspaceRoot, folder), { recursive: true });
  for (const file of layout.managedFiles) {
    const target = path.join(workspaceRoot, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    /* Avoid rewriting unchanged source files. Besides reducing latency for a
       large mapped workspace, this preserves the original file metadata and
       makes a save observationally a no-op when Markdown content is unchanged. */
    const renamed = previousPaths.has(file.id) && previousPaths.get(file.id) !== file.relativePath;
    await writeWorkspaceFile(target, String(file.content ?? ''), renamed);
  }
  const nextFiles = new Set(layout.managedFiles.map(item => item.relativePath.toLocaleLowerCase()));
  for (const rp of old?.managedFiles || []) {
    if (!nextFiles.has(rp.toLocaleLowerCase())) await rm(path.join(workspaceRoot, rp), { force: true }).catch(() => {});
  }
  const nextFolders = new Set(layout.managedFolders.map(item => item.toLocaleLowerCase()));
  const oldFolders = [...(old?.managedFolders || [])].sort((a, b) => b.length - a.length);
  for (const rp of oldFolders) {
    if (!nextFolders.has(rp.toLocaleLowerCase())) await rmdir(path.join(workspaceRoot, rp)).catch(() => {});
  }
  const revision = currentRevision + 1;
  const manifest = {
    workspace,
    managedFiles: layout.managedFiles.map(item => item.relativePath),
    managedFolders: layout.managedFolders,
    externallyRemovedFiles: discarded.externallyRemovedFiles,
    externallyRemovedFolders: discarded.externallyRemovedFolders,
    revision,
  };
  const tempPath = metadataPath + '.tmp';
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tempPath, metadataPath);
  /* Migrate the pre-mapping manifest out of Workspace on the first save. */
  await rm(legacyMetadataPath, { force: true }).catch(() => {});
  return { ...workspace, _revision: revision };
}

function queueWorkspaceSave(workspace) {
  const pending = workspaceSaveQueue.then(() => saveWorkspace(workspace));
  workspaceSaveQueue = pending.catch(() => {});
  return pending;
}

async function workspaceApi(req, res) {
  if (req.method === 'GET') {
    const stored = await readMetadata();
    return json(res, 200, await scanWorkspace(stored));
  }
  if (req.method === 'PUT') {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 25 * 1024 * 1024) return json(res, 413, { error: 'Workspace is too large' }); chunks.push(chunk); }
    try {
      const savedWorkspace = await queueWorkspaceSave(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      return json(res, 200, { ok: true, workspace: savedWorkspace });
    } catch (error) {
      if (error.code === 'WORKSPACE_CONFLICT') return json(res, 409, { error: error.message, workspace: await scanWorkspace(await readMetadata()) });
      return json(res, 400, { error: error.message || 'Invalid workspace data' });
    }
  }
  return json(res, 405, { error: 'Method not allowed' });
}

/* The workspace is user data, not application source. Do not let Vite's
   development watcher observe files that the API creates, renames, or removes
   while scanning and saving a mapped workspace on Windows. */
const vite = await createViteServer({
  root: projectRoot,
  server: {
    middlewareMode: true,
    hmr: process.env.PLAYWRIGHT_TEST_SERVER === '1'
      ? { host: '127.0.0.1', port: 5188, clientPort: 5188 }
      : { host: '127.0.0.1', port: port + 1, clientPort: port + 1 },
    watch: process.env.PLAYWRIGHT_TEST_SERVER === '1'
      ? null
      : { ignored: [workspaceRoot, `${workspaceRoot}/**`] },
  },
  appType: 'spa',
});
const server = createHttpServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/api/webdav' || pathname === '/api/webdav/session') {
      const origin = `http://${req.headers.host}`;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)
          || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '仅接受本机同源页面' });
      res.setHeader('Cache-Control', 'no-store');
      if (pathname.endsWith('/session') && req.method === 'GET') return json(res, 200, { token: davToken, version: 4, features: { documentRename: true } });
      if (req.method !== 'POST' || req.headers['x-paper-dav-token'] !== davToken) return json(res, 403, { error: '本机连接授权无效' });
      try { return json(res, 200, await webdav.run(await readBodyJson(req, 29 * 1024 * 1024))); }
      catch (error) { return json(res, [401, 412, 429, 503].includes(error.status) ? error.status : 400, { error: webdavError(error), code: error.code, retryAt: error.retryAt }); }
    }
    if (pathname.startsWith('/api/local-images/')) {
      const origin = `http://127.0.0.1:${port}`;
      if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)
          || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '仅接受本地页面请求' });
      if (pathname === '/api/local-images/session' && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store'); return json(res, 200, { token: localImageToken });
      }
      if (req.method !== 'POST' || req.headers['x-paper-local-token'] !== localImageToken) return json(res, 403, { error: '本地操作授权无效' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 25 * 1024 * 1024) return json(res, 413, { error: '请求过大' }); chunks.push(chunk); }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = pathname === '/api/local-images/grant' ? await localImages.grant(body)
          : pathname === '/api/local-images/action' ? await localImages.run(body) : null;
        return json(res, result ? 200 : 404, result || { error: '未知操作' });
      } catch (error) { return json(res, 400, { error: error.code === 'EEXIST' ? '同名图片已存在，未覆盖' : error.message }); }
    }
    if (pathname === '/api/workspace') return await workspaceApi(req, res);
    if (pathname === '/api/assets' && req.method === 'POST') return await saveAssetApi(req, res);
    const decodedPath = decodeURI(pathname);
    if (decodedPath.includes('.assets/') || decodedPath.includes('/assets/') || MIME_TYPES[path.extname(decodedPath).toLowerCase()]) {
      const served = await serveWorkspaceAsset(decodedPath, res);
      if (served) return;
    }
    vite.middlewares(req, res, error => { if (error) { console.error(error); res.statusCode = 500; res.end('Internal server error'); } });
  } catch (error) { console.error(error); json(res, 500, { error: error.message }); }
});

server.listen(port, '127.0.0.1', () => {
  console.log('Writide: http://127.0.0.1:' + port);
  console.log('Workspace: ' + workspaceRoot);
});
