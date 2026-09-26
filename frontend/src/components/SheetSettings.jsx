import { useEffect, useRef, useState } from 'react';
import { EXPECTED_SCRIPT_VERSION } from '../lib/sheetSync.js';
import { buildScript } from '../lib/sheetSyncTemplate.js';

// Web App URL, Sheet URL and Sheet tab are one setting shared by every tab;
// Profile (D) is still this tab's own. Both live in one draft/save/discard
// below -- there is no reason to make a human learn two forms -- but Save
// routes each half to whichever of onUpdateSheetSettings/onUpdate it belongs to.
const SHARED_FIELDS = ['webAppUrl', 'sheetUrl', 'sheetTabName'];
const FIELDS = [...SHARED_FIELDS, 'applicant'];

const sameValues = (a, b) => FIELDS.every((name) => (a[name] ?? '') === (b[name] ?? ''));
const sameSharedValues = (a, b) => SHARED_FIELDS.every((name) => (a[name] ?? '') === (b[name] ?? ''));

/** What gets saved: every field with the space around it gone. */
const cleaned = (draft) => Object.fromEntries(FIELDS.map((name) => [name, String(draft[name] ?? '').trim()]));

/**
 * One tab's settings -- its name, whether it still exists, its Automatic/
 * Human-check preference (which used to be a separate global switch in the
 * header), and its Profile (D) value -- plus, shared with every other tab
 * rather than its own, where "Send to sheet" sends a row.
 *
 * The Web App URL, Sheet URL and Sheet tab name are one setting for the whole
 * archive (`sheetSettings`, from useArchive): every tab writes to the same
 * Google Sheet, so editing them here changes them on every other tab's panel
 * too. Profile (D) is still saved to this tab's own record on the server.
 * The shared secret is generated once and never shown here as an editable
 * field, the same way SHARED_SECRET is set once at the top of sheet-sync.gs
 * itself -- editing it here would just as quickly break the deployment it
 * needs to match.
 *
 * There is no Category field: column C is always this tab's own name, sent
 * with every row and baked into a generated script's default, so it can never
 * drift out of sync with which tab a record actually lives on the way a
 * separately-typed value could.
 *
 * Sheet-field edits (shared and Profile alike) are a draft until Save;
 * half-typed values -- a tab name a letter short, a URL being pasted -- are
 * never what a row is sent with, only what was saved is. Automatic/
 * Human-check and the tab's own name apply immediately on click/submit,
 * same as the switch it replaces.
 */
