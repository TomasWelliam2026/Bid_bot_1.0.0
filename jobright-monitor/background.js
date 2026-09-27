// Service worker: opens the feed tab, guarantees a live content script in it,
// and persists everything the panel streams so the panel can be reopened
// without losing the list.

const ORIGINS = ["https://jobright.ai", "https://www.jobright.ai"];
const TARGET = `${ORIGINS[0]}/jobs/recommend`;
const RECOMMEND_PATTERNS = ORIGINS.map((o) => `${o}/jobs/recommend*`);

// The job boards Auto can fetch from, picked in the panel. Each has the page
// a run opens, the tabs that count as that page, and the content script that
// reads it — both scripts answer the same messages, so everything after the
// feed tab is shared.
const DICE_SEARCH_URL =
  "https://www.dice.com/jobs?countryCode=US&filters.employmentType=FULLTIME" +
  "&filters.workplaceTypes=Remote&latitude=38.7945952&location=United+States" +
  "&locationPrecision=Country&longitude=-106.5348379&q=data+engineer";

const GLASSDOOR_SEARCH_URL =
  "https://www.glassdoor.com/Job/remote-data-engineer-jobs-SRCH_IL.0,6_IS11047_KO7,20.htm" +
  "?locId=11047&locT=S&remoteWorkType=1";

const SOURCES = {
  jobright: { name: "Jobright", url: TARGET, patterns: RECOMMEND_PATTERNS, script: "content.js" },
  dice: { name: "Dice", url: DICE_SEARCH_URL, patterns: ["https://www.dice.com/jobs*"], script: "content-dice.js" },
  glassdoor: {
    name: "Glassdoor",
    url: GLASSDOOR_SEARCH_URL,
    patterns: ["https://www.glassdoor.com/Job/*"],
    script: "content-glassdoor.js"
  }
};

// Every board's list page — Stop and Clear reach whichever one is open.
const FEED_PATTERNS = Object.values(SOURCES).flatMap((s) => s.patterns);

// A job carries the board it came from; Jobright's cards predate the field.
const sourceOf = (job) => SOURCES[job?.source] || SOURCES.jobright;

const feedTabIds = async () =>
  (await chrome.tabs.query({ url: FEED_PATTERNS })).map((t) => t.id).filter((id) => typeof id === "number");
// A run collects at most this many, so the store holds the most recent run.
// Keep in step with MAX_ITEMS in content.js and sidepanel.js.
const MAX_STORED = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The toolbar button opens the panel directly — there is no popup.
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(enableActionOpensPanel);
chrome.runtime.onStartup.addListener(enableActionOpensPanel);

async function enableActionOpensPanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Chrome older than the side panel API; nothing to fall back to.
  }
}

// ---------------------------------------------------------------------------
// Storage
//
// JOB_FOUND messages arrive in bursts, and each one is a read-modify-write of
// the same key. Run them through one promise chain so a burst cannot
// interleave two reads and lose jobs.
// ---------------------------------------------------------------------------

let writeQueue = Promise.resolve();
const serialize = (fn) => (writeQueue = writeQueue.then(fn, fn));

async function addJob(job) {
  return serialize(async () => {
    const { jobs = [] } = await chrome.storage.local.get("jobs");
    if (jobs.some((j) => j.key === job.key)) return jobs.length;

    jobs.push(job);
    const trimmed = jobs.slice(-MAX_STORED);
    await chrome.storage.local.set({ jobs: trimmed });
    await setBadge(trimmed.length);
    return trimmed.length;
  });
}

// Merges a detail reading onto an already-stored job. Goes through the same
// queue as addJob so a detail write cannot land between another write's read
// and set.
async function updateJob(key, patch) {
  return serialize(async () => {
    const { jobs = [] } = await chrome.storage.local.get("jobs");
    const i = jobs.findIndex((j) => j.key === key);
    if (i === -1) return;
    jobs[i] = { ...jobs[i], ...patch };
    await chrome.storage.local.set({ jobs });
  });
}

// ---------------------------------------------------------------------------
// Resume styles
//
// Each style is a whole template file. They are interchangeable: every one
// carries the same holes the builder fills — the header (h1.name, .title,
// .contact), #summary, #skills, and a <div class="job"> the builder copies once
// per role — and differs only in how the page looks. Adding a style is a file plus a line here plus an <option> in
// sidepanel.html; no other code changes.
//
// Declared above the profile because PROFILE_DEFAULTS reads the default from
// it, and a const is not hoisted.
// ---------------------------------------------------------------------------

const RESUME_STYLES = {
  "DE-1": "resume_temples/resume-template-DE-1.html",
  "SF-1": "resume_temples/resume-template-sf1.html",
  "SF-2": "resume_temples/resume-template-sf2.html"
};

const DEFAULT_RESUME_STYLE = "DE-1";

// Styles added from the panel with "Style add". An extension cannot write into
// its own install directory at runtime, so the chosen file's HTML is kept in
// chrome.storage.local instead, keyed by style name: { name: { file, html } }.
// They sit alongside RESUME_STYLES and are used exactly like them.
async function getCustomStyles() {
  const { customStyles = {} } = await chrome.storage.local.get("customStyles");
  return customStyles;
}

const listCustomStyles = (styles) =>
  Object.entries(styles).map(([name, s]) => ({ name, file: s.file }));

// The holes buildResumeHtml cannot do without, matched the same way — a file
// missing one would build a resume with that part silently left out. The
// header is not required: a style without it keeps its own.
function missingHoles(html) {
  const missing = [];
  if (!/<p[^>]*id="summary"[^>]*>[\s\S]*?<\/p>/.test(html)) missing.push('<p id="summary">');
  if (!/<div[^>]*id="skills"[^>]*>[\s\S]*?<\/div>/.test(html)) missing.push('<div id="skills">');
  // A fresh RegExp: JOB_BLOCK_RE is global, and .test on it would carry
  // lastIndex over from one call to the next.
  if (!new RegExp(JOB_BLOCK_RE.source).test(html)) {
    missing.push('<div class="job"> holding a <ul data-exp="0">');
  }
  return missing;
}

async function addCustomStyle(name, file, html) {
  name = String(name || "").trim().slice(0, 40);
  if (!name) throw new Error("the style needs a name");
  if (Object.hasOwn(RESUME_STYLES, name)) {
    throw new Error(`"${name}" is a built-in style — rename the file`);
  }
  const missing = missingHoles(String(html || ""));
  if (missing.length) throw new Error(`the file has no ${missing.join(", ")}`);

  const styles = await getCustomStyles();
  const replaced = Object.hasOwn(styles, name);
  styles[name] = { file: String(file || ""), html: String(html) };
  await chrome.storage.local.set({ customStyles: styles });
  return { name, replaced, styles: listCustomStyles(styles) };
}

async function removeCustomStyle(name) {
  const styles = await getCustomStyles();
  delete styles[name];
  await chrome.storage.local.set({ customStyles: styles });

  // A profile left pointing at the removed style goes back to the default,
  // rather than quietly falling back on every job.
  const profile = await getProfile();
  if (profile.resumeStyle === name) await setProfile({ resumeStyle: DEFAULT_RESUME_STYLE });
  return { styles: listCustomStyles(styles), profile: await getProfile() };
}

// ---------------------------------------------------------------------------
// Profile — the OpenAI key, model and prompt set under ChatGPT setting.
//
// The key lives in chrome.storage.local, which is not encrypted: anyone with
// access to this Chrome profile's directory can read it. That is the same
// exposure as any extension holding a key, but it is worth knowing, and it is
// why the key is never sent anywhere except api.openai.com.
// ---------------------------------------------------------------------------

