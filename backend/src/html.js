/**
 * HTML -> a flat list of typed blocks the PDF renderer can lay out.
 *
 * jsPDF's own `doc.html()` needs a browser (html2canvas plus a live DOM), which
 * a Node server does not have. So the markup is reduced here to the structure a
 * document actually carries -- headings, paragraphs, list items, rules -- and
 * the renderer draws those with jsPDF's text API.
 *
 * A <textarea> is the exception: what is inside one was typed by hand, so it is
 * taken as plain text with its line breaks intact rather than reduced.
 *
 * Blocks: { type: 'h1'|'h2'|'h3'|'p'|'li'|'quote'|'pre'|'hr', text, indent }
 */

/** Tags that open a new block, mapped to the style the renderer knows. */
const BLOCK_TAGS = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h3',
  h5: 'h3',
  h6: 'h3',
  p: 'p',
  div: 'p',
  section: 'p',
  article: 'p',
  header: 'p',
  footer: 'p',
  main: 'p',
  td: 'p',
  th: 'p',
  tr: 'p',
  dd: 'p',
  dt: 'h3',
  li: 'li',
  blockquote: 'quote',
  pre: 'pre',
  code: null, // inline unless inside <pre>
};

const LIST_TAGS = new Set(['ul', 'ol']);
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'head', 'title']);

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  eacute: 'é',
};

function decode(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+[0-9]*);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * Split HTML into blocks. Plain text (no tags at all) is treated as paragraphs
 * separated by blank lines, so a caller may pass either.
 */
export function htmlToBlocks(html) {
  const source = String(html || '');
  if (!source.trim()) return [];
  // No tags at all: a typed value, though it may still carry entities if the
  // caller read a field's innerHTML rather than its value.
  if (!/<[a-z!/]/i.test(source)) return plainTextToBlocks(decode(source));

  const blocks = [];
  let type = 'p';
  let indent = 0;
  let buffer = '';
  // Nested lists: each level remembers whether it numbers its items.
  const lists = [];
  let dropDepth = 0;
  let preDepth = 0;
  let rawDepth = 0;

  const flush = () => {
    const text = preDepth > 0 ? buffer.replace(/[ \t]+$/gm, '') : buffer.replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ type, text, indent });
    buffer = '';
  };

  /* A <textarea> holds what a person typed, not markup for us to reduce, so its
     line breaks are the document's shape -- salutation, paragraphs, sign-off --
     and are kept rather than collapsed. An editor that keeps HTML in a textarea
     sends escaped markup instead; that is parsed as markup. */
  const flushRaw = () => {
    const raw = buffer;
    buffer = '';
    type = 'p';
    indent = 0;
    for (const block of /<[a-z!/]/i.test(raw) ? htmlToBlocks(raw) : plainTextToBlocks(raw)) {
      blocks.push(block);
    }
  };

  const token = /<!--[\s\S]*?-->|<\/?([a-z][a-z0-9]*)\b[^>]*>|[^<]+/gi;
  for (const match of source.matchAll(token)) {
    const whole = match[0];
    const tag = match[1] ? match[1].toLowerCase() : null;

    if (rawDepth > 0) {
      if (tag === 'textarea' && whole.startsWith('</')) {
        rawDepth -= 1;
        flushRaw();
      } else {
        buffer += tag ? whole : decode(whole);
      }
      continue;
    }

    if (whole.startsWith('<!--')) continue;

    if (!tag) {
      if (dropDepth === 0) buffer += decode(whole);
      continue;
    }

    const closing = whole.startsWith('</');

    if (DROP_TAGS.has(tag)) {
      dropDepth += closing ? -1 : 1;
      if (dropDepth < 0) dropDepth = 0;
      continue;
    }
    if (dropDepth > 0) continue;

    if (tag === 'textarea') {
      flush();
      if (!closing) rawDepth = 1;
      continue;
    }

    if (tag === 'br') {
      buffer += '\n';
      continue;
    }
    if (tag === 'hr') {
      flush();
      blocks.push({ type: 'hr', text: '', indent });
      continue;
    }

    if (LIST_TAGS.has(tag)) {
      flush();
      if (closing) lists.pop();
      else lists.push({ ordered: tag === 'ol', n: 0 });
      indent = lists.length;
      continue;
    }

    if (tag === 'pre') {
      flush();
      preDepth += closing ? -1 : 1;
      if (preDepth < 0) preDepth = 0;
      type = preDepth > 0 ? 'pre' : 'p';
      continue;
    }

    const mapped = BLOCK_TAGS[tag];
    if (mapped === undefined || mapped === null) continue; // inline: keep collecting

    flush();
    if (closing) {
      type = preDepth > 0 ? 'pre' : 'p';
      continue;
    }

    type = preDepth > 0 ? 'pre' : mapped;
    if (mapped === 'li') {
      const list = lists[lists.length - 1];
      indent = Math.max(1, lists.length);
      // Marker is part of the text so wrapped lines can hang under it.
      buffer = list && list.ordered ? `${(list.n += 1)}. ` : '• ';
    } else {
      indent = 0;
    }
  }
  // An unclosed <textarea> still gives up what it was holding.
  if (rawDepth > 0) flushRaw();
  else flush();

  return collapse(blocks);
}

/**
 * Paragraphs from a plain-text body: a blank line starts a new one, and the
 * single line breaks inside a paragraph are kept -- text that was typed by hand
 * is read back the way it was typed, and the renderer draws "\n" as a break.
 */
function plainTextToBlocks(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((chunk) =>
      chunk
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .trim(),
    )
    .filter(Boolean)
    .map((chunk) => ({ type: 'p', text: chunk, indent: 0 }));
}

/** Drop leading/trailing rules and runs of duplicate rules. */
function collapse(blocks) {
  const out = [];
  for (const block of blocks) {
    if (block.type === 'hr' && (out.length === 0 || out[out.length - 1].type === 'hr')) continue;
    out.push(block);
  }
  while (out.length && out[out.length - 1].type === 'hr') out.pop();
  return out;
}

/** First line of readable text, for previews in the review queue. */
export function excerpt(content, max = 220) {
  // A structured resume has no markup to reduce; its summary is the preview.
  const html =
    content && typeof content === 'object'
      ? [content.SUMMARY, ...(Array.isArray(content.SKILLS) ? content.SKILLS : [])].filter(Boolean).join(' ')
      : content;
  const text = htmlToBlocks(html)
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
