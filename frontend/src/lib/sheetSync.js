/**
 * One row of application data, sent to a Google Apps Script Web App bound to
 * a tracking spreadsheet.
 *
 * The request uses `text/plain` for its Content-Type rather than
 * `application/json`. An Apps Script Web App doesn't implement `doOptions`,
 * so a JSON content type would make the browser send a CORS preflight first
 * and the deployment has nothing to answer it with -- the request never gets
 * past that. `text/plain` is a "simple request" and skips the preflight; the
 * script still reads the body as JSON regardless of what the header says.
 */
export async function sendToSheet(webAppUrl, payload) {
  const url = String(webAppUrl || '').trim();
  if (!url) return { ok: false, error: 'No Web App URL configured' };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { ok: false, error: error.message || 'Network error' };
  }

  const text = await response.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // A deployment that isn't the JSON endpoint expected (a redirect to a
    // Google sign-in page, for one) still returns 200 with HTML in it.
  }

  if (!response.ok) return { ok: false, error: (data && data.error) || `HTTP ${response.status}` };
  if (data && data.ok === false) return { ok: false, error: data.error || 'The sheet rejected the row' };
  if (!data) return { ok: false, error: 'Unexpected response — check the Web App URL and its deployment' };
  return { ok: true, row: data.row, version: data.version || 0 };
}

/**
 * The script version this dashboard is written against. Kept equal to
 * SCRIPT_VERSION in sheet-sync.gs: a deployment reporting less (or nothing --
 * copies from before versions existed) is running old code, and old code does
 * not fill column A.
 */
export const EXPECTED_SCRIPT_VERSION = 6;

/**
 * Which version of the script the Web App URL is actually running.
 *
 * Apps Script keeps a deployment pinned to the version it was created with:
 * pasting new code and editing the deployment changes nothing unless "New
 * version" is picked, so the repo and the sheet can disagree with no sign of
 * it. A plain GET answers with the version and writes nothing. Returns 0 for a
 * script too old to report one, null when the question could not be asked.
 */
export async function probeScript(webAppUrl) {
  const url = String(webAppUrl || '').trim();
  if (!url) return null;
  try {
    const data = await (await fetch(url)).json();
    return Number(data && data.version) || 0;
  } catch {
    return null;
  }
}

/**
 * A record from the archive, shaped the way sendToSheet's payload expects.
 *
 * The date is when the row is sent, not when the record was filed. The sheet
 * is appended to and read top to bottom, and it rules off a line whenever the
 * date changes: a record from three weeks ago, sent today, carries today's
 * date, so the sheet stays in the order it was written and one old row does
 * not open a spurious day-boundary in the middle of it.
 *
 * Sent as an instant rather than a calendar day, because the script writes it
 * with `new Date(...)`: a bare `YYYY-MM-DD` would be read as UTC midnight and
 * could land on the day before in a timezone behind it.
 */
export function payloadFor(record, sheetSettings, country, applicant, sentAt = new Date(), requestId = '') {
  return {
    secret: sheetSettings.secret,
    // Names this send, so a retry of it can be recognised as the same send
    // rather than a second one. See confirmSend below.
    requestId,
    // Which worksheet tab the row goes to -- shared by every archive tab now,
    // not chosen per one. The script writes wherever this says, so changing
    // it needs no redeploy.
    sheetTab: String(sheetSettings.sheetTabName || '').trim(),
    date: sentAt.toISOString(),
    company: record.company,
    position: record.job_title,
    jobUrl: record.job_url || '',
    // Column C (Category) -- the tab's own Country (C), set separately from
    // its name. Blank leaves the script's own default in its place.
    region: country,
    // Column D (Profile) -- each tab's own value too, unlike the rest of
    // sheetSettings above.
    applicant,
  };
}

/** A name for one send, kept across its retries. */
export function newRequestId(recordId) {
  const random = Math.random().toString(36).slice(2, 10);
  return `r${recordId}-${Date.now().toString(36)}-${random}`;
}

/**
 * Did that send land, despite the error?
 *
 * An Apps Script reply is not returned by the /exec URL itself: that answers a
 * redirect to a single-use address on googleusercontent, and the reply is
 * fetched from there. Anything that fetches it twice -- a proxy retrying an
 * idempotent GET, above all -- gets `404` on the second go, so the caller sees
 * a failure for a row that is sitting in the sheet. Clicking Retry then files
 * a duplicate.
 *
 * The script remembers what each requestId wrote, so this asks. A few attempts,
 * because the same lost-answer problem can swallow this request too, and asking
 * again is harmless: it writes nothing.
 */
export async function confirmSend(webAppUrl, secret, requestId, attempts = 3) {
  const url = String(webAppUrl || '').trim();
  if (!url || !requestId) return { written: false };

  const query =
    `${url}${url.includes('?') ? '&' : '?'}check=${encodeURIComponent(requestId)}` +
    `&secret=${encodeURIComponent(secret || '')}`;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(query);
      const data = await response.json().catch(() => null);
      if (data && data.ok === true) return { written: Boolean(data.written), row: data.row };
    } catch {
      // Network error on the way to an answer that is only advisory.
    }
    await new Promise((wake) => setTimeout(wake, 400 * (attempt + 1)));
  }
  return { written: false };
}
