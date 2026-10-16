import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { API } from '../hooks/useArchive.js';
import { hintFor } from '../lib/sheetSyncHints.js';

// Kept in sync with the <th> list in the table below -- an error banner
// spans every column, so it needs to know how many there are.
const COLUMN_COUNT = 9;

// The .docx is written beside the resume PDF and deleted with it, but it is not
// offered here: the PDF is the copy to read, and a second link to the same
// document on every row is a column of noise.
const KINDS = [
  ['job_des', 'Description'],
  ['cover', 'Cover'],
  ['resume', 'Resume'],
];

const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

const hasFiles = (record) => KINDS.some(([kind]) => record[`${kind}_path`]);

// A resume and a cover letter are written for one profile -- its name, its
// experience -- so on a row shared in from another tab they are that tab's,
// and are not offered as this one's. The job description is the same posting
// whoever applies to it. Each by the short name the row shows and the long one
// its tooltip uses.
const PROFILE_KINDS = new Map([
  ['resume', ['resume', 'resume']],
  ['cover', ['cover', 'cover letter']],
]);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const NO_SHARED_TABS = new Map();

// Fewest rows a page is ever cut down to, however short the window is: below
// this the pager costs more room than the rows it pages through.
const MIN_PAGE_SIZE = 5;

/**
 * Where the reader was, kept across a reload: whether they were keeping up
 * with the newest rows, and if not, the first record on the page they chose.
 *
 * The record, not the page number. Rows per page follow the window height, so
 * "page 12" is a different set of rows after the window is resized, and a
 * deleted row earlier in the archive moves every later page. The page is
 * worked out from the record each time instead -- whichever page holds it
 * now. Per browser, which is what it is: one person's place in the list.
 */
const VIEW_KEY = 'jobsaver.applications.view';

function readView() {
  try {
    const view = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
    return view && typeof view === 'object' ? view : {};
  } catch {
    return {};
  }
}

function writeView(view) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Private window or storage switched off: the place is kept for this tab only.
  }
}

/**
 * How many rows fit between the top of the table and the bottom of the window.
 *
 * Read from the same custom properties the stylesheet sizes rows with, so the
 * two cannot drift, and from what is actually below the table in the panel --
 * the pager and the panel's own padding -- rather than a guessed constant.
 */
function rowsThatFit(wrap) {
  const panel = wrap.closest('.panel');
  if (!panel) return MIN_PAGE_SIZE;
  const root = getComputedStyle(document.documentElement);
  const rowHeight = parseFloat(root.getPropertyValue('--row-h')) || 52;
  const headHeight = parseFloat(root.getPropertyValue('--head-h')) || 33;

  const wrapBox = wrap.getBoundingClientRect();
  const inPanel = panel.getBoundingClientRect().bottom - wrapBox.bottom; // pager + padding
  // What the page keeps under the panel -- its own margin and the app's bottom
  // padding. Read, not assumed: guess low and the window grows a scrollbar for
  // the sake of a few pixels.
  const app = panel.closest('.app');
  const belowPanel =
    parseFloat(getComputedStyle(panel).marginBottom || 0) +
    (app ? parseFloat(getComputedStyle(app).paddingBottom || 0) : 0);

  const available = window.innerHeight - wrapBox.top - inPanel - belowPanel - headHeight;
  return Math.max(MIN_PAGE_SIZE, Math.floor(available / rowHeight));
}

/** Slots in the pager once there are more pages than fit as a plain row. */
const SLOTS = 7;

/**
 * Page numbers to offer: the ends, the current page and its neighbours, with
 * a gap marker standing in for the stretches left out.
 *
 * Always the same number of slots, so the pager is one width whichever page is
 * showing -- it used to be four entries at either end and seven in the middle,
 * and being right-aligned, every button moved under the pointer as the count
 * changed. Near an end the slots are filled with consecutive pages instead of
 * shrinking: 1 2 3 4 5 … 109, then 1 … 54 55 56 … 109, then 1 … 105 106 107 108 109.
 */
function pageList(current, total) {
  if (total <= SLOTS) return Array.from({ length: total }, (_, i) => i + 1);
  const run = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (current <= 4) return [...run(1, 5), 'gap-end', total];
  if (current >= total - 3) return [1, 'gap-start', ...run(total - 4, total)];
  return [1, 'gap-start', current - 1, current, current + 1, 'gap-end', total];
}

