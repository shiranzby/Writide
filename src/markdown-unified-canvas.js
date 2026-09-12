import { Compartment, EditorState, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { search } from '@codemirror/search';
import { searchNavigation } from './markdown-search-scroll.js';
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, insertNewlineContinueMarkup, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { MarkdownDocumentModel, blockSourceRange, rawBlockStructuralPrefix, parseMarkdownTable, replaceSourceRange, sourceLineEnding, tableCellRange, tableStructureTransaction } from './markdown-model.js';
import { liveMarkdownPreview, tableCellVisibleRange } from './markdown-live-preview.js';
import { inlineFormatTransaction } from './markdown-inline-format.js';

const exitEmptyNestedItem = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/* One continuous Markdown editor for the Typora surface. The preview is a
   read-only projection; it never owns text and never serializes back to it. */
export class MarkdownUnifiedCanvas {
  constructor({ root, render, prepareRender, onSourceChange, onFocusChange, onPreviewRender, onTableContextMenu }) {
    this.root = root;
    this.render = render;
    this.prepareRender = prepareRender;
    this.onSourceChange = onSourceChange;
    this.onFocusChange = onFocusChange;
    this.onPreviewRender = onPreviewRender;
    this.onTableContextMenu = onTableContextMenu;
    this.composing = false;
    this.livePreview = new Compartment();
    this.liveEnabled = false;
    this.liveExtension = liveMarkdownPreview({
      render: this.render,
      prepareRender: this.prepareRender,
      onRender: this.onPreviewRender,
      onTableContextMenu: (...args) => this.onTableContextMenu?.(this, ...args),
    });
    this.documentStates = new Map();
    this.documentId = null;
    this.preview = document.createElement('article');
    this.preview.className = 'typora-unified-preview markdown-preview';
    this.editorHost = document.createElement('div');
    this.editorHost.className = 'typora-unified-source';
    this.editorHost.hidden = false;
    this.preview.hidden = true;
    this.editorHost.setAttribute('aria-label', '仿 Typora Markdown 源码编辑器');
    this.root.replaceChildren(this.preview, this.editorHost);
    this.extensions = [
          basicSetup,
          markdown(),
          search({ top: true, scrollToMatch: range => EditorView.scrollIntoView(range, { y: 'center' }) }),
          searchNavigation,
          EditorState.phrases.of({ 'Find': '查找', 'Replace': '替换', 'next': '下一个',
            'previous': '上一个', 'all': '全选匹配', 'match case': '区分大小写',
            'regexp': '正则', 'by word': '整词', 'replace': '替换', 'replace all': '全部替换', 'close': '关闭' }),
          this.livePreview.of([]),
          Prec.highest(EditorView.domEventHandlers({
            copy: (event, view) => this.copyStructuredSelection(event, view),
          })),
          Prec.highest(keymap.of([
            { key: 'Mod-a', run: view => this.selectContext(view) },
            { key: 'Mod-Shift-z', run: view => { redo(view); return true; } },
            { key: 'Mod-y', run: view => { redo(view); return true; } },
            { key: 'Shift-Enter', run: view => this.insertHardBreak(view) },
            { key: 'Enter', run: view => this.insertParagraph(view) },
            { key: 'Backspace', run: view => this.deleteStructuralBoundary(view) },
            { key: 'Home', run: view => this.moveToRawStart(view) },
            { key: 'ArrowLeft', run: view => this.moveAcrossTableCell(view, -1) },
            { key: 'ArrowRight', run: view => this.moveAcrossTableCell(view, 1) },
            { key: 'ArrowUp', run: view => this.moveIntoStructuredBlock(view, -1) || this.moveOutOfRawBlock(view, -1) },
            { key: 'ArrowDown', run: view => this.moveIntoStructuredBlock(view, 1) || this.moveOutOfRawBlock(view, 1) },
          ])),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          history({ minDepth: 50, newGroupDelay: 250 }),
          EditorView.lineWrapping,
          EditorView.updateListener.of(update => {
            const selection = update.state.selection.main;
            this.root.dataset.sourceSelection = `${selection.from}:${selection.to}`;
            if (update.docChanged && !this.settingContent) {
              this.source = this.applyEditorChangesToSource(update);
              this.onSourceChange?.(this.source, update);
              /* Do not replace the preview subtree while an IME candidate is
                 active. The CodeMirror DOM remains the only focused editor;
                 the final composition update renders once after commit. */
              if (!this.composing && !update.view.composing) this.renderPreview();
            }
          }),
        ];
    this.editor = new EditorView({
      state: EditorState.create({ doc: '', extensions: this.extensions }),
      parent: this.editorHost,
    });
    this.source = '';
    this.sourceLineEnding = '\n';
    this.setLivePreview(true);
    this.preview.addEventListener('click', event => {
      const checkbox = event.target.closest('input[type="checkbox"][data-task-marker-offset]');
      if (checkbox) {
        event.preventDefault();
        const markerOffset = Number(checkbox.dataset.taskMarkerOffset);
        if (Number.isFinite(markerOffset)) {
          const editorOffset = this.source.slice(0, markerOffset).replace(/\r\n?/g, '\n').length;
          const checked = checkbox.checked;
          this.editor.dispatch({
            changes: { from: editorOffset, to: editorOffset + 1, insert: checked ? 'x' : ' ' },
            selection: { anchor: editorOffset + 2 },
            userEvent: 'input.task',
          });
          this.editor.focus();
        }
        return;
      }
      this.focusFromPreview(event);
    });
    this.preview.addEventListener('pointerdown', event => {
      if (event.target === this.preview && this.editorHost.hidden) {
        event.preventDefault();
        this.focus('end');
      }
    });
    /* The article does not always fill the scrollable paper surface. A click
       in the remaining canvas area must still enter the same continuous
       editor, just like clicking below the last paragraph in a document. */
    const canvasSurface = this.root.closest('#typora-view') || this.root.parentElement;
    canvasSurface?.addEventListener('pointerdown', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const rect = canvasSurface.getBoundingClientRect();
      if (event.clientX >= rect.left + canvasSurface.clientLeft + canvasSurface.clientWidth
          || event.clientY >= rect.top + canvasSurface.clientTop + canvasSurface.clientHeight) return;
      if (this.preview.contains(target) || this.editorHost.contains(target)
          || event.composedPath().includes(this.editorHost)) return;
      event.preventDefault();
      this.focus('end');
    });
    this.editor.dom.addEventListener('focus', () => {
      this.editorHost.hidden = false;
      this.preview.hidden = true;
      this.onFocusChange?.(this.editor);
    });
    this.editor.dom.addEventListener('compositionstart', () => { this.composing = true; });
    this.editor.dom.addEventListener('compositionend', () => {
      queueMicrotask(() => {
        this.composing = false;
        this.renderPreview();
      });
    });
    this.editor.dom.addEventListener('blur', event => {
      if (this.editorHost.contains(event.relatedTarget)) return;
      this.onFocusChange?.(null);
    });
  }

  mount(source = '', { focus = false, selection = null, documentId = null } = {}) {
    const nextSource = String(source ?? '');
    this.sourceLineEnding = nextSource.includes('\r\n') ? '\r\n' : nextSource.includes('\r') ? '\r' : '\n';
    const editorSource = nextSource.replace(/\r\n?/g, '\n');
    if (documentId && documentId !== this.documentId) {
      if (this.documentId) this.documentStates.set(this.documentId, this.editor.state.toJSON({ history: historyField }));
      const stored = this.documentStates.get(documentId);
      this.source = nextSource;
      this.settingContent = true;
      this.editor.setState(stored?.doc === editorSource
        ? EditorState.fromJSON(stored, { extensions: this.extensions }, { history: historyField })
        : EditorState.create({ doc: editorSource, selection: selection || { anchor: 0 }, extensions: this.extensions }));
      this.settingContent = false;
      this.documentId = documentId;
      this.applyLivePreviewConfiguration();
    } else
    if (this.editor.state.doc.toString() !== editorSource) {
      this.source = nextSource;
      this.settingContent = true;
      this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: editorSource }, selection: selection || { anchor: 0 } });
      this.settingContent = false;
    } else {
      this.source = nextSource;
      if (selection) this.editor.dispatch({ selection });
    }
    this.renderPreview();
    if (focus) this.focus('start');
  }

  sourceOffsetFromEditorOffset(offset, source = this.source) {
    const target = Math.max(0, Number(offset) || 0);
    let editorOffset = 0;
    let sourceOffset = 0;
    while (sourceOffset < source.length && editorOffset < target) {
      if (source[sourceOffset] === '\r' && source[sourceOffset + 1] === '\n') sourceOffset += 2;
      else sourceOffset += 1;
      editorOffset += 1;
    }
    return sourceOffset;
  }

  /* CodeMirror normalizes CRLF/CR to one LF. Block ranges come from the raw
     Markdown snapshot, so every raw range must cross this inverse mapping
     before it is used in an EditorState transaction. */
  editorOffsetFromSourceOffset(offset, source = this.source) {
    const target = Math.max(0, Math.min(Number(offset) || 0, source.length));
    let editorOffset = 0;
    let sourceOffset = 0;
    while (sourceOffset < target) {
      if (source[sourceOffset] === '\r' && source[sourceOffset + 1] === '\n') sourceOffset += 2;
      else sourceOffset += 1;
      editorOffset += 1;
    }
    return editorOffset;
  }

  insertedSourceText(value, sourceOffset, source) {
    const text = String(value ?? '').replace(/\r\n?/g, '\n');
    if (!text.includes('\n')) return text;
    const atCursor = source.slice(sourceOffset, sourceOffset + 2);
    const lineEnding = atCursor.startsWith('\r\n') ? '\r\n'
      : atCursor.startsWith('\n') || atCursor.startsWith('\r') ? atCursor[0]
      : this.nearestSourceLineEnding(sourceOffset, source) || this.sourceLineEnding;
    return text.replace(/\n/g, lineEnding);
  }

  nearestSourceLineEnding(offset, source = this.source) {
    const position = Math.max(0, Math.min(Number(offset) || 0, source.length));
    const before = source.slice(0, position);
    const previous = [...before.matchAll(/\r\n|\r|\n/g)].at(-1)?.[0];
    if (previous) return previous;
    const following = source.slice(position).match(/^\r\n|^\r|^\n/)?.[0];
    if (following) return following;
    return source.slice(position).match(/\r\n|\r|\n/)?.[0] || '';
  }

  applyEditorChangesToSource(update) {
    const original = this.source;
    const changes = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ fromA, toA, inserted: inserted.toString() });
    });
    let next = original;
    changes.reverse().forEach(({ fromA, toA, inserted }) => {
      const from = this.sourceOffsetFromEditorOffset(fromA, original);
      const to = this.sourceOffsetFromEditorOffset(toA, original);
      next = `${next.slice(0, from)}${this.insertedSourceText(inserted, from, original)}${next.slice(to)}`;
    });
    return next;
  }

  renderPreview() {
    if (this.liveEnabled) return;
    this.preview.innerHTML = this.render?.(this.source) || '';
    const blocks = new MarkdownDocumentModel(this.source).blocks;
    let blockIndex = 0;
    [...this.preview.children].forEach(element => {
        const isBlank = element.matches('[data-md-blank-line="true"]');
        const nextIndex = blocks.findIndex((block, index) => index >= blockIndex && (block.type === 'blank') === isBlank);
        if (nextIndex < 0) return;
        const block = blocks[nextIndex];
        blockIndex = nextIndex + 1;
        element.dataset.sourceStart = String(block.startLine);
        element.dataset.sourceEnd = String(block.endLine);
        element.dataset.sourceStartOffset = String(block.startOffset);
        element.dataset.sourceEndOffset = String(block.endOffset);
      });
    blocks.forEach(block => {
      const element = [...this.preview.children].find(item => Number(item.dataset.sourceStart) === block.startLine);
      if (!element) return;
      const blockText = this.source.slice(block.startOffset, block.endOffset);
      const lines = [];
      const linePattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
      let match;
      while ((match = linePattern.exec(blockText)) && match[0] !== '') {
        lines.push({ text: match[1], startOffset: block.startOffset + match.index });
        if (!match[2]) break;
      }
      let lineIndex = 0;
      [...element.querySelectorAll('li.task-list-item, li[data-task-item="true"]')].forEach(item => {
        while (lineIndex < lines.length && !/^\s*[-+*]\s+\[[ xX]\]/.test(lines[lineIndex].text)) lineIndex += 1;
        if (lineIndex >= lines.length) return;
        const line = lines[lineIndex++];
        const marker = line.text.search(/\[[ xX]\]/);
        if (marker < 0) return;
        item.querySelector('input[type="checkbox"]')?.setAttribute('data-task-marker-offset', String(line.startOffset + marker + 1));
      });
    });
    /* Mermaid is an asynchronous projection of the same Markdown snapshot.
       Start it only after the complete preview subtree and source ranges are
       installed; stale diagrams are discarded by the renderer when a newer
       source snapshot replaces this subtree. */
    void this.onPreviewRender?.(this.preview);
  }

  focus(position = 'start') {
    const offset = position === 'end' ? this.editor.state.doc.length : 0;
    this.editorHost.hidden = false;
    this.preview.hidden = true;
    this.editor.dispatch({ selection: { anchor: offset }, scrollIntoView: false });
    this.editor.focus();
  }

  attachEditorTo(parent) {
    if (!parent || this.editor.dom.parentElement === parent) return;
    parent.replaceChildren(this.editor.dom);
  }

  setLivePreview(enabled) {
    if (this.liveEnabled === enabled) return;
    this.liveEnabled = enabled;
    this.applyLivePreviewConfiguration();
    this.editorHost.hidden = false;
    this.preview.hidden = true;
  }

  applyLivePreviewConfiguration() {
    this.editor.dispatch({ effects: this.livePreview.reconfigure(this.liveEnabled ? this.liveExtension : []) });
  }

  focusFromPreview(event) {
    if (event.target.closest('a, button, input, textarea')) return;
    const image = event.target.closest('img[data-source-start][data-source-end]');
    if (image) {
      const sourceOffset = Number(image.dataset.sourceStart);
      if (Number.isInteger(sourceOffset)) {
        this.focusOffset(this.editorOffsetFromSourceOffset(sourceOffset));
        return;
      }
    }
    const block = event.target.closest('[data-source-start]');
    if (block) {
      const line = Math.max(1, Number(block.dataset.sourceStart) || 1);
      const model = new MarkdownDocumentModel(this.source);
      const sourceBlock = model.blocks.find(item => item.startLine === line);
      const languageLabel = event.target.closest('.paper-code-language');
      const languageOffset = languageLabel && sourceBlock?.type === 'code'
        ? sourceBlock.startOffset + (this.source.slice(sourceBlock.startOffset, sourceBlock.endOffset).match(/[^\r\n]*/) || [''])[0].length
        : null;
      const body = sourceBlock && (sourceBlock.type === 'code' || sourceBlock.type === 'math')
        ? blockSourceRange(sourceBlock, this.source)
        : null;
      const editorOffset = languageOffset !== null
        ? this.editorOffsetFromSourceOffset(languageOffset)
        : body
        ? this.editorOffsetFromSourceOffset(body.startOffset)
        : this.editor.state.doc.line(Math.min(line, this.editor.state.doc.lines)).from;
      this.focusOffset(editorOffset);
      return;
    }
    const rect = this.preview.getBoundingClientRect();
    if (event.clientY >= rect.top && event.clientY <= rect.bottom) this.focus('end');
  }

  focusLine(lineNumber) {
    const line = this.editor.state.doc.line(Math.min(Math.max(1, lineNumber), this.editor.state.doc.lines));
    this.focusOffset(line.from);
  }

  focusOffset(offset) {
    this.editorHost.hidden = false;
    this.preview.hidden = true;
    this.editor.dispatch({ selection: { anchor: Math.max(0, Math.min(this.editor.state.doc.length, Number(offset) || 0)) }, scrollIntoView: true });
    this.editor.focus();
  }

  getSelection() {
    const selection = this.editor.state.selection.main;
    return { from: selection.from, to: selection.to };
  }

  setSelection(selection) {
    if (!selection) return;
    const max = this.editor.state.doc.length;
    const from = Math.max(0, Math.min(Number(selection.from) || 0, max));
    const to = Math.max(from, Math.min(Number(selection.to) || from, max));
    this.editor.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: false });
  }

  selectContext(view) {
    const position = view.state.selection.main.head;
    const model = new MarkdownDocumentModel(view.state.doc.toString());
    const block = model.blocks.find(item => position >= item.startOffset && position <= item.endOffset);
    const range = this.liveEnabled && block?.type === 'table'
      ? { startOffset: block.startOffset, endOffset: view.state.doc.line(block.endLine).to }
      : block && (block.type === 'code' || block.type === 'math')
      ? blockSourceRange(block, model.source)
      : { startOffset: 0, endOffset: view.state.doc.length };
    if ((block?.type === 'code' || block?.type === 'math') && range.startOffset < range.endOffset) {
      range.startOffset += rawBlockStructuralPrefix(block, view.state.doc.lineAt(range.startOffset).text).length;
    }
    view.dispatch({ selection: { anchor: range.startOffset, head: range.endOffset } });
    return true;
  }

  copyStructuredSelection(event, view) {
    if (!this.liveEnabled || !event.clipboardData) return false;
    const selection = view.state.selection.main;
    if (selection.empty) return false;
    const source = view.state.doc.toString();
    const block = new MarkdownDocumentModel(source).blocks.find(block =>
      selection.from >= block.startOffset && selection.to <= block.endOffset);
    if (!block) return false;
    let text = view.state.sliceDoc(selection.from, selection.to);
    let html;
    if (block.type === 'table') {
      const table = parseMarkdownTable(source, block);
      const rows = table.rows.filter(row => row.index !== table.separatorIndex);
      const first = tableCellVisibleRange(view, rows[0].cells[0]);
      const last = tableCellVisibleRange(view, rows.at(-1).cells.at(-1));
      // A full visual table drag omits hidden pipes, but its clipboard must not.
      if (selection.from > first.start || selection.to < last.end) return false;
      text = source.slice(block.startOffset, view.state.doc.line(block.endLine).to);
      html = this.render(text);
    } else if (block.type === 'code') {
      const escape = text => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
      html = `<pre><code>${escape(text)}</code></pre>`;
    } else return false;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    event.clipboardData.setData('text/html', html);
    return true;
  }

  deleteEmptyBlock(view) {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const model = new MarkdownDocumentModel(view.state.doc.toString());
    const block = model.blocks.find(item => {
      if (item.type !== 'code' && item.type !== 'math') return false;
      const range = blockSourceRange(item, model.source);
      const start = range && this.editorOffsetFromSourceOffset(range.startOffset, model.source);
      const end = range && this.editorOffsetFromSourceOffset(range.endOffset, model.source);
      return Boolean(range && selection.head >= start && selection.head <= end);
    });
    if (!block) return false;
    // Only an actual, single empty body line supports deleting the block.
    // Opening syntax and multiple blank lines retain ordinary Backspace.
    if (!block.closed || block.endLine - block.startLine !== 2) return false;
    const body = blockSourceRange(block, model.source);
    if (!body) return false;
    const bodyStart = this.editorOffsetFromSourceOffset(body.startOffset, model.source);
    const bodyEnd = this.editorOffsetFromSourceOffset(body.endOffset, model.source);
    const emptyBody = view.state.sliceDoc(bodyStart, bodyEnd);
    const prefix = rawBlockStructuralPrefix(block, emptyBody);
    if (emptyBody !== prefix || selection.head < bodyStart || selection.head > bodyEnd) return false;
    const from = this.editorOffsetFromSourceOffset(block.startOffset, model.source);
    const to = this.editorOffsetFromSourceOffset(block.endOffset, model.source);
    view.dispatch({
      changes: { from, to, insert: '' },
      selection: { anchor: Math.min(from, view.state.doc.length - (to - from)) },
      userEvent: 'delete.block',
    });
    return true;
  }

  deleteStructuralBoundary(view) {
    if (this.deleteEmptyBlock(view)) return true;
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const line = view.state.doc.lineAt(selection.head);
    const rawBlock = new MarkdownDocumentModel(view.state.doc.toString()).blocks.find(block =>
      (block.type === 'code' || block.type === 'math') && line.number > block.startLine
      && line.number < (block.closed ? block.endLine : block.endLine + 1));
    if (rawBlock) {
      const indent = rawBlockStructuralPrefix(rawBlock, line.text).length;
      if (selection.head <= line.from + indent) {
        if (line.number === rawBlock.startLine + 1) return true;
        const previous = view.state.doc.line(line.number - 1);
        view.dispatch({ changes: { from: previous.to, to: line.from + indent, insert: '' },
          selection: { anchor: previous.to }, userEvent: 'delete.backward' });
        return true;
      }
    }
    const emptyList = line.text.match(/^((?:\s*>\s*)*\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?$/);
    const emptyQuote = line.text.match(/^(\s*(?:>\s*)+)$/);
    if (emptyList && selection.head === line.to) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: emptyList[1] },
        selection: { anchor: line.from + emptyList[1].length },
        userEvent: 'delete.structure',
      });
      return true;
    }
    if (emptyQuote && selection.head === line.to) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: { anchor: line.from },
        userEvent: 'delete.structure',
      });
      return true;
    }
    const model = new MarkdownDocumentModel(view.state.doc.toString());
    const raw = model.blocks.find(block => {
      if (block.type !== 'code' && block.type !== 'math') return false;
      const body = blockSourceRange(block, model.source);
      return body && selection.head === this.editorOffsetFromSourceOffset(body.startOffset, model.source);
    });
    // The frame/gutter is visual structure. Backspace at the first body
    // position must not join source text to the opening delimiter.
    return Boolean(raw);
  }

  moveToRawStart(view) {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const line = view.state.doc.lineAt(selection.head);
    const rawBlock = new MarkdownDocumentModel(view.state.doc.toString()).blocks.find(block =>
      (block.type === 'code' || block.type === 'math') && line.number > block.startLine
      && line.number < (block.closed ? block.endLine : block.endLine + 1));
    if (!rawBlock) return false;
    const indent = rawBlockStructuralPrefix(rawBlock, line.text).length;
    view.dispatch({ selection: { anchor: line.from + indent } });
    return true;
  }

  moveAcrossTableCell(view, direction) {
    if (!this.liveEnabled || !view.state.selection.main.empty) return false;
    const position = view.state.selection.main.head;
    const source = view.state.doc.toString();
    const block = new MarkdownDocumentModel(source).blocks.find(item => item.type === 'table'
      && position >= item.startOffset && position < item.endOffset);
    if (!block) return false;
    const cells = parseMarkdownTable(source, block)?.visualRows.flatMap(row => row.cells) || [];
    const index = cells.findIndex(cell => position >= cell.rawStart && position <= cell.rawEnd);
    if (index < 0) return false;
    const cell = cells[index];
    const visible = tableCellVisibleRange(view, cell);
    if (direction < 0 ? position > visible.start : position < visible.end) return false;
    const next = cells[index + direction];
    const nextVisible = next && tableCellVisibleRange(view, next);
    const outsideLine = direction < 0 ? block.startLine - 1 : block.endLine + 1;
    const line = outsideLine > 0 && outsideLine <= view.state.doc.lines ? view.state.doc.line(outsideLine) : null;
    const anchor = next ? (direction < 0 ? nextVisible.end : nextVisible.start)
      : line ? (direction < 0 ? line.to : line.from) : position;
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(anchor, direction)]), scrollIntoView: true, userEvent: 'select' });
    return true;
  }

  insertHardBreak(view) {
    const selection = view.state.selection.main;
    /* Raw blocks own their physical line syntax. Adding Markdown's two-space
       hard-break marker there would silently change code/formula source. */
    const model = new MarkdownDocumentModel(view.state.doc.toString());
    const rawBlock = model.blocks.find(block => {
      if (block.type !== 'code' && block.type !== 'math') return false;
      const body = blockSourceRange(block, model.source);
      const start = body && this.editorOffsetFromSourceOffset(body.startOffset, model.source);
      const end = body && this.editorOffsetFromSourceOffset(body.endOffset, model.source);
      return body && selection.from >= start && selection.to <= end;
    });
    if (rawBlock) return this.insertParagraph(view);
    const insert = '  \n';
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length }, userEvent: 'input' });
    return true;
  }

  moveIntoStructuredBlock(view, direction) {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const line = view.state.doc.lineAt(selection.head);
    if (line.text.length !== 0) return false;
    const adjacentNumber = line.number + direction;
    if (adjacentNumber < 1 || adjacentNumber > view.state.doc.lines) return false;
    const adjacent = view.state.doc.line(adjacentNumber);
    const model = new MarkdownDocumentModel(view.state.doc.toString());
    // Empty body lines belong to native navigation, not block-entry navigation.
    if (model.blocks.some(block => (block.type === 'code' || block.type === 'math')
      && line.number >= block.startLine && line.number <= block.endLine)) return false;
    const adjacentBlock = model.blocks.find(block => block.type === 'structured'
      && adjacentNumber >= block.startLine && adjacentNumber <= block.endLine);
    if (adjacentBlock) return false;
    const adjacentRawBlock = model.blocks.find(block => (block.type === 'code' || block.type === 'math')
      && adjacentNumber >= block.startLine && adjacentNumber <= block.endLine);
    if (adjacentRawBlock) {
      const body = blockSourceRange(adjacentRawBlock, model.source);
      if (!body) return false;
      const bodyStart = this.editorOffsetFromSourceOffset(body.startOffset, model.source);
      const bodyEnd = this.editorOffsetFromSourceOffset(body.endOffset, model.source);
      const target = direction < 0 ? Math.max(bodyStart, bodyEnd - 1) : bodyStart;
      const prefix = direction > 0 && bodyStart < bodyEnd
        ? rawBlockStructuralPrefix(adjacentRawBlock, view.state.doc.lineAt(target).text).length : 0;
      view.dispatch({
        selection: { anchor: direction < 0 ? view.state.doc.lineAt(target).to : target + prefix },
        scrollIntoView: true,
      });
      return true;
    }
    if (!adjacentBlock && !/^\s*(?:(?:>\s*)+|(?:[-+*]|\d+[.)])\s+)/.test(adjacent.text)) {
      const source = view.state.doc.toString();
      const tableBlock = new MarkdownDocumentModel(source).blocks.find(block => (
        block.type === 'table'
        && adjacentNumber >= block.startLine
        && adjacentNumber <= block.endLine
      ));
      const table = tableBlock && parseMarkdownTable(source, tableBlock);
      const targetRow = direction < 0 ? table?.visualRows.at(-1) : table?.visualRows[0];
      const targetCell = direction < 0 ? targetRow?.cells.at(-1) : targetRow?.cells[0];
      if (!targetCell) return false;
      view.dispatch({
        selection: { anchor: direction < 0 ? targetCell.contentEnd : targetCell.contentStart },
        scrollIntoView: true,
      });
      return true;
    }
    if (adjacentBlock) {
      const targetLine = view.state.doc.line(direction < 0 ? adjacentBlock.endLine : adjacentBlock.startLine);
      const quote = targetLine.text.match(/^\s*(?:>\s*)+/)?.[0] || '';
      const list = targetLine.text.slice(quote.length).match(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/)?.[0] || '';
      view.dispatch({
        selection: { anchor: direction < 0 ? targetLine.to : targetLine.from + quote.length + list.length },
        scrollIntoView: true,
      });
      return true;
    }
    view.dispatch({
      selection: { anchor: direction < 0 ? adjacent.to : adjacent.from },
      scrollIntoView: true,
    });
    return true;
  }

  moveOutOfRawBlock(view, direction) {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const model = new MarkdownDocumentModel(view.state.doc.toString());
    const block = model.blocks.find(item => {
      if (item.type !== 'code' && item.type !== 'math') return false;
      const body = blockSourceRange(item, model.source);
      return body && selection.head >= body.startOffset && selection.head <= body.endOffset;
    });
    if (!block) return false;
    const body = blockSourceRange(block, model.source);
    const candidate = view.moveVertically(selection, direction > 0).head;
    if (candidate >= body.startOffset && candidate <= body.endOffset) return false;
    if (direction < 0) {
      if (block.startLine <= 1) return false;
      const line = view.state.doc.line(block.startLine - 1);
      view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
      return true;
    }
    if (block.endLine < view.state.doc.lines) {
      const line = view.state.doc.line(block.endLine + 1);
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      return true;
    }
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 }, scrollIntoView: true, userEvent: 'input' });
    return true;
  }

  insertParagraph(view) {
    const selection = view.state.selection.main;
    const line = view.state.doc.lineAt(selection.head);
    const rawBlock = new MarkdownDocumentModel(view.state.doc.toString()).blocks.find(block =>
      (block.type === 'code' || block.type === 'math') && line.number > block.startLine
      && line.number < (block.closed ? block.endLine : block.endLine + 1));
    if (rawBlock) {
      const prefix = rawBlockStructuralPrefix(rawBlock, view.state.doc.line(rawBlock.startLine).text);
      const insert = `\n${prefix}`;
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert },
        selection: { anchor: selection.from + insert.length }, userEvent: 'input' });
      return true;
    }
    const inMath = new MarkdownDocumentModel(view.state.doc.toString()).blocks.some(block =>
      block.type === 'math' && selection.head >= block.startOffset && selection.head <= block.endOffset);
    if (!inMath && selection.empty && selection.head === line.to) {
      const emptyItem = line.text.match(/^((?:\s*>\s*)*\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?$/);
      const emptyQuote = /^\s*(?:>\s*)+$/.test(line.text);
      if (emptyItem?.[1] && exitEmptyNestedItem(view)) return true;
      if (emptyItem || emptyQuote) {
        const quotePrefix = emptyQuote ? line.text.slice(0, line.text.lastIndexOf('>')) : '';
        const insert = quotePrefix.includes('>') ? quotePrefix : '\n';
        view.dispatch({ changes: { from: line.from, to: line.to, insert },
          selection: { anchor: line.from + insert.length }, userEvent: 'input' });
        return true;
      }
    }
    if (!inMath && insertNewlineContinueMarkup(view)) return true;
    const paragraphBreak = this.liveEnabled ? '\n\n' : '\n';
    if (!selection.empty) {
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert: paragraphBreak }, selection: { anchor: selection.from + paragraphBreak.length }, userEvent: 'input' });
      return true;
    }
    const position = selection.head;
    const before = view.state.sliceDoc(Math.max(0, position - 3), position);
    if (before === '  \n') {
      view.dispatch({ changes: { from: position - 3, to: position, insert: '\n\n' }, selection: { anchor: position - 1 }, userEvent: 'input' });
      return true;
    }
    /* A normal Enter is a physical source edit. Never consume or replace the
       newline that already follows the caret: that would skip an editable
       blank line and move the caret into the next paragraph. */
    view.dispatch({ changes: { from: position, insert: paragraphBreak }, selection: { anchor: position + paragraphBreak.length }, userEvent: 'input' });
    return true;
  }

  replaceSelection(value) {
    const selection = this.editor.state.selection.main;
    this.editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: value }, userEvent: 'input' });
    this.editor.focus();
  }

  toggleInline(command) {
    const transaction = inlineFormatTransaction(this.editor.state, command);
    if (!transaction) return;
    this.editor.dispatch(transaction);
    this.editor.focus();
  }

  insertText(value, caretOffset = String(value).length) {
    const selection = this.editor.state.selection.main;
    const text = String(value);
    this.editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + caretOffset }, userEvent: 'input' });
    this.editor.focus();
  }

  undo() { undo(this.editor); }
  redo() { redo(this.editor); }

  applyTableCommand(action, rowIndex, columnIndex, targetBlock = null) {
    const block = new MarkdownDocumentModel(this.source).blocks.find(item => item.type === 'table'
      && (!targetBlock || item.startLine === targetBlock.startLine));
    const transaction = tableStructureTransaction(this.source, { action, rowIndex, columnIndex, block });
    if (!transaction) return false;
    const nextSource = replaceSourceRange(this.source, transaction.startOffset, transaction.endOffset, transaction.replacement);
    const nextBlock = new MarkdownDocumentModel(nextSource).blocks.find(item => item.type === 'table' && item.startLine === block?.startLine);
    const nextCell = tableCellRange(nextSource, {
      block: nextBlock,
      rowIndex: transaction.rowIndex,
      columnIndex: transaction.columnIndex,
    });
    const from = this.editorOffsetFromSourceOffset(transaction.startOffset);
    const to = this.editorOffsetFromSourceOffset(transaction.endOffset);
    const insert = transaction.replacement.replace(/\r\n?/g, '\n');
    const anchor = nextCell ? this.editorOffsetFromSourceOffset(nextCell.startOffset, nextSource) : from;
    this.editor.dispatch({
      changes: { from, to, insert },
      selection: { anchor },
      userEvent: 'input.table',
    });
    this.editor.focus();
    return true;
  }

  destroy() {
    this.editor.destroy();
    this.root.replaceChildren();
  }
}
