import MarkdownIt from 'markdown-it';
import { taskSourceAnchors } from './markdown-task-source.js';
import markdownItTaskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { openSearchPanel, closeSearchPanel, findNext, findPrevious, replaceNext, replaceAll } from '@codemirror/search';
import 'katex/dist/katex.min.css';
import { MarkdownDocumentModel, blockSourceRange, rawBlockStructuralPrefix, parseMarkdownTable, scanMarkdownImageRanges, upgradeSoftBreakToParagraph } from './markdown-model.js';
import { canvasBlockAtLine, createCanvasBlocks } from './markdown-canvas.js';
import { MarkdownUnifiedCanvas } from './markdown-unified-canvas.js';
import { saveDirectoryImage, renameDirectoryImage } from './markdown-image-files.js';
import { migrateDirectoryEntry, planDirectoryMoves } from './directory-migration.js';
import { webdavRequest, webdavHandle, resumeWebdav, rememberDavSession, DEFAULT_DAV_URL } from './webdav-workspace.js';
import { createWebdavDialog } from './webdav-dialog.js';
import { createDavTree } from './webdav-tree.js';
import { deferDavImage, createDavImageLoader, davImageReferences } from './webdav-images.js';
import { readWorkspaceSession, rememberWorkspace, restoreWorkspaceFile } from './workspace-session.js';
import { installEditorContextMenu, showResolvedEditorUrl } from './editor-context-menu.js';
import {
  createIcons, AlignLeft, Bold, CheckSquare, ChevronDown, Code2, Columns2,
  Copy, Download, File, FileCode2, FilePlus2, Files, Folder, FolderOpen, FolderPlus, Heading1, Heading2,
  Image, Italic, Link, List, ListOrdered, Maximize2, Menu, Minus, Moon,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pilcrow, Quote, Redo2,
  Search, Settings, Sigma, Strikethrough, Sun, Table2, Undo2, Underline, X, ChevronRight
} from 'lucide';
import './style.css';

const STORAGE_KEY = 'paper-workspace-v1';
const pendingImageInsertions = new Set();
const SETTINGS_KEY = 'paper-settings-v1';
const DIRECTORY_SESSION_KEY = 'paper-directory-session-v1';
const VIEW_STATE_KEY = 'paper-view-state-v1';
const defaultSettings = {
  theme: 'light', fontSize: 17, lineHeight: 1.75, contentWidth: 860,
  autosave: true, spellcheck: false, showLineNumbers: true, showToolbar: true, autoSpace: true,
  editorTheme: 'github', defaultCodeLanguage: 'plaintext', codeWrap: false, viewMode: 'typora',
  diagrams: true, inlineMath: true, highlights: true, alerts: true,
  autoUpload: true, indentSize: 2, autoIndent: true, matchBrackets: true,
  matchMarkdown: true, lineEnding: 'LF', imagePathMode: 'document-assets',
  imageCustomPath: '', relativeImage: true, dotImage: true, escapeImage: true,
  startupMode: 'last', lastDirectory: null, sidebarWidth: 272,
};

const welcome = `# 欢迎使用 Paper

一个专注写作的网页 Markdown 编辑器。

## Markdown 能力

- **粗体**、*斜体*、~~删除线~~ 与 \`行内代码\`
- [链接](https://typora.io)与图片
- [x] 任务列表
- [ ] 未完成任务

> 编辑时直接看到排版结果，也可以切换到源码模式。

## 代码块

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

## 表格

| 功能 | 状态 |
| --- | --- |
| 实时渲染 | 已支持 |
| 本地保存 | 已支持 |

## 数学公式

行内公式：$E = mc^2$

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

[^1]: 支持脚注、公式、表格、任务列表和围栏代码。
`;

function makeDocument(name, content = '', sourcePath = null, sourceExtension = '.md') {
  return { id: crypto.randomUUID(), name, content, parentId: null, updatedAt: Date.now(), sourcePath, sourceExtension, sourceLineEnding: detectLineEnding(content) };
}

function detectLineEnding(value) {
  const text = String(value ?? '');
  return text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
}

function sourceLineEnding(value) {
  return detectLineEnding(value);
}

function makeFolder(name, parentId = null) {
  return { id: crypto.randomUUID(), name, parentId, expanded: true };
}

function normalizeWorkspace(value) {
  if (!value || !Array.isArray(value.documents) || !Array.isArray(value.folders)) return null;
  value.documents.forEach(doc => {
    if (!('parentId' in doc)) doc.parentId = null;
    if (!('sourcePath' in doc)) doc.sourcePath = null;
    if (!('sourceExtension' in doc)) doc.sourceExtension = '.md';
    if (!('sourceLineEnding' in doc)) doc.sourceLineEnding = detectLineEnding(doc.content);
  });
  value.activeFolderId ??= null;
  if (value.activeId !== null && !value.documents.some(doc => doc.id === value.activeId)) value.activeId = value.documents[0]?.id || null;
  if (!value.folders.some(folder => folder.id === value.activeFolderId)) value.activeFolderId = value.documents.find(doc => doc.id === value.activeId)?.parentId || null;
  return value;
}

const PROVIDER_DB = 'paper-workspace-providers';
const PROVIDER_STORE = 'handles';
let workspaceProvider = { kind: 'server', id: 'server:Workspace', displayName: '本地工作区' };
let directoryHandle = null;
let pendingDirectoryHandle = null;
let directoryProviderSnapshot = new Map();
let directoryRemovedEntries = new Set();
let directoryDirtyDocuments = new Set();
let directorySaveChain = Promise.resolve();
let serverSaveChain = Promise.resolve();
let serverSaveRevision = 0;
let workspaceDirty = false;
let davStartupError = null;

async function loadWorkspace() {
  const previous = readWorkspaceSession();
  const empty = () => ({ documents: [], folders: [], activeId: null, activeFolderId: null });
  const restore = value => restoreWorkspaceFile(value, settings.startupMode, previous);
  if (settings.startupMode === 'new') {
    workspaceProvider = { kind: 'browser', id: `browser:${crypto.randomUUID()}`, displayName: '新工作区（浏览器）' };
    return empty();
  }
  if (previous?.provider.kind === 'browser') {
    workspaceProvider = previous.provider;
    try { return restore(normalizeWorkspace(JSON.parse(localStorage.getItem(workspaceProvider.id))) || empty()); }
    catch { return empty(); }
  }
  if (previous?.provider.webdav) {
    const config = { ...previous.provider.webdav, session: sessionStorage.getItem('paper-webdav-session') };
    workspaceProvider = { ...previous.provider, kind: 'directory-pending' };
    try {
      await resumeWebdav(config, !config.session);
      const handle = webdavHandle(config);
      const scanned = await scanDirectoryHandle(handle);
      if (settings.startupMode === 'last') await handle.davTree.restorePath(previous.lastFile?.path);
      directoryHandle = handle;
      directoryProviderSnapshot = scanned.snapshot;
      workspaceProvider.kind = 'directory';
      return restore(scanned.workspace);
    } catch (error) { davStartupError = error; }
    return empty();
  }
  if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') {
    const handle = await readStoredDirectoryHandle();
    if (handle?.queryPermission) {
      pendingDirectoryHandle = handle;
      try {
        if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
          const scanned = await scanDirectoryHandle(handle);
          if (scanned) {
            directoryHandle = handle;
            pendingDirectoryHandle = null;
            sessionStorage.setItem(DIRECTORY_SESSION_KEY, '1');
            directoryProviderSnapshot = scanned.snapshot;
            workspaceProvider = { kind: 'directory', id: `directory:${handle.name}`, displayName: handle.name };
            return restore(scanned.workspace);
          }
        }
      } catch (error) { console.warn('读取已保存目录工作区失败:', error); }
    }
  }
  /* Once a page has entered a mapped-directory session, an unavailable handle
     is an empty mapped state, never permission to read the server Workspace. */
  if (pendingDirectoryHandle || sessionStorage.getItem(DIRECTORY_SESSION_KEY) === '1') {
    workspaceProvider = { kind: 'directory-pending', id: 'directory:pending', displayName: pendingDirectoryHandle?.name || '目录工作区' };
    return { documents: [], folders: [], activeId: null, activeFolderId: null };
  }
  try {
    const response = await fetch('/api/workspace');
    if (response.ok) {
      const remote = normalizeWorkspace(await response.json());
      /* The server is authoritative for the default workspace, including an empty directory. */
      if (remote) {
        localStorage.removeItem(STORAGE_KEY);
        return restore(remote);
      }
    }
  } catch { /* The static build can still work without the local server. */ }
  /* A failed server request must never promote an old browser snapshot back to a file. */
  return { documents: [], folders: [], activeId: null, activeFolderId: null };
}

function loadSettings() {
  try { return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) }; }
  catch { return { ...defaultSettings }; }
}

let settings = loadSettings();
if (settings.startupMode === 'directory') settings.startupMode = 'last-directory';
let workspace = await loadWorkspace();
let openTabs = workspace.activeId ? [workspace.activeId] : [];
const tabViewStates = new Map();
try {
  const saved = JSON.parse(sessionStorage.getItem(VIEW_STATE_KEY) || '{}');
  Object.entries(saved).forEach(([id, state]) => { if (state && typeof state === 'object') tabViewStates.set(id, state); });
} catch { /* A malformed session state must not prevent the editor from opening. */ }
let saveTimer;
let davRecoveryTimer, davRecovering = false, davRecoveryAttempts = 0, davRetryAt = 0;
let menuCloseTimer;
/* The Markdown document is owned by CodeMirror. Preview never edits it. */
let contextTarget = null;
let tableContextTarget = null;

