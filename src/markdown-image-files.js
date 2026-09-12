export async function saveDirectoryImage(root, documentPath, file) {
  const parts = String(documentPath || '').replace(/\\/g, '/').split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) throw new Error('请先保存文档到源目录');
  const documentName = parts.pop();
  let parent = root;
  for (const part of parts) parent = await parent.getDirectoryHandle(part);
  const folderName = documentName.replace(/\.[^.]+$/, '') + '.assets';
  const folder = await parent.getDirectoryHandle(folderName, { create: true });
  const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
  const extension = extensions[file.type];
  if (!extension) throw new Error('不支持的图片类型');
  const filename = `image-${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const handle = await folder.getFileHandle(filename, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(file);
    await writer.close();
  } catch (error) {
    await writer.abort?.().catch(() => {});
    throw error;
  }
  return `./${folderName}/${filename}`;
}

export async function renameDirectoryImage(root, documentPath, href, newName) {
  if (!newName.trim() || /[\\/:*?"<>|]/.test(newName) || /[. ]$/.test(newName)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(newName)) throw new Error('文件名不合法');
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(href)) throw new Error('只允许源目录中的相对图片地址');
  const documentParts = String(documentPath || '').replace(/\\/g, '/').split('/');
  if (documentParts.some(part => !part || part === '.' || part === '..')) throw new Error('文档路径超出授权目录');
  const parts = documentParts.slice(0, -1);
  for (const part of decodeURIComponent(href.split(/[?#]/)[0]).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('图片路径超出授权目录');
      parts.pop();
    } else parts.push(part);
  }
  const oldName = parts.pop();
  if (!oldName) throw new Error('图片路径无效');
  if (root.queryPermission && await root.queryPermission({ mode: 'readwrite' }) !== 'granted'
      && await root.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('目录写入权限未授权，请重新连接目录');
  let parent = root;
  for (const part of parts) parent = await parent.getDirectoryHandle(part);
  const move = async (from, to) => {
    if (from === to) return;
    try { await parent.getFileHandle(to); throw new Error('同名文件已存在，未覆盖'); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    const original = await (await parent.getFileHandle(from)).getFile();
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    const matchesOriginal = async file => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return bytes.length === originalBytes.length && bytes.every((value, index) => value === originalBytes[index]);
    };
    let created = false, written = false;
    try {
      const target = await parent.getFileHandle(to, { create: true });
      created = true;
      const writer = await target.createWritable();
      try { await writer.write(original); await writer.close(); }
      catch (error) { await writer.abort?.().catch(() => {}); throw error; }
      written = true;
      if (!await matchesOriginal(await target.getFile())) throw new Error('目标文件内容已变化，未删除源文件');
      if (!await matchesOriginal(await (await parent.getFileHandle(from)).getFile())) throw new Error('源文件在重命名期间已变化，未删除');
      await parent.removeEntry(from);
    } catch (error) {
      if (created) {
        try {
          const current = await (await parent.getFileHandle(to)).getFile();
          if ((!written && current.size === 0) || await matchesOriginal(current)) await parent.removeEntry(to);
        } catch { /* Preserve an uncertain target rather than delete another writer's data. */ }
      }
      throw error;
    }
  };
  await move(oldName, newName);
  const path = href.split(/[?#]/)[0];
  return { href: path.slice(0, path.lastIndexOf('/') + 1) + encodeURIComponent(newName) + href.slice(path.length),
    rollback: () => move(newName, oldName) };
}