// Nothing is appended to the prompt at send time, so the default has to carry
// the output format itself — otherwise a fresh install produces answers the
// builder cannot read.
const PROFILE_DEFAULTS = {
  apiKey: "",
  model: "gpt-4o-mini",

  // Which country this profile's applications are filed under in the shared
  // archive — sent with every save so the dashboard puts it on that tab.
  // Blank leaves it off every tab there rather than guessing.
  countryName: "",

  // Which template the resume is laid out with — a key of RESUME_STYLES.
  // Every style is filled from the same answer, so switching is purely
  // cosmetic and takes effect on the next job generated.
  resumeStyle: DEFAULT_RESUME_STYLE,

  // The candidate's full resume, sent with every job so the tailored one is
  // built from real experience rather than from the job description alone.
  masterResume: "",

  prompt: [
    "You are an expert resume writer. Given the job description and the master",
    "resume below, write a tailored resume and a cover letter for the job.",
    "Use only experience found in the master resume — never invent employers,",
    "titles, dates or achievements.",
    "",
    "Return ONLY JavaScript source, no prose and no code fence, in exactly this form:",
    "",
    "const resume = {",
    '  "CONTACT": ["Full name", "Headline title", "City, ST ZIP", "phone", "email", "https://linkedin.com/in/…"],',
    '  "SUMMARY": "one paragraph",',
    '  "SKILLS": ["Label: a, b, c"],',
    '  "EXPERIENCE": [',
    '    ["Company", "Job title", "Location", "Start – End", "bullet", "bullet"]',
    "  ],",
    '  "CERTIFICATIONS": ["Certification name"],',
    '  "EDUCATION": [',
    '    ["School", [["Degree", "Field of study"]], "Year"]',
    "  ]",
    "};",
    'const coverletter = "the cover letter for this job, plain text";',
    "",
    "EXPERIENCE holds one array per role, most recent first, 3 to 7 roles. Each",
    "starts with the company, the job title, the location and the dates, then the bullets.",
    "EDUCATION holds one array per school; its middle item lists every degree earned",
    "there. CERTIFICATIONS is [] when the master resume lists none.",
    "Use double-quoted strings and keys. Plain text only — no HTML, no markdown."
  ].join("\n")
};

async function getProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  return { ...PROFILE_DEFAULTS, ...(profile || {}) };
}

async function setProfile(patch) {
  const profile = { ...(await getProfile()), ...patch };
  await chrome.storage.local.set({ profile });
  return profile;
}

// ---------------------------------------------------------------------------
// Theme — light by default; dark is an explicit choice the panel saves here,
// not a system-preference follow.
// ---------------------------------------------------------------------------

const DEFAULT_THEME = "light";

async function getTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  return theme === "dark" ? "dark" : DEFAULT_THEME;
}

async function setTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  await chrome.storage.local.set({ theme: next });
  return next;
}

async function clearJobs() {
  return serialize(async () => {
    await chrome.storage.local.set({ jobs: [] });
    await setBadge(0);
  });
}

async function setBadge(count) {
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
}

// ---------------------------------------------------------------------------
// Tab handling
// ---------------------------------------------------------------------------

// Arms the listeners *before* reading tab.status, so a tab that finishes
// loading between the two cannot leave us waiting for an event that already
// fired.
function waitForComplete(tabId, timeoutMs = 30000, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };

    // Stop has to interrupt the wait, not merely be noticed after it: a page
    // that never finishes loading would otherwise hold the queue for the full
    // timeout after the user asked it to stop.
    const onAbort = () => finish(new Error(STOPPED));
    if (signal?.aborted) return finish(new Error(STOPPED));
    signal?.addEventListener("abort", onAbort, { once: true });

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(new Error("the feed tab was closed while loading"));
    };
    const timer = setTimeout(() => finish(new Error("the feed tab timed out loading")), timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete") finish();
      },
      () => finish(new Error("the feed tab no longer exists"))
    );
  });
}

// Reuses an already-open recommend tab; the site is behind a login, so reusing
// it keeps the session warm and avoids tab churn.
//
// The tab is focused rather than opened in the background on purpose: the list
// is virtualized, and a backgrounded tab throttles timers and may not mount
// offscreen rows at all, which would stall the harvest.
async function openFeedTab(source = SOURCES.jobright) {
  const tabs = await chrome.tabs.query({ url: source.patterns });
  const existing = tabs.find((t) => typeof t.id === "number");

  if (existing) {
    // A Dice or Glassdoor tab on some other search is sent to the configured one.
    const onTarget = source === SOURCES.jobright || existing.url === source.url;
    await chrome.tabs.update(existing.id, onTarget ? { active: true } : { active: true, url: source.url });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    if (!onTarget || existing.status !== "complete") await waitForComplete(existing.id);
    feedTabId = existing.id;
    return existing.id;
  }

  const tab = await chrome.tabs.create({ url: source.url, active: true });
  await waitForComplete(tab.id);
  feedTabId = tab.id;
  return tab.id;
}

// ---------------------------------------------------------------------------
// Reaching the content script
//
// "Could not establish connection. Receiving end does not exist." means no
// content script is listening in that tab. Causes, all of them live here:
//
//   1. The extension was reloaded or updated while the tab was already open —
//      the old script is dead and a new one was never injected.
//   2. The page was reached by SPA navigation. jobright.ai is Next.js, so
//      arriving at /jobs/recommend from another route is a pushState, not a
//      document load, and never triggers injection.
//   3. The document reached "complete" but the script had not registered its
//      listener yet — "complete" and run_at:document_idle are different
//      instants.
//   4. The tab is on www.jobright.ai, outside the match patterns.
//
// (2) and (4) are handled in the manifest, which matches the whole site on
// both hosts. (1) and (3) are handled here: ping first, inject when nothing
// answers, retry while the page settles.
// ---------------------------------------------------------------------------

async function ping(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return reply?.ok === true;
  } catch {
    return false; // no receiving end (yet)
  }
}

async function ensureContentScript(tabId, { attempts = 5, gapMs = 300, signal, script = "content.js" } = {}) {
  if (await ping(tabId)) return;

  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new Error(STOPPED);
    try {
      // Both content scripts no-op on re-injection, so injecting a tab that
      // already has one costs nothing and cannot double up the stream.
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: [script]
      });
    } catch (err) {
      lastError = err; // navigated mid-inject, or not an injectable page
    }

    if (await ping(tabId)) return;
    await sleep(gapMs * (i + 1));
  }

  throw new Error(
    "the job board tab is not responding" +
      (lastError ? ` (injection failed: ${lastError.message})` : "") +
      " — try reloading it"
  );
}

async function tell(tabId, message, script) {
  await ensureContentScript(tabId, { script });
  return chrome.tabs.sendMessage(tabId, message);
}

// ---------------------------------------------------------------------------
// The detail pass
//
// Each caught card's URL is opened in its own tab, switched to, read, and
// closed. Focusing the tab also makes the read more reliable: a backgrounded
// tab can defer rendering, so a detail page that is never shown may not paint
// the block we are waiting for.
//
// The cost is that the browser visibly walks through jobs while the queue
// drains. Set FOCUS_DETAIL_TABS to false to go back to reading them out of
// sight.
//
// One at a time, with a gap between visits. This is someone's site being
// opened once per job, and a burst of parallel tabs would be both rude and
// slower in practice.
// ---------------------------------------------------------------------------

const FOCUS_DETAIL_TABS = true;

// Marker for "the user pressed Stop", so an interrupted job is reported as
// stopped rather than as a failure the user has to worry about.
const STOPPED = "stopped by user";
const wasStopped = (err) => (err?.message || String(err)) === STOPPED;

const DETAIL_GAP_MS = 700;
const DETAIL_LOAD_TIMEOUT = 25000;

// The POST happens here rather than in the content script on purpose. A
// content script's fetch runs against the page's own origin, so posting to
// localhost from jobright.ai would be a cross-origin request needing CORS
// headers on your server. The service worker fetches as the extension, and a
// host permission covers it with no CORS involvement.
//
// Note the manifest grants "http://localhost/*", not ".../localhost:4500/*" —
// Chrome match patterns cannot carry a port, and the portless form covers
// every port on that host.
const API_BASE = "http://localhost:4500";
const CHECK_ENDPOINT = `${API_BASE}/get-item`;
const SAVE_ENDPOINT = `${API_BASE}/save-data`;
const SAVE_TIMEOUT_MS = 10000;

const queue = [];
const queued = new Set(); // keys ever enqueued, so a re-scan cannot double-visit
let draining = false;
let visitEnabled = true;
let saveEnabled = true;
let visitedCount = 0;
let savedCount = 0;
let skippedCount = 0; // already in the collector, so never sent
let generatedCount = 0;
let feedTabId = null; // the recommendations tab, used as the detail tabs' opener

