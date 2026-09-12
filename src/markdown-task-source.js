import { scanMarkdownBlocks } from './markdown-model.js';

// Carry parser-owned source positions through rendering-only math/blank-line
// transforms. These temporary anchors are removed before HTML is returned.
export function taskSourceAnchors(source, createParser) {
  const lines = [];
  const offsets = [];
  for (const match of source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
    if (!match[0]) break;
    lines.push(match[1]);
    offsets.push(match.index);
  }
  const excluded = scanMarkdownBlocks(source).filter(block => block.type === 'math' || block.type === 'code');
  const anchors = new Map();
  const nonce = crypto.randomUUID();
  const parser = createParser();
  parser.core.ruler.before('github-task-lists', 'task-source-positions', state => {
    for (let index = 2; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type !== 'inline' || !token.map || !/^\[[ xX]\] /.test(token.content)
        || state.tokens[index - 1].type !== 'paragraph_open'
        || state.tokens[index - 2].type !== 'list_item_open') continue;
      const row = token.map[0];
      const column = lines[row]?.indexOf(token.content.split('\n')[0]) ?? -1;
      if (column < 0) continue;
      const offset = offsets[row] + column + 1;
      if (excluded.some(block => offset >= block.startOffset && offset < block.endOffset)) continue;
      anchors.set(`<!--${nonce}:${offset}-->`, offset);
    }
  });
  parser.parse(source, {});
  let marked = source;
  for (const [anchor, offset] of [...anchors].sort((a, b) => b[1] - a[1])) {
    marked = marked.slice(0, offset + 3) + anchor + marked.slice(offset + 3);
  }
  return {
    source: marked,
    bind(renderer) {
      renderer.core.ruler.after('github-task-lists', 'bind-task-source', state => {
        for (const token of state.tokens) {
          if (token.type !== 'inline' || !token.children) continue;
          const anchor = token.children.find(child => child.type === 'html_inline' && anchors.has(child.content));
          if (!anchor) continue;
          const checkbox = token.children.find(child => child.type === 'html_inline' && child.content.startsWith('<input class="task-list-item-checkbox"'));
          if (!checkbox) continue;
          checkbox.content = checkbox.content.replace('<input ', `<input data-task-source-offset="${anchors.get(anchor.content)}" `);
          token.children = token.children.filter(child => child !== anchor);
        }
      });
    },
  };
}
