import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { measureLoadedPreview } from './markdown-search-scroll.js';
import { markdownSelectionLayer } from './markdown-selection-layer.js';
import { mediaScrollbarAnchor } from './markdown-media-scroll.js';
import { rawBlockStructuralPrefix, parseMarkdownTable, scanMarkdownBlocks, tableCellRange } from './markdown-model.js';

const activatePreview = StateEffect.define();
const activatedMouseStarts = new WeakMap();

class StructureMarker extends WidgetType {
  constructor({ label, kind, checked = false, markerOffset = -1 }) {
    super();
    this.label = label;
    this.kind = kind;
    this.checked = checked;
    this.markerOffset = markerOffset;
  }

  eq(other) {
    return this.label === other.label && this.kind === other.kind
      && this.checked === other.checked && this.markerOffset === other.markerOffset;
  }

  toDOM(view) {
    const marker = document.createElement('span');
    marker.className = `live-structure-marker live-structure-${this.kind}`;
    marker.setAttribute('aria-hidden', 'true');
    if (this.kind !== 'task') {
      marker.textContent = this.label;
      return marker;
    }
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.checked;
    checkbox.tabIndex = -1;
    checkbox.setAttribute('aria-label', this.checked ? '已完成任务' : '未完成任务');
    checkbox.addEventListener('mousedown', event => event.preventDefault());
    checkbox.addEventListener('click', event => {
      event.preventDefault();
      if (this.markerOffset < 0) return;
      view.dispatch({
        changes: { from: this.markerOffset, to: this.markerOffset + 1, insert: this.checked ? ' ' : 'x' },
        userEvent: 'input.task',
      });
      view.focus();
    });
    marker.append(checkbox);
    return marker;
  }

  ignoreEvent() { return false; }
}

class EmptyTableCellWidget extends WidgetType {
  constructor(rowIndex, columnIndex, header = false, style = '', selected = false) {
    super();
    this.rowIndex = rowIndex;
    this.columnIndex = columnIndex;
    this.header = header;
    this.style = style;
    this.selected = selected;
  }

  eq(other) {
    return this.rowIndex === other.rowIndex && this.columnIndex === other.columnIndex && this.header === other.header && this.style === other.style && this.selected === other.selected;
  }

  toDOM() {
    const cell = document.createElement('span');
    cell.className = `live-table-cell live-table-cell-empty${this.header ? ' live-table-cell-header' : ''}${this.selected ? ' live-table-cell-selected' : ''}`;
    cell.dataset.tableRow = String(this.rowIndex);
    cell.dataset.tableColumn = String(this.columnIndex);
    cell.style.cssText = this.style;
    cell.textContent = '\u00a0';
    return cell;
  }

  ignoreEvent() { return false; }
}

function structuredLine(line) {
  const quote = line.text.match(/^(?:[ \t]*>[ \t]?)+/)?.[0] || '';
  const rest = line.text.slice(quote.length);
  const list = rest.match(/^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?/);
  if (!quote && !list) return null;
  const quoteDepth = (quote.match(/>/g) || []).length;
  if (!list) return { prefixLength: quote.length, kind: 'quote', label: '', depth: quoteDepth, quoteDepth };
  const task = list[3] !== undefined;
  const marker = list[2];
  const markerStart = line.from + quote.length + list[1].length;
  const taskMarkOffset = task
    ? line.from + quote.length + list[0].indexOf('[') + 1
    : -1;
  return {
    prefixLength: quote.length + list[0].length,
    kind: task ? 'task' : /^\d/.test(marker) ? 'ordered' : 'bullet',
    label: task ? '' : /^\d/.test(marker) ? marker.replace(/[.)]$/, '.') : '•',
    checked: task && list[3].toLowerCase() === 'x',
    markerOffset: taskMarkOffset,
    quoteDepth,
    depth: quoteDepth + Math.floor(list[1].replace(/\t/g, '    ').length / 2),
    markerStart,
  };
}

