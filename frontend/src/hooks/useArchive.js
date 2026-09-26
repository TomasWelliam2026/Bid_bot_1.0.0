import { useCallback, useEffect, useState } from 'react';

/* eslint-disable no-undef -- __API_ORIGIN__ is injected by vite.config.js */

/**
 * Where the API is, decided in the browser rather than at build time.
 *
 * A page opened from another machine calls the API on the host it was served
 * from: that address is known to work -- it is how the page itself arrived --
 * so the dashboard keeps working if this machine's address changes, and never
 * depends on the name meaning the same thing at both ends.
 *
 * Loopback is the exception. The baked-in address is used there instead of
 * 127.0.0.1, so a dashboard opened on this machine talks to the same backend
 * as everyone else's, and so a proxy or VPN client that treats the two
 * differently cannot put this browser on a different footing from the rest.
 */
const LOOPBACK = /^(localhost$|127\.|\[?::1\]?$)/i;
const API_PORT = 4500;

/**
 * The API is called on the host the page came from -- loopback included.
 *
 * Whatever route brought the page here works, by definition, so the API is
 * asked for on the same one. That matters most under a proxy switched on in
 * the browser (LumiProxy and the like): such a proxy sits out on the internet
 * with no route back to this network, but leaves loopback alone, so a page
 * opened at localhost can only reach an API asked for at localhost. Mixing the
 * two -- page on loopback, API on the LAN address -- is the one combination
 * that fails under a proxy while looking correct in the source.
 *
 * A page opened straight off the disk (`file://`) has no host to follow, so
 * that falls back to the address baked in at build time.
 */
function apiOrigin() {
  if (typeof window === 'undefined') return __API_ORIGIN__ || '';
  const { protocol, hostname } = window.location;
  const servedOverHttp = protocol === 'http:' || protocol === 'https:';
  if (!servedOverHttp || !hostname) return __API_ORIGIN__ || '';
  return `${protocol}//${hostname}:${API_PORT}`;
}

export const API = import.meta.env.VITE_API_URL || apiOrigin();

const EMPTY = {
  dataRoot: '',
  counts: { total: 0 },
  users: [],
  records: [],
  // Sheet-sync's Web App URL, Sheet URL and sheet tab name -- one setting for
  // the whole archive, not per tab. `secret` rides along so payloadFor and
  // the script generator have it, but nothing here ever edits it.
  sheetSettings: { webAppUrl: '', sheetUrl: '', sheetTabName: '', secret: '' },
};

/**
 * Oldest first, replacing an entry that is already on screen.
 *
 * The same order the server sends its snapshot in, and the order the table
 * reads in: the archive runs down the page the way the spreadsheet it came
 * from does, with whatever just arrived at the end. Generic over anything
 * with an `id` -- used for both records and users, which both stream in the
 * same shape (a full replace on `snapshot`, one entry at a time after).
 */
function upsert(list, entry) {
  const rest = list.filter((existing) => existing.id !== entry.id);
  return [...rest, entry].sort((a, b) => a.id - b.id);
}

async function request(method, path, body) {
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok ? data : { ...data, error: data.error || `HTTP ${response.status}` };
  } catch (error) {
    return { error: error.message };
  }
}

const post = (path, body) => request('POST', path, body);

/**
 * Live view of the archive.
 *
 * The server pushes over Server-Sent Events: it opens the stream with a
 * snapshot and then sends one message per record as it lands, so the table is
 * current without polling. EventSource reconnects on its own, and each
 * reconnection replays a fresh snapshot — so a dropped backend heals without a
 * page reload.
 */
export function useArchive() {
  const [state, setState] = useState(EMPTY);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const stream = new EventSource(`${API}/api/stream`);

    stream.addEventListener('snapshot', (event) => {
      setState({ ...EMPTY, ...JSON.parse(event.data) });
      setConnected(true);
    });
    stream.addEventListener('record', (event) => {
      const { record, counts } = JSON.parse(event.data);
      setState((previous) => ({ ...previous, counts, records: upsert(previous.records, record) }));
    });
    stream.addEventListener('removed', (event) => {
      const { ids, counts } = JSON.parse(event.data);
      const gone = new Set(ids);
      setState((previous) => ({
        ...previous,
        counts,
        records: previous.records.filter((record) => !gone.has(record.id)),
      }));
    });
    // A tab's settings (Automatic/Human-check, Sheet sync) changing -- from
    // this browser or another one. Without this, two open dashboards would
    // disagree about a tab until one of them happened to refetch, the same
    // problem `record`/`removed` already solve for the archive itself.
    stream.addEventListener('user', (event) => {
      const { user } = JSON.parse(event.data);
      setState((previous) => ({ ...previous, users: upsert(previous.users, user) }));
    });
    // A tab deleted -- from this browser or another one.
    stream.addEventListener('user_removed', (event) => {
      const { id } = JSON.parse(event.data);
      setState((previous) => ({ ...previous, users: previous.users.filter((user) => user.id !== id) }));
    });
    // Sheet-sync's shared settings changing -- from this browser, on any tab's
    // panel, or another one. Every tab shows the same values, so this is one
    // event for the whole archive rather than something carried on `user`.
    stream.addEventListener('sheet_settings', (event) => {
      const { sheetSettings } = JSON.parse(event.data);
      setState((previous) => ({ ...previous, sheetSettings }));
    });

    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);

    return () => stream.close();
  }, []);

  // Each action returns the server's answer; the state itself arrives on the
  // stream, so two open tabs never disagree about what was approved.

  // A submission exactly like a live POST to /save-data would send -- used by
  // the CSV importer, which has nothing else to call.
  const save = useCallback((payload) => post('/save-data', payload), []);

  const approve = useCallback((id) => post(`/api/records/${id}/approve`), []);
  const reject = useCallback((id) => post(`/api/records/${id}/reject`), []);

  // Tabs. `createUser` names a new one; `updateUser` covers renaming it,
  // flipping its Automatic/Human-check preference, and saving its Profile (D)
  // value -- all of it is just columns on the same row, so one PATCH covers
  // whichever of them a caller is changing. `deleteUser` only succeeds once
  // the server finds nothing left attributed to it.
  const createUser = useCallback((name) => post('/api/users', { name }), []);
  const updateUser = useCallback((id, patch) => request('PATCH', `/api/users/${id}`, patch), []);
  const deleteUser = useCallback((id) => request('DELETE', `/api/users/${id}`), []);

  // Sheet-sync's Web App URL, Sheet URL and sheet tab name -- shared by every
  // tab, so this is one PATCH to the archive rather than to any particular one.
  const updateSheetSettings = useCallback((patch) => request('PATCH', '/api/sheet-settings', patch), []);

  // Record that a row reached the Google Sheet. The browser does the sending;
  // this is what makes the result outlive the tab that did it.
  const markSent = useCallback((id, sent = true) => post(`/api/records/${id}/sent`, { sent }), []);

  // `withFiles` decides whether the stored PDFs go with the record. The row
  // disappears when the server confirms it on the stream, not before.
  const remove = useCallback(
    (id, withFiles) => request('DELETE', `/api/records/${id}?files=${withFiles ? 1 : 0}`),
    [],
  );

  return {
    ...state,
    connected,
    save,
    approve,
    reject,
    markSent,
    remove,
    createUser,
    updateUser,
    deleteUser,
    updateSheetSettings,
  };
}
