import { jsPDF } from 'jspdf';
import { applyFont, encodeFor } from './pdf.js';

/**
 * HTML + its stylesheet -> a PDF, drawn with jsPDF.
 *
 * jsPDF's own `doc.html()` needs a browser (html2canvas plus a live DOM), so
 * the page is read here instead: the markup is parsed into a tree, the
 * `<style>` block into rules, and the two are walked together to place text on
 * the page. That keeps the document's design in one place -- the stylesheet --
 * rather than duplicated in a renderer.
 *
 * It is a small subset of CSS, sized to the documents this server generates:
 * block flow with margins and padding, backgrounds and single-edge borders,
 * inline runs with their own weight and colour, unordered lists, and the
 * page-break hints. No floats and no positioning; of grid, only the one row
 * the resumes use -- `1fr auto` over inline items, the last one hard right.
 */

/* --- markup ---------------------------------------------------------------- */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', bull: '•',
  ndash: '–', mdash: '—', hellip: '…', middot: '·',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
};

const decode = (text) =>
  String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);

/** Parse markup into a tree of { tag, attrs, classes, children } and text nodes. */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, classes: [], children: [] };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]>|<!doctype[^>]*>|<\/([a-z][a-z0-9]*)\s*>|<([a-z][a-z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/?)>|[^<]+/gi;

  let skipDepth = 0;
  let skipTag = null;

  for (const match of String(html).matchAll(token)) {
    const [whole, closeTag, openTag, rawAttrs, selfClose] = match;

    if (skipDepth > 0) {
      if (closeTag && closeTag.toLowerCase() === skipTag) skipDepth -= 1;
      else if (openTag && openTag.toLowerCase() === skipTag) skipDepth += 1;
      continue;
    }
    if (whole.startsWith('<!')) continue;

    if (closeTag) {
      const name = closeTag.toLowerCase();
      // Close the nearest matching element, tolerating unclosed tags.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (openTag) {
      const name = openTag.toLowerCase();
      if (SKIP.has(name)) {
        if (!selfClose && !VOID.has(name)) {
          skipDepth = 1;
          skipTag = name;
        }
        continue;
      }
      const attrs = {};
      for (const attr of String(rawAttrs || '').matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g)) {
        if (!attr[1]) continue;
        attrs[attr[1].toLowerCase()] = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
      }
      const node = {
        tag: name,
        attrs,
        classes: (attrs.class || '').split(/\s+/).filter(Boolean),
        children: [],
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClose && !VOID.has(name)) stack.push(node);
      continue;
    }

    const text = decode(whole);
    if (text) stack[stack.length - 1].children.push({ tag: '#text', text });
  }

  return root;
}

/** Everything inside the first <style> block. */
export function extractCss(html) {
  return [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]).join('\n');
}

/* --- stylesheet ------------------------------------------------------------ */

/**
 * Parse rules into { selector parts, declarations, order }. `@media print` is
 * treated as applying, because a PDF is print; anything else is skipped.
 */