function addInlineFormatting(state, from, to, output, context = {}) {
  const decorations = [];
  const hide = (start, end) => decorations.push(Decoration.replace({ hiddenSyntax: true }).range(start, end));
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const name = node.name;
      if (name === 'Image') return false;
      if (name === 'Escape') {
        hide(node.from, node.from + 1);
        return false;
      }
      if (name === 'HorizontalRule') {
        hide(node.from, node.to);
        decorations.push(Decoration.line({ attributes: { class: 'live-horizontal-rule' } }).range(state.doc.lineAt(node.from).from));
        return false;
      }
      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'Strikethrough') {
        const marks = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'EmphasisMark') marks.push({ from: child.from, to: child.to });
        }
        for (const mark of marks) hide(mark.from, mark.to);
        if (marks.length >= 2 && marks[0].to < marks.at(-1).from) {
          const cls = name === 'StrongEmphasis' ? 'live-inline-strong'
            : name === 'Strikethrough' ? 'live-inline-strike' : 'live-inline-emphasis';
          decorations.push(Decoration.mark({ class: cls, tagName: name === 'StrongEmphasis' ? 'strong' : name === 'Emphasis' ? 'em' : 's' }).range(marks[0].to, marks.at(-1).from));
        }
        return true;
      }
      if (name === 'InlineCode') {
        const marks = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'CodeMark') marks.push({ from: child.from, to: child.to });
        }
        for (const mark of marks) hide(mark.from, mark.to);
        if (marks.length >= 2 && marks[0].to < marks.at(-1).from) {
          decorations.push(Decoration.mark({ class: 'live-inline-code' }).range(marks[0].to, marks.at(-1).from));
        }
        return false;
      }
      if (name === 'Link') {
        const url = node.node.getChild('URL');
        const marks = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'LinkMark') marks.push({ from: child.from, to: child.to });
        }
        if (marks.length >= 2 && marks[0].to < marks[1].from) {
          const reference = node.node.getChild('LinkLabel');
          const label = (reference ? state.sliceDoc(reference.from + 1, reference.to - 1) : '')
            || state.sliceDoc(marks[0].to, marks[1].from);
          const href = url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '')
            : context.references?.[label.trim().replace(/\s+/g, ' ').toUpperCase()]?.href;
          hide(marks[0].from, marks[0].to);
          decorations.push(Decoration.mark({ class: 'live-inline-link', attributes: href ? {
            'data-link-href': href,
          } : {} }).range(marks[0].to, marks[1].from));
          hide(marks[1].from, node.to);
          return true;
        }
      }
      return true;
    },
  });
  const source = state.sliceDoc(from, to);
  for (const match of source.matchAll(/<u>([^\n]+?)<\/u>/gi)) {
    const start = from + match.index;
    const contentStart = start + 3;
    const contentEnd = contentStart + match[1].length;
    hide(start, contentStart);
    decorations.push(Decoration.mark({ class: 'live-inline-underline' }).range(contentStart, contentEnd));
    hide(contentEnd, contentEnd + 4);
  }
  for (const match of source.matchAll(/~~([^\n]+?)~~/g)) {
    const start = from + match.index;
    const contentStart = start + 2;
    const contentEnd = contentStart + match[1].length;
    hide(start, contentStart);
    decorations.push(Decoration.mark({ class: 'live-inline-strike' }).range(contentStart, contentEnd));
    hide(contentEnd, contentEnd + 2);
  }
  for (const range of decorations) {
    if (range.from === range.to && range.from >= from && range.from <= to) {
      output.push(range);
      continue;
    }
    const start = Math.max(from, range.from);
    const end = Math.min(to, range.to);
    if (start < end) output.push(range.value.range(start, end));
  }
}

function addInlineMedia(state, block, decorations, render, context, onRender, active = false, imageSizes) {
  const protectedRanges = [];
  syntaxTree(state).iterate({
    from: block.startOffset,
    to: state.doc.line(block.endLine).to,
    enter(node) {
      if (node.name === 'InlineCode') {
        protectedRanges.push([node.from, node.to]);
        return false;
      }
      const htmlImage = ['HTMLTag', 'HTMLBlock'].includes(node.name)
        && /^<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>\s*$/i.test(state.sliceDoc(node.from, node.to));
      if (node.name !== 'Image' && !htmlImage) return true;
      protectedRanges.push([node.from, node.to]);
      const source = state.sliceDoc(node.from, node.to);
      const media = { ...block, type: 'image', startOffset: node.from, endOffset: node.to, sourceText: source };
      const html = render(source, { ...context, __paperSourceOffset: node.from });
      const firstLine = state.doc.lineAt(node.from), lastLine = state.doc.lineAt(node.to);
      const standalone = firstLine.from === node.from && lastLine.to === node.to;
      const showAddress = active && state.selection.main.empty
        && state.doc.lineAt(state.selection.main.head).number === state.doc.lineAt(node.from).number;
      // Standalone images need their own height-map block. Inline replacement
      // makes surrounding text share the image's virtualized line geometry.
      const widget = new RenderedBlock(media, html, onRender, null, { inline: !standalone, imageSizes });
      if (showAddress) {
        decorations.push(Decoration.mark({ class: 'live-image-address' }).range(node.from, node.to));
        const url = node.node.getChild('URL');
        if (url) decorations.push(Decoration.mark({ class: 'live-inline-link', attributes: {
          'data-link-href': state.sliceDoc(url.from, url.to).replace(/^<|>$/g, ''),
        } }).range(url.from, url.to));
        if (htmlImage) {
          const attr = source.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
          if (attr) {
            const template = document.createElement('template'); template.innerHTML = source;
            const href = template.content.querySelector('img')?.getAttribute('src');
            const at = node.from + attr.index + attr[0].indexOf(attr[1]) + 1;
            if (href && attr[2].length) decorations.push(Decoration.mark({ class: 'live-inline-link', attributes: { 'data-link-href': href } }).range(at, at + attr[2].length));
          }
        }
        decorations.push(Decoration.widget({ widget, side: 1, block: standalone }).range(node.to));
      } else {
        decorations.push(Decoration.replace({ widget, block: standalone }).range(node.from, node.to));
      }
      return false;
    },
  });
  const source = state.sliceDoc(block.startOffset, state.doc.line(block.endLine).to);
  for (const match of source.matchAll(/(?<![\\$])\$(?!\$)([^$\n]+)\$(?!\$)/g)) {
    const from = block.startOffset + match.index;
    const to = from + match[0].length;
    if (protectedRanges.some(([start, end]) => from < end && to > start)) continue;
    const media = { ...block, type: 'inline-math', startOffset: from, endOffset: to, sourceText: match[0] };
    decorations.push(Decoration.replace({ widget: new RenderedBlock(media,
      render(match[0], { ...context, __paperSourceOffset: from }), onRender, null, { inline: true }) }).range(from, to));
  }
}

