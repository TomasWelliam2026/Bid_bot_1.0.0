import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

/** The `users` columns `updateUser` will write, keyed by the camelCase name a
 *  PATCH body uses -- kept next to the table definition rather than inline in
 *  `updateUser` so the two stay easy to compare when a column is added.
 *
 *  Everything Sheet-sync used to keep per tab (Web App URL, Sheet URL, Sheet
 *  tab name, secret) is now one setting shared by every tab -- see
 *  `getSheetSettings`/`updateSheetSettings` -- so only Profile (D), Country
 *  (C) and Role are still per-tab columns here. Country (C) lives in
 *  `sheet_region`, the column C value from the per-tab days, and is set on its
 *  own rather than taken from the tab's name. Role is the tab's job function:
 *  never written to the sheet, it is what -- with Country (C) -- decides which
 *  tabs list each other's applications. `sheet_web_app_url`, `sheet_url`,
 *  `sheet_tab_name` and `sheet_secret` stay in the table (dropping a column
 *  is more upheaval than a now-unused one is worth) but nothing reads or
 *  writes them through this map any more. */
const USER_PATCH_FIELDS = {
  name: 'name',
  auto: 'auto',
  applicant: 'sheet_applicant',
  country: 'sheet_region',
  role: 'sheet_role',
  // What the extension writes this profile's resumes with -- its own prompt,
  // master resume (and whether it is sent) and resume style, set from the
  // extension's Profile screen. Blank prompt or style means the extension's
  // built-in default.
  prompt: 'gpt_prompt',
  masterResume: 'master_resume',
  masterResumeMode: 'master_resume_mode',
  resumeStyle: 'resume_style',
  // The profile's summary, which Recruiter Bid puts in the body of the email
  // it sends to a recruiter.
  summary: 'summary',
};

/** The `settings` keys `updateSheetSettings` will write, keyed by the
 *  camelCase name a PATCH body uses -- see `USER_PATCH_FIELDS` above, which
 *  this mirrors for the one Sheet-sync setting every tab now shares. */
const SHEET_SETTINGS_FIELDS = {
  webAppUrl: 'sheet_web_app_url',
  sheetUrl: 'sheet_url',
  sheetTabName: 'sheet_tab_name',
  secret: 'sheet_secret',
};

/**
 * The server's own database: SQLite through Node's built-in `node:sqlite`, so
 * the archive needs no service and no native build step alongside it.
 *
 * `records` is the log the frontend renders. `drafts` holds the submitted HTML
 * only while a record waits for a human decision -- once it is filed the PDFs
 * on disk are the artefact, so the markup is dropped. `users` is the archive's
 * multi-tab concept: one row per country a human is applying from (the
 * dashboard shows these as tabs), each with their own Automatic/Human-check
 * preference and their own Profile (D), Country (C) and Role values -- and,
 * since every tab is a profile the extension writes resumes for, their own
 * prompt, master resume and resume style.
 * `records.user_id` points at
 * one, or is NULL for a submission nobody has attributed yet ("Unassigned").
 *
 * Everywhere else Sheet-sync used to be configured per tab -- the Web App
 * URL, the Sheet URL, the Sheet tab name, the shared secret -- is one setting
 * for the whole archive now, held in `settings` (see `getSheetSettings`):
 * every tab sends its rows to the same Google Sheet, and each tab's own
 * Country (C) is what tells them apart there, not a separate deployment each.
 *
 * `status` is what happened to the documents; `sent_status` is the separate
 * question of whether the row has been copied to the Google Sheet. The two
 * never move together: a row can be filed and not sent, or sent and later
 * rejected.
 *
 * `sent_status` is the sheet status of the tab the record is filed under. A
 * tab sharing its Country (C) and Role can send the same record too, written
 * with that tab's own Profile (D) and Country (C) -- and that send is that
 * tab's, one row in `sheet_sends`, never folded into the record's own status:
 * sheet status belongs to a profile, not to the record.
 *
 * Deleting works the same way round. A record is deleted only from the tab it
 * is filed under; a tab it is shared into deletes just its own part of it --
 * the record leaves that tab's list (`hidden_rows`) and that tab's
 * `sheet_sends` row goes -- while the record, its files and its own tab's
 * status stay.
 */