export function parseCss(css) {
  const source = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const variables = {};
  let order = 0;

  const readBlock = (text, printing) => {
    const rule = /([^{}]+)\{([^{}]*)\}|@media([^{]*)\{((?:[^{}]*\{[^{}]*\})*)\}/g;
    for (const match of text.matchAll(rule)) {
      if (match[3] !== undefined) {
        if (/\bprint\b|\ball\b/.test(match[3])) readBlock(match[4], true);
        continue;
      }
      const selectors = match[1].trim();
      // @page and the rest describe the sheet, not the elements on it. @media
      // is read above; anything else here would otherwise parse as a selector
      // with no tag and no class -- which matches everything.
      if (selectors.startsWith('@')) continue;
      const declarations = {};
      for (const line of match[2].split(';')) {
        const at = line.indexOf(':');
        if (at === -1) continue;
        const property = line.slice(0, at).trim().toLowerCase();
        const value = line.slice(at + 1).trim();
        if (property) declarations[property] = value;
      }
      if (selectors === ':root') {
        for (const [property, value] of Object.entries(declarations)) {
          if (property.startsWith('--')) variables[property] = value;
        }
        continue;
      }
      for (const selector of selectors.split(',')) {
        const parts = selector
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(readCompound)
          .filter(Boolean);
        if (!parts.length) continue;
        // A print rule wins over the same-specificity screen rule above it.
        rules.push({ parts, declarations, order: order++, printing: printing ? 1 : 0 });
      }
    }
  };

  readBlock(source, false);
  return { rules, variables };
}

/** "h2.section" -> { tag: 'h2', classes: ['section'] }; pseudo-classes ignored. */
function readCompound(part) {
  const clean = part.replace(/::?[a-z-]+(\([^)]*\))?/gi, '');
  if (!clean || clean === '>' || clean === '+' || clean === '~') return null;
  const classes = [...clean.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  const tag = (clean.match(/^([a-z][a-z0-9]*)/i) || [])[1];
  if (clean === '*') return { tag: null, classes: [], universal: true };
  return { tag: tag ? tag.toLowerCase() : null, classes };
}

const matchesCompound = (node, part) =>
  (part.universal || !part.tag || node.tag === part.tag) &&
  part.classes.every((name) => node.classes.includes(name));

/** Descendant combinators only -- the sheets here use nothing else. */
function matches(parts, node, ancestors) {
  if (!matchesCompound(node, parts[parts.length - 1])) return false;
  let index = parts.length - 2;
  for (let a = ancestors.length - 1; a >= 0 && index >= 0; a -= 1) {
    if (matchesCompound(ancestors[a], parts[index])) index -= 1;
  }
  return index < 0;
}

const specificity = (parts) =>
  parts.reduce((total, part) => total + part.classes.length * 10 + (part.tag ? 1 : 0), 0);

/** Properties a child takes from its parent, as CSS defines inheritance. */
const INHERITED = ['color', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform'];

/** The declarations that apply to one node, parent values included. */
export function computeStyle(node, ancestors, sheet, inherited) {
  const own = {};
  const applicable = sheet.rules
    .filter((rule) => matches(rule.parts, node, ancestors))
    .sort((a, b) => specificity(a.parts) - specificity(b.parts) || a.printing - b.printing || a.order - b.order);
  for (const rule of applicable) Object.assign(own, rule.declarations);

  const style = {};
  for (const property of INHERITED) if (inherited[property] !== undefined) style[property] = inherited[property];
  Object.assign(style, own);
  return style;
}

/* --- values ---------------------------------------------------------------- */

const PT_PER_PX = 0.75;
const MM_PER_PT = 25.4 / 72;

const resolveVar = (value, variables) =>
  String(value).replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g, (_, name, fallback) =>
    variables[name] !== undefined ? variables[name] : (fallback || '').trim());

/** A CSS length in points. */
export function points(value, variables, base = 0) {
  const raw = resolveVar(value ?? '', variables).trim();
  const match = /^(-?[\d.]+)(px|pt|in|mm|em|rem)?$/.exec(raw);
  if (!match) return 0;
  const size = Number(match[1]);
  switch (match[2]) {
    case 'pt': return size;
    case 'in': return size * 72;
    case 'mm': return size / MM_PER_PT;
    case 'em':
    case 'rem': return size * base;
    default: return size * PT_PER_PX;
  }
}

/**
 * CSS `line-height` as a plain multiplier of the font size — the only form
 * the renderer's own arithmetic uses (`size * lineHeight`). Unlike every
 * other length in this file, the property is legitimately unitless (`1.45`),
 * a length (`20px`), a percentage (`150%`) or the keyword `normal`, so a bare
 * `Number(...)` on it silently becomes NaN for the last three — which then
 * poisons every `state.y` added to after it, and eventually reaches jsPDF as
 * a non-finite rect height ("Invalid arguments passed to jsPDF.rect").
 * Falls back to 1.2 for anything it cannot read, the same as the property
 * being absent.
 */
export function lineHeightOf(value, variables, size) {
  const raw = resolveVar(value ?? '', variables).trim();
  if (/^-?[\d.]+$/.test(raw)) return Number(raw);
  if (raw.endsWith('%')) {
    const pct = Number(raw.slice(0, -1));
    return Number.isFinite(pct) && pct > 0 ? pct / 100 : 1.2;
  }
  const length = points(raw, variables, size);
  return length > 0 && size > 0 ? length / size : 1.2;
}

/** "10px 14px" -> { top, right, bottom, left } in points. */
export function box(value, variables, base) {
  const parts = resolveVar(value ?? '', variables).trim().split(/\s+/).filter(Boolean);
  const at = (index) => points(parts[index], variables, base);
  if (parts.length === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (parts.length === 1) return { top: at(0), right: at(0), bottom: at(0), left: at(0) };
  if (parts.length === 2) return { top: at(0), right: at(1), bottom: at(0), left: at(1) };
  if (parts.length === 3) return { top: at(0), right: at(1), bottom: at(2), left: at(1) };
  return { top: at(0), right: at(1), bottom: at(2), left: at(3) };
}

const NAMED = { white: [255, 255, 255], black: [0, 0, 0] };

/** A CSS colour as [r, g, b], or null. */
export function colour(value, variables) {
  const raw = resolveVar(value ?? '', variables).trim().toLowerCase();
  if (!raw || raw === 'transparent' || raw === 'none') return null;
  if (NAMED[raw]) return NAMED[raw];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(raw);
  if (rgb) {
    // CSS Color 4 allows "r g b" / "r g b / a" alongside the older
    // "r, g, b", and both show up in generated CSS — split on either so a
    // channel is never silently left stuck to its neighbour (which would
    // parse as one non-numeric chunk and leave a NaN in the result).
    const channels = rgb[1].split('/')[0].split(/[,\s]+/).filter(Boolean).slice(0, 3).map((part) => Math.round(Number(part)));
    return channels.length === 3 && channels.every(Number.isFinite) ? channels : null;
  }
  return null;
}

/** "2px solid var(--teal)" -> { width, colour }. */
function border(value, variables) {
  const raw = resolveVar(value ?? '', variables).trim();
  if (!raw || raw === '0' || raw === 'none') return null;
  const width = points((raw.match(/(-?[\d.]+(?:px|pt|mm|in)?)/) || [])[1], variables);
  if (!width) return null;
  return { width, colour: colour((raw.match(/#[0-9a-f]{3,6}|rgba?\([^)]*\)/i) || [])[0], variables) || [0, 0, 0] };
}

/* --- rendering -------------------------------------------------------------- */

const BLOCK = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'hr', 'body', 'section', 'article', 'header', 'footer', 'main', 'blockquote']);
const isBlock = (node) => node.tag !== '#text' && BLOCK.has(node.tag);

/** The page-break hints, in both spellings: legacy page-break-* and CSS3 break-*. */
const avoidsBreakInside = (style) => style['page-break-inside'] === 'avoid' || style['break-inside'] === 'avoid';
const keepsWithNext = (style) => style['page-break-after'] === 'avoid' || style['break-after'] === 'avoid';

/** Page geometry, in millimetres. */
const PAGE_MARGIN = { top: 15, bottom: 15, left: 15, right: 15 };

export function renderHtmlToPdf(html, { url } = {}) {
  const tree = parseHtml(html);
  const sheet = parseCss(extractCss(html));
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const font = applyFont(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  let lost = 0;

  const text = (value) => {
    const { text: safe, lost: dropped } = encodeFor(value);
    lost += dropped;
    return safe;
  };

  const body = find(tree, 'body') || tree;
  const bodyStyle = computeStyle(body, [], sheet, {});
  const baseSize = points(bodyStyle['font-size'] || '12px', sheet.variables) || 12;
  const bodyPad = box(bodyStyle.padding, sheet.variables, baseSize);

  const left = PAGE_MARGIN.left + bodyPad.left * MM_PER_PT;
  const right = pageWidth - PAGE_MARGIN.right - bodyPad.right * MM_PER_PT;
  const top = PAGE_MARGIN.top + bodyPad.top * MM_PER_PT;
  const bottom = pageHeight - PAGE_MARGIN.bottom;

  const state = { y: top, draw: true };

  const newPage = () => {
    if (state.draw) doc.addPage();
    state.y = top;
  };

  // Measuring lays a subtree out with drawing off to learn its height, so it
  // must never break the page: a break jumps y back to the top, and the height
  // comes out small or negative -- precisely when the block does not fit, which
  // is the only time the answer matters. That is what let "avoid" blocks split.
  const room = (height) => {
    if (!state.draw) return;
    if (state.y + height <= bottom) return;
    newPage();
  };

  const setFont = (style) => {
    const weight = Number(style['font-weight']) >= 600 || style['font-weight'] === 'bold' ? 'bold' : 'normal';
    const italic = style['font-style'] === 'italic';
    let want = weight === 'bold' ? (italic ? 'bolditalic' : 'bold') : italic ? 'italic' : 'normal';
    if (font.styles && !font.styles.has(want)) want = 'normal';
    doc.setFont(font.family, want);
    doc.setFontSize(points(style['font-size'] || `${baseSize}pt`, sheet.variables, baseSize) || baseSize);
    const ink = colour(style.color, sheet.variables) || [0, 0, 0];
    doc.setTextColor(...ink);
    doc.setCharSpace(points(style['letter-spacing'], sheet.variables, baseSize) * MM_PER_PT || 0);
  };

  // How far a piece of text moves the cursor in the current font. jsPDF's
  // getTextWidth() ignores setCharSpace(), but doc.text() draws with it -- so
  // with letter-spacing each word overran the width it was given and swallowed
  // the space after it ("PROFESSIONALSUMMARY"). Letter-spacing follows every
  // character, spaces included, as it does in a browser.
  const advanceOf = (value) => doc.getTextWidth(value) + doc.getCharSpace() * value.length;

  /** Flatten a node's inline descendants into runs carrying their own style. */
  const runs = (node, style, ancestors) => {
    const out = [];
    for (const child of node.children || []) {
      if (child.tag === '#text') {
        out.push({ text: child.text, style, href: null });
        continue;
      }
      const childStyle = computeStyle(child, [...ancestors, node], sheet, style);
      if (childStyle['text-transform'] === 'uppercase') childStyle.transform = 'uppercase';
      const href = child.tag === 'a' ? child.attrs.href : null;
      const margin = box(childStyle.margin, sheet.variables, baseSize);
      // An element's margins sit outside everything it holds, so they go on its
      // first and last run rather than on every one -- and they add to whatever
      // a nested element already asked for instead of replacing it.
      const inner = runs(child, childStyle, [...ancestors, node]);
      inner.forEach((run, index) => {
        out.push({
          ...run,
          href: run.href || href,
          spaceBefore: (run.spaceBefore || 0) + (index === 0 ? margin.left : 0),
          spaceAfter: (run.spaceAfter || 0) + (index === inner.length - 1 ? margin.right : 0),
        });
      });
    }
    return out;
  };

  /** How wide runs are on one line, in millimetres. */
  const runsWidth = (list) =>
    list.reduce((total, run) => {
      setFont(run.style);
      const value = run.style['text-transform'] === 'uppercase' ? run.text.toUpperCase() : run.text;
      return total + advanceOf(text(value.replace(/\s+/g, ' '))) + ((run.spaceBefore || 0) + (run.spaceAfter || 0)) * MM_PER_PT;
    }, 0);

  /**
   * `display: grid` with `grid-template-columns: 1fr auto` over inline items:
   * the school and its years, say. The last item is the auto column, as wide
   * as its text and hard right; everything before it is the 1fr column and
   * wraps in what is left. Null for any other grid, which flows as blocks do.
   */
  const splitRow = (node, style, ancestors) => {
    if (style.display !== 'grid') return null;
    const tracks = resolveVar(style['grid-template-columns'] || '', sheet.variables).trim().split(/\s+/);
    if (tracks.length !== 2 || tracks[1] !== 'auto') return null;
    const items = (node.children || []).filter((child) => child.tag !== '#text' || child.text.trim());
    if (items.length < 2 || items.some(isBlock)) return null;

    const right = runs({ ...node, children: items.slice(-1) }, style, ancestors)
      .map((run) => ({ ...run, text: run.text.trim() }))
      .filter((run) => run.text);
    if (!right.length) return null;
    return {
      left: runs({ ...node, children: items.slice(0, -1) }, style, ancestors),
      right,
      gap: points(style['column-gap'] || style.gap, sheet.variables, baseSize) * MM_PER_PT,
    };
  };

  /**
   * Draw runs as wrapped lines. Returns the height used. `trailing` runs, if
   * any, are drawn hard right on the first line, and every line stops short
   * of them by `gap`.
   */
  const inline = (list, x, width, style, trailing = null, gap = 0) => {
    const size = points(style['font-size'] || `${baseSize}pt`, sheet.variables, baseSize) || baseSize;
    const lineHeight = lineHeightOf(style['line-height'] || bodyStyle['line-height'], sheet.variables, size);
    const step = size * lineHeight * MM_PER_PT;

    const trailingWidth = trailing ? runsWidth(trailing) : 0;
    const fullWidth = width;
    if (trailing) width = Math.max(fullWidth - trailingWidth - gap, fullWidth / 3);
    let first = true;

    // Split every run into words, keeping each word's style with it.
    const words = [];
    for (const run of list) {
      const value = style.transform === 'uppercase' || run.style['text-transform'] === 'uppercase'
        ? run.text.toUpperCase()
        : run.text;
      // A left margin opens its gap before the run and a right margin after it.
      // Both on one side would leave the element hard against its neighbour --
      // which is what a separator bullet between contact details shows first.
      if (run.spaceBefore) words.push({ ...run, text: '', pad: run.spaceBefore });
      const pieces = value.split(/(\s+)/).filter((piece) => piece !== '');
      for (const piece of pieces) words.push({ ...run, text: piece, space: /^\s+$/.test(piece) });
      if (run.spaceAfter) words.push({ ...run, text: '', pad: run.spaceAfter });
    }

    let line = [];
    let lineWidth = 0;
    let used = 0;

    const flush = () => {
      if (!line.length && !(first && trailing)) return;
      room(step);
      if (first && trailing) {
        let at = x + fullWidth - trailingWidth;
        for (const run of trailing) {
          at += (run.spaceBefore || 0) * MM_PER_PT;
          setFont(run.style);
          const value = text((run.style['text-transform'] === 'uppercase' ? run.text.toUpperCase() : run.text).replace(/\s+/g, ' '));
          if (state.draw) doc.text(value, at, state.y + step * 0.76);
          at += advanceOf(value) + (run.spaceAfter || 0) * MM_PER_PT;
        }
      }
      first = false;
      let cursor = x;
      for (const word of line) {
        if (word.pad) {
          cursor += word.pad * MM_PER_PT;
          continue;
        }
        setFont(word.style);
        if (state.draw && word.text.trim()) {
          if (word.href) doc.textWithLink(text(word.text), cursor, state.y + step * 0.76, { url: word.href });
          else doc.text(text(word.text), cursor, state.y + step * 0.76);
        }
        cursor += advanceOf(text(word.text));
      }
      state.y += step;
      used += step;
      line = [];
      lineWidth = 0;
    };

    for (const word of words) {
      if (word.pad) {
        // A margin, like a space, must not indent the start of a wrapped line.
        if (!line.length) continue;
        line.push(word);
        lineWidth += word.pad * MM_PER_PT;
        continue;
      }
      setFont(word.style);
      const advance = advanceOf(text(word.text));
      if (lineWidth + advance > width && line.length) flush();
      // A space must not start a line -- checked after the wrap, or the space
      // that caused the break becomes the next line's indent.
      if (word.space && !line.length) continue;
      line.push(word);
      lineWidth += advance;
    }
    flush();
    return used;
  };

  /** A block's inline content: a `1fr auto` row when it is one, wrapped text otherwise. */
  const inlineOrRow = (node, style, ancestors, x, width) => {
    const row = splitRow(node, style, ancestors);
    return row
      ? inline(row.left, x, width, style, row.right, row.gap)
      : inline(runs(node, style, ancestors), x, width, style);
  };

  /** A block's margin and padding in points, the longhands the sheets use included. */
  const spacing = (style) => {
    const margin = box(style.margin, sheet.variables, baseSize);
    if (style['margin-top'] !== undefined) margin.top = points(style['margin-top'], sheet.variables, baseSize);
    if (style['margin-bottom'] !== undefined) margin.bottom = points(style['margin-bottom'], sheet.variables, baseSize);
    const padding = box(style.padding, sheet.variables, baseSize);
    if (style['padding-bottom'] !== undefined) padding.bottom = points(style['padding-bottom'], sheet.variables, baseSize);
    if (style['padding-left'] !== undefined) padding.left = points(style['padding-left'], sheet.variables, baseSize);
    return { margin, padding };
  };

  /** Render one block and everything under it. */
  const block = (node, ancestors, x, width, inheritedStyle) => {
    const style = computeStyle(node, ancestors, sheet, inheritedStyle);
    if (style.display === 'none') return;

    const { margin, padding } = spacing(style);

    state.y += margin.top * MM_PER_PT;

    if (node.tag === 'hr') {
      const rule = border(style['border-top'] || style.border, sheet.variables);
      if (rule) {
        room(rule.width * MM_PER_PT);
        if (state.draw) {
          doc.setDrawColor(...rule.colour);
          doc.setLineWidth(rule.width * MM_PER_PT);
          doc.line(x, state.y, x + width, state.y);
        }
        state.y += rule.width * MM_PER_PT;
      }
      state.y += margin.bottom * MM_PER_PT;
      return;
    }

    const background = colour(style.background || style['background-color'], sheet.variables);
    const edge = border(style['border-left'], sheet.variables);
    const inner = { x: x + padding.left * MM_PER_PT, width: width - (padding.left + padding.right) * MM_PER_PT };

    // A box with a background or an edge needs its height before it is drawn,
    // so the children are laid out once with drawing switched off.
    if ((background || edge) && state.draw) {
      const height = measure(node, ancestors, inner.x, inner.width, inheritedStyle) + (padding.top + padding.bottom) * MM_PER_PT;
      if (state.y + height > bottom && height <= bottom - top) newPage();
      if (background) {
        doc.setFillColor(...background);
        doc.rect(x, state.y, width, height, 'F');
      }
      if (edge) {
        doc.setFillColor(...edge.colour);
        doc.rect(x, state.y, edge.width * MM_PER_PT, height, 'F');
      }
    } else if (avoidsBreakInside(style) && state.draw) {
      const height = measure(node, ancestors, inner.x, inner.width, inheritedStyle);
      if (state.y + height > bottom && height <= bottom - top) newPage();
    }

    state.y += padding.top * MM_PER_PT;

    const children = node.children || [];
    const blocks = children.filter(isBlock);

    if (blocks.length) {
      flow(blocks, [...ancestors, node], inner.x, inner.width, style);
    } else if (node.tag === 'li') {
      // ul li::before puts a bullet in the padding to the left of the text. The
      // marker is drawn before that text is laid out, so the first line has to
      // be known to fit before the marker goes down -- otherwise the page
      // breaks between the two and the bullet is stranded at the foot of the
      // page its sentence has just left.
      const marker = points('12px', sheet.variables);
      const size = points(style['font-size'] || `${baseSize}pt`, sheet.variables, baseSize) || baseSize;
      const lineHeight = lineHeightOf(style['line-height'] || bodyStyle['line-height'], sheet.variables, size);
      const step = size * lineHeight * MM_PER_PT;
      room(step);
      if (state.draw) {
        setFont(style);
        doc.text(text('•'), inner.x - marker * MM_PER_PT, state.y + step * 0.76);
      }
      inline(runs(node, style, ancestors), inner.x, inner.width, style);
    } else {
      inlineOrRow(node, style, ancestors, inner.x, inner.width);
    }

    state.y += padding.bottom * MM_PER_PT;

    const under = border(style['border-bottom'], sheet.variables);
    if (under) {
      room(under.width * MM_PER_PT);
      if (state.draw) {
        doc.setDrawColor(...under.colour);
        doc.setLineWidth(under.width * MM_PER_PT);
        doc.line(x, state.y, x + width, state.y);
      }
      state.y += under.width * MM_PER_PT;
    }

    state.y += margin.bottom * MM_PER_PT;
  };

  /** Lay a subtree out without drawing, to learn how tall it is. */
  function measure(node, ancestors, x, width, inheritedStyle) {
    const wasDrawing = state.draw;
    const startY = state.y;
    state.draw = false;
    const style = computeStyle(node, ancestors, sheet, inheritedStyle);
    const children = node.children || [];
    if (children.some(isBlock)) {
      for (const child of children) if (isBlock(child)) block(child, [...ancestors, node], x, width, style);
    } else {
      inlineOrRow(node, style, ancestors, x, width);
    }
    const height = state.y - startY;
    state.y = startY;
    state.draw = wasDrawing;
    return height;
  }

  /** A whole block laid out without drawing -- margins, padding and borders included. */
  function measureBlock(node, ancestors, x, width, inheritedStyle) {
    const wasDrawing = state.draw;
    const startY = state.y;
    state.draw = false;
    block(node, ancestors, x, width, inheritedStyle);
    const height = state.y - startY;
    state.y = startY;
    state.draw = wasDrawing;
    return height;
  }

  /**
   * How much of blocks[i] has to fit for it to start on this page: all of a
   * block that may not be split (or is drawn as one box), otherwise its own top
   * spacing plus the lead of its first child -- down to the first bullet or
   * paragraph. A block that keeps with its next sibling brings that sibling's
   * lead along, so heading -> job header -> first bullet moves as one unit.
   */
  function lead(blocks, i, ancestors, x, width, inheritedStyle) {
    const node = blocks[i];
    const style = computeStyle(node, ancestors, sheet, inheritedStyle);
    if (style.display === 'none') return 0;

    const children = (node.children || []).filter(isBlock);
    const solid =
      !children.length ||
      avoidsBreakInside(style) ||
      colour(style.background || style['background-color'], sheet.variables) ||
      border(style['border-left'], sheet.variables);

    if (!solid) {
      const { margin, padding } = spacing(style);
      const innerX = x + padding.left * MM_PER_PT;
      const innerWidth = width - (padding.left + padding.right) * MM_PER_PT;
      return (margin.top + padding.top) * MM_PER_PT + lead(children, 0, [...ancestors, node], innerX, innerWidth, style);
    }

    let height = measureBlock(node, ancestors, x, width, inheritedStyle);
    if (keepsWithNext(style) && blocks[i + 1]) height += lead(blocks, i + 1, ancestors, x, width, inheritedStyle);
    return height;
  }

  /**
   * Sibling blocks in order. One marked page-break-after: avoid goes to a new
   * page first unless it and the start of what follows both fit, so a heading
   * or a job header is never left alone at the foot of a page. Anything taller
   * than a page is left to break where it must.
   */
  function flow(blocks, ancestors, x, width, inheritedStyle) {
    blocks.forEach((child, i) => {
      if (state.draw && blocks[i + 1] && keepsWithNext(computeStyle(child, ancestors, sheet, inheritedStyle))) {
        const need =
          measureBlock(child, ancestors, x, width, inheritedStyle) + lead(blocks, i + 1, ancestors, x, width, inheritedStyle);
        if (state.y + need > bottom && need <= bottom - top) newPage();
      }
      block(child, ancestors, x, width, inheritedStyle);
    });
  }

  flow((body.children || []).filter(isBlock), [body], left, right - left, bodyStyle);

  const heading = find(tree, 'h1');
  doc.setProperties({
    title: textOf(find(tree, 'title')) || (heading ? textOf(heading) : 'Document'),
    keywords: url || '',
    creator: 'jobsaver',
  });

  return { pdf: Buffer.from(doc.output('arraybuffer')), pages: doc.getNumberOfPages(), lost };
}

/** First element with this tag, depth first. */
function find(node, tag) {
  if (node.tag === tag) return node;
  for (const child of node.children || []) {
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
}

/** All the text under a node. */
function textOf(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.text;
  return (node.children || []).map(textOf).join('');
}