function addStructuredLineDecorations(state, block, decorations, activeLine = null, context = {}) {
  const tree = syntaxTree(state);
  for (let number = block.startLine; number <= block.endLine; number += 1) {
    const line = state.doc.line(number);
    let structure = structuredLine(line);
    let continuation = false;
    if (line.text.trim() && (!structure || structure.kind === 'quote')) {
      let item = null, quoteDepth = 0;
      for (let node = tree.resolveInner(line.to, -1); node; node = node.parent) {
        if (!item && node.name === 'ListItem') item = node;
        if (node.name === 'Blockquote') quoteDepth++;
      }
      const parentLine = item && state.doc.lineAt(item.from);
      if (parentLine && parentLine.number < number) {
        const parentStructure = structuredLine(parentLine);
        if (parentStructure) {
          const quotePrefix = structure?.prefixLength || 0;
          structure = { ...parentStructure, prefixLength: quotePrefix + line.text.slice(quotePrefix).match(/^[ \t]*/)[0].length };
          continuation = true;
        }
      } else if (!structure && quoteDepth) {
        structure = { kind: 'quote', depth: quoteDepth, quoteDepth, prefixLength: line.text.match(/^[ \t]*/)[0].length };
        continuation = true;
      }
    }
    if (!structure) {
      addInlineFormatting(state, line.from, line.to, decorations, context);
      continue;
    }
    decorations.push(Decoration.line({
      attributes: {
        class: `live-structured-line live-${structure.kind}-line${continuation ? ' live-structured-continuation' : ''}${structure.quoteDepth ? ' live-in-quote' : ''}${activeLine === number ? ' live-structured-active' : ''}`,
        style: `--live-structure-depth:${structure.depth}`,
      },
    }).range(line.from));
    if (structure.prefixLength) {
      decorations.push(Decoration.replace({
        ...(continuation ? {} : { widget: new StructureMarker(structure) }),
      }).range(line.from, line.from + structure.prefixLength));
    }
    addInlineFormatting(state, line.from + structure.prefixLength, line.to, decorations, context);
  }
}

function addTableLineDecorations(state, block, decorations, layout, context = {}) {
  const table = parseMarkdownTable(state.doc.toString(), block);
  if (!table) return;
  let visualIndex = 0;
  for (const row of table.rows) {
    const line = state.doc.line(block.startLine + row.index);
    const separator = row.index === table.separatorIndex;
    const rowIndex = separator ? -1 : visualIndex++;
    decorations.push(Decoration.line({
      attributes: {
        class: `live-table-line${separator ? ' live-table-separator' : rowIndex === 0 ? ' live-table-header' : rowIndex % 2 === 0 ? ' live-table-alt' : ''}`,
        ...(rowIndex >= 0 ? { 'data-table-row': String(rowIndex) } : {}),
      },
    }).range(line.from));
    if (separator) {
      if (line.length) decorations.push(Decoration.replace({}).range(line.from, line.to));
      continue;
    }
    for (const cell of row.cells) {
      const rawStart = line.from + (cell.rawStart - row.startOffset);
      const rawEnd = line.from + (cell.rawEnd - row.startOffset);
      const contentStart = line.from + (cell.contentStart - row.startOffset);
      const contentEnd = line.from + (cell.contentEnd - row.startOffset);
      const delimiterFrom = cell.index === 0 ? line.from : line.from + (row.cells[cell.index - 1].rawEnd - row.startOffset);
      if (contentStart > delimiterFrom) decorations.push(Decoration.replace({}).range(delimiterFrom, contentStart));
      if (contentEnd < rawEnd) decorations.push(Decoration.replace({}).range(contentEnd, rawEnd));
      const selectedRanges = state.selection.ranges.filter(range => !range.empty && range.from <= contentEnd && range.to >= contentStart);
      const visible = selectedRanges.length ? tableCellVisibleRange({ state }, cell) : null;
      const fullySelected = visible && selectedRanges.some(range => range.from <= visible.start && range.to >= visible.end);
      if (contentEnd > contentStart) {
        decorations.push(Decoration.mark({
          attributes: {
            class: `live-table-cell${rowIndex === 0 ? ' live-table-cell-header' : ''}${fullySelected ? ' live-table-cell-selected' : ''}`,
            'data-table-row': String(rowIndex),
            'data-table-column': String(cell.index),
            ...(layout ? { style: `flex:0 0 ${layout.widths[cell.index]}%;text-align:${layout.aligns[cell.index]};` } : {}),
          },
        }).range(contentStart, contentEnd));
        addInlineFormatting(state, contentStart, contentEnd, decorations, context);
        for (const escapedPipe of state.sliceDoc(contentStart, contentEnd).matchAll(/\\\|/g)) {
          decorations.push(Decoration.replace({}).range(
            contentStart + escapedPipe.index,
            contentStart + escapedPipe.index + 1,
          ));
        }
      } else {
        decorations.push(Decoration.widget({
          widget: new EmptyTableCellWidget(rowIndex, cell.index, rowIndex === 0,
            layout ? `flex:0 0 ${layout.widths[cell.index]}%;text-align:${layout.aligns[cell.index]};` : '', fullySelected),
          side: 1,
        }).range(contentStart));
      }
    }
    const last = row.cells.at(-1);
    if (last) {
      const trailingFrom = line.from + (last.rawEnd - row.startOffset);
      if (trailingFrom < line.to) decorations.push(Decoration.replace({}).range(trailingFrom, line.to));
    }
  }
}

