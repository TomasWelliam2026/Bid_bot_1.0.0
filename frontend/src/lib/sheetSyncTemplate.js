/**
 * A ready-to-paste copy of `sheet-sync.gs`, with the sheet tab name and
 * shared secret already filled in from Sheet sync's own settings.
 *
 * A browser has no way to script Google's own Apps Script editor or its
 * deployment flow -- there's no public API a plain page can call for that
 * without a full OAuth setup. What this can do instead is remove the one
 * step that's actually error-prone by hand: getting SHEET_NAME and
 * SHARED_SECRET right. Everything after "Change these two" here is kept
 * byte-for-byte identical to the repo's `sheet-sync.gs` -- if that file's
 * logic changes, this template needs the same change made to it.
 */

const BODY = `function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // serialize concurrent clicks so no two rows race for the same day boundary
  try {
    return respond(handle(e));
  } catch (error) {
    return respond({ ok: false, error: String(error && error.message || error) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Visiting the /exec URL in a browser confirms the deployment, not just a 404.
 *
 * It also answers the one question a caller cannot answer for itself: whether
 * a request it never got a reply to actually wrote its row. An Apps Script
 * reply is fetched from a single-use URL, and anything that re-fetches it --
 * a proxy retrying an idempotent GET, most of all -- gets a 404 while the row
 * sits happily in the sheet. "?check=<requestId>&secret=..." says which it
 * was, and asking twice is harmless.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (!params.check) {
    return respond({ ok: false, error: 'POST only — this endpoint takes a job application row, not a page load.', version: SCRIPT_VERSION });
  }
  if (params.secret !== SHARED_SECRET) {
    return respond({ ok: false, error: 'forbidden — secret does not match' });
  }
  const seen = CacheService.getScriptCache().get('req:' + params.check);
  const answer = { ok: true, written: Boolean(seen), version: SCRIPT_VERSION };
  if (seen) {
    const before = JSON.parse(seen);
    answer.row = before.row;
    answer.count = before.count;
  }
  return respond(answer);
}

function handle(e) {
  const body = JSON.parse((e.postData && e.postData.contents) || '{}');

  if (body.secret !== SHARED_SECRET) {
    return { ok: false, error: 'forbidden — secret does not match' };
  }

  // The tab comes with the request, so the dashboard can point rows at any tab
  // in the spreadsheet without the script being redeployed; SHEET_NAME is the
  // tab used when a request does not name one.
  const sheetName = String(body.sheetTab || '').trim() || SHEET_NAME;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { ok: false, error: 'No sheet tab named "' + sheetName + '"' };

  // { secret, test: true } exercises the secret and the sheet lookup above
  // without writing anything -- a way to check a deployment (with curl, or
  // the browser console) without leaving a fake row behind.
  if (body.test) {
    return { ok: true, test: true };
  }

  // A request that has been seen before wrote its row already: say so again
  // rather than writing another. "requestId" is the dashboard's per-send id,
  // kept the same across its retries.
  const cache = CacheService.getScriptCache();
  const requestKey = body.requestId ? 'req:' + String(body.requestId).slice(0, 200) : null;
  if (requestKey) {
    const seen = cache.get(requestKey);
    if (seen) return JSON.parse(seen);
  }

  const company = String(body.company || '').trim();
  const position = String(body.position || '').trim();
  if (!company || !position) {
    return { ok: false, error: 'company and position are required' };
  }

  const date = body.date ? new Date(body.date) : new Date();
  const lastRow = sheet.getLastRow();
  const hasData = lastRow >= START_ROW;

  // A day-boundary rule below the last row of the previous date, purely from
  // comparing dates -- column A carries no counter to key this off of.
  let newDay = !hasData;
  if (hasData) {
    const prevDate = sheet.getRange(lastRow, COLS.DATE).getValue();
    newDay = !sameDay(prevDate, date);
  }

  // max(), not lastRow + 1, so an empty sheet (lastRow 0) or a header-only one
  // never gets written into above START_ROW.
  const row = Math.max(lastRow, START_ROW - 1) + 1;
  const range = sheet.getRange(row, 1, 1, NUM_COLS);

  // Carry over the previous row's look (the Category/Profile chip formatting,
  // the status dropdown) rather than reconstructing formatting and data
  // validation by hand -- a new row should look like the ones above it.
  if (hasData) {
    sheet.getRange(lastRow, 1, 1, NUM_COLS).copyTo(range, { formatOnly: true });
  }

  // Column A counts the applications made that day, so it starts again at 1 on
  // every new date -- the same thing the thick rule below marks. Within a day
  // it is one more than the row above, read from the sheet rather than derived
  // from the row number, so it stays right on a sheet whose data does not start
  // where this script thinks it does; anything blank or not a number above it
  // (an empty column A, a stray label) starts the count over rather than
  // poisoning it with NaN.
  const previousCount = hasData ? Number(sheet.getRange(lastRow, COLS.COUNT).getValue()) : 0;
  const count = newDay || !(Number.isFinite(previousCount) && previousCount > 0) ? 1 : previousCount + 1;

  sheet.getRange(row, COLS.COUNT).setValue(count);
  sheet.getRange(row, COLS.DATE).setValue(date);
  sheet.getRange(row, COLS.REGION).setValue(body.region || DEFAULT_CATEGORY);
  sheet.getRange(row, COLS.APPLICANT).setValue(body.applicant || DEFAULT_PROFILE);
  sheet.getRange(row, COLS.COMPANY).setValue(company);
  sheet.getRange(row, COLS.POSITION).setValue(position);
  sheet.getRange(row, COLS.URL).setValue(body.jobUrl || '');
  sheet.getRange(row, COLS.STATUS).setValue('applied');

  // A thick rule over the first row of each new date, matching how the sheet is
  // already divided by hand -- and over that row only. The format copy above
  // brings the row above's borders along with everything else, so without this
  // the rule on a day's first row would be copied onto its second, and from
  // there onto every row after it. So each row sets its own top edge: thick
  // when it starts a date, none when it continues one.
  if (hasData) {
    if (newDay) {
      range.setBorder(true, null, null, null, null, null, 'black', SpreadsheetApp.BorderStyle.SOLID_THICK);
    } else {
      range.setBorder(false, null, null, null, null, null);
    }
  }

  const result = { ok: true, row: row, count: count, version: SCRIPT_VERSION };
  if (requestKey) {
    // Remember what this request wrote, so the same request arriving again --
    // a retry after an answer went missing on the way back -- is told what
    // happened instead of appending a second copy of the row.
    cache.put(requestKey, JSON.stringify(result), REQUEST_MEMORY_SECONDS);
  }
  return result;
}

function sameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function respond(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
`;

