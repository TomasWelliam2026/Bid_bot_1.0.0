import { useEffect, useMemo, useRef, useState } from 'react';
import CsvImport from './components/CsvImport.jsx';
import RecordsTable from './components/RecordsTable.jsx';
import ReviewQueue from './components/ReviewQueue.jsx';
import SheetSettings from './components/SheetSettings.jsx';
import TabTrend from './components/TabTrend.jsx';
import UserTabs from './components/UserTabs.jsx';
import { API, useArchive } from './hooks/useArchive.js';
import { useActiveUser } from './hooks/useActiveUser.js';
import { useSheetSync } from './hooks/useSheetSync.js';

export default function App() {
  const {
    dataRoot,
    users,
    records,
    sheetSettings,
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
  } = useArchive();

  const [activeId, setActiveId, activeUser] = useActiveUser(users);

  // Everything below the tab strip is scoped to whichever tab is open --
  // the tiles, the review queue, the table. `activeId` is only ever `null`
  // when no tab exists at all, so there is nothing yet to show.
  const visibleRecords = useMemo(
    () => (activeId == null ? [] : records.filter((record) => record.user_id === activeId)),
    [records, activeId],
  );
  const pending = visibleRecords.filter((record) => record.status === 'pending');
  const tileCounts = useMemo(() => {
    const counts = { total: 0, pending: 0, saved: 0, rejected: 0, failed: 0 };
    for (const record of visibleRecords) {
      counts.total += 1;
      if (record.status in counts) counts[record.status] += 1;
    }
    return counts;
  }, [visibleRecords]);

  // Unfiltered, so a tab you are not currently looking at can still show a
  // pending count on its own button -- without this, a submission waiting on
  // another tab would be invisible until you happened to switch to it, which
  // the single global queue this replaces never did.
  const pendingByUser = useMemo(() => {
    const counts = {};
    for (const record of records) {
      if (record.status !== 'pending' || record.user_id == null) continue;
      counts[record.user_id] = (counts[record.user_id] || 0) + 1;
    }
    return counts;
  }, [records]);

  // Owns "sent to sheet" for the whole app -- the manual button in
  // RecordsTable is the only thing that sends a row. Where each row stands is
  // on the record itself; this only carries the send in flight and its error.
  // `sheetSettings` is shared by every tab; `tabName` and Profile (D) are the
  // active one's own, for Column C and D on the row.
  const sheetSync = useSheetSync(markSent, sheetSettings, activeUser?.name ?? '', activeUser?.sheet?.applicant ?? '');

  // Which floating panel is on screen, if any. Escape closes it, and so does a
  // click anywhere outside the toolbar -- the way a menu behaves, so it never
  // has to be dismissed by hunting for the ✕.
  const [panel, setPanel] = useState(null); // 'sheet' | 'csv' | null
  const tools = useRef(null);

  // Switching tabs closes Sheet sync rather than silently re-pointing it at
  // the newly active tab out from under a half-typed edit -- a fresh,
  // deliberate re-open always shows the right tab's own settings.
  useEffect(() => setPanel(null), [activeId]);

  useEffect(() => {
    if (!panel) return undefined;

    // A panel hangs off the right of its icon, which is fine until the header
    // wraps and puts that icon near the left -- then a 720px panel would open
    // off the side of the window. Measure once it is up and slide it back on.
    const nudgeIntoView = () => {
      const node = tools.current?.querySelector('.popover:not([hidden])');
      if (!node) return;
      node.style.transform = '';
      const box = node.getBoundingClientRect();
      const edge = 12;
      const shift =
        box.left < edge
          ? edge - box.left
          : box.right > window.innerWidth - edge
            ? window.innerWidth - edge - box.right
            : 0;
      if (shift) node.style.transform = `translateX(${Math.round(shift)}px)`;
    };
    nudgeIntoView();
    window.addEventListener('resize', nudgeIntoView);

    const onKey = (event) => {
      if (event.key === 'Escape') setPanel(null);
    };
    const onDown = (event) => {
      if (!tools.current?.contains(event.target)) setPanel(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('resize', nudgeIntoView);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [panel]);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Job archive</h1>
          <p className="sub">
            Submissions posted to <code>/save-data</code>, rendered to PDF and filed under{' '}
            <span className="mono">{dataRoot || 'the data root'}</span>
            <span className="mono">/{'{date}/{company}'}</span>.
          </p>
        </div>
        <div className="header-actions">
          {/* Which backend, not just whether it answers: the API is reached at
              a fixed network address, so a dashboard opened on the wrong
              machine or pointed at a stale build is a real way to see nothing
              at all. The address is in the tooltip, and on screen when the
              stream is down. */}
          <span className="chip" title={`API: ${API || 'same origin'}`}>
            <span className="dot" style={{ background: connected ? 'var(--good)' : 'var(--bad)' }} />
            {connected ? 'Live' : 'Reconnecting'}
          </span>

          {/* Whose applications are on screen -- replaces the old global
              Automatic/Human-check switch, which is now each tab's own
              setting (see Sheet sync below). */}
          <UserTabs
            users={users}
            activeId={activeId}
            onSelect={setActiveId}
            onCreate={createUser}
            pendingByUser={pendingByUser}
          />

          {/* Two panels that are opened, used and dismissed: an icon each, and
              the panel itself floats over the page rather than holding a
              screenful of it open all day. Both stay mounted behind their
              icon, so a half-filled form or a running import survives being
              closed. */}
          <div className="tools" ref={tools}>
            <button
              className={panel === 'sheet' ? 'icon-tool on' : 'icon-tool'}
              aria-haspopup="dialog"
              aria-expanded={panel === 'sheet'}
              title={activeUser ? `Sheet sync settings — ${activeUser.name}` : 'Select a tab to edit its settings'}
              aria-label="Sheet sync settings"
              disabled={!activeUser}
              onClick={() => setPanel((open) => (open === 'sheet' ? null : 'sheet'))}
            >
              ⚙
              {/* Nothing sends to the sheet until this is set up, which is
                  worth saying without opening the panel to find out. */}
              {activeUser && (!sheetSync.webAppUrl || sheetSync.scriptStatus.state === 'outdated') ? (
                <span className="tool-dot" />
              ) : null}
            </button>
            <button
              className={panel === 'csv' ? 'icon-tool on' : 'icon-tool'}
              aria-haspopup="dialog"
              aria-expanded={panel === 'csv'}
              title="Import from CSV"
              aria-label="Import from CSV"
              onClick={() => setPanel((open) => (open === 'csv' ? null : 'csv'))}
            >
              ⤓
            </button>

            <div className="popover sheet" role="dialog" aria-label="Sheet sync" hidden={panel !== 'sheet'}>
              {activeUser ? (
                <SheetSettings
                  activeUser={activeUser}
                  sheetSettings={sheetSettings}
                  onUpdate={updateUser}
                  onUpdateSheetSettings={updateSheetSettings}
                  onDelete={deleteUser}
                  onClose={() => setPanel(null)}
                  scriptStatus={sheetSync.scriptStatus}
                />
              ) : null}
            </div>
            <div className="popover csv" role="dialog" aria-label="Import from CSV" hidden={panel !== 'csv'}>
              <CsvImport
                auto={activeUser ? activeUser.auto : false}
                userName={activeUser?.name ?? ''}
                onSave={save}
                onClose={() => setPanel(null)}
              />
            </div>
          </div>
        </div>
      </header>

      {/* An unreachable backend used to look exactly like an empty archive:
          zeroes in the tiles, "nothing filed yet" under them, and every status
          column blank -- all of it indistinguishable from a server that simply
          had nothing to say. Say which it is. */}
      {connected ? null : (
        <div className="note critical offline" role="alert">
          <strong>Not connected to the backend.</strong> Nothing below is current — the counts, the
          statuses and the table are all empty because no answer has arrived, not because the
          archive is empty.
          <div className="sub">
            Trying <span className="mono">{API || 'this page’s own origin'}</span>. Check the server
            is running (<span className="mono">npm start</span> in <span className="mono">backend/</span>),
            and that this machine can reach it — port 4500 has to be open on the firewall for any
            computer other than the one it runs on.
            {/* The one cause that leaves no trace anywhere else: the request
                never reaches the network this page is on. */}
            <br />
            If a proxy or VPN extension is switched on in this browser (LumiProxy and the like),
            add <span className="mono">172.20.*</span> to its bypass list — a proxy out on the
            internet has no route to an address on this network, and the page loading from that
            same address is not proof it is exempt.
          </div>
        </div>
      )}

      {/* This tab's own numbers on the left, how every tab has grown over
          time on the right -- one row, the two sides pinned to the same
          height (see .overview-row), so the four tiles stretch to fill
          whatever height the chart on the right settles on rather than
          leaving a gap under a shorter stack. */}
      <div className="overview-row">
        <div className="tiles">
          <div className="panel tile">
            <div className="tile-text">
              <div className="tile-label">Applications</div>
              <div className="tile-detail">in this tab</div>
            </div>
            <div className="tile-value">{tileCounts.total || 0}</div>
          </div>
          <div className="panel tile">
            <div className="tile-text">
              <div className="tile-label">Filed</div>
              <div className="tile-detail">PDFs written to disk</div>
            </div>
            <div className="tile-value good">{tileCounts.saved || 0}</div>
          </div>
          <div className="panel tile">
            <div className="tile-text">
              <div className="tile-label">Waiting</div>
              <div className="tile-detail">{activeUser?.auto ? 'automatic mode is on' : 'awaiting your review'}</div>
            </div>
            <div className={pending.length ? 'tile-value warn' : 'tile-value'}>{tileCounts.pending || 0}</div>
          </div>
          <div className="panel tile">
            <div className="tile-text">
              <div className="tile-label">Rejected / failed</div>
              <div className="tile-detail">nothing filed</div>
            </div>
            <div className="tile-value">{(tileCounts.rejected || 0) + (tileCounts.failed || 0)}</div>
          </div>
        </div>

        <TabTrend users={users} records={records} activeId={activeId} />
      </div>

      <ReviewQueue records={pending} onApprove={approve} onReject={reject} />

      <RecordsTable
        records={visibleRecords}
        connected={connected}
        onDelete={remove}
        sheetSending={sheetSync.sending}
        sheetErrors={sheetSync.errors}
        sheetWebAppUrl={sheetSync.webAppUrl}
        onSendToSheet={sheetSync.sendRow}
        onDismissSheetError={sheetSync.dismissError}
      />
    </div>
  );
}
