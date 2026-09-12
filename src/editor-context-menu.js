import { createIcons, Bold, Italic, Code2, Link, Quote, List, ListOrdered, CheckSquare, Scissors, Copy, Clipboard, Trash2 } from 'lucide';
import { Transaction } from '@codemirror/state';
import { imageReferenceReplacement } from './markdown-image-reference.js';

export function showResolvedEditorUrl(tab, url) {
  if (!tab) return;
  const target = new URL(url, location.href);
  if (target.protocol === 'blob:' || /^data:image\//i.test(url) || (target.origin === location.origin && /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(target.pathname))) {
    // Local SVG must remain an image, never an executable same-origin page.
    const viewer = new URL('/image-viewer.html', location.origin);
    viewer.searchParams.set('src', url); tab.location.href = viewer.href;
  } else tab.location.href = url;
}

// Context actions patch the same Markdown document and use its undo history.
export function installEditorContextMenu({ menu, getEditor, getDocumentId, toEditorOffset, execute, render, resolveUrl, imageAction }) {
  const icons = { Bold, Italic, Code2, Link, Quote, List, ListOrdered, CheckSquare, Scissors, Copy, Clipboard, Trash2 };
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const open = async href => {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try { const url = await resolveUrl(href); if (!url) throw new Error('不支持此链接类型'); showResolvedEditorUrl(tab, url); }
    catch (error) { tab?.close(); throw error; }
  };
  const add = (parent, label, action, { disabled = false, title = '' } = {}) => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.disabled = disabled; button.title = title;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', async event => {
      event.stopPropagation(); menu.hidden = true;
      try { await action(); } catch (error) { alert(`操作未完成：${error.message || error}`); }
    });
    parent.append(button); return button;
  };
  const submenu = (label) => {
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = label;
    const body = document.createElement('div'); body.className = 'editor-context-submenu'; body.setAttribute('role', 'menu');
    details.append(summary, body); menu.append(details); return body;
  };
  const toolbar = entries => {
    const bar = document.createElement('div'); bar.className = 'editor-context-tools';
    for (const [label, icon, action] of entries) {
      const button = add(bar, '', action, { title: label }); button.setAttribute('aria-label', label);
      const symbol = document.createElement('i'); symbol.dataset.lucide = icon; button.append(symbol);
    }
    menu.append(bar);
  };
  menu.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.hidden = true; });
  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented || !event.target.closest('#typora-editor, #split-editor, #split-preview')) return;
    // The table node already owns precise row/column context and its own menu.
    if (event.target.closest('td, th, .live-table-cell')) return;
    const view = getEditor(); if (!view) return;
    event.preventDefault();
    menu.replaceChildren(); menu.classList.add('editor-context-menu');
    const snapshot = view.state.doc.toString();
    const docId = getDocumentId();
    const nativeSelection = window.getSelection()?.toString() || '';
    const nativeRange = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneContents() : null;
    const nativeHtml = document.createElement('div'); if (nativeRange) nativeHtml.append(nativeRange);
    const preview = Boolean(event.target.closest('#split-preview'));
    let { from, to } = view.state.selection.main;
    const image = event.target.closest('img');
    const link = event.target.closest('a[href], [data-link-href]');
    if (image && image.hasAttribute('data-source-start')) {
      from = Number(image.dataset.sourceStart); to = Number(image.dataset.sourceEnd);
      if (preview) { from = toEditorOffset(from); to = toEditorOffset(to); }
    } else if (!preview && from === to) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) { from = to = pos; view.dispatch({ selection: { anchor: pos } }); }
    }
    const validRange = Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to <= snapshot.length;
    const selected = preview && !image ? nativeSelection : snapshot.slice(from, to);
    const check = () => {
      if (view !== getEditor() || view.state.doc.toString() !== snapshot || getDocumentId() !== docId) {
        throw new Error('文档已变化，请重新打开菜单');
      }
    };
    const replace = (value, fileOperation = false) => {
      check(); if (!validRange || (preview && !image)) throw new Error('请在编辑区选择要修改的内容');
      view.dispatch({ changes: { from, to, insert: value }, selection: { anchor: from + value.length },
        annotations: fileOperation ? Transaction.addToHistory.of(false) : [], userEvent: 'input.context' }); view.focus();
    };
    const copy = value => navigator.clipboard.writeText(value);
    const html = () => preview && !image ? nativeHtml.innerHTML : render(selected);
    const command = cmd => { check(); if (!preview || image) view.dispatch({ selection: { anchor: from, head: to } }); execute(cmd); };
    const canEdit = !preview || Boolean(image && validRange);
    if (image) {
      const href = image.dataset.originalSrc || image.getAttribute('src');
      add(menu, '打开图片', () => open(href));
      const local = !/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(href);
      add(menu, '打开图片位置', () => imageAction('reveal', href), { disabled: !local, title: local ? '通过本地服务在资源管理器定位' : '远程图片没有本地文件位置' });
      add(menu, '复制图片', async () => {
        const url = await resolveUrl(href);
        if (!url) throw new Error('不支持的图片地址');
        const response = await fetch(url); if (!response.ok) throw new Error('图片读取失败');
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      });
      add(menu, '重命名图片文件', async () => {
        check();
        const oldName = decodeURIComponent(href.split('/').at(-1));
        const name = prompt('图片新文件名（只更新当前引用；文件重命名不属于正文Ctrl+Z撤销）', oldName);
        if (!name || name === oldName) return;
        if (/[\\/:*?"<>|]/.test(name) || !name.trim() || name === '.' || name === '..') throw new Error('文件名不合法');
        if (imageReferenceReplacement(selected, href, href) === null) throw new Error('图片引用不能精确定位，未重命名');
        const result = await imageAction('rename', href, name);
        try {
          const replacement = imageReferenceReplacement(selected, href, result.href);
          if (replacement === null) throw new Error('图片引用已变化，未重命名');
          replace(replacement, true);
        }
        catch (error) { await result.rollback(); throw error; }
      }, { disabled: !canEdit || !local });
      const scale = submenu('缩放图片');
      for (const percentage of [25, 50, 75, 100, 150, 200]) {
        add(scale, `${percentage}%`, () => {
          const element = document.createElement('img');
          element.setAttribute('src', href); element.setAttribute('alt', image.alt);
          element.style.zoom = `${percentage}%`;
          replace(element.outerHTML.replace(/>$/, ' />'));
        }, { disabled: !canEdit });
      }
      add(menu, '复制图片地址', () => copy(href));
    } else if (link) {
      const href = link.dataset.linkHref || link.getAttribute('href');
      add(menu, '打开链接', () => open(href));
      add(menu, '复制链接地址', () => copy(href));
    }
    toolbar([
      ['剪切', 'scissors', async () => { if (!canEdit) throw new Error('预览是只读的'); await copy(selected); replace(''); }],
      ['复制', 'copy', () => copy(selected)],
      ['粘贴', 'clipboard', async () => replace(await navigator.clipboard.readText())],
      ['删除', 'trash-2', () => replace('')],
    ]);
    const formats = submenu('复制 / 粘贴为');
    add(formats, '复制为 Markdown', () => copy(selected), { disabled: preview && !image, title: preview && !image ? '精确Markdown请在编辑区选择，预览可复制文字或带格式内容' : '' });
    add(formats, '复制为 HTML', () => copy(html()));
    add(formats, '复制带格式内容', () => navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html()], { type: 'text/html' }),
      'text/plain': new Blob([selected], { type: 'text/plain' }),
    })]));
    add(formats, '粘贴为纯文本', async () => replace(await navigator.clipboard.readText()), { disabled: !canEdit });
    if (canEdit) {
      toolbar([
        ['粗体', 'bold', () => command('bold')], ['斜体', 'italic', () => command('italic')],
        ['行内代码', 'code-2', () => command('inline-code')], ['链接', 'link', () => command('link')],
        ['引用', 'quote', () => command('quote')], ['有序列表', 'list-ordered', () => command('ol')],
        ['无序列表', 'list', () => command('ul')], ['任务列表', 'check-square', () => command('task')],
      ]);
      const paragraph = submenu('段落');
      for (let n = 1; n <= 6; n++) add(paragraph, `${n} 级标题`, () => command(`h${n}`));
      add(paragraph, '正文', () => command('paragraph'));
      const insert = submenu('插入');
      for (const [label, cmd] of [['图片', 'image'], ['脚注', 'footnote'], ['水平分割线', 'hr'], ['表格', 'table'], ['代码块', 'code'], ['公式块', 'math'], ['目录', 'toc'], ['YAML Front Matter', 'yaml']]) {
        add(insert, label, () => command(cmd));
      }
      for (const [label, below] of [['段落（上方）', false], ['段落（下方）', true]]) add(insert, label, () => {
        check(); const line = view.state.doc.lineAt(from); const at = below ? line.to : line.from;
        view.dispatch({ changes: { from: at, insert: '\n' }, selection: { anchor: below ? at + 1 : at }, userEvent: 'input.context' }); view.focus();
      });
    }
    createIcons({ icons, root: menu });
    menu.hidden = false;
    menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
  });
}