function stableProviderId(kind, relativePath) {
  let hash = 2166136261;
  for (const char of `${kind}:${relativePath}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${kind}-${(hash >>> 0).toString(16)}`;
}

function providerSegment(value, fallback) {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || fallback;
}

function normalizeProviderPath(value) { return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }

function openProviderDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    const request = indexedDB.open(PROVIDER_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PROVIDER_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeDirectoryHandle(handle) {
  try {
    const db = await openProviderDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PROVIDER_STORE, 'readwrite');
      tx.objectStore(PROVIDER_STORE).put(handle, 'active-directory');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* A session-only directory mapping is still useful. */ }
}

async function readStoredDirectoryHandle() {
  try {
    const db = await openProviderDb();
    if (!db) return null;
    const handle = await new Promise((resolve, reject) => {
      const request = db.transaction(PROVIDER_STORE).objectStore(PROVIDER_STORE).get('active-directory');
      request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  } catch { return null; }
}

async function getDirectoryHandleAtPath(relativePath, create = false) {
  if (!directoryHandle) throw new Error('目录工作区尚未打开');
  let current = directoryHandle;
  for (const part of normalizeProviderPath(relativePath).split('/').filter(Boolean)) current = await current.getDirectoryHandle(part, { create });
  return current;
}

async function writeDirectoryFile(relativePath, content) {
  const normalized = normalizeProviderPath(relativePath);
  const parts = normalized.split('/').filter(Boolean);
  const fileName = parts.pop();
  const parent = await getDirectoryHandleAtPath(parts.join('/'), true);
  const file = await parent.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(String(content ?? ''));
  await writable.close();
}

async function scanDirectoryPaths(handle) {
  const snapshot = new Map();
  async function visit(current, parentPath = '') {
    for await (const [name, entry] of current.entries()) {
      if (name.startsWith('.')) continue;
      const relativePath = normalizeProviderPath(parentPath ? `${parentPath}/${name}` : name);
      if (entry.kind === 'directory') {
        if (name.endsWith('.assets')) continue;
        snapshot.set(stableProviderId('folder', relativePath), { type: 'folder', path: relativePath });
        await visit(entry, relativePath);
      } else if (entry.kind === 'file' && /\.(md|markdown|txt)$/i.test(name)) {
        snapshot.set(stableProviderId('document', relativePath), { type: 'document', path: relativePath });
      }
    }
  }
  await visit(handle);
  return snapshot;
}

async function removeDirectoryEntry(relativePath, recursive = false) {
  const parts = normalizeProviderPath(relativePath).split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return;
  const parent = await getDirectoryHandleAtPath(parts.join('/'), false);
  await parent.removeEntry(name, { recursive });
}

async function directoryEntryExists(relativePath, type) {
  const parts = normalizeProviderPath(relativePath).split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return false;
  try {
    const parent = await getDirectoryHandleAtPath(parts.join('/'), false);
    if (type === 'folder') await parent.getDirectoryHandle(name, { create: false });
    else await parent.getFileHandle(name, { create: false });
    return true;
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
    return false;
  }
}

function buildDirectoryLayout(value) {
  const folderPaths = new Map();
  const documents = [];
  const folders = [];
  const visit = parentId => {
    const parentPath = folderPaths.get(parentId) || '';
    const used = new Set();
    value.folders.filter(folder => folder.parentId === parentId).forEach(folder => {
      let name = providerSegment(folder.name, 'Folder');
      if (used.has(name.toLocaleLowerCase())) name += '-' + folder.id.slice(0, 6);
      used.add(name.toLocaleLowerCase());
      const relativePath = normalizeProviderPath(parentPath ? `${parentPath}/${name}` : name);
      folderPaths.set(folder.id, relativePath);
      folders.push({ id: folder.id, relativePath });
      visit(folder.id);
    });
    value.documents.filter(document => document.parentId === parentId).forEach(document => {
      let name = providerSegment(document.name, 'Untitled');
      if (used.has(name.toLocaleLowerCase())) name += '-' + document.id.slice(0, 6);
      used.add(name.toLocaleLowerCase());
      const extension = /^\.(md|markdown|txt)$/i.test(document.sourceExtension || '') ? document.sourceExtension : '.md';
      const relativePath = normalizeProviderPath(parentPath ? `${parentPath}/${name}${extension}` : `${name}${extension}`);
      documents.push({ id: document.id, relativePath });
    });
  };
  visit(null);
  return { documents, folders };
}

function directoryLayoutMatchesSnapshot(layout) {
  const entries = [
    ...layout.folders.map(item => ({ ...item, type: 'folder' })),
    ...layout.documents.map(item => ({ ...item, type: 'document' })),
  ];
  if (directoryRemovedEntries.size || entries.length !== directoryProviderSnapshot.size) return false;
  return entries.every(item => {
    const previous = directoryProviderSnapshot.get(item.id);
    return previous?.type === item.type && normalizeProviderPath(previous.path) === item.relativePath;
  });
}

async function saveDirectoryWorkspace(value, dirtyDocumentIds = new Set()) {
  if (!directoryHandle || workspaceProvider.kind !== 'directory') return;
  if (directoryHandle.webdav) {
    // A partially loaded tree is not a deletion snapshot. Save only explicit edits.
    const paths = new Map();
    for (const folder of value.folders) {
      const previous = directoryProviderSnapshot.get(folder.id);
      const original = previous?.path.split('/').at(-1);
      if (original && (original !== folder.name || previous.path.split('/').slice(0, -1).join('/') !== (value.folders.find(item => item.id === folder.parentId)?.sourcePath || ''))) throw new Error('WebDAV暂不支持移动或重命名');
    }
    for (const item of [...value.folders, ...value.documents]) paths.set(item.id, item);
    for (const [id] of directoryProviderSnapshot) {
      if (!paths.has(id) && !workspace.folders.some(item => item.id === id) && !workspace.documents.some(item => item.id === id)) throw new Error('WebDAV暂不支持删除');
    }
    const parentPath = id => {
      if (!id) return '';
      const folder = paths.get(id);
      if (!folder) throw new Error('父目录尚未加载');
      return folder.sourcePath || [parentPath(folder.parentId), providerSegment(folder.name, 'Folder')].filter(Boolean).join('/');
    };
    for (const folder of value.folders) {
      if (directoryProviderSnapshot.has(folder.id)) continue;
      const path = parentPath(folder.id);
      await getDirectoryHandleAtPath(path, true);
      folder.sourcePath = path;
      const current = workspace.folders.find(item => item.id === folder.id);
      if (current) current.sourcePath = path;
      directoryProviderSnapshot.set(folder.id, { type: 'folder', path });
    }
    for (const doc of value.documents) {
      const previous = directoryProviderSnapshot.get(doc.id);
      const extension = doc.sourceExtension || '.md';
      if (previous && (previous.path.split('/').at(-1) !== doc.name + extension || previous.path.split('/').slice(0, -1).join('/') !== parentPath(doc.parentId))) throw new Error('WebDAV暂不支持移动或重命名');
      if (previous && !dirtyDocumentIds.has(doc.id)) continue;
      if (doc.webdavUnloaded) continue;
      const path = doc.sourcePath || [parentPath(doc.parentId), providerSegment(doc.name, 'Untitled') + extension].filter(Boolean).join('/');
      await directoryHandle.writeFileAtPath(path, preserveDocumentLineEndings(doc));
      doc.sourcePath = path;
      directoryProviderSnapshot.set(doc.id, { type: 'document', path });
    }
    return;
  }
  const plannedLayout = buildDirectoryLayout(value);
  const contentOnlySave = directoryLayoutMatchesSnapshot(plannedLayout);
  if (contentOnlySave) {
    for (const id of dirtyDocumentIds) {
      const previous = directoryProviderSnapshot.get(id);
      if (!previous || previous.type !== 'document') continue;
      if (await directoryEntryExists(previous.path, 'document')) continue;
      directoryRemovedEntries.add(id);
      throw new Error(`源文件已在外部删除：${previous.path}`);
    }
  } else {
    /* Structural operations need one fresh tree snapshot. Ordinary text saves
       probe only their target file so large mapped directories stay fast. */
    const currentPaths = new Set([...await scanDirectoryPaths(directoryHandle).then(snapshot => snapshot.values())]
      .map(item => normalizeProviderPath(item.path).toLocaleLowerCase()));
    for (const [id, previous] of directoryProviderSnapshot) {
      if (!currentPaths.has(normalizeProviderPath(previous.path).toLocaleLowerCase())) directoryRemovedEntries.add(id);
    }
  }
  const removedFolders = new Set([...directoryRemovedEntries].filter(id => directoryProviderSnapshot.get(id)?.type === 'folder'));
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of value.folders) {
      if (removedFolders.has(folder.id) || !removedFolders.has(folder.parentId)) continue;
      removedFolders.add(folder.id); directoryRemovedEntries.add(folder.id); changed = true;
    }
  }
  const folderIds = new Set(value.folders.filter(folder => !removedFolders.has(folder.id)).map(folder => folder.id));
  value = {
    ...value,
    folders: value.folders.filter(folder => !removedFolders.has(folder.id)),
    documents: value.documents.filter(document => !directoryRemovedEntries.has(document.id) && (!document.parentId || folderIds.has(document.parentId))),
  };
  const layout = buildDirectoryLayout(value);
  const moves = planDirectoryMoves(layout, directoryProviderSnapshot);
  for (const move of moves) {
    const result = await migrateDirectoryEntry(directoryHandle, move);
    for (const [id, previous] of directoryProviderSnapshot) {
      if (previous.path !== move.from && !(move.kind === 'directory' && previous.path.startsWith(move.from + '/'))) continue;
      const path = move.to + previous.path.slice(move.from.length);
      directoryProviderSnapshot.set(id, { ...previous, path });
      const doc = value.documents.find(item => item.id === id);
      if (doc) doc.sourcePath = path;
    }
    if (result.retained.length) alert(`迁移目标已校验。部分源内容有变化或无法清理，已保留，请检查：${move.from}`);
  }
  const nextSnapshot = new Map();
  for (const folder of layout.folders) {
    const previous = directoryProviderSnapshot.get(folder.id);
    if (!previous || previous.path !== folder.relativePath) await getDirectoryHandleAtPath(folder.relativePath, true);
    nextSnapshot.set(folder.id, { type: 'folder', path: folder.relativePath });
  }
  for (const item of layout.documents) {
    const doc = value.documents.find(document => document.id === item.id);
    const previous = directoryProviderSnapshot.get(item.id)?.path || doc.sourcePath;
    const pathChanged = Boolean(previous && normalizeProviderPath(previous) !== item.relativePath);
    if (!previous || pathChanged || dirtyDocumentIds.has(item.id)) {
      await writeDirectoryFile(item.relativePath, preserveDocumentLineEndings(doc));
    }
    doc.sourcePath = item.relativePath;
    nextSnapshot.set(item.id, { type: 'document', path: item.relativePath });
  }
  for (const [id, previous] of directoryProviderSnapshot) {
    if (nextSnapshot.has(id)) continue;
    try { await removeDirectoryEntry(previous.path, previous.type === 'folder'); } catch { /* Already absent. */ }
  }
  directoryProviderSnapshot = nextSnapshot;
}

function queueDirectorySave() {
  const snapshot = JSON.parse(JSON.stringify(workspace));
  const dirtyDocumentIds = new Set(directoryDirtyDocuments);
  const pending = directorySaveChain.then(async () => {
    await saveDirectoryWorkspace(snapshot, dirtyDocumentIds);
    for (const saved of snapshot.documents) {
      const current = workspace.documents.find(document => document.id === saved.id);
      if (current && current.name === saved.name && current.parentId === saved.parentId) current.sourcePath = saved.sourcePath;
    }
    rememberWorkspace(workspaceProvider, workspace);
    for (const id of dirtyDocumentIds) {
      const current = workspace.documents.find(document => document.id === id);
      const saved = snapshot.documents.find(document => document.id === id);
      if (current && saved && current.content === saved.content) directoryDirtyDocuments.delete(id);
    }
  });
  directorySaveChain = pending.catch(error => {
    console.error('目录工作区保存失败:', error);
  });
  return pending;
}

function preserveDocumentLineEndings(doc) {
  const newline = doc?.sourceLineEnding || sourceLineEnding(doc?.content);
  return String(doc?.content ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, newline);
}


document.querySelector('#app').innerHTML = `
  <div class="app-shell">
    <header class="app-header">
      <button class="icon-button mobile-menu" data-command="toggle-sidebar-mobile" title="显示侧边栏"><i data-lucide="menu"></i></button>
      <nav class="menu-bar" aria-label="应用菜单">
        <button class="menu-trigger" data-menu="file">文件</button>
        <button class="menu-trigger" data-menu="edit">编辑</button>
        <button class="menu-trigger" data-menu="paragraph">段落</button>
        <button class="menu-trigger" data-menu="format">格式</button>
        <button class="menu-trigger" data-menu="view">视图</button>
      </nav>
      <div id="document-tabs" class="document-tabs" role="tablist" aria-label="打开的文档"></div>
      <div id="save-state" class="header-save-state">已保存</div>
      <div class="header-actions">
        <button class="icon-button" data-command="toggle-focus" title="专注模式"><i data-lucide="maximize-2"></i></button>
        <button id="theme-toggle" class="icon-button" data-command="toggle-theme" title="切换到暗色模式" aria-label="切换到暗色模式"><i data-lucide="moon"></i></button>
        <button class="icon-button" data-command="settings" title="偏好设置"><i data-lucide="settings"></i></button>
      </div>
    </header>

    <div id="menu-popover" class="menu-popover" hidden></div>

    <main class="workspace">
      <aside id="sidebar" class="sidebar">
        <div class="sidebar-tabs" role="tablist">
          <button class="sidebar-tab active" data-panel="files">文件</button>
          <button class="sidebar-tab" data-panel="outline">大纲</button>
          <span class="sidebar-spacer"></span>
          <button class="icon-button compact" data-command="search" title="搜索文档"><i data-lucide="search"></i></button>
          <button class="icon-button compact" data-command="new-folder" title="新建文件夹"><i data-lucide="folder-plus"></i></button>
          <button class="icon-button compact" data-command="new" title="新建文档"><i data-lucide="file-plus-2"></i></button>
        </div>
        <div id="search-wrap" class="search-wrap" hidden>
          <i data-lucide="search"></i><input id="document-search" placeholder="搜索文件" />
        </div>
        <section id="files-panel" class="sidebar-panel active">
          <button id="workspace-root-drop" class="workspace-root-drop" type="button" title="本地工作区根目录">
            <i data-lucide="folder-open"></i><span>本地工作区</span>
          </button>
          <div id="file-list" class="file-list"></div>
        </section>
        <section id="outline-panel" class="sidebar-panel">
          <div class="panel-label">文档大纲</div>
          <div id="outline-list" class="outline-list"></div>
        </section>
        <footer class="sidebar-footer">
          <span id="document-count"></span>
          <button class="icon-button compact" data-command="settings" title="偏好设置"><i data-lucide="settings"></i></button>
        </footer>
      </aside>

      <div id="sidebar-resizer" class="sidebar-resizer" aria-hidden="true"></div>

      <section class="editor-pane">
        <div id="table-toolbar" class="table-toolbar" hidden>
          <button data-table-cmd="add-row-above" title="在上方插入行">↑行</button>
          <button data-table-cmd="add-row-below" title="在下方插入行">↓行</button>
          <span></span>
          <button data-table-cmd="add-col-left" title="在左侧插入列">←列</button>
          <button data-table-cmd="add-col-right" title="在右侧插入列">→列</button>
          <span></span>
          <button data-table-cmd="delete-row" title="删除行">✕行</button>
          <button data-table-cmd="delete-col" title="删除列">✕列</button>
        </div>
        <div class="format-toolbar" aria-label="格式工具栏">
          <button data-command="undo" title="撤销"><i data-lucide="undo-2"></i></button>
          <button data-command="redo" title="重做"><i data-lucide="redo-2"></i></button><span></span>
          <button data-command="h1" title="一级标题"><i data-lucide="heading-1"></i></button>
          <button data-command="h2" title="二级标题"><i data-lucide="heading-2"></i></button>
          <button data-command="bold" title="粗体"><i data-lucide="bold"></i></button>
          <button data-command="italic" title="斜体"><i data-lucide="italic"></i></button>
          <button data-command="underline" title="下划线"><i data-lucide="underline"></i></button>
          <button data-command="strike" title="删除线"><i data-lucide="strikethrough"></i></button><span></span>
          <button data-command="quote" title="引用"><i data-lucide="quote"></i></button>
          <button data-command="ul" title="无序列表"><i data-lucide="list"></i></button>
          <button data-command="ol" title="有序列表"><i data-lucide="list-ordered"></i></button>
          <button data-command="task" title="任务列表"><i data-lucide="check-square"></i></button>
          <button data-command="code" title="代码块"><i data-lucide="code-2"></i></button>
          <button data-command="table" title="表格"><i data-lucide="table-2"></i></button>
          <button data-command="link" title="链接"><i data-lucide="link"></i></button>
          <button data-command="image" title="图片"><i data-lucide="image"></i></button>
          <button data-command="math" title="数学公式"><i data-lucide="sigma"></i></button>
          <button class="toolbar-more" data-command="source" title="切换源码模式"><i data-lucide="file-code-2"></i></button>
        </div>
        <div class="editor-scroll">
          <div id="typora-view" hidden><div id="typora-editor" aria-label="仿 Typora Markdown 幕布编辑器"></div></div>
          <div id="split-view">
            <div id="split-editor" aria-label="Markdown 源码编辑器"></div>
            <article id="split-preview" class="markdown-preview" aria-label="Markdown 渲染预览"></article>
          </div>
        </div>
        <footer class="status-bar">
          <button data-command="toggle-sidebar"><i data-lucide="panel-left-close"></i><span>侧边栏</span></button>
          <button id="source-view-toggle" data-command="source" title="切换仅源码视图" aria-label="切换仅源码视图" aria-pressed="false"><i data-lucide="code-2"></i></button>
          <span class="status-fill"></span>
          <span id="image-cache-notice" hidden></span>
          <span id="cursor-mode">所见即所得</span>
          <span id="word-count">0 字</span>
          <span id="char-count">0 字符</span>
        </footer>
      </section>
    </main>
  </div>

  <div id="settings-dialog" class="dialog-backdrop" hidden>
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header><h2 id="settings-title">偏好设置</h2><button class="icon-button" data-command="close-settings" title="关闭"><i data-lucide="x"></i></button></header>
      <div class="settings-layout">
        <nav class="settings-nav">
          <button class="active" data-settings-tab="general">通用</button>
          <button data-settings-tab="editor">编辑器</button>
          <button data-settings-tab="appearance">外观</button>
          <button data-settings-tab="markdown">Markdown</button>
          <button data-settings-tab="images">图像</button>
          <button data-settings-tab="cache">缓存与网络</button>
        </nav>
        <div class="settings-content">
          <section class="settings-page active" data-settings-page="general">
            <h3>通用</h3><p>管理保存与启动行为。</p>
            <label class="setting-row"><span><b>自动保存</b><small>停止输入后保存到当前浏览器</small></span><input id="setting-autosave" type="checkbox" /></label>
            <label class="setting-row"><span><b>拼写检查</b><small>使用浏览器内置拼写检查</small></span><input id="setting-spellcheck" type="checkbox" /></label>
            <label class="select-row"><span><b>启动时</b></span><select id="setting-startup"><option value="last">打开上次工作区及最后文件</option><option value="new">打开新的工作区</option><option value="last-directory">打开上次工作区（不打开文件）</option></select></label>
            <div class="setting-row"><b>工作区</b><button data-command="open-webdav">连接 WebDAV…</button></div>
          </section>
          <section class="settings-page" data-settings-page="editor">
            <h3>编辑器</h3><p>调整正文的阅读和写作尺寸。</p>
            <label class="field-row"><span>字体大小</span><output id="font-size-value"></output><input id="setting-font-size" type="range" min="12" max="32" step="1" /></label>
            <label class="field-row"><span>行高</span><output id="line-height-value"></output><input id="setting-line-height" type="range" min="1.2" max="2.4" step="0.05" /></label>
            <label class="field-row"><span>内容宽度</span><output id="content-width-value"></output><input id="setting-content-width" type="range" min="560" max="1400" step="20" /></label>
            <label class="select-row"><span><b>默认缩进</b><small>源码编辑器和代码块的 Tab 宽度</small></span><select id="setting-indent-size"><option value="2">2 个空格</option><option value="3">3 个空格</option><option value="4">4 个空格</option><option value="5">5 个空格</option><option value="6">6 个空格</option></select></label>
            <label class="setting-row"><span><b>对齐缩进</b><small>输入列表或引用时自动延续缩进</small></span><input id="setting-auto-indent" type="checkbox" /></label>
            <label class="setting-row"><span><b>匹配括号和引号</b><small>输入成对字符时自动补全</small></span><input id="setting-match-brackets" type="checkbox" /></label>
            <label class="setting-row"><span><b>匹配 Markdown 字符</b><small>自动补全强调、代码和删除线标记</small></span><input id="setting-match-markdown" type="checkbox" /></label>
            <label class="select-row"><span><b>默认换行符</b><small>保存文档时使用的行尾格式</small></span><select id="setting-line-ending"><option value="LF">LF (Unix)</option><option value="CRLF">CRLF (Windows)</option></select></label>
          </section>
          <section class="settings-page" data-settings-page="appearance">
            <h3>外观</h3><p>选择应用界面的显示模式。</p>
            <label class="setting-row"><span><b>工具栏</b></span><input id="setting-toolbar" type="checkbox" /></label>
            <div class="theme-options">
              <button data-theme="light"><span class="theme-preview light"></span>浅色</button>
              <button data-theme="dark"><span class="theme-preview dark"></span>深色</button>
              <button data-theme="system"><span class="theme-preview system"></span>跟随系统</button>
            </div>
            <h4 class="settings-subtitle">编辑器主题</h4>
            <div class="editor-theme-options">
              <button data-editor-theme="github">GitHub</button><button data-editor-theme="whitey">Whitey</button>
              <button data-editor-theme="newsprint">Newsprint</button><button data-editor-theme="night">Night</button>
            </div>
          </section>
          <section class="settings-page" data-settings-page="markdown">
            <h3>Markdown</h3><p>配置扩展语法的渲染偏好。</p>
            <label class="setting-row"><span><b>代码块行号</b><small>在围栏代码块中显示行号</small></span><input id="setting-line-numbers" type="checkbox" /></label>
            <label class="setting-row"><span><b>中英文自动空格</b><small>改善混合文本的可读性</small></span><input id="setting-auto-space" type="checkbox" /></label>
            <label class="setting-row"><span><b>自动换行代码</b><small>长代码行换行显示</small></span><input id="setting-code-wrap" type="checkbox" /></label>
            <label class="select-row"><span><b>默认代码语言</b><small>使用快捷键插入代码块时应用</small></span><select id="setting-code-language"><option value="plaintext">纯文本</option><option value="javascript">JavaScript</option><option value="typescript">TypeScript</option><option value="python">Python</option><option value="java">Java</option><option value="go">Go</option><option value="rust">Rust</option><option value="bash">Shell</option><option value="json">JSON</option><option value="yaml">YAML</option></select></label>
            <label class="setting-row"><span><b>图表</b><small>渲染 Mermaid、Flowchart 等围栏代码</small></span><input id="setting-diagrams" type="checkbox" /></label>
            <label class="setting-row"><span><b>行内公式与高亮</b><small>启用 $公式$ 和 ==高亮== 扩展</small></span><input id="setting-extensions" type="checkbox" /></label>
            <div class="support-grid"><span>表格</span><span>任务列表</span><span>脚注</span><span>数学公式</span><span>流程图</span><span>代码高亮</span></div>
          </section>
          <section class="settings-page" data-settings-page="images">
            <h3>图像</h3><p>管理图片插入与存储方式。</p>
            <label class="select-row"><span><b>图片存储位置</b><small>上传图片的默认相对路径</small></span><select id="setting-image-path"><option value="current">当前文件夹</option><option value="assets">./assets</option><option value="document-assets">./文档名.assets</option><option value="custom">指定路径</option></select></label>
            <label id="image-custom-path-row" class="select-row" hidden><span><b>指定图片路径</b><small>相对于文档所在目录，禁止使用 ..</small></span><input id="setting-image-custom" placeholder="assets/images" /></label>
            <label class="setting-row"><span><b>粘贴时自动上传</b><small>从剪贴板粘贴图片时自动上传并插入</small></span><input id="setting-auto-upload" type="checkbox" checked /></label>
            <label class="setting-row"><span><b>优先使用相对路径</b><small>插入图片时使用当前文档可访问的相对地址</small></span><input id="setting-relative-image" type="checkbox" checked /></label>
            <label class="setting-row"><span><b>为相对路径添加 ./</b><small>让路径在 Markdown 阅读器中更明确</small></span><input id="setting-dot-image" type="checkbox" checked /></label>
            <label class="setting-row"><span><b>自动转义图片 URL</b><small>处理空格和非 ASCII 文件名</small></span><input id="setting-escape-image" type="checkbox" checked /></label>
          </section>
        </div>
      </div>
    </section>
  </div>
  <input id="file-input" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden />
  <input id="folder-input" type="file" webkitdirectory directory multiple hidden />
  <input id="image-input" type="file" accept="image/*" multiple hidden />
  <div id="context-menu" class="context-menu" hidden role="menu"></div>
`;

const iconSet = { AlignLeft, Bold, CheckSquare, ChevronDown, ChevronRight, Code2, Columns2, Copy, Download, File, FileCode2, FilePlus2, Files, Folder, FolderOpen, FolderPlus, Heading1, Heading2, Image, Italic, Link, List, ListOrdered, Maximize2, Menu, Minus, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pilcrow, Quote, Redo2, Search, Settings, Sigma, Strikethrough, Sun, Table2, Undo2, Underline, X };
createIcons({ icons: iconSet });

const cachePage = document.createElement('section');
cachePage.className = 'settings-page'; cachePage.dataset.settingsPage = 'cache';
cachePage.innerHTML = `<h3>服务端图片缓存</h3>
  <form id="image-cache-form">
    <fieldset id="image-cache-fields" disabled>
      <label class="setting-row"><b>启用磁盘缓存</b><input name="enabled" type="checkbox" /></label>
      <label class="select-row"><b>容量上限（MiB）</b><input name="maxMiB" type="number" min="1" max="10240" step="1" required /></label>
      <label class="select-row"><b>版本检查间隔（分钟）</b><input name="minutes" type="number" min="1" max="10080" step="1" required /></label>
      <div class="cache-actions"><button type="submit"><i data-lucide="check-square"></i>保存设置</button>
      <button type="button" data-cache-action="refresh"><i data-lucide="redo-2"></i>检查图片更新</button>
      <button type="button" data-cache-action="clear"><i data-lucide="x"></i>清理图片缓存</button></div>
    </fieldset>
  </form><dl id="image-cache-stats"></dl><p id="image-cache-message" role="status"></p>`;
document.querySelector('.settings-content').append(cachePage);
createIcons({ icons: iconSet });
async function updateCacheSettings() {
  const fields = document.querySelector('#image-cache-fields'); fields.disabled = true;
  const message = document.querySelector('#image-cache-message');
  if (!directoryHandle?.webdav) { message.textContent = '连接WebDAV后可管理服务端图片缓存'; return; }
  try {
    const state = await directoryHandle.cacheAction('status');
    const form = document.querySelector('#image-cache-form');
    form.elements.enabled.checked = state.enabled;
    form.elements.maxMiB.value = state.maxBytes / 1024 ** 2;
    form.elements.minutes.value = state.checkInterval / 60000;
    document.querySelector('#image-cache-stats').innerHTML = `<dt>服务端占用</dt><dd>${(state.bytes / 1024 ** 2).toFixed(1)} MiB / ${state.maxBytes / 1024 ** 2} MiB</dd><dt>图片数量</dt><dd>${state.count}</dd><dt>本次服务缓存命中 / 下载请求</dt><dd>${state.hits} / ${state.downloads}</dd>`;
    message.textContent = state.warning || '';
    fields.disabled = false;
  } catch (error) { message.textContent = error.message; }
}
async function runCacheAction(action, extra = {}) {
  const handle = directoryHandle;
  if (!handle?.webdav) return;
  const fields = document.querySelector('#image-cache-fields'); fields.disabled = true;
  try {
    await handle.cacheAction(action, extra);
    if (directoryHandle !== handle) return;
    if (action === 'refresh') {
      directoryImageUrls.delete(handle); directoryImageSizes.delete(handle); davCacheGeneration++;
      const doc = activeDocument();
      if (doc?.sourcePath) await warmImageDimensions(handle, doc);
      for (const image of document.querySelectorAll('#typora-editor img, #split-preview img')) {
        const source = image.dataset.originalSrc || image.dataset.davSrc;
        if (!source) continue;
        image.dataset.davSrc = source; delete image.dataset.previewImageBound;
      }
      preparePreviewImages(document.querySelector('#typora-editor'));
      preparePreviewImages(document.querySelector('#split-preview'));
    }
    await updateCacheSettings();
  } catch (error) { document.querySelector('#image-cache-message').textContent = error.message; fields.disabled = false; }
}
document.querySelector('#image-cache-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  runCacheAction('configure', { settings: { enabled: form.elements.enabled.checked,
    maxBytes: Number(form.elements.maxMiB.value) * 1024 ** 2, checkInterval: Number(form.elements.minutes.value) * 60000 } });
});
cachePage.addEventListener('click', event => {
  const action = event.target.closest('[data-cache-action]')?.dataset.cacheAction;
  if (!action) return;
  if (action === 'clear' && !confirm('清理此服务的所有图片缓存？源图片和文档不变，下次打开时重新读取。')) return;
  runCacheAction(action);
});

document.querySelector('.format-toolbar').addEventListener('mousedown', event => {
  if (!event.target.closest('button')) return;
  event.preventDefault();
});
document.querySelector('.format-toolbar').addEventListener('click', event => {
  const button = event.target.closest('button[data-command]');
  if (!button) return;
  event.stopPropagation();
  execute(button.dataset.command);
});

if (window.innerWidth <= 760) document.querySelector('.app-shell').classList.add('sidebar-hidden');

