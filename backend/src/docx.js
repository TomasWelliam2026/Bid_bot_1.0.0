import { deflateRawSync } from 'node:zlib';
import { htmlToBlocks } from './html.js';
import { colour, computeStyle, extractCss, parseCss, parseHtml, points } from './htmlPdf.js';
import { styledResume } from './resumeTemplate.js';

/**
 * The resume as a .docx, drawn from the same page the PDF is drawn from.
 *
 * `styledResume` decides which page that is -- the template for a structured
 * payload, the markup as sent when it carries its own stylesheet -- and the
 * same CSS engine the PDF renderer uses reads it here: `parseHtml` for the
 * tree, `parseCss`/`computeStyle` for what applies to each node, `points` and
 * `colour` for the values. So a size, a colour or a background that changes in
 * the stylesheet changes in both documents at once, rather than in the PDF and
 * then, eventually, here.
 *
 * A .docx is a zip of XML parts, and a zip is a documented container format, so
 * this writes both by hand rather than taking on a dependency for it: Node
 * deflates, and the handful of headers below is the whole of what Word needs to
 * open the file.
 */

/* --- the zip container ------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * A zip of `{ name, data }` entries, deflated.
 *
 * Timestamps are left at the epoch the format starts from rather than the
 * moment of writing, so the same resume always produces the same bytes -- two
 * files that differ only in when they were made would otherwise look like two
 * different documents.
 */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // modified time
    local.writeUInt16LE(0x21, 12); // modified date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory header
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, directory, end]);
}

/* --- WordprocessingML ------------------------------------------------------- */

const xml = (value) =>
  String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Word measures spacing in twentieths of a point, and font size in halves. */
const twips = (pt) => Math.round((pt || 0) * 20);
const halfPoints = (pt) => Math.max(2, Math.round((pt || 0) * 2));
const hex = (rgb) => (rgb ? rgb.map((part) => part.toString(16).padStart(2, '0')).join('').toUpperCase() : null);

const DEFAULT_INK = '000000';

/**
 * One run of text.
 *
 * Line breaks inside the text are kept as breaks: a cover letter typed by hand
 * carries its shape in them, and a single <w:t> would run it all together.
 */
