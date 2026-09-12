function quotePrefixLength(line, depth) {
  let length = 0;
  for (let index = 0; index < depth; index += 1) {
    const marker = line.slice(length).match(/^[ \t]*>[ \t]?/);
    if (!marker) return null;
    length += marker[0].length;
  }
  return length;
}

// Quote markers and delimiter indentation belong to the container, not its body.
// Consume exactly the opening quote depth: a literal `>` stays editable.
export function rawBlockStructuralPrefix(block, line) {
  const quoteLength = quotePrefixLength(line, block.quoteDepth || 0) ?? 0;
  const opening = block.sourceText.split(/\r\n?|\n/, 1)[0];
  const openingQuote = quotePrefixLength(opening, block.quoteDepth || 0) ?? 0;
  const indentation = opening.slice(openingQuote).match(/^[ \t]*/)[0].length;
  const spaces = line.slice(quoteLength).match(/^[ \t]*/)[0].length;
  return line.slice(0, quoteLength + Math.min(indentation, spaces));
}

/* Source-oriented block ranges. The source string is canonical: offsets are
   measured against the original text, including CRLF line endings. Rendered
   DOM must never be used to rebuild the Markdown source. */
export function scanMarkdownBlocks(source) {
  const text = String(source ?? '');
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n' && text[index] !== '\r') continue;
    const end = index;
    const next = text[index] === '\r' && text[index + 1] === '\n' ? index + 2 : index + 1;
    lines.push({ text: text.slice(start, end), start, end, nextStart: next });
    start = next;
    index = next - 1;
  }
  lines.push({ text: text.slice(start), start, end: text.length, nextStart: text.length });

  const blocks = [];
  const add = (type, startLine, endLine, extra = {}) => {
    const first = lines[startLine];
    const last = lines[endLine];
    blocks.push({
      type,
      startLine: startLine + 1,
      endLine: endLine + 1,
      startOffset: first?.start ?? text.length,
      endOffset: last?.nextStart ?? text.length,
      sourceText: text.slice(first?.start ?? text.length, last?.nextStart ?? text.length),
      ...extra,
    });
  };
  const isFence = line => line.match(/^((?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})([^\n]*)$/);
  const withoutQuote = line => line.replace(/^(?:[ \t]*>[ \t]?)+/, '');
  const isMathStart = line => /^\s*(?:\$\$|\\\[)\s*$/.test(withoutQuote(line));
  const mathEnvironment = /^(equation\*?|align\*?|gather\*?|displaymath|math)$/i;
  const mathEnvironmentStart = line => {
    const match = withoutQuote(line).match(/^\s*\\begin\{([^}]+)\}\s*$/i);
    return match && mathEnvironment.test(match[1]) ? match[1] : null;
  };
  const isHeading = line => line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
  const isTable = line => /^\s*\|?.+\|.+\|?\s*$/.test(line);
  const isTableStart = index => isTable(lines[index].text) && index + 1 < lines.length
    && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1].text);
  const isStructured = line => /^\s*(?:(?:>\s*)+|(?:[-+*]|\d+[.)])\s+)/.test(line);
  /* A canonical hard break is stored as two trailing spaces followed by the
     line ending. A line containing only those spaces is still part of the
     paragraph, not an independent blank block. */
  const isHardBreakOnlyLine = line => /^[ \t]{2,}$/.test(line);
  const isContentLine = line => Boolean(line.trim()) || isHardBreakOnlyLine(line);
  const isSpecial = line => isFence(line) || isMathStart(line) || mathEnvironmentStart(line)
    || isHeading(line) || isTable(line) || isStructured(line);

  const addRaw = (type, first, last, closed, extra = {}) => {
    const bodyStartOffset = lines[first].nextStart;
    // Only a verified closing delimiter owns the preceding separator.
    const bodyEndOffset = closed
      ? Math.max(bodyStartOffset, lines[last - 1].end)
      : lines[last].nextStart;
    add(type, first, last, { ...extra, closed, bodyStartOffset, bodyEndOffset });
  };

  let index = 0;
  while (index < lines.length) {
    if (!isContentLine(lines[index].text)) {
      add('blank', index, index);
      index += 1;
      continue;
    }
    const fence = isFence(lines[index].text);
    if (fence) {
      const marker = fence[2][0];
      const markerLength = fence[2].length;
      const quoteDepth = (fence[1].match(/>/g) || []).length;
      const closing = new RegExp(`^[ \\t]*${marker}{${markerLength},}[ \\t]*$`);
      let end = index;
      let closed = false;
      while (end + 1 < lines.length) {
        const next = lines[end + 1].text;
        const prefixLength = quotePrefixLength(next, quoteDepth);
        if (prefixLength === null) break;
        end += 1;
        if (closing.test(next.slice(prefixLength))) { closed = true; break; }
      }
      addRaw('code', index, end, closed, {
        language: fence[3].trim().split(/\s+/, 1)[0] || '',
        ...(quoteDepth ? { quoteDepth } : {}),
      });
      index = end + 1;
      continue;
    }
    const environment = mathEnvironmentStart(lines[index].text);
    if (isMathStart(lines[index].text) || environment) {
      const opening = withoutQuote(lines[index].text).trim();
      const prefix = lines[index].text.slice(0, lines[index].text.length - withoutQuote(lines[index].text).length);
      const quoteDepth = (prefix.match(/>/g) || []).length;
      const delimiter = environment ? `\\end{${environment}}` : opening === '\\[' ? '\\]' : '$$';
      let end = index;
      let closed = false;
      while (end + 1 < lines.length) {
        const next = lines[end + 1].text;
        const prefixLength = quotePrefixLength(next, quoteDepth);
        if (prefixLength === null) break;
        end += 1;
        if (next.slice(prefixLength).trim().toLowerCase() === delimiter.toLowerCase()) { closed = true; break; }
      }
      addRaw('math', index, end, closed, {
        ...(environment ? { environment: environment.toLowerCase() } : {}),
        ...(quoteDepth ? { quoteDepth } : {}),
      });
      index = end + 1;
      continue;
    }
    const heading = isHeading(lines[index].text);
    if (heading) {
      add('heading', index, index, { level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    if (isTableStart(index)) {
      let end = index + 1;
      while (end + 1 < lines.length && lines[end + 1].text.trim() && isTable(lines[end + 1].text)) end += 1;
      add('table', index, end);
      index = end + 1;
      continue;
    }
    if (isStructured(lines[index].text)) {
      let end = index;
      while (end + 1 < lines.length && isContentLine(lines[end + 1].text)
        && !isFence(lines[end + 1].text) && !isMathStart(lines[end + 1].text)
        && !mathEnvironmentStart(lines[end + 1].text) && !isTableStart(end + 1)
        && (isStructured(lines[end + 1].text) || /^\s{2,}\S/.test(lines[end + 1].text))) end += 1;
      add('structured', index, end);
      index = end + 1;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length && isContentLine(lines[end + 1].text) && !isSpecial(lines[end + 1].text)) end += 1;
    add('paragraph', index, end);
    index = end + 1;
  }
  return blocks;
}

export function replaceSourceRange(source, startOffset, endOffset, replacement) {
  const text = String(source ?? '');
  const start = Math.max(0, Math.min(text.length, Number(startOffset) || 0));
  const end = Math.max(start, Math.min(text.length, Number(endOffset) || 0));
  return `${text.slice(0, start)}${String(replacement ?? '')}${text.slice(end)}`;
}

export function blockSourceRange(block, source = '') {
  const text = String(source ?? '');
  if (!block || typeof block.startOffset !== 'number' || typeof block.endOffset !== 'number') return null;
  const sourceText = text.slice(block.startOffset, block.endOffset);
  if (block.type === 'code' || block.type === 'math') {
    const startOffset = block.bodyStartOffset;
    const endOffset = block.bodyEndOffset;
    return { startOffset, endOffset, sourceText: text.slice(startOffset, endOffset) };
  }
  return { startOffset: block.startOffset, endOffset: block.endOffset, sourceText };
}

export function findSourceBlocks(source, type = null) {
  const blocks = scanMarkdownBlocks(source);
  return type ? blocks.filter(block => block.type === type) : blocks;
}

export function sourceLineEnding(source) {
  const text = String(source ?? '');
  return text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
}

function escapedAt(source, offset) {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function closingBracket(source, start, open, close) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (escapedAt(source, index)) continue;
    if (source[index] === open) depth += 1;
    if (source[index] === close && --depth === 0) return index;
  }
  return -1;
}

function normalizeReferenceLabel(label) {
  return String(label ?? '')
    .replace(/\\([\\[\]()_*!#])/g, '$1')
    .trim()
    .replace(/[ \t\r\n]+/g, ' ')
    .toLowerCase();
}

/* Deliberately limited source lexer for preview nodes that need exact offsets.
   Markdown-it exposes block line maps but no inline image offsets. This keeps
   the canonical string untouched and refuses ambiguous/unfinished syntax. */
export function scanMarkdownImageRanges(source) {
  const text = String(source ?? '');
  const fencedRanges = scanMarkdownBlocks(text)
    .filter(block => block.type === 'code')
    .map(block => [block.startOffset, block.endOffset]);
  const excludedRanges = [...fencedRanges];
  for (const line of sourceLines(text)) {
    if (/^(?: {4}|\t)\S/.test(line.text)
      && !excludedRanges.some(([from, to]) => line.start < to && line.nextStart > from)) {
      excludedRanges.push([line.start, line.nextStart]);
    }
  }
  for (let commentStart = text.indexOf('<!--'); commentStart >= 0;) {
    if (excludedRanges.some(([from, to]) => commentStart >= from && commentStart < to)) {
      commentStart = text.indexOf('<!--', commentStart + 4);
      continue;
    }
    const commentEnd = text.indexOf('-->', commentStart + 4);
    excludedRanges.push([commentStart, commentEnd >= 0 ? commentEnd + 3 : text.length]);
    commentStart = commentEnd >= 0 ? text.indexOf('<!--', commentEnd + 3) : -1;
  }
  const referenceDefinitions = new Set();
  for (const line of sourceLines(text)) {
    if (excludedRanges.some(([from, to]) => line.start < to && line.nextStart > from)) continue;
    const definition = line.text.match(/^ {0,3}\[([^\]\r\n]+)\]:\s*(?:<[^>\r\n]*>|\S+)/);
    if (definition) referenceDefinitions.add(normalizeReferenceLabel(definition[1]));
  }
  const ranges = [];
  for (let index = 0; index < text.length; index += 1) {
    if (excludedRanges.some(([from, to]) => index >= from && index < to)) continue;
    if (text[index] === '`' && !escapedAt(text, index)) {
      let length = 1;
      while (text[index + length] === '`') length += 1;
      const marker = '`'.repeat(length);
      const close = text.indexOf(marker, index + length);
      if (close >= 0) index = close + length - 1;
      continue;
    }
    if (text[index] !== '!' || text[index + 1] !== '[' || escapedAt(text, index)) continue;
    const altEnd = closingBracket(text, index + 1, '[', ']');
    if (altEnd < 0) continue;
    const next = altEnd + 1;
    if (text[next] === '(') {
      const end = closingBracket(text, next, '(', ')');
      if (end >= 0 && !/[\r\n]/.test(text.slice(next, end + 1))) {
        ranges.push({ startOffset: index, endOffset: end + 1, altStartOffset: index + 2, altEndOffset: altEnd, kind: 'inline' });
        index = end;
      }
      continue;
    }
    if (text[next] === '[') {
      const end = closingBracket(text, next, '[', ']');
      if (end >= 0) {
        const key = normalizeReferenceLabel(text.slice(next + 1, end) || text.slice(index + 2, altEnd));
        if (referenceDefinitions.has(key)) {
          ranges.push({ startOffset: index, endOffset: end + 1, altStartOffset: index + 2, altEndOffset: altEnd, kind: 'reference' });
        }
        index = end;
        continue;
      }
    }
    if (referenceDefinitions.has(normalizeReferenceLabel(text.slice(index + 2, altEnd)))) {
      ranges.push({ startOffset: index, endOffset: altEnd + 1, altStartOffset: index + 2, altEndOffset: altEnd, kind: 'shortcut' });
      index = altEnd;
    }
  }
  return ranges;
}

function sourceLines(source) {
  const text = String(source ?? '');
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n' && text[index] !== '\r') continue;
    const end = index;
    const lineEnding = text[index] === '\r' && text[index + 1] === '\n' ? '\r\n' : text[index];
    const nextStart = index + lineEnding.length;
    lines.push({ text: text.slice(start, end), start, end, nextStart, lineEnding });
    start = nextStart;
    index = nextStart - 1;
  }
  lines.push({ text: text.slice(start), start, end: text.length, nextStart: text.length, lineEnding: '' });
  return lines;
}

function unescapedPipePositions(line) {
  const positions = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '|') continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) positions.push(index);
  }
  return positions;
}