const menus = {
  file: [['新建文档', 'new', 'Ctrl+N'], ['新建文件夹', 'new-folder', ''], ['打开文件…', 'open', 'Ctrl+O'], ['打开文件夹…', 'open-folder', ''], ['连接 WebDAV…', 'open-webdav', ''], ['新工作区', 'new-workspace', ''], ['导出 Markdown', 'export-md', 'Ctrl+S'], ['导出 HTML', 'export-html', ''], ['导出 PDF', 'export-pdf', ''], ['导出图片', 'export-image', ''], ['删除当前文档', 'delete', '']],
  edit: [['撤销', 'undo', 'Ctrl+Z'], ['重做', 'redo', 'Ctrl+Shift+Z'], ['查找', 'find', 'Ctrl+F']],
  paragraph: [['一级标题', 'h1', 'Ctrl+1'], ['二级标题', 'h2', 'Ctrl+2'], ['正文', 'paragraph', 'Ctrl+0'], ['引用', 'quote', 'Ctrl+Shift+Q'], ['代码块', 'code', 'Ctrl+Shift+K'], ['数学公式块', 'math', 'Ctrl+Shift+M'], ['表格', 'table', 'Ctrl+T'], ['目录', 'toc', ''], ['YAML 元数据', 'yaml', ''], ['GitHub Alert', 'alert', '']],
  format: [['粗体', 'bold', 'Ctrl+B'], ['斜体', 'italic', 'Ctrl+I'], ['下划线', 'underline', 'Ctrl+U'], ['行内代码', 'inline-code', 'Ctrl+Shift+`'], ['删除线', 'strike', 'Alt+Shift+5'], ['高亮', 'highlight', ''], ['上标', 'superscript', ''], ['下标', 'subscript', ''], ['链接', 'link', 'Ctrl+K'], ['图片', 'image', 'Ctrl+Shift+I']],
  view: [['仿 Typora 视图', 'view-typora', ''], ['源码 / 预览分栏', 'view-split', ''], ['仅源码', 'view-source', 'Ctrl+/'], ['显示/隐藏侧边栏', 'toggle-sidebar', 'Ctrl+Shift+L'], ['显示大纲', 'show-outline', 'Ctrl+Shift+1'], ['显示文件树', 'show-files', 'Ctrl+Shift+3'], ['专注模式', 'toggle-focus', 'F8'], ['打字机模式', 'typewriter', 'F9'], ['偏好设置', 'settings', 'Ctrl+,']],
};

function activeDocument() { return workspace.documents.find(item => item.id === workspace.activeId); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
}

function markdownCodeLines(source) {
  const result = new Set();
  for (const block of new MarkdownDocumentModel(source).blocks) {
    if (block.type !== 'code') continue;
    for (let line = block.startLine; line <= block.endLine; line += 1) result.add(line - 1);
  }
  return result;
}

function normalizeLatexDelimiters(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const codeLines = markdownCodeLines(markdown);
  let latexBlock = null;
  const environment = /^(equation\*?|align\*?|gather\*?|displaymath|math)$/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (codeLines.has(index)) {
      output.push(line);
      continue;
    }

    if (!latexBlock && trimmed === '\\[') {
      latexBlock = 'bracket';
      output.push('$$');
      continue;
    }
    if (latexBlock === 'bracket' && trimmed === '\\]') {
      latexBlock = null;
      output.push('$$');
      continue;
    }

    const begin = trimmed.match(/^\\begin\{([^}]+)\}$/i);
    if (!latexBlock && begin && environment.test(begin[1])) {
      latexBlock = begin[1].toLowerCase();
      output.push('$$');
      continue;
    }
    const end = trimmed.match(/^\\end\{([^}]+)\}$/i);
    if (latexBlock && end && end[1].toLowerCase() === latexBlock) {
      latexBlock = null;
      output.push('$$');
      continue;
    }
    if (latexBlock) {
      output.push(line);
      continue;
    }

    const singleLine = line.match(/^(\s*)\\\[([\s\S]*?)\\\](\s*)$/);
    if (singleLine) {
      output.push(`${singleLine[1]}$$`, singleLine[2], `${singleLine[3]}$$`);
      continue;
    }

    output.push(line.replace(/(^|[^\\])\\\(([^\n]*?)(?<!\\)\\\)/g, '$1$$$2$$'));
  }

  return output.join('\n');
}

function normalizeWysiwygMarkdown(markdown) {
  /* Markdown source remains canonical: one physical Enter in the editor is
     represented by one newline, and paragraph separation is the standard
     two-newline Markdown syntax. Visual spacing belongs to CSS. */
  return String(markdown ?? '').replace(/\r\n?/g, '\n');
}

const markdownBlankLineMarker = '\uE001MD_BLANK_LINE\uE002';

function prepareMarkdownForRendering(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const codeLines = markdownCodeLines(markdown);
  let inMath = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (codeLines.has(index)) {
      output.push(line);
      continue;
    }
    if (trimmed === '$$') {
      inMath = !inMath;
      output.push(line);
      continue;
    }
    if (!inMath && trimmed === '' && index < lines.length - 1) {
      /* Keep the marker in Markdown as an ordinary paragraph. Raw block HTML
         here can consume a following fence; replacing the marker after the
         parser has finished keeps every block boundary unambiguous. */
      output.push('', markdownBlankLineMarker, '');
      continue;
    }
    output.push(line);
  }
  return output.join('\n');
}

function restoreMarkdownBlankLines(html) {
  return String(html ?? '').replaceAll(`<p>${markdownBlankLineMarker}</p>`, '<div data-md-blank-line="true"><br></div>');
}

function renderMathBlocks(source) {
  const normalized = normalizeLatexDelimiters(source);
  const lines = normalized.split('\n');
  const output = [];
  const formulas = new Map(new MarkdownDocumentModel(normalized).blocks
    .filter(block => block.type === 'math' && block.closed)
    .map(block => [block.startLine - 1, block]));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const block = formulas.get(index);
    if (!block) { output.push(line); continue; }
    const latex = blockSourceRange(block, normalized).sourceText.split('\n')
      .map(bodyLine => bodyLine.slice(rawBlockStructuralPrefix(block, bodyLine).length)).join('\n');
    const environment = block.environment?.startsWith('align') ? 'aligned'
      : block.environment?.startsWith('gather') ? 'gathered' : null;
    const renderLatex = environment ? `\\begin{${environment}}${latex}\\end{${environment}}` : latex;
    let html;
    try { html = katex.renderToString(renderLatex, { displayMode: true, throwOnError: false }); }
    catch { html = `<code>${escapeHtml(latex)}</code>`; }
    // HTML annotation newlines must not create new Markdown blocks.
    const serializedHtml = String(html).replace(/\r?\n/g, '&#10;');
    const encodedLatex = escapeHtml(latex).replace(/\r?\n/g, '&#10;');
    const quote = line.match(/^(?:[ \t]*>[ \t]?)+/)?.[0] || '';
    output.push(`${quote}<div class="paper-math-block" data-math-block="true" data-latex="${encodedLatex}" data-source-start="${block.startLine}" data-source-end="${block.endLine}">${serializedHtml}</div>`);
    index = block.endLine - 1;
  }
  return output.join('\n');
}

function renderInlineMath(source) {
  const lines = String(source ?? '').split('\n');
  const codeLines = markdownCodeLines(source);
  return lines.map((line, index) => {
    if (codeLines.has(index) || line.includes('$$')) return line;
    return line.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, prefix, latex) => {
      try {
        const html = katex.renderToString(latex, { displayMode: false, throwOnError: false });
        return `${prefix}<span class="paper-inline-math" data-inline-math="true">${html}</span>`;
      } catch {
        return `${prefix}$${latex}$`;
      }
    });
  }).join('\n');
}

function createMarkdownParser() {
  const parser = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: false });
  parser.use(markdownItTaskLists, { enabled: true });
  parser.renderer.rules.softbreak = () => '<br data-paper-source-break="soft">\n';
  parser.renderer.rules.hardbreak = () => '<br data-paper-source-break="hard">\n';
  return parser;
}

function prepareMarkdownContext(source) {
  const context = {};
  context.__paperSource = String(source ?? '');
  context.__paperImageRanges = scanMarkdownImageRanges(context.__paperSource);
  createMarkdownParser().parse(normalizeLatexDelimiters(source), context);
  return context;
}

function highlightedCodeLines(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const lines = [document.createElement('span')];
  // Split text, not HTML tags, so multiline highlight spans keep their style.
  const visit = (node, ancestors = []) => {
    if (node.nodeType === Node.TEXT_NODE) {
      node.data.split('\n').forEach((text, index) => {
        if (index) lines.push(document.createElement('span'));
        if (!text) return;
        let parent = lines.at(-1);
        for (const ancestor of ancestors) {
          const clone = ancestor.cloneNode(false);
          parent.append(clone);
          parent = clone;
        }
        parent.append(document.createTextNode(text));
      });
    } else {
      for (const child of node.childNodes) visit(child,
        node.nodeType === Node.ELEMENT_NODE ? [...ancestors, node] : ancestors);
    }
  };
  visit(template.content);
  return lines.map((line, index) => {
    line.className = 'paper-code-source-line';
    line.dataset.previewCodeLine = String(index + 1);
    return line.outerHTML;
  }).join('\n');
}

function renderMarkdown(source, context = {}) {
  const originalSource = String(source ?? '');
  const imageSource = String(context.__paperSource ?? originalSource);
  const sourceOffset = Number(context.__paperSourceOffset) || 0;
  /* Use the source model for block ranges. Regex ranges based on normalized
     LF text drift in CRLF files and can attach a rendered block to the wrong
     source line. */
  const codeRanges = new MarkdownDocumentModel(originalSource).blocks
    .filter(block => block.type === 'code')
    .map(block => ({ start: block.startLine, end: block.endLine }));
  let codeIndex = 0;
  const imageRanges = (context.__paperImageRanges || scanMarkdownImageRanges(imageSource))
    .filter(range => range.startOffset >= sourceOffset && range.endOffset <= sourceOffset + originalSource.length)
    .map(range => ({
      ...range,
      startOffset: range.startOffset - sourceOffset,
      endOffset: range.endOffset - sourceOffset,
      altStartOffset: range.altStartOffset - sourceOffset,
      altEndOffset: range.altEndOffset - sourceOffset,
    }));
  let imageIndex = 0;
  const renderer = createMarkdownParser();
  for (const rule of ['html_inline', 'html_block']) {
    renderer.renderer.rules[rule] = (tokens, index) => {
      const content = tokens[index].content;
      let searchFrom = 0;
      return content.replace(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag => {
        const template = document.createElement('template'); template.innerHTML = tag;
        const image = template.content.querySelector('img'); if (!image) return tag;
        const reserved = cachedImageGeometry(image.getAttribute('src'));
        if (reserved && !image.hasAttribute('width') && !image.hasAttribute('height') && !image.style.width && !image.style.height) {
          image.width = reserved.width; image.height = reserved.height; image.style.height = 'auto';
          const zoomValue = parseFloat(image.style.zoom);
          const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue / (image.style.zoom.endsWith('%') ? 100 : 1) : 1;
          image.dataset.cacheDimensions = 'true'; image.dataset.cacheHeight = reserved.estimate * zoom;
        }
        if (directoryHandle?.webdav) deferDavImage(image);
        const at = originalSource.indexOf(tag, searchFrom);
        if (at >= 0) {
          image.dataset.sourceStart = String(at); image.dataset.sourceEnd = String(at + tag.length);
          searchFrom = at + tag.length;
        }
        return image.outerHTML;
      });
    };
  }
  renderer.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const alt = token.attrGet('alt') || self.renderInlineAsText(token.children || [], options, env);
    const src = token.attrGet('src');
    const reserved = cachedImageGeometry(src);
    if (reserved) {
      token.attrSet('width', String(reserved.width)); token.attrSet('height', String(reserved.height));
      token.attrSet('style', 'height:auto'); token.attrSet('data-cache-dimensions', 'true'); token.attrSet('data-cache-height', String(reserved.estimate));
    }
    if (directoryHandle?.webdav && src && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) {
      token.attrSet('data-dav-src', src); token.attrSet('data-dav-pending', 'true');
      token.attrs = token.attrs.filter(([name]) => name !== 'src');
    }
    token.attrSet('alt', alt);
    const documentPath = workspace.documents.find(item => item.id === workspace.activeId)?.sourcePath;
    if (documentPath) token.attrSet('data-document-path', documentPath);
    const rangeIndex = imageRanges.findIndex((range, candidateIndex) => {
      if (candidateIndex < imageIndex) return false;
      const sourceAlt = imageSource.slice(range.altStartOffset + sourceOffset, range.altEndOffset + sourceOffset);
      const parsedAlt = renderer.parseInline(sourceAlt, env);
      const renderedSourceAlt = self.renderInlineAsText(parsedAlt[0]?.children || [], options, env);
      return renderedSourceAlt === alt;
    });
    if (rangeIndex >= 0) {
      const range = imageRanges[rangeIndex];
      imageIndex = rangeIndex + 1;
      token.attrSet('data-source-start', String(range.startOffset));
      token.attrSet('data-source-end', String(range.endOffset));
    }
    return self.renderToken(tokens, index, options);
  };
  renderer.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = String(token.info || 'text').trim().split(/[ \t]+/, 1)[0] || 'text';
    const text = String(token.content || '').replace(/\n$/, '');
    if (language.toLowerCase() === 'mermaid') {
      const range = codeRanges[codeIndex++] || { start: 1, end: 1 };
      return `<div class="paper-mermaid" data-source-start="${range.start}" data-source-end="${range.end}"><pre class="paper-mermaid-source">${escapeHtml(text)}</pre></div>`;
    }
    const range = codeRanges[codeIndex++] || { start: 1, end: 1 };
    const sourceStart = range.start;
    const sourceEnd = range.end;
    let highlighted = escapeHtml(text);
    if (language !== 'text' && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    highlighted = highlightedCodeLines(highlighted);
    const lineCount = Math.max(1, text.split('\n').length);
    const lines = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
    return `<div class="paper-code-block" data-source-start="${sourceStart}" data-source-end="${sourceEnd}" data-language="${escapeHtml(language)}"><div class="paper-code-header"><span class="paper-code-flag" aria-hidden="true"><span></span><span></span><span></span></span><span class="paper-code-language">${escapeHtml(language)}</span></div><div class="paper-code-preview-body"><pre class="paper-code-gutter" aria-hidden="true">${lines}</pre><pre class="paper-code-pre"><code class="hljs language-${escapeHtml(language)}">${highlighted}</code></pre></div></div>`;
  };
  const tasks = taskSourceAnchors(originalSource, createMarkdownParser);
  tasks.bind(renderer);
  const normalized = normalizeLatexDelimiters(tasks.source);
  const renderedSource = renderInlineMath(renderMathBlocks(prepareMarkdownForRendering(normalized)));
  const html = renderer.render(renderedSource, context);
  return DOMPurify.sanitize(restoreMarkdownBlankLines(html), { ADD_ATTR: ['data-language', 'data-source-start', 'data-source-end', 'data-md-blank-line', 'data-inline-math', 'data-mermaid', 'data-task-list', 'data-task-item'] });
}

