import fs from 'node:fs';
import os from 'node:os';
import cors from 'cors';
import express from 'express';
import { config, corsOrigins } from './config.js';
import { Store } from './db.js';
import { excerpt } from './html.js';
import { resumeHtml } from './resumeTemplate.js';
import { FILED_KINDS, removeFiles, storeSubmission } from './storage.js';

const store = new Store(config.dbFile);

const app = express();
app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: config.bodyLimit }));

/* --- live updates ----------------------------------------------------------
   Server-Sent Events: the table is append-mostly and the browser reconnects on
   its own, so a socket library would be more machinery than the job needs. */

const clients = new Set();

const send = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const broadcast = (event, data) => {
  for (const client of clients) {
    try {
      send(client, event, data);
    } catch {
      clients.delete(client);
    }
  }
};

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);

  // Open with the current state so a fresh tab paints immediately.
  send(res, 'snapshot', snapshot());

  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
});

// The whole archive, oldest first: the dashboard shows every row rather than
// a page of them, so a cap here would silently hide the difference between
// "that is all of it" and "that is the first 200".
const snapshot = () => ({
  dataRoot: config.dataRoot,
  counts: store.counts(),
  users: store.listUsers().map(userJson),
  records: store.list({ limit: 0, order: 'asc' }),
  sheetSettings: store.getSheetSettings(),
});

const pushRecord = (record) => {
  broadcast('record', { record, counts: store.counts() });
};

const pushRemoved = (ids, files) => {
  broadcast('removed', { ids, files, counts: store.counts() });
};

/** Paths a record points at, in the archive -- the .docx among them, so that
    deleting a record takes every file it made with it. */
const filesOf = (record) => FILED_KINDS.map((kind) => record[`${kind}_path`]).filter(Boolean);

/* --- ingest ---------------------------------------------------------------- */

/**
 * When the application was made, as a local Date, or null if it was not sent.
 *
 * `YYYY-MM-DD` is read as that calendar day where the server runs: the archive
 * is browsed by local day, so reading a bare date as UTC would file an evening
 * application under the day before. A full timestamp is taken as it comes.
 */
function submittedDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Render and file one submission, updating the record either way. */
async function fileSubmission(id, { company, jobTitle, jobUrl, documents, date, profile }) {
  try {
    const stored = await storeSubmission({
      root: config.dataRoot,
      company,
      jobTitle,
      jobUrl,
      documents,
      date,
      profile,
    });
    store.dropDraft(id);
    const record = store.markSaved(id, stored);
    console.log(`[saved] #${id} ${company} — ${jobTitle} -> ${stored.dir || 'nothing to file'}`);
    pushRecord(record);
    return { ok: true, record };
  } catch (error) {
    const record = store.markFailed(id, error.message);
    console.error(`[failed] #${id} ${error.message}`);
    pushRecord(record);
    return { ok: false, record, error: error.message };
  }
}