export class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS records (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        company       TEXT NOT NULL,
        job_title     TEXT NOT NULL,
        job_url       TEXT,
        status        TEXT NOT NULL,          -- pending | saved | rejected | failed
        sent_status   TEXT NOT NULL DEFAULT 'unsent',  -- unsent | sent (to the sheet)
        sent_at       TEXT,
        mode          TEXT NOT NULL,          -- the mode the submission arrived in
        dir_path      TEXT,
        job_des_path  TEXT,
        cover_path    TEXT,
        resume_path   TEXT,
        resume_docx_path TEXT,
        error         TEXT,
        created_at    TEXT NOT NULL,
        decided_at    TEXT
      );

      CREATE TABLE IF NOT EXISTS drafts (
        record_id INTEGER PRIMARY KEY,
        job_des   TEXT,
        cover     TEXT,
        resume    TEXT,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- One row per tab the archive tracks -- a country a human is applying
      -- from. COLLATE NOCASE on the name makes lookups (and the UNIQUE
      -- constraint) treat "Sisu" and "sisu" as the same tab, so a padded or
      -- differently-cased name arriving from the extension resolves to the
      -- existing tab instead of forking a near-duplicate.
      CREATE TABLE IF NOT EXISTS users (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        name              TEXT NOT NULL COLLATE NOCASE UNIQUE,
        auto              INTEGER NOT NULL DEFAULT 1,
        sheet_web_app_url TEXT NOT NULL DEFAULT '',
        sheet_url         TEXT NOT NULL DEFAULT '',
        sheet_tab_name    TEXT NOT NULL DEFAULT 'Sheet1',
        sheet_region      TEXT NOT NULL DEFAULT 'US',
        sheet_applicant   TEXT NOT NULL DEFAULT '',
        sheet_secret      TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        sheet_role        TEXT NOT NULL DEFAULT '',
        gpt_prompt        TEXT NOT NULL DEFAULT '',
        master_resume     TEXT NOT NULL DEFAULT '',
        master_resume_mode TEXT NOT NULL DEFAULT 'use',
        resume_style      TEXT NOT NULL DEFAULT '',
        summary           TEXT NOT NULL DEFAULT ''
      );

      -- A record sent to the sheet by a tab other than the one it is filed
      -- under: one row per such tab, the way records.sent_status/sent_at is
      -- the record's own tab's. Removed with the record, and with the tab.
      CREATE TABLE IF NOT EXISTS sheet_sends (
        record_id INTEGER NOT NULL,
        user_id   INTEGER NOT NULL,
        sent_at   TEXT NOT NULL,
        PRIMARY KEY (record_id, user_id)
      );

      -- A record a tab it is shared into has deleted from its own list. The
      -- record stays everywhere else. Removed with the record, and with the tab.
      -- An email Recruiter Bid sent: one row per send. A recruiter's address
      -- here is what keeps them from being imported and emailed again.
      CREATE TABLE IF NOT EXISTS recruiter_sends (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email_address TEXT NOT NULL COLLATE NOCASE,
        company_name  TEXT NOT NULL DEFAULT '',
        email_title   TEXT NOT NULL DEFAULT '',
        email_content TEXT NOT NULL DEFAULT '',
        arrived_date  TEXT NOT NULL DEFAULT '',
        subject       TEXT NOT NULL DEFAULT '',
        body          TEXT NOT NULL DEFAULT '',
        profile_id    INTEGER,
        profile_name  TEXT NOT NULL DEFAULT '',
        sent_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recruiter_sends_email ON recruiter_sends (email_address);

      CREATE TABLE IF NOT EXISTS hidden_rows (
        record_id INTEGER NOT NULL,
        user_id   INTEGER NOT NULL,
        hidden_at TEXT NOT NULL,
        PRIMARY KEY (record_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS records_status ON records (status);
      CREATE INDEX IF NOT EXISTS records_created ON records (created_at DESC);
    `);

    // An archive written before the sheet columns existed opens as it is and
    // grows them here -- CREATE TABLE IF NOT EXISTS leaves an existing table
    // alone, so a new column has to be added to it separately.
    this.addColumn('sent_status', "TEXT NOT NULL DEFAULT 'unsent'");
    this.addColumn('sent_at', 'TEXT');
    this.addColumn('resume_docx_path', 'TEXT');

    this.addColumn('user_id', 'INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS records_user ON records (user_id)');

    // Role arrived after the users table did. Blank until someone sets it,
    // which leaves every existing tab listing only its own applications.
    this.addColumn('sheet_role', "TEXT NOT NULL DEFAULT ''", 'users');

    // Each tab is a profile the extension writes resumes for, with its own
    // prompt, master resume and resume style -- which used to be one set for
    // the whole extension. Blank until the extension sets them.
    this.addColumn('gpt_prompt', "TEXT NOT NULL DEFAULT ''", 'users');
    this.addColumn('master_resume', "TEXT NOT NULL DEFAULT ''", 'users');
    this.addColumn('master_resume_mode', "TEXT NOT NULL DEFAULT 'use'", 'users');
    this.addColumn('resume_style', "TEXT NOT NULL DEFAULT ''", 'users');

    // The summary a recruiter email carries -- set from the extension's
    // Profile screen, blank until then.
    this.addColumn('summary', "TEXT NOT NULL DEFAULT ''", 'users');

    // Every record before this column existed belonged to the one person who
    // used this archive before it had a multi-user concept at all. Give that
    // person a name -- "Sisu" -- and hand them everything already here.
    //
    // Gated on a settings flag rather than "did addColumn just add the
    // column": that would only be true on the exact run that adds it, and a
    // server that happens to restart between the column landing and this
    // backfill running (whether from a crash, a deploy, or anything else)
    // would skip it forever after -- the column would already exist on every
    // later run, so `addColumn` would never again report having just added
    // it. Checking "has this migration actually finished" directly makes it
    // safe to retry on every startup until it has, and never after.
    if (this.getSetting('migrated_sisu') !== 'true') {
      const orphaned = this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id IS NULL').get().n;
      if (orphaned > 0) {
        const sisu = this.findOrCreateUser('Sisu', { auto: true });
        this.db.prepare('UPDATE records SET user_id = ? WHERE user_id IS NULL').run(sisu.id);
        console.log(`[migrate] assigned ${orphaned} existing record(s) to "Sisu"`);
      }
      // Set even when there was nothing to backfill (a fresh install): a
      // record saved with no `user` between now and this flag being set is a
      // deliberate Unassigned submission, not a pre-migration leftover, and
      // must never be swept into Sisu by a later restart.
      this.setSetting('migrated_sisu', 'true');
    }

    // Sheet-sync used to be configured per tab; now it is one setting for the
    // whole archive (see SHEET_SETTINGS_FIELDS above). The first startup after
    // that change seeds it from Sisu's tab, whose Web App URL, Sheet URL,
    // sheet tab name and secret ('SISU', matching what sheet-sync.gs already
    // has hardcoded) are the one already-deployed, already-working
    // configuration -- everyone else's per-tab values, if they had set their
    // own, are superseded by it. A fresh install with no Sisu at all gets a
    // freshly generated secret and blank URLs, same as a brand-new tab used to.
    //
    // Found by that hardcoded secret rather than by the name "Sisu": renaming
    // is a feature this same release adds, so the tab this needs to find may
    // already have been renamed away from "Sisu" by the time this runs. The
    // secret is the one thing about it that never changes.
    if (this.getSetting('migrated_global_sheet_settings') !== 'true') {
      const sisu =
        this.db.prepare("SELECT * FROM users WHERE sheet_secret = 'SISU'").get() || this.getUserByName('Sisu');
      this.setSetting('sheet_web_app_url', sisu?.sheet_web_app_url || '');
      this.setSetting('sheet_url', sisu?.sheet_url || '');
      this.setSetting('sheet_tab_name', sisu?.sheet_tab_name || 'Sheet1');
      this.setSetting('sheet_secret', sisu?.sheet_secret || randomBytes(16).toString('hex'));
      this.setSetting('migrated_global_sheet_settings', 'true');
    }

    // Column C used to be the tab's own name, sent with every row; now it is
    // each tab's Country (C), set on its own. Seed it from the name once, so
    // a tab keeps writing exactly what it wrote before until someone changes
    // it -- `sheet_region` itself still holds the stale 'US' default from the
    // per-tab days, which would have relabelled every tab.
    if (this.getSetting('migrated_sheet_country') !== 'true') {
      this.db.exec('UPDATE users SET sheet_region = name');
      this.setSetting('migrated_sheet_country', 'true');
    }
  }

  /** Add a column to `table` (`records` unless said otherwise) unless it is
   *  already there. Returns whether it actually added one, so a caller can run
   *  one-time follow-up work only on the migration that introduces the
   *  column. */
  addColumn(name, definition, table = 'records') {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((column) => column.name === name)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    return true;
  }

  /* --- settings ---------------------------------------------------------- */

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  /* --- sheet settings -------------------------------------------------------
     Where "Send to sheet" sends a row, and what rides along with it -- one
     setting for the whole archive (see SHEET_SETTINGS_FIELDS), not one per
     tab: every tab writes to the same Google Sheet, and Column C (Category)
     is what tells a tab's rows apart there, filled in from that tab's own
     Country (C) -- see USER_PATCH_FIELDS. */

  getSheetSettings() {
    return {
      webAppUrl: this.getSetting('sheet_web_app_url', ''),
      sheetUrl: this.getSetting('sheet_url', ''),
      sheetTabName: this.getSetting('sheet_tab_name', 'Sheet1'),
      secret: this.getSetting('sheet_secret', ''),
    };
  }

  /** Same shape as `updateUser`: whichever of `patch`'s keys are real fields
   *  get written, anything else is ignored. */
  updateSheetSettings(patch) {
    for (const [key, settingKey] of Object.entries(SHEET_SETTINGS_FIELDS)) {
      if (key in patch) this.setSetting(settingKey, patch[key]);
    }
    return this.getSheetSettings();
  }

  /* --- records ----------------------------------------------------------- */

  /**
   * `createdAt` is when the application was made, which is not always when the
   * server heard about it -- a row imported from a spreadsheet carries the date
   * it happened. It defaults to now.
   *
   * A submission arrives unsent -- reaching the sheet is a later, manual step.
   * `sent` is for the one case where that is already done before the record
   * exists: a row imported from a spreadsheet of applications already made,
   * which is where the sheet's own rows came from in the first place. Its
   * `sent_at` is the date on the row, being as close to when it reached the
   * sheet as anything here knows.
   */
  insert({ company, jobTitle, jobUrl, status, mode, createdAt, sent = false, userId = null }) {
    const at = createdAt || new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO records (company, job_title, job_url, status, sent_status, sent_at, mode, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(company, jobTitle, jobUrl || null, status, sent ? 'sent' : 'unsent', sent ? at : null, mode, at, userId);
    return Number(result.lastInsertRowid);
  }

  /**
   * Park the submission until someone approves or rejects it.
   *
   * A document is either markup or, for a resume, the structured data the
   * template is drawn from. SQLite binds strings, so the structured form is
   * stored as JSON and restored on the way out -- markup never starts with a
   * brace, so the two cannot be confused.
   */
  saveDraft(id, { job_des, cover, resume }) {
    const store = (value) => {
      if (value === undefined || value === null || value === '') return null;
      return typeof value === 'string' ? value : JSON.stringify(value);
    };
    this.db
      .prepare('INSERT OR REPLACE INTO drafts (record_id, job_des, cover, resume) VALUES (?, ?, ?, ?)')
      .run(id, store(job_des), store(cover), store(resume));
  }

  getDraft(id) {
    const row = this.db.prepare('SELECT job_des, cover, resume FROM drafts WHERE record_id = ?').get(id);
    if (!row) return null;
    const restore = (value) => {
      if (typeof value !== 'string' || !/^s*[[{]/.test(value)) return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };
    return { job_des: restore(row.job_des), cover: restore(row.cover), resume: restore(row.resume) };
  }

  dropDraft(id) {
    this.db.prepare('DELETE FROM drafts WHERE record_id = ?').run(id);
  }

  /** Record where the documents were filed. */
  markSaved(id, { dir, files }) {
    this.db
      .prepare(
        `UPDATE records
            SET status = 'saved', dir_path = ?, job_des_path = ?, cover_path = ?, resume_path = ?,
                resume_docx_path = ?, error = NULL, decided_at = ?
          WHERE id = ?`,
      )
      .run(
        dir,
        files.job_des || null,
        files.cover || null,
        files.resume || null,
        files.resume_docx || null,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  /**
   * Whether the row has reached the Google Sheet.
   *
   * The dashboard sends the row itself and calls this once the script answers
   * OK, so the answer lives with the record rather than in the browser that
   * happened to click the button -- every tab, and every later session, reads
   * the same status.
   *
   * `userId` is the tab that sent it. Left out, or the tab the record is filed
   * under, it is the record's own `sent_status`; any other tab's send is that
   * tab's own row in `sheet_sends`, so one profile's send never reads as
   * another's.
   */
  markSent(id, sent = true, userId = null) {
    const record = this.get(id);
    if (!record) return null;
    const at = sent ? new Date().toISOString() : null;

    if (userId == null || userId === record.user_id) {
      this.db
        .prepare('UPDATE records SET sent_status = ?, sent_at = ? WHERE id = ?')
        .run(sent ? 'sent' : 'unsent', at, id);
    } else if (sent) {
      this.db
        .prepare(
          `INSERT INTO sheet_sends (record_id, user_id, sent_at) VALUES (?, ?, ?)
           ON CONFLICT(record_id, user_id) DO UPDATE SET sent_at = excluded.sent_at`,
        )
        .run(id, userId, at);
    } else {
      this.db.prepare('DELETE FROM sheet_sends WHERE record_id = ? AND user_id = ?').run(id, userId);
    }
    return this.get(id);
  }

  /**
   * A record taken off one tab's list -- a tab it is shared into, never the
   * tab it is filed under -- along with that tab's own sheet status for it.
   * That is the whole of that tab's part in it: the record itself, its files
   * and its own tab's status are not touched.
   */
  hideFor(id, userId) {
    this.db.prepare('DELETE FROM sheet_sends WHERE record_id = ? AND user_id = ?').run(id, userId);
    this.db
      .prepare(
        `INSERT INTO hidden_rows (record_id, user_id, hidden_at) VALUES (?, ?, ?)
         ON CONFLICT(record_id, user_id) DO NOTHING`,
      )
      .run(id, userId, new Date().toISOString());
    return this.get(id);
  }

  /** Each row with what other tabs hold of it: `sheet_sends` -- [{ user_id,
   *  sent_at }], oldest first, for every tab other than its own that has sent
   *  it -- and `hidden_for`, the ids of the tabs that have deleted it from
   *  their own list. One query per table for the lot, however many rows there
   *  are; `recordId` narrows both to one record. */
  withTabData(rows, recordId = null) {
    if (!rows.length) return rows;
    const where = recordId == null ? '' : 'WHERE record_id = ?';
    const params = recordId == null ? [] : [recordId];
    const add = (map, key, value) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    };

    const sends = new Map();
    for (const { record_id, user_id, sent_at } of this.db
      .prepare(`SELECT record_id, user_id, sent_at FROM sheet_sends ${where} ORDER BY sent_at`)
      .all(...params)) {
      add(sends, record_id, { user_id, sent_at });
    }
    const hidden = new Map();
    for (const { record_id, user_id } of this.db
      .prepare(`SELECT record_id, user_id FROM hidden_rows ${where}`)
      .all(...params)) {
      add(hidden, record_id, user_id);
    }

    return rows.map((row) => ({
      ...row,
      sheet_sends: sends.get(row.id) ?? [],
      hidden_for: hidden.get(row.id) ?? [],
    }));
  }

  markRejected(id) {
    this.db
      .prepare(`UPDATE records SET status = 'rejected', decided_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
    return this.get(id);
  }

  markFailed(id, message) {
    this.db
      .prepare(`UPDATE records SET status = 'failed', error = ?, decided_at = ? WHERE id = ?`)
      .run(String(message).slice(0, 500), new Date().toISOString(), id);
    return this.get(id);
  }

  get(id) {
    const record = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id);
    return record ? this.withTabData([record], id)[0] : null;
  }

  /**
   * The log.
   *
   * `limit: 0` means every row -- SQLite reads a negative LIMIT as no limit,
   * which is what the dashboard asks for: it shows the whole archive rather
   * than a page of it. `order` picks which end comes first; the dashboard
   * reads oldest-first, the way the spreadsheet these rows came from does,
   * while a caller asking the HTTP API for "the last N" wants newest-first.
   */
  list({ status, limit = 200, order = 'desc' } = {}) {
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const cap = limit > 0 ? limit : -1;
    return this.withTabData(
      status
        ? this.db
            .prepare(`SELECT * FROM records WHERE status = ? ORDER BY id ${direction} LIMIT ?`)
            .all(status, cap)
        : this.db.prepare(`SELECT * FROM records ORDER BY id ${direction} LIMIT ?`).all(cap),
    );
  }

  /**
   * The newest record for a company and job title, or null.
   *
   * Matched case-insensitively on trimmed values: the same posting scraped
   * twice rarely comes back byte-identical, and a near-miss here would report
   * a job as new when it is already in the archive.
   *
   * `userId` narrows it to one tab: a number is that tab, null is the
   * unassigned records, and leaving it out searches every tab.
   */
  findByJob(company, jobTitle, userId) {
    const byTab = userId !== undefined;
    const params = [String(company), String(jobTitle)];
    if (byTab) params.push(userId);
    return (
      this.db
        .prepare(
          `SELECT * FROM records
             WHERE lower(trim(company)) = lower(trim(?))
               AND lower(trim(job_title)) = lower(trim(?))
               ${byTab ? 'AND user_id IS ?' : ''}
             ORDER BY id DESC LIMIT 1`,
        )
        .get(...params) || null
    );
  }

  /** Remove one record, its held draft and what other tabs hold of it.
   *  Returns the row that was removed. */
  remove(id) {
    const record = this.get(id);
    if (!record) return null;
    this.db.prepare('DELETE FROM drafts WHERE record_id = ?').run(id);
    this.db.prepare('DELETE FROM sheet_sends WHERE record_id = ?').run(id);
    this.db.prepare('DELETE FROM hidden_rows WHERE record_id = ?').run(id);
    this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
    return record;
  }

  /** Clear the log. Returns every row that was removed, so its files can go too. */
  removeAll() {
    const records = this.db.prepare('SELECT * FROM records').all();
    this.db.exec('DELETE FROM drafts; DELETE FROM sheet_sends; DELETE FROM hidden_rows; DELETE FROM records;');
    return records;
  }

  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM records GROUP BY status').all();
    const counts = { total: 0, pending: 0, saved: 0, rejected: 0, failed: 0 };
    for (const row of rows) {
      counts[row.status] = Number(row.n);
      counts.total += Number(row.n);
    }
    return counts;
  }

  /* --- users --------------------------------------------------------------
     One row per country this archive tracks -- what the dashboard shows as a
     tab. `findOrCreateUser` is what lets a bare name on an incoming
     submission attribute itself: the extension only ever sends a name, never
     a tab id, and never has to create the tab first. */

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  /** The `name` column is COLLATE NOCASE, so this already ignores case; only
   *  the trim needs doing here. */
  getUserByName(name) {
    const trimmed = String(name || '').trim();
    return trimmed ? this.db.prepare('SELECT * FROM users WHERE name = ?').get(trimmed) || null : null;
  }

  createUser(name, { auto = true } = {}) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('a tab needs a name');
    const result = this.db
      .prepare(
        `INSERT INTO users (name, auto, sheet_applicant, sheet_region, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(trimmed, auto ? 1 : 0, trimmed, trimmed, new Date().toISOString());
    return this.getUser(Number(result.lastInsertRowid));
  }

  /**
   * Like `createUser`, but an existing name is not an error -- it is the same
   * tab, found instead of made. A live submission or a CSV row only ever
   * names a country; whether that country's tab already exists is not its
   * concern.
   */
  findOrCreateUser(name, opts = {}) {
    const existing = this.getUserByName(name);
    if (existing) return existing;
    try {
      return this.createUser(name, opts);
    } catch (err) {
      // Lost a race with another request naming the same brand-new tab in the
      // same instant. node:sqlite is synchronous and Node is single-threaded,
      // so within this one process the check-then-insert above cannot
      // actually interleave -- this only fires against a second *process*
      // sharing the file. Re-read rather than fail either way.
      const retry = this.getUserByName(name);
      if (retry) return retry;
      throw err;
    }
  }

  /** Applies whichever of `patch`'s keys are real user fields; anything else
   *  in `patch` is ignored rather than erroring, so a caller can pass a whole
   *  request body through without pre-filtering it. */
  /** One email Recruiter Bid sent. Returns the stored row. */
  addRecruiterSend(send) {
    const text = (value) => String(value ?? '');
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO recruiter_sends
           (email_address, company_name, email_title, email_content, arrived_date,
            subject, body, profile_id, profile_name, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        text(send.email_address),
        text(send.company_name),
        text(send.email_title),
        text(send.email_content),
        text(send.arrived_date),
        text(send.subject),
        text(send.body),
        Number.isInteger(send.profile_id) ? send.profile_id : null,
        text(send.profile_name),
        text(send.sent_at) || new Date().toISOString()
      );
    return this.db.prepare('SELECT * FROM recruiter_sends WHERE id = ?').get(lastInsertRowid);
  }

  /** Every email Recruiter Bid sent, newest first. */
  listRecruiterSends() {
    return this.db.prepare('SELECT * FROM recruiter_sends ORDER BY sent_at DESC, id DESC').all();
  }

  updateUser(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(USER_PATCH_FIELDS)) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(key === 'auto' ? (patch[key] ? 1 : 0) : String(patch[key] ?? ''));
    }
    if (sets.length) {
      this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.getUser(id);
  }

  /** How many records still point at this tab -- pending ones included, since
   *  they are already rows in `records` (just not yet filed). What a delete
   *  is blocked on. */
  countRecordsForUser(id) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?').get(id).n;
  }

  /**
   * Remove a tab outright. Callers are expected to have already checked
   * `countRecordsForUser(id) === 0` -- this does not itself touch `records`,
   * so deleting a tab that still has some would silently orphan them with a
   * `user_id` pointing at a row that no longer exists.
   */
  deleteUser(id) {
    // Its sends of other tabs' records are its own sheet status, and its
    // deleted list its own list: both go with it.
    this.db.prepare('DELETE FROM sheet_sends WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM hidden_rows WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  close() {
    this.db.close();
  }
}