function parseTableRow(line, lineStart, rowIndex) {
  const pipes = unescapedPipePositions(line);
  if (!pipes.length) return null;
  const leadingPipe = /^\s*\|/.test(line);
  const trailingPipe = /\|\s*$/.test(line);
  const first = leadingPipe ? pipes[0] + 1 : 0;
  const last = trailingPipe ? pipes.at(-1) : line.length;
  const delimiters = pipes.slice(leadingPipe ? 1 : 0, trailingPipe ? -1 : undefined);
  const starts = [first, ...delimiters.map(position => position + 1)];
  const ends = [...delimiters, last];
  const cells = [];
  for (let index = 0; index < starts.length; index += 1) {
    const rawStart = starts[index];
    const rawEnd = ends[index];
    const segment = line.slice(rawStart, rawEnd);
    const leadingWhitespace = segment.match(/^\s*/)?.[0].length || 0;
    const trailingWhitespace = segment.match(/\s*$/)?.[0].length || 0;
    const contentStart = rawStart + leadingWhitespace;
    const contentEnd = Math.max(contentStart, rawEnd - trailingWhitespace);
    cells.push({
      index,
      rawStart: lineStart + rawStart,
      rawEnd: lineStart + rawEnd,
      contentStart: lineStart + contentStart,
      contentEnd: lineStart + contentEnd,
      rawText: line.slice(rawStart, rawEnd),
      text: line.slice(contentStart, contentEnd),
    });
  }
  if (!cells.length) return null;
  return {
    index: rowIndex,
    startOffset: lineStart,
    endOffset: lineStart + line.length,
    lineText: line,
    leadingPipe,
    trailingPipe,
    cells,
  };
}