app.post('/save-data', async (req, res) => {
  const body = req.body || {};
  const company = String(body.company || '').trim();
  const jobTitle = String(body.job_title || '').trim();
  const jobUrl = String(body.job_url || '').trim();
  const documents = {
    job_des: body.job_des || '',
    // `coverletter` is what the sender calls it; `cover` is the older name for the
    // same field, and what the archive and the dashboard call it throughout.
    cover: body.coverletter || body.cover || '',
    resume: body.resume || '',
  };

  if (!company || !jobTitle) {
    return res.status(400).json({ ok: false, error: 'company and job_title are required' });
  }

  // Optional: when the application was actually made. It dates the record and
  // picks the archive folder, so a backfilled row lands under the day it
  // happened rather than the day it was imported.
  const date = submittedDate(body.date);
  if (body.date && !date) {
    return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD or an ISO timestamp' });
  }

  // Optional: the row is already in the Google Sheet. The CSV importer sends
  // this, because a spreadsheet of applications already made *is* the sheet --
  // filing those as unsent would invite a click that appends a duplicate. A
  // live submission sends nothing here and lands unsent.
  const sent = /^(1|true|yes|sent)$/i.test(String(body.sent ?? ''));

  // Who this application belongs to. A name is enough to land in that tab,
  // whether or not anyone has created it from the dashboard yet -- naming a
  // tab that does not exist yet makes it. Nothing here (a CSV import that
  // forgot to tag a row, an un-updated extension) leaves the record
  // unassigned rather than guessing, and an unassigned submission always
  // waits for a human -- there is no tab whose Automatic preference could
  // apply to it.
  const userName = String(body.user || '').trim();
  const user = userName ? store.findOrCreateUser(userName, { auto: config.autoByDefault }) : null;
  // A brand-new tab made in passing here still needs telling to every open
  // dashboard, the same as one made from the "+" button -- otherwise a CSV
  // import that names a tab nobody has created yet files rows into a tab
  // that never appears in the strip until the page is reloaded.
  if (user) pushUser(user);
  const auto = user ? Boolean(user.auto) : false;

  // A submission may carry no documents at all. A row imported from a
  // spreadsheet of applications already made is a note about a posting with
  // nothing to render -- it is logged like any other, there is simply nothing
  // to file and no folder is made for it.
  const mode = auto ? 'auto' : 'check';
  const id = store.insert({
    company,
    jobTitle,
    jobUrl,
    userId: user ? user.id : null,
    status: auto ? 'saving' : 'pending',
    mode,
    createdAt: date ? date.toISOString() : undefined,
    sent,
  });

  if (!auto) {
    // Human check: hold the markup and let the dashboard decide.
    // The date is not parked with the draft: it is already on the record, and
    // that is what approving reads it back from.
    store.saveDraft(id, documents);
    const record = store.get(id);
    pushRecord(record);
    console.log(`[queued] #${id} ${company} — ${jobTitle}`);
    return res.status(202).json({ ok: true, id, mode: 'check', status: 'pending', record });
  }

  // Hold the markup until it is safely on disk: a render that fails can then be
  // retried from the dashboard instead of losing what was sent.
  store.saveDraft(id, documents);
  // The applicant's own name, not the tab's -- Profile (D) in the Sheet sync
  // panel (`sheet_applicant`), falling back to the tab's name only while that
  // is still blank, so two unconfigured tabs still never collide.
  const applicantName = user ? user.sheet_applicant || user.name : undefined;
  const result = await fileSubmission(id, { company, jobTitle, jobUrl, documents, date, profile: applicantName });
  return res.status(result.ok ? 201 : 500).json({
    ok: result.ok,
    id,
    mode: 'auto',
    status: result.record.status,
    sent_status: result.record.sent_status,
    dir: result.record.dir_path,
    files: FILED_KINDS.reduce((files, kind) => {
      if (result.record[`${kind}_path`]) files[kind] = result.record[`${kind}_path`];
      return files;
    }, {}),
    error: result.error,
  });
});

/**
 * Has this posting already been taken?
 *
 *   POST /get-item  { company, job_title, user? }
 *     -> { code: 200, msg: 'already exist' }
 *     -> { code: 401, msg: 'not exist' }
 *
 * The verdict is the `code` in the body; the HTTP status stays 200 so a caller
 * reads one place for the answer and never has to treat a normal "no" as a
 * transport failure. `record` rides along for callers that want to know what
 * was found -- a rejected posting is still a posting that was seen before.
 *
 * `user` is the tab name, the same string /save-data files the job under.
 * When it is sent, only that tab counts: the same company and title on
 * another tab is somebody else's application, so this one is still new. A
 * blank `user` means the unassigned records, and a tab that does not exist
 * yet holds nothing. Without `user` at all, every tab is searched.
 */