function tableTargetFromElement(element) {
  const cell = element instanceof Element ? element.closest('[data-table-row][data-table-column]') : null;
  if (!cell) return null;
  const rowIndex = Number(cell.getAttribute('data-table-row'));
  const columnIndex = Number(cell.getAttribute('data-table-column'));
  return Number.isInteger(rowIndex) && Number.isInteger(columnIndex) ? { rowIndex, columnIndex } : null;
}

function tableCellEditingOffset(view, block, target) {
  const range = tableCellRange(view.state.doc.toString(), { block, ...target });
  if (!range) return null;
  return renderedTextSourceMap(view, range.startOffset, range.endOffset).offsets[0] ?? range.startOffset;
}

function renderedTextSourceMap(view, from, to) {
  const hidden = [];
  const entities = [];
  const formats = [];
  addInlineFormatting(view.state, from, to, formats);
  for (const range of formats) if (range.value.spec.hiddenSyntax) hidden.push([range.from, range.to]);
  syntaxTree(view.state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'Image') {
        hidden.push([node.from, node.to]);
        return false;
      }
      if (['EmphasisMark', 'LinkMark', 'LinkLabel', 'CodeMark'].includes(node.name)
        || (node.name === 'URL' && node.node.parent?.name !== 'Autolink')) {
        hidden.push([node.from, node.to]);
      } else if (node.name === 'Escape') {
        hidden.push([node.from, Math.max(node.from, node.to - 1)]);
      } else if (node.name === 'Entity') {
        const decoder = document.createElement('textarea');
        decoder.innerHTML = view.state.sliceDoc(node.from, node.to);
        entities.push({ from: node.from, to: node.to, text: decoder.value });
      }
      return true;
    },
  });
  hidden.sort((left, right) => left[0] - right[0]);
  const source = view.state.sliceDoc(from, to);
  const offsets = [];
  let text = '';
  let endOffset = from;
  for (let sourceOffset = from; sourceOffset < to;) {
    const entity = entities.find(item => item.from === sourceOffset);
    if (entity) {
      text += entity.text;
      for (let index = 0; index < entity.text.length; index += 1) offsets.push(entity.from);
      sourceOffset = entity.to;
      endOffset = sourceOffset;
      continue;
    }
    const range = hidden.find(item => sourceOffset >= item[0] && sourceOffset < item[1]);
    if (range) {
      sourceOffset = range[1];
      continue;
    }
    text += source[sourceOffset - from];
    offsets.push(sourceOffset);
    sourceOffset += 1;
    endOffset = sourceOffset;
  }
  offsets.push(to);
  return { text, offsets, endOffset };
}

export function tableCellVisibleRange(view, cell) {
  const mapped = renderedTextSourceMap(view, cell.contentStart, cell.contentEnd);
  return { start: mapped.offsets[0], end: mapped.endOffset };
}

