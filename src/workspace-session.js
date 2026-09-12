const key = 'paper-last-workspace-v1';
export function readWorkspaceSession(storage = localStorage) {
  try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
}
export function rememberWorkspace(provider, workspace, storage = localStorage) {
  const previous = readWorkspaceSession(storage);
  const doc = workspace.documents.find(item => item.id === workspace.activeId);
  storage.setItem(key, JSON.stringify({ provider,
    lastFile: doc ? { id: doc.id, path: doc.sourcePath } : previous?.provider.id === provider.id ? previous.lastFile : null }));
}
export function restoreWorkspaceFile(workspace, mode, previous) {
  if (mode === 'last-directory') return { ...workspace, activeId: null, activeFolderId: null };
  if (!previous?.lastFile) return workspace;
  const last = previous.lastFile;
  const doc = workspace.documents.find(item => last.path ? item.sourcePath === last.path : item.id === last.id);
  // A removed/renamed file is not permission to silently open a different file.
  return { ...workspace, activeId: doc?.id || null, activeFolderId: doc?.parentId || null };
}
