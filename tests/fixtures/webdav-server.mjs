import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function mockWebdav({ pageSize = Infinity, nextLink = null, imageDelayMs = 0 } = {}) {
  const files = new Map([['说明.md', { data: Buffer.from('# 远端文档\n\n原文'), etag: '"initial"' }]]);
  const folders = new Set(['']);
  const calls = [];
  const metrics = { activeImages: 0, peakImages: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== `Basic ${Buffer.from('writer:secret').toString('base64')}`) { res.writeHead(401); res.end(); return; }
    const path = decodeURIComponent(url.pathname).replace(/^\/dav\//, '').replace(/\/$/, '');
    calls.push({ method: req.method, path, query: url.search, match: req.headers['if-match'], depth: req.headers.depth, overwrite: req.headers.overwrite });
    const file = files.get(path);
    const exists = file || folders.has(path);
    if (req.method === 'PROPFIND') {
      if (!exists) { res.writeHead(404); res.end(); return; }
      const names = [path];
      if (req.headers.depth !== '0' && folders.has(path)) for (const name of [...folders, ...files.keys()]) {
        if (name && name.slice(0, Math.max(0, name.lastIndexOf('/'))) === path) names.push(name);
      }
      const offset = Number(url.searchParams.get('offset')) || 0;
      const paging = req.headers.depth !== '0';
      const selected = paging ? names.slice(offset, offset + pageSize) : names;
      const xml = selected.map(name => {
        const item = files.get(name);
        const href = '/dav/' + name.split('/').map(encodeURIComponent).join('/') + (folders.has(name) && name ? '/' : '');
        return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${folders.has(name) ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${item?.data.length || 0}</d:getcontentlength><d:getetag>${item?.etag || ''}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      }).join('');
      const headers = { 'Content-Type': 'application/xml' };
      if (paging && offset + pageSize < names.length) {
        const link = nextLink ? nextLink(url, offset + pageSize) : `${url.pathname}?offset=${offset + pageSize}&limit=${pageSize}`;
        headers.Link = `<${link}>; rel="next"`;
      }
      res.writeHead(207, headers);
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`);
    } else if (req.method === 'GET' && file) {
      if (path.endsWith('.png')) {
        metrics.activeImages++; metrics.peakImages = Math.max(metrics.peakImages, metrics.activeImages);
        res.once('close', () => { metrics.activeImages--; });
        if (imageDelayMs) await new Promise(resolve => setTimeout(resolve, imageDelayMs));
      }
      res.writeHead(200, { ETag: file.etag, 'Content-Type': path.endsWith('.png') ? 'image/png' : 'text/plain' }); res.end(file.data);
    } else if (req.method === 'MOVE') {
      const destination = new URL(req.headers.destination, url);
      const to = decodeURIComponent(destination.pathname).replace(/^\/dav\//, '');
      if (!file) { res.writeHead(404); res.end(); return; }
      if (req.headers['if-match'] !== file.etag || (req.headers.overwrite === 'F' && (files.has(to) || folders.has(to)))) { res.writeHead(412); res.end(); return; }
      files.set(to, file); files.delete(path); res.writeHead(201); res.end();
    } else if (req.method === 'PUT') {
      if ((req.headers['if-none-match'] === '*' && exists) || (req.headers['if-match'] && req.headers['if-match'] !== file?.etag)) { res.writeHead(412); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      files.set(path, { data: Buffer.concat(chunks), etag: `"${randomUUID()}"` });
      res.writeHead(201); res.end();
    } else if (req.method === 'MKCOL') { folders.add(path); res.writeHead(201); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { files, folders, calls, metrics, url: `http://127.0.0.1:${server.address().port}/dav/`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
