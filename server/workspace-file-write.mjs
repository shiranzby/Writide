import { readFile, writeFile } from 'node:fs/promises';

// Preserve source bytes until the replacement file is durably verified.

export async function writeWorkspaceFile(target, content, renamed = false) {
  let current = null;
  try { current = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (renamed && current !== null) throw new Error('重命名目标已存在，未覆盖');
  // Exclusive creation also protects a target appearing after the existence check.
  if (current !== content) await writeFile(target, content, { encoding: 'utf8', flag: renamed ? 'wx' : 'w' });
}