/** Turns text into a single-quoted Apps Script string literal. */
function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function buildScript({ sheetTabName, secret, category, profile }) {
  const header = `/**
 * Receiving end of the dashboard's "Send to sheet" button.
 *
 * Generated by the dashboard's Generate script button from the Sheet sync
 * settings -- paste it into Extensions ▸ Apps Script (from inside the
 * target spreadsheet, so it's bound to it and
 * SpreadsheetApp.getActiveSpreadsheet() needs no ID), then Deploy ▸ New
 * deployment ▸ Web app (execute as "Me", access "Anyone").
 */

const SHEET_NAME = ${quote(sheetTabName || 'Sheet1')};
const SHARED_SECRET = ${quote(secret || '')};

// Written to column C (Category) and column D (Profile) whenever a request does
// not carry its own: the values in the dashboard when this was generated.
const DEFAULT_CATEGORY = ${quote(category ?? 'US')};
const DEFAULT_PROFILE = ${quote(profile ?? '')};

// Row 1 is the header (column A is a running count -- Date, Category, Profile,
// Company, Position, Job URL, Status from B); data starts here.
const START_ROW = 2;
const COLS = { COUNT: 1, DATE: 2, REGION: 3, APPLICANT: 4, COMPANY: 5, POSITION: 6, URL: 7, STATUS: 8 };
const NUM_COLS = 8;

// How long a sent row is remembered by its request id, for answering "did that
// one land?". Six hours, the longest the cache keeps anything.
const REQUEST_MEMORY_SECONDS = 21600;

// Raised whenever this script changes, and reported with every answer, so the
// dashboard can tell a deployment still running an older copy -- the usual
// reason column A stays empty after this file was updated.
const SCRIPT_VERSION = 6;

`;
  return header + BODY;
}