app.post('/get-item', (req, res) => {
  const company = String(req.body?.company || '').trim();
  const jobTitle = String(req.body?.job_title || '').trim();

  if (!company || !jobTitle) {
    return res.status(400).json({ code: 400, msg: 'company and job_title are required' });
  }

  let userId;
  if (req.body && Object.hasOwn(req.body, 'user')) {
    const userName = String(req.body.user || '').trim();
    if (userName) {
      const user = store.getUserByName(userName);
      if (!user) return res.json({ code: 401, msg: 'not exist' });
      userId = user.id;
    } else {
      userId = null;
    }
  }

  const record = store.findByJob(company, jobTitle, userId);
  if (!record) return res.json({ code: 401, msg: 'not exist' });

  return res.json({
    code: 200,
    msg: 'already exist',
    record: {
      id: record.id,
      company: record.company,
      job_title: record.job_title,
      job_url: record.job_url,
      status: record.status,
      dir_path: record.dir_path,
      user_id: record.user_id,
      created_at: record.created_at,
    },
  });
});

/**
 * The resume page the PDF is drawn from, as HTML.
 *
 *   POST /api/resume/preview  { SUMMARY, SKILLS, EXPERIENCE }
 *
 * Same input the resume field of /save-data takes. Useful for checking the
 * wording in a browser, and for printing the page directly if you want the
 * browser's own rendering rather than the PDF.
 */
app.post('/api/resume/preview', (req, res) => {
  res.type('html').send(resumeHtml(req.body || {}));
});

/* --- review ---------------------------------------------------------------- */

app.post('/api/records/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const record = store.get(id);
  if (!record) return res.status(404).json({ ok: false, error: 'No such record' });
  if (record.status !== 'pending' && record.status !== 'failed') {
    return res.status(409).json({ ok: false, error: `Record is already ${record.status}` });
  }
  const draft = store.getDraft(id);
  if (!draft) return res.status(410).json({ ok: false, error: 'The submitted documents are no longer held' });

  // The applicant's own name, not the tab's -- Profile (D), falling back to
  // the tab's name only while that is still blank. See the matching comment
  // in /save-data above.
  const approvingUser = record.user_id ? store.getUser(record.user_id) : null;
  const result = await fileSubmission(id, {
    company: record.company,
    jobTitle: record.job_title,
    jobUrl: record.job_url,
    documents: draft,
    // The day the application was made, which for an imported row is not today.
    date: submittedDate(record.created_at),
    profile: approvingUser ? approvingUser.sheet_applicant || approvingUser.name : undefined,
  });
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/api/records/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const record = store.get(id);
  if (!record) return res.status(404).json({ ok: false, error: 'No such record' });
  store.dropDraft(id);
  const updated = store.markRejected(id);
  pushRecord(updated);
  res.json({ ok: true, record: updated });
});

/* --- sheet status ------------------------------------------------------------
   Every record starts unsent. The dashboard is what talks to the Apps Script
   Web App -- the server never does -- so it reports back here once a send comes
   back OK, and the record carries the answer from then on. */

app.post('/api/records/:id/sent', (req, res) => {
  const id = Number(req.params.id);
  if (!store.get(id)) return res.status(404).json({ ok: false, error: 'No such record' });

  // `{ sent: false }` puts a row back to unsent, for a row that has to go again.
  const sent = req.body?.sent !== false;

  // `user_id` is the tab that sent it, which is not always the tab the record
  // is filed under: a tab sharing its Country (C) and Role can send it too,
  // with its own Profile (D) and Country (C), and that send is that tab's
  // sheet status, not the record's own. Left out, it is the record's own.
  let userId = null;
  if (req.body?.user_id != null) {
    userId = Number(req.body.user_id);
    if (!store.getUser(userId)) return res.status(404).json({ ok: false, error: 'No such tab' });
  }

  const record = store.markSent(id, sent, userId);
  pushRecord(record);
  const by = userId != null && userId !== record.user_id ? ` by ${store.getUser(userId).name}` : '';
  console.log(`[${sent ? 'sent' : 'unsent'}] #${id} ${record.company}${by}`);
  res.json({ ok: true, record });
});

