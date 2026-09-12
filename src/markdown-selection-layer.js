import { layer, RectangleMarker } from '@codemirror/view';

// Keep CodeMirror's text selection, but paint cells and code gutters according
// to their rendered geometry instead of treating them as plain text lines.
export const markdownSelectionLayer = layer({
  above: false,
  class: 'paper-selection-layer',
  update: update => update.selectionSet || update.docChanged || update.viewportChanged,
  markers(view) {
    const ranges = view.state.selection.ranges.filter(range => !range.empty);
    if (!ranges.length) return [];
    const scroll = view.scrollDOM.getBoundingClientRect();
    const base = { left: scroll.left - view.scrollDOM.scrollLeft * view.scaleX,
      top: scroll.top - view.scrollDOM.scrollTop * view.scaleY };
    const special = [...view.contentDOM.querySelectorAll('.cm-line[data-code-line], .live-table-line')].map(line => {
      const rect = line.getBoundingClientRect();
      const from = view.posAtDOM(line, 0), to = view.posAtDOM(line, line.childNodes.length);
      return { top: rect.top - base.top, bottom: rect.bottom - base.top,
        left: rect.left - base.left + parseFloat(getComputedStyle(line).paddingLeft) * view.scaleX,
        right: rect.right - base.left, table: line.classList.contains('live-table-line'),
        full: ranges.some(range => range.from <= from && range.to >= to) };
    }).filter(rect => rect.bottom > rect.top);
    const output = [];
    const add = (left, top, right, bottom) => {
      if (right > left && bottom > top) output.push(new RectangleMarker('cm-selectionBackground', left, top, right - left, bottom - top));
    };
    for (const range of ranges) for (const rect of RectangleMarker.forRange(view, 'cm-selectionBackground', range)) {
      const end = rect.top + rect.height;
      const boundaries = special.filter(line => line.top < end && line.bottom > rect.top);
      const cuts = [...new Set([rect.top, end, ...boundaries.flatMap(line => [Math.max(rect.top, line.top), Math.min(end, line.bottom)])])].sort((a, b) => a - b);
      for (let i = 1; i < cuts.length; i++) {
        const top = cuts[i - 1], bottom = cuts[i];
        const line = boundaries.find(line => line.top <= top && line.bottom >= bottom);
        if (line?.table || line?.full) continue;
        add(Math.max(rect.left, line?.left ?? rect.left), top,
          Math.min(rect.left + rect.width, line?.right ?? rect.left + rect.width), bottom);
      }
    }
    for (const line of special) if (!line.table && line.full) add(line.left, line.top, line.right, line.bottom);
    for (const cell of view.contentDOM.querySelectorAll('.live-table-cell')) {
      const bounds = cell.getBoundingClientRect();
      if (cell.classList.contains('live-table-cell-selected')) {
        add(bounds.left - base.left, bounds.top - base.top, bounds.right - base.left, bounds.bottom - base.top);
        continue;
      }
      const start = view.posAtDOM(cell, 0), end = view.posAtDOM(cell, cell.childNodes.length);
      for (const selected of ranges) {
        const from = Math.max(start, selected.from), to = Math.min(end, selected.to);
        if (to <= from) continue;
        const a = view.domAtPos(from), b = view.domAtPos(to);
        const domRange = cell.ownerDocument.createRange();
        domRange.setStart(a.node, a.offset);
        domRange.setEnd(b.node, b.offset);
        // Text-node rectangles avoid painting both a formatting element and
        // its child text, which would darken bold/italic selections twice.
        const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
          if (!domRange.intersectsNode(node)) continue;
          const textRange = cell.ownerDocument.createRange();
          textRange.setStart(node, node === a.node ? a.offset : 0);
          textRange.setEnd(node, node === b.node ? b.offset : node.textContent.length);
          for (const rect of textRange.getClientRects()) add(
            Math.max(bounds.left, rect.left) - base.left, Math.max(bounds.top, rect.top) - base.top,
            Math.min(bounds.right, rect.right) - base.left, Math.min(bounds.bottom, rect.bottom) - base.top);
        }
      }
    }
    return output;
  },
});
