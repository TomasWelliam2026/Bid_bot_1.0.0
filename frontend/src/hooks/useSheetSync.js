import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EXPECTED_SCRIPT_VERSION,
  confirmSend,
  newRequestId,
  payloadFor,
  probeScript,
  sendToSheet,
} from '../lib/sheetSync.js';

const EMPTY_SHEET = { webAppUrl: '', sheetUrl: '', sheetTabName: '', secret: '' };

/**
 * Sending a record to the Google Sheet: which one is in flight, and why one
 * failed -- for the manual "Send to sheet" button.
 *
 * `sheetSettings` is the Web App URL / Sheet URL / Sheet tab name / secret
 * shared by every tab now (`useArchive`'s own `sheetSettings`, not a
 * per-tab thing) -- falls back to blank fields rather than throwing before
 * the first snapshot has arrived. `userId`, `country` and `applicant` are the
 * active tab's id and its own Country (C) and Profile (D) values, sent as
 * Column C and D on every row -- see lib/sheetSync.js's payloadFor -- whether
 * the row is filed under that tab or shared into it from another.
 *
 * Whether a row has already been sent is *not* held here: it is on the record
 * itself, set by the server once `markSent` lands and carried back on the
 * stream -- `sent_status` for the tab it is filed under, `sheet_sends` for
 * every other tab that has sent it. Only the browser can reach the Apps Script
 * Web App, so the browser sends; but the answer belongs to the archive, so
 * every tab and every later session agree on which rows have gone.
 *
 * A send is one tab's, so what is in flight and what failed are kept per tab
 * and record: the same record sent from two tabs is two sends, and one's
 * error never shows against the other. `sending` and `errors` are the active
 * tab's, by record id.
 */
export function useSheetSync(markSent, sheetSettings, userId, country, applicant) {
  const settings = sheetSettings ?? EMPTY_SHEET;
  const keyOf = (recordId, tab = userId) => `${tab}:${recordId}`;
  const [sendingKeys, setSendingKeys] = useState(() => new Set());
  const [errorsByKey, setErrorsByKey] = useState({}); // tab:record -> error text

  // The name of the send in progress for a record from a tab, kept until it is
  // known to have landed. A retry reuses it, so the script recognises the
  // second request as the same send and answers with the row it already wrote
  // instead of appending another. Per tab as well: another tab's send of the
  // same record writes its own row, and must not be answered with this one's.
  const requestIds = useRef(new Map());

  // Which version of the script the deployment runs: null until known, then
  // the number it reports (0 for a copy too old to report one). Asked once per
  // Web App URL, and corrected by every send's own answer.
  const [scriptVersion, setScriptVersion] = useState(null);
  useEffect(() => {
    let current = true;
    setScriptVersion(null);
    probeScript(settings.webAppUrl).then((version) => {
      if (current) setScriptVersion(version);
    });
    return () => {
      current = false;
    };
  }, [settings.webAppUrl]);

  const scriptStatus =
    scriptVersion === null
      ? { state: 'unknown' }
      : scriptVersion >= EXPECTED_SCRIPT_VERSION
        ? { state: 'current', version: scriptVersion }
        : { state: 'outdated', version: scriptVersion };

  const prefix = `${userId}:`;
  const sending = useMemo(
    () => new Set([...sendingKeys].filter((key) => key.startsWith(prefix)).map((key) => Number(key.slice(prefix.length)))),
    [sendingKeys, prefix],
  );
  const errors = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(errorsByKey)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, text]) => [key.slice(prefix.length), text]),
      ),
    [errorsByKey, prefix],
  );

  const clearError = (key) =>
    setErrorsByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const dismissError = (id) => clearError(keyOf(id));

  const fail = (key, text) => setErrorsByKey((prev) => ({ ...prev, [key]: text }));

  const sendRow = async (record) => {
    // Everything below belongs to the tab the click was made on, even if
    // another tab is open by the time the answer comes back.
    const tab = userId;
    const key = keyOf(record.id, tab);
    clearError(key);
    setSendingKeys((prev) => new Set(prev).add(key));

    let requestId = requestIds.current.get(key);
    if (!requestId) {
      requestId = newRequestId(record.id);
      requestIds.current.set(key, requestId);
    }

    const result = await sendToSheet(
      settings.webAppUrl,
      payloadFor(record, settings, country, applicant, new Date(), requestId),
    );

    // An error here does not mean the row is not in the sheet: the reply is
    // fetched from a single-use address, and losing it is not the same as the
    // script not having run. Ask before believing the failure.
    let landed = result.ok;
    if (result.ok) setScriptVersion(result.version);
    if (!result.ok) {
      const confirmed = await confirmSend(settings.webAppUrl, settings.secret, requestId);
      landed = confirmed.written;
    }

    // The status only flips once the archive has it, so the button never
    // claims "Sent" on the strength of something this tab alone remembers.
    const saved = landed ? await markSent(record.id, true, tab) : null;
    if (landed) requestIds.current.delete(key);

    setSendingKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

    if (!landed) fail(key, result.error);
    else if (saved?.error) fail(key, `sent, but the status was not saved — ${saved.error}`);
    return landed ? { ok: true, row: result.row } : result;
  };

  return { sending, errors, sendRow, dismissError, scriptStatus, webAppUrl: settings.webAppUrl };
}
