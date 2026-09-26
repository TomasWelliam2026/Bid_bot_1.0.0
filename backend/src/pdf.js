import fs from 'node:fs';
import { jsPDF } from 'jspdf';
import { config } from './config.js';
import { htmlToBlocks } from './html.js';

/** A4 portrait in millimetres, with a margin that leaves a 174mm text column. */
const MARGIN = 18;
const PT_TO_MM = 25.4 / 72;

/** Per-block type: font size in points, weight, and the space around it in mm. */
const STYLE = {
  h1: { size: 16, style: 'bold', before: 5, after: 2.5, lead: 1.25 },
  h2: { size: 13, style: 'bold', before: 4.5, after: 2, lead: 1.25 },
  h3: { size: 11, style: 'bold', before: 3.5, after: 1.5, lead: 1.25 },
  p: { size: 10, style: 'normal', before: 0, after: 2.4, lead: 1.4 },
  li: { size: 10, style: 'normal', before: 0, after: 1.4, lead: 1.4 },
  quote: { size: 10, style: 'italic', before: 2, after: 2.4, lead: 1.4 },
  pre: { size: 9, style: 'normal', before: 2, after: 2.4, lead: 1.35, mono: true },
  hr: { size: 10, style: 'normal', before: 3, after: 3, lead: 1 },
};

const lineHeight = (size, lead) => size * PT_TO_MM * lead;

/* --- text encoding ---------------------------------------------------------

   The built-in PDF fonts are single-byte (WinAnsi). Hand jsPDF a character
   outside that range and it re-encodes the whole string as UTF-16, which the
   standard fonts then render as noise -- so by default anything unencodable is
   folded down to its closest Latin-1 form here.

   Set PDF_FONT to a .ttf to keep the original characters instead: the font is
   embedded and subset into each document, which is what a CJK job description
   needs. */

/** Characters WinAnsi lacks, mapped to something readable. */
const FOLD = new Map(Object.entries({
  '‑': '-', '‒': '-', '―': '-', '−': '-',
  '●': '-', '○': '-', '▪': '-', '■': '-', '◦': '-',
  '⁃': '-', '∙': '-', '·': '-', '✔': 'v', '✓': 'v',
  '→': '->', '←': '<-', '⇒': '=>',
  '′': "'", '″': '"', '⁄': '/',
  '​': '', '‌': '', '‍': '', '﻿': '', '­': '',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
}));

/** Highest code point WinAnsiEncoding can carry directly. */
const isEncodable = (code) => code <= 0xff || WINANSI_HIGH.has(code);

/** The WinAnsi slots above Latin-1 that jsPDF maps for the standard fonts. */
const WINANSI_HIGH = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/**
 * Fold one string into what the standard fonts can draw. Returns the text and
 * how many characters had to be replaced, so the caller can say so out loud
 * rather than shipping a PDF full of silent question marks.
 */
export function toWinAnsi(text) {
  let out = '';
  let lost = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (isEncodable(code)) {
      out += char;
      continue;
    }
    const folded = FOLD.get(char);
    if (folded !== undefined) {
      out += folded;
      continue;
    }
    // Accented letters outside Latin-1 usually survive as their base letter.
    const stripped = char.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (stripped && [...stripped].every((c) => isEncodable(c.codePointAt(0)))) {
      out += stripped;
      continue;
    }
    out += '?';
    lost += 1;
  }
  return { text: out, lost };
}

/* --- optional embedded font ------------------------------------------------ */

let embedded;

/** Read the configured TTF once; a missing file is a warning, not a crash. */
function customFont() {
  if (embedded !== undefined) return embedded;
  embedded = null;
  if (!config.pdfFont) return embedded;
  try {
    const faces = { normal: config.pdfFont, bold: config.pdfFontBold || config.pdfFont };
    embedded = {
      family: 'app',
      files: Object.entries(faces).map(([style, file]) => ({
        style,
        vfs: `app-${style}.ttf`,
        base64: fs.readFileSync(file).toString('base64'),
      })),
    };
    console.log(`[pdf] embedding ${config.pdfFont}${config.pdfFontBold ? ' (+bold)' : ''}`);
  } catch (error) {
    console.error(`[pdf] PDF_FONT could not be read (${error.message}) — falling back to Helvetica`);
    embedded = null;
  }
  return embedded;
}

/**
 * Register the configured font on a document, if there is one. Returns the
 * family to draw with and which weights it actually has.
 */
export function applyFont(doc) {
  const font = customFont();
  if (!font) return { family: 'helvetica', styles: null };
  for (const face of font.files) {
    doc.addFileToVFS(face.vfs, face.base64);
    doc.addFont(face.vfs, font.family, face.style);
  }
  return { family: font.family, styles: new Set(font.files.map((face) => face.style)) };
}