export default function SheetSettings({
  activeUser,
  sheetSettings,
  onUpdate,
  onUpdateSheetSettings,
  onDelete,
  onClose,
  scriptStatus,
}) {
  const settings = { ...sheetSettings, applicant: activeUser.sheet.applicant };
  const [draft, setDraft] = useState(settings);
  const [saveState, setSaveState] = useState('idle'); // idle | saved
  const [copyState, setCopyState] = useState('idle'); // idle | copied | failed
  const [scriptOpen, setScriptOpen] = useState(false);

  const [nameDraft, setNameDraft] = useState(activeUser.name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState(null);
  const nameBaseline = useRef(activeUser.name);
  useEffect(() => {
    if (activeUser.name === nameBaseline.current) return;
    // Captured before the mutation below, not read from nameBaseline.current
    // inside the updater: setNameDraft's updater runs during React's render
    // phase, after this effect (and the plain assignment two lines down) has
    // already finished -- reading the ref in there would see the *new*
    // value, so the dirty check below would always fail and switching tabs
    // would silently keep showing whichever tab's name was on screen first.
    const before = nameBaseline.current;
    setNameDraft((current) => (current === before ? activeUser.name : current));
    nameBaseline.current = activeUser.name;
  }, [activeUser.name]);
  const nameDirty = nameDraft.trim().length > 0 && nameDraft.trim() !== activeUser.name;

  const renameTab = async (event) => {
    event.preventDefault();
    if (!nameDirty || nameBusy) return;
    setNameBusy(true);
    setNameError(null);
    const result = await onUpdate(activeUser.id, { name: nameDraft.trim() });
    setNameBusy(false);
    if (result?.error) setNameError(result.error);
  };

  // Deleting is the one irreversible action on this panel, so it takes a
  // second click before it does anything -- and switching to another tab's
  // settings mid-confirm never carries the armed state over to it.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleteError(null);
  }, [activeUser.id]);

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    const result = await onDelete(activeUser.id);
    setDeleteBusy(false);
    if (result?.error) {
      setConfirmingDelete(false);
      setDeleteError(result.error);
      return;
    }
    onClose();
  };

  const dirty = !sameValues(cleaned(draft), settings);

  // The saved settings can change without this panel -- the shared fields
  // from another browser on any tab's panel, Profile from another browser on
  // this one. Take the new values unless there are edits here that would be
  // lost.
  const baseline = useRef(settings);
  useEffect(() => {
    if (sameValues(settings, baseline.current)) return;
    const before = baseline.current;
    setDraft((current) => (sameValues(current, before) ? settings : current));
    baseline.current = settings;
  }, [settings.webAppUrl, settings.sheetUrl, settings.sheetTabName, settings.applicant]);

  const save = (event) => {
    event?.preventDefault();
    if (!dirty) return;
    const next = cleaned(draft);
    // Two different resources on the server, saved together here because a
    // human editing one while looking at the other's fields should not have
    // to find and press a second Save -- but only the half that actually
    // changed is sent to each.
    if (!sameSharedValues(next, settings)) {
      const { applicant: _applicant, ...sharedPatch } = next;
      onUpdateSheetSettings(sharedPatch);
    }
    if (next.applicant !== settings.applicant) {
      onUpdate(activeUser.id, { applicant: next.applicant });
    }
    setDraft(next);
    setSaveState('saved');
    setTimeout(() => setSaveState('idle'), 2500);
  };

  const discard = () => setDraft(settings);

  const field = (name) => ({
    value: draft[name] ?? '',
    onChange: (event) => {
      const { value } = event.target;
      setSaveState('idle');
      setDraft((current) => ({ ...current, [name]: value }));
    },
  });

  const configured = Boolean(settings.webAppUrl);

  // Everything the script needs from this panel, written into it: the
  // worksheet tab it writes to by default, and the Category and Profile a row
  // gets whenever the request does not carry its own. Category is this tab's
  // own name -- always current, so this never describes a value someone typed
  // into a field and forgot about. Sheet tab and Profile come from the saved
  // settings -- the ones rows are actually sent with -- so the script can
  // never describe a value that is still being typed.
  const script = buildScript({
    sheetTabName: settings.sheetTabName,
    secret: settings.secret,
    category: activeUser.name,
    profile: settings.applicant,
  });

  // No page can script Google's own editor or its deployment flow -- that has
  // no public API for a browser to call without a full OAuth setup. What this
  // can do is hand over a script with nothing left to fill in by hand.
  const generateScript = async () => {
    setScriptOpen(true);
    try {
      await navigator.clipboard.writeText(script);
      setCopyState('copied');
    } catch {
      setCopyState('failed'); // it is open below, selectable by hand
    }
    setTimeout(() => setCopyState('idle'), 4000);
  };

  return (
    <section className="panel sheet-settings">
      <div className="panel-head">
        <h2 className="panel-title">Sheet sync — {activeUser.name}</h2>
        <div className="head-actions">
          <span className={`tag ${configured ? 'good' : 'warn'}`}>
            {configured ? 'Configured' : 'Not set up'}
          </span>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close sheet sync">
            ✕
          </button>
        </div>
      </div>

      {/* The tab's own name and its one irreversible action, side by side --
          applies on submit/click, same as Automatic/Human-check below,
          rather than waiting on the Sheet-sync Save button further down
          (which only ever covers the shared fields). Delete takes a second
          click before it does anything, and switching to another tab's
          settings mid-confirm never carries the armed state over to it. */}
      <form onSubmit={renameTab}>
        <div className="field-grid">
          <label className="field wide">
            <span>Tab name</span>
            <input
              type="text"
              value={nameDraft}
              onChange={(event) => {
                setNameError(null);
                setNameDraft(event.target.value);
              }}
            />
          </label>
        </div>
        <div className="save-row">
          <button type="submit" className="btn btn-primary" disabled={!nameDirty || nameBusy}>
            {nameBusy ? 'Renaming…' : 'Rename tab'}
          </button>
          {confirmingDelete ? (
            <>
              <span className="tile-detail">Delete “{activeUser.name}” for good?</span>
              <button type="button" className="btn" disabled={deleteBusy} onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
              <button type="button" className="btn danger solid" disabled={deleteBusy} onClick={confirmDelete}>
                {deleteBusy ? 'Deleting…' : 'Confirm delete'}
              </button>
            </>
          ) : (
            <button type="button" className="btn danger" onClick={() => setConfirmingDelete(true)}>
              Delete tab
            </button>
          )}
        </div>
        {nameError ? <div className="note critical">{nameError}</div> : null}
        {deleteError ? <div className="note critical">{deleteError}</div> : null}
      </form>

      {/* This tab's Automatic/Human-check preference -- applies immediately
          on click, the same as the global switch this replaced did, rather
          than waiting on the Save button below (which only ever covers the
          Sheet-sync fields). */}
      <div className="switch" role="group" aria-label={`How ${activeUser.name}'s submissions are handled`}>
        <button
          type="button"
          className={activeUser.auto ? 'seg on' : 'seg'}
          aria-pressed={activeUser.auto}
          onClick={() => onUpdate(activeUser.id, { auto: true })}
          title="Render and file every submission the moment it arrives"
        >
          Automatic
        </button>
        <button
          type="button"
          className={activeUser.auto ? 'seg' : 'seg on'}
          aria-pressed={!activeUser.auto}
          onClick={() => onUpdate(activeUser.id, { auto: false })}
          title="Hold each submission until you approve it"
        >
          Human check
        </button>
      </div>

      {/* Everything below here is the Google Sheet side of this panel --
          shared by every tab, unlike the tab settings above -- so it gets an
          outline of its own rather than blending into them. */}
      <div className="sheet-settings-shared">
        {/* The deployment can run older code than the repo with no sign of it
            -- the one thing on this panel that is not the user's own input. */}
        {scriptStatus?.state === 'outdated' ? (
          <div className="note critical script-outdated" role="alert">
            <strong>The deployed script is out of date</strong> (reports v{scriptStatus.version || 'none'},
            this dashboard needs v{EXPECTED_SCRIPT_VERSION}) —{' '}
            {scriptStatus.version < 3
              ? 'rows are written without column A.'
              : scriptStatus.version < 5
                ? 'it always writes to the tab it was generated for, whatever Sheet tab says here.'
                : scriptStatus.version < 6
                  ? "it draws the day's thick line over every row of the day instead of only the first."
                  : 'it predates what this dashboard sends.'}{' '}
            Generate script, paste into the Apps Script editor, then{' '}
            <b>Deploy ▸ Manage deployments ▸ ✏️ ▸ Version: New version ▸ Deploy</b>. Editing without
            picking <b>New version</b> keeps the old code running.
          </div>
        ) : scriptStatus?.state === 'current' ? (
          <div className="script-current">Deployed script v{scriptStatus.version} ✓</div>
        ) : null}

        {/* A form, so Enter in any field saves. Labels and placeholders only;
            the two fields that need more say it in a tooltip. */}
        <form onSubmit={save}>
          <p className="tile-detail">
            Web App URL, Sheet URL and Sheet tab are shared by every tab. Profile (D) is just{' '}
            {activeUser.name}'s own.
          </p>
          <div className="field-grid">
            <label className="field wide">
              <span>Apps Script Web App URL</span>
              <input
                type="url"
                placeholder="https://script.google.com/macros/s/…/exec"
                title="From Deploy ▸ New deployment ▸ Web app, in the sheet's Apps Script editor. This is what the ⇪ button calls. Shared by every tab."
                {...field('webAppUrl')}
              />
            </label>

            <label className="field">
              <span>Google Sheet URL</span>
              <input
                type="url"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                title="For the Open sheet link — never called directly. Shared by every tab."
                {...field('sheetUrl')}
              />
            </label>

            <label className="field">
              <span>Sheet tab</span>
              <input
                type="text"
                placeholder="Sheet1"
                title="The tab each row is written to, exactly as named at the bottom of the spreadsheet. Applies from the next send after Save — no redeploy. Shared by every tab."
                {...field('sheetTabName')}
              />
            </label>

            <label className="field wide">
              <span>Profile (D)</span>
              <input type="text" placeholder="e.g. your name" {...field('applicant')} />
            </label>
          </div>

          <div className="save-row">
            <button type="submit" className="btn btn-primary" disabled={!dirty}>
              Save
            </button>
            {dirty ? (
              <button type="button" className="btn" onClick={discard}>
                Discard
              </button>
            ) : null}
            <span className={`save-state ${dirty ? 'dirty' : saveState}`} role="status">
              {dirty ? 'Unsaved changes' : saveState === 'saved' ? 'Saved ✓ — used from the next send' : ''}
            </span>
          </div>
        </form>

        {/* One row of actions, in the order they are used: build the script,
            look at it if you want to, visit the sheet. */}
        <div className="panel-foot">
          <button
            type="button"
            className="btn"
            onClick={generateScript}
            disabled={dirty}
            title={
              dirty
                ? 'Save first — the script is built from the saved settings'
                : 'Builds the Apps Script with the saved Sheet tab, Category and Profile written in, copies it, and shows it below'
            }
          >
            {copyState === 'copied'
              ? 'Copied ✓'
              : copyState === 'failed'
                ? 'Copy failed — select it below'
                : 'Generate script'}
          </button>
          <details
            className="script-peek"
            open={scriptOpen}
            onToggle={(event) => setScriptOpen(event.currentTarget.open)}
          >
            <summary>Script</summary>
            <textarea readOnly className="mono" rows={10} value={script} onFocus={(event) => event.target.select()} />
          </details>
          {settings.sheetUrl ? (
            <a className="btn" href={settings.sheetUrl} target="_blank" rel="noreferrer">
              Open sheet ↗
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