function isTableSeparatorRow(row) {
  return Boolean(row?.cells.length) && row.cells.every(cell => /^:?-{3,}:?$/.test(cell.text.trim()));
}

function formatTableRow(cells, template, { separator = false } = {}) {
  const values = cells.map((value, index) => {
    const text = separator ? value : value;
    const cell = template?.cells[Math.min(index, (template?.cells.length || 1) - 1)];
    const before = cell?.rawText.match(/^\s*/)?.[0] || '';
    const after = cell?.rawText.match(/\s*$/)?.[0] || '';
    return `${before}${text}${after}`;
  });
  const body = values.join('|');
  return `${template?.leadingPipe ? '|' : ''}${body}${template?.trailingPipe ? '|' : ''}`;
}

function emptyTableRow(template, count, separator = false, selectedSeparator = '---') {
  const values = Array.from({ length: count }, (_, index) => {
    if (!separator) return '';
    return index === 0 ? selectedSeparator : '---';
  });
  return formatTableRow(values, template, { separator });
}

/* Source-only Markdown table map. Every offset is measured in the original
   string, including CRLF bytes; the rendered table is never consulted. */
export function parseMarkdownTable(source, block = null) {
  const text = String(source ?? '');
  const candidate = block?.type === 'table' ? block : scanMarkdownBlocks(text).find(item => item.type === 'table');
  if (!candidate) return null;
  const lines = sourceLines(text).slice(candidate.startLine - 1, candidate.endLine);
  const rows = lines.map((line, index) => {
    const row = parseTableRow(line.text, line.start, index);
    return row ? { ...row, lineEnding: line.lineEnding, nextStartOffset: line.nextStart } : null;
  }).filter(Boolean);
  const separatorIndex = rows.findIndex(isTableSeparatorRow);
  const visualRows = rows.filter((_row, index) => index !== separatorIndex);
  const columnCount = Math.max(0, ...rows.map(row => row.cells.length));
  return {
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    sourceText: text.slice(candidate.startOffset, candidate.endOffset),
    rows,
    visualRows,
    separatorIndex,
    columnCount,
    lineEnding: rows.find(row => row.lineEnding)?.lineEnding || sourceLineEnding(text),
  };
}