/* --- users --------------------------------------------------------------------
   One row per tab the archive tracks -- a country a human is applying from,
   shown in the dashboard as a tab, each with its own Automatic/Human-check
   preference and its own Profile (D), Country (C) and Role values -- and, as
   a profile the extension writes resumes for, its own prompt, master resume
   and resume style, which the extension reads and saves here. Broadcasting every create/update
   as its own SSE event, the same way a record change is, is what keeps two
   open dashboards from disagreeing about a tab's settings until one of them
   happens to refetch. Sheet-sync's Web App URL, Sheet URL, Sheet tab name and
   secret are not here -- they are one setting for the whole archive, below. */

const userJson = (user) => ({
  id: user.id,
  name: user.name,
  auto: Boolean(user.auto),
  created_at: user.created_at,
  sheet: {
    applicant: user.sheet_applicant,
    // Column C on the sheet -- its own value, not the tab's name.
    country: user.sheet_region,
    // The tab's job function. Not on the sheet: tabs sharing it and Country
    // (C) list each other's applications in the dashboard.
    role: user.sheet_role,
  },
  // What the extension writes this profile's resumes with, set from its
  // Profile screen. A blank prompt or style is the extension's own default.
  resume: {
    prompt: user.gpt_prompt,
    masterResume: user.master_resume,
    masterResumeMode: user.master_resume_mode === 'none' ? 'none' : 'use',
    style: user.resume_style,
    // The body of the emails Recruiter Bid sends for this profile.
    summary: user.summary || '',
  },
});

const pushUser = (user) => broadcast('user', { user: userJson(user) });

/**
 * The emails Recruiter Bid has sent. The extension saves each one here once
 * Gmail has confirmed it, and reads the addresses back to skip those
 * recruiters on the next import.
 */
app.get('/api/recruiter-sends', (_req, res) => {
  res.json({ ok: true, sends: store.listRecruiterSends() });
});

app.post('/api/recruiter-sends', (req, res) => {
  const body = req.body || {};
  if (!String(body.email_address || '').trim()) {
    return res.status(400).json({ ok: false, error: 'email_address is required' });
  }
  res.status(201).json({ ok: true, send: store.addRecruiterSend(body) });
});

app.get('/api/users', (_req, res) => {
  res.json({ users: store.listUsers().map(userJson) });
});

app.post('/api/users', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

  // A human typing a name into the "+" tab is almost certainly a typo'd dupe
  // if it already exists -- unlike a live submission naming a tab, which
  // treats the same collision as the normal, expected case (findOrCreateUser).
  if (store.getUserByName(name)) {
    return res.status(409).json({ ok: false, error: `A tab named "${name}" already exists` });
  }

  const user = store.createUser(name, { auto: config.autoByDefault });
  pushUser(user);
  console.log(`[tab] created "${user.name}"`);
  res.status(201).json({ ok: true, user: userJson(user) });
});

app.patch('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!store.getUser(id)) return res.status(404).json({ ok: false, error: 'No such tab' });

  const body = req.body || {};
  const patch = {};

  // A rename gets the same collision check tab creation does -- a human
  // renaming Alex to an existing tab's name is almost certainly a mistake,
  // not a request to merge the two.
  if ('name' in body) {
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name cannot be blank' });
    const collision = store.getUserByName(name);
    if (collision && collision.id !== id) {
      return res.status(409).json({ ok: false, error: `A tab named "${name}" already exists` });
    }
    patch.name = name;
  }

  if ('auto' in body) patch.auto = Boolean(body.auto);
  if ('applicant' in body) patch.applicant = body.applicant;
  if ('country' in body) patch.country = body.country;
  if ('role' in body) patch.role = body.role;
  if ('prompt' in body) patch.prompt = body.prompt;
  if ('masterResume' in body) patch.masterResume = body.masterResume;
  if ('masterResumeMode' in body) patch.masterResumeMode = body.masterResumeMode === 'none' ? 'none' : 'use';
  if ('resumeStyle' in body) patch.resumeStyle = body.resumeStyle;
  if ('summary' in body) patch.summary = String(body.summary ?? '');

  const user = store.updateUser(id, patch);
  pushUser(user);
  res.json({ ok: true, user: userJson(user) });
});

