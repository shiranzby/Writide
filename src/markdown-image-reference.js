import MarkdownIt from 'markdown-it';
import { scanMarkdownImageRanges } from './markdown-model.js';

const markdown = new MarkdownIt();

function sameDestination(left, right) {
  try {
    const base = 'https://markdown.invalid/';
    return decodeURI(new URL(left, base).href) === decodeURI(new URL(right, base).href);
  } catch { return false; }
}

// Operate on the exact source destination, never an occurrence in alt/title text.
export function imageReferenceReplacement(source, renderedHref, nextHref) {
  // Readable Unicode in source; retain reserved ASCII escapes and literal %.
  nextHref = nextHref.replace(/(?:%[89a-f][\da-f])+/gi, encoded => {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  });
  const image = scanMarkdownImageRanges(source).find(range => range.startOffset === 0 && range.endOffset === source.length);
  if (image?.kind === 'inline') {
    let from = image.altEndOffset + 2;
    while (/[ \t]/.test(source[from] || '') && from < source.length) from++;
    const destination = markdown.helpers.parseLinkDestination(source, from, source.length);
    if (destination.ok && sameDestination(destination.str, renderedHref)) {
      const angled = source[from] === '<';
      const replacement = angled ? `<${nextHref.replace(/>/g, '%3E')}>`
        : nextHref.replace(/ /g, '%20').replace(/[()]/g, value => `\\${value}`);
      return source.slice(0, from) + replacement + source.slice(destination.pos);
    }
  }
  if (/^<img\s/i.test(source)) {
    const attribute = [...source.matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .find(match => match[1].toLowerCase() === 'src');
    if (attribute) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      const decoded = markdown.utils.unescapeAll(value);
      if (sameDestination(decoded, renderedHref)) {
        const start = attribute.index + attribute[0].indexOf('=') + 1;
        const prefix = source.slice(0, start);
        const escaped = nextHref.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return prefix + `"${escaped}"` + source.slice(attribute.index + attribute[0].length);
      }
    }
  }
  return null;
}