let mermaidRenderId = 0;
let mermaidModulePromise = null;
const directoryImageUrls = new WeakMap();
const directoryImageSizes = new WeakMap();
let davCacheGeneration = 0;
const imagePath = (documentPath, src) => {
  try {
    const url = new URL(src, new URL(documentPath, 'https://workspace.invalid/'));
    return url.origin === 'https://workspace.invalid' ? decodeURIComponent(url.pathname).replace(/^\//, '') : null;
  } catch { return null; }
};
function reportImageCache(message) {
  if (!message) return;
  const notice = document.querySelector('#image-cache-notice');
  notice.hidden = false; notice.textContent = '图片缓存提示'; notice.title = message;
  document.querySelector('#image-cache-message').textContent = message;
}
async function warmImageDimensions(handle, doc) {
  try {
    const paths = [...new Set(davImageReferences(doc.content).map(item => imagePath(doc.sourcePath, item.src)).filter(Boolean))].slice(0, 5000);
    if (!paths.length) return;
    const result = await handle.imageDimensions(paths);
    let sizes = directoryImageSizes.get(handle);
    if (!sizes) directoryImageSizes.set(handle, sizes = new Map());
    for (const [path, size] of Object.entries(result.images)) sizes.set(path.replace(/^\//, ''), size);
    reportImageCache(result.warning);
  } catch (error) { reportImageCache(error.message); }
}
function cachedImageGeometry(src) {
  const doc = activeDocument();
  if (!directoryHandle?.webdav || !doc?.sourcePath || !src) return null;
  const size = directoryImageSizes.get(directoryHandle)?.get(imagePath(doc.sourcePath, src));
  if (!size?.width || !size?.height) return null;
  const root = document.querySelector('#typora-editor'), style = getComputedStyle(root);
  const available = Math.max(1, root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  return { ...size, estimate: size.height * Math.min(size.width, available) / size.width + (parseFloat(style.getPropertyValue('--editor-font-size')) || 16) };
}
const davReferenceCache = new WeakMap();
const davImageKey = (handle, path, src) => handle.webdav.session + ':' + davCacheGeneration + ':' + new URL(src, new URL(path, 'https://workspace.invalid/')).href;
const loadDavImage = createDavImageLoader({ windowJobs: () => {
  const handle = directoryHandle, doc = activeDocument();
  if (!handle?.webdav || !doc?.sourcePath || doc.webdavUnloaded || settings.viewMode === 'source') return [];
  let cached = davReferenceCache.get(doc);
  if (!cached || cached.source !== doc.content) {
    cached = { source: doc.content, references: davImageReferences(doc.content) }; davReferenceCache.set(doc, cached);
  }
  const view = settings.viewMode === 'typora' ? unifiedTyporaCanvas?.editor : splitEditorView;
  if (!view) return [];
  const surface = (settings.viewMode === 'typora' ? document.querySelector('#typora-view') : view.scrollDOM).getBoundingClientRect();
  const caret = view.coordsAtPos(view.state.selection.main.head);
  const offset = caret && caret.top >= surface.top && caret.bottom <= surface.bottom ? view.state.selection.main.head
    : view.posAtCoords({ x: surface.left + surface.width / 2, y: (surface.top + surface.bottom) / 2 }, false) ?? view.viewport.from;
  let pivot = cached.references.findIndex(item => item.offset >= offset);
  if (pivot < 0) pivot = cached.references.length;
  return cached.references.slice(Math.max(0, pivot - 5), pivot + 5).map(item => ({
    key: davImageKey(handle, doc.sourcePath, item.src), load: () => resolveDirectoryImage(handle, doc.sourcePath, item.src),
  }));
} });
async function resolveDirectoryImage(handle, documentPath, source) {
  const base = new URL(documentPath, 'https://workspace.invalid/');
  const url = new URL(source, base);
  if (url.origin !== base.origin) return null;
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  let cache = directoryImageUrls.get(handle);
  if (!cache) directoryImageUrls.set(handle, cache = new Map());
  const key = parts.join('/');
  if (!cache.has(key)) {
    const pending = (async () => {
      if (handle.webdav) {
        const file = await handle.readFileAtPath(key, true);
        let sizes = directoryImageSizes.get(handle);
        if (!sizes) directoryImageSizes.set(handle, sizes = new Map());
        if (file.cache?.width && file.cache?.height) sizes.set(key, { width: file.cache.width, height: file.cache.height });
        reportImageCache(file.cache?.warning);
        return URL.createObjectURL(file);
      }
      let parent = handle;
      for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
      const file = await parent.getFileHandle(parts.at(-1));
      return URL.createObjectURL(await file.getFile());
    })();
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return cache.get(key);
}
function preparePreviewImages(root) {
  if (!root) return;
  root.querySelectorAll('img').forEach(image => {
    if (image.dataset.previewImageBound === 'true') return;
    image.dataset.previewImageBound = 'true';
    const originalAlt = image.getAttribute('alt')?.trim() || '未命名图片';
    image.addEventListener('error', () => {
      image.dataset.imageError = 'true';
      image.alt = `图片加载失败：${originalAlt}`;
      image.title = image.alt;
    });
    image.addEventListener('load', () => {
      if (image.dataset.cacheDimensions === 'true' && image.naturalWidth && image.naturalHeight) {
        image.width = image.naturalWidth; image.height = image.naturalHeight;
      }
      delete image.dataset.davPending;
      delete image.dataset.imageError;
      image.alt = originalAlt;
      image.removeAttribute('title');
    });
    const source = image.dataset.davSrc || image.getAttribute('src');
    if (source) image.dataset.originalSrc = source;
    const doc = workspace.documents.find(item => item.id === workspace.activeId);
    if (source && directoryHandle && workspaceProvider.kind === 'directory' && doc?.sourcePath
        && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) {
      if (directoryHandle.webdav) {
        const handle = directoryHandle, path = image.dataset.documentPath || doc.sourcePath;
        image.removeAttribute('src'); image.dataset.davPending = 'true';
        loadDavImage(image, () => resolveDirectoryImage(handle, path, source), davImageKey(handle, path, source));
      } else resolveDirectoryImage(directoryHandle, image.dataset.documentPath || doc.sourcePath, source).then(url => {
        if (url && image.getAttribute('src') === source) image.src = url;
      }).catch(() => image.dispatchEvent(new Event('error')));
    } else if (source && workspaceProvider.kind === 'server' && doc?.sourcePath
        && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(source)) {
      image.src = new URL(source, new URL(doc.sourcePath, location.origin + '/')).href;
    }
  });
}

async function renderMermaidDiagrams(root) {
  if (!root) return;
  preparePreviewImages(root);
  const diagrams = [...root.querySelectorAll('.paper-mermaid')];
  if (!diagrams.length) return;
  const mermaidModule = await (mermaidModulePromise ||= import('mermaid'));
  const mermaid = mermaidModule.default || mermaidModule;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
  await Promise.all(diagrams.map(async diagram => {
    const source = diagram.querySelector('.paper-mermaid-source')?.textContent || diagram.dataset.mermaidSource || '';
    if (!source) return;
    diagram.dataset.mermaidSource = source;
    const requestId = String(++mermaidRenderId);
    diagram.dataset.mermaidRequest = requestId;
    try {
      const result = await mermaid.render(`paper-mermaid-${requestId}`, source);
      if (diagram.isConnected && diagram.dataset.mermaidRequest === requestId) {
        diagram.innerHTML = result.svg;
        diagram.dataset.mermaidTheme = theme;
      }
    } catch (error) {
      if (diagram.isConnected && diagram.dataset.mermaidRequest === requestId) {
        diagram.textContent = `Mermaid: ${error?.message || '无法渲染图表'}`;
        diagram.classList.add('paper-mermaid-error');
      }
    }
  }));
}


let splitEditorView = null;
let typoraEditor = null;
let unifiedTyporaCanvas = null;

function ensureTyporaCanvas() {
  if (unifiedTyporaCanvas) return unifiedTyporaCanvas;
  const root = document.querySelector('#typora-editor');
  if (!root) return null;
  unifiedTyporaCanvas = new MarkdownUnifiedCanvas({
    root,
    render: (source, context) => renderMarkdown(source, context),
    prepareRender: prepareMarkdownContext,
    onPreviewRender: rootElement => renderMermaidDiagrams(rootElement),
    onTableContextMenu: (canvas, _view, block, target, event) => showTableContextMenu(canvas, { ...target, block }, event),
    onSourceChange: (source, update) => {
      const doc = activeDocument();
      for (const bookmark of pendingImageInsertions) {
        if (bookmark.documentId !== doc?.id) continue;
        bookmark.from = update.changes.mapPos(bookmark.from, 1);
        bookmark.to = update.changes.mapPos(bookmark.to, 1);
      }
      if (!doc || doc.content === source) return;
      doc.content = source;
      doc.updatedAt = Date.now();
      renderOutline(source);
      updateStats(source);
      markSaving();
      if (settings.viewMode === 'split') renderSplitPreview(source);
    },
    onFocusChange: editor => { typoraEditor = editor ? unifiedTyporaCanvas : null; },
  });
  return unifiedTyporaCanvas;
}

function setTyporaCanvasContent(content) {
  const canvas = ensureTyporaCanvas();
  if (!canvas) return;
  canvas.mount(content, { documentId: activeDocument()?.id || null });
  typoraEditor = canvas;
}

function setTyporaEditorContent(content) {
  setTyporaCanvasContent(content);
}

function renderSplitPreview(source) {
  const preview = document.querySelector('#split-preview');
  if (!preview) return;
  preview.innerHTML = renderMarkdown(source);
  renderMermaidDiagrams(preview);
  const blocks = createCanvasBlocks(source);
  let blockIndex = 0;
  [...preview.children].forEach(element => {
    const isBlank = element.matches('[data-md-blank-line="true"]');
    const nextIndex = blocks.findIndex((block, index) => index >= blockIndex && (block.type === 'blank') === isBlank);
    if (nextIndex < 0) return;
    const block = blocks[nextIndex];
    blockIndex = nextIndex + 1;
     element.dataset.canvasBlockId = block.id;
     if (!element.matches('img')) {
       element.dataset.sourceStart = String(block.startLine);
       element.dataset.sourceEnd = String(block.endLine);
     }
     element.dataset.sourceStartOffset = String(block.sourceRange.startOffset);
     element.dataset.sourceEndOffset = String(block.sourceRange.endOffset);
  });
  createIcons({ icons: iconSet });
  syncSplitPreviewFocus(source);
}

document.querySelector('#split-preview')?.addEventListener('click', event => {
  if (!window.getSelection()?.isCollapsed || event.target.closest('a[href]')) return;
  const checkbox = event.target.closest('input[type="checkbox"][data-task-source-offset]');
  if (checkbox && splitEditorView) {
    event.preventDefault();
    /* The marker offset is measured in the original document string so mixed
       LF/CRLF files can be written back byte-for-byte. CodeMirror stores LF;
       convert the raw source offset exactly once before dispatching. */
    const source = activeDocument()?.content ?? unifiedTyporaCanvas?.source ?? splitEditorView.state.doc.toString();
    const sourceOffset = Number(checkbox.dataset.taskSourceOffset);
    if (Number.isInteger(sourceOffset) && /^\[[ xX]\]$/.test(source.slice(sourceOffset - 1, sourceOffset + 2))) {
      const editorOffset = source.slice(0, sourceOffset).replace(/\r\n?/g, '\n').length;
      splitEditorView.dispatch({
        changes: { from: editorOffset, to: editorOffset + 1, insert: checkbox.checked ? 'x' : ' ' },
        selection: { anchor: editorOffset + 2 },
        userEvent: 'input.task',
      });
      splitEditorView.focus();
    }
    return;
  }
  const image = event.target.closest('img[data-source-start][data-source-end]');
  if (image && splitEditorView) {
    event.preventDefault();
    const source = activeDocument()?.content ?? unifiedTyporaCanvas?.source ?? splitEditorView.state.doc.toString();
    const sourceOffset = Number(image.dataset.sourceStart);
    if (Number.isInteger(sourceOffset)) {
      const editorOffset = source.slice(0, sourceOffset).replace(/\r\n?/g, '\n').length;
      splitEditorView.dispatch({ selection: { anchor: editorOffset }, scrollIntoView: true });
      requestAnimationFrame(() => syncSplitPreviewFocus(splitEditorView.state.doc.toString(), splitEditorView.state));
    }
    return;
  }
  const target = event.target.closest('[data-source-start]');
  if (!target || !splitEditorView) return;
  const lineNumber = Math.max(1, Number(target.dataset.sourceStart) || 1);
  const line = splitEditorView.state.doc.line(Math.min(lineNumber, splitEditorView.state.doc.lines));
  splitEditorView.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  requestAnimationFrame(() => syncSplitPreviewFocus(splitEditorView.state.doc.toString(), splitEditorView.state));
});

async function resolveEditorLink(href) {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon);base64,/i.test(href)) return href;
  const doc = activeDocument();
  if (directoryHandle && workspaceProvider.kind === 'directory' && doc?.sourcePath
      && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
    return resolveDirectoryImage(directoryHandle, doc.sourcePath, href);
  }
  const base = new URL(doc?.sourcePath || '', window.location.href);
  const url = new URL(href, base);
  return ['http:', 'https:', 'mailto:', 'tel:', 'blob:'].includes(url.protocol) ? url.href : null;
}

const localImageGrants = new Map();
let localImageGrantHandle = null;
async function editorImageAction(action, href, newName) {
  if (directoryHandle?.webdav) throw new Error('远端图片暂不支持文件定位、重命名或删除；可复制、缩放及插入图片');
  const doc = activeDocument();
  if (!doc?.sourcePath || workspaceProvider.kind === 'import') throw new Error('请先保存文档到本地源目录');
  if (action === 'rename' && workspaceProvider.kind === 'directory') {
    if (!directoryHandle) throw new Error('请重新连接源目录');
    return renameDirectoryImage(directoryHandle, doc.sourcePath, href, newName);
  }
  if (directoryHandle !== localImageGrantHandle) { localImageGrants.clear(); localImageGrantHandle = directoryHandle; }
  const session = await fetch('/api/local-images/session');
  if (!session.ok) throw new Error('本地图片服务未启动，请重启启动脚本后重试');
  const { token } = await session.json().catch(() => ({}));
  if (!token) throw new Error('本地图片服务未启动，请重启启动脚本后重试');
  const request = async (endpoint, body) => {
    const response = await fetch(`/api/local-images/${endpoint}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Paper-Local-Token': token,
    }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '文件操作失败'); return result;
  };
  const key = `${token}:${workspaceProvider.id}:${doc.sourcePath}`;
  let grantId = localImageGrants.get(key);
  if (!grantId) {
    let rootPath = '';
    if (workspaceProvider.kind === 'directory') {
      rootPath = prompt(`首次使用文件操作，请填写映射目录“${workspaceProvider.displayName}”的完整路径。仅在此目录内定位或重命名图片。`);
      if (!rootPath?.trim()) throw new Error('已取消目录授权，文件未修改');
    }
    await persistWorkspace();
    const grant = await request('grant', { rootPath: rootPath.trim(), documentPath: doc.sourcePath,
      expectedContent: doc.content, serverWorkspace: workspaceProvider.kind === 'server' });
    grantId = grant.grantId; localImageGrants.set(key, grantId);
  }
  const result = await request('action', { grantId, action, href, newName });
  if (action === 'rename') result.rollback = () => request('action', { grantId, action: 'rename', href: result.href,
    newName: decodeURIComponent(href.split('/').at(-1)) });
  return result;
}

document.addEventListener('click', async event => {
  const link = event.target.closest('a[href], [data-link-href]');
  if (!link?.closest('#typora-editor, #split-preview') || !window.getSelection()?.isCollapsed) return;
  const href = link.getAttribute('data-link-href') || link.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  try {
    const url = await resolveEditorLink(href);
    if (url && tab) showResolvedEditorUrl(tab, url);
    else tab?.close();
  } catch (error) { tab?.close(); alert(`无法打开链接：${error.message}`); }
});


function splitSelection() {
  if (!splitEditorView) return null;
  const selection = splitEditorView.state.selection.main;
  return { from: selection.from, to: selection.to, text: splitEditorView.state.sliceDoc(selection.from, selection.to) };
}

function replaceSplitSelection(prefix, suffix, placeholder = '') {
  const selection = splitSelection();
  if (!selection || !splitEditorView) return;
  const selected = selection.text || placeholder;
  const insert = `${prefix}${selected}${suffix}`;
  const caret = selection.from + prefix.length;
  splitEditorView.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: caret, head: selected === placeholder ? caret : caret + selected.length },
    userEvent: 'input.format',
  });
  splitEditorView.focus();
}

function applySplitInlineFormat(command) {
  if (['bold', 'italic', 'underline', 'strike', 'inline-code'].includes(command)) {
    unifiedTyporaCanvas?.toggleInline(command);
    return;
  }
  const wrappers = {
    bold: ['**', '**', '粗体'],
    italic: ['*', '*', '斜体'],
    underline: ['<span style="text-decoration: underline;">', '</span>', '下划线'],
    strike: ['~~', '~~', '删除线'],
    'inline-code': ['`', '`', '代码'],
    highlight: ['==', '==', '高亮'],
    superscript: ['^', '^', '上标'],
    subscript: ['~', '~', '下标'],
  };
  const format = wrappers[command];
  if (format) replaceSplitSelection(...format);
}

function insertSplitText(value, caretOffset = value.length) {
  if (!splitEditorView) return;
  const selection = splitSelection();
  if (!selection) return;
  splitEditorView.dispatch({
    changes: { from: selection.from, to: selection.to, insert: value },
    selection: { anchor: selection.from + caretOffset },
    userEvent: 'input.insert',
  });
  splitEditorView.focus();
}

function syncSplitPreviewFocus(source, state = splitEditorView?.state) {
  const preview = document.querySelector('#split-preview');
  if (!preview || !state) return;
  const lineNumber = state.doc.lineAt(state.selection.main.head).number;
  preview.dataset.focusLine = String(lineNumber);
  preview.querySelectorAll('.split-focus').forEach(element => element.classList.remove('split-focus'));

   const block = canvasBlockAtLine(createCanvasBlocks(source), lineNumber);
   const target = block
     ? preview.querySelector(`[data-canvas-block-id="${CSS.escape(block.id)}"]`)
     : null;
  target?.classList.add('split-focus');
}

let splitScrollSyncLocked = false;
let splitScrollSyncPending = null;
let splitSuppressedSourceTop = null;
let splitSuppressedPreviewTop = null;
let splitSuppressedSourceUntil = 0;
let splitSuppressedPreviewUntil = 0;

function consumeProgrammaticScroll(element, expectedTop) {
  if (expectedTop === null) return false;
  const isSource = element === splitSourceScrollContainer();
  const expiresAt = isSource ? splitSuppressedSourceUntil : splitSuppressedPreviewUntil;
  if (performance.now() > expiresAt) {
    if (isSource) splitSuppressedSourceTop = null;
    else splitSuppressedPreviewTop = null;
    return false;
  }
  const consumed = Math.abs(element.scrollTop - expectedTop) <= 2;
  /* A different value means a real user scroll arrived before the synthetic
     event. Let that event through instead of suppressing it. */
  if (consumed || Math.abs(element.scrollTop - expectedTop) > 2) {
    if (isSource) splitSuppressedSourceTop = null;
    else splitSuppressedPreviewTop = null;
  }
  return consumed;
}

function runSplitScrollSync(callback) {
  if (splitScrollSyncLocked) {
    /* Do not drop a fast reverse scroll. Coalesce it and apply the latest
       direction after the current programmatic scroll settles. */
    splitScrollSyncPending = callback;
    return;
  }
  splitScrollSyncLocked = true;
  requestAnimationFrame(() => {
    /* CodeMirror virtualizes line DOM. A large outer-container scroll updates
       its mounted rows during its own next-frame measure. Read on the frame
       after that measure so we never map a stale mounted line. */
    requestAnimationFrame(() => {
      callback();
      requestAnimationFrame(() => {
        splitScrollSyncLocked = false;
        const pending = splitScrollSyncPending;
        splitScrollSyncPending = null;
        if (pending) runSplitScrollSync(pending);
      });
    });
  });
}

function previewElementAtLine(preview, lineNumber) {
  return [...preview.querySelectorAll('[data-source-start][data-source-end]')]
    .find(element => lineNumber >= Number(element.dataset.sourceStart) && lineNumber <= Number(element.dataset.sourceEnd));
}

function sourceLineAtViewportTop(scroller, state) {
  const scrollerRect = scroller.getBoundingClientRect();
  const boundary = scrollerRect.top + 12;
  const visibleLine = [...splitEditorView.contentDOM.querySelectorAll('.cm-line')]
    .find(element => element.getBoundingClientRect().bottom >= boundary);
  if (visibleLine) return state.doc.lineAt(splitEditorView.posAtDOM(visibleLine, 0)).number;
  const contentRect = splitEditorView.contentDOM.getBoundingClientRect();
  const position = splitEditorView.posAtCoords({
    x: Math.max(scrollerRect.left + 1, Math.min(scrollerRect.right - 1, contentRect.left + 4)),
    y: boundary,
  }, false);
  if (position !== null) return state.doc.lineAt(position).number;
  // Fall back to the height map only when the visible coordinate is outside
  // a mounted text line (for example during the first layout frame).
  const height = Math.max(0, scrollerRect.top + 12 - splitEditorView.documentTop);
  return state.doc.lineAt(splitEditorView.lineBlockAtHeight(height).from).number;
}

function splitSourceScrollContainer() {
  return splitEditorView?.scrollDOM || document.querySelector('#split-editor .cm-scroller');
}

function syncPreviewToSourceScroll() {
  const preview = document.querySelector('#split-preview');
  const scroller = splitSourceScrollContainer();
  if (!preview || !scroller || settings.viewMode !== 'split') return;
  const lineNumber = sourceLineAtViewportTop(scroller, splitEditorView.state);
  const target = previewElementAtLine(preview, lineNumber);
  if (!target) return;
  const start = Number(target.dataset.sourceStart) || lineNumber;
  const end = Number(target.dataset.sourceEnd) || lineNumber;
  const fraction = end > start ? (lineNumber - start) / (end - start) : 0;
  const targetRect = target.getBoundingClientRect();
  const top = targetRect.top - preview.getBoundingClientRect().top + preview.scrollTop
    + targetRect.height * Math.max(0, Math.min(1, fraction)) - 12;
  const nextTop = Math.max(0, Math.min(top, preview.scrollHeight - preview.clientHeight));
  splitSuppressedPreviewTop = nextTop;
  splitSuppressedPreviewUntil = performance.now() + 250;
  preview.scrollTop = nextTop;
}

function syncSourceToPreviewScroll() {
  const preview = document.querySelector('#split-preview');
  const scroller = splitSourceScrollContainer();
  if (!preview || !scroller || settings.viewMode !== 'split') return;
  const boundary = preview.getBoundingClientRect().top + 12;
  const target = [...preview.querySelectorAll('[data-source-start][data-source-end]')]
    .find(element => element.getBoundingClientRect().bottom >= boundary);
  if (!target) return;
  const start = Math.max(1, Number(target.dataset.sourceStart) || 1);
  const end = Math.max(start, Number(target.dataset.sourceEnd) || start);
  const targetRect = target.getBoundingClientRect();
  const fraction = targetRect.height > 0
    ? Math.max(0, Math.min(1, (boundary - targetRect.top) / targetRect.height))
    : 0;
  const lineNumber = Math.round(start + (end - start) * fraction);
  const line = splitEditorView.state.doc.line(Math.min(lineNumber, splitEditorView.state.doc.lines));
  const block = splitEditorView.lineBlockAt(line.from);
  const nextTop = Math.max(0, Math.min(
    scroller.scrollTop + splitEditorView.documentTop + block.top - scroller.getBoundingClientRect().top - 12,
    scroller.scrollHeight - scroller.clientHeight,
  ));
  splitSuppressedSourceTop = nextTop;
  splitSuppressedSourceUntil = performance.now() + 250;
  scroller.scrollTop = nextTop;
}

function ensureSplitScrollSync() {
  const preview = document.querySelector('#split-preview');
  const scroller = splitSourceScrollContainer();
  if (!preview || !scroller || preview.dataset.scrollSync === 'true') return;
  preview.dataset.scrollSync = 'true';
  scroller.addEventListener('scroll', () => {
    const consumed = consumeProgrammaticScroll(scroller, splitSuppressedSourceTop);
    if (consumed) return;
    runSplitScrollSync(syncPreviewToSourceScroll);
  }, { passive: true });
  preview.addEventListener('scroll', () => {
    const consumed = consumeProgrammaticScroll(preview, splitSuppressedPreviewTop);
    if (consumed) return;
    runSplitScrollSync(syncSourceToPreviewScroll);
  }, { passive: true });
}

function ensureSplitEditor() {
  if (splitEditorView) return splitEditorView;
  const host = document.querySelector('#split-editor');
  const canvas = ensureTyporaCanvas();
  if (!canvas) return null;
  splitEditorView = canvas.editor;
  if (host && settings.viewMode !== 'typora') canvas.attachEditorTo(host);
  ensureSplitScrollSync();
  return splitEditorView;
}

function setSplitEditorContent(content) {
  const editor = ensureSplitEditor();
  const editorContent = String(content ?? '').replace(/\r\n?/g, '\n');
  if (!editor || editor.state.doc.toString() === editorContent) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: editorContent } });
}

let previousNonSourceMode = settings.viewMode === 'split' ? 'split' : 'typora';
function setViewMode(mode, { persist = true, focus = true } = {}) {
  const next = ['typora', 'split', 'source'].includes(mode) ? mode : 'typora';
  const sameMode = settings.viewMode === next;
  if (settings.viewMode !== 'source' && next === 'source') previousNonSourceMode = settings.viewMode;
  const doc = activeDocument();
  settings.viewMode = next;
  ensureTyporaCanvas()?.setLivePreview(next === 'typora');
  const typora = document.querySelector('#typora-view');
  const split = document.querySelector('#split-view');
  typora.hidden = next !== 'typora';
  split.hidden = next === 'typora';
  split.classList.toggle('source-only', next === 'source');
  document.querySelector('#source-view-toggle')?.setAttribute('aria-pressed', String(next === 'source'));
  document.querySelector('#cursor-mode').textContent = next === 'typora' ? '仿 Typora' : next === 'split' ? '源码 / 预览' : '源码模式';
  if (sameMode) {
    /* Theme/settings changes call this function again. Reusing the existing
       editor state avoids resetting its DOM, selection, composition or scroll
       position when the Markdown source has not changed. */
    if (next !== 'typora') {
      unifiedTyporaCanvas?.attachEditorTo(document.querySelector('#split-editor'));
      if (splitEditorView?.state.doc.toString() !== (doc?.content || '')) setSplitEditorContent(doc?.content || '');
    }
  } else if (next === 'typora') {
    unifiedTyporaCanvas?.attachEditorTo(unifiedTyporaCanvas.editorHost);
    setTyporaEditorContent(doc?.content || '');
    /* Switching views must restore the rendered surface, not steal focus into
       the hidden source host. The editor is focused only after an explicit
       click or when a new document requests initial focus. */
    if (unifiedTyporaCanvas) {
      unifiedTyporaCanvas.editorHost.hidden = false;
      unifiedTyporaCanvas.preview.hidden = true;
    }
  } else {
    unifiedTyporaCanvas?.attachEditorTo(document.querySelector('#split-editor'));
    setSplitEditorContent(doc?.content || '');
    renderSplitPreview(doc?.content || '');
    ensureSplitScrollSync();
    if (focus && next === 'source') splitEditorView?.focus();
  }
  document.querySelectorAll('[data-view-mode]').forEach(item => item.classList.toggle('active', item.dataset.viewMode === next));
  if (persist) persistSettings();
}

function persistWorkspace() {
  if (workspaceProvider.kind !== 'directory-pending') rememberWorkspace(workspaceProvider, workspace);
  if (workspaceProvider.kind === 'directory-pending') return Promise.resolve();
  if (workspaceProvider.kind === 'directory') {
    const pending = queueDirectorySave();
    pending.then(() => { workspaceDirty = directoryDirtyDocuments.size > 0; }).catch(() => {});
    return pending;
  }
  if (workspaceProvider.kind !== 'server') {
    localStorage.setItem(workspaceProvider.kind === 'browser' ? workspaceProvider.id : STORAGE_KEY, JSON.stringify(workspace));
    workspaceDirty = false;
    return Promise.resolve();
  }
  /* The server owns this workspace. Keep no content snapshot in the browser. */
  localStorage.removeItem(STORAGE_KEY);
  const revision = ++serverSaveRevision;
  const snapshot = JSON.parse(JSON.stringify(workspace));
  /* Bind the optimistic-concurrency token when this snapshot is created. If
     it is read later inside the queue, a delayed pagehide save can inherit a
     newer revision and overwrite a newer document snapshot. */
  const snapshotRevision = Number.isInteger(workspace._revision) ? workspace._revision : null;
  if (snapshotRevision !== null) snapshot._revision = snapshotRevision;
  const operation = serverSaveChain.then(async () => {
    const response = await fetch('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot), keepalive: true });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && result.workspace && revision === serverSaveRevision) {
        const authoritative = normalizeWorkspace(result.workspace);
        /* Keep the local editor and its selection authoritative for this
           failed request. Replacing it with the remote snapshot would discard
           unsaved Markdown and move the caret. The next explicit edit can
           retry with the latest revision. */
        if (authoritative) workspace._revision = authoritative._revision;
        const state = document.querySelector('#save-state');
        if (state) state.textContent = '保存冲突';
      }
      const error = new Error(`Workspace save failed (${response.status})`);
      if (response.status === 409) error.code = 'WORKSPACE_CONFLICT';
      throw error;
    }
    if (revision === serverSaveRevision) workspaceDirty = false;
    if (!result.workspace) return;
    const authoritative = normalizeWorkspace(result.workspace);
    if (!authoritative) return;
    /* Every successful serialized request advances the local revision cursor.
       Only the newest request is allowed to reconcile document membership. */
    workspace._revision = authoritative._revision;
    if (revision !== serverSaveRevision) return;
    const documentIds = new Set(authoritative.documents.map(doc => doc.id));
    const folderIds = new Set(authoritative.folders.map(folder => folder.id));
    const removedDocuments = workspace.documents.filter(doc => !documentIds.has(doc.id)).map(doc => doc.id);
    const removedFolders = workspace.folders.filter(folder => !folderIds.has(folder.id)).map(folder => folder.id);
    if (!removedDocuments.length && !removedFolders.length) return;
    workspace.documents = workspace.documents.filter(doc => documentIds.has(doc.id));
    workspace.folders = workspace.folders.filter(folder => folderIds.has(folder.id));
    openTabs = openTabs.filter(id => documentIds.has(id));
    if (!workspace.documents.some(doc => doc.id === workspace.activeId)) workspace.activeId = openTabs[0] || workspace.documents[0]?.id || null;
    if (!workspace.folders.some(folder => folder.id === workspace.activeFolderId)) workspace.activeFolderId = null;
    renderFiles(); renderTabs();
    if (workspace.activeId) switchDocument(workspace.activeId);
    else {
      refreshActiveEditor('');
      renderOutline(''); updateStats('');
    }
  });
  /* Keep the queue usable after a failed request while returning the original
     operation so autosave can show failure instead of reporting success. */
  serverSaveChain = operation.catch(error => { console.error('工作区保存失败:', error); });
  return operation;
}
function persistSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); applySettings(); }

function captureDocumentViewState() {
  const id = workspace.activeId;
  if (!id) return;
  const state = { mode: settings.viewMode, typoraScrollTop: null, typoraSourceScrollTop: null, typoraSelection: null, sourceScrollTop: null, sourceSelection: null, splitScrollTop: null, splitPreviewScrollTop: null, splitSelection: null };
  const typora = document.querySelector('#typora-view');
  if (typora) state.typoraScrollTop = typora.scrollTop;
  if (unifiedTyporaCanvas) {
    state.typoraSelection = unifiedTyporaCanvas.getSelection();
    state.typoraSourceScrollTop = unifiedTyporaCanvas.editor.scrollDOM.scrollTop;
  }
  const splitScroller = splitSourceScrollContainer();
  if (splitScroller) state.splitScrollTop = splitScroller.scrollTop;
  const splitPreview = document.querySelector('#split-preview');
  if (splitPreview) state.splitPreviewScrollTop = splitPreview.scrollTop;
  const splitSelectionValue = splitSelection();
  if (splitSelectionValue) state.splitSelection = { from: splitSelectionValue.from, to: splitSelectionValue.to };
  tabViewStates.set(id, state);
  try { sessionStorage.setItem(VIEW_STATE_KEY, JSON.stringify(Object.fromEntries(tabViewStates))); } catch { /* UI state is best effort only. */ }
}

function restoreDocumentViewState(id) {
  const state = tabViewStates.get(id);
  if (!state) return;
  const restore = () => {
    if (workspace.activeId !== id) return;
    const typora = document.querySelector('#typora-view');
    if (typora && Number.isFinite(state.typoraScrollTop)) typora.scrollTop = state.typoraScrollTop;
    if (unifiedTyporaCanvas) {
      unifiedTyporaCanvas.setSelection(state.typoraSelection);
      if (Number.isFinite(state.typoraSourceScrollTop)) unifiedTyporaCanvas.editor.scrollDOM.scrollTop = state.typoraSourceScrollTop;
    }
    const splitScroller = splitSourceScrollContainer();
    if (splitScroller && Number.isFinite(state.splitScrollTop)) splitScroller.scrollTop = state.splitScrollTop;
    const splitPreview = document.querySelector('#split-preview');
    if (splitPreview && Number.isFinite(state.splitPreviewScrollTop)) splitPreview.scrollTop = state.splitPreviewScrollTop;
    if (splitEditorView && state.splitSelection) {
      const max = splitEditorView.state.doc.length;
      splitEditorView.dispatch({ selection: { anchor: Math.min(state.splitSelection.from, max), head: Math.min(state.splitSelection.to, max) }, scrollIntoView: false });
    }
  };
  restore();
  requestAnimationFrame(restore);
}

function markSaving() {
  const state = document.querySelector('#save-state');
  if (workspaceProvider.kind === 'directory' && workspace.activeId) directoryDirtyDocuments.add(workspace.activeId);
  workspaceDirty = true;
  state.textContent = settings.autosave ? '正在保存…' : '未保存';
  clearTimeout(saveTimer);
  if (!settings.autosave) return;
  saveTimer = setTimeout(async () => {
    try {
      await persistWorkspace();
      state.textContent = '已保存';
    } catch (error) {
      console.error('保存失败:', error);
      state.textContent = error?.code === 'WORKSPACE_CONFLICT' ? '保存冲突' : '保存失败';
      scheduleDavRecovery(error);
    }
  }, directoryHandle?.webdav ? 1500 : 220);
}

function scheduleDavRecovery(error) {
  if (!workspaceProvider.webdav || error?.code === 'WORKSPACE_CONFLICT') return;
  davRetryAt = Math.max(davRetryAt, error?.retryAt || Date.now() + 30000);
  if (davRecoveryAttempts >= 3) return;
  clearTimeout(davRecoveryTimer);
  davRecoveryTimer = setTimeout(() => { void recoverDavWorkspace(); }, Math.max(1000, davRetryAt - Date.now()));
}
async function recoverDavWorkspace() {
  if (!workspaceProvider.webdav || davRecovering || document.hidden || !navigator.onLine) return;
  if (Date.now() < davRetryAt) { scheduleDavRecovery({ retryAt: davRetryAt }); return; }
  davRecovering = true; davRecoveryAttempts++;
  const providerId = workspaceProvider.id;
  try {
    const config = directoryHandle?.webdav || { ...workspaceProvider.webdav };
    await resumeWebdav(config, !directoryHandle);
    if (workspaceProvider.id !== providerId) return;
    if (!directoryHandle) await openDirectoryFromHandle(webdavHandle(config), { persistHandle: false });
    else if (directoryDirtyDocuments.size && settings.autosave) {
      await persistWorkspace();
      document.querySelector('#save-state').textContent = workspaceDirty ? '未保存' : '已保存';
    } else if (workspace.documents.find(doc => doc.id === workspace.activeId)?.webdavUnloaded) await switchDocument(workspace.activeId);
    davRecoveryAttempts = 0; davRetryAt = 0;
  } catch (error) {
    document.querySelector('#save-state').textContent = error.code === 'WORKSPACE_CONFLICT' ? '保存冲突' : error.message;
    if (error.status !== 401) scheduleDavRecovery(error);
  } finally { davRecovering = false; }
}
const resumeDavOnReturn = () => { if (!document.hidden) { davRecoveryAttempts = 0; void recoverDavWorkspace(); } };
document.addEventListener('visibilitychange', resumeDavOnReturn);
window.addEventListener('online', resumeDavOnReturn);

window.addEventListener('pagehide', () => {
  captureDocumentViewState();
  if (!workspaceDirty) return;
  clearTimeout(saveTimer);
  void persistWorkspace();
});

function renderFiles(filter = '') {
  const list = document.querySelector('#file-list');
  list.replaceChildren();
  const renderDocument = (doc, depth = 0) => {
    const button = document.createElement('button');
    button.className = `file-row${doc.id === workspace.activeId ? ' active' : ''}`;
    button.dataset.id = doc.id;
    button.draggable = true;
    button.style.paddingLeft = `${8 + depth * 16}px`;
    const isActive = doc.id === workspace.activeId;
    const icon = document.createElement('span'); icon.className = 'tree-icon';
    icon.innerHTML = `<i data-lucide="${isActive ? 'file-code-2' : 'file'}"></i>`;
    const info = document.createElement('span'); info.className = 'file-info';
    const name = document.createElement('strong'); name.textContent = doc.name;
    const date = document.createElement('small'); date.textContent = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(doc.updatedAt);
    info.append(name, date); button.append(icon, info); list.append(button);
  };
  const renderFolder = (folder, depth = 0) => {
    const row = document.createElement('button'); row.className = `folder-row${folder.id === workspace.activeFolderId ? ' active' : ''}`; row.dataset.folderId = folder.id; row.style.paddingLeft = `${7 + depth * 16}px`;
    row.draggable = true;
    const arrow = document.createElement('span'); arrow.className = 'folder-arrow'; arrow.innerHTML = `<i data-lucide="${folder.expanded ? 'chevron-down' : 'chevron-right'}"></i>`;
    const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.innerHTML = `<i data-lucide="${folder.expanded ? 'folder-open' : 'folder'}"></i>`;
    const name = document.createElement('strong'); name.textContent = folder.name; row.append(arrow, icon, name); list.append(row);
    row.setAttribute('aria-busy', String(Boolean(folder.davLoading)));
    if (folder.davError) {
      const status = document.createElement('small');
      status.textContent = '加载失败';
      row.title = folder.davError;
      row.append(status);
    }
    if (!folder.expanded) return;
    workspace.folders.filter(item => item.parentId === folder.id).forEach(item => renderFolder(item, depth + 1));
    workspace.documents.filter(item => item.parentId === folder.id).forEach(item => renderDocument(item, depth + 1));
  };
  if (filter) workspace.documents.filter(doc => doc.name.toLowerCase().includes(filter.toLowerCase())).forEach(doc => renderDocument(doc));
  else {
    workspace.folders.filter(folder => folder.parentId === null).forEach(folder => renderFolder(folder));
    workspace.documents.filter(doc => doc.parentId === null).forEach(doc => renderDocument(doc));
  }
  document.querySelector('#document-count').textContent = `${directoryHandle?.webdav ? '已加载 ' : ''}${workspace.folders.length} 个文件夹 · ${workspace.documents.length} 个文件`;
  createIcons({ icons: iconSet });
}

function renderTabs() {
  const tabs = document.querySelector('#document-tabs');
  if (!tabs) return;
  openTabs = openTabs.filter(id => workspace.documents.some(doc => doc.id === id));
  for (const tab of [...tabs.children]) if (!openTabs.includes(tab.dataset.id)) tab.remove();
  openTabs.forEach((id, index) => {
    const doc = workspace.documents.find(item => item.id === id);
    const tab = [...tabs.children].find(item => item.dataset.id === id) || document.createElement('div');
    tab.className = `document-tab${id === workspace.activeId ? ' active' : ''}`;
    tab.dataset.id = id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(id === workspace.activeId));
    const name = tab.querySelector('span') || document.createElement('span'); name.textContent = doc.name;
    const close = tab.querySelector('button') || document.createElement('button');
    close.className = 'document-tab-close'; close.dataset.closeTab = id;
    close.title = '关闭标签'; close.setAttribute('aria-label', `关闭 ${doc.name}`);
    if (!close.firstChild) close.innerHTML = '<i data-lucide="x"></i>';
    if (!tab.firstChild) tab.append(name, close);
    if (tabs.children[index] !== tab) tabs.insertBefore(tab, tabs.children[index] || null);
  });
  createIcons({ icons: iconSet });
}

const renamingDocuments = new Set();
async function renameDocument(id) {
  const doc = workspace.documents.find(item => item.id === id);
  if (!doc || renamingDocuments.has(id)) return;
  if (doc.webdavUnloaded) { alert('文档尚未加载，请稍后重命名'); return; }
  const entered = prompt('重命名文件', doc.name);
  if (entered === null) return;
  const name = entered.trim().replace(/\.(md|markdown|txt)$/i, '');
  if (name === doc.name) return;
  if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) { alert('文件名不合法'); return; }
  if (workspace.documents.some(item => item.id !== id && item.parentId === doc.parentId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { alert('同名文档已存在，未覆盖'); return; }
  const oldName = doc.name, oldPath = doc.sourcePath, handle = directoryHandle, provider = workspaceProvider;
  renamingDocuments.add(id);
  try {
    clearTimeout(saveTimer);
    await persistWorkspace();
    if (workspaceProvider !== provider || directoryHandle !== handle) throw new Error('工作区已切换，未重命名');
    const path = doc.sourcePath;
    const nextPath = path ? path.slice(0, path.lastIndexOf('/') + 1) + name + (doc.sourceExtension || '.md') : null;
    if (provider.kind === 'directory') {
      let remoteChanged = false;
      if (handle.webdav) remoteChanged = (await handle.renameFileAtPath(path, nextPath, doc.content)).changed;
      else await renameDirectoryImage(handle, path, './' + encodeURIComponent(path.split('/').at(-1)), name + (doc.sourceExtension || '.md'));
      doc.sourcePath = nextPath;
      directoryProviderSnapshot.set(id, { type: 'document', path: nextPath });
      doc.name = name; doc.updatedAt = Date.now();
      rememberWorkspace(workspaceProvider, workspace);
      if (remoteChanged) alert('文档已重命名，但远端内容同时发生变化。请保留本机修改并重新连接核对，不会覆盖远端。');
    } else {
      doc.name = name; doc.sourcePath = nextPath; doc.updatedAt = Date.now();
      try { await persistWorkspace(); }
      catch (error) { doc.name = oldName; doc.sourcePath = oldPath; throw error; }
    }
    renderFiles(); renderTabs();
    document.querySelector('#save-state').textContent = workspaceDirty ? '未保存' : '已保存';
  } catch (error) { alert(`重命名未完成：${error.message}`); }
  finally { renamingDocuments.delete(id); }
}

document.querySelector('#document-tabs').addEventListener('dblclick', event => {
  if (event.target.closest('[data-close-tab]')) return;
  const tab = event.target.closest('.document-tab');
  if (tab) { event.preventDefault(); void renameDocument(tab.dataset.id); }
});

function closeTab(id) {
  const index = openTabs.indexOf(id);
  if (index < 0) return;
  openTabs.splice(index, 1);
  if (id === workspace.activeId) {
    const nextId = openTabs[index] || openTabs[index - 1] || workspace.documents.find(doc => doc.id !== id)?.id;
    if (nextId) switchDocument(nextId);
  }
  if (!openTabs.length && workspace.documents[0]) { openTabs.push(workspace.documents[0].id); switchDocument(workspace.documents[0].id); }
  renderTabs();
}

function outlineHeadings(markdown) {
  return new MarkdownDocumentModel(markdown).blocks
    .filter(block => block.type === 'heading')
    .map(block => ['', `#`.repeat(block.level), block.text]);
}

function scrollToOutlineHeading(index) {
  const source = activeDocument()?.content || '';
  const target = new MarkdownDocumentModel(source).blocks.filter(block => block.type === 'heading')[index];
  const view = settings.viewMode === 'typora' ? unifiedTyporaCanvas?.editor : splitEditorView;
  if (!target || !view) return;
  const line = view.state.doc.line(Math.min(target.startLine, view.state.doc.lines));
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true, userEvent: 'select.outline' });
  view.focus();
  const surface = settings.viewMode === 'typora' ? document.querySelector('#typora-view') : view.scrollDOM;
  view.requestMeasure({
    read: () => {
      const box = surface.getBoundingClientRect();
      const top = view.coordsAtPos(line.from)?.top ?? view.documentTop + view.lineBlockAt(line.from).top;
      return surface.scrollTop + top - box.top - surface.clientHeight * 0.35;
    },
    write: top => { surface.scrollTop = Math.max(0, top); },
  });
  if (settings.viewMode === 'split') {
    const preview = document.querySelector('#split-preview');
    const heading = preview?.querySelectorAll('h1,h2,h3,h4,h5,h6')[index];
    if (!preview || !heading) return;
    const top = heading.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop - preview.clientHeight * 0.35;
    preview.scrollTo({ top: Math.max(0, Math.min(top, preview.scrollHeight - preview.clientHeight)), behavior: 'auto' });
    return;
  }

}

function renderOutline(markdown = '') {
  const list = document.querySelector('#outline-list');
  if (!list) return;
  list.replaceChildren();
  const headings = outlineHeadings(markdown);
  if (!headings.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '当前文档没有标题';
    list.append(empty);
    return;
  }
  headings.forEach((match, index) => {
    const button = document.createElement('button');
    button.className = 'outline-row';
    button.style.paddingLeft = `${12 + (match[1].length - 1) * 14}px`;
    button.textContent = match[2].replace(/[*_`]/g, '');
    button.dataset.outlineIndex = String(index);
    button.addEventListener('click', () => scrollToOutlineHeading(index));
    list.append(button);
  });
}

function updateStats(value) {
  const source = String(value || '');
  const plain = source.replace(/[#>*_`~\[\]()-]/g, ' ').trim();
  const words = (plain.match(/[\u4e00-\u9fff]/g) || []).length + (plain.match(/[A-Za-z0-9]+/g) || []).length;
  document.querySelector('#word-count').textContent = `${words} 字`;
  document.querySelector('#char-count').textContent = `${source.length} 字符`;
}

function refreshActiveEditor(content, { focus = false } = {}) {
  setTyporaEditorContent(content);
  setSplitEditorContent(content);
  renderSplitPreview(content);
  if (focus) {
    if (settings.viewMode === 'typora') unifiedTyporaCanvas?.focus('end');
    else splitEditorView?.focus();
  }
}

async function switchDocument(id) {
  const next = workspace.documents.find(doc => doc.id === id); if (!next) return;
  if (workspace.activeId && workspace.activeId !== id) captureDocumentViewState();
  if (!openTabs.includes(id)) openTabs.push(id);
  workspace.activeId = id;
  if (next.webdavUnloaded) {
    const handle = directoryHandle;
    document.querySelector('#typora-view').inert = true;
    document.querySelector('#split-view').inert = true;
    document.querySelector('#save-state').textContent = '正在读取远端文档';
    renderFiles(); renderTabs();
    try {
      const file = await handle.readFileAtPath(next.sourcePath);
      next.content = await file.text(); next.updatedAt = file.lastModified; next.sourceLineEnding = detectLineEnding(next.content);
      await warmImageDimensions(handle, next);
      delete next.webdavUnloaded;
      if (directoryHandle !== handle || workspace.activeId !== id) return;
      document.querySelector('#save-state').textContent = '已加载';
    } catch (error) {
      if (directoryHandle === handle && workspace.activeId === id) {
        document.querySelector('#save-state').textContent = error.message;
        scheduleDavRecovery(error);
      }
      return;
    }
  }
  rememberWorkspace(workspaceProvider, workspace);
  updateWorkspaceRootLabel();
  setTyporaEditorContent(next.content);
  setSplitEditorContent(next.content);
  renderSplitPreview(next.content);
  renderFiles(document.querySelector('#document-search').value); renderTabs(); renderOutline(next.content); updateStats(next.content);
  restoreDocumentViewState(id);
}

function newDocument() {
  if (workspaceProvider.kind === 'directory-pending') return reconnectDirectoryWorkspace();
  const doc = makeDocument(`未命名文档 ${workspace.documents.length + 1}`);
  doc.parentId = workspace.activeFolderId;
  const folder = workspace.folders.find(item => item.id === doc.parentId);
  if (folder) folder.expanded = true;
  workspace.documents.unshift(doc); switchDocument(doc.id); unifiedTyporaCanvas?.focus('start'); splitEditorView?.focus();
}

function newFolder() {
  if (workspaceProvider.kind === 'directory-pending') return reconnectDirectoryWorkspace();
  const name = prompt('文件夹名称', '新建文件夹'); if (!name?.trim()) return;
  const folder = makeFolder(name.trim(), workspace.activeFolderId);
  workspace.folders.push(folder); workspace.activeFolderId = folder.id; persistWorkspace(); renderFiles();
}

function ensureFolder(name, parentId = null) {
  const normalized = String(name || '').trim();
  if (!normalized) return parentId;
  const found = workspace.folders.find(folder => folder.parentId === parentId && folder.name.toLocaleLowerCase() === normalized.toLocaleLowerCase());
  if (found) return found.id;
  const folder = makeFolder(normalized, parentId);
  workspace.folders.push(folder);
  return folder.id;
}

async function importFiles(files, directoryName = '', targetParentId = workspace.activeFolderId, { createRoot = Boolean(directoryName) } = {}) {
  if (workspaceProvider.kind === 'directory-pending') {
    alert('请先重新连接源目录，再导入文件。');
    return;
  }
  const list = [...files].filter(file => /\.(md|markdown|txt)$/i.test(file.name));
  if (!list.length) return;
  const rootId = directoryName && createRoot ? ensureFolder(directoryName, targetParentId) : targetParentId;
  for (const file of list) {
    const relative = file.webkitRelativePath || file.relativePath || file.name;
    const parts = relative.split(/[\\/]/).filter(Boolean);
    const folders = parts.slice(directoryName ? 1 : 0, -1);
    let parentId = rootId;
    folders.forEach(name => { parentId = ensureFolder(name, parentId); });
    const name = parts.at(-1).replace(/\.(md|markdown|txt)$/i, '') || '未命名文档';
    const doc = makeDocument(name, await file.text());
    doc.parentId = parentId;
    workspace.documents.unshift(doc);
    openTabs.push(doc.id);
  }
  const last = workspace.documents.find(doc => openTabs.includes(doc.id));
  if (last) switchDocument(last.id);
  persistWorkspace(); renderFiles(); renderTabs();
}

async function scanDirectoryHandle(handle) {
  if (handle.webdav) {
    const tree = handle.davTree = createDavTree(handle, stableProviderId);
    await tree.load();
    tree.workspace.activeId = tree.workspace.documents[0]?.id || null;
    return tree;
  }
  const folders = [];
  const documents = [];
  const snapshot = new Map();
  let bytes = 0;
  async function visit(current, parentId, parentPath = '') {
    const entries = [];
    for await (const [name, entry] of current.entries()) {
      if (name.startsWith('.')) continue;
      if (entry.kind === 'directory' && !name.endsWith('.assets')) entries.push({ name, entry });
      if (entry.kind === 'file' && /\.(md|markdown|txt)$/i.test(name)) entries.push({ name, entry });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const item of entries) {
      if (handle.webdav && documents.length + folders.length >= 2000) throw new Error('WebDAV目录超过2000个条目，请连接较小的子目录');
      const relativePath = normalizeProviderPath(parentPath ? `${parentPath}/${item.name}` : item.name);
      if (item.entry.kind === 'directory') {
        const id = stableProviderId('folder', relativePath);
        folders.push({ id, name: item.name, parentId, expanded: false, sourcePath: relativePath });
        snapshot.set(id, { type: 'folder', path: relativePath });
        await visit(item.entry, id, relativePath);
      } else {
        const file = handle.webdav ? null : await item.entry.getFile();
        bytes += file?.size || 0;
        if (handle.webdav && bytes > 50 * 1024 * 1024) throw new Error('WebDAV文档总量超过50MiB，请连接较小的子目录');
        const extension = item.name.match(/\.(md|markdown|txt)$/i)?.[0] || '.md';
        const id = stableProviderId('document', relativePath);
        documents.push({ id, name: item.name.slice(0, -extension.length), content: file ? await file.text() : '', ...(handle.webdav ? { webdavUnloaded: true } : {}), parentId, updatedAt: file?.lastModified || Date.now(), sourcePath: relativePath, sourceExtension: extension });
        snapshot.set(id, { type: 'document', path: relativePath });
      }
    }
  }
  await visit(handle, null);
  return { workspace: { documents, folders, activeId: documents[0]?.id || null, activeFolderId: documents[0]?.parentId || null }, snapshot };
}

function updateWorkspaceRootLabel() {
  const root = document.querySelector('#workspace-root-drop');
  if (!root) return;
  const label = root.querySelector('span');
  const mapped = workspaceProvider.kind === 'directory';
  const imported = workspaceProvider.kind === 'import';
  const pending = workspaceProvider.kind === 'directory-pending';
  if (label) label.textContent = workspaceProvider.displayName || '本地工作区';
  root.title = mapped ? `已映射目录：${workspaceProvider.displayName}` : imported ? '当前为导入副本，不会写回原目录' : '本地工作区根目录';
  root.dataset.providerKind = workspaceProvider.kind;
  root.classList.toggle('workspace-mapped', mapped);
  root.classList.toggle('workspace-imported', imported);
  if (pending) {
    label.textContent = `${workspaceProvider.displayName}（重新连接）`;
    root.title = '重新授权并连接源目录';
    document.querySelector('#save-state').textContent = '目录待连接';
  }
  const loading = workspace.documents.find(doc => doc.id === workspace.activeId)?.webdavUnloaded;
  document.querySelector('#typora-view').inert = pending || !workspace.activeId || loading;
  document.querySelector('#split-view').inert = pending || !workspace.activeId || loading;
}

function installWorkspace(nextWorkspace, provider, snapshot = new Map()) {
  const next = normalizeWorkspace(nextWorkspace);
  if (!next) return false;
  workspace = next;
  workspaceProvider = provider;
  directoryProviderSnapshot = snapshot;
  directoryRemovedEntries = new Set();
  directoryDirtyDocuments = new Set();
  tabViewStates.clear();
  openTabs = workspace.activeId ? [workspace.activeId] : [];
  updateWorkspaceRootLabel();
  renderFiles(); renderTabs();
  if (workspace.activeId) switchDocument(workspace.activeId);
  else { refreshActiveEditor(''); renderOutline(''); updateStats(''); }
  rememberWorkspace(workspaceProvider, workspace);
  return true;
}

function startDavTree(handle) {
  const tree = handle?.davTree;
  if (!tree) return;
  tree.bind(workspace);
  tree.active = () => directoryHandle === handle;
  tree.changed = () => { if (tree.active()) renderFiles(document.querySelector('#document-search').value); };
  void tree.prefetch();
}

async function openDirectoryFromHandle(handle, { persistHandle = true } = {}) {
  if (!handle) return false;
  const permission = await handle.queryPermission?.({ mode: 'readwrite' });
  if (permission === 'denied') throw new Error('没有目录读写权限');
  const scanned = await scanDirectoryHandle(handle);
  directoryHandle = handle;
  pendingDirectoryHandle = null;
  if (persistHandle && !handle.webdav) await storeDirectoryHandle(handle);
  const provider = handle.webdav
    ? { kind: 'directory', id: `webdav:${handle.webdav.url}:${handle.webdav.username}`, displayName: `WebDAV · ${handle.name}`, webdav: { url: handle.webdav.url, username: handle.webdav.username } }
    : { kind: 'directory', id: `directory:${handle.name}`, displayName: handle.name };
  if (workspaceProvider.kind === 'directory-pending') {
    if (handle.davTree && settings.startupMode === 'last') await handle.davTree.restorePath(readWorkspaceSession()?.lastFile?.path);
    scanned.workspace = restoreWorkspaceFile(scanned.workspace, settings.startupMode, readWorkspaceSession());
  }
  installWorkspace(scanned.workspace, provider, scanned.snapshot);
  startDavTree(handle);
  sessionStorage.setItem(DIRECTORY_SESSION_KEY, '1');
  settings.lastDirectory = handle.name;
  persistSettings();
  return true;
}

async function openDirectoryWorkspace() {
  if (typeof window.showDirectoryPicker !== 'function') {
    alert('当前浏览器不支持可写入的目录映射。请使用 Chromium 内核浏览器打开本应用，以便直接修改所选文件夹中的源文件。');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const permission = await handle.requestPermission?.({ mode: 'readwrite' });
    if (permission === 'denied') throw new Error('没有目录读写权限');
    await openDirectoryFromHandle(handle);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    alert(`打开目录失败：${error.message || '无法读取目录'}`);
  }
}

async function reconnectDirectoryWorkspace() {
  if (workspaceProvider.webdav) return openWebdavDialog();
  if (!pendingDirectoryHandle) return openDirectoryWorkspace();
  const root = document.querySelector('#workspace-root-drop');
  if (root.disabled) return;
  root.disabled = true;
  try {
    if (workspaceDirty) await persistWorkspace();
    await directorySaveChain;
    const permission = await pendingDirectoryHandle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('目录授权未通过，未读取或写入文件');
    await openDirectoryFromHandle(pendingDirectoryHandle, { persistHandle: false });
    document.querySelector('#save-state').textContent = '已连接';
  } catch (error) {
    if (error?.name !== 'AbortError') alert(`重新连接失败：${error.message || '目录不可用'}`);
  } finally {
    root.disabled = false;
  }
}

async function newBrowserWorkspace() {
  try {
    if (workspaceDirty) await persistWorkspace();
    await directorySaveChain;
    directoryHandle = null;
    pendingDirectoryHandle = null;
    sessionStorage.removeItem(DIRECTORY_SESSION_KEY);
    installWorkspace({ documents: [], folders: [], activeId: null, activeFolderId: null },
      { kind: 'browser', id: `browser:${crypto.randomUUID()}`, displayName: '新工作区（浏览器）' });
    await persistWorkspace();
  } catch (error) { alert(`未切换工作区：${error.message}`); }
}

async function openWebdavDialog() {
  if (document.querySelector('.webdav-dialog')) return;
  const preferences = await webdavRequest({ action: 'preferences' }).catch(() => ({}));
  createWebdavDialog({
    previous: { ...preferences, ...(workspaceProvider.webdav || readWorkspaceSession()?.provider.webdav) },
    reveal: config => webdavRequest({ action: 'reveal-password', ...config }),
    forget: () => webdavRequest({ action: 'forget-password' }),
    connect: async config => {
      const same = directoryHandle?.webdav && directoryHandle.webdav.url === new URL(config.url || DEFAULT_DAV_URL).href.replace(/\/*$/, '/') && directoryHandle.webdav.username === config.username;
      if (!same && workspaceDirty) await persistWorkspace();
      await directorySaveChain;
      const result = await webdavRequest({ action: 'connect', ...config, session: directoryHandle?.webdav?.session });
      const handle = same ? directoryHandle : webdavHandle(result);
      Object.assign(handle.webdav, result);
      rememberDavSession(result);
      try {
        if (!same) await openDirectoryFromHandle(handle, { persistHandle: false });
        else if (workspaceDirty || directoryDirtyDocuments.size) await persistWorkspace();
        else if (workspace.documents.find(doc => doc.id === workspace.activeId)?.webdavUnloaded) await switchDocument(workspace.activeId);
        document.querySelector('#settings-dialog').hidden = true;
        document.querySelector('#save-state').textContent = '已连接 WebDAV';
        davRecoveryAttempts = 0; davRetryAt = 0; clearTimeout(davRecoveryTimer);
      } catch (error) {
        if (!same) await webdavRequest({ action: 'disconnect', session: result.session }).catch(() => {});
        throw error;
      }
    },
    disconnect: async () => {
      if (workspaceDirty) throw new Error('请先保存或导出当前修改，再断开连接');
      const session = sessionStorage.getItem('paper-webdav-session');
      if (session) await webdavRequest({ action: 'disconnect', session });
      sessionStorage.removeItem('paper-webdav-session');
      localStorage.removeItem('paper-webdav-connection');
      clearTimeout(davRecoveryTimer);
      if (workspaceProvider.webdav) {
        directoryHandle = null;
        installWorkspace({ documents: [], folders: [], activeId: null, activeFolderId: null }, { ...workspaceProvider, kind: 'directory-pending' });
      }
    },
  });
}

async function importDirectoryFiles(files, directoryName = '') {
  const list = [...files].filter(file => /\.(md|markdown|txt)$/i.test(file.name));
  if (!list.length) return;
  const folders = [];
  const documents = [];
  const folderIds = new Map();
  for (const file of list) {
    const relative = file.webkitRelativePath || file.relativePath || file.name;
    const parts = relative.split(/[\\/]/).filter(Boolean);
    const pathParts = parts.slice(directoryName ? 1 : 0, -1);
    let parentId = null;
    let path = '';
    for (const part of pathParts) {
      path = normalizeProviderPath(path ? `${path}/${part}` : part);
      if (!folderIds.has(path)) {
        const folder = makeFolder(part, parentId);
        folder.expanded = false;
        folders.push(folder); folderIds.set(path, folder.id);
      }
      parentId = folderIds.get(path);
    }
    const name = parts.at(-1).replace(/\.(md|markdown|txt)$/i, '') || '未命名文档';
    documents.push(makeDocument(name, await file.text()));
    documents.at(-1).parentId = parentId;
  }
  const imported = { documents, folders, activeId: documents[0].id, activeFolderId: documents[0].parentId };
  directoryHandle = null;
  sessionStorage.removeItem(DIRECTORY_SESSION_KEY);
  installWorkspace(imported, { kind: 'import', id: `import:${Date.now()}`, displayName: `${directoryName || '导入目录'}（导入副本）` });
  settings.lastDirectory = directoryName || null;
  persistSettings();
  persistWorkspace();
}

function download(name, content, type) {
  const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([content], { type })); anchor.download = name; anchor.click(); URL.revokeObjectURL(anchor.href);
}



const INLINE_FORMATS = ['bold', 'italic', 'underline', 'strike', 'inline-code', 'highlight', 'superscript', 'subscript'];

function applyInlineFormat(command) {
  if (settings.viewMode === 'typora' && typoraEditor) {
    typoraEditor.toggleInline(command);
    return;
  }
  if ((settings.viewMode === 'split' || settings.viewMode === 'source') && splitEditorView) applySplitInlineFormat(command);
}

function insert(command) {
  if (INLINE_FORMATS.includes(command)) return applyInlineFormat(command);
  const language = settings.defaultCodeLanguage === 'plaintext' ? '' : settings.defaultCodeLanguage;
  const values = {
    quote: '\n> 引用内容\n', ul: '\n- 列表项\n', ol: '\n1. 列表项\n', task: '\n- [ ] 待办事项\n',
    code: '\n' + String.fromCharCode(96).repeat(3) + language + '\n\n' + String.fromCharCode(96).repeat(3) + '\n',
    table: '\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n', link: '[链接文字](https://)', image: '![图片说明](https://)',
    math: '\n$$\n\n$$\n', toc: '\n[TOC]\n', yaml: '---\ntitle: 文档标题\nauthor: 作者\ntags: [Markdown]\n---\n\n',
    alert: '\n> [!NOTE]\n> 这里是提示内容。\n', hr: '\n---\n', footnote: '脚注引用[^1]\n\n[^1]: 脚注内容。\n',
  };
  if (!values[command]) return;
  if (settings.viewMode === 'typora' && typoraEditor) {
    let caretOffset = values[command].length;
    if (command === 'code') { const opening = values[command].match(/\n(?:`{3,}|~{3,})[^\n]*\n/); if (opening) caretOffset = opening.index + opening[0].length; }
    if (command === 'math') { const opening = values[command].match(/\n\$\$\n/); if (opening) caretOffset = opening.index + opening[0].length; }
    typoraEditor.insertText(values[command], caretOffset);
    return;
  }
  if ((settings.viewMode === 'split' || settings.viewMode === 'source') && splitEditorView) {
    let caretOffset = values[command].length;
    if (command === 'code') { const opening = values[command].match(/\n(?:`{3,}|~{3,})[^\n]*\n/); if (opening) caretOffset = opening.index + opening[0].length; }
    if (command === 'math') { const opening = values[command].match(/\n\$\$\n/); if (opening) caretOffset = opening.index + opening[0].length; }
    insertSplitText(values[command], caretOffset);
    return;
  }
}

function applyBlockType(command) {
  if (settings.viewMode === 'typora' && typoraEditor) {
    const level = command === 'paragraph' ? 0 : Number(command.slice(1));
    const line = typoraEditor.editor.state.doc.lineAt(typoraEditor.editor.state.selection.main.from);
    const text = line.text.replace(/^#{1,6}\s+/, '');
    typoraEditor.editor.dispatch({ changes: { from: line.from, to: line.to, insert: `${level ? `${'#'.repeat(level)} ` : ''}${text}` }, userEvent: 'input.format' });
    typoraEditor.editor.focus();
    return;
  }
  if ((settings.viewMode === 'split' || settings.viewMode === 'source') && splitEditorView) {
    const selection = splitSelection();
    if (!selection) return;
    const line = splitEditorView.state.doc.lineAt(selection.from);
    const text = line.text.replace(/^#{1,6}\s+/, '');
    const level = command === 'paragraph' ? 0 : Number(command.slice(1));
    splitEditorView.dispatch({ changes: { from: line.from, to: line.to, insert: `${level ? `${'#'.repeat(level)} ` : ''}${text}` }, userEvent: 'input.format' });
    splitEditorView.focus();
    return;
  }
}

function applyListType(listType) {
  if (settings.viewMode === 'typora' && typoraEditor) {
    const line = typoraEditor.editor.state.doc.lineAt(typoraEditor.editor.state.selection.main.from);
    const text = line.text.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
    const prefix = listType === 'task' ? '- [ ] ' : listType === 'ol' ? '1. ' : '- ';
    typoraEditor.editor.dispatch({ changes: { from: line.from, to: line.to, insert: prefix + text }, userEvent: 'input.format' });
    typoraEditor.editor.focus();
    return;
  }
  if ((settings.viewMode === 'split' || settings.viewMode === 'source') && splitEditorView) {
    const selection = splitSelection();
    if (!selection) return;
    const line = splitEditorView.state.doc.lineAt(selection.from);
    const text = line.text.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
    const prefix = listType === 'task' ? '- [ ] ' : listType === 'ol' ? '1. ' : '- ';
    splitEditorView.dispatch({ changes: { from: line.from, to: line.to, insert: prefix + text }, userEvent: 'input.format' });
    splitEditorView.focus();
    return;
  }
}

function execute(command) {
  document.querySelector('#menu-popover').hidden = true;
  if (['h1','h2','h3','h4','h5','h6','paragraph'].includes(command)) return applyBlockType(command);
  if (['ul','ol','task'].includes(command)) return applyListType(command);
  if (['bold','italic','underline','inline-code','strike','highlight','superscript','subscript','quote','code','table','link','math','toc','yaml','alert','hr','footnote'].includes(command)) return insert(command);
  if (command === 'new') return newDocument();
  if (command === 'new-folder') return newFolder();
  if (command === 'open') return document.querySelector('#file-input').click();
  if (command === 'open-folder') return openDirectoryWorkspace();
  if (command === 'open-webdav') return openWebdavDialog();
  if (command === 'new-workspace') return newBrowserWorkspace();
  if (command === 'delete' && directoryHandle?.webdav) return alert('WebDAV首版暂不支持删除远端文件');
  if (command === 'undo') return unifiedTyporaCanvas?.undo();
  if (command === 'redo') return unifiedTyporaCanvas?.redo();
  if (command === 'source') return setViewMode(settings.viewMode === 'source' ? previousNonSourceMode : 'source');
  if (command === 'view-typora') return setViewMode('typora');
  if (command === 'view-split') return setViewMode('split');
  if (command === 'view-source') return setViewMode('source');
  if (command === 'toggle-sidebar' || command === 'toggle-sidebar-mobile') return document.querySelector('.app-shell').classList.toggle('sidebar-hidden');
  if (command === 'toggle-focus') return document.querySelector('.app-shell').classList.toggle('focus-mode');
  if (command === 'typewriter') return document.querySelector('.app-shell').classList.toggle('typewriter-mode');
  if (command === 'toggle-theme') {
    settings.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    return persistSettings();
  }
  if (command === 'show-outline' || command === 'show-files') { const panel = command === 'show-outline' ? 'outline' : 'files'; document.querySelector('.app-shell').classList.remove('sidebar-hidden'); document.querySelectorAll('.sidebar-tab').forEach(item => item.classList.toggle('active', item.dataset.panel === panel)); document.querySelectorAll('.sidebar-panel').forEach(item => item.classList.toggle('active', item.id === `${panel}-panel`)); return; }
  if (command === 'search') { const wrap = document.querySelector('#search-wrap'); wrap.hidden = false; document.querySelector('#document-search').focus(); return; }
  const searchCommands = { find: openSearchPanel, 'close-find': closeSearchPanel,
    'find-next': findNext, 'find-previous': findPrevious, 'replace-one': replaceNext, 'replace-all': replaceAll };
  if (searchCommands[command]) {
    const view = settings.viewMode === 'typora' ? typoraEditor?.editor : splitEditorView;
    if (view) searchCommands[command](view);
    return;
  }
  if (command === 'image') { return document.querySelector('#image-input').click(); }
  if (command === 'settings') { syncSettingsControls(); document.querySelector('#settings-dialog').hidden = false; return; }
  if (command === 'close-settings') { document.querySelector('#settings-dialog').hidden = true; return; }
  const doc = activeDocument(); if (!doc || doc.webdavUnloaded) return;
  if (command === 'export-md') return download(`${doc.name}.md`, doc.content, 'text/markdown;charset=utf-8');
  if (command === 'export-html') { return download(`${doc.name}.html`, `<!doctype html><meta charset="utf-8"><title>${doc.name}</title><article>${renderMarkdown(doc.content)}</article>`, 'text/html;charset=utf-8'); }
  if (command === 'export-pdf') { window.print(); return; }
  if (command === 'export-image') {
    const content = renderMarkdown(doc.content);
    const width = Math.max(640, Number(settings.contentWidth) + 96);
    const height = Math.max(240, document.querySelector('#typora-view')?.scrollHeight || document.querySelector('#split-preview')?.scrollHeight || 240);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font:17px/1.75 Segoe UI,Microsoft YaHei,sans-serif;color:#292929;background:#fff;padding:48px;box-sizing:border-box">${content}</div></foreignObject></svg>`;
    return download(`${doc.name}.svg`, svg, 'image/svg+xml;charset=utf-8');
  }
  if (command === 'delete' && workspace.documents.length > 1 && confirm(`删除“${doc.name}”？`)) { workspace.documents = workspace.documents.filter(item => item.id !== doc.id); switchDocument(workspace.documents[0].id); }
}

function applySettings() {
  const editorScroll = settings.viewMode === 'typora'
    ? document.querySelector('#typora-view')
    : splitSourceScrollContainer();
  const scrollTop = editorScroll?.scrollTop;
  const resolvedTheme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme;
  const previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.editorTheme = settings.editorTheme;
  document.documentElement.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--editor-line-height', settings.lineHeight);
  document.documentElement.style.setProperty('--content-width', `${settings.contentWidth}px`);
  document.documentElement.style.setProperty('--indent-size', settings.indentSize);
  document.documentElement.style.setProperty('--sidebar-width', `${Math.min(420, Math.max(210, Number(settings.sidebarWidth) || 272))}px`);
  document.querySelector('.app-shell').classList.toggle('code-wrap', settings.codeWrap);
  document.querySelector('.app-shell').classList.toggle('toolbar-hidden', !settings.showToolbar);
  if (unifiedTyporaCanvas?.editor) unifiedTyporaCanvas.editor.contentDOM.spellcheck = settings.spellcheck;
  document.querySelectorAll('button[data-theme]').forEach(button => button.classList.toggle('selected', button.dataset.theme === settings.theme));
  document.querySelectorAll('button[data-editor-theme]').forEach(button => button.classList.toggle('selected', button.dataset.editorTheme === settings.editorTheme));
  updateThemeToggle(resolvedTheme);
  if (previousTheme && previousTheme !== resolvedTheme) {
    void renderMermaidDiagrams(document.querySelector('#typora-editor'));
    void renderMermaidDiagrams(document.querySelector('#split-preview'));
  }
  if (document.querySelector('#split-view')) setViewMode(settings.viewMode || 'typora', { persist: false, focus: false });
  if (editorScroll && Number.isFinite(scrollTop)) {
    editorScroll.scrollTop = scrollTop;
    requestAnimationFrame(() => {
      if (editorScroll.isConnected) editorScroll.scrollTop = scrollTop;
    });
  }
}

function updateThemeToggle(theme) {
  const button = document.querySelector('#theme-toggle');
  if (!button) return;
  const dark = theme === 'dark';
  button.title = dark ? '切换到浅色模式' : '切换到暗色模式';
  button.setAttribute('aria-label', button.title);
  button.innerHTML = `<i data-lucide="${dark ? 'sun' : 'moon'}"></i>`;
  createIcons({ icons: iconSet, attrs: { 'aria-hidden': 'true' } });
}

function syncSettingsControls() {
  document.querySelector('#setting-toolbar').checked = settings.showToolbar;
  const values = { 'setting-autosave': settings.autosave, 'setting-spellcheck': settings.spellcheck, 'setting-font-size': settings.fontSize, 'setting-line-height': settings.lineHeight, 'setting-content-width': settings.contentWidth, 'setting-line-numbers': settings.showLineNumbers, 'setting-auto-space': settings.autoSpace, 'setting-code-wrap': settings.codeWrap, 'setting-diagrams': settings.diagrams, 'setting-extensions': settings.inlineMath && settings.highlights, 'setting-startup': settings.startupMode, 'setting-indent-size': settings.indentSize, 'setting-auto-indent': settings.autoIndent, 'setting-match-brackets': settings.matchBrackets, 'setting-match-markdown': settings.matchMarkdown, 'setting-line-ending': settings.lineEnding, 'setting-image-path': settings.imagePathMode, 'setting-auto-upload': settings.autoUpload, 'setting-relative-image': settings.relativeImage ?? true, 'setting-dot-image': settings.dotImage ?? true, 'setting-escape-image': settings.escapeImage ?? true };
  Object.entries(values).forEach(([id, value]) => { const input = document.querySelector(`#${id}`); if (input.type === 'checkbox') input.checked = value; else input.value = value; });
  document.querySelector('#font-size-value').textContent = `${settings.fontSize}px`; document.querySelector('#line-height-value').textContent = settings.lineHeight; document.querySelector('#content-width-value').textContent = `${settings.contentWidth}px`;
  document.querySelector('#setting-code-language').value = settings.defaultCodeLanguage;
  document.querySelector('#setting-startup').value = settings.startupMode;
  document.querySelector('#setting-indent-size').value = String(settings.indentSize);
  document.querySelector('#setting-line-ending').value = settings.lineEnding;
  document.querySelector('#setting-image-path').value = settings.imagePathMode;
  document.querySelector('#image-custom-path-row').hidden = settings.imagePathMode !== 'custom';
  document.querySelector('#setting-image-custom').value = settings.imageCustomPath || '';
  applySettings();
}

function applyStartupMode() {
  if (workspaceProvider.kind !== 'directory-pending') rememberWorkspace(workspaceProvider, workspace);
}

/* Register top-level pointer handlers before mounting an editor. The editor
   creation is asynchronous enough that a fast first click must not land
   before the menu triggers exist. */
document.querySelectorAll('.menu-trigger').forEach(trigger => {
  trigger.addEventListener('mouseenter', () => showMenu(trigger));
  trigger.addEventListener('pointerdown', event => {
    event.preventDefault();
    showMenu(trigger);
  });
  trigger.addEventListener('click', event => {
    event.preventDefault();
    showMenu(trigger);
  });
  trigger.addEventListener('mouseleave', scheduleMenuClose);
});
document.querySelector('#menu-popover').addEventListener('mouseenter', () => clearTimeout(menuCloseTimer));
document.querySelector('#menu-popover').addEventListener('mouseleave', scheduleMenuClose);

/* Mount the single editor directly into the initial view. Moving it through
   the hidden split host during startup creates an observable empty-host race. */
if (settings.viewMode === 'typora') ensureTyporaCanvas();
else ensureSplitEditor();
applyStartupMode();
if (workspace.activeId) switchDocument(workspace.activeId);
else { renderFiles(); renderTabs(); renderOutline(''); updateStats(''); }
applySettings();
initTableToolbar();
installEditorContextMenu({
  menu: document.querySelector('#context-menu'), getEditor: () => unifiedTyporaCanvas?.editor,
  getDocumentId: () => activeDocument()?.id,
  toEditorOffset: offset => unifiedTyporaCanvas.editorOffsetFromSourceOffset(offset),
  execute, render: renderMarkdown, resolveUrl: resolveEditorLink, imageAction: editorImageAction,
});

/* ── Table toolbar operations ── */
function initTableToolbar() {
  const bar = document.querySelector('#table-toolbar');
  if (!bar) return;
  bar.querySelector('[data-table-cmd="add-row-below"]')?.addEventListener('click', () => modifyTable('addRowBelow'));
  bar.querySelector('[data-table-cmd="add-row-above"]')?.addEventListener('click', () => modifyTable('addRowAbove'));
  bar.querySelector('[data-table-cmd="add-col-right"]')?.addEventListener('click', () => modifyTable('addColRight'));
  bar.querySelector('[data-table-cmd="add-col-left"]')?.addEventListener('click', () => modifyTable('addColLeft'));
  bar.querySelector('[data-table-cmd="delete-row"]')?.addEventListener('click', () => modifyTable('deleteRow'));
  bar.querySelector('[data-table-cmd="delete-col"]')?.addEventListener('click', () => modifyTable('deleteCol'));
}
function modifyTable(action) {
  const target = tableContextTarget;
  if (!target?.canvas) return;
  const command = {
    addRowBelow: 'add-row-below', addRowAbove: 'add-row-above',
    addColRight: 'add-col-right', addColLeft: 'add-col-left',
    deleteRow: 'delete-row', deleteCol: 'delete-col',
  }[action] || action;
  target.canvas.applyTableCommand(command, target.rowIndex, target.columnIndex, target.block);
}

function showTableContextMenu(canvas, target, event) {
  const menu = document.querySelector('#context-menu');
  if (!menu) return;
  tableContextTarget = { canvas, ...target };
  contextTarget = null;
  menu.replaceChildren();
  const editor = canvas.editor;
  const source = editor.state.doc.toString();
  const cell = parseMarkdownTable(source, target.block)?.visualRows[target.rowIndex]?.cells[target.columnIndex];
  const selection = editor.state.selection.main;
  const from = cell && (selection.empty || selection.from < cell.contentStart || selection.to > cell.contentEnd) ? cell.contentStart : selection.from;
  const to = cell && (selection.empty || selection.from < cell.contentStart || selection.to > cell.contentEnd) ? cell.contentEnd : selection.to;
  const run = command => {
    if (editor.state.doc.toString() !== source) return;
    editor.dispatch({ selection: { anchor: from, head: to } });
    execute(command); menu.hidden = true;
  };
  const tools = document.createElement('div'); tools.className = 'editor-context-tools';
  for (const [label, icon, command] of [['粗体', 'bold', 'bold'], ['斜体', 'italic', 'italic'], ['行内代码', 'code-2', 'inline-code'], ['链接', 'link', 'link'],
    ['引用', 'quote', 'quote'], ['有序列表', 'list-ordered', 'ol'], ['无序列表', 'list', 'ul'], ['任务列表', 'check-square', 'task']]) {
    const button = document.createElement('button'); button.title = label; button.setAttribute('aria-label', label);
    if (['quote', 'ol', 'ul', 'task'].includes(command)) {
      button.disabled = true; button.title = `${label}：Markdown表格单元格不支持此块级格式`;
    }
    const iconElement = document.createElement('i'); iconElement.dataset.lucide = icon; button.append(iconElement);
    button.addEventListener('click', () => run(command)); tools.append(button);
  }
  menu.append(tools); createIcons({ icons: iconSet });
  const actions = [
    ['add-row-above', '在上方插入行'], ['add-row-below', '在下方插入行'],
    ['add-col-left', '在左侧插入列'], ['add-col-right', '在右侧插入列'],
    ['delete-row', '删除当前行'], ['delete-col', '删除当前列'],
    ['move-row-up', '上移该行'], ['move-row-down', '下移该行'],
    ['move-col-left', '左移该列'], ['move-col-right', '右移该列'],
    ['align-left', '该列左对齐'], ['align-center', '该列居中'], ['align-right', '该列右对齐'],
    ['format-table', '格式化表格源码'], ['delete-table', '删除表格'],
  ];
  actions.forEach(([action, label]) => {
    const button = document.createElement('button');
    button.dataset.tableCommand = action;
    button.textContent = label;
    button.disabled = target.rowIndex === 0 && (action === 'add-row-above' || action === 'delete-row');
    button.addEventListener('click', () => {
      canvas.applyTableCommand(action, target.rowIndex, target.columnIndex, target.block);
      tableContextTarget = null;
      menu.hidden = true;
    });
    menu.append(button);
  });
  const copy = document.createElement('button'); copy.textContent = '复制表格';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(target.block.sourceText); }
    catch (error) { alert(`无法复制：${error.message}`); }
    menu.hidden = true;
  });
  menu.append(copy);
  menu.classList.add('editor-context-menu');
  menu.hidden = false;
  menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
}

document.addEventListener('click', event => {
  if (!event.target.closest('[data-menu], #menu-popover')) document.querySelector('#menu-popover').hidden = true;
  /* Editor surfaces own their pointer and selection behavior. The document
     delegate must never reinterpret a click inside an editable block. */
  if (event.target.closest('#typora-editor, #split-editor, #split-preview')) return;
  const closeTabId = event.target.closest('[data-close-tab]')?.dataset.closeTab;
  if (closeTabId) { event.stopPropagation(); closeTab(closeTabId); return; }
  const tabItem = event.target.closest('.document-tab');
  if (tabItem) { if (tabItem.dataset.id !== workspace.activeId) switchDocument(tabItem.dataset.id); return; }
  const command = event.target.closest('[data-command]')?.dataset.command; if (command) execute(command);
  const file = event.target.closest('.file-row'); if (file) switchDocument(file.dataset.id);
  const folder = event.target.closest('.folder-row'); if (folder) {
    const item = workspace.folders.find(value => value.id === folder.dataset.folderId);
    workspace.activeFolderId = item.id; item.expanded = !item.expanded;
    if (directoryHandle?.davTree) {
      rememberWorkspace(workspaceProvider, workspace);
      const tree = directoryHandle.davTree;
      if (item.expanded) void tree.load(item.sourcePath, item.id)
        .then(() => tree.prefetch(item.id, () => item.expanded)).catch(() => {});
    } else persistWorkspace();
    renderFiles(document.querySelector('#document-search').value);
  }
  const menu = event.target.closest('[data-menu]');
  if (menu) {
    const popover = document.querySelector('#menu-popover'); popover.replaceChildren();
    menus[menu.dataset.menu].forEach(([label, cmd, shortcut]) => { const button = document.createElement('button'); button.dataset.command = cmd; const text = document.createElement('span'); text.textContent = label; const key = document.createElement('kbd'); key.textContent = shortcut; button.append(text, key); popover.append(button); });
    const rect = menu.getBoundingClientRect(); popover.style.left = `${rect.left}px`; popover.hidden = false;
  }
  const tab = event.target.closest('[data-panel]'); if (tab) { document.querySelectorAll('.sidebar-tab').forEach(item => item.classList.toggle('active', item === tab)); document.querySelectorAll('.sidebar-panel').forEach(item => item.classList.toggle('active', item.id === `${tab.dataset.panel}-panel`)); }
  const settingsTab = event.target.closest('[data-settings-tab]'); if (settingsTab) { document.querySelectorAll('[data-settings-tab]').forEach(item => item.classList.toggle('active', item === settingsTab)); document.querySelectorAll('[data-settings-page]').forEach(item => item.classList.toggle('active', item.dataset.settingsPage === settingsTab.dataset.settingsTab)); settingsTab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); if (settingsTab.dataset.settingsTab === 'cache') updateCacheSettings(); }
  const theme = event.target.closest('button[data-theme]'); if (theme) { settings.theme = theme.dataset.theme; persistSettings(); }
  const editorTheme = event.target.closest('button[data-editor-theme]'); if (editorTheme) { settings.editorTheme = editorTheme.dataset.editorTheme; persistSettings(); }
});

/* A theme toggle is a non-editing command. Keep the CodeMirror selection and
   composition focus when it is clicked from an active editor. */
document.querySelector('#theme-toggle')?.addEventListener('pointerdown', event => event.preventDefault());

document.querySelector('#file-list').addEventListener('contextmenu', event => {
  event.preventDefault();
  const fileRow = event.target.closest('.file-row');
  const folderRow = event.target.closest('.folder-row');
  if (!fileRow && !folderRow) return;
  contextTarget = fileRow ? { type: 'document', id: fileRow.dataset.id } : { type: 'folder', id: folderRow.dataset.folderId };
  const menu = document.querySelector('#context-menu'); menu.replaceChildren();
  const actions = [['rename', '重命名'], ['new-child', contextTarget.type === 'folder' ? '新建子文档' : '新建同级文档'], ['new-folder-child', contextTarget.type === 'folder' ? '新建子文件夹' : '新建同级文件夹'], ['delete', '删除']];
  actions.forEach(([action, label]) => {
    const button = document.createElement('button'); button.dataset.contextCommand = action; button.textContent = label; menu.append(button);
  });
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 160)}px`;
  menu.hidden = false;
});

function folderDescendants(id) {
  const ids = new Set([id]);
  const children = new Map();
  for (const folder of workspace.folders) {
    if (!children.has(folder.parentId)) children.set(folder.parentId, []);
    children.get(folder.parentId).push(folder.id);
  }
  for (const parent of ids) for (const child of children.get(parent) || []) ids.add(child);
  return [...ids];
}

function validMove(type, id, parentId) {
  if (type === 'document') return !parentId || workspace.folders.some(folder => folder.id === parentId);
  if (id === parentId) return false;
  return !parentId || (workspace.folders.some(folder => folder.id === parentId) && !folderDescendants(id).includes(parentId));
}

let nodeMigrationPending = false;
async function changeNodeLocation(node, changes) {
  if (nodeMigrationPending) return;
  nodeMigrationPending = true;
  const provider = workspaceProvider, handle = directoryHandle;
  const before = { name: node.name, parentId: node.parentId };
  const oldPath = directoryProviderSnapshot.get(node.id)?.path;
  try {
    clearTimeout(saveTimer);
    await persistWorkspace();
    if (provider !== workspaceProvider || handle !== directoryHandle) throw new Error('工作区已切换，未迁移');
    Object.assign(node, changes);
    document.querySelector('#save-state').textContent = '正在迁移';
    renderFiles();
    await persistWorkspace();
    document.querySelector('#save-state').textContent = workspaceDirty ? '未保存' : '已保存';
  } catch (error) {
    // A completed copy may retain some source files. Do not reverse that move
    // just because a later content save failed.
    if (directoryProviderSnapshot.get(node.id)?.path === oldPath) Object.assign(node, before);
    document.querySelector('#save-state').textContent = '迁移未完成';
    alert(error.message);
  } finally {
    nodeMigrationPending = false;
    renderFiles(); renderTabs();
  }
}

document.querySelector('#context-menu').addEventListener('click', event => {
  const tableCommand = event.target.closest('[data-table-command]')?.dataset.tableCommand;
  if (tableCommand && tableContextTarget) {
    tableContextTarget.canvas.applyTableCommand(tableCommand, tableContextTarget.rowIndex, tableContextTarget.columnIndex, tableContextTarget.block);
    tableContextTarget = null;
    document.querySelector('#context-menu').hidden = true;
    return;
  }
  const command = event.target.closest('[data-context-command]')?.dataset.contextCommand;
  if (!command || !contextTarget) return;
  if (command === 'rename' && contextTarget.type === 'document') {
    document.querySelector('#context-menu').hidden = true;
    void renameDocument(contextTarget.id); return;
  }
  if (directoryHandle?.webdav && ['rename', 'delete'].includes(command)) return alert('WebDAV暂不支持文件夹重命名或删除远端文件');
  const target = contextTarget.type === 'document'
    ? workspace.documents.find(item => item.id === contextTarget.id)
    : workspace.folders.find(item => item.id === contextTarget.id);
  const parentId = target?.parentId ?? workspace.activeFolderId;
  if (!target) return;
  if (command === 'rename') {
    const next = prompt(contextTarget.type === 'document' ? '重命名文件' : '重命名文件夹', target.name);
    if (next?.trim() && workspaceProvider.kind === 'directory') {
      document.querySelector('#context-menu').hidden = true;
      void changeNodeLocation(target, { name: next.trim() }); return;
    }
    if (next?.trim()) { target.name = next.trim().replace(/\.md$/i, ''); target.updatedAt = Date.now(); }
  } else if (command === 'new-child') {
    const doc = makeDocument('未命名文档', ''); doc.parentId = contextTarget.type === 'folder' ? target.id : target.parentId; workspace.documents.unshift(doc); switchDocument(doc.id);
  } else if (command === 'new-folder-child') {
    const folder = makeFolder('新建文件夹', contextTarget.type === 'folder' ? target.id : target.parentId); workspace.folders.push(folder); workspace.activeFolderId = folder.id;
  } else if (command === 'delete') {
    if (contextTarget.type === 'document') {
      if (workspace.documents.length <= 1) { alert('至少保留一个文档'); return; }
      if (!confirm(`删除“${target.name}”？`)) return;
      workspace.documents = workspace.documents.filter(item => item.id !== target.id);
      openTabs = openTabs.filter(id => id !== target.id);
      if (workspace.activeId === target.id) switchDocument(openTabs[0] || workspace.documents[0].id);
    } else {
      if (!confirm(`删除“${target.name}”及其中所有文件？`)) return;
      const ids = folderDescendants(target.id);
      workspace.folders = workspace.folders.filter(item => !ids.includes(item.id));
      const removed = workspace.documents.filter(item => ids.includes(item.parentId)).map(item => item.id);
      workspace.documents = workspace.documents.filter(item => !ids.includes(item.parentId));
      openTabs = openTabs.filter(id => !removed.includes(id));
      workspace.activeFolderId = null;
      if (!workspace.documents.length) workspace.documents.push(makeDocument('未命名文档'));
      if (!workspace.documents.some(item => item.id === workspace.activeId)) switchDocument(openTabs[0] || workspace.documents[0].id);
    }
  }
  document.querySelector('#context-menu').hidden = true;
  persistWorkspace(); renderFiles(); renderTabs();
});

document.addEventListener('pointerdown', event => {
  const menu = document.querySelector('#context-menu');
  if (!event.target.closest('#context-menu')) menu.hidden = true;
});

document.querySelector('#file-list').addEventListener('dragstart', event => {
  if (directoryHandle?.webdav) { event.preventDefault(); return; }
  const row = event.target.closest('.file-row, .folder-row');
  if (!row || !event.dataTransfer) return;
  const type = row.classList.contains('file-row') ? 'document' : 'folder';
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-paper-node', JSON.stringify({ type, id: row.dataset.id || row.dataset.folderId }));
  row.classList.add('dragging');
});
document.querySelector('#file-list').addEventListener('dragend', event => {
  event.target.closest('.file-row, .folder-row')?.classList.remove('dragging');
  document.querySelectorAll('.drop-target').forEach(row => row.classList.remove('drop-target'));
});
document.querySelector('#file-list').addEventListener('dragover', event => {
  const target = event.target.closest('.folder-row');
  if (!target) return;
  event.preventDefault(); target.classList.add('drop-target');
});
document.querySelector('#file-list').addEventListener('dragleave', event => {
  if (!event.currentTarget.contains(event.relatedTarget)) return;
  event.target.closest('.folder-row')?.classList.remove('drop-target');
});
document.querySelector('#file-list').addEventListener('drop', event => {
  const target = event.target.closest('.folder-row');
  if (!target) return;
  event.preventDefault();
  let payload;
  try { payload = JSON.parse(event.dataTransfer.getData('application/x-paper-node')); } catch { return; }
  const node = payload.type === 'document' ? workspace.documents.find(item => item.id === payload.id) : workspace.folders.find(item => item.id === payload.id);
  if (!node || !validMove(payload.type, payload.id, target.dataset.folderId)) return;
  if (workspaceProvider.kind === 'directory') {
    target.classList.remove('drop-target');
    void changeNodeLocation(node, { parentId: target.dataset.folderId }); return;
  }
  node.parentId = target.dataset.folderId;
  target.classList.remove('drop-target');
  workspace.activeFolderId = target.dataset.folderId;
  persistWorkspace(); renderFiles();
});

const workspaceRootDrop = document.querySelector('#workspace-root-drop');
workspaceRootDrop.addEventListener('click', () => {
  if (workspaceProvider.kind === 'directory-pending') return reconnectDirectoryWorkspace();
  workspace.activeFolderId = null;
  persistWorkspace();
  renderFiles(document.querySelector('#document-search').value);
});
workspaceRootDrop.addEventListener('dragover', event => {
  if (event.dataTransfer?.types?.includes('application/x-paper-node') || event.dataTransfer?.types?.includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    workspaceRootDrop.classList.add('drop-target');
  }
});
workspaceRootDrop.addEventListener('dragleave', event => {
  if (!workspaceRootDrop.contains(event.relatedTarget)) workspaceRootDrop.classList.remove('drop-target');
});
workspaceRootDrop.addEventListener('drop', async event => {
  event.preventDefault();
  workspaceRootDrop.classList.remove('drop-target');
  const rawNode = event.dataTransfer?.getData('application/x-paper-node');
  if (rawNode) {
    let payload;
    try { payload = JSON.parse(rawNode); } catch { return; }
    const node = payload.type === 'document'
      ? workspace.documents.find(item => item.id === payload.id)
      : workspace.folders.find(item => item.id === payload.id);
    if (!node || !validMove(payload.type, payload.id, null)) return;
    if (workspaceProvider.kind === 'directory') {
      await changeNodeLocation(node, { parentId: null }); return;
    }
    node.parentId = null;
    workspace.activeFolderId = null;
    persistWorkspace();
    renderFiles(document.querySelector('#document-search').value);
    return;
  }
  const files = event.dataTransfer?.files;
  if ([...(files || [])].some(file => /\.(md|markdown|txt)$/i.test(file.name))) await importFiles(files, '', null);
});

document.addEventListener('dragover', event => {
  if (event.target.closest('#typora-view, #split-view, #file-list, #workspace-root-drop')) return;
  if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
});
document.addEventListener('drop', async event => {
  if (event.target.closest('#typora-view, #split-view, #file-list, #workspace-root-drop')) return;
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  const markdown = [...files].some(file => /\.(md|markdown|txt)$/i.test(file.name));
  if (!markdown) return;
  event.preventDefault();
  const rootName = files[0].webkitRelativePath?.split(/[\\/]/)[0] || '';
  await importFiles(files, rootName, null, { createRoot: false });
});

function showMenu(trigger) {
  clearTimeout(menuCloseTimer);
  const popover = document.querySelector('#menu-popover');
  popover.replaceChildren();
  menus[trigger.dataset.menu].forEach(([label, cmd, shortcut]) => {
    const button = document.createElement('button'); button.dataset.command = cmd;
    const text = document.createElement('span'); text.textContent = label;
    const key = document.createElement('kbd'); key.textContent = shortcut;
    button.append(text, key); popover.append(button);
  });
  const rect = trigger.getBoundingClientRect();
  popover.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 238))}px`;
  popover.hidden = false;
}
function scheduleMenuClose() { menuCloseTimer = setTimeout(() => { document.querySelector('#menu-popover').hidden = true; }, 180); }
document.querySelector('#document-search').addEventListener('input', event => renderFiles(event.target.value));
document.querySelector('#file-input').addEventListener('change', async event => {
  await importFiles(event.target.files);
  event.target.value = '';
});
document.querySelector('#folder-input').addEventListener('change', async event => {
  const first = event.target.files?.[0];
  const rootName = first?.webkitRelativePath?.split(/[\\/]/)[0] || '导入目录';
  await importDirectoryFiles(event.target.files, rootName);
  event.target.value = '';
});


async function insertImageFiles(files) {
  const doc = activeDocument();
  const canvas = ensureTyporaCanvas();
  if (!doc || !canvas) return;
  const handle = directoryHandle;
  const providerKind = workspaceProvider.kind;
  const selection = canvas.editor.state.selection.main;
  const bookmark = { documentId: doc.id, from: selection.from, to: selection.to };
  pendingImageInsertions.add(bookmark);
  try {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      let href;
      if (providerKind === 'directory' && handle) {
        href = await saveDirectoryImage(handle, doc.sourcePath, file);
      } else if (providerKind === 'server') {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        href = formatImagePath(await uploadImageData(data, file.name, file.type, doc.id));
      } else {
        throw new Error('请先将文档保存到本地工作区或连接源目录');
      }
      if (activeDocument()?.id !== doc.id || directoryHandle !== handle || workspaceProvider.kind !== providerKind) {
        throw new Error(`图片已保存到 ${href}，文档已切换，未向其它文档插入`);
      }
      const text = `![](${href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
      const from = bookmark.from;
      canvas.editor.dispatch({ changes: { from, to: bookmark.to, insert: text },
        selection: { anchor: from + text.length }, userEvent: 'input.image' });
      bookmark.from = bookmark.to = from + text.length;
      canvas.editor.focus();
    }
  } catch (error) {
    alert(`图片保存未完成：${error.message || error}`);
  } finally {
    pendingImageInsertions.delete(bookmark);
  }
}

document.querySelector('#image-input').addEventListener('change', event => {
  const files = [...event.target.files];
  event.target.value = '';
  void insertImageFiles(files);
});

// Base64 is only a transport for the local server, never a Markdown fallback.
function uploadImageData(base64Data, fileName, mime, documentId) {
  return fetch('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, fileName, mime, pathMode: 'document-assets', data: base64Data }),
  }).then(async response => {
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '本地图片写入失败');
    return response.json();
  }).then(result => result.documentRelativePath || result.relativePath);
}

function formatImagePath(relativePath) {
  const clean = String(relativePath || '').replace(/^\.\//, '');
  return `./${clean}`;
}


document.addEventListener('paste', event => {
  if (!event.target.closest('.cm-content')) return;
  const files = [...(event.clipboardData?.items || [])]
    .filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  void insertImageFiles(files);
}, true);

document.addEventListener('drop', event => {
  if (!event.target.closest('#typora-view, #split-view')) return;
  const images = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  event.stopPropagation();
  void insertImageFiles(images);
}, true);

[ ['setting-autosave','autosave'],['setting-spellcheck','spellcheck'],['setting-line-numbers','showLineNumbers'],['setting-auto-space','autoSpace'],['setting-code-wrap','codeWrap'],['setting-diagrams','diagrams'],['setting-auto-indent','autoIndent'],['setting-match-brackets','matchBrackets'],['setting-match-markdown','matchMarkdown'],['setting-auto-upload','autoUpload'],['setting-relative-image','relativeImage'],['setting-dot-image','dotImage'],['setting-escape-image','escapeImage'] ].forEach(([id,key]) => document.querySelector('#' + id)?.addEventListener('change', event => {
  settings[key] = event.target.checked;
  if (key === 'showLineNumbers' || key === 'codeWrap') {
    document.documentElement.dataset.showLineNumbers = String(settings.showLineNumbers);
    document.documentElement.dataset.codeWrap = String(settings.codeWrap);
  }
  persistSettings();
}));
document.querySelector('#setting-extensions').addEventListener('change', event => { settings.inlineMath = event.target.checked; settings.highlights = event.target.checked; persistSettings(); });
document.querySelector('#setting-toolbar').addEventListener('change', event => { settings.showToolbar = event.target.checked; persistSettings(); });
document.querySelector('#setting-code-language').addEventListener('change', event => { settings.defaultCodeLanguage = event.target.value; persistSettings(); });
document.querySelector('#setting-startup')?.addEventListener('change', event => {
  settings.startupMode = event.target.value;
  persistSettings();
});
document.querySelector('#setting-indent-size')?.addEventListener('change', event => { settings.indentSize = Number(event.target.value); persistSettings(); });
document.querySelector('#setting-line-ending')?.addEventListener('change', event => { settings.lineEnding = event.target.value; persistSettings(); });
document.querySelector('#setting-image-path')?.addEventListener('change', event => { settings.imagePathMode = event.target.value; document.querySelector('#image-custom-path-row').hidden = event.target.value !== 'custom'; persistSettings(); });
document.querySelector('#setting-image-custom')?.addEventListener('input', event => { settings.imageCustomPath = event.target.value; persistSettings(); });
[['setting-font-size','fontSize','font-size-value','px'],['setting-line-height','lineHeight','line-height-value',''],['setting-content-width','contentWidth','content-width-value','px']].forEach(([id,key,output,suffix]) => document.querySelector('#' + id).addEventListener('input', event => { settings[key] = Number(event.target.value); document.querySelector('#' + output).textContent = event.target.value + suffix; persistSettings(); }));

document.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  if (event.key === 'F8') { event.preventDefault(); execute('toggle-focus'); return; }
  if (event.key === 'F9') { event.preventDefault(); execute('typewriter'); return; }
  const isSourceInput = settings.viewMode !== 'typora'
    && Boolean(event.target.closest?.('#split-editor .cm-content'));
  if (!event.ctrlKey && !event.metaKey && !event.altKey && isSourceInput && event.key === 'Tab') {
    event.preventDefault();
    const indent = ' '.repeat(Math.max(2, Math.min(6, Number(settings.indentSize) || 2)));
    const selection = splitSelection();
    if (selection) splitEditorView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: indent },
      selection: { anchor: selection.from + indent.length },
      userEvent: 'input.tab',
    });
    splitEditorView?.focus();
    return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && settings.matchBrackets && (isSourceInput || event.target.closest?.('[contenteditable="true"]'))) {
    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
    const close = pairs[event.key];
    if (close) {
      event.preventDefault();
      if (isSourceInput) {
        const selection = splitSelection();
        if (selection) splitEditorView.dispatch({
          changes: { from: selection.from, to: selection.to, insert: event.key + close },
          selection: { anchor: selection.from + 1 },
          userEvent: 'input.bracket',
        });
        splitEditorView?.focus();
      } else {
        document.execCommand('insertText', false, event.key + close);
        const selection = window.getSelection();
        if (selection?.anchorNode) { const range = document.createRange(); range.setStart(selection.anchorNode, Math.max(0, selection.anchorOffset - 1)); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
      }
      return;
    }
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  let command = null;
  if (event.shiftKey) {
    command = { n:'new', s:'export-md', k:'code', m:'math', q:'quote', i:'image', l:'toggle-sidebar', '1':'show-outline', '2':'show-files', '3':'show-files', '[':'ol', ']':'ul', '`':'inline-code', h:'replace-all' }[key];
  } else command = { n:'new', o:'open', s:'export-md', k:'link', t:'table', f:'find', '/':'source', ',':'settings', '0':'paragraph', '1':'h1', '2':'h2', '3':'h3', '4':'h4', '5':'h5', '6':'h6', h:'find' }[key];
  if ((key === 'b' || key === 'i') && !event.shiftKey) command = key === 'b' ? 'bold' : 'italic';
  if (key === 'u' && !event.shiftKey) command = 'underline';
  if (event.altKey && event.shiftKey && key === '5') command = 'strike';
  if (command) { event.preventDefault(); execute(command); }
});

const resizer = document.querySelector('#sidebar-resizer');

function finishSidebarResize(event) {
  if (event?.pointerId != null && resizer.hasPointerCapture(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
  document.body.classList.remove('resizing');
  const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'));
  if (Number.isFinite(width)) { settings.sidebarWidth = Math.round(width); persistSettings(); }
}
resizer.addEventListener('pointerdown', event => {
  if (window.innerWidth <= 760) return;
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
});
resizer.addEventListener('pointermove', event => {
  if (!resizer.hasPointerCapture(event.pointerId)) return;
  const width = Math.min(420, Math.max(210, event.clientX));
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
});
resizer.addEventListener('pointerup', finishSidebarResize);
resizer.addEventListener('pointercancel', finishSidebarResize);
resizer.addEventListener('lostpointercapture', finishSidebarResize);

syncSettingsControls();
updateWorkspaceRootLabel();
/* Consumers that automate or immediately interact with the page need an
   explicit boundary after the async workspace bootstrap and final settings
   application have completed. */
document.documentElement.dataset.appReady = 'true';
startDavTree(directoryHandle);
if (davStartupError) scheduleDavRecovery(davStartupError);
