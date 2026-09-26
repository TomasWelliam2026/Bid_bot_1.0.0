import { useEffect, useRef, useState } from 'react';
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
 * the first snapshot has arrived. `tabName` and `applicant` are the active
 * tab's own name and Profile (D) value, sent as Column C and D on every row
 * -- see lib/sheetSync.js's payloadFor.
 *
 * Whether a row has already been sent is *not* held here: it is `sent_status`
 * on the record itself, set by the server once `markSent` lands and carried
 * back on the stream. Only the browser can reach the Apps Script Web App, so
 * the browser sends; but the answer belongs to the archive, so every tab and
 * every later session agree on which rows have gone.
 */
export function useSheetSync(markSent, sheetSettings, tabName, applicant) {
  const settings = sheetSettings ?? EMPTY_SHEET;
  const [sending, setSending] = useState(() => new Set());
  const [errors, setErrors] = useState({}); // record id -> error text

  // The name of the send in progress for a record, kept until it is known to
  // have landed. A retry reuses it, so the script recognises the second
  // request as the same send and answers with the row it already wrote instead
  // of appending another.
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

  const dismissError = (id) =>
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const fail = (id, text) => setErrors((prev) => ({ ...prev, [id]: text }));

  const sendRow = async (record) => {
    dismissError(record.id);
    setSending((prev) => new Set(prev).add(record.id));

    let requestId = requestIds.current.get(record.id);
    if (!requestId) {
      requestId = newRequestId(record.id);
      requestIds.current.set(record.id, requestId);
    }

    const result = await sendToSheet(
      settings.webAppUrl,
      payloadFor(record, settings, tabName, applicant, new Date(), requestId),
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
    const saved = landed ? await markSent(record.id) : null;
    if (landed) requestIds.current.delete(record.id);

    setSending((prev) => {
      const next = new Set(prev);
      next.delete(record.id);
      return next;
    });

    if (!landed) fail(record.id, result.error);
    else if (saved?.error) fail(record.id, `sent, but the status was not saved — ${saved.error}`);
    return landed ? { ok: true, row: result.row } : result;
  };

  return { sending, errors, sendRow, dismissError, scriptStatus, webAppUrl: settings.webAppUrl };
}