function sourceOffsetAtPoint(root, block, view, event) {
  let container = root;
  let from = block.startOffset;
  let to = block.endOffset;
  if (block.type === 'code') {
    container = root.querySelector('.paper-code-pre code');
    from = block.bodyStartOffset;
    to = block.bodyEndOffset;
  } else if (block.type === 'heading') {
    container = root.querySelector('h1,h2,h3,h4,h5,h6');
    from += block.sourceText.match(/^\s*#{1,6}[ \t]+/)?.[0].length || 0;
  } else if (block.type !== 'paragraph') return null;
  if (!container || !container.contains(event.target)) return null;
  const mapped = block.type === 'code' ? { text: '', offsets: [] } : renderedTextSourceMap(view, from, to);
  if (block.type === 'code') {
    for (let at = from; at < to;) {
      const line = view.state.doc.lineAt(at);
      const contentFrom = line.from + rawBlockStructuralPrefix(block, line.text).length;
      for (let index = contentFrom; index < Math.min(line.to + 1, to); index += 1) {
        mapped.text += view.state.sliceDoc(index, index + 1);
        mapped.offsets.push(index);
      }
      at = line.to + 1;
    }
    mapped.offsets.push(to);
  }
  const visibleText = mapped.text.replace(/\n+$/, '');
  const visibleOffsets = mapped.offsets.slice(0, visibleText.length + 1);
  // DOM is used only for hit testing. A mismatch disables the map rather than
  // guessing, so renderer-only structures can never corrupt Markdown source.
  if (container.textContent.replace(/\n+$/, '') !== visibleText) return null;
  const document = root.ownerDocument;
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  const fallback = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = caret?.offsetNode || fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (!node || !container.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return visibleOffsets[Math.min(visibleText.length, range.toString().length)] ?? to;
}

class RenderedBlock extends WidgetType {
  constructor(block, html, onRender, onTableContextMenu, { inline = false, tableLayouts, imageSizes } = {}) {
    super();
    this.block = block;
    this.html = html;
    this.onRender = onRender;
    this.onTableContextMenu = onTableContextMenu;
    this.inline = inline;
    this.tableLayouts = tableLayouts;
    this.imageSizes = imageSizes;
    this.reservedHeight = Number(html.match(/\bdata-cache-height="([\d.]+)"/)?.[1]);
  }

  get estimatedHeight() {
    return this.dragHeight ?? this.imageSizes?.get(this.html)?.height ?? (this.reservedHeight > 0 && this.reservedHeight < 1000000 ? this.reservedHeight : this.block.type === 'image' ? 180 : -1);
  }

  eq(other) {
    return this.html === other.html && this.block.sourceText === other.block.sourceText
      && this.block.startOffset === other.block.startOffset
      && this.inline === other.inline;
  }

  toDOM(view) {
    const root = document.createElement(this.inline ? 'span' : 'div');
    root.className = `markdown-live-block markdown-preview${this.inline ? ' markdown-live-inline' : ''}`;
    root.dataset.liveStart = String(this.block.startOffset);
    root.dataset.liveType = this.block.type;
    root.addEventListener('mousedown', event => {
      if (event.button === 2 && event.target.closest('img')) event.preventDefault();
    });
    root.addEventListener('load', () => measureLoadedPreview(view), true);
    root.addEventListener('error', () => measureLoadedPreview(view), true);
    if (this.block.type === 'math' && !this.block.closed) {
      const shell = document.createElement('div');
      shell.className = 'paper-math-block paper-math-unclosed';
      shell.setAttribute('data-math-block', 'unclosed');
      const source = document.createElement('code');
      source.className = 'paper-math-unclosed-source';
      const bodyFrom = Math.max(0, this.block.bodyStartOffset - this.block.startOffset);
      const bodyTo = Math.max(bodyFrom, this.block.bodyEndOffset - this.block.startOffset);
      source.textContent = this.block.sourceText.slice(bodyFrom, bodyTo).replace(/[\r\n]+$/, '')
        .split(/\r\n?|\n/).map(line => line.slice(rawBlockStructuralPrefix(this.block, line).length)).join('\n');
      shell.append(source);
      root.append(shell);
    } else {
      root.innerHTML = this.html.trim();
      if (this.inline) {
        const paragraph = root.querySelector(':scope > p');
        if (paragraph) root.replaceChildren(...paragraph.childNodes);
      }
      root.querySelectorAll('img[data-source-start][data-source-end]').forEach(image => {
        const start = Number(image.dataset.sourceStart);
        const end = Number(image.dataset.sourceEnd);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return;
        const renderStartOffset = this.block.renderStartOffset ?? this.block.startOffset;
        image.dataset.sourceStart = String(renderStartOffset + start);
        image.dataset.sourceEnd = String(renderStartOffset + end);
      });
      const image = this.block.type === 'image' && root.querySelector('img');
      if (image && this.imageSizes) {
        const size = this.imageSizes.get(this.html);
        // Virtualized images must retain their intrinsic ratio before re-decoding.
        if (size && !image.hasAttribute('width') && !image.hasAttribute('height') && !image.style.height) {
          image.width = size.width;
          image.height = size.naturalHeight;
          image.style.height = 'auto';
        }
        if (!size && !this.reservedHeight && !image.hasAttribute('height') && !image.style.height) image.dataset.mediaPending = 'true';
        image.addEventListener('load', () => { delete image.dataset.mediaPending; });
        image.addEventListener('error', () => { delete image.dataset.mediaPending; });
        const rememberSize = () => queueMicrotask(() => {
          if (root.dataset.mediaFrozen || !root.isConnected) return;
          if (image.naturalWidth && image.naturalHeight) this.imageSizes.set(this.html, {
            width: image.naturalWidth, naturalHeight: image.naturalHeight,
            height: Math.max(root.getBoundingClientRect().height, image.getBoundingClientRect().height),
          });
        });
        image.addEventListener('load', rememberSize);
        root.addEventListener('media-layout-released', rememberSize);
      }
    }
    if (this.block.type === 'table') {
      const table = root.querySelector('table');
      const cached = this.tableLayouts?.get(this.block.startOffset);
      if (table && cached) {
        const cols = document.createElement('colgroup');
        for (const width of cached.widths) {
          const col = document.createElement('col');
          col.style.width = `${width}%`;
          cols.append(col);
        }
        table.prepend(cols);
        table.style.tableLayout = 'fixed';
      }
      const measureTable = () => {
        if (!table?.isConnected || !table.rows.length) return;
        const cells = [...table.rows[0].cells];
        const total = cells.reduce((sum, cell) => sum + cell.getBoundingClientRect().width, 0);
        if (!total) return;
        this.tableLayouts?.set(this.block.startOffset, {
          widths: cells.map(cell => cell.getBoundingClientRect().width / total * 100),
          aligns: cells.map(cell => getComputedStyle(cell).textAlign),
        });
      };
      root.addEventListener('mousedown', measureTable, { capture: true });
      requestAnimationFrame(measureTable);
      const sourceTable = parseMarkdownTable(view.state.doc.toString(), this.block);
      const rows = sourceTable?.visualRows || [];
      [...(table?.querySelectorAll('tr') || [])].forEach((row, rowIndex) => {
        const sourceRow = rows[rowIndex];
        if (!sourceRow) return;
        row.dataset.tableRow = String(rowIndex);
        [...row.children].forEach((cell, columnIndex) => {
          const sourceCell = sourceRow.cells[columnIndex];
          if (!sourceCell) return;
          cell.dataset.tableRow = String(rowIndex);
          cell.dataset.tableColumn = String(columnIndex);
          cell.dataset.tableSourceStart = String(sourceCell.contentStart);
          cell.dataset.tableSourceEnd = String(sourceCell.contentEnd);
        });
      });
      root.addEventListener('contextmenu', event => {
        const target = tableTargetFromElement(event.target);
        if (!target) return;
        event.preventDefault();
        this.onTableContextMenu?.(view, this.block, target, event);
      });
    }
    const restoreCheckboxFocus = ordinal => queueMicrotask(() => {
      view.dom.querySelector(`[data-live-start="${this.block.startOffset}"]`)
        ?.querySelectorAll('input[type="checkbox"]')[ordinal]?.focus({ preventScroll: true });
    });
    root.addEventListener('change', event => {
      if (!event.target.matches('input[type="checkbox"]')) return;
      const ordinal = [...root.querySelectorAll('input[type="checkbox"]')].indexOf(event.target);
      const relative = event.target.getAttribute('data-task-source-offset');
      if (relative === null) return;
      const from = this.block.startOffset + Number(relative);
      if (!Number.isInteger(from) || !/^\[[ xX]\]$/.test(view.state.sliceDoc(from - 1, from + 2))) return;
      view.dispatch({ changes: { from, to: from + 1, insert: event.target.checked ? 'x' : ' ' }, userEvent: 'input.task' });
      restoreCheckboxFocus(ordinal);
    });
    root.addEventListener('keydown', event => {
      if (!event.target.matches('input[type="checkbox"]') || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const ordinal = [...root.querySelectorAll('input[type="checkbox"]')].indexOf(event.target);
      event.preventDefault();
      event.stopPropagation();
      (key === 'y' || event.shiftKey ? redo : undo)(view);
      restoreCheckboxFocus(ordinal);
    });
    const rawEditable = this.block.type === 'code' || this.block.type === 'math';
    root.addEventListener(rawEditable ? 'pointerdown' : 'mousedown', event => {
      if (event.button !== 0 || event.target.closest('button, input')) return;
      if (event.target.closest('a') && (event.ctrlKey || event.metaKey)) return;
      if (!rawEditable) event.preventDefault();
      const block = this.block;
      const image = event.target.closest('img[data-source-start][data-source-end]');
      if (image) {
        const sourceOffset = Number(image.dataset.sourceStart);
        if (Number.isInteger(sourceOffset)) {
          view.dispatch({ selection: { anchor: sourceOffset }, effects: activatePreview.of(true) });
          view.focus();
        }
        return;
      }
      let offset = block.startOffset;
      if (block.type === 'table') {
        const target = tableTargetFromElement(event.target);
        const cellOffset = target && tableCellEditingOffset(view, block, target);
        if (cellOffset !== null && cellOffset !== undefined) offset = cellOffset;
      }
      if (block.type === 'code' || block.type === 'math') {
        offset = block.bodyStartOffset;
        const code = root.querySelector('.paper-code-pre');
        if (code && code.contains(event.target)) {
          const lineHeight = parseFloat(getComputedStyle(code).lineHeight) || 24;
          const lineIndex = Math.max(0, Math.floor((event.clientY - code.getBoundingClientRect().top) / lineHeight));
          const first = view.state.doc.lineAt(block.bodyStartOffset).number;
          const last = view.state.doc.lineAt(block.bodyEndOffset).number;
          offset = view.state.doc.line(Math.min(last, first + lineIndex)).from;
        }
        if (block.endLine - block.startLine > 1) {
          offset += rawBlockStructuralPrefix(block, view.state.doc.lineAt(offset).text).length;
        }
        if (event.target.closest('.paper-code-language')) offset = view.state.doc.lineAt(block.startOffset).to;
      }
      if (block.type !== 'structured' && block.type !== 'table') offset = sourceOffsetAtPoint(root, block, view, event) ?? offset;
      view.dispatch({ selection: { anchor: offset }, effects: activatePreview.of(true) });
      view.focus();
      if (rawEditable) {
        // Preserve the source hit before activation changes the block geometry.
        activatedMouseStarts.set(view, offset);
        const owner = view.dom.ownerDocument;
        const cleanup = () => {
          owner.removeEventListener('mousedown', startSelection, true);
          owner.removeEventListener('pointerup', cleanup, true);
          owner.removeEventListener('pointercancel', cleanup, true);
          activatedMouseStarts.delete(view);
        };
        const startSelection = down => {
          owner.removeEventListener('mousedown', startSelection, true);
          if (down.button !== 0) return;
          if (view.contentDOM.contains(down.target)) return;
          down.preventDefault();
          down.stopImmediatePropagation();
          view.contentDOM.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, button: 0, buttons: 1,
            clientX: down.clientX, clientY: down.clientY,
            shiftKey: down.shiftKey, ctrlKey: down.ctrlKey, metaKey: down.metaKey,
          }));
        };
        owner.addEventListener('mousedown', startSelection, true);
        owner.addEventListener('pointerup', cleanup, true);
        owner.addEventListener('pointercancel', cleanup, true);
      }
    });
    queueMicrotask(() => {
      if (root.isConnected) void this.onRender?.(root);
    });
    if (this.block.type === 'image') view.plugin(mediaScrollbarAnchor)?.freeze(root, this);
    return root;
  }

  ignoreEvent() { return true; }
}

