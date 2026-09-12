function parts(path) {
  const value = String(path).replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) {
    throw new Error('迁移路径必须位于已授权目录内');
  }
  return value.split('/');
}

async function parentAt(root, path, create = false) {
  const names = parts(path), name = names.pop();
  let parent = root;
  for (const part of names) parent = await parent.getDirectoryHandle(part, { create });
  return { parent, name };
}

async function digest(file) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
    .map(value => value.toString(16).padStart(2, '0')).join('');
}

async function inventory(handle, path = '') {
  if (handle.kind === 'file') {
    const file = await handle.getFile();
    return [{ path, kind: 'file', handle, file, hash: await digest(file) }];
  }
  const entries = [{ path, kind: 'directory', handle }];
  for await (const [name, child] of handle.entries()) {
    entries.push(...await inventory(child, path ? `${path}/${name}` : name));
  }
  return entries;
}

async function unchanged(handle, snapshot) {
  const current = await inventory(handle);
  const expected = new Map(snapshot.map(entry => [entry.path, entry]));
  return current.length === expected.size && current.every(entry => {
    const before = expected.get(entry.path);
    return before?.kind === entry.kind && before.hash === entry.hash;
  });
}

// Descendants of a moved folder travel as bytes, not as reconstructed Markdown.
export function planDirectoryMoves(layout, snapshot) {
  const changed = [...layout.folders, ...layout.documents].flatMap(item => {
    const old = snapshot.get(item.id);
    if (!old || old.path === item.relativePath) return [];
    parts(old.path); parts(item.relativePath);
    return [{ from: old.path, to: item.relativePath, kind: old.type === 'folder' ? 'directory' : 'file' }];
  }).sort((a, b) => a.from.split('/').length - b.from.split('/').length);
  const roots = [];
  for (const move of changed) {
    const ancestor = roots.find(root => root.kind === 'directory' && move.from.startsWith(root.from + '/'));
    if (ancestor) {
      if (move.to !== ancestor.to + move.from.slice(ancestor.from.length)) throw new Error('请分步移动父目录与其内部文件');
    } else roots.push(move);
  }
  for (const move of roots) {
    const from = move.from.toLocaleLowerCase(), to = move.to.toLocaleLowerCase();
    if (to === from || to.startsWith(from + '/') || from.startsWith(to + '/')) throw new Error('不能迁移到自身、子目录或仅改变大小写');
    if (roots.some(other => other !== move && (move.to === other.from || move.to.startsWith(other.from + '/')))) throw new Error('请分步移动互相依赖的目录');
  }
  return roots;
}

export async function migrateDirectoryEntry(root, move) {
  const from = parts(move.from).join('/').toLocaleLowerCase(), to = parts(move.to).join('/').toLocaleLowerCase();
  if (to === from || to.startsWith(from + '/') || from.startsWith(to + '/')) throw new Error('不能迁移到自身或子目录');
  const source = await parentAt(root, move.from);
  const handle = move.kind === 'directory'
    ? await source.parent.getDirectoryHandle(source.name)
    : await source.parent.getFileHandle(source.name);
  const snapshot = await inventory(handle);
  const destination = await parentAt(root, move.to, true);
  for await (const [name] of destination.parent.entries()) {
    if (name.toLocaleLowerCase() === destination.name.toLocaleLowerCase()) throw new Error(`迁移目标已存在，未覆盖：${move.to}`);
  }
  let target;
  try {
    target = move.kind === 'directory'
      ? await destination.parent.getDirectoryHandle(destination.name, { create: true })
      : await destination.parent.getFileHandle(destination.name, { create: true });
    for (const entry of snapshot) {
      let next = target;
      if (entry.path) {
        const location = await parentAt(target, entry.path);
        for await (const [name] of location.parent.entries()) {
          if (name.toLocaleLowerCase() === location.name.toLocaleLowerCase()) throw new Error('目标目录已变化，未覆盖');
        }
        next = entry.kind === 'directory'
          ? await location.parent.getDirectoryHandle(location.name, { create: true })
          : await location.parent.getFileHandle(location.name, { create: true });
      }
      if (entry.kind !== 'file') continue;
      if ((await next.getFile()).size !== 0) throw new Error('目标文件已变化，未覆盖');
      const writer = await next.createWritable();
      try { await writer.write(entry.file); await writer.close(); }
      catch (error) { await writer.abort?.().catch(() => {}); throw error; }
      if (await digest(await next.getFile()) !== entry.hash) throw new Error('目标文件校验失败');
    }
    if (!await unchanged(handle, snapshot) || !await unchanged(target, snapshot)) throw new Error('复制期间源目录或目标目录已变化');
  } catch (error) {
    // Keep partial output too: another application may have changed it meanwhile.
    throw new Error(`迁移未完成，原路径未删除；请检查目标副本 ${move.to}：${error.message}`);
  }

  const retained = [];
  // Never recursively delete: newly added or changed files must survive cleanup.
  for (const entry of [...snapshot].reverse()) {
    try {
      if (entry.kind === 'file') {
        const next = entry.path ? await parentAt(target, entry.path) : destination;
        const nextHandle = await next.parent.getFileHandle(next.name);
        if (await digest(await entry.handle.getFile()) !== entry.hash || await digest(await nextHandle.getFile()) !== entry.hash) {
          retained.push(entry.path || move.from); continue;
        }
      }
      const old = entry.path ? await parentAt(handle, entry.path) : source;
      await old.parent.removeEntry(old.name);
    } catch { retained.push(entry.path || move.from); }
  }
  return { retained };
}