// One controller per run. Stop aborts it, which unblocks every await in the
// queue at once — the page load being waited on, the scrape reply, and the
// POST — instead of letting the current job run to completion first.
let runAbort = null;
const runSignal = () => runAbort?.signal;

function beginRun() {
  runAbort?.abort();
  runAbort = new AbortController();
}

function abortRun() {
  runAbort?.abort();
  runAbort = null;
}

// ---------------------------------------------------------------------------
// Stage one: the duplicate filter
//
// Every card the feed finds is a candidate. The collector is asked about it
// before anything else happens, and only a job it does not already have is
// stored, shown in the list, and passed to the work queue below. A job the
// collector has is dropped outright — never stored, never listed, never
// opened.
//
// This is its own queue rather than a step inside drain(), because the two run
// at completely different speeds. A /get-item call is a localhost round trip;
// a visit is a page load plus a generation. Tying the list to the slow queue
// would fill it one row every half-minute instead of as fast as the feed finds
// cards.
// ---------------------------------------------------------------------------

const checkQueue = [];
const checked = new Set(); // candidates ever filtered, so a re-scan cannot re-ask
let checking = false;
let acceptedCount = 0;

function enqueueCheck(job) {
  if (!job?.key || checked.has(job.key)) return;
  checked.add(job.key);
  checkQueue.push(job);
  drainChecks();
}

async function drainChecks() {
  if (checking) return;
  checking = true;

  try {
    while (checkQueue.length) {
      const signal = runSignal();
      if (signal?.aborted) break;

      // The list is full; further candidates are not worth asking about.
      if (acceptedCount >= MAX_STORED) {
        checkQueue.length = 0;
        break;
      }

      const job = checkQueue.shift();

      // Only meaningful while saving is on: with it off the collector holds
      // nothing, so every candidate is new.
      const check = saveEnabled
        ? await checkExisting(job, signal)
        : { ok: true, exists: false };

      if (check.stopped) {
        checked.delete(job.key);
        checkQueue.unshift(job);
        break;
      }

      if (check.exists) {
        skippedCount++;
        queueStatus();
        continue; // dropped: not stored, not shown, not opened
      }

      acceptedCount++;
      await addJob(job);
      broadcast({ type: "JOB_ADDED", job });

      // A check that failed rides along, so the panel can say the job was
      // saved without a working duplicate check.
      enqueue(check.error ? { ...job, checkError: check.error } : job);
      tellFeed({ type: "ACCEPTED", count: acceptedCount });
    }
  } finally {
    checking = false;
    queueStatus();
  }
}

// Tells the feed tab how many candidates have survived the filter, so it knows
// whether it still needs to scroll for more.
async function tellFeed(message) {
  if (feedTabId === null) return;
  await chrome.tabs.sendMessage(feedTabId, message).catch(() => {});
}

function enqueue(job) {
  if (!visitEnabled || !job?.href || queued.has(job.key)) return;
  queued.add(job.key);
  queue.push(job);
  drain();
}

function broadcast(message) {
  // Only the panel listens; it is closed most of the time, and "no receiving
  // end" is the expected outcome, not an error.
  chrome.runtime.sendMessage(message).catch(() => {});
}

