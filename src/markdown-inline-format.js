import { markdownLanguage } from '@codemirror/lang-markdown';

const formats = {
  bold: ['**', '**', 'StrongEmphasis', 'EmphasisMark'],
  italic: ['*', '*', 'Emphasis', 'EmphasisMark'],
  strike: ['~~', '~~', 'Strikethrough', 'StrikethroughMark'],
  underline: ['<u>', '</u>'],
  'inline-code': ['`', '`', 'InlineCode', 'CodeMark'],
};

// Keep Markdown canonical: edit only this format's delimiters, not rendered HTML.
export function inlineFormatTransaction(state, command) {
  const format = formats[command];
  if (!format) return null;
  const [open, close, nodeName, markName] = format;
  const selection = state.selection.main;
  const source = state.doc.toString();
  const matches = [];
  const protectedRanges = [];
  const structuralRanges = [];
  const tree = markdownLanguage.parser.parse(source);
  tree.iterate({ enter(node) {
    if (['ListMark', 'QuoteMark', 'HeaderMark', 'TaskMarker'].includes(node.name)) {
      structuralRanges.push([node.from, node.to]);
    }
  } });
  tree.iterate({ enter(node) {
    if (node.name === 'InlineCode' && command !== 'inline-code') {
      if (!(selection.from <= node.from && selection.to >= node.to)) protectedRanges.push([node.from, node.to]);
      return false;
    }
    if (['FencedCode', 'CodeBlock'].includes(node.name)) {
      protectedRanges.push([node.from, node.to]);
      return false;
    }
    if (node.name !== nodeName) return true;
    const marks = [];
    for (let child = node.node.firstChild; child; child = child.nextSibling) {
      if (child.name === markName) marks.push(child);
    }
    if (marks.length >= 2) matches.push({ from: node.from, to: node.to, start: marks[0].to, end: marks.at(-1).from });
    return false;
  } });
  if (protectedRanges.some(([from, to]) => selection.from < to && selection.to > from)) return null;
  if (command === 'underline') {
    for (const match of source.matchAll(/<u>([\s\S]*?)<\/u>/gi)) {
      if (!protectedRanges.some(([a, b]) => match.index < b && match.index + match[0].length > a)) {
        matches.push({ from: match.index, to: match.index + match[0].length, start: match.index + 3, end: match.index + 3 + match[1].length });
      }
    }
  }
  if (selection.empty) {
    const containing = matches.find(m => selection.head >= m.start && selection.head <= m.end);
    if (containing) return {
      changes: [{ from: containing.from, to: containing.start, insert: '' }, { from: containing.end, to: containing.to, insert: '' }],
      selection: { anchor: selection.head - (containing.start - containing.from) }, userEvent: 'input.format',
    };
    return { changes: { from: selection.from, insert: `${open}文本${close}` },
      selection: { anchor: selection.from + open.length, head: selection.from + open.length + 2 }, userEvent: 'input.format' };
  }
  const affected = matches.filter(m => selection.from < m.end && selection.to > m.start);
  const from = Math.min(selection.from, ...affected.map(m => m.from));
  const to = Math.max(selection.to, ...affected.map(m => m.to));
  const removed = affected.flatMap(m => [[m.from, m.start], [m.end, m.to]]).sort((a, b) => a[0] - b[0]);
  const map = pos => pos - from - removed.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(pos, b) - a), 0);
  let plain = '', cursor = from;
  for (const [a, b] of removed) { plain += source.slice(cursor, a); cursor = b; }
  plain += source.slice(cursor, to);
  const start = map(selection.from), end = map(selection.to);
  const structural = structuralRanges.filter(([a, b]) => a < to && b > from)
    .map(([a, b]) => [map(Math.max(a, from)), map(Math.min(b, to))]);
  // Selection may include block markers and blank lines; neither is inline text.
  const textSpans = (a, b) => {
    let ranges = [[a, b]];
    for (const [left, right] of structural) {
      ranges = ranges.flatMap(([x, y]) => right <= x || left >= y ? [[x, y]]
        : [[x, Math.max(x, left)], [Math.min(y, right), y]]).filter(([x, y]) => x < y);
    }
    return ranges.flatMap(([x, y]) => {
      const result = [];
      for (let pos = x; pos < y;) {
        const newline = plain.indexOf('\n', pos);
        const stop = newline >= 0 ? Math.min(newline, y) : y;
        let left = pos, right = stop;
        while (left < right && /\s/.test(plain[left])) left++;
        while (right > left && /\s/.test(plain[right - 1])) right--;
        if (left < right) result.push([left, right]);
        pos = stop + 1;
      }
      return result;
    });
  };
  const selectedText = textSpans(start, end);
  if (!selectedText.length) return null;
  let spans = affected.map(m => [map(m.start), map(m.end)]).sort((a, b) => a[0] - b[0]);
  const covered = selectedText.every(([left, right]) => {
    let coveredTo = left;
    for (const [a, b] of spans) if (a <= coveredTo) coveredTo = Math.max(coveredTo, b);
    return coveredTo >= right;
  });
  if (covered) {
    spans = spans.flatMap(([a, b]) => [[a, Math.min(b, start)], [Math.max(a, end), b]]).filter(([a, b]) => a < b);
  } else {
    spans.push([start, end]);
  }
  const merged = [];
  for (const span of spans.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  const validSpans = merged.flatMap(([a, b]) => textSpans(a, b));
  let insert = '', anchor = 0, head = 0;
  for (let i = 0; i <= plain.length; i++) {
    if (i === end) head = from + insert.length;
    if (validSpans.some(([, b]) => b === i)) insert += close;
    if (validSpans.some(([a]) => a === i)) insert += open;
    if (i === start) anchor = from + insert.length;
    if (i < plain.length) insert += plain[i];
  }
  return { changes: { from, to, insert }, selection: { anchor, head }, userEvent: 'input.format' };
}