/**
 * Fold text for whatever font is in play: nothing to do when a Unicode face is
 * embedded, otherwise down to what the built-in fonts can draw.
 */
export function encodeFor(value) {
  return customFont() ? { text: String(value), lost: 0 } : toWinAnsi(value);
}

/**
 * Render blocks into a fresh A4 document.
 *
 * The constructor options are the ones the project standardised on: portrait,
 * millimetres, A4, compressed.
 */
export function renderPdf({ title, subtitle, url, blocks }) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const font = customFont();
  let family = 'helvetica';
  if (font) {
    for (const face of font.files) {
      doc.addFileToVFS(face.vfs, face.base64);
      doc.addFont(face.vfs, font.family, face.style);
    }
    family = font.family;
  }

  // With a Unicode font embedded there is nothing to fold.
  let lost = 0;
  const encode = (text) => {
    if (font) return String(text);
    const result = toWinAnsi(text);
    lost += result.lost;
    return result.text;
  };

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const right = pageWidth - MARGIN;
  const bottom = pageHeight - MARGIN;
  let y = MARGIN;

  doc.setProperties({
    title: [title, subtitle].filter(Boolean).join(' - '),
    subject: subtitle || '',
    keywords: url || '',
    creator: 'jobsaver',
  });

  /** Start a new page when the next line would cross the bottom margin. */
  const need = (height) => {
    if (y + height <= bottom) return;
    doc.addPage();
    y = MARGIN;
  };

  /** An embedded face may only exist in one weight; fall back to it. */
  const useFont = (style, mono) => {
    if (mono && !font) return doc.setFont('courier', style === 'italic' ? 'normal' : style);
    if (!font) return doc.setFont('helvetica', style);
    const has = font.files.some((face) => face.style === style);
    return doc.setFont(family, has ? style : 'normal');
  };

  const write = (text, style, indent = 0) => {
    useFont(style.style, style.mono);
    doc.setFontSize(style.size);

    const left = MARGIN + indent * 5;
    const width = right - left;
    const lh = lineHeight(style.size, style.lead);
    const body = encode(text);

    // Wrapped lines of a list item hang under the text, not under the marker.
    const marker = /^(•|-|\d+\.)\s/.exec(body);
    const hang = marker ? doc.getTextWidth(marker[0]) : 0;

    for (const paragraph of body.split('\n')) {
      const lines = doc.splitTextToSize(paragraph, width - hang);
      if (!lines.length) {
        y += lh;
        continue;
      }
      lines.forEach((line, index) => {
        need(lh);
        doc.text(line, index === 0 ? left : left + hang, y + lh * 0.78);
        y += lh;
      });
    }
  };

  const heading = (text, size, style, colour) => {
    useFont(style);
    doc.setFontSize(size);
    if (colour) doc.setTextColor(...colour);
    const lh = lineHeight(size, 1.25);
    for (const line of doc.splitTextToSize(encode(text), right - MARGIN)) {
      need(lh);
      doc.text(line, MARGIN, y + lh * 0.78);
      y += lh;
    }
    doc.setTextColor(0);
  };

  // Title block: what the document is, and where the posting came from.
  if (title) heading(title, 18, 'bold');
  if (subtitle) heading(subtitle, 10.5, 'normal', [90, 90, 90]);
  if (url) {
    useFont('normal');
    doc.setFontSize(9);
    doc.setTextColor(40, 90, 190);
    const lh = lineHeight(9, 1.3);
    need(lh);
    doc.textWithLink(encode('Job URL'), MARGIN, y + lh * 0.78, { url });
    y += lh;
    doc.setTextColor(0);
  }
  if (title || subtitle || url) {
    y += 2;
    need(0.1);
    doc.setDrawColor(200);
    doc.line(MARGIN, y, right, y);
    y += 4;
  }

  for (const block of blocks) {
    const style = STYLE[block.type] || STYLE.p;
    y += style.before;
    if (block.type === 'hr') {
      need(1);
      doc.setDrawColor(210);
      doc.line(MARGIN, y, right, y);
      y += style.after;
      continue;
    }
    write(block.text, style, block.indent || 0);
    y += style.after;
  }

  // Page numbers last, once the total is known.
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    useFont('normal');
    doc.setFontSize(8);
    doc.setTextColor(140);
    doc.text(`${page} / ${pages}`, right, pageHeight - 10, { align: 'right' });
  }
  doc.setTextColor(0);

  return { pdf: Buffer.from(doc.output('arraybuffer')), pages, lost };
}

/** HTML in, PDF bytes out. */
export function htmlToPdf(html, meta = {}) {
  return renderPdf({ ...meta, blocks: htmlToBlocks(html) });
}
