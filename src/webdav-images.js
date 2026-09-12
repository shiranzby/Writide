import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: true });
export function davImageReferences(source) {
  source = source.replace(/\r\n?/g, '\n');
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const result = [];
  const add = (src, offset) => {
    if (src && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) result.push({ src, offset });
  };
  for (const token of parser.parse(source, {})) {
    const offset = starts[token.map?.[0] || 0];
    for (const child of token.type === 'inline' ? token.children || [] : [token]) {
      if (child.type === 'image') add(child.attrGet('src'), offset);
      if (['html_inline', 'html_block'].includes(child.type)) {
        const template = document.createElement('template'); template.innerHTML = child.content;
        template.content.querySelectorAll('img[src]').forEach(image => add(image.getAttribute('src'), offset));
      }
    }
  }
  return result;
}

// Keep remote source URLs inert until their preview is near the viewport.
export function deferDavImage(image) {
  const source = image.getAttribute('src');
  if (source && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) {
    image.dataset.davSrc = source;
    image.removeAttribute('src');
    image.dataset.davPending = 'true';
  }
}

export function createDavImageLoader({ windowJobs = () => [] } = {}) {
  const images = new Map(), jobs = new Map(), resolved = new Map(), visible = new Set();
  let wanted = new Set(), running = 0, retryTimer, frame;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
    }
    schedule();
  }, { rootMargin: '250px 0px' });
  function remove(image) { observer.unobserve(image); images.delete(image); visible.delete(image); }
  function schedule() { if (!frame) frame = requestAnimationFrame(plan); }
  function plan() {
    frame = null;
    if (document.hidden) return;
    wanted = new Set();
    const candidates = [];
    for (const [image, item] of images) {
      if (!image.isConnected) { remove(image); continue; }
      if (visible.has(image)) candidates.push(item);
    }
    candidates.push(...windowJobs());
    for (const item of candidates) {
      if (resolved.has(item.key)) continue;
      wanted.add(item.key);
      if (!jobs.has(item.key)) jobs.set(item.key, { ...item, running: false, retryAt: 0 });
    }
    for (const [key, job] of jobs) if (!wanted.has(key) && !job.running) jobs.delete(key);
    pump();
  }
  function pump() {
    clearTimeout(retryTimer);
    let nextRetry = Infinity;
    for (const key of wanted) {
      const job = jobs.get(key);
      if (!job || job.running || document.hidden) continue;
      if (job.retryAt > Date.now()) { nextRetry = Math.min(nextRetry, job.retryAt); continue; }
      if (running >= 10) break;
      running++; job.running = true;
      job.load().then(url => {
        jobs.delete(key); resolved.set(key, url);
        if (resolved.size > 512) resolved.delete(resolved.keys().next().value);
        for (const [image, item] of images) if (item.key === key) {
          if (url && image.isConnected) image.src = url;
          remove(image);
        }
      }).catch(error => {
        for (const [image, item] of images) if (item.key === key) {
          image.dispatchEvent(new Event('error'));
          if (error.retryAt) image.title = '图片等待请求额度恢复';
        }
        job.retryAt = error.retryAt || Date.now() + 30000;
      }).finally(() => { running--; job.running = false; pump(); });
    }
    if (Number.isFinite(nextRetry)) retryTimer = setTimeout(pump, Math.max(1000, nextRetry - Date.now()));
  }
  document.addEventListener('visibilitychange', schedule);
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  document.addEventListener('keyup', schedule);
  document.addEventListener('pointerup', schedule);
  return (image, load, key) => {
    if (resolved.has(key)) { image.src = resolved.get(key); return; }
    images.set(image, { load, key }); observer.observe(image); schedule();
  };
}