export function liveMarkdownPreview({ render, prepareRender, onRender, onTableContextMenu }) {
  const imageSizes = new Map();
  let previousSource;
  let previousDoc;
  let blocks = [];
  let context;
  let referenceKey;
  const renderCache = new Map();
  const tableLayouts = new Map();
  const renderCached = (source, env) => {
    const key = source;
    if (!renderCache.has(key)) renderCache.set(key, render(source, env));
    if (renderCache.size > 512) renderCache.delete(renderCache.keys().next().value);
    return renderCache.get(key);
  };
  const build = (state, active) => {
    if (state.doc !== previousDoc) {
      previousDoc = state.doc;
      previousSource = state.doc.toString();
      blocks = scanMarkdownBlocks(previousSource);
      context = prepareRender?.(previousSource) || {};
      const nextReferenceKey = JSON.stringify(context.references || {});
      if (referenceKey !== nextReferenceKey) renderCache.clear();
      referenceKey = nextReferenceKey;
    }
    const source = previousSource;
    const decorations = [];
    for (const block of blocks) {
      // Physical empty lines always belong to CodeMirror, never to a widget.
      if (block.type === 'blank') continue;
      const from = block.startOffset;
      const contentTo = state.doc.line(block.endLine).to;
      /* Replace source characters only. Physical line endings stay in the
         CodeMirror document so every blank line keeps its own caret target. */
      const to = contentTo;
      if (to <= from) continue;
      const renderContext = { ...context, __paperSourceOffset: from };
      if (block.type === 'table') {
        const table = parseMarkdownTable(source, block);
        const layout = tableLayouts.get(from);
        if (layout && table) {
          tableLayouts.set(`${from}:${layout.widths.length}`, layout);
          const previous = tableLayouts.get(`${from}:${table.columnCount}`);
          tableLayouts.set(from, { ...layout, ...previous,
            widths: previous?.widths || Array(table.columnCount).fill(100 / table.columnCount),
            aligns: Array.from({ length: table.columnCount }, (_, index) => {
              const marker = table.rows[table.separatorIndex]?.cells[index]?.text || '';
              return marker.endsWith(':') ? marker.startsWith(':') ? 'center' : 'right' : 'left';
            }),
          });
        }
      }
      const editing = active && state.selection.ranges.some(range =>
        range.empty ? range.head >= from && range.head <= contentTo : range.from <= contentTo && range.to >= from);
      const paragraphLines = block.type === 'paragraph' || block.type === 'structured'
        ? Array.from({ length: block.endLine - block.startLine + 1 }, (_, index) => state.doc.line(block.startLine + index))
        : [];
      const hasStructuredLine = block.type === 'structured' || paragraphLines.some(line => {
        if (structuredLine(line)) return true;
        if (!line.text.trim()) return false;
        for (let node = syntaxTree(state).resolveInner(line.to, -1); node; node = node.parent) {
          if (node.name === 'ListItem' || node.name === 'Blockquote') return true;
        }
        return false;
      });
      if (hasStructuredLine) {
        addStructuredLineDecorations(state, block, decorations, active ? state.doc.lineAt(state.selection.main.head).number : null, renderContext);
        addInlineMedia(state, block, decorations, renderCached, renderContext, onRender, active, imageSizes);
        continue;
      }
      if (block.type === 'paragraph' || block.type === 'heading') {
        for (const line of paragraphLines.length ? paragraphLines : [state.doc.line(block.startLine)]) {
          const heading = block.type === 'heading';
          const isActive = active && state.doc.lineAt(state.selection.main.head).number === line.number;
          decorations.push(Decoration.line({ attributes: {
            class: heading
              ? `live-heading-line live-heading-${block.level || 1}`
              : `live-prose-line${isActive ? ' live-prose-active' : ''}`,
          } }).range(line.from));
          if (heading) {
            const prefix = line.text.match(/^\s*#{1,6}\s+/)?.[0];
            if (prefix) decorations.push((isActive
              ? Decoration.mark({ class: 'live-heading-prefix' })
              : Decoration.replace({})).range(line.from, line.from + prefix.length));
          }
        }
        addInlineFormatting(state, from, contentTo, decorations, renderContext);
        addInlineMedia(state, block, decorations, renderCached, renderContext, onRender, active, imageSizes);
        continue;
      }
      if (editing) {
        if (block.type === 'table') {
          addTableLineDecorations(state, block, decorations, tableLayouts.get(block.startOffset), renderContext);
          continue;
        }
        if (block.type === 'code') {
          const opening = state.doc.lineAt(block.startOffset);
          const prefix = rawBlockStructuralPrefix(block, opening.text);
          const fence = opening.text.slice(prefix.length).match(/^(`{3,}|~{3,})/);
          if (fence) {
            decorations.push(Decoration.replace({}).range(opening.from, opening.from + prefix.length + fence[1].length));
            decorations.push(Decoration.line({ attributes: { class: 'live-code-header' } }).range(opening.from));
          }
          const first = state.doc.lineAt(block.bodyStartOffset).number;
          const last = state.doc.lineAt(block.bodyEndOffset).number;
          for (let number = first; number <= last; number += 1) {
            const line = state.doc.line(number);
            const indent = rawBlockStructuralPrefix(block, line.text).length;
            if (indent) decorations.push(Decoration.replace({ structuralIndent: true }).range(line.from, line.from + indent));
            decorations.push(Decoration.line({ attributes: { 'data-code-line': String(number - first + 1) } })
              .range(state.doc.line(number).from));
          }
          if (block.closed) {
            const closing = state.doc.line(block.endLine);
            const caretLine = state.doc.lineAt(state.selection.main.head).number;
            if (caretLine !== closing.number && closing.length) {
              decorations.push(Decoration.replace({}).range(closing.from, closing.to));
              decorations.push(Decoration.line({ attributes: { class: 'live-code-footer' } }).range(closing.from));
            }
          }
        } else if (block.type === 'math') {
          const opening = state.doc.lineAt(block.startOffset);
          const closing = block.closed ? state.doc.line(block.endLine) : null;
          const caretLine = state.doc.lineAt(state.selection.main.head).number;
          for (const delimiter of [opening, closing]) {
            if (!delimiter || caretLine === delimiter.number || !delimiter.length) continue;
            decorations.push(Decoration.replace({}).range(delimiter.from, delimiter.to));
            decorations.push(Decoration.line({ attributes: { class: 'live-math-delimiter' } }).range(delimiter.from));
          }
          const first = state.doc.lineAt(block.bodyStartOffset).number;
          const last = state.doc.lineAt(block.bodyEndOffset).number;
          for (let number = first; number <= last; number += 1) {
            const line = state.doc.line(number);
            const prefix = rawBlockStructuralPrefix(block, line.text);
            if (prefix) decorations.push(Decoration.replace({ structuralIndent: true }).range(line.from, line.from + prefix.length));
            decorations.push(Decoration.line({ attributes: { class: 'live-math-source' } }).range(line.from));
          }
        } else if (block.type === 'heading') {
          decorations.push(Decoration.line({ attributes: { class: `live-heading-line live-heading-${block.level || 1}` } }).range(from));
          addInlineFormatting(state, from, contentTo, decorations, renderContext);
        }
        continue;
      }
      decorations.push(Decoration.replace({
        block: true,
        widget: new RenderedBlock(block, renderCached(block.sourceText, renderContext), onRender, onTableContextMenu, { tableLayouts }),
      }).range(from, to));
    }
    return Decoration.set(decorations, true);
  };
  const field = StateField.define({
    create(state) {
      previousDoc = undefined;
      previousSource = undefined;
      tableLayouts.clear();
      imageSizes.clear();
      renderCache.clear();
      referenceKey = undefined;
      return { active: false, decorations: build(state, false) };
    },
    update(value, transaction) {
      const parsed = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
      let active = value.active;
      for (const effect of transaction.effects) if (effect.is(activatePreview)) active = effect.value;
      if (!transaction.docChanged && !parsed && active === value.active && transaction.selection) {
        const before = transaction.startState.selection;
        const after = transaction.state.selection;
        if (before.ranges.length === 1 && after.ranges.length === 1
            && before.main.empty && after.main.empty
            && transaction.startState.doc.lineAt(before.main.head).number === transaction.state.doc.lineAt(after.main.head).number) {
          return value;
        }
      }
      if (transaction.docChanged || transaction.selection || parsed || active !== value.active) {
        return { active, decorations: build(transaction.state, active) };
      }
      return value;
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
  return [field, markdownSelectionLayer, mediaScrollbarAnchor, EditorView.mouseSelectionStyle.of((view, startEvent) => {
    let start = activatedMouseStarts.get(view);
    if (start === undefined || startEvent.button !== 0) return null;
    activatedMouseStarts.delete(view);
    let initial = view.state.selection;
    return {
      update(update) {
        if (update.docChanged) {
          start = update.changes.mapPos(start);
          initial = initial.map(update.changes);
        }
      },
      get(event, extend, multiple) {
        const head = event === startEvent ? start : view.posAtCoords({ x: event.clientX, y: event.clientY }, false) ?? start;
        if (extend) return initial.replaceRange(initial.main.extend(head));
        const range = EditorSelection.range(start, head);
        return multiple ? initial.addRange(range) : EditorSelection.create([range]);
      },
    };
  }), EditorView.atomicRanges.of(view => view.state.field(field).decorations.update({
    filter: (_from, _to, decoration) => Boolean(decoration.spec.structuralIndent),
  })), EditorView.inputHandler.of((view, from, to, text) => {
    if (!text || from !== to) return false;
    const block = scanMarkdownBlocks(view.state.doc.toString()).find(item =>
      (item.type === 'code' || item.type === 'math')
      && item.closed
      && item.endLine - item.startLine === 1
      && item.bodyStartOffset === from
      && item.bodyEndOffset === from);
    if (!block) return false;
    const prefix = rawBlockStructuralPrefix(block, view.state.doc.line(block.startLine).text);
    const value = prefix + (text.endsWith('\n') ? text : `${text}\n`);
    view.dispatch({
      changes: { from, to, insert: value },
      selection: { anchor: from + prefix.length + text.length },
      userEvent: 'input',
    });
    return true;
  }), EditorView.domEventHandlers({
    contextmenu(event, view) {
      const target = tableTargetFromElement(event.target);
      if (!target) return false;
      const position = view.posAtDOM(event.target, 0);
      const block = scanMarkdownBlocks(view.state.doc.toString()).find(item =>
        item.type === 'table' && position >= item.startOffset && position <= item.endOffset);
      if (!block) return false;
      event.preventDefault();
      onTableContextMenu?.(view, block, target, event);
      return true;
    },
    focus(_event, view) {
      if (!view.state.field(field).active) view.dispatch({ effects: activatePreview.of(true) });
      return false;
    },
  })];
}
