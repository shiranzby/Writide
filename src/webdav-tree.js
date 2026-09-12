// Only enumerate an opened directory and one level of its children. Never recurse.
export function createDavTree(handle, idFor) {
  let workspace = { documents: [], folders: [], activeId: null, activeFolderId: null };
  const snapshot = new Map(), states = new Map();
  const tree = { workspace, snapshot, bind: value => { workspace = value; }, changed: () => {}, active: () => true, load, prefetch, restorePath };
  async function load(path = '', parentId = null, background = false) {
    let state = states.get(path);
    if (!state) states.set(path, state = { cursor: null, done: false, visited: new Set() });
    if (state.done) return;
    if (state.pending) return state.pending;
    const folder = workspace.folders.find(item => item.id === parentId);
    if (folder) { folder.davLoading = true; delete folder.davError; }
    tree.changed();
    state.pending = (async () => {
      do {
        const page = await handle.readDirectoryPage(path, state.cursor, background);
        for (const item of page.entries) {
          if (item.name.startsWith('.') || (item.kind === 'directory' && item.name.endsWith('.assets'))) continue;
          const type = item.kind === 'directory' ? 'folder' : 'document';
          if (type === 'document' && !/\.(md|markdown|txt)$/i.test(item.name)) continue;
          const sourcePath = path ? path + '/' + item.name : item.name;
          // New local entries can be saved while a background page is in flight.
          if ([...snapshot.values()].some(entry => entry.path === sourcePath)) continue;
          const id = idFor(type, sourcePath);
          if (type === 'folder') workspace.folders.push({ id, name: item.name, parentId, sourcePath, expanded: false });
          else {
            const extension = item.name.match(/\.(md|markdown|txt)$/i)[0];
            workspace.documents.push({ id, name: item.name.slice(0, -extension.length), parentId, sourcePath,
              sourceExtension: extension, content: '', webdavUnloaded: true, updatedAt: Date.now() });
          }
          snapshot.set(id, { type, path: sourcePath });
        }
        if (page.nextCursor && state.visited.has(page.nextCursor)) throw new Error('WebDAV分页循环，目录尚未完整加载');
        if (page.nextCursor) state.visited.add(page.nextCursor);
        state.cursor = page.nextCursor;
        state.done = !state.cursor;
        tree.changed();
      } while (!state.done && tree.active());
    })().catch(error => { if (folder) folder.davError = error.message; throw error; })
      .finally(() => { state.pending = null; if (folder) folder.davLoading = false; tree.changed(); });
    return state.pending;
  }
  async function prefetch(parentId = null, stillWanted = () => true) {
    for (const child of workspace.folders.filter(item => item.parentId === parentId)) {
      if (!tree.active() || !stillWanted() || (typeof document !== 'undefined' && document.hidden)) return;
      try { await load(child.sourcePath, child.id, true); }
      catch { return; } // A throttle or failure stops speculation; an explicit click retries.
    }
  }
  async function restorePath(path) {
    if (!path) return;
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length++) {
      const parentPath = parts.slice(0, length).join('/');
      const folder = workspace.folders.find(item => item.sourcePath === parentPath);
      if (!folder) return;
      folder.expanded = true;
      await load(parentPath, folder.id);
    }
  }
  return tree;
}
