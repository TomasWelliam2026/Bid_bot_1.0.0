/**
 * A spreadsheet of applications -> the rows /save-data is called with.
 *
 * Columns are read by position, the way the sheet is laid out:
 *
 *   B  date        C  tab          E  company        F  position        G  job URL
 *
 * so A, D and anything past G are ignored. Column C is the same Category
 * column a sent row is written under -- it names the tab (country) the row
 * belongs to, the same as `region` in lib/sheetSync.js's payload. Nothing
 * here talks to the network -- it turns text into rows and says what it made
 * of them, and the component decides what to send.
 */

/** Zero-based column indexes for B, C, E, F and G. */
export const COLUMNS = { date: 1, tab: 2, company: 4, position: 5, url: 6 };

/** What each column is called on screen, in the order they are shown. */
export const FIELDS = [
  ['date', 'B', 'Date'],
  ['tab', 'C', 'Tab'],
  ['company', 'E', 'Company'],
  ['position', 'F', 'Position'],
  ['url', 'G', 'Job URL'],
];

/* --- the file ------------------------------------------------------------- */

const DELIMITERS = [',', ';', '\t'];

/**
 * Which character separates the fields. A sheet exported in a locale that uses
 * the comma as a decimal point is semicolon-separated, so the file is asked
 * rather than assumed: whichever candidate appears most on the first line wins.
 */
export function sniffDelimiter(text) {
  const firstLine = String(text).split('\n', 1)[0];
  let best = ',';
  let most = 0;
  for (const candidate of DELIMITERS) {
    const count = firstLine.split(candidate).length - 1;
    if (count > most) {
      most = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * Split CSV into rows of fields.
 *
 * Quoted fields are honoured, including the commas, newlines and doubled
 * quotes inside them -- a job title with a comma in it is common enough that
 * splitting on the delimiter alone would corrupt real files.
 */
export function parseCsv(text, delimiter) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const sep = delimiter || sniffDelimiter(source);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (source[at + 1] === '"') {
        field += '"'; // a doubled quote is one literal quote
        at += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    // A quote only opens a field; one in the middle of a value is just a quote.
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === sep) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);

  // A file ending in a newline leaves one empty row behind it.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/* --- dates ---------------------------------------------------------------- */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const iso = (year, month, day) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const realDate = (year, month, day) => {
  if (!(year >= 1000 && year <= 9999) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const made = new Date(year, month - 1, day);
  return made.getMonth() === month - 1 && made.getDate() === day ? iso(year, month, day) : null;
};

/**
 * Which way round a slashed date is written, decided across the whole file.
 *
 * `03/04/2026` alone is either the 3rd of April or the 4th of March. But a
 * sheet is written one way throughout, so one unambiguous row -- any date with
 * a part above 12 -- settles every other row in the file. Failing that it is
 * read month-first, which is what a sheet written in the US will be.
 */
export function sniffDayOrder(rows) {
  for (const cells of rows) {
    const parts = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(String(cells[COLUMNS.date] ?? '').trim());
    if (!parts) continue;
    if (Number(parts[1]) > 12) return 'day-first';
    if (Number(parts[2]) > 12) return 'month-first';
  }
  return 'month-first';
}

/**
 * One cell as `YYYY-MM-DD`, or null when it cannot be read. Null is not fatal:
 * the row still imports, the server just dates it today.
 */
export function readDate(value, order = 'month-first') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  // Year first: unambiguous however it is punctuated.
  const yearFirst = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  if (yearFirst) return realDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));

  const slashed = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(raw);
  if (slashed) {
    const [first, second] = [Number(slashed[1]), Number(slashed[2])];
    let year = Number(slashed[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    // One part above 12 can only be the day, whatever the rest of the file does.
    const dayFirst = first > 12 || (second <= 12 && order === 'day-first');
    return dayFirst ? realDate(year, second, first) : realDate(year, first, second);
  }

  // "14 Mar 2026", "Mar 14, 2026", "March 14 2026".
  const named = /^(?:(\d{1,2})\s+)?([a-z]{3,})\.?\s+(?:(\d{1,2})\s*,?\s+)?(\d{4})$/i.exec(raw);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    const day = Number(named[1] || named[3]);
    if (month && day) return realDate(Number(named[4]), month, day);
  }

  return null;
}

/* --- rows ----------------------------------------------------------------- */

/** Does the first row name the columns rather than carry data? */
export function looksLikeHeader(cells) {
  if (!cells) return false;
  const label = (index) => String(cells[index] ?? '').trim().toLowerCase();
  const hits = [
    /date|applied|day/.test(label(COLUMNS.date)),
    /tab|country|category/.test(label(COLUMNS.tab)),
    /company|employer|org/.test(label(COLUMNS.company)),
    /position|title|role|job/.test(label(COLUMNS.position)),
    /url|link|posting|site/.test(label(COLUMNS.url)),
  ].filter(Boolean).length;
  // Two labels agreeing is a header; one could be a company actually called Date.
  return hits >= 2;
}

/**
 * Read a whole file into rows ready to send.
 *
 * Every data row comes back, importable or not, so the preview can show what
 * was skipped and why rather than quietly dropping it.
 */
export function readRows(text) {
  const delimiter = sniffDelimiter(text);
  const table = parseCsv(text, delimiter);
  if (table.length === 0) return { rows: [], header: false, delimiter, order: 'month-first' };

  const header = looksLikeHeader(table[0]);
  const body = header ? table.slice(1) : table;
  const order = sniffDayOrder(body);

  const cell = (cells, index) => String(cells[index] ?? '').trim();

  const rows = body.map((cells, index) => {
    const company = cell(cells, COLUMNS.company);
    const position = cell(cells, COLUMNS.position);
    const dateText = cell(cells, COLUMNS.date);
    const date = readDate(dateText, order);
    return {
      // The line in the file, so a skipped row can be found in the spreadsheet.
      line: index + 1 + (header ? 1 : 0),
      dateText,
      date,
      tab: cell(cells, COLUMNS.tab),
      company,
      position,
      url: cell(cells, COLUMNS.url),
      skip: !company || !position ? (!company && !position ? 'no company or position' : !company ? 'no company' : 'no position') : null,
    };
  });

  return { rows, header, delimiter, order };
}

/** The /save-data payload for one row. */
export const payloadFor = (row) => ({
  company: row.company,
  job_title: row.position,
  job_url: row.url || '',
  ...(row.date ? { date: row.date } : {}),
});