/**
 * A tab can only be deleted once nothing is attributed to it. There is no
 * "move these elsewhere" step to fall back on -- Unassigned is not a tab a
 * human can browse to sort them from -- so the safe rule is: the human deletes
 * (or reassigns, once that exists) the applications first, with the delete
 * and delete-selected controls the table already has, and only then can the
 * now-empty tab go.
 */
app.delete('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = store.getUser(id);
  if (!user) return res.status(404).json({ ok: false, error: 'No such tab' });

  const count = store.countRecordsForUser(id);
  if (count > 0) {
    return res.status(409).json({
      ok: false,
      error: `${count} application${count === 1 ? '' : 's'} still on this tab — delete them first`,
    });
  }

  store.deleteUser(id);
  broadcast('user_removed', { id });
  console.log(`[tab] deleted "${user.name}"`);
  res.json({ ok: true, id });
});

/* --- sheet settings -------------------------------------------------------
   Where every tab's "Send to sheet" sends a row -- one Web App URL, one
   Google Sheet, one sheet tab name and one secret for the whole archive, not
   a set per tab. Broadcast the same way a user update is, so two open
   dashboards -- on different tabs or the same one -- never disagree about
   where a row just sent actually went. */

const pushSheetSettings = () => broadcast('sheet_settings', { sheetSettings: store.getSheetSettings() });

app.get('/api/sheet-settings', (_req, res) => {
  res.json({ sheetSettings: store.getSheetSettings() });
});

app.patch('/api/sheet-settings', (req, res) => {
  const body = req.body || {};
  const patch = {};
  // `secret` is not on any form -- the dashboard only ever shows it baked into
  // a generated script -- but is still accepted here the way a user's own
  // secret always has been, for the rare direct fix (recovering the one this
  // archive already has a live deployment tied to, say).
  for (const key of ['webAppUrl', 'sheetUrl', 'sheetTabName', 'secret']) {
    if (key in body) patch[key] = body[key];
  }
  const sheetSettings = store.updateSheetSettings(patch);
  pushSheetSettings();
  res.json({ ok: true, sheetSettings });
});

/* --- deleting ---------------------------------------------------------------
   Two scopes -- one record, or the whole log -- and each can take the stored
   PDFs with it or leave them on disk. Deleting files is opt-in per request
   rather than implied, because the record is a note and the PDF is the work. */

const wantsFiles = (req) => /^(1|true|yes)$/i.test(String(req.query.files ?? req.body?.files ?? ''));

/**
 * `?user_id=` is the tab the delete was made on. A tab the record is shared
 * into -- same Country (C) and Role -- deletes only its own part of it: the
 * record leaves that tab's list and that tab's sheet status for it goes, while
 * the record, its files and the tab it is filed under keep everything. That
 * answers with `hidden` rather than `ids`, and every dashboard hears it as an
 * ordinary record update. Left out, or the record's own tab, it is deleted.
 */
app.delete('/api/records/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = store.get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'No such record' });

  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  if (userId != null && userId !== existing.user_id) {
    const tab = store.getUser(userId);
    if (!tab) return res.status(404).json({ ok: false, error: 'No such tab' });
    const record = store.hideFor(id, userId);
    console.log(`[removed] #${id} ${record.company} from "${tab.name}" — still on its own tab`);
    pushRecord(record);
    return res.json({ ok: true, ids: [], hidden: [id], filesRemoved: 0 });
  }

  const record = store.remove(id);

  const removed = wantsFiles(req) ? await removeFiles(filesOf(record), config.dataRoot) : [];
  console.log(`[deleted] #${id} ${record.company}${removed.length ? ` and ${removed.length} file(s)` : ''}`);
  pushRemoved([id], removed.length);
  res.json({ ok: true, ids: [id], filesRemoved: removed.length });
});

