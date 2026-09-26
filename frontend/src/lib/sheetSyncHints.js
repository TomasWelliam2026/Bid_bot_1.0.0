/**
 * Turns one of sheet-sync's own error strings into what to do about it.
 *
 * These are exact matches, not a guess at some third-party API's wording --
 * every message here is produced by sendToSheet() (src/lib/sheetSync.js) or
 * by sheet-sync.gs, both written for this project, so the fix for each one is
 * known ahead of time.
 */
const RULES = [
  [
    /status was not saved/i,
    'The row is in the sheet, but this server never recorded it, so the button still says Unsent. Check the backend is running — and note that clicking Send again appends a second row to the sheet.',
  ],
  [
    /no web app url configured/i,
    'Open Sheet sync above and paste the Apps Script Web App URL (it ends in /exec).',
  ],
  [
    /forbidden.*secret/i,
    "The Shared secret here doesn't match SHARED_SECRET at the top of sheet-sync.gs — copy the same value into both, then redeploy the script.",
  ],
  [
    /no sheet tab named/i,
    'Check the Sheet tab field in Sheet sync against the tab name shown at the bottom of the spreadsheet — it has to match exactly, spaces and capitals included.',
  ],
  [
    /company and position are required/i,
    'This record has no company or job title, so there was nothing to send.',
  ],
  [
    /http 401|http 403/i,
    'The deployment rejected the request. In the Apps Script editor: Deploy ▸ Manage deployments ▸ Edit, and set "Who has access" to Anyone.',
  ],
  [
    /http 404/i,
    "Two things give a 404 here. If no row appeared in the sheet, that URL doesn't point to a live Web App: redeploy (Deploy ▸ New deployment ▸ Web app) and paste the new /exec URL here — a URL from a previous deployment stops working once you deploy again. If the row *did* appear, the reply was fetched twice instead of once — usually a proxy retrying it — and the second fetch of a single-use address is a 404. Retry is safe either way: the script recognises the repeat and will not add the row twice.",
  ],
  [
    /^http \d+/i,
    'The deployment returned an error. Open the Apps Script editor ▸ Executions (left sidebar) to see what failed.',
  ],
  [
    /unexpected response/i,
    'The reply wasn\'t the JSON the script returns — likely the wrong URL, or a deployment still asking for sign-in. Confirm access is set to "Anyone", not "Anyone with a Google account", and re-copy the /exec URL after redeploying.',
  ],
  [
    /failed to fetch|fetch failed|networkerror|load failed/i,
    'The browser never got a usable response. Almost always: the deployment\'s "Who has access" is set to "Only myself" (Google\'s default for a new deployment) — an anonymous request gets redirected to a sign-in page the browser then blocks. Fix: Deploy ▸ Manage deployments ▸ ✏️ ▸ "Who has access": Anyone ▸ Deploy. Also check the Apps Script Web App URL in Sheet sync ends in /exec, not /dev, and isn\'t blank or stale. If none of that is it, then check this device\'s network connection.',
  ],
];

const FALLBACK = 'Check the Web App URL is correct and the script is deployed with access set to Anyone.';

export function hintFor(message) {
  const text = String(message || '');
  const rule = RULES.find(([pattern]) => pattern.test(text));
  return rule ? rule[1] : FALLBACK;
}