/**
 * Everything the database holds, oldest first: what was filed, and where.
 *
 * Paged over the whole archive, not a window onto the front of it: the server
 * sends every record, so the last page is the last record rather than the
 * two-hundredth. The panel keeps one height whatever a page holds, so turning
 * pages never moves anything under the pointer.
 *
 * Rows can be deleted one at a time or by the selection. Both go through the
 * same dialog, which asks the one question that matters: whether the PDFs on
 * disk go with the record. The record is a note; the PDF is the work, so
 * removing the files is never implied by removing the row.
 *
 * Rows filed under another tab with the same Country (C) and Role --
 * `sharedTabs`, by id -- are listed alongside the open tab's own (`ownerId`).
 * They can be sent to the sheet from here like any other row: a send writes
 * the open tab's Country (C) and Profile (D), whichever tab the row is filed
 * under. The Sheet column only ever speaks for the profile on screen, so a
 * shared row reads as sent once this tab has sent it -- its own tab's send
 * is that tab's, and shows there. Deleting one deletes only this tab's part of
 * it: it leaves this list and this tab's sheet status for it goes, while the
 * record, its files and its own tab's status stay. Its resume and cover letter
 * were written for its own tab's profile, so only its job description is
 * offered here -- see PROFILE_KINDS.
 */