export function tableCellRange(source, target = {}) {
  const table = parseMarkdownTable(source, target.block);
  if (!table || target.rowIndex === undefined || target.columnIndex === undefined) return null;
  const row = table.visualRows[Number(target.rowIndex)];
  const cell = row?.cells[Number(target.columnIndex)];
  if (!cell) return null;
  return {
    table,
    rowIndex: Number(target.rowIndex),
    columnIndex: Number(target.columnIndex),
    startOffset: cell.contentStart,
    endOffset: cell.contentEnd,
    sourceText: String(source).slice(cell.contentStart, cell.contentEnd),
  };
}

function tableLinesWithEndings(table, source) {
  const text = String(source ?? '');
  return table.rows.map(row => ({
    text: text.slice(row.startOffset, row.endOffset),
    lineEnding: row.lineEnding,
  }));
}

/* Returns one contiguous source replacement. The caller converts these raw
   offsets to CodeMirror offsets and dispatches exactly one transaction. */
export function tableStructureTransaction(source, target = {}) {
  const text = String(source ?? '');
  const table = parseMarkdownTable(text, target.block);
  if (!table) return null;
  const rowIndex = Number(target.rowIndex);
  const columnIndex = Number(target.columnIndex);
  const action = String(target.action || '');
  const visualRow = table.visualRows[rowIndex];
  if (!visualRow || !Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= table.columnCount) return null;
  const physicalIndex = table.rows.indexOf(visualRow);
  const separator = table.separatorIndex >= 0 ? table.rows[table.separatorIndex] : null;
  const lines = tableLinesWithEndings(table, text);
  const replaceLine = (index, value) => { lines[index].text = value; };
  const dataTemplate = table.visualRows.find((_row, index) => index > 0) || table.visualRows[0];
  const separatorTemplate = separator || table.visualRows[0];
  const separatorCell = separator?.cells[columnIndex]?.text.trim() || '---';
  const newData = () => emptyTableRow(dataTemplate, table.columnCount, false);
  const newSeparator = () => emptyTableRow(separatorTemplate, table.columnCount, true, separatorCell);

  if (action === 'add-row-above' || action === 'add-row-below') {
    // A Markdown table's header and separator are inseparable. There is no
    // valid row position above the header, while "below header" means the
    // first data row after the separator.
    if (rowIndex === 0 && action === 'add-row-above') return null;
    const insertAtPhysical = rowIndex === 0
      ? Math.max(1, table.separatorIndex + 1)
      : physicalIndex + (action === 'add-row-below' ? 1 : 0);
    const reference = table.rows[Math.min(table.rows.length - 1, Math.max(0, insertAtPhysical - 1))] || dataTemplate;
    let ending = lines[insertAtPhysical]?.lineEnding || table.lineEnding;
    if (insertAtPhysical === lines.length) {
      const previous = lines.at(-1);
      ending = previous?.lineEnding || '';
      if (previous && !previous.lineEnding) previous.lineEnding = table.lineEnding;
    }
    lines.splice(insertAtPhysical, 0, { text: emptyTableRow(reference, table.columnCount), lineEnding: ending });
  } else if (action === 'delete-row') {
    if (rowIndex === 0 || table.visualRows.length <= 2) return null;
    lines.splice(physicalIndex, 1);
  } else if (action === 'add-col-left' || action === 'add-col-right' || action === 'delete-col') {
    if (action === 'delete-col' && table.columnCount <= 1) return null;
    const delta = action === 'add-col-left' ? 0 : action === 'add-col-right' ? 1 : -1;
    const at = action === 'delete-col' ? columnIndex : columnIndex + delta;
    lines.forEach((line, index) => {
      const row = table.rows[index];
      if (!row) return;
      if (action === 'delete-col') {
        const cell = row.cells[at];
        if (!cell) return;
        const nextCell = row.cells[at + 1];
        const before = text.slice(row.startOffset, cell.rawStart);
        const after = nextCell
          ? text.slice(nextCell.rawStart, row.endOffset)
          : text.slice(cell.rawEnd, row.endOffset);
        replaceLine(index, `${before}${after}`);
        return;
      }
      const values = row.cells.map(cell => text.slice(cell.contentStart, cell.contentEnd));
      if (isTableSeparatorRow(row)) {
        values.splice(at, 0, separator?.cells[columnIndex]?.text.trim() || '---');
        replaceLine(index, formatTableRow(values, row, { separator: true }));
        return;
      }
      values.splice(at, 0, '');
      replaceLine(index, formatTableRow(values, row));
    });
  } else if (action === 'move-row-up' || action === 'move-row-down') {
    const other = rowIndex + (action === 'move-row-up' ? -1 : 1);
    if (rowIndex === 0 || other < 1 || other >= table.visualRows.length) return null;
    const otherPhysical = table.rows.indexOf(table.visualRows[other]);
    [lines[physicalIndex].text, lines[otherPhysical].text] = [lines[otherPhysical].text, lines[physicalIndex].text];
  } else if (action === 'move-col-left' || action === 'move-col-right') {
    const other = columnIndex + (action === 'move-col-left' ? -1 : 1);
    if (other < 0 || other >= table.columnCount) return null;
    lines.forEach((line, index) => {
      const row = table.rows[index];
      const values = row.cells.map(cell => text.slice(cell.contentStart, cell.contentEnd));
      [values[columnIndex], values[other]] = [values[other], values[columnIndex]];
      line.text = formatTableRow(values, row, { separator: index === table.separatorIndex });
    });
  } else if (['align-left', 'align-center', 'align-right'].includes(action)) {
    if (!separator) return null;
    const values = separator.cells.map(cell => cell.text.trim());
    values[columnIndex] = { 'align-left': ':---', 'align-center': ':---:', 'align-right': '---:' }[action];
    replaceLine(table.separatorIndex, formatTableRow(values, separator, { separator: true }));
  } else if (action === 'delete-table') {
    return { startOffset: table.startOffset, endOffset: table.endOffset, replacement: '', rowIndex: 0, columnIndex: 0 };
  } else if (action === 'format-table') {
    lines.forEach((line, index) => {
      const row = table.rows[index];
      line.text = formatTableRow(row.cells.map(cell => cell.text.trim()), row, { separator: index === table.separatorIndex });
    });
  } else return null;

  const replacement = lines.map(line => `${line.text}${line.lineEnding}`).join('');
  const selectionRow = action === 'add-row-above' ? rowIndex : action === 'add-row-below' ? rowIndex + 1 : rowIndex;
  const selectionColumn = action === 'add-col-left' ? columnIndex : action === 'add-col-right' ? columnIndex + 1 : Math.min(columnIndex, table.columnCount - (action === 'delete-col' ? 2 : 1));
  return {
    startOffset: table.startOffset,
    endOffset: table.endOffset,
    replacement,
    rowIndex: selectionRow,
    columnIndex: Math.max(0, selectionColumn),
    sourceText: table.sourceText,
  };
}

