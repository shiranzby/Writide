import { createHash } from 'node:crypto';

// A shared per-account queue covers different tabs and DAV sessions.
export function createDavTransport({ fetcher = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const accounts = new Map();
  return (url, options = {}) => {
    const parsed = new URL(url);
    const auth = new Headers(options.headers).get('authorization') || '';
    const key = parsed.origin + createHash('sha256').update(auth).digest('hex');
    let state = accounts.get(key);
    if (!state) accounts.set(key, state = { queue: Promise.resolve(), next: 0, retryAt: 0, failures: 0, requests: [] });
    const admitted = state.queue.then(async () => {
      if (state.retryAt > now()) throw Object.assign(new Error('WebDAV冷却中'), { status: 503, retryAt: state.retryAt });
      if (state.next > now()) await sleep(state.next - now());
      if (state.retryAt > now()) throw Object.assign(new Error('WebDAV冷却中'), { status: 503, retryAt: state.retryAt });
      const headers = new Headers(options.headers);
      const kind = headers.get('x-paper-dav-work') || (/^(PUT|MKCOL)$/i.test(options.method || '') ? 'write' : 'read');
      headers.delete('x-paper-dav-work');
      const nutstore = parsed.hostname === 'dav.jianguoyun.com';
      if (nutstore) {
        state.requests = state.requests.filter(item => item.time > now() - 1800000);
        // Leave 60 requests for other clients, and 60 more for saves/read-back.
        const max = kind === 'write' ? (options.method?.toUpperCase() === 'PUT' ? 539 : 540) : 480;
        const background = state.requests.filter(item => item.kind === 'prefetch');
        if (state.requests.length >= max || (kind === 'prefetch' && background.length >= 60)) {
          const first = kind === 'prefetch' && background.length >= 60 ? background[0] : state.requests[0];
          throw Object.assign(new Error('已达到本应用请求预算，暂停加载'), { status: 429, retryAt: first.time + 1800000 });
        }
        state.requests.push({ time: now(), kind });
      }
      state.next = now() + (nutstore ? 150 : 0);
      return headers;
    });
    // Serialize quota admission, not the network response: slow images may overlap.
    state.queue = admitted.catch(() => {});
    const operation = admitted.then(async headers => {
      const response = await fetcher(url, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if ([429, 503].includes(response.status)) {
        const retry = response.headers.get('retry-after');
        const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now();
        state.retryAt = now() + Math.max(1000, Number.isFinite(delay) ? delay : Math.min(300000, 30000 * 2 ** state.failures));
        state.failures++;
        await response.body?.cancel();
        throw Object.assign(new Error('WebDAV暂时不可用'), { status: response.status, retryAt: state.retryAt });
      }
      if (state.retryAt <= now()) { state.failures = 0; state.retryAt = 0; }
      if (['GET', 'PROPFIND'].includes((options.method || 'GET').toUpperCase()) && response.ok && response.body) {
        const limit = 20 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('单文件超过20MiB'); }
        let bytes = 0;
        return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > limit) throw new Error('单文件超过20MiB');
          controller.enqueue(chunk);
        } })), { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      return response;
    });
    return operation;
  };
}