function run(text, { bold = false, italic = false, size = 10, color = DEFAULT_INK } = {}) {
  const properties =
    `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}` +
    `<w:color w:val="${color}"/><w:sz w:val="${halfPoints(size)}"/><w:szCs w:val="${halfPoints(size)}"/></w:rPr>`;
  const body = String(text ?? '')
    .split('\n')
    .map((line, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t>`)
    .join('');
  return `<w:r>${properties}${body}</w:r>`;
}

/**
 * One paragraph.
 *
 * `shading` fills it, and `borders` draws the rules a block carries -- the left
 * edge of the skills box, the line under a section heading -- as paragraph
 * borders, which is the nearest thing WordprocessingML has to a box drawn
 * around flowing text.
 */
function paragraph(runs, { before = 0, after = 60, indent = 0, hanging = 0, shading = null, borders = {}, rightTab = 0, align = null } = {}) {
  const parts = [];
  // A right-aligned tab stop, for text that sits hard against the right edge.
  if (rightTab) parts.push(`<w:tabs><w:tab w:val="right" w:pos="${rightTab}"/></w:tabs>`);
  if (align === 'center' || align === 'right' || align === 'justify') parts.push(`<w:jc w:val="${align}"/>`);
  parts.push(`<w:spacing w:before="${before}" w:after="${after}"/>`);
  if (indent || hanging) {
    parts.push(`<w:ind w:left="${indent}"${hanging ? ` w:hanging="${hanging}"` : ''}/>`);
  }
  if (shading) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>`);

  // The schema wants the sides in this order, whatever order they arrived in.
  const edges = ['top', 'left', 'bottom', 'right']
    .filter((side) => borders[side])
    .map((side) => [side, borders[side]]);
  if (edges.length) {
    const drawn = edges
      .map(([side, edge]) => {
        // Word counts border width in eighths of a point, and wants at least 2.
        const size = Math.max(2, Math.round(edge.width * 8));
        return `<w:${side} w:val="single" w:sz="${size}" w:space="${side === 'left' ? 4 : 1}" w:color="${edge.color}"/>`;
      })
      .join('');
    parts.push(`<w:pBdr>${drawn}</w:pBdr>`);
  }

  return `<w:p><w:pPr>${parts.join('')}</w:pPr>${runs.join('')}</w:p>`;
}

/* --- the styled page -------------------------------------------------------- */

/** First element with this tag, depth first. */
function findTag(node, tag) {
  if (node.tag === tag) return node;
  for (const child of node.children || []) {
    const found = findTag(child, tag);
    if (found) return found;
  }
  return null;
}

const BLOCK_TAGS = new Set([
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'hr',
  'section', 'article', 'header', 'footer', 'main', 'blockquote',
]);
const isBlock = (node) => node.tag !== '#text' && BLOCK_TAGS.has(node.tag);

/** A4 less the page margins set in buildDocx, in twips: where the right edge of the text is. */
const TEXT_WIDTH = 11906 - 2 * 1134;

/**
 * `display: grid; grid-template-columns: 1fr auto` over inline items, split
 * into the items of the 1fr column and the one in the auto column. The same
 * split applies to `display: flex; justify-content: space-between` over
 * inline items -- a job's location and its dates, say -- which resumes use
 * for exactly this "label left, value hard right" layout far more often than
 * grid. Null for anything else.
 */
function rightColumn(node, style) {
  const gridColumns = style.display === 'grid'
    ? String(style['grid-template-columns'] || '').trim().split(/\s+/)
    : null;
  const isGrid = gridColumns && gridColumns.length === 2 && gridColumns[1] === 'auto';
  const isFlexBetween = style.display === 'flex' && /\bspace-between\b/.test(style['justify-content'] || '');
  if (!isGrid && !isFlexBetween) return null;
  const items = (node.children || []).filter((child) => child.tag !== '#text' || child.text.trim());
  // Each item's own tag can be a block one -- a template's "degree"/"year"
  // row is as often two <div>s as two <span>s -- as long as what is inside
  // it is plain inline content runsOf() can read as one line. A block nested
  // inside an item is the real wall: that needs its own layout, which a
  // flattened run of text cannot give it.
  if (items.length < 2 || items.some((item) => (item.children || []).some(isBlock))) return null;
  return { left: items.slice(0, -1), right: items[items.length - 1] };
}

const isBold = (style) => Number(style['font-weight']) >= 600 || style['font-weight'] === 'bold';

/** "1px solid var(--rule)" -> { width, color } for a paragraph border. */
function edge(value, variables) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'none' || raw === '0') return null;
  const width = points((raw.match(/(-?[\d.]+(?:px|pt|mm|in)?)/) || [])[1], variables) || 1;
  const ink = colour((raw.match(/var\([^)]*\)|#[0-9a-f]{3,6}|rgba?\([^)]*\)/i) || [])[0], variables);
  return { width, color: hex(ink) || DEFAULT_INK };
}

/**
 * The page's blocks, each carrying the style that applies to it.
 *
 * A container's own fill and left edge are handed down to the paragraphs inside
 * it, since a paragraph is the only thing WordprocessingML lets us fill: the
 * skills box is drawn as its own lines, filled and edged, rather than as a box
 * around them. Padding becomes indentation for the same reason.
 */
function styledBlocks(html) {
  const tree = parseHtml(html);
  const sheet = parseCss(extractCss(html));
  const body = findTag(tree, 'body') || tree;
  const bodyStyle = computeStyle(body, [], sheet, {});
  const baseSize = points(bodyStyle['font-size'] || '12px', sheet.variables) || 12;
  const variables = sheet.variables;

  const sizeOf = (style) => points(style['font-size'] || `${baseSize}pt`, variables, baseSize) || baseSize;

  /** Flatten a node's inline descendants into runs carrying their own style. */
  const runsOf = (node, style, ancestors) => {
    const out = [];
    for (const child of node.children || []) {
      if (child.tag === '#text') {
        const text = style['text-transform'] === 'uppercase' ? child.text.toUpperCase() : child.text;
        if (text.trim()) {
          out.push(
            run(text.replace(/\s+/g, ' '), {
              bold: isBold(style),
              italic: style['font-style'] === 'italic',
              size: sizeOf(style),
              color: hex(colour(style.color, variables)) || DEFAULT_INK,
            }),
          );
        }
        continue;
      }
      if (isBlock(child)) continue; // handled as its own paragraph
      const childStyle = computeStyle(child, [...ancestors, node], sheet, style);
      out.push(...runsOf(child, childStyle, [...ancestors, node]));
    }
    return out;
  };

  /**
   * Flatten a rightColumn() item -- a grid/flex row's own direct item, which
   * rightColumn already confirmed holds no nested block -- into runs. Unlike
   * runsOf()'s own loop, this must not skip the item for being block-tagged
   * itself (a row's items are as often <div>s as <span>s): only its
   * descendants get that treatment, via the ordinary runsOf() recursion.
   */
  const flattenItems = (items, parentStyle, ancestors) => {
    const out = [];
    for (const item of items) {
      const itemStyle = computeStyle(item, ancestors, sheet, parentStyle);
      out.push(...runsOf(item, itemStyle, ancestors));
    }
    return out;
  };

  const blocks = [];

  // `lead` carries a container's own padding-top down to whichever of its
  // descendants draws first -- the only one it can actually show up in front
  // of, since nothing here gives an empty container a paragraph of its own to
  // carry spacing on. It is an object, not a plain number, so every recursive
  // call sees the same box: the first real block drawn anywhere under this
  // container consumes it (adds it to that block's own "before" and zeroes
  // it), and every sibling after that -- at any depth -- finds it already
  // spent, the same way CSS top margins/padding only ever show up once.
  const walk = (node, ancestors, inherited, inheritedFill, inheritedEdge, indent, lead = { value: 0 }) => {
    for (const child of node.children || []) {
      if (!isBlock(child)) continue;
      const style = computeStyle(child, [...ancestors, node], sheet, inherited);
      if (style.display === 'none') continue;

      const marginTop = points(style['margin-top'], variables, baseSize);
      const marginBottom = points(style['margin-bottom'], variables, baseSize);
      const paddingLeft = points(style['padding-left'], variables, baseSize);
      const paddingTop = points(style['padding-top'], variables, baseSize);
      const fill = hex(colour(style.background || style['background-color'], variables)) || inheritedFill;
      // A box's own left edge, or the one its container is drawing: like the
      // fill, it belongs to every line inside the box, since the lines are all
      // WordprocessingML gives us to draw it on.
      const left = edge(style['border-left'], variables) || inheritedEdge;
      const under = edge(style['border-bottom'], variables);
      // A non-<hr> element's own top border -- a decorative rule drawn as a
      // plain <div> rather than an <hr>, which resumes do for a two-tone rule
      // like a thick band over a thin bottom border, since <hr> only ever
      // draws the one line its own border-top gives it.
      const over = edge(style['border-top'], variables);
      const ownIndent = indent + twips(paddingLeft) + twips(points(style['margin-left'], variables, baseSize));

      if (child.tag === 'hr') {
        const before = twips(marginTop) + lead.value;
        lead.value = 0;
        blocks.push(
          paragraph([run(' ', { size: 2 })], {
            before,
            after: twips(marginBottom),
            borders: { bottom: edge(style['border-top'] || style.border, variables) || { width: 1, color: DEFAULT_INK } },
          }),
        );
        continue;
      }

      const children = child.children || [];
      // A grid/flex row is checked before the plain "has block children ->
      // recurse as a container" path below, because its own items are very
      // often block-tagged <div>s (a template's "degree"/"year" pair, say) --
      // rightColumn itself is what decides whether that still reads as one
      // row of flowing text rather than a container of separate blocks, not
      // whether the items happen to be <div> or <span>.
      const row = rightColumn(child, style);
      if (!row && children.some(isBlock)) {
        // A container: its own fill and edge pass down to what it holds. Its
        // own padding-top has nowhere to live but in front of whatever draws
        // first inside it, so it joins lead rather than being dropped here.
        lead.value += twips(paddingTop);
        walk(child, [...ancestors, node], style, fill, left, ownIndent, lead);
        continue;
      }

      const itemAncestors = [...ancestors, node, child];
      const inlineRuns = row
        ? [
            ...flattenItems(row.left, style, itemAncestors),
            '<w:r><w:tab/></w:r>',
            ...flattenItems([row.right], style, itemAncestors),
          ]
        : runsOf(child, style, [...ancestors, node]);
      // A border-only box -- a decorative rule drawn as an empty <div>, say --
      // has no text and no fill either, but still has to leave its mark.
      if (!inlineRuns.length && !fill && !left && !under && !over) continue;

      const bullet = child.tag === 'li';
      const before = twips(marginTop) + twips(paddingTop) + lead.value;
      lead.value = 0;
      blocks.push(
        paragraph(bullet ? [run('•  ', { size: sizeOf(style), color: hex(colour(style.color, variables)) || DEFAULT_INK }), ...inlineRuns] : inlineRuns, {
          before,
          after: twips(marginBottom),
          indent: bullet ? ownIndent + 280 : ownIndent,
          hanging: bullet ? 200 : 0,
          shading: fill,
          borders: { left, bottom: under, top: over },
          rightTab: row ? TEXT_WIDTH : 0,
          align: row ? null : style['text-align'],
        }),
      );
    }
  };

  walk(body, [], bodyStyle, null, null, 0);

  return {
    blocks,
    background: hex(colour(bodyStyle.background || bodyStyle['background-color'], variables)),
  };
}

/* --- markup with no stylesheet ---------------------------------------------- */

/**
 * What the generic PDF layout does, in the same sizes it uses (src/pdf.js), so
 * an unstyled resume reads the same in both files.
 */
const GENERIC = {
  h1: { size: 16, bold: true, before: 100, after: 50 },
  h2: { size: 13, bold: true, before: 90, after: 40 },
  h3: { size: 11, bold: true, before: 70, after: 30 },
  p: { size: 10, after: 48 },
  li: { size: 10, after: 28 },
  quote: { size: 10, italic: true, before: 40, after: 48 },
  pre: { size: 9, before: 40, after: 48 },
  hr: { size: 10, before: 60, after: 60 },
};

function genericBlocks(html) {
  const blocks = [];
  for (const block of htmlToBlocks(html)) {
    const style = GENERIC[block.type] || GENERIC.p;
    const indent = (block.indent || 0) * 280;
    if (block.type === 'hr') {
      blocks.push(
        paragraph([run(' ', { size: 2 })], {
          before: style.before,
          after: style.after,
          borders: { bottom: { width: 1, color: DEFAULT_INK } },
        }),
      );
      continue;
    }
    blocks.push(
      paragraph([run(block.text, { size: style.size, bold: style.bold, italic: style.italic })], {
        before: style.before || 0,
        after: style.after,
        indent,
      }),
    );
  }
  return blocks;
}

/* --- the file --------------------------------------------------------------- */

function buildDocx({ blocks, background }) {
  // A page colour only shows in Word when the document asks for it to be shown,
  // which lives in settings.xml -- so that part is written only when there is a
  // colour worth showing.
  const painted = background && background !== 'FFFFFF';

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    (painted ? `<w:background w:color="${background}"/>` : '') +
    `<w:body>${blocks.join('')}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' + // A4, as the PDF is
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
    '</w:body></w:document>';

  const settings =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:displayBackgroundShape/></w:settings>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    (painted
      ? '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
      : '') +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '</Relationships>';

  const parts = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ];
  if (painted) {
    parts.push({ name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') });
    parts.push({ name: 'word/settings.xml', data: Buffer.from(settings, 'utf8') });
  }

  return zip(parts);
}

/**
 * The resume as a .docx: the styled page when there is one -- which is the page
 * the PDF is rendered from -- and the generic layout otherwise.
 */
export function resumeDocx(input = {}) {
  const page = styledResume(input);
  return buildDocx(page ? styledBlocks(page) : { blocks: genericBlocks(input), background: null });
}