function sourceLineEndingNear(source, offset) {
  const text = String(source ?? '');
  const position = Math.max(0, Math.min(text.length, Number(offset) || 0));
  const at = text.slice(position).match(/^(\r\n|\r|\n)/)?.[0];
  if (at) return at;
  const previous = [...text.slice(0, position).matchAll(/\r\n|\r|\n/g)].at(-1)?.[0];
  if (previous) return previous;
  return text.slice(position).match(/\r\n|\r|\n/)?.[0] || '\n';
}

/* Typora's Enter turns an existing soft line boundary into a paragraph
   boundary. It must replace exactly one source newline, never append a second
   separator beside it. */
export function upgradeSoftBreakToParagraph(source, offset) {
  const text = String(source ?? '');
  const position = Math.max(0, Math.min(text.length, Number(offset) || 0));
  const newline = sourceLineEnding(text);
  if (text.slice(position, position + newline.length) !== newline) return null;
  if (text.slice(position + newline.length, position + newline.length * 2) === newline) return null;
  return replaceSourceRange(text, position, position + newline.length, newline + newline);
}

/* Immutable document facade used by every editor surface. A model owns one
   exact Markdown snapshot and its ranges; editing returns a new snapshot so a
   rendered DOM can never become the source of truth. */
export class MarkdownDocumentModel {
  constructor(source = '') {
    this.source = String(source ?? '');
    this.blocks = scanMarkdownBlocks(this.source);
  }

