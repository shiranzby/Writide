import { XMLParser } from 'fast-xml-parser';

// Parse and constrain paginated WebDAV directory responses.

const directoryPath = url => decodeURIComponent(url.pathname).replace(/\/+$/, '');

export async function readDirectoryPage(client, endpoint, path, cursor = '', background = false, metadata = false) {
  const target = new URL(endpoint);
  const relative = path.replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
  target.pathname = target.pathname.replace(/\/*$/, '/') + relative.replace(/\/*$/, relative ? '/' : '');
  const validate = value => {
    const url = new URL(value, target);
    if (url.origin !== target.origin || url.username || url.password || url.hash || directoryPath(url) !== directoryPath(target)) {
      throw new Error('WebDAV分页地址超出当前目录，已停止加载');
    }
    return url.href;
  };
  const requestUrl = cursor ? validate(cursor) : target.href;
  const response = await client.customRequest(path, { url: requestUrl, method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'X-Paper-Dav-Work': background ? 'prefetch' : 'read' },
    data: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/>${metadata ? '<d:getetag/><d:getlastmodified/><d:getcontentlength/>' : ''}</d:prop></d:propfind>`,
    signal: AbortSignal.timeout(15000) });
  const xml = await response.text();
  if (xml.length > 20 * 1024 * 1024) throw new Error('目录响应过大');
  const parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(xml);
  if (!parsed.multistatus) throw new Error('无效WebDAV目录响应');
  const entries = [];
  for (const item of [parsed.multistatus.response || []].flat()) {
    const href = new URL(item.href, target);
    const fullPath = directoryPath(href), parent = directoryPath(target);
    if (href.origin !== target.origin || fullPath === parent) continue;
    if (!fullPath.startsWith(parent + '/')) throw new Error('目录返回了越界条目');
    const name = fullPath.slice(parent.length + 1);
    if (!name || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new Error('目录返回了无效文件名');
    const success = [item.propstat || []].flat().filter(prop => / 2\d\d(?: |$)/.test(prop.status));
    const props = Object.assign({}, ...success.map(prop => prop.prop));
    if (!Object.hasOwn(props, 'resourcetype')) throw new Error('目录条目没有类型或读取权限');
    entries.push({ name, kind: props.resourcetype?.collection !== undefined ? 'directory' : 'file',
      ...(metadata ? { etag: typeof props.getetag === 'string' ? props.getetag : null,
        modified: props.getlastmodified || '', size: /^\d+$/.test(props.getcontentlength) ? Number(props.getcontentlength) : null } : {}) });
  }
  let nextCursor = null;
  for (const link of (response.headers.get('link') || '').matchAll(/<([^>]+)>\s*;[^,]*?\brel\s*=\s*(?:"([^"]+)"|([^\s,;]+))/gi)) {
    if ((link[2] || link[3]).split(/\s+/).includes('next')) nextCursor = validate(link[1]);
  }
  if (nextCursor === requestUrl) throw new Error('WebDAV分页地址重复，已停止加载');
  return { entries, nextCursor };
}
