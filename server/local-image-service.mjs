import { realpath, readFile, stat, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Server-side bridge for operations constrained to the managed workspace.

const imageExtension = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
function contained(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('路径超出已授权目录');
  return target;
}

// A grant is session-local, scoped to a root confirmed against the open file.
export function createLocalImageService({ workspaceRoot, reveal }) {
  const grants = new Map();
  return {
    async grant({ rootPath, documentPath, expectedContent, serverWorkspace = false }) {
      const root = await realpath(serverWorkspace ? workspaceRoot : rootPath);
      if (!documentPath || path.isAbsolute(documentPath)) throw new Error('缺少文档相对路径');
      const document = contained(root, await realpath(contained(root, path.resolve(root, documentPath))));
      if (await readFile(document, 'utf8') !== expectedContent) throw new Error('此目录中的文档与当前内容不一致；请等待保存后确认正确源目录');
      const id = randomUUID(); grants.set(id, { root, document });
      return { grantId: id };
    },
    async run({ grantId, action, href, newName }) {
      const grant = grants.get(grantId); if (!grant) throw new Error('目录授权已失效，请重新确认源目录');
      const { root, document } = grant;
      if (typeof href !== 'string' || /^(?:[a-z][a-z\d+.-]*:|\/\/|[\\/])/i.test(href)) throw new Error('仅支持源目录内的相对图片地址');
      const relative = decodeURIComponent(href.split(/[?#]/)[0]);
      if (!imageExtension.test(relative)) throw new Error('仅允许图片文件');
      const requested = contained(root, path.resolve(path.dirname(document), relative));
      const file = contained(root, await realpath(requested));
      if (file !== requested) throw new Error('不对符号链接图片执行文件操作');
      if (!(await stat(file)).isFile()) throw new Error('目标不是图片文件');
      if (action === 'reveal') { await reveal(file); return { ok: true }; }
      if (action !== 'rename') throw new Error('不支持的图片操作');
      if (typeof newName !== 'string' || !newName || /[\\/:*?"<>|\x00-\x1f]/.test(newName)
          || /[. ]$/.test(newName) || newName === '.' || newName === '..'
          || !imageExtension.test(newName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(newName)) throw new Error('图片文件名不合法');
      const target = contained(root, path.join(path.dirname(file), newName));
      if (target === file) return { href, ok: true };
      // link is exclusive: unlike rename, it can never overwrite a name that
      // another process created after the existence check. Both names share bytes.
      await link(file, target);
      try { await unlink(file); }
      catch (error) { await unlink(target); throw error; }
      return { ok: true, href: href.slice(0, href.lastIndexOf('/') + 1) + encodeURIComponent(newName) };
    },
  };
}
