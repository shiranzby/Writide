import { MarkdownDocumentModel, blockSourceRange, sourceLineEnding } from './markdown-model.js';

/* The canvas contract is deliberately source-first. A block is identified by
   its exact byte range in the Markdown snapshot; rendered DOM is never used to
   reconstruct that snapshot. Editors may replace only `sourceRange` or
   `bodyRange`, then create a new canvas snapshot. */
export function createCanvasBlocks(source = '') {
  const model = new MarkdownDocumentModel(source);
  return model.blocks.map((block, index) => {
    const bodyRange = block.type === 'code' || block.type === 'math'
      ? blockSourceRange(block, model.source)
      : null;
    return {
      id: `block-${index}-${block.startOffset}-${block.endOffset}`,
      index,
      type: block.type,
      startLine: block.startLine,
      endLine: block.endLine,
      sourceRange: {
        startOffset: block.startOffset,
        endOffset: block.endOffset,
      },
      bodyRange: bodyRange ? {
        startOffset: bodyRange.startOffset,
        endOffset: bodyRange.endOffset,
      } : null,
      sourceText: block.sourceText,
      language: block.language || '',
      editable: block.type !== 'blank',
    };
  });
}

export function canvasBlockAtLine(blocks, lineNumber) {
  const line = Math.max(1, Number(lineNumber) || 1);
  return blocks.find(block => line >= block.startLine && line <= block.endLine) || null;
}

export function canvasBlockAtOffset(blocks, offset) {
  const position = Math.max(0, Number(offset) || 0);
  return blocks.find(block => position >= block.sourceRange.startOffset && position <= block.sourceRange.endOffset) || null;
}

export function canvasReplacement(source, block, replacement, { body = false } = {}) {
  if (!block) return null;
  const range = body && block.bodyRange ? block.bodyRange : block.sourceRange;
  const model = new MarkdownDocumentModel(source);
  return model.replace(range.startOffset, range.endOffset, replacement).source;
}

export function normalizeCanvasText(source, value) {
  const newline = sourceLineEnding(source);
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, newline);
}

/* The canvas owns one immutable Markdown snapshot. View code may ask for a
   replacement, but it never receives permission to serialize rendered DOM
   back into Markdown. Keeping this small session object separate from the
   DOM makes the eventual local-block editors use the same source contract. */
export class MarkdownCanvasDocument {
  constructor(source = '') {
    this.source = String(source ?? '');
    this.blocks = createCanvasBlocks(this.source);
  }

  replace(startOffset, endOffset, value) {
    const nextSource = new MarkdownDocumentModel(this.source)
      .replace(startOffset, endOffset, normalizeCanvasText(this.source, value)).source;
    return new MarkdownCanvasDocument(nextSource);
  }

  replaceBlock(block, value, { body = false } = {}) {
    return new MarkdownCanvasDocument(canvasReplacement(this.source, block, normalizeCanvasText(this.source, value), { body }));
  }

  replaceBlockById(id, value, { body = false } = {}) {
    const block = this.blocks.find(item => item.id === id);
    return block ? this.replaceBlock(block, value, { body }) : null;
  }

  replaceRange(range, value) {
    if (!range) return null;
    return this.replace(range.startOffset, range.endOffset, value);
  }

  blockAtOffset(offset) {
    return canvasBlockAtOffset(this.blocks, offset);
  }

  blockAtLine(lineNumber) {
    return canvasBlockAtLine(this.blocks, lineNumber);
  }
}