export default function RecordsTable({
  records,
  ownerId,
  sharedTabs = NO_SHARED_TABS,
  connected,
  onDelete,
  sheetSending,
  sheetErrors,
  sheetWebAppUrl,
  onSendToSheet,
  onDismissSheetError,
}) {
  const [confirm, setConfirm] = useState(null); // { scope: 'one'|'selected', record?, ids? }
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  // Which rows are picked, by id. Kept as pages turn: choosing rows here and
  // more there, then deleting the lot, is the point of having a selection.
  const [selected, setSelected] = useState(() => new Set());
  // Whether to keep up with the newest rows. The archive reads oldest-first,
  // so the newest are on the last page: that is where a first visit opens, and
  // where it stays as records arrive. Turning to a page yourself is a
  // deliberate look at history, and is never yanked away by an arrival.
  // Both this and the place below come back from the last visit.
  const [following, setFollowing] = useState(() => readView().following !== false);
  // The first record on the page the reader chose, when not following.
  const [anchorId, setAnchorId] = useState(() => {
    const id = Number(readView().anchorId);
    return Number.isFinite(id) && id > 0 ? id : null;
  });

  useEffect(() => {
    writeView({ following, anchorId });
  }, [following, anchorId]);
  // A page is as many rows as the window has room for, so the panel ends near
  // the bottom of the screen with no dead space inside it. Measured rather
  // than assumed: the height above the table depends on whether the offline
  // banner is up, and on how the header wrapped.
  const [pageSize, setPageSize] = useState(10);
  const wrap = useRef(null);

  useLayoutEffect(() => {
    if (!wrap.current) return undefined;
    const measure = () => {
      if (wrap.current) setPageSize(rowsThatFit(wrap.current));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // Re-measured when the banner above appears or disappears, which is the
    // one thing that moves the table without resizing the window.
  }, [connected, records.length === 0]);

  // Another tab's row, listed here only because it shares this tab's Country (C)
  // and Role.
  const isShared = (record) => record.user_id !== ownerId;

  // The tab a shared row is filed under, by name.
  const tabNameOf = (record) => sharedTabs.get(record.user_id)?.name ?? 'its own tab';

  // A selection is made on one tab and belongs to it. Switching tabs drops it:
  // a row picked on its own tab is also listed on a tab sharing its country
  // and role, where deleting it means something else entirely.
  useEffect(() => setSelected(new Set()), [ownerId]);

  // A record deleted elsewhere is gone from this list, so it cannot stay
  // picked here -- otherwise the count would outlive the rows it counts.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const alive = new Set(records.map((record) => record.id));
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [records]);

  const pages = Math.max(1, Math.ceil(records.length / pageSize));

  // The page is not stored; it is whichever page holds the remembered record at
  // today's rows-per-page. Records are in id order, so a record that has since
  // been deleted resolves to the next one after it rather than losing the
  // place, and one past the end of the archive lands on the last page -- which
  // also covers deleting the last row of the last page. Until the archive has
  // arrived there is nothing to find, and the last page is as good as any.
  let page = pages;
  if (!following && anchorId !== null) {
    const index = records.findIndex((record) => record.id >= anchorId);
    if (index >= 0) page = Math.floor(index / pageSize) + 1;
  }

  const from = (page - 1) * pageSize;
  const visible = records.slice(from, from + pageSize);

  const show = (next) => {
    setFollowing(next === pages);
    setAnchorId(records[(next - 1) * pageSize]?.id ?? null);
  };

  /* --- the selection ------------------------------------------------------ */

  const pickedOnPage = visible.filter((record) => selected.has(record.id)).length;
  const wholePagePicked = visible.length > 0 && pickedOnPage === visible.length;

  const togglePage = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const record of visible) {
        if (wholePagePicked) next.delete(record.id);
        else next.add(record.id);
      }
      return next;
    });
  };

  const toggleRow = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* --- deleting ----------------------------------------------------------- */

  const ask = (next) => {
    setConfirm(next);
    setWithFiles(false);
    setNote(null);
  };

  // Escape closes the dialog, the way every other dialog on the page does --
  // but not while the delete it asked about is running.
  useEffect(() => {
    if (!confirm) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) setConfirm(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirm, busy]);

  // Every delete says which tab it is made on. The server deletes a record
  // filed under this tab, and for one shared in from another tab deletes only
  // this tab's part of it -- answering with `hidden` instead of `ids`.
  const run = async () => {
    setBusy(true);

    let result;
    if (confirm.scope === 'one') {
      result = await onDelete(confirm.record.id, withFiles, ownerId);
    } else {
      // A hand-picked set is neither one row nor the whole log, which is all
      // the API deletes, so it goes one at a time -- stopping at the first
      // refusal rather than carrying on past it, and still reporting what went.
      const ids = [];
      const hidden = [];
      let filesRemoved = 0;
      for (const id of confirm.ids) {
        const step = await onDelete(id, withFiles, ownerId);
        if (step && step.error) {
          result = { error: step.error, ids, hidden, filesRemoved };
          break;
        }
        if (step.hidden?.length) hidden.push(...step.hidden);
        else ids.push(...(step.ids || [id]));
        filesRemoved += step.filesRemoved || 0;
      }
      result = result || { ids, hidden, filesRemoved };
    }

    setBusy(false);
    setConfirm(null);

    const deleted = result.ids || [];
    const removed = result.hidden || [];
    const gone = [...deleted, ...removed];
    if (gone.length) {
      setSelected((current) => {
        const next = new Set(current);
        for (const id of gone) next.delete(id);
        return next;
      });
    }

    if (result.error) {
      setNote({
        tone: 'bad',
        text:
          `Delete failed — ${result.error}` +
          (gone.length ? ` (${plural(gone.length, 'row')} went before it stopped)` : ''),
      });
      return;
    }

    const deletedText =
      `Deleted ${plural(deleted.length, 'record')}` +
      (result.filesRemoved ? ` and ${plural(result.filesRemoved, 'file')}` : '');
    const removedText = `${plural(removed.length, 'shared row')} from this tab — still on ${
      removed.length === 1 ? 'its own tab' : 'their own tabs'
    }`;
    setNote({
      tone: 'ok',
      text: !removed.length
        ? deletedText
        : deleted.length
          ? `${deletedText}; removed ${removedText}`
          : `Removed ${removedText}`,
    });
  };

  // What the dialog is about, in the two shapes it takes.
  const inScope =
    confirm?.scope === 'selected'
      ? records.filter((record) => confirm.ids.includes(record.id))
      : confirm
        ? [confirm.record]
        : [];
  // A shared row's files are its own tab's, and never go from here: the file
  // question is only about this tab's own records, and only asked when one of
  // them actually has something on disk.
  const ownInScope = inScope.filter((record) => !isShared(record));
  const sharedInScope = inScope.filter(isShared);
  const filesInScope = ownInScope.some(hasFiles);

  const marked = (record) =>
    confirm?.record?.id === record.id || (confirm?.scope === 'selected' && confirm.ids.includes(record.id));

  const sharedCount = records.filter(isShared).length;
  const sharedNames = [...sharedTabs.values()].map((user) => user.name).join(', ');

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Applications</h2>
        <div className="head-actions">
          {selected.size > 0 ? (
            <>
              <span className="tile-detail">{selected.size} selected</span>
              <button className="btn" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button
                className="btn danger"
                onClick={() => ask({ scope: 'selected', ids: [...selected] })}
              >
                Delete selected
              </button>
            </>
          ) : (
            <span
              className="tile-detail"
              title={
                sharedCount
                  ? `Also listed: ${sharedNames}'s applications — the same Country (C) and Role. Sending one from here writes this tab's Country (C) and Profile (D).`
                  : undefined
              }
            >
              {records.length - sharedCount} total
              {sharedCount ? ` · ${sharedCount} from ${sharedNames}` : null}
            </span>
          )}
        </div>
      </div>

      {note ? <div className={`note ${note.tone === 'bad' ? 'critical' : 'good'}`}>{note.text}</div> : null}

      {records.length === 0 ? (
        <div className="empty">
          {connected ? (
            <>
              Nothing filed yet. POST a payload to <code>/save-data</code> and it appears here.
            </>
          ) : (
            // An empty archive and an unreachable one are different facts, and
            // only one of them is the server's answer.
            <>
              Waiting for the backend. This is not an empty archive — no answer has arrived yet.
            </>
          )}
        </div>
      ) : (
        <div className="table-wrap" ref={wrap} style={{ '--rows': pageSize }}>
          <table>
            <thead>
              <tr>
                <th scope="col" className="col-pick">
                  {/* One click takes the whole page, and takes it back. Half
                      ticked when only some of the page is picked. */}
                  <input
                    type="checkbox"
                    checked={wholePagePicked}
                    ref={(node) => {
                      if (node) node.indeterminate = pickedOnPage > 0 && !wholePagePicked;
                    }}
                    onChange={togglePage}
                    title={
                      wholePagePicked
                        ? `Deselect the ${plural(visible.length, 'row')} on this page`
                        : `Select the ${plural(visible.length, 'row')} on this page`
                    }
                    aria-label={`Select all ${visible.length} rows on this page`}
                  />
                </th>
                <th scope="col" className="col-sheet">Sheet</th>
                <th scope="col">#</th>
                <th scope="col">Received</th>
                <th scope="col">Company</th>
                <th scope="col">Job title</th>
                <th scope="col">Documents</th>
                <th scope="col">Stored in</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {visible.map((record) => {
                // In flight and failed are this tab's, by record id -- see
                // useSheetSync -- so a send from another tab never shows here.
                const isSending = sheetSending.has(record.id);
                // A same-country, same-role tab's row: sent, picked and deleted
                // from here like any other, but what a send writes and what a
                // delete takes are this tab's -- see run() and useSheetSync.
                const shared = isShared(record);
                const owner = shared ? sharedTabs.get(record.user_id) : null;
                const ownerName = tabNameOf(record);
                // The archive's own answer, for this tab's profile only: every
                // record arrives unsent and stays that way until a send to the
                // sheet comes back OK. A row's own tab's send is the record's
                // `sent_status`; any other tab's is its entry in `sheet_sends`.
                const isSent = shared
                  ? (record.sheet_sends ?? []).some((send) => send.user_id === ownerId)
                  : record.sent_status === 'sent';
                const sheetError = sheetErrors[record.id];
                // The documents on disk, less -- on a shared row -- the ones
                // written for its own tab's profile, which are named instead.
                const filed = KINDS.filter(([kind]) => record[`${kind}_path`]);
                const docs = shared ? filed.filter(([kind]) => !PROFILE_KINDS.has(kind)) : filed;
                const otherProfileDocs = shared
                  ? [...PROFILE_KINDS].filter(([kind]) => record[`${kind}_path`]).map(([, names]) => names)
                  : [];
                const picked = selected.has(record.id);
                const rowClass = [
                  marked(record) ? 'row-marked' : '',
                  picked ? 'row-picked' : '',
                  shared ? 'row-shared' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <Fragment key={record.id}>
                    <tr className={rowClass || undefined}>
                      <td className="col-pick">
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={() => toggleRow(record.id)}
                          aria-label={`Select record ${record.id}, ${record.company}`}
                        />
                      </td>
                      <td className="col-sheet">
                        <button
                          className={isSent ? 'icon-btn sheet sent' : 'icon-btn sheet'}
                          disabled={isSending || !sheetWebAppUrl}
                          title={
                            !sheetWebAppUrl
                              ? 'Set the Apps Script Web App URL in Sheet sync above first'
                              : (isSent ? 'Sent — click to send again' : `Send #${record.id} to the sheet`) +
                                (shared
                                  ? ` with this tab's Country (C) and Profile (D) — ${ownerName}'s own send is separate`
                                  : '')
                          }
                          aria-label={
                            isSent
                              ? `Sent record ${record.id}, ${record.company}, to the sheet — send again`
                              : `Send record ${record.id}, ${record.company}, to the sheet`
                          }
                          onClick={() => onSendToSheet(record)}
                        >
                          {isSending ? '…' : isSent ? '✓' : '⇪'}
                        </button>
                      </td>
                      <td className="num">{record.id}</td>
                      <td className="nowrap">{when(record.created_at)}</td>
                      <td>{record.company}</td>
                      <td>
                        {record.job_url ? (
                          <a href={record.job_url} target="_blank" rel="noreferrer">
                            {record.job_title}
                          </a>
                        ) : (
                          record.job_title
                        )}
                        <div className="sub">
                          {record.mode === 'auto' ? 'automatic' : 'human check'}
                          {shared ? (
                            <span
                              className="tag muted shared-from"
                              title={
                                `Filed under ${ownerName}` +
                                (owner?.sheet?.applicant ? `, Profile (D) ${owner.sheet.applicant}` : '') +
                                ` — the same Country (C) and Role as this tab, so it is listed here. Sending it from here writes this tab's Country (C) and Profile (D).`
                              }
                            >
                              {ownerName}
                            </span>
                          ) : null}
                        </div>
                        {record.error ? <div className="sub bad">{record.error}</div> : null}
                      </td>
                      <td className="nowrap">
                        {docs.map(([kind, label]) => (
                          <a
                            key={kind}
                            className="doc"
                            href={`${API}/api/records/${record.id}/file/${kind}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {label}
                          </a>
                        ))}
                        {otherProfileDocs.length ? (
                          <span
                            className="sub"
                            title={
                              `The ${otherProfileDocs.map(([, long]) => long).join(' and ')} ` +
                              `${otherProfileDocs.length === 1 ? 'was' : 'were'} written for ${ownerName}'s ` +
                              `profile, so ${otherProfileDocs.length === 1 ? 'it is' : 'they are'} not this ` +
                              `tab's. Open ${otherProfileDocs.length === 1 ? 'it' : 'them'} from ${ownerName}.`
                            }
                          >
                            {ownerName}'s {otherProfileDocs.map(([short]) => short).join(' & ')}
                          </span>
                        ) : null}
                        {docs.length || otherProfileDocs.length ? null : <span className="sub">—</span>}
                      </td>
                      <td className="path" title={record.dir_path || ''}>
                        {record.dir_path || ''}
                      </td>
                      <td className="col-action">
                        <button
                          className="icon-btn"
                          title={
                            shared
                              ? `Remove #${record.id} from this tab — it stays on ${ownerName}`
                              : `Delete record #${record.id}`
                          }
                          aria-label={
                            shared
                              ? `Remove record ${record.id}, ${record.company}, from this tab`
                              : `Delete record ${record.id}, ${record.company}`
                          }
                          onClick={() => ask({ scope: 'one', record })}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                    {sheetError ? (
                      <tr className="sheet-error-row">
                        <td colSpan={COLUMN_COUNT}>
                          <div className="sheet-error-box" role="alert">
                            <div className="sheet-error-body">
                              <div className="sheet-error-reason">
                                Couldn't send #{record.id} to the sheet — <span className="mono">{sheetError}</span>
                              </div>
                              <div className="sheet-error-fix">{hintFor(sheetError)}</div>
                            </div>
                            <div className="sheet-error-actions">
                              <button className="btn" onClick={() => onSendToSheet(record)}>
                                Retry
                              </button>
                              <button
                                className="icon-btn"
                                title="Dismiss"
                                aria-label="Dismiss this error"
                                onClick={() => onDismissSheetError(record.id)}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {records.length > pageSize ? (
        <div className="pager">
          <span className="tile-detail">
            {from + 1}–{Math.min(from + pageSize, records.length)} of {records.length}
            {following ? ' · newest' : null}
          </span>
          {/* Every number is as wide as the largest, so 9 and 109 take the same
              room and the row keeps its width as the pages turn. */}
          <div className="pager-pages" style={{ '--page-digits': String(pages).length }}>
            <button className="page" disabled={page === 1} onClick={() => show(page - 1)}>
              Prev
            </button>
            {pageList(page, pages).map((entry) =>
              typeof entry === 'number' ? (
                <button
                  key={entry}
                  className={entry === page ? 'page num on' : 'page num'}
                  aria-current={entry === page ? 'page' : undefined}
                  onClick={() => show(entry)}
                >
                  {entry}
                </button>
              ) : (
                // A gap takes a whole slot, the same size as a number: with one
                // gap at an end and two in the middle, a narrower gap would
                // still let the row change width.
                <span key={entry} className="page num gap" aria-hidden="true">
                  …
                </span>
              ),
            )}
            <button className="page" disabled={page === pages} onClick={() => show(page + 1)}>
              Next
            </button>
          </div>
        </div>
      ) : null}

      {/* Deleting is the one thing here that cannot be undone, so it is asked
          in a dialog over the page rather than a strip beside the table: it
          takes the focus, and nothing else can be clicked until it is answered. */}
      {confirm ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setConfirm(null);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <h3 className="modal-title" id="delete-title">
              {confirm.scope === 'selected'
                ? `Delete ${plural(confirm.ids.length, 'selected row')}?`
                : ownInScope.length
                  ? 'Delete this record?'
                  : 'Remove this row from this tab?'}
            </h3>

            <div className="modal-body">
              {confirm.scope === 'one' ? (
                <p className="modal-line">
                  <strong>#{confirm.record.id}</strong> {confirm.record.company} —{' '}
                  {confirm.record.job_title}
                </p>
              ) : (
                <ul className="modal-list">
                  {inScope.slice(0, 5).map((record) => (
                    <li key={record.id}>
                      <strong>#{record.id}</strong> {record.company} — {record.job_title}
                      {isShared(record) ? <span className="sub"> · {tabNameOf(record)}'s</span> : null}
                    </li>
                  ))}
                  {inScope.length > 5 ? <li className="sub">…and {inScope.length - 5} more</li> : null}
                </ul>
              )}

              {/* What deleting means for a row shared in from another tab: only
                  this tab's part of it goes. */}
              {sharedInScope.length ? (
                <p className="modal-note">
                  {confirm.scope === 'one'
                    ? `This is ${tabNameOf(confirm.record)}'s application. Only this tab's part of it goes: it leaves this list, and this tab's sheet status for it is cleared. It stays on ${tabNameOf(confirm.record)} with its files and sheet status.`
                    : `${sharedInScope.length} of these ${sharedInScope.length === 1 ? 'is' : 'are'} shared from another tab. For those, only this tab's part goes — they leave this list and this tab's sheet status for them is cleared — and they stay on their own tab with their files.`}
                </p>
              ) : null}

              {!ownInScope.length ? null : filesInScope ? (
                <label className="with-files">
                  <input
                    type="checkbox"
                    checked={withFiles}
                    onChange={(event) => setWithFiles(event.target.checked)}
                  />
                  also delete the stored PDF files{sharedInScope.length ? ' of this tab’s own records' : ''}
                </label>
              ) : (
                <p className="sub">Nothing is on disk for this.</p>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn" disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn danger solid" disabled={busy} autoFocus onClick={run}>
                {busy
                  ? 'Deleting…'
                  : withFiles
                    ? 'Delete with files'
                    : ownInScope.length
                      ? 'Delete'
                      : 'Remove from this tab'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