function queueStatus(extra = {}) {
  broadcast({
    type: "DETAIL_STATUS",
    status: {
      draining,
      pending: queue.length,
      visited: visitedCount,
      saved: savedCount,
      skipped: skippedCount,
      accepted: acceptedCount,
      checking: checkQueue.length,
      generated: generatedCount,
      ...extra
    }
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  queueStatus();

  try {
    while (queue.length && visitEnabled) {
      const signal = runSignal();
      if (signal?.aborted) break;

      const job = queue.shift();
      queueStatus({ current: job.title });

      // Everything here has already cleared the duplicate filter, so this
      // stage is only the slow work: open, read, generate, save.
      let detail;
      try {
        detail = await visitJob(job, signal);
      } catch (err) {
        detail = wasStopped(err)
          ? { ok: false, stopped: true }
          : { ok: false, error: err?.message || String(err) };
      }

      // Only non-LinkedIn jobs are saved — a LinkedIn origin ends the pass at
      // the closed tab, with nothing read and nothing sent.
      if (saveEnabled && detail.ok && !detail.isLinkedIn) {
        queueStatus({ current: `${job.title} — writing resume` });
        const profile = await getProfile();
        detail.resume = await generateResume(profile, detail, signal);
        if (detail.resume.ok) generatedCount++;

        // Nothing is sent unless the resume actually built. A job that fails
        // here is deliberately left unsaved rather than stored half-done —
        // which also means /get-item still reports it missing, so the next
        // run picks it up and tries again.
        if (detail.resume.ok) {
          detail.save = await saveJob(job, detail, signal, profile);
          if (detail.save.ok) savedCount++;
          // The duplicate check that let this job through did not answer
          // cleanly — worth surfacing, but not worth withholding the job over.
          if (job.checkError) detail.save.checkError = job.checkError;
        }
      }

      // A job interrupted mid-read is not a result. Leave the record clean and
      // put it back at the front so a later Start picks it up where it left
      // off, rather than storing a half-reading.
      // Interrupted during the read, or during its POST — either way there is
      // no complete result to store.
      // It stays in `queued` — it is still spoken for, just back at the front.
      if (detail.stopped || detail.resume?.stopped || detail.save?.stopped) {
        queue.unshift(job);
        break;
      }

      visitedCount++;
      await updateJob(job.key, { detail });
      broadcast({ type: "JOB_DETAIL", key: job.key, detail });

      // Politeness toward jobright.ai for having opened a page. Duplicates
      // never reach this queue, so every job here did open one.
      if (queue.length && !signal?.aborted) await sleep(DETAIL_GAP_MS);
    }
  } finally {
    draining = false;
    queueStatus({ drained: true });
  }
}

// POSTs one job to the local collector. Never throws: a save failure is a
// reportable outcome shown against that job in the panel, not something that
// should stop the queue.
// Both endpoints are reached the same way, so the request itself lives here.
// Two things should make it give up: a dead localhost port that would hang it
// open and stall the queue, and the user pressing Stop.
async function postJson(url, body, signal) {
  const timeout = AbortSignal.timeout(SAVE_TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abort
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null; // not JSON; the status still tells us what happened
  }
  return { res, data };
}

function describeFetchError(err, url) {
  return err?.name === "TimeoutError" || err?.name === "AbortError"
    ? `no response in ${SAVE_TIMEOUT_MS / 1000}s`
    : `${err?.message || err} — is ${url} running?`;
}

// Asks the collector whether it already holds this job, by company and title.
//
// Only the exact answer { code: 200, msg: "already exist" } suppresses the
// save. Anything else — a different code, a different message, a non-200, or
// no reply at all — is treated as "not a duplicate", so the check failing open
// can never silently cost you a job.
async function checkExisting(job, signal) {
  try {
    const { res, data } = await postJson(
      CHECK_ENDPOINT,
      { company: job.company, job_title: job.title },
      signal
    );

    const exists = res.ok && data?.code === 200 && data?.msg === "already exist";
    return { ok: true, exists };
  } catch (err) {
    if (signal?.aborted) return { ok: false, stopped: true, exists: false };
    return { ok: false, exists: false, error: describeFetchError(err, CHECK_ENDPOINT) };
  }
}

// ---------------------------------------------------------------------------
// Building the resume document
//
// The resume template — one file per style in RESUME_STYLES, picked under
// ChatGPT setting — carries only the layout. Every word comes from the answer:
// the header from CONTACT, the summary, the skills lines, one job block per
// EXPERIENCE entry drawn from the template's first job block as the pattern,
// one edu-item per EDUCATION entry and one cert-item per CERTIFICATIONS entry
// the same way. 3 to 7 roles is the expected range; any count builds. With no
// certifications, the template's cert-section is removed.
//
// The template renders itself in a browser from a `resume` global. What is
// built here is the same output with the data already baked in and every
// <script> removed, so the stored document is static: no JavaScript, nothing
// to load, prints and converts to PDF anywhere. Editing the template edits the
// resume — no code change needed.
// ---------------------------------------------------------------------------

// One entry per style that has actually been used, so switching styles mid-run
// does not re-read a file that was already read.
const templateCache = new Map();

// An unknown style — a value stored by an older build, or one whose file was
// removed — falls back to the default rather than failing the job. Losing the
// chosen layout is a much smaller loss than losing the resume.
//
// An added style is read from storage every time rather than cached, so
// replacing it with a new file takes effect on the very next job.
async function loadTemplate(style) {
  if (!Object.hasOwn(RESUME_STYLES, style)) {
    const custom = (await getCustomStyles())[style];
    if (custom?.html) return custom.html;
  }

  const key = Object.hasOwn(RESUME_STYLES, style) ? style : DEFAULT_RESUME_STYLE;
  if (templateCache.has(key)) return templateCache.get(key);

  const file = RESUME_STYLES[key];
  // A file missing from the extension folder rejects with "Failed to fetch"
  // rather than answering 404 — typically the templates were moved and the
  // extension is still running the code from before.
  const unreadable = `could not read ${file} — check it exists, then reload the extension in chrome://extensions`;
  let res;
  try {
    res = await fetch(chrome.runtime.getURL(file));
  } catch {
    throw new Error(unreadable);
  }
  if (!res.ok) throw new Error(unreadable);

  const text = await res.text();
  templateCache.set(key, text);
  return text;
}

// Model output is text of unknown shape going into a document that gets stored
// and rendered elsewhere. Escaping it is what keeps a stray "<" from breaking
// the markup — or worse, closing a tag and injecting into the page.
const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// One role's block: from <div class="job"> through its bullet list and the
// closing tag after it. Every block in the template matches; the first one is
// the pattern each role is drawn from, and all of them are replaced.
const JOB_BLOCK_RE =
  /<div[^>]*class="job"[^>]*>[\s\S]*?<ul[^>]*data-exp="\d+"[^>]*>[\s\S]*?<\/ul>\s*<\/div>/g;

// Replaces the text inside the first element carrying `cls` among its classes,
// whatever its tag. Returns the input unchanged when there is no such element,
// so a style that leaves one out (SF-1 has no .title) simply does not show it.
const fillClass = (html, cls, inner) =>
  html.replace(
    new RegExp(`(<(\\w+)[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>)[\\s\\S]*?(<\\/\\2>)`),
    (_m, open, _tag, close) => `${open}${inner}${close}`
  );

// Index just past the closing tag of the element that opens at `start`,
// counting nested elements of the same tag — an edu-item in SF-1 holds a div
// of its own — or -1 if it never closes.
function elementEnd(html, start) {
  const tag = /^<(\w+)/.exec(html.slice(start, start + 20))[1];
  const re = new RegExp(`<${tag}\\b|<\\/${tag}>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m; (m = re.exec(html)); ) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

// Every outermost element carrying `cls` among its classes, as {start, end}.
function findByClass(html, cls) {
  const items = [];
  const re = new RegExp(`<\\w+[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>`, "g");
  for (let m; (m = re.exec(html)); ) {
    const end = elementEnd(html, m.index);
    if (end === -1) break;
    items.push({ start: m.index, end });
    re.lastIndex = end;
  }
  return items;
}

// Same idea as the job blocks: the first element with class `cls` is the
// pattern, `fill` makes one copy of it per entry, and every element with that
// class is replaced by the copies. Returns null when the template has none,
// so the caller can keep what it has.
function repeatByClass(html, cls, entries, fill) {
  const items = findByClass(html, cls);
  if (!items.length) return null;

  const { start } = items[0];
  const end = items[items.length - 1].end;
  const pattern = html.slice(start, items[0].end);
  const indent = html.slice(html.lastIndexOf("\n", start) + 1, start);

  const out = entries.map((e) => fill(pattern, e)).join(`\n${indent}`);
  return html.slice(0, start) + out + html.slice(end);
}

// "Bachelor of Science (B.S.), Business Data Analytics".
const degreeText = (d) => [d.degree, d.field].filter(Boolean).join(", ");

// The school's first .degree line is itself a pattern: one copy per degree
// earned there, each on its own line under the school. A school listed with
// no degree loses the line rather than showing the template's sample.
const fillEducation = (html, entries) =>
  repeatByClass(html, "edu-item", entries, (pattern, e) => {
    let h = pattern;
    h = fillClass(h, "school", escapeHtml(e.school));
    h = fillClass(h, "year", escapeHtml(e.year));
    return e.degrees.length
      ? repeatByClass(h, "degree", e.degrees, (line, d) => fillClass(line, "degree", escapeHtml(degreeText(d)))) ?? h
      : removeByClass(h, "degree");
  });

// A cert-item holding a .cert-name gets the name there; one that is just the
// name (DE-1's list item) gets it directly.
const fillCertifications = (html, certs) =>
  repeatByClass(html, "cert-item", certs, (pattern, name) =>
    fillClass(pattern, /class="cert-name"/.test(pattern) ? "cert-name" : "cert-item", escapeHtml(name))
  );

// Drops every element with class `cls`, and the line it sat on if it leaves
// that line blank.
function removeByClass(html, cls) {
  for (const { start, end } of findByClass(html, cls).reverse()) {
    const lineStart = html.lastIndexOf("\n", start - 1);
    const before = html.slice(lineStart + 1, start);
    html = /^\s*$/.test(before) ? html.slice(0, lineStart) + html.slice(end) : html.slice(0, start) + html.slice(end);
  }
  return html;
}

const bulletsHtml = (bullets) => bullets.map((b) => `      <li>${escapeHtml(b)}</li>`).join("\n");

function jobHtml(pattern, entry, index) {
  let html = pattern;
  html = fillClass(html, "company", escapeHtml(entry.company));
  html = fillClass(html, "role", escapeHtml(entry.role));
  if (/class="location"/.test(html)) {
    html = fillClass(html, "location", escapeHtml(entry.location));
    html = fillClass(html, "dates", escapeHtml(entry.dates));
    // One of the two missing: drop the separator so neither dangles.
    if (!entry.location || !entry.dates) html = html.replace(/<span class="sep">[\s\S]*?<\/span>/, "");
  } else {
    // A style whose meta line is one element gets both in it.
    html = fillClass(html, "meta", escapeHtml([entry.location, entry.dates].filter(Boolean).join(" | ")));
  }
  return html.replace(
    /(<ul[^>]*data-exp=")\d+("[^>]*>)[\s\S]*?(<\/ul>)/,
    (_m, head, tail, close) =>
      entry.bullets.length
        ? `${head}${index}${tail}\n${bulletsHtml(entry.bullets)}\n    ${close}`
        : `${head}${index}${tail}${close}`
  );
}

// A contact entry that is a profile link rather than text. Shown as a short
// label ("LinkedIn") rather than the whole URL, as the templates always did.
const isLink = (s) => /^https?:\/\//i.test(s) || /^(www\.)?[\w-]+\.(com|io|dev|me)\//i.test(s);

function linkHtml(url) {
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const label = /linkedin\.com/i.test(url)
    ? "LinkedIn"
    : /github\.com/i.test(url)
      ? "GitHub"
      : url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

// CONTACT is [name, headline title, ...the rest of the header line]. The rest
// goes on the template's contact line, in the order given, joined with the
// separator the template already uses there. A style with a second
// "contact links" line (SF-1) gets the links there instead.
function fillContact(html, contact) {
  const [name, title, ...rest] = contact;

  if (name) {
    html = html.replace(
      /(<h1[^>]*class="name"[^>]*>)[\s\S]*?(<\/h1>)/,
      (_m, open, close) => `${open}${escapeHtml(name)}${close}`
    );
    html = html.replace(
      /(<title>)[\s\S]*?(<\/title>)/,
      (_m, open, close) => `${open}${escapeHtml(title ? `${name} - ${title}` : name)}${close}`
    );
  }
  if (title) html = fillClass(html, "title", escapeHtml(title));

  if (!rest.length) return html;

  const contactRe = /(<p[^>]*class="contact"[^>]*>)([\s\S]*?)(<\/p>)/;
  const linksRe = /(<p[^>]*class="contact links"[^>]*>)([\s\S]*?)(<\/p>)/;
  const sep = html.match(contactRe)?.[2].match(/<span class="sep">[\s\S]*?<\/span>/)?.[0] ||
    '<span class="sep">|</span>';

  const splitLinks = linksRe.test(html);
  const main = rest
    .filter((s) => !splitLinks || !isLink(s))
    .map((s) => (isLink(s) ? linkHtml(s) : escapeHtml(s)));

  html = html.replace(contactRe, (_m, open, _inner, close) => `${open}\n    ${main.join(sep)}\n  ${close}`);
  if (splitLinks) {
    const links = rest.filter(isLink).map(linkHtml);
    html = html.replace(linksRe, (_m, open, _inner, close) => `${open}${links.join(sep)}${close}`);
  }
  return html;
}

// Mirrors what the template's own script does, so the baked output matches
// what a browser would have rendered: text before the first ":" is the label.
//
// The colon is its own <span> rather than the tail of the label, which is what
// lets SF-1 put it in a column of its own so every colon lines up. Inline —
// which is how DE-1 renders it — label, colon and value still read as one
// "Label: a, b, c", so the split costs that style nothing.
function skillsHtml(lines) {
  return lines
    .map((line) => {
      const i = String(line).indexOf(":");
      if (i === -1) return `    <p>${escapeHtml(line)}</p>`;
      const label = escapeHtml(String(line).slice(0, i));
      const rest = escapeHtml(String(line).slice(i + 1).trim());
      return (
        `    <p><span class="label">${label}</span>` +
        `<span class="colon">:</span> ${rest}</p>`
      );
    })
    .join("\n");
}

function buildResumeHtml(template, data) {
  const warnings = [];

  // Every script goes: the data is baked into the markup, the template's
  // renderer has nothing left to do, and a stored document with no JavaScript
  // in it is a much safer thing to hand around. First, so none of the regexes
  // below can match something written inside that renderer.
  let html = template.replace(/<script\b[^>]*>[\s\S]*?<\/script>\s*/gi, "");

  html = html.replace(
    /(<p[^>]*id="summary"[^>]*>)([\s\S]*?)(<\/p>)/,
    (_m, open, _inner, close) => `${open}${escapeHtml(data.SUMMARY)}${close}`
  );

  html = html.replace(
    /(<div[^>]*id="skills"[^>]*>)([\s\S]*?)(<\/div>)/,
    (_m, open, _inner, close) => `${open}\n${skillsHtml(data.SKILLS)}\n  ${close}`
  );

  if (data.CONTACT.length) html = fillContact(html, data.CONTACT);
  else warnings.push("no CONTACT in the answer — header kept from the template");

  const count = data.EXPERIENCE.length;
  if (count < 3 || count > 7) warnings.push(`${count} role(s) in EXPERIENCE — expected 3 to 7`);
  data.EXPERIENCE.forEach((e, i) => {
    if (!e.company || !e.role || !e.location || !e.dates) {
      warnings.push(`role ${i + 1} is missing its company, title, location or dates`);
    }
    if (!e.bullets.length) warnings.push(`no bullets for role ${i + 1}${e.company ? ` (${e.company})` : ""}`);
  });

  if (data.EDUCATION.length) {
    // Said out loud: a school that arrives with no degree builds without one,
    // and that is otherwise easy to miss until the PDF is read.
    data.EDUCATION.forEach((e, i) => {
      if (!e.degrees.length) warnings.push(`no degree for school ${i + 1}${e.school ? ` (${e.school})` : ""}`);
    });
    const filled = fillEducation(html, data.EDUCATION);
    if (filled) html = filled;
    else warnings.push('template has no <div class="edu-item"> — education kept from the template');
  } else {
    warnings.push("no EDUCATION in the answer — education kept from the template");
  }

  // Unlike education, none is a normal answer — plenty of resumes have no
  // certifications — so the section goes rather than keeping the template's
  // sample ones.
  if (data.CERTIFICATIONS.length) {
    const filled = fillCertifications(html, data.CERTIFICATIONS);
    if (filled) html = filled;
    else warnings.push('template has no class="cert-item" — certifications left out');
  } else {
    html = removeByClass(removeByClass(html, "cert-section"), "cert-item");
  }

  const blocks = [...html.matchAll(JOB_BLOCK_RE)];
  if (blocks.length) {
    // Everything from the first job block to the end of the last is replaced
    // by one copy of the first per role, indented as the first one was.
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    const start = first.index;
    const end = last.index + last[0].length;
    const indent = html.slice(html.lastIndexOf("\n", start) + 1, start);
    const jobs = data.EXPERIENCE.map((e, i) => jobHtml(first[0], e, i)).join(`\n\n${indent}`);
    html = html.slice(0, start) + jobs + html.slice(end);
  } else {
    // A style added from a file that predates job blocks: no pattern to copy,
    // so its own employer lines stay and only the bullets are filled, by slot.
    warnings.push('template has no <div class="job"> block — employer lines kept from the template');
    html = html.replace(/(<ul[^>]*data-exp="(\d+)"[^>]*>)([\s\S]*?)(<\/ul>)/g, (_m, open, n, _inner, close) => {
      const bullets = data.EXPERIENCE[Number(n)]?.bullets || [];
      return bullets.length ? `${open}\n${bulletsHtml(bullets)}\n    ${close}` : `${open}${close}`;
    });
  }

  return { html, warnings };
}


// ---------------------------------------------------------------------------
// Reading the model's answer
//
// The answer is JavaScript source, in the shape of the template's data.js:
//
//   const resume = { "CONTACT": […], "SUMMARY": …, "SKILLS": […],
//                    "EXPERIENCE": [[company, title, location, dates, …bullets]],
//                    "CERTIFICATIONS": [name, …],
//                    "EDUCATION": [[school, [[degree, field], …], year]] };
//   const coverletter = "…";
//
// It is *parsed*, never run. MV3 forbids eval and new Function outright, and
// running text a model wrote would be a bad idea even where it is allowed.
// So the two declarations are located and read as literals.
//
// Models are not disciplined about this, so the scanner tolerates what they
// actually emit: fences with prose either side, comments, bare keys, single
// quotes, apostrophes inside single quotes, typographic quotes, trailing
// commas, a comma dropped between two strings, `undefined`, and "a" + "b"
// concatenation.
//
// What it will not do is invent an answer that has no resume object in it.
// That is a prompt problem rather than a parsing one, and the error says so in
// as many words — the two get fixed in different places.
// ---------------------------------------------------------------------------

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

// What can open a string, and what closes it. The typographic pairs are here
// because models slip into smart quotes when a value reads like prose, and a
// curly quote is not worth losing a job over.
const QUOTES = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’"
};

// Bare words a model writes where JSON needs a value.
const BARE_VALUES = {
  true: "true",
  false: "false",
  null: "null",
  undefined: "null",
  NaN: "null",
  Infinity: "null"
};

// `//` and `/* */`, wherever the source is scanned. Skipping them is not
// cosmetic: a comment like "// Jane's summary" inside the object would
// otherwise open a string on the apostrophe and swallow the rest of the
// answer. Returns the index just past the comment, or -1 if there is none.
function skipComment(src, i) {
  if (src[i] !== "/") return -1;
  if (src[i + 1] === "/") {
    const nl = src.indexOf("\n", i + 2);
    return nl === -1 ? src.length : nl;
  }
  if (src[i + 1] === "*") {
    const close = src.indexOf("*/", i + 2);
    return close === -1 ? src.length : close + 2;
  }
  return -1;
}

// A single quote is ambiguous: models write 'the company's team' and mean an
// apostrophe, not a terminator. So inside single quotes a closing quote only
// counts where a string could actually end.
function closesValue(src, i) {
  // Spaces and tabs only. A newline is itself an end — a single-quoted string
  // cannot span lines in valid JS, so a quote at end of line is a terminator
  // even with no punctuation after it.
  let k = i + 1;
  while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
  return k >= src.length || ",}];:\n\r".includes(src[k]);
}

// Reads the string literal starting at `start` and returns its value plus the
// index of the closing quote.
function readStringLiteral(src, start) {
  const open = src[start];
  const close = QUOTES[open] ?? open;
  const ambiguous = open === "'";
  let value = "";

  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];

    if (c === "\\") {
      const n = src[++i];
      if (n === "u") {
        value += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
        i += 4;
      } else if (n === "x") {
        value += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (n !== "\n") {
        value += ESCAPES[n] ?? n; // \" \' \` \\ \/ and anything unrecognised
      }
      continue;
    }

    if (c === close && (!ambiguous || closesValue(src, i))) return { value, end: i };

    value += c;
  }
  throw new Error("unterminated string in the model's answer");
}

// Matches the bracket at `start`, stepping over strings and comments — a brace
// inside either must not throw the count off.
function findMatchingBracket(src, start) {
  let depth = 0;

  for (let i = start; i < src.length; i++) {
    const past = skipComment(src, i);
    if (past !== -1) {
      i = past - 1;
      continue;
    }

    const c = src[i];
    if (QUOTES[c]) {
      i = readStringLiteral(src, i).end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

// A JS object literal is not quite JSON. This rewrites the differences models
// actually produce, in one string-aware pass so nothing inside a string is
// touched.
function normalizeToJson(src) {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const past = skipComment(src, i);
    if (past !== -1) {
      i = past;
      continue;
    }

    const c = src[i];

    if (QUOTES[c]) {
      const first = readStringLiteral(src, i);
      let text = first.value;
      i = first.end + 1;

      // "a" + "b": JSON has no concatenation, so fold it away here.
      for (;;) {
        let k = i;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] !== "+") break;
        k++;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (!QUOTES[src[k]]) break;

        const next = readStringLiteral(src, k);
        text += next.value;
        i = next.end + 1;
      }

      out += JSON.stringify(text); // re-emits as a valid JSON string

      // "a"\n"b": a string followed straight by another is a dropped comma —
      // models lose one at the end of a line — so put it back.
      let k = i;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (QUOTES[src[k]]) out += ",";
      continue;
    }

    // A bare word is a key when a colon follows; otherwise it is a value like
    // true/false/null — or undefined/NaN, which JSON cannot hold at all.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);

      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;

      out += src[k] === ":" ? JSON.stringify(word) : BARE_VALUES[word] ?? word;
      i = j;
      continue;
    }

    if (c === ",") {
      let k = i + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === "}" || src[k] === "]") {
        i++; // trailing comma
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

function parseObjectLiteral(literal) {
  try {
    return JSON.parse(literal);
  } catch {
    try {
      return JSON.parse(normalizeToJson(literal));
    } catch {
      return null;
    }
  }
}

// A fence around the whole answer, or one buried in prose either side of it.
const stripFence = (raw) => {
  const whole = raw.match(/^\s*```(?:js|javascript|json)?\s*\r?\n([\s\S]*?)\r?\n?```\s*$/i);
  if (whole) return whole[1];
  const inner = raw.match(/```(?:js|javascript|json)?\s*\r?\n([\s\S]*?)```/i);
  return inner ? inner[1] : raw;
};

// Index just past `<name> =`, or -1. Covers const/let/var, `export const`, and
// the `window.` / `globalThis.` forms models reach for.
function declarationValueAt(src, name) {
  const re = new RegExp(
    "(?:^|[;\\s])(?:(?:const|let|var)\\s+|(?:window|globalThis|self)\\s*\\.\\s*)?" +
      name +
      "\\s*=\\s*",
    "m"
  );
  const m = re.exec(src);
  if (!m) return -1;
  let i = m.index + m[0].length;
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function parseModelAnswer(raw) {
  const src = stripFence(String(raw));

  let coverletter = null;
  const ci = declarationValueAt(src, "coverletter");
  if (ci !== -1 && QUOTES[src[ci]]) {
    coverletter = readStringLiteral(src, ci).value.trim() || null;
  }

  let data = null;
  let declared = false;

  const ri = declarationValueAt(src, "resume");
  if (ri !== -1 && src[ri] === "{") {
    declared = true;
    const end = findMatchingBracket(src, ri);
    if (end !== -1) data = parseObjectLiteral(src.slice(ri, end + 1));
  }

  // Tolerated: the whole answer is a bare object rather than a declaration.
  if (!data && !declared) {
    const trimmed = src.trim();
    if (trimmed.startsWith("{")) data = parseObjectLiteral(trimmed);
  }

  if (!data) {
    // Two different problems, fixed in two different places, so they get two
    // different messages.
    throw new Error(
      declared
        ? "found `const resume` but could not read its object"
        : "the answer has no `const resume = { … }` — the prompt has to ask for it"
    );
  }

  if (typeof data.SUMMARY !== "string" || !data.SUMMARY.trim()) {
    throw new Error("the answer has no SUMMARY string");
  }

  // A cover letter written as a key of the object instead of its own const.
  if (!coverletter && typeof data.coverletter === "string") {
    coverletter = data.coverletter.trim() || null;
  }

  const strings = (a) =>
    Array.isArray(a) ? a.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean) : [];

  // Each role is [company, title, location, dates, ...bullets]; split here so
  // the builder and the panel read named parts, not positions.
  // Positional: a blank field keeps its place, so "" for the dates cannot
  // pull the first bullet into the dates slot.
  const fields = (a) => (Array.isArray(a) ? a.map((s) => (typeof s === "string" ? s.trim() : "")) : []);

  const EXPERIENCE = (Array.isArray(data.EXPERIENCE) ? data.EXPERIENCE : []).map((entry) => {
    const parts = fields(entry);
    // The older shape put both in one "location | dates" string. Recognised
    // by that separator and by what follows being a sentence, not a date.
    if (/\s\|\s/.test(parts[2] || "") && (parts[3] || "").length > 40) {
      const [location, dates] = parts[2].split(/\s\|\s/);
      parts.splice(2, 1, location.trim(), dates.trim());
    }
    const [company = "", role = "", location = "", dates = "", ...bullets] = parts;
    return { company, role, location, dates, bullets: bullets.filter(Boolean) };
  });

  // [degree, field] -> { degree, field }; a bare string is a degree alone.
  const degreeOf = (d) =>
    Array.isArray(d) ? { degree: fields(d)[0] || "", field: fields(d)[1] || "" } : { degree: String(d).trim(), field: "" };

  // A period: "2016", "2015 – 2018", "Aug 2016", "Expected May 2027",
  // "2019 - Present" — short, with a year or "present" in it. Also a bare
  // number, which a model may write for a year.
  const isPeriod = (v) =>
    typeof v === "number" ||
    (typeof v === "string" && v.trim().length <= 30 && /\b(?:19|20)\d{2}\b|\bpresent\b/i.test(v));

  // Each school is [school, [[degree, field], ...], year]. Models drift from
  // that, so the parts are found by what they are rather than where they sit:
  // the school is the first string, the period is the last item that reads as
  // one, and everything else is a degree — a [degree, field] pair, a list of
  // them, or a plain "degree" string. That reads the intended shape and also
  // [school, [d, f], [d, f], year], [school, year, [[d, f]]] and the older
  // [school, "degree", year].
  const EDUCATION = (Array.isArray(data.EDUCATION) ? data.EDUCATION : []).map((entry) => {
    const parts = Array.isArray(entry) ? [...entry] : [];
    const school = typeof parts[0] === "string" ? parts.shift().trim() : "";
    let at = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (isPeriod(parts[i])) {
        at = i;
        break;
      }
    }
    // Nothing reads as a date: fall back to where the shape puts it, the last
    // item, when that is a string after at least one degree.
    if (at === -1 && parts.length >= 2 && typeof parts[parts.length - 1] === "string") at = parts.length - 1;
    const year = at === -1 ? "" : String(parts.splice(at, 1)[0]).trim();

    const degrees = [];
    for (const p of parts) {
      if (Array.isArray(p) && p.some(Array.isArray)) degrees.push(...p.filter(Array.isArray));
      else if (Array.isArray(p) || (typeof p === "string" && p.trim())) degrees.push(p);
    }
    return {
      school,
      degrees: degrees.map(degreeOf).filter((d) => d.degree || d.field),
      year
    };
  });

  return {
    CONTACT: strings(data.CONTACT),
    SUMMARY: data.SUMMARY.trim(),
    SKILLS: strings(data.SKILLS),
    EXPERIENCE,
    EDUCATION,
    CERTIFICATIONS: strings(data.CERTIFICATIONS),
    coverletter
  };
}
// ---------------------------------------------------------------------------
// Resume generation
//
// Runs only for jobs /get-item said it does not have. Like the POSTs, this is
// made from the service worker: the key never touches the page, and there is
// no CORS to satisfy.
// ---------------------------------------------------------------------------

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
// Generation is much slower than a localhost round trip, so it gets its own
// budget rather than the 10s the collector calls use.
const GENERATE_TIMEOUT_MS = 120000;

async function generateResume(profile, detail, signal) {
  if (!profile.apiKey) {
    return { ok: false, skipped: true, error: "no API key set — open ChatGPT setting on the Generate tab" };
  }
  // The model is given the readable text, not the markup: the HTML is chrome
  // it would have to pay tokens to ignore. The markup still goes to job_des.
  const description = detail.descriptionText;
  if (!description) {
    return { ok: false, skipped: true, error: "no description was read from the page" };
  }

  let template;
  try {
    template = await loadTemplate(profile.resumeStyle);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  const timeout = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;

  // The prompt goes out exactly as it was typed — nothing is appended to it.
  // The user message carries the two inputs, each under its own heading so the
  // model cannot mistake the candidate's resume for part of the job posting.
  // With no master resume set, the job description goes out on its own.
  const masterResume = (profile.masterResume || "").trim();
  const userContent = masterResume
    ? `=== JOB DESCRIPTION ===\n${description}\n\n=== MASTER RESUME ===\n${masterResume}`
    : description;
  if (!masterResume) {
    console.warn("[jobright] no master resume set in ChatGPT setting — sending the job description only");
  }

  const messages = [
    { role: "system", content: profile.prompt },
    { role: "user", content: userContent }
  ];

  // Every outgoing request, logged in full, every time.
  //
  // This lands in the *service worker's* console, not the page's and not the
  // panel's: chrome://extensions → Jobright Live Feed → "Inspect views:
  // service worker".
  //
  // The API key is deliberately absent. It travels as an Authorization header
  // rather than in the body, and a console log is the easiest thing in the
  // world to screenshot into a bug report.
  // The model goes in the header line as text, not only inside the object —
  // it should be readable without expanding anything, and it survives a copy
  // out of the console.
  console.log(`[jobright] → OpenAI request · ${profile.model}`, { model: profile.model, messages });
  console.log("[jobright]   system message:\n" + messages[0].content);
  console.log("[jobright]   user message:\n" + messages[1].content);

  try {
    const res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${profile.apiKey}`
      },
      body: JSON.stringify({
        model: profile.model,
        // No response_format here: JSON mode would force a bare JSON object,
        // and the answer wanted is JavaScript source carrying two declarations.
        messages
      }),
      signal: abort
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      // OpenAI puts the useful part in error.message; the status alone is
      // rarely enough to tell a bad key from a bad model name.
      const detailMsg = data?.error?.message || res.statusText;
      return { ok: false, error: `HTTP ${res.status} — ${detailMsg}` };
    }

    const text = data?.choices?.[0]?.message?.content?.trim();

    // The reply, verbatim. Not asked for, but the request on its own only
    // tells you half of why a job failed to parse — remove this line if the
    // console gets too noisy.
    console.log("[jobright] ← OpenAI answer:\n" + (text || "(empty)"));

    if (!text) return { ok: false, error: "the model returned an empty answer" };

    let parsed;
    try {
      parsed = parseModelAnswer(text);
    } catch (err) {
      // Keep the raw answer on the result so a malformed reply can be read in
      // the panel instead of only being described.
      return { ok: false, error: err.message, raw: text };
    }

    const { html, warnings } = buildResumeHtml(template, parsed);
    if (!parsed.coverletter) warnings.push("no coverletter in the answer");

    return {
      ok: true,
      html,
      coverletter: parsed.coverletter,
      data: parsed,
      raw: text,
      warnings,
      model: data?.model || profile.model
    };
  } catch (err) {
    if (signal?.aborted) return { ok: false, stopped: true, error: STOPPED };
    return {
      ok: false,
      error:
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `no answer in ${GENERATE_TIMEOUT_MS / 1000}s`
          : isNetworkError(err)
            ? `could not reach OpenAI (${err.message}) — check the internet connection, VPN, proxy or firewall`
            : `${err?.message || err}`
    };
  }
}

// fetch() rejects with a bare TypeError when no response arrives at all —
// "Failed to fetch" in Chrome — which on its own does not say which request.
const isNetworkError = (err) =>
  err?.name === "TypeError" && /failed to fetch|networkerror|load failed/i.test(err.message);

// ---------------------------------------------------------------------------
// Test connection
//
// A fixed, minimal round trip to OpenAI — one user message, no prompt and no
// master resume involved — so a key and model can be checked from the panel
// directly, before Save and before a real job is ever spent on finding out
// the key is wrong. Takes apiKey/model as given rather than reading the saved
// profile, because the point is to test what is currently typed.
// ---------------------------------------------------------------------------

const TEST_MESSAGE =
  "Hello, GPT. can you receive this message? if you received data, reply OK or not reply NOT";
const TEST_TIMEOUT_MS = 20000;

async function testConnection(apiKey, model) {
  apiKey = String(apiKey || "").trim();
  model = String(model || "").trim();
  if (!apiKey) return { ok: false, error: "no API key given" };
  if (!model) return { ok: false, error: "no model given" };

  console.log(`[jobright] → OpenAI test · ${model}`, { model, message: TEST_MESSAGE });

  try {
    const res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: TEST_MESSAGE }]
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null; // not JSON; the status still tells us what happened
    }

    if (!res.ok) {
      const detailMsg = data?.error?.message || res.statusText;
      return { ok: false, error: `HTTP ${res.status} — ${detailMsg}` };
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    console.log("[jobright] ← OpenAI test reply:\n" + (reply || "(empty)"));
    if (!reply) return { ok: false, error: "the model returned an empty answer" };

    return { ok: true, reply, model: data?.model || model };
  } catch (err) {
    return {
      ok: false,
      error:
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `no response in ${TEST_TIMEOUT_MS / 1000}s`
          : `${err?.message || err}`
    };
  }
}

// ---------------------------------------------------------------------------
// Sending a job to the collector
// ---------------------------------------------------------------------------

// The cover letter goes out wrapped in a <textarea> so it drops straight into
// a form on the other side.
//
// Escaped on the way in. Textarea content is RCDATA: a literal "</textarea>"
// in the letter would close the element early and spill the rest as markup,
// and character references are decoded on parse, so escaping round-trips back
// to the original text.
const wrapCoverLetter = (text) =>
  text ? `<textarea>${escapeHtml(text)}</textarea>` : null;

async function saveJob(job, detail, signal, profile) {
  const payload = {
    job_url: job.href,
    job_des: detail.descriptionHtml,
    resume: detail.resume?.html ?? null,
    coverletter: wrapCoverLetter(detail.resume?.coverletter),
    company: job.company,
    job_title: job.title,
    // Which country tab this lands on in the shared archive. Blank leaves it
    // off every tab there rather than guessing.
    user: profile?.countryName || ""
  };

  try {
    const { res } = await postJson(SAVE_ENDPOINT, payload, signal);
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText}` };
  } catch (err) {
    if (signal?.aborted) return { ok: false, stopped: true, error: STOPPED };
    return { ok: false, error: describeFetchError(err, SAVE_ENDPOINT) };
  }
}

// ---------------------------------------------------------------------------
// A job typed in by hand
//
// Manual mode is the queue's pass -- duplicate check, generate, then save --
// with the two things visitJob would have read off the page handed over
// instead. As on the feed, a job the collector already holds stops at the
// check. Nothing here opens a tab or touches the feed, so it can be used
// while a run is streaming, and Stop (which aborts the run signal) does not
// reach it: this pass carries no signal, only generateResume's own timeout.
// ---------------------------------------------------------------------------

// The pasted text, as the markup /save-data stores in job_des. A scraped job
// arrives as the page's own HTML; typed text has none, so its blank lines are
// turned into paragraphs and its single newlines into breaks, escaped first so
// a posting that mentions a tag cannot inject one.
const manualDescriptionHtml = (text) =>
  text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");

// One at a time: a second Generate while the first is still with the model
// would spend the key twice on work the panel has nowhere to show.
let manualBusy = false;

async function generateManual(input) {
  const company = String(input?.company || "").trim();
  const title = String(input?.title || "").trim();
  const url = String(input?.url || "").trim();
  const description = String(input?.description || "").trim();

  if (!company || !title || !description) {
    return { ok: false, error: "company, job title and job description are all required" };
  }
  if (manualBusy) return { ok: false, error: "the last one is still being written" };

  manualBusy = true;
  try {
    // Asked before the model is, so a posting the collector already holds
    // costs no API call. A check that fails fails open, as on the feed: the
    // job goes ahead and the error is reported beside the result.
    const job = { href: url, company, title };
    const check = await checkExisting(job, undefined);
    if (check.exists) return { ok: true, duplicate: true, resume: null, save: null };

    broadcast({ type: "MANUAL_STATUS", stage: "generating" });
    const profile = await getProfile();
    const detail = {
      ok: true,
      descriptionFound: true,
      descriptionText: description,
      descriptionHtml: manualDescriptionHtml(description)
    };

    const resume = await generateResume(profile, detail, undefined);
    // Same rule as the queue: nothing is sent unless the resume built, so a
    // failed generation leaves the collector untouched rather than storing a
    // job with no documents against it.
    if (!resume.ok) return { ok: true, resume, save: null, checkError: check.error };
    detail.resume = resume;

    broadcast({ type: "MANUAL_STATUS", stage: "saving" });
    // Deliberately not counted into the queue's tally: that strip reports what
    // the feed run did, and a hand-typed job is not part of one.
    const save = await saveJob(job, detail, undefined, profile);

    return { ok: true, resume, save, duplicate: false, checkError: check.error };
  } finally {
    manualBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Opening a job
// ---------------------------------------------------------------------------

// Opened as the feed tab's child so that closing it hands focus back to the
// recommendations list rather than to whatever tab happens to sit next to it.
// The opener is optional — Chrome rejects it if that tab has since closed or
// moved to another window, and the visit is fine without it.
async function createDetailTab(url) {
  const base = { url, active: FOCUS_DETAIL_TABS };

  if (feedTabId !== null) {
    try {
      return await chrome.tabs.create({ ...base, openerTabId: feedTabId });
    } catch {
      feedTabId = null;
    }
  }
  return chrome.tabs.create(base);
}

async function visitJob(job, signal) {
  if (signal?.aborted) throw new Error(STOPPED);

  const tab = await createDetailTab(job.href);

  // Closing the tab is also what unblocks a pending scrape: sendMessage
  // rejects as soon as its receiver is gone, so Stop does not have to wait for
  // the page to answer.
  const closeNow = () => chrome.tabs.remove(tab.id).catch(() => {});
  signal?.addEventListener("abort", closeNow, { once: true });

  try {
    await waitForComplete(tab.id, DETAIL_LOAD_TIMEOUT, signal);
    await ensureContentScript(tab.id, { signal, script: sourceOf(job).script });
    const detail = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_DETAIL" });
    if (signal?.aborted) throw new Error(STOPPED);
    if (!detail || typeof detail !== "object") {
      throw new Error("no reading came back from the detail page");
    }
    return detail;
  } finally {
    signal?.removeEventListener("abort", closeNow);
    // Closed either way. The spec only calls for closing the tab on a LinkedIn
    // origin, but a tab opened to be read has no reason to outlive the read.
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Panel API
// ---------------------------------------------------------------------------

async function handle(msg) {
  switch (msg?.type) {
    case "GET_STATE": {
      const { jobs = [] } = await chrome.storage.local.get("jobs");
      return { ok: true, jobs };
    }

    // Opening the URL and starting the stream are one action, so the panel
    // only has to say "start".
    case "START": {
      // Only boards with a content script can be fetched from. The panel
      // keeps Start off for the others; this is the same rule where the work
      // happens.
      const sourceKey = msg.options?.source || "jobright";
      const source = SOURCES[sourceKey];
      if (!source) return { ok: false, error: `${sourceKey} is not supported yet — only Jobright, Dice and Glassdoor` };

      visitEnabled = msg.options?.visitJobs !== false;
      saveEnabled = msg.options?.saveJobs !== false;
      beginRun();

      const tabId = await openFeedTab(source);
      const reply = await tell(tabId, { type: "START_STREAM", options: msg.options }, source.script);

      // Anything left over from a previous Stop resumes now.
      tellFeed({ type: "ACCEPTED", count: acceptedCount });
      drainChecks();
      if (visitEnabled) drain();

      return { ok: true, tabId, visitEnabled, saveEnabled, endpoint: SAVE_ENDPOINT, ...reply };
    }

    // Everything in flight, at once: the feed tab's observer and scroll
    // harvest, the filter, the visit queue, the page load or scrape being
    // awaited, and the POST. The pending queue is kept rather than thrown
    // away, so a later Start carries on from where this left off.
    case "STOP": {
      visitEnabled = false;
      abortRun();

      // Every board's list tab, in case more than one is open.
      const stopped = await Promise.all(
        (await feedTabIds()).map((id) =>
          chrome.tabs.sendMessage(id, { type: "STOP_STREAM" }).then(() => true, () => false)
        )
      );
      const stoppedFeed = stopped.some(Boolean);

      queueStatus({ stopped: true });
      return { ok: true, stoppedFeed, pending: queue.length };
    }

    case "SET_VISIT":
      visitEnabled = !!msg.enabled;
      if (!visitEnabled) queue.length = 0;
      return { ok: true, visitEnabled };

    case "GET_PROFILE":
      return {
        ok: true,
        profile: await getProfile(),
        styles: listCustomStyles(await getCustomStyles())
      };

    case "ADD_STYLE":
      return { ok: true, ...(await addCustomStyle(msg.name, msg.file, msg.html)) };

    case "REMOVE_STYLE":
      return { ok: true, ...(await removeCustomStyle(msg.name)) };

    case "SET_PROFILE":
      return { ok: true, profile: await setProfile(msg.patch) };

    case "TEST_CONNECTION":
      return await testConnection(msg.apiKey, msg.model);

    case "GET_THEME":
      return { ok: true, theme: await getTheme() };

    case "SET_THEME":
      return { ok: true, theme: await setTheme(msg.theme) };

    case "SET_SAVE":
      saveEnabled = !!msg.enabled;
      return { ok: true, saveEnabled };

    // Manual mode's Generate. Runs the generate-and-save pass on typed input
    // and answers with both outcomes; it never throws, so the panel always has
    // something to report against the job.
    case "GENERATE_MANUAL":
      return generateManual(msg.job);

    case "CLEAR": {
      queue.length = 0;
      queued.clear();
      checkQueue.length = 0;
      checked.clear();
      acceptedCount = 0;
      tellFeed({ type: "ACCEPTED", count: 0 });
      visitedCount = 0;
      savedCount = 0;
      skippedCount = 0;
      generatedCount = 0;
      await clearJobs();

      // Forget, do not re-scan. Clear empties the list and leaves it empty;
      // dropping each tab's dedupe only makes sure the next Start can find
      // those cards again rather than treating them as already seen.
      for (const id of await feedTabIds()) {
        await chrome.tabs.sendMessage(id, { type: "FORGET" }).catch(() => {});
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "JOB_FOUND") {
    // A card the feed found is a candidate, not yet a caught item. The
    // collector is asked about it first; only what it does not already have
    // gets stored, shown, and queued for the real work.
    if (sender.tab) enqueueCheck(msg.job);
    return false;
  }
  if (msg?.type === "FEED_STATUS") return false;

  (async () => {
    let reply;
    try {
      reply = await handle(msg);
    } catch (err) {
      reply = { ok: false, error: err?.message || String(err) };
    }
    try {
      sendResponse(reply);
    } catch {
      // The panel can close mid-request, taking its port with it. Everything
      // is already in storage, so there is nothing to recover.
    }
  })();

  return true; // async reply
});