app.delete('/api/records', async (req, res) => {
  const records = store.removeAll();
  if (records.length === 0) return res.json({ ok: true, ids: [], filesRemoved: 0 });

  let removed = [];
  if (wantsFiles(req)) {
    for (const record of records) removed = removed.concat(await removeFiles(filesOf(record), config.dataRoot));
  }
  const ids = records.map((record) => record.id);
  console.log(`[deleted] ${ids.length} record(s)${removed.length ? ` and ${removed.length} file(s)` : ''}`);
  pushRemoved(ids, removed.length);
  res.json({ ok: true, ids, filesRemoved: removed.length });
});

/* --- reading --------------------------------------------------------------- */

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, dataRoot: config.dataRoot, uptimeSec: Math.round(process.uptime()) }));

app.get('/api/state', (_req, res) => res.json(snapshot()));

app.get('/api/records', (req, res) => {
  // `limit=0` or `limit=all` is the whole log; anything else caps at that many.
  const asked = String(req.query.limit ?? '');
  const limit = /^(0|all)$/i.test(asked) ? 0 : Number(asked) || 200;
  res.json({ records: store.list({ status: req.query.status, limit, order: req.query.order }) });
});

app.get('/api/records/:id', (req, res) => {
  const record = store.get(Number(req.params.id));
  if (!record) return res.status(404).json({ ok: false, error: 'No such record' });
  const draft = store.getDraft(record.id);
  res.json({
    record,
    // Preview text only -- the dashboard shows what is about to be filed, not
    // the raw markup.
    preview: draft
      ? { job_des: excerpt(draft.job_des), cover: excerpt(draft.cover), resume: excerpt(draft.resume) }
      : null,
  });
});

/** Open a filed PDF straight from the archive. */
app.get('/api/records/:id/file/:kind', (req, res) => {
  const record = store.get(Number(req.params.id));
  if (!record) return res.status(404).json({ ok: false, error: 'No such record' });
  if (!FILED_KINDS.includes(req.params.kind)) {
    return res.status(400).json({ ok: false, error: 'Unknown document' });
  }

  const file = record[`${req.params.kind}_path`];
  if (!file || !fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'No such file' });

  const name = file.split(/[\\/]/).pop();
  // Not every document is a PDF: the resume is also filed as a .docx, and an
  // older archive may hold the resume as the page itself.
  const type = /\.html?$/i.test(name)
    ? 'text/html; charset=utf-8'
    : /\.docx$/i.test(name)
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf';
  res.setHeader('Content-Type', type);
  // A .docx is downloaded rather than displayed; the browser has no view for it.
  const disposition = /\.docx$/i.test(name) ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(name)}"`);
  fs.createReadStream(file).pipe(res);
});

/**
 * Every address this machine answers on, loopback aside -- printed at startup
 * so the address to put in the dashboard's config is on screen rather than
 * looked up with ipconfig.
 */
const networkAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((face) => face && face.family === 'IPv4' && !face.internal)
    .map((face) => face.address);

const server = app.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  if (config.host === '0.0.0.0') {
    for (const address of networkAddresses()) {
      console.log(`[server] on the network http://${address}:${config.port}`);
    }
  }
  console.log(`[store]  ${config.dataRoot}`);
  console.log(`[db]     ${config.dbFile}`);
  console.log(`[users]  ${store.listUsers().length} tab(s)`);
});

// The usual way this fails is a second copy started while the first still
// runs -- say that, rather than an unhandled-error stack trace.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[server] port ${config.port} is already in use on ${config.host}.`);
    console.error(`[server] The backend is probably already running in another window -- check`);
    console.error(`[server] http://localhost:${config.port}/api/health, or close that window and start again.`);
  } else {
    console.error(`[server] could not start: ${error.message}`);
  }
  store.close();
  process.exit(1);
});

const shutdown = () => {
  console.log('\n[server] shutting down');
  for (const client of clients) client.end();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