  get nonBlankBlocks() {
    return this.blocks.filter(block => block.type !== 'blank');
  }

  block(index, { nonBlank = false } = {}) {
    const blocks = nonBlank ? this.nonBlankBlocks : this.blocks;
    return blocks[Number(index)] || null;
  }

  range(index, { nonBlank = false, body = false } = {}) {
    const block = this.block(index, { nonBlank });
    return block ? (body ? blockSourceRange(block, this.source) : {
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      sourceText: block.sourceText,
    }) : null;
  }

  replace(startOffset, endOffset, replacement) {
    return new MarkdownDocumentModel(replaceSourceRange(this.source, startOffset, endOffset, replacement));
  }

  replaceBlock(index, replacement, { nonBlank = true, body = false } = {}) {
    const range = this.range(index, { nonBlank, body });
    return range ? this.replace(range.startOffset, range.endOffset, replacement) : null;
  }

  blocksOfType(type) {
    return this.blocks.filter(block => block.type === type);
  }

  replaceBlockBodyByType(type, ordinal, replacement) {
    const block = this.blocksOfType(type)[Number(ordinal)];
    if (!block) return null;
    const range = this.range(this.blocks.indexOf(block), { body: true });
    if (!range) return null;
    /* Editors expose LF internally. Convert only inserted line breaks to the
       document's existing convention so a CRLF file never gets mixed EOLs. */
    const newline = sourceLineEndingNear(this.source, range.startOffset);
    let normalized = String(replacement ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, newline);
    if (normalized) {
      const before = this.source.slice(0, range.startOffset);
      const after = this.source.slice(range.endOffset);
      if (before && !/(?:\r\n|\r|\n)$/.test(before)) normalized = newline + normalized;
      if (block.closed && after && !/^(?:\r\n|\r|\n)/.test(after)) normalized += newline;
    }
    return this.replace(range.startOffset, range.endOffset, normalized);
  }
}
