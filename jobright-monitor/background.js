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

const ZIPRECRUITER_SEARCH_URL =
  "https://www.ziprecruiter.com/jobs-search?search=Full-time+Data+Engineer&location=United+States" +
  "&location_explicitly_set=true&radius=25&days=&refine_by_employment=employment_type%3Afull_time" +
  "&refine_by_location_type=only_remote&refine_by_salary=&refine_by_salary_ceil=" +
  "&refine_by_apply_type=has_zipapply&refine_by_experience_level=&apply_types_explicitly_set=true" +
  "&employment_types_explicitly_set=true&location_types_explicitly_set=true&lk=pM--mREKRcWpgbzqqaJUgQ";

const GLASSDOOR_SEARCH_URL =
  "https://www.glassdoor.com/Job/remote-data-engineer-jobs-SRCH_IL.0,6_IS11047_KO7,20.htm" +
  "?locId=11047&locT=S&remoteWorkType=1";

// `nextPage` boards are read one search page at a time, the pager's Next
// clicked once a page is done (see "the next page" below). A `scrollBatches`
// board is one long list: once a full list is done it is cleared and the
// feed scrolled on for more (see "the next batch").
const SOURCES = {
  jobright: { name: "Jobright", url: TARGET, patterns: RECOMMEND_PATTERNS, script: "content.js", scrollBatches: true },
  dice: {
    name: "Dice",
    url: DICE_SEARCH_URL,
    patterns: ["https://www.dice.com/jobs*"],
    script: "content-dice.js",
    searchUrl: (search) => diceSearchUrl(search),
    nextPage: true
  },
  glassdoor: {
    name: "Glassdoor",
    url: GLASSDOOR_SEARCH_URL,
    patterns: ["https://www.glassdoor.com/Job/*"],
    script: "content-glassdoor.js",
    searchUrl: (search) => glassdoorSearchUrl(search)
  },
  ziprecruiter: {
    name: "ZipRecruiter",
    url: ZIPRECRUITER_SEARCH_URL,
    patterns: ["https://www.ziprecruiter.com/jobs-search*"],
    script: "content-ziprecruiter.js",
    searchUrl: (search) => zipRecruiterSearchUrl(search),
    // Two-pane layout: clicking a card updates the right-hand pane in place
    // rather than navigating, so the job is read there — no tab of its own.
    readsInPane: true,
    // Each page's cards are finished before [aria-label="Next page"] is
    // clicked for the next one — see nextPageWhenDone.
    nextPage: true
  },
  // No fixed page: the search opened is the one the panel's search form asks
  // for, on that country's Indeed site — see indeedSearchUrl.
  indeed: {
    name: "Indeed",
    searched: true,
    patterns: ["https://*.indeed.com/jobs*"],
    script: "content-indeed.js",
    searchUrl: (search) => indeedSearchUrl(search),
    nextPage: true,
    // Each job is read on the search page, by clicking its card; no tab is
    // ever opened for one — see readInPane.
    readsInPane: true
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
const MAX_STORED = 30;

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
// sidepanel.html; no other code changes. Which one a resume uses is each
// profile's own choice — see writerFor.
// ---------------------------------------------------------------------------

const RESUME_STYLES = {
  "DE-1": "resume_temples/resume-template-DE-1.html",
  "SF-1": "resume_temples/resume-template-sf1.html",
  "SF-2": "resume_temples/resume-template-sf2.html",
  "DE-2": "resume_temples/resume-template-de2.html"
};

const DEFAULT_RESUME_STYLE = "DE-1";

// Styles added from the panel belong to the profile they were added under:
// a name and the template's HTML, typed or pasted into that profile's editor
// — not a file — and offered to that profile alone. The built-in
// RESUME_STYLES are every profile's. An extension cannot write into its own
// install directory at runtime, so the HTML is kept in chrome.storage.local
// instead, by profile id and style name: { [profileId]: { [name]: { html } } }.
async function getProfileStyles(profileId) {
  const { profileStyles = {} } = await chrome.storage.local.get("profileStyles");
  return profileStyles[profileId] || {};
}

async function setProfileStyles(profileId, styles) {
  const { profileStyles = {} } = await chrome.storage.local.get("profileStyles");
  profileStyles[profileId] = styles;
  await chrome.storage.local.set({ profileStyles });
}

const listCustomStyles = (styles) => Object.keys(styles).map((name) => ({ name }));

// Added styles used to be one list for the whole extension, under
// "customStyles". Each profile there is now given its own copy of that list,
// so every profile still has every style it could pick before; the shared
// list is then emptied, so this happens once. Profiles added to the dashboard
// later start with the built-in styles only.
async function migrateLegacyStyles(profiles) {
  const { customStyles } = await chrome.storage.local.get("customStyles");
  if (!customStyles || !Object.keys(customStyles).length || !profiles.length) return;
  const { profileStyles = {} } = await chrome.storage.local.get("profileStyles");
  for (const p of profiles) profileStyles[p.id] = { ...customStyles, ...(profileStyles[p.id] || {}) };
  await chrome.storage.local.set({ profileStyles, customStyles: {} });
}

// The holes buildResumeHtml cannot do without, matched the same way — a
// template missing one would build a resume with that part silently left out.
// The header is not required: a style without it keeps its own.
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

// A name already added to this profile replaces that style — the editor's
// Update.
async function addCustomStyle(profileId, name, html) {
  name = String(name || "").trim().slice(0, 40);
  if (!name) throw new Error("the style needs a name");
  if (Object.hasOwn(RESUME_STYLES, name)) {
    throw new Error(`"${name}" is a built-in style — pick another name`);
  }
  const missing = missingHoles(String(html || ""));
  if (missing.length) throw new Error(`the HTML has no ${missing.join(", ")}`);

  const styles = await getProfileStyles(profileId);
  const replaced = Object.hasOwn(styles, name);
  styles[name] = { html: String(html) };
  await setProfileStyles(profileId, styles);
  return { name, replaced, styles: listCustomStyles(styles) };
}

// A style's template as text, built-in or one of this profile's — what the
// profile's editor starts from when a listed style is copied into it.
async function getStyleHtml(profileId, name) {
  return { name, builtin: Object.hasOwn(RESUME_STYLES, name), html: await loadTemplate(name, profileId) };
}

async function removeCustomStyle(profileId, name) {
  const styles = await getProfileStyles(profileId);
  delete styles[name];
  await setProfileStyles(profileId, styles);

  // The profile, if it was using it, goes back to the default rather than
  // quietly falling back on every job. Best effort: with the collector
  // unreachable, loadTemplate's own fallback still covers it.
  const list = await listProfiles();
  const profile = list.ok && list.profiles.find((p) => p.id === profileId);
  if (profile?.resume?.style === name) await updateProfile(profileId, { resumeStyle: "" });
  return { styles: listCustomStyles(styles) };
}

// ---------------------------------------------------------------------------
// Settings — the OpenAI key and model set under ChatGPT setting, and the
// country and role picked under Profile.
//
// The prompt, master resume and resume style are not here: each profile has
// its own, kept on its dashboard tab — see Profiles below.
//
// The key lives in chrome.storage.local, which is not encrypted: anyone with
// access to this Chrome profile's directory can read it. That is the same
// exposure as any extension holding a key, but it is worth knowing, and it is
// why the key is never sent anywhere except api.openai.com.
// ---------------------------------------------------------------------------

const SETTINGS_DEFAULTS = {
  apiKey: "",
  model: "gpt-4o-mini",

  // Which profiles a caught job gets resumes for: every dashboard tab with
  // this Country (C) and this Role. Both are needed — blank picks none.
  country: "",
  role: ""
};

// The prompt a profile is written with until it is given its own. Nothing is
// appended to the prompt at send time, so it has to carry the output format
// itself — otherwise a fresh profile produces answers the builder cannot read.
const DEFAULT_PROMPT = [
    "You are an expert resume writer. Given the job description and the master",
    "resume below, write a tailored resume and a cover letter for the job.",
    "Use only experience found in the master resume — never invent employers,",
    "titles, dates or achievements.",
    "",
    "Return ONLY JavaScript source, no prose and no code fence, in exactly this form:",
    "",
    "const resume = {",
    '  "name": "Full name",',
    '  "title": "Headline title",',
    '  "contact": {',
    '    "email": "email",',
    '    "phone": "phone",',
    '    "linkedin": "https://linkedin.com/in/…",',
    '    "location": "City, ST ZIP"',
    "  },",
    '  "resume": {',
    '    "summary": "one paragraph",',
    '    "skills": ["Label: a, b, c"],',
    '    "experience": [',
    "      {",
    '        "company": "Company",',
    '        "position": "Job title",',
    '        "location": "Location",',
    '        "duration": "Start - End",',
    '        "content": ["bullet", "bullet"]',
    "      }",
    "    ],",
    '    "education": [',
    '      { "degree": "Degree in field of study", "school": "School", "year": "Year" }',
    "    ]",
    "  },",
    '  "cover_letter": "the cover letter for this job, plain text"',
    "};",
    "",
    "experience holds one object per role, most recent first, 3 to 7 roles.",
    "education holds one object per degree. Add \"certifications\": [\"Certification name\"]",
    "inside \"resume\" only when the master resume lists any.",
    "Use double-quoted strings and keys. Plain text only — no HTML, no markdown."
  ].join("\n");

// Stored under "profile", the name this object had when it held a single
// profile's prompt and master resume. A store written then still carries
// those, which migrateLegacySettings hands to the tab they belonged to.
async function getSettings() {
  const { profile } = await chrome.storage.local.get("profile");
  return { ...SETTINGS_DEFAULTS, ...(profile || {}) };
}

async function setSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ profile: settings });
  return settings;
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
// `url` is the search to open where it is not the board's fixed one (Indeed's).
async function openFeedTab(source = SOURCES.jobright, url = source.url) {
  const tabs = await chrome.tabs.query({ url: source.patterns });
  const existing = tabs.find((t) => typeof t.id === "number");

  if (existing) {
    // A Dice, Glassdoor, Indeed or ZipRecruiter tab on some other search is sent to the one asked for.
    const onTarget = source === SOURCES.jobright || existing.url === url;
    await chrome.tabs.update(existing.id, onTarget ? { active: true } : { active: true, url });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    if (!onTarget || existing.status !== "complete") await waitForComplete(existing.id);
    feedTabId = existing.id;
    return existing.id;
  }

  const tab = await chrome.tabs.create({ url, active: true });
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
// Waiting for a person: the human check
//
// Indeed sits behind Cloudflare, which sometimes shows a check — "Just a
// moment...", "Additional Verification Required", "Verify you are human" — in
// place of the page asked for. Only a person can pass it. A content script
// that finds one says so (`blocked` on its replies), and the run pauses
// there: the tab is brought to the front, the panel says what is needed, and
// the tab is looked at every few seconds. Once the page behind the check is
// showing, the run carries on from where it paused — the search page is
// streamed, the job page is read. Stop ends the wait, as it ends everything.
// ---------------------------------------------------------------------------

const VERIFY_POLL_MS = 2000;

// The check being waited on, for the panel: { tabId, page: "search" | "job",
// title, since }, or null.
let verifyPause = null;

function setVerifyPause(pause) {
  verifyPause = pause;
  broadcast({ type: "VERIFY_STATUS", pause });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (tab) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

// Whether the tab still shows the check. Passing it usually loads a new
// document, so a tab mid-load, or one whose fresh script has not answered
// yet, is neither — null — and is simply asked again next time.
async function stillBlocked(tabId, script) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== "complete") return null;
    await ensureContentScript(tabId, { script, attempts: 2 });
    const reply = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return reply?.ok ? reply.blocked === true : null;
  } catch {
    return null;
  }
}

async function waitForHumanCheck(tabId, script, signal, page, title = null) {
  setVerifyPause({ tabId, page, title, since: Date.now() });
  holdAwake();
  await focusTab(tabId);
  try {
    while (!signal?.aborted) {
      await sleep(VERIFY_POLL_MS);
      if (signal?.aborted) break;
      if (!(await chrome.tabs.get(tabId).catch(() => null))) {
        throw new Error("the tab was closed before the human check was passed");
      }
      if ((await stillBlocked(tabId, script)) === false) return;
    }
    throw new Error(STOPPED);
  } finally {
    setVerifyPause(null);
    releaseAwake();
  }
}

// A list tab that could not be carried on with — closed during a check, say —
// told to the panel in the status line, where the feed's own news goes.
function reportFeedError(err) {
  broadcast({ type: "FEED_STATUS", status: { streaming: false, error: err?.message || String(err) } });
}

// START_STREAM on a board's list tab, waiting out any human check in front of
// it first.
async function streamFeed(tabId, source, options, signal) {
  let reply = await tell(tabId, { type: "START_STREAM", options }, source.script);
  while (reply?.blocked) {
    await waitForHumanCheck(tabId, source.script, signal, "search");
    reply = await tell(tabId, { type: "START_STREAM", options }, source.script);
  }
  tellFeed({ type: "ACCEPTED", count: acceptedCount });
  return reply;
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
const USERS_ENDPOINT = `${API_BASE}/api/users`;
const SAVE_TIMEOUT_MS = 10000;

const queue = [];
const queued = new Set(); // keys ever enqueued, so a re-scan cannot double-visit
let draining = false;
// Search first, build after: the jobs caught wait in `queue` while the board
// is searched, and only once the search for this batch is over — the list is
// full, or the board has nothing more — are their resumes built, one after
// the other (see buildNow). Then the list is cleared and the next search
// begins.
let building = false;
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

// Keeping the worker alive
//
// Chrome stops an idle extension service worker after 30s, and a pending
// fetch() does not count as activity. Generation routinely takes longer than
// that, so without this the worker was killed mid-answer: the job stayed in
// the list, the resume never arrived, no error was ever reported, and the
// in-memory queue went with it. Any extension API call resets the idle timer,
// so a cheap one is made on an interval for as long as something long-running
// holds the worker. Counted, so the queue and a manual Generate can overlap.
const KEEPALIVE_MS = 20000;
let keepAliveHolds = 0;
let keepAliveTimer = null;

function holdAwake() {
  if (keepAliveHolds++ > 0) return;
  keepAliveTimer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo().catch(() => {});
    } catch {
      // Not available (e.g. a test harness) — nothing to keep alive there.
    }
  }, KEEPALIVE_MS);
}

function releaseAwake() {
  if (--keepAliveHolds > 0) return;
  keepAliveHolds = 0;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
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

      // The list is full. Every board goes on in batches: the candidates
      // still waiting are held for the next batch, which checks them first —
      // they are marked seen already, so dropping them would lose them for
      // good.
      if (acceptedCount >= MAX_STORED) break; // searched enough: built below

      const job = checkQueue.shift();

      // Asked once per profile picked in Settings: a job is new while any of
      // them does not have it yet. Only meaningful while saving is on: with it
      // off the collector holds nothing, so every candidate is new. Profiles
      // that cannot be read are no reason to drop a job — it goes ahead, and
      // the queue reports the same failure on its row.
      const selection = captureMode ? { ok: true, profiles: [] } : await selectedProfiles();
      const check = captureMode
        ? { ok: true, pending: null, existing: [] }
        : !selection.ok
        ? { ok: false, pending: null, existing: [], error: selection.error }
        : saveEnabled
          ? await checkExisting(job, signal, selection.profiles)
          : { ok: true, pending: selection.profiles, existing: [] };

      if (check.stopped) {
        checked.delete(job.key);
        checkQueue.unshift(job);
        break;
      }

      if (check.pending && !check.pending.length) {
        skippedCount++;
        queueStatus();
        continue; // every profile has it: not stored, not shown, not opened
      }

      acceptedCount++;
      await addJob(job);
      broadcast({ type: "JOB_ADDED", job });

      // Which profiles it is built for rides along to the queue, with the ones
      // that already have it and a check that failed, so the panel can say so.
      enqueue({
        ...job,
        ...(check.pending && { profileIds: check.pending.map((p) => p.id) }),
        ...(check.existing.length && { existingOn: check.existing }),
        ...(check.error && { checkError: check.error })
      });
      tellFeed({ type: "ACCEPTED", count: acceptedCount });
    }
  } finally {
    checking = false;
    if (acceptedCount >= MAX_STORED) buildNow();
    queueStatus();
    // A page whose cards were all already in the collector queues nothing,
    // so drain() never runs for it — this is where that page is finished.
    nextPageWhenDone();
    nextBatchWhenDone();
    nextTermWhenDone();
  }
}

// ---------------------------------------------------------------------------
// Dice and Indeed: the next page, once this one is done
//
// On a nextPage board a run works one search page at a time. When every card found on the
// page has been through the filter and every job it let through has had its
// resume built and sent, the page's "Next" is clicked and the new page is
// read like the first. It ends at the last page (no Next, or a disabled one),
// at MAX_STORED new jobs, at MAX_PAGES, or on Stop.
//
// Called whenever either queue empties; it does nothing unless both are empty
// at once, so a lull between two checks does not turn the page early.
// ---------------------------------------------------------------------------

const MAX_PAGES = 100;
// Cards can still be arriving from the page when the queues first empty; this
// gives them a moment to land before the page is called finished.
const PAGE_SETTLE_MS = 1500;
const PAGE_CHANGE_TIMEOUT = 20000;

let runSource = null; // the board the current run was started on
let pagesTurned = 0;
let paging = false;

const pipelineIdle = () => !checking && !checkQueue.length && !draining && !queue.length;
// The search has nothing in hand: every card found so far has been checked,
// and no build is on. The jobs caught may still be waiting for theirs.
const searchIdle = () => !checking && !checkQueue.length && !draining && !building;

// The search for this batch is over: the jobs it caught are built now, one
// after the other. More caught meanwhile (the last checks) join the build.
function buildNow() {
  if (building || !visitEnabled || !queue.length) return;
  building = true;
  broadcast({ type: "BUILD_STARTED", count: queue.length });
  drain();
}

async function nextPageWhenDone() {
  // A run paused on a human check moves on once it is passed, not before.
  // Not while the tab is being sent to the next term's search: the page it
  // is leaving is not the one to judge.
  if (!SOURCES[runSource]?.nextPage || paging || switchingTerm || verifyPause || !searchIdle()) return;
  paging = true;

  let turned = false;
  try {
    await sleep(PAGE_SETTLE_MS);
    const signal = runSignal();
    // Stopped, still busy after all, or full: not this time. A job still in
    // flight calls back here when it finishes; a full list is built and then
    // the batch step's to clear (nextBatchWhenDone).
    if (!signal || signal.aborted || !visitEnabled || switchingTerm || !searchIdle()) return;
    if (feedTabId === null || acceptedCount >= MAX_STORED) return;
    // A board that reads each job beside its list (Indeed, ZipRecruiter) can
    // only read it while its page is showing: that page's jobs are built
    // before the next page is searched.
    // Every card the page has found must have reached the worker first: a
    // card's JOB_FOUND can trail the page's own replies (the desktop app
    // relays them by polling). Cards still arriving are checked, and their
    // checks call back here.
    await pageCardsArrived(signal);
    if (signal.aborted || !searchIdle()) return;
    if (SOURCES[runSource].readsInPane && queue.length) return buildNow();
    if (pagesTurned >= MAX_PAGES) return endTerm();

    const reply = await chrome.tabs
      .sendMessage(feedTabId, { type: "NEXT_PAGE" })
      .catch(() => null);
    if (!reply?.clicked) return endTerm(); // the last page, or the tab is gone

    pagesTurned++;
    await waitForPageChange(feedTabId, reply.url, signal);
    if (signal.aborted) return;

    // Either a new document (the script is re-injected and starts fresh) or
    // the same one re-rendered (its dedupe keeps what was already seen) — or
    // a human check, waited out first.
    await streamFeed(feedTabId, SOURCES[runSource], {}, signal);
    turned = true;
  } catch (err) {
    if (!wasStopped(err)) {
      console.warn("[jobright] could not open the next page:", err?.message || err);
      reportFeedError(err);
    }
  } finally {
    paging = false;
  }

  // Looked at again once the new page has had time to queue its cards: a page
  // whose cards were all seen before sends no JOB_FOUND, so nothing else would
  // move the run on from it. A page with work in it is simply still busy then,
  // and its own queues call back here when they empty.
  if (turned) nextPageWhenDone();
}

// Waits, up to PAGE_ARRIVAL_MS, until every card the list page says it has
// found has been handed to the duplicate check.
const PAGE_ARRIVAL_MS = 10000;
async function pageCardsArrived(signal) {
  const deadline = Date.now() + PAGE_ARRIVAL_MS;
  while (Date.now() < deadline && !signal?.aborted) {
    const ping = await chrome.tabs.sendMessage(feedTabId, { type: "PING" }).catch(() => null);
    if (!Array.isArray(ping?.keys) || ping.keys.every((key) => checked.has(key))) return true;
    await sleep(300);
  }
  return false;
}

// This term's search has no more to give: what it caught is built, and the
// next term is looked at after — nextTermWhenDone waits a moment first.
function endTerm() {
  if (termOver === "reported") return; // the run's last term, already over
  termOver = true;
  if (queue.length) buildNow();
  else nextTermWhenDone();
}

// Resolves once the click has taken the tab somewhere and the page is loaded:
// the URL has moved on (Dice puts ?page= in it, Indeed &start=) and the tab
// reports complete.
// A Next that re-renders in place without touching the URL simply runs out
// the clock, and the page is read as it is by then.
async function waitForPageChange(tabId, fromUrl, signal) {
  const deadline = Date.now() + PAGE_CHANGE_TIMEOUT;
  while (Date.now() < deadline && !signal?.aborted) {
    await sleep(300);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the job board tab was closed");
    if (tab.url !== fromUrl && tab.status === "complete") break;
  }
  // The job list is rendered after the document loads.
  await sleep(PAGE_SETTLE_MS);
}

// ---------------------------------------------------------------------------
// Jobright: the next batch, once this one is done
//
// Jobright's feed is one long list scrolled for more, with no pages. A run
// takes MAX_STORED new jobs at a time. Once the list is full and every one
// of them has had its resume built and sent, the list is cleared — in
// storage, the badge and the panel — and the feed tab scrolls on from where
// it stopped for the next MAX_STORED. What has been seen stays seen, so no
// job comes round twice; candidates that arrived after the list filled are
// checked first. It ends when the feed runs out (a batch that never fills),
// or on Stop. The jobs themselves are in the collector by then; only the
// panel's list is cleared.
//
// Called whenever either queue empties, like nextPageWhenDone.
// ---------------------------------------------------------------------------

let batchesDone = 0;
let batching = false;

// The batch's own work is done: nothing being checked or worked on. Unlike
// pipelineIdle, candidates held over for the next batch do not count.
const batchDone = () => !checking && !draining && !queue.length;

// What the feed tab last said about its scrolling: whether it is scrolling
// now, why its last pass ended, and how many cards it had seen by then.
// Kept from its FEED_STATUS messages.
let feedScroll = { harvesting: false, endReason: null, total: 0 };
// Scroll-ons in a row that turned up no card the feed had not seen.
let dryScrolls = 0;
let lastScrollTotal = -1;
const MAX_DRY_SCROLLS = 2;

function resetFeedScroll() {
  feedScroll = { harvesting: false, endReason: null, total: 0 };
  dryScrolls = 0;
  lastScrollTotal = -1;
}

function noteFeedStatus(status, tabId) {
  if (tabId !== feedTabId || !status) return;
  feedScroll = {
    harvesting: !!status.harvesting,
    endReason: status.harvestComplete ? status.endReason || feedScroll.endReason : feedScroll.endReason,
    total: typeof status.total === "number" ? status.total : feedScroll.total
  };
  // A pass that ends while everything caught is already done is the moment
  // to look again; one that ends with work still going is looked at when the
  // work is done.
  if (status.harvestComplete) nextBatchWhenDone();
  // Jobright's feed has run out: the search is over, and what it caught is built.
  if (status.harvestComplete && status.endReason === "bottom") buildNow();
  const source = SOURCES[runSource];
  // Glassdoor's list is read to its end unless it stopped at a full list,
  // which the batch step goes on from.
  if (status.harvestComplete && !status.atLimit && source && !source.nextPage && !source.scrollBatches && !termOver) {
    endTerm();
  }
}

// What a board does for more once its full list has been cleared.
const NEXT_STEP = { scroll: "scrolling for more", page: "on to the next page", more: "loading more" };

async function nextBatchWhenDone() {
  const source = SOURCES[runSource];
  if (!source || batching) return;
  // Not full yet: Jobright's search scrolls on for more before anything is built.
  if (acceptedCount < MAX_STORED) return source.scrollBatches && searchIdle() ? scrollMoreWhenDone() : undefined;
  if (!batchDone()) return;
  batching = true;
  try {
    // A job still arriving, or a queue about to pick one up, is not done.
    await sleep(PAGE_SETTLE_MS);
    const signal = runSignal();
    if (!signal || signal.aborted || !visitEnabled || acceptedCount < MAX_STORED || !batchDone()) return;
    if (feedTabId === null) return;

    batchesDone++;
    acceptedCount = 0;
    await clearJobs();
    const next = source.scrollBatches ? "scroll" : source.nextPage ? "page" : "more";
    broadcast({
      type: "BATCH_CLEARED", batch: batchesDone, done: MAX_STORED, size: MAX_STORED,
      board: source.name, next: NEXT_STEP[next]
    });

    // The held-over candidates first, then more from the board: Jobright
    // scrolls on, a paged board turns its page once this one's cards are all
    // through (nextPageWhenDone, called as the checks finish), and Glassdoor
    // loads more.
    tellFeed({ type: "ACCEPTED", count: 0 });
    drainChecks();
    if (next === "scroll") await tell(feedTabId, { type: "NEXT_BATCH" }, source.script);
    else if (next === "more") await streamFeed(feedTabId, source, runOptions, signal);
  } catch (err) {
    console.warn("[jobright] could not start the next batch:", err?.message || err);
    reportFeedError(err);
  } finally {
    batching = false;
  }
}

// The list is not full, but every job caught so far has been checked and has
// had its resume built and sent — and the feed's last scroll pass stopped
// short of the list's end (its scroll budget, or the bound on cards seen
// per pass). Those jobs are finished, so the list is cleared of them — in
// storage, the badge and the panel, as a full batch is — and the feed
// scrolls on from where it stopped to catch more. A pass that caught nothing
// has nothing to clear and just scrolls on. This goes on until the feed
// genuinely ends (the last list is kept then, to be looked at), or
// MAX_DRY_SCROLLS passes in a row turn up nothing new.
async function scrollMoreWhenDone() {
  const reason = feedScroll.endReason;
  // "bottom" is looked past too: a feed that loads more at its end can seem
  // to have ended. MAX_DRY_SCROLLS passes in a row with nothing new end it.
  if (feedScroll.harvesting || !reason || reason === "stopped") return;
  if (checkQueue.length || feedTabId === null) return;
  batching = true;
  try {
    await sleep(PAGE_SETTLE_MS);
    const signal = runSignal();
    if (!signal || signal.aborted || !searchIdle() || feedScroll.harvesting) return;
    if (acceptedCount >= MAX_STORED) return; // filled meanwhile: the batch step's turn

    dryScrolls = feedScroll.total === lastScrollTotal ? dryScrolls + 1 : 0;
    lastScrollTotal = feedScroll.total;
    if (dryScrolls >= MAX_DRY_SCROLLS) {
      broadcast({ type: "FEED_DONE", reason: "no more new cards below" });
      buildNow(); // the search is over: what it caught is built
      return;
    }

    feedScroll = { ...feedScroll, harvesting: true, endReason: null };
    let reply;
    // Jobs caught and still waiting to be built: the search goes on, and the
    // list keeps them. Jobs built already: the list is cleared of them first.
    if (acceptedCount > 0 && !queue.length) {
      const done = acceptedCount;
      batchesDone++;
      acceptedCount = 0;
      await clearJobs();
      broadcast({ type: "BATCH_CLEARED", batch: batchesDone, done, size: MAX_STORED });
      tellFeed({ type: "ACCEPTED", count: 0 });
      // NEXT_BATCH: the feed's own count starts again too, and it scrolls on.
      reply = await tell(feedTabId, { type: "NEXT_BATCH" }, SOURCES[runSource].script);
    } else {
      broadcast({ type: "SCROLLING_MORE", accepted: 0, size: MAX_STORED });
      reply = await tell(feedTabId, { type: "SCROLL_MORE" }, SOURCES[runSource].script);
    }
    if (!reply?.ok && !reply?.harvesting) feedScroll = { ...feedScroll, harvesting: false, endReason: "stopped" };
  } catch (err) {
    console.warn("[jobright] could not scroll on for more:", err?.message || err);
  } finally {
    batching = false;
  }
}
// ---------------------------------------------------------------------------
// Indeed: the search a run opens
//
// Indeed is read like Dice — a search page in a tab, content-indeed.js on it,
// the pager's Next once a page is done — with each job's description read by
// clicking its card on that page. The search is not fixed, though: the
// panel's search form says what to look for, and Start opens that search on
// the picked country's Indeed site.
// ---------------------------------------------------------------------------

// Each country's own Indeed site, by the ISO code the panel's Country sends —
// keep in step with #searchCountry in sidepanel.html.
const INDEED_COUNTRIES = {
  US: "www", GB: "uk", CA: "ca", AU: "au", IN: "in", DE: "de", FR: "fr", IE: "ie", NL: "nl",
  ES: "es", IT: "it", PL: "pl", SE: "se", CH: "ch", BE: "be", AT: "at", PT: "pt", SG: "sg",
  JP: "jp", PH: "ph", AE: "ae", ZA: "za", NZ: "nz", BR: "br", MX: "mx"
};

// The panel's Job type values are Indeed's own (jt(fulltime) and so on).
const INDEED_JOB_TYPES = new Set(["fulltime", "parttime", "contract", "internship"]);
// Indeed's attribute key for remote jobs.
const INDEED_REMOTE = "DSQF7";

// What the panel asked to search for, with anything unusable dropped.
function indeedSearchOf(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    role: String(s.role || "").trim().slice(0, 200),
    country: Object.hasOwn(INDEED_COUNTRIES, s.country) ? s.country : "US",
    location: String(s.location || "").trim().slice(0, 200),
    jobType: INDEED_JOB_TYPES.has(s.jobType) ? s.jobType : "",
    postedDays: Math.max(0, Math.min(30, Math.floor(Number(s.postedDays) || 0))),
    remote: !!s.remote
  };
}

// The search as Indeed's own filters write it, newest first:
//   /jobs?q=data+engineer&l=Austin%2C+TX&fromage=7&sc=0kf%3Aattr%28DSQF7%29jt%28fulltime%29%3B&sort=date
// q and l are what Indeed's own two search boxes send — "What" (the role) and
// "Where" (a city, state, zip code or "remote"; blank for the whole country) —
// so this is the same search as typing into them and pressing Find jobs. fromage
// the days since posting, and sc the remote and job-type filters together.
function indeedSearchUrl(search) {
  const url = new URL(`https://${INDEED_COUNTRIES[search.country]}.indeed.com/jobs`);
  url.searchParams.set("q", search.role);
  if (search.location) url.searchParams.set("l", search.location);
  if (search.postedDays) url.searchParams.set("fromage", String(search.postedDays));
  const filters = (search.remote ? `attr(${INDEED_REMOTE})` : "") + (search.jobType ? `jt(${search.jobType})` : "");
  if (filters) url.searchParams.set("sc", `0kf:${filters};`);
  url.searchParams.set("sort", "date");
  return url.href;
}

// ---------------------------------------------------------------------------
// Search terms, on every board that can be searched
//
// The panel's search form goes to Dice, Glassdoor and ZipRecruiter as well as
// Indeed. Its search box can hold several terms, separated by ";" or new
// lines: a run searches for each in turn, one after the other, on the same
// tab (see nextTermWhenDone). Indeed needs at least one term; on the other
// boards an empty box opens the board's fixed search, as before.
// ---------------------------------------------------------------------------

const MAX_TERMS = 20;

function searchTerms(search) {
  const seen = new Set();
  return String(search?.role || "")
    .split(/[;\n]+/)
    .map((t) => t.trim().slice(0, 200))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_TERMS);
}

// Dice's own search page, as its search box and filters write it.
const DICE_JOB_TYPES = { fulltime: "FULLTIME", parttime: "PARTTIME", contract: "CONTRACTS" };
const DICE_POSTED = { 1: "ONE", 3: "THREE", 7: "SEVEN" };
function diceSearchUrl(search) {
  const url = new URL("https://www.dice.com/jobs");
  url.searchParams.set("q", search.role);
  url.searchParams.set("countryCode", "US");
  url.searchParams.set("location", search.location || "United States");
  if (DICE_JOB_TYPES[search.jobType]) url.searchParams.set("filters.employmentType", DICE_JOB_TYPES[search.jobType]);
  const posted = DICE_POSTED[search.postedDays] || (search.postedDays ? "SEVEN" : "");
  if (posted) url.searchParams.set("filters.postedDate", posted);
  if (search.remote) url.searchParams.set("filters.workplaceTypes", "Remote");
  return url.href;
}

// ZipRecruiter's search page, as its search box and refine filters write it.
const ZIP_JOB_TYPES = { fulltime: "full_time", parttime: "part_time", contract: "contract", internship: "internship" };
function zipRecruiterSearchUrl(search) {
  const url = new URL("https://www.ziprecruiter.com/jobs-search");
  url.searchParams.set("search", search.role);
  url.searchParams.set("location", search.location || "United States");
  if (search.postedDays) url.searchParams.set("days", String(search.postedDays));
  if (ZIP_JOB_TYPES[search.jobType]) url.searchParams.set("refine_by_employment", `employment_type:${ZIP_JOB_TYPES[search.jobType]}`);
  if (search.remote) url.searchParams.set("refine_by_location_type", "only_remote");
  return url.href;
}

// Glassdoor's keyword search; it forwards to its own /Job/…SRCH… address.
function glassdoorSearchUrl(search) {
  const url = new URL("https://www.glassdoor.com/Job/jobs.htm");
  url.searchParams.set("sc.keyword", search.role);
  if (search.location) url.searchParams.set("locKeyword", search.location);
  if (search.postedDays) url.searchParams.set("fromAge", String(search.postedDays));
  if (search.remote) url.searchParams.set("remoteWorkType", "1");
  return url.href;
}

// The page a run opens for one term — the board's fixed page when there is
// no term and the board has one.
function searchPageUrl(source, search, term) {
  if (term && source.searchUrl) return source.searchUrl({ ...search, role: term });
  return source.url;
}

// The run's search terms, in order, and which one it is on.
let runSearch = null;
let runTerms = [];
let termIndex = 0;
// The current term's results are all in: its last page is done (a paged
// board), or its list has been read to the end (Glassdoor). "reported" once
// the panel has been told the last term is finished.
let termOver = false;
let switchingTerm = false;

function resetTerms(search = null, terms = []) {
  runSearch = search;
  runTerms = terms;
  termIndex = 0;
  termOver = false;
}

// Once a term's results are finished, every job caught for it checked and
// read, the same tab goes on to the next term's search, from an empty list.
// The last term's list is kept, to be looked at.
async function nextTermWhenDone() {
  if (!termOver || termOver === "reported" || switchingTerm || verifyPause || !pipelineIdle()) return;
  if (termIndex + 1 >= runTerms.length) {
    if (runTerms.length > 1) {
      termOver = "reported";
      broadcast({ type: "TERMS_DONE", total: runTerms.length });
    }
    return;
  }
  switchingTerm = true;
  try {
    await sleep(PAGE_SETTLE_MS);
    const signal = runSignal();
    if (!signal || signal.aborted || !visitEnabled || !pipelineIdle() || feedTabId === null) return;
    const source = SOURCES[runSource];
    const tab = await chrome.tabs.get(feedTabId).catch(() => null);
    if (!tab) return;

    termIndex++;
    termOver = false;
    acceptedCount = 0;
    pagesTurned = 0;
    await clearJobs();
    const term = runTerms[termIndex];
    broadcast({ type: "TERM_STARTED", term, index: termIndex, total: runTerms.length });

    await chrome.tabs.update(feedTabId, { url: searchPageUrl(source, runSearch, term) });
    await waitForPageChange(feedTabId, tab.url, signal);
    if (signal.aborted) return;
    await streamFeed(feedTabId, source, runOptions, signal);
  } catch (err) {
    if (!wasStopped(err)) {
      console.warn("[jobright] could not search for the next term:", err?.message || err);
      reportFeedError(err);
    }
  } finally {
    switchingTerm = false;
  }
  // A first page whose cards were all seen before queues nothing.
  nextPageWhenDone();
  nextTermWhenDone();
}

// ---------------------------------------------------------------------------
// Capture only
//
// A run with options.capture set reads each job's information and keeps it,
// and nothing else: no collector check, no ChatGPT, no resume, no save.
// Every card found is caught; each is opened (or read in the pane) for its
// description; and { term, board, company, title, url, location, description }
// goes into the "captures" list, which outlives Clear and the list clears
// between batches and terms, and is exported from the panel as CSV or JSON.
// ---------------------------------------------------------------------------

let captureMode = false;
let runOptions = {};
const MAX_CAPTURES = 5000;

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// The description as plain text: each block and break on a line of its own,
// list items as bullets, every other tag gone.
function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|section|tr|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      const name = e.toLowerCase();
      if (Object.hasOwn(HTML_ENTITIES, name)) return HTML_ENTITIES[name];
      if (name[0] !== "#") return m;
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n") // one block, one line
    .trim();
}

async function addCapture(job, detail) {
  const record = {
    term: runTerms[termIndex] || "",
    board: SOURCES[job.source]?.name || SOURCES[runSource]?.name || job.source || "",
    company: job.company || detail?.company || "",
    title: job.title || detail?.title || "",
    // ZipRecruiter's card link does not reliably open the job; the address it
    // was read at does — the same choice saveJob makes.
    url: (job.source === "ziprecruiter" && detail?.url) || job.href || detail?.url || "",
    location: job.location || detail?.location || "",
    description: htmlToText(detail?.descriptionHtml) || detail?.descriptionText || "",
    note: detail?.ok
      ? detail.isLinkedIn ? "posted on LinkedIn — description not read" : ""
      : detail?.error || "not read",
    capturedAt: new Date().toISOString()
  };
  return serialize(async () => {
    const { captures = [] } = await chrome.storage.local.get("captures");
    if (record.url && captures.some((c) => c.url === record.url)) return captures.length;
    captures.push(record);
    const kept = captures.slice(-MAX_CAPTURES);
    await chrome.storage.local.set({ captures: kept });
    broadcast({ type: "CAPTURE_ADDED", count: kept.length, record });
    return kept.length;
  });
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
  if (building) drain(); // otherwise it waits for the search to finish
}

function broadcast(message) {
  // Only the panel listens; it is closed most of the time, and "no receiving
  // end" is the expected outcome, not an error.
  chrome.runtime.sendMessage(message).catch(() => {});
}

// The job the queue is working on and which step it is at, so the panel can
// say "waiting for ChatGPT" on that job's own row. Kept here rather than only
// sent once, because every status carries it: a panel opened mid-generation
// still learns what the current job is doing. `at` is when the step began, so
// the panel can count the seconds a slow answer has been taking, and `profile`
// is whose resume the step is for, once there is one.
//   opening → reading → (per profile) waiting (for ChatGPT) → building → saving
let active = null;

function setStage(job, stage, profile = null) {
  active = job && stage ? { key: job.key, title: job.title, stage, profile, at: Date.now() } : null;
  queueStatus();
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
      active,
      ...extra
    }
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  holdAwake();
  queueStatus();

  try {
    while (queue.length && visitEnabled) {
      const signal = runSignal();
      if (signal?.aborted) break;

      const job = queue.shift();
      setStage(job, "opening");

      // Everything here has already cleared the duplicate filter, so this
      // stage is only the slow work: open, read, generate, save.
      let detail;
      try {
        detail = await visitJob(job, signal, (stage) => setStage(job, stage));
      } catch (err) {
        detail = wasStopped(err)
          ? { ok: false, stopped: true }
          : { ok: false, error: err?.message || String(err) };
      }

      // Only non-LinkedIn jobs are saved — a LinkedIn origin ends the pass at
      // the closed tab, with nothing read and nothing sent. The page is read
      // once; each profile then gets its own resume from that one reading.
      if (saveEnabled && detail.ok && !detail.isLinkedIn) {
        const results = [...(job.partialResults || [])];
        const selection = await selectedProfiles();
        if (!selection.ok) {
          detail.profilesError = selection.error;
        } else {
          // The profiles the duplicate check found without this job — or,
          // for a job checked before the profiles could be read, every one
          // picked — less any already done before a Stop.
          const done = new Set(results.map((r) => r.profileId));
          const todo = selection.profiles.filter(
            (p) => (!job.profileIds || job.profileIds.includes(p.id)) && !done.has(p.id)
          );
          for (const profile of todo) {
            const result = await buildFor(job, detail, selection.settings, profile, signal);
            if (result.stopped) {
              detail.stopped = true;
              break;
            }
            results.push(result);
          }
        }
        detail.results = results;
        if (job.existingOn) detail.existingOn = job.existingOn;
        // The duplicate check that let this job through did not answer
        // cleanly — worth surfacing, but not worth withholding the job over.
        if (job.checkError) detail.checkError = job.checkError;
        // Kept for a Stop below, so a later Start carries on with the
        // profiles still to do rather than writing the others' again.
        job.partialResults = results;
      }

      // A job interrupted mid-read, mid-answer or mid-POST is not a result.
      // Leave the record clean and put it back at the front so a later Start
      // picks it up where it left off, rather than storing half of one.
      // It stays in `queued` — it is still spoken for, just back at the front.
      if (detail.stopped) {
        queue.unshift(job);
        break;
      }

      if (captureMode) {
        await addCapture(job, detail);
        detail.captured = true;
      }

      visitedCount++;
      active = null; // its row now shows the outcome instead
      await updateJob(job.key, { detail });
      broadcast({ type: "JOB_DETAIL", key: job.key, detail });

      // Politeness toward jobright.ai for having opened a page. Duplicates
      // never reach this queue, so every job here did open one.
      if (queue.length && !signal?.aborted) await sleep(DETAIL_GAP_MS);
    }
  } finally {
    draining = false;
    active = null;
    if (!queue.length) building = false; // built: the next search can begin
    releaseAwake();
    queueStatus({ drained: true });
    nextPageWhenDone();
    nextBatchWhenDone();
    nextTermWhenDone();
  }
}

// One profile's resume for a job that has been read: written from that
// profile's own prompt, master resume and style, and — only once it has built
// — filed under that profile's own tab. Nothing is sent unless the resume
// actually built: a profile that fails here is deliberately left unsaved
// rather than stored half-done, which also means /get-item still reports it
// missing on that tab, so the next run picks it up and tries again.
// `{ stopped: true }` when Stop cut it short, with nothing counted.
async function buildFor(job, detail, settings, profile, signal) {
  const onStage = (stage) => setStage(job, stage, profile.name);
  const resume = await generateResume(writerFor(settings, profile), detail, signal, onStage);
  if (resume.stopped) return { stopped: true };

  const result = { profileId: profile.id, profileName: profile.name, resume, save: null };
  if (resume.ok) {
    onStage("saving");
    result.save = await saveJob(job, detail, resume, signal, profile.name);
    if (result.save.stopped) return { stopped: true };
    generatedCount++;
    if (result.save.ok) savedCount++;
  }
  return result;
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

// Asks the collector whether each profile's tab already holds this job, by
// company and title. The same job on another profile's tab is that profile's
// application, so this one still goes ahead for the rest. Answers with the
// profiles still to build for (`pending`) and the names of those that have it
// (`existing`).
//
// Only the exact answer { code: 200, msg: "already exist" } counts a profile
// out. Anything else — a different code, a different message, a non-200, or
// no reply at all — is treated as "not a duplicate", so the check failing open
// can never silently cost a profile a job.
async function checkExisting(job, signal, profiles) {
  const pending = [];
  const existing = [];
  const errors = [];
  for (const profile of profiles) {
    try {
      const { res, data } = await postJson(
        CHECK_ENDPOINT,
        // The same `user` saveJob sends, so the check looks on the tab the
        // save would land on.
        { company: job.company, job_title: job.title, user: profile.name },
        signal
      );
      if (res.ok && data?.code === 200 && data?.msg === "already exist") existing.push(profile.name);
      else pending.push(profile);
    } catch (err) {
      if (signal?.aborted) return { ok: false, stopped: true, pending: [], existing: [] };
      pending.push(profile);
      errors.push(`${profile.name}: ${describeFetchError(err, CHECK_ENDPOINT)}`);
    }
  }
  return { ok: !errors.length, pending, existing, error: errors.join("; ") || undefined };
}

// ---------------------------------------------------------------------------
// Profiles
//
// A profile is one of the dashboard's tabs: a person applying in a country
// for a role, under their own Profile (D) name — with their own prompt,
// master resume and resume style kept on the tab as well, edited from this
// extension's Profile screen. Settings picks a country and a role, and every
// profile with both gets its own resume for each job caught: written from its
// own master resume with its own prompt, laid out in its own style, and filed
// under its own tab.
// ---------------------------------------------------------------------------

const matchKey = (s) => String(s ?? "").trim().toLowerCase();

// Every tab on the dashboard, in its order, as the collector describes it:
// { id, name, sheet: { applicant, country, role },
//   resume: { prompt, masterResume, masterResumeMode, style } }.
async function listProfiles() {
  try {
    const res = await fetch(USERS_ENDPOINT, { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    const data = await res.json();
    const profiles = (data?.users || []).filter((u) => String(u?.name || "").trim());
    await migrateLegacyStyles(profiles);
    return { ok: true, profiles };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, USERS_ENDPOINT) };
  }
}

// Saves a profile's own prompt, master resume or resume style to its tab.
async function updateProfile(id, patch) {
  const url = `${USERS_ENDPOINT}/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.user) return { ok: false, error: data?.error || `HTTP ${res.status} ${res.statusText}` };
    return { ok: true, profile: data.user };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, url) };
  }
}

// Matched the way the dashboard matches tabs to each other: ignoring case and
// surrounding spaces.
function matchingProfiles(profiles, settings) {
  const country = matchKey(settings.country);
  const role = matchKey(settings.role);
  if (!country || !role) return [];
  return profiles.filter((p) => matchKey(p.sheet?.country) === country && matchKey(p.sheet?.role) === role);
}

// The profiles a job is built for, read fresh each time, so one edited
// mid-run is written with what was saved last.
async function selectedProfiles() {
  const settings = await getSettings();
  const list = await listProfiles();
  if (!list.ok) return { ok: false, error: `could not load the profiles — ${list.error}` };
  const profiles = matchingProfiles(list.profiles, settings);
  if (!profiles.length) {
    return {
      ok: false,
      error:
        !settings.country || !settings.role
          ? "no country and role picked — choose them in Settings → Profile"
          : `no profile on the dashboard has Country "${settings.country}" and Role "${settings.role}"`
    };
  }
  return { ok: true, settings, profiles };
}

// What one profile's resume is written with: the key and model from ChatGPT
// setting, everything else the profile's own. A blank prompt or style is the
// built-in default, the way a fresh profile starts.
function writerFor(settings, profile) {
  const own = profile.resume || {};
  return {
    name: profile.name,
    profileId: profile.id,
    apiKey: settings.apiKey,
    model: settings.model,
    prompt: String(own.prompt || "").trim() ? own.prompt : DEFAULT_PROMPT,
    masterResume: own.masterResume || "",
    masterResumeMode: own.masterResumeMode === "none" ? "none" : "use",
    resumeStyle: own.style || DEFAULT_RESUME_STYLE
  };
}

// The prompt, master resume and resume style used to be one set for the
// whole extension, filed under the one tab Country name picked. The first
// time the profiles can be read, that set goes to that tab — unless the tab
// has its own already — and the tab's country and role become the ones
// picked, so a run carries on building for it as before. Until the collector
// answers, it is simply tried again next time.
async function migrateLegacySettings() {
  const settings = await getSettings();
  if (settings.migratedToProfiles) return;

  const legacyTab = String(settings.countryName || "").trim();
  if (legacyTab) {
    const list = await listProfiles();
    if (!list.ok) return;
    const tab = list.profiles.find((p) => matchKey(p.name) === matchKey(legacyTab));
    if (tab) {
      const own = tab.resume || {};
      const hasOwn = [own.prompt, own.masterResume, own.style].some((v) => String(v || "").trim());
      const patch = {};
      if (!hasOwn) {
        if (settings.prompt && settings.prompt !== DEFAULT_PROMPT) patch.prompt = settings.prompt;
        if (settings.masterResume) patch.masterResume = settings.masterResume;
        if (settings.masterResumeMode === "none") patch.masterResumeMode = "none";
        if (settings.resumeStyle && settings.resumeStyle !== DEFAULT_RESUME_STYLE) patch.resumeStyle = settings.resumeStyle;
      }
      if (Object.keys(patch).length && !(await updateProfile(tab.id, patch)).ok) return;
      if (!settings.country && !settings.role) {
        await setSettings({ country: tab.sheet?.country || "", role: tab.sheet?.role || "" });
      }
    }
  }
  await setSettings({ migratedToProfiles: true });
}

// ---------------------------------------------------------------------------
// Building the resume document
//
// The resume template — one file per style in RESUME_STYLES, or an added one,
// picked per profile — carries only the layout. Every word comes from the answer:
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
// An added style — one of `profileId`'s own — is read from storage every time
// rather than cached, so replacing it takes effect on the very next job.
async function loadTemplate(style, profileId) {
  if (!Object.hasOwn(RESUME_STYLES, style)) {
    const custom = (await getProfileStyles(profileId))[style];
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

// The cover letter, wherever the answer put it as a key of an object:
// cover_letter (the shape the prompt asks for), coverletter, coverLetter —
// any case, with or without an underscore, space or hyphen — as one string,
// or as a list of paragraphs. Null when there is none.
function coverLetterOf(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const key = Object.keys(obj).find((k) => /^cover[\s_-]?letter$/i.test(k));
  const value = key === undefined ? null : obj[key];
  const text = Array.isArray(value)
    ? value.filter((p) => typeof p === "string").join("\n\n")
    : typeof value === "string"
      ? value
      : "";
  return text.trim() || null;
}

// The shape ChatGPT answers in — the one DEFAULT_PROMPT asks for — a profile
// object rather than the older CONTACT/SUMMARY arrays:
//
//   const resume = {
//     name, title,
//     contact: { email, phone, linkedin, location },
//     resume: { summary, skills: [...],
//               experience: [{ company, position, location, duration, content: [...] }],
//               education: [{ degree, school, year }],
//               certifications?: [...] },
//     cover_letter: "…"
//   };
//
// Turned into the array shape here, so the rest of the parser, the builder
// and every template work from one shape. An object that is already in the
// array shape (it has SUMMARY) is returned as it is.
function fromProfileShape(d) {
  if (!d || typeof d !== "object" || typeof d.SUMMARY === "string") return d;
  const r = d.resume && typeof d.resume === "object" && !Array.isArray(d.resume) ? d.resume : d;
  if (typeof r.summary !== "string") return d;

  const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const list = (v) => (Array.isArray(v) ? v : []);
  const contact = d.contact || r.contact || {};

  return {
    // [name, headline, ...the contact line], the order every template uses.
    CONTACT: [
      str(d.name ?? r.name),
      str(d.title ?? r.title),
      ...[contact.location, contact.phone, contact.email, contact.linkedin ?? contact.website].map(str)
    ],
    SUMMARY: r.summary,
    SKILLS: list(r.skills),
    EXPERIENCE: list(r.experience).map((e) => [
      str(e.company),
      str(e.position ?? e.title ?? e.role),
      str(e.location),
      str(e.duration ?? e.dates),
      ...list(e.content ?? e.bullets).map(str)
    ]),
    CERTIFICATIONS: list(r.certifications ?? d.certifications).map((c) => (typeof c === "string" ? c : str(c?.name))),
    // A degree comes as one string ("Bachelor of Science in X"), so it fills
    // the degree slot and leaves the field empty.
    EDUCATION: list(r.education).map((e) => [str(e.school), [[str(e.degree), str(e.field)]], str(e.year ?? e.duration)]),
    // cover_letter beside "resume", where the prompt asks for it — or inside it.
    coverletter: coverLetterOf(d) ?? coverLetterOf(r)
  };
}

function parseModelAnswer(raw) {
  const src = stripFence(String(raw));

  // A cover letter in a declaration of its own, after the resume object:
  // `const coverletter = "…"`, as the older prompt asked, or cover_letter /
  // coverLetter.
  let coverletter = null;
  for (const name of ["coverletter", "cover_letter", "coverLetter"]) {
    const ci = declarationValueAt(src, name);
    if (ci !== -1 && QUOTES[src[ci]]) {
      coverletter = readStringLiteral(src, ci).value.trim() || null;
      break;
    }
  }

  let data = null;
  let declared = false;

  const ri = declarationValueAt(src, "resume");
  if (ri !== -1 && src[ri] === "{") {
    declared = true;
    const end = findMatchingBracket(src, ri);
    if (end !== -1) data = parseObjectLiteral(src.slice(ri, end + 1));
  }

  // Tolerated: the answer is a bare object rather than a `const resume`, as
  // the profile shape below usually is — maybe behind another name
  // (`const data = {`) or with a trailing semicolon. The first complete
  // object in the answer is read.
  if (!data && !declared) {
    const open = src.indexOf("{");
    const end = open === -1 ? -1 : findMatchingBracket(src, open);
    if (end !== -1) data = parseObjectLiteral(src.slice(open, end + 1));
  }

  if (!data) {
    // Two different problems, fixed in two different places, so they get two
    // different messages.
    throw new Error(
      declared
        ? "found `const resume` but could not read its object"
        : "the answer has no resume object — the prompt has to ask for one"
    );
  }

  data = fromProfileShape(data);

  if (typeof data.SUMMARY !== "string" || !data.SUMMARY.trim()) {
    throw new Error("the answer has no SUMMARY string");
  }

  // A cover letter written as a key of the object instead of its own const —
  // cover_letter in the shape the prompt asks for.
  if (!coverletter) coverletter = coverLetterOf(data);

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
// Style preview
//
// A template filled exactly the way a job's resume is — buildResumeHtml, from
// an answer in the shape the prompt asks ChatGPT for — so the preview is what
// a job built with that style will look like. The data is the newest resume
// actually generated for the profile being previewed, so it reads as that
// profile's own; until there is one, the sample answer below, read by the
// same parser a real answer is.
// ---------------------------------------------------------------------------

const PREVIEW_SAMPLE_ANSWER = `const resume = {
  "CONTACT": ["Alex Morgan", "Senior Software Engineer", "Austin, TX 78701", "(512) 555-0142", "alex.morgan@example.com", "https://linkedin.com/in/alex-morgan"],
  "SUMMARY": "Software engineer with nine years building data-heavy web platforms, from ingestion pipelines to the dashboards that read them. Leads small teams through design, delivery and on-call, and cares about systems that stay fast and boring at scale.",
  "SKILLS": [
    "Languages: TypeScript, Python, Go, SQL",
    "Frameworks: React, Node.js, FastAPI, Django",
    "Cloud & Data: AWS, PostgreSQL, Kafka, Snowflake, Terraform"
  ],
  "EXPERIENCE": [
    ["Northwind Analytics", "Senior Software Engineer", "Austin, TX", "Mar 2021 – Present",
      "Led a team of five rebuilding the reporting pipeline on Kafka and Snowflake, cutting report latency from hours to minutes.",
      "Designed the multi-tenant permissions model now used by every product surface.",
      "Mentored four engineers through promotion to mid and senior levels."],
    ["Contoso Health", "Software Engineer II", "Remote", "Jun 2018 – Feb 2021",
      "Built the patient-scheduling API serving 2M requests a day at a p99 under 120 ms.",
      "Moved deployments to Terraform and blue-green releases, ending weekend release windows."],
    ["Fabrikam Labs", "Software Engineer", "Dallas, TX", "Aug 2016 – May 2018",
      "Shipped the React rewrite of the customer portal, raising its conversion rate by 18%.",
      "Wrote the integration test suite that gated every merge to main."]
  ],
  "CERTIFICATIONS": ["AWS Certified Solutions Architect – Associate"],
  "EDUCATION": [
    ["University of Texas at Austin", [["Bachelor of Science (B.S.)", "Computer Science"]], "2012 – 2016"]
  ]
};`;

// The shape parseModelAnswer gives today. A resume stored by an older build
// can be in an older one, and is passed over rather than previewed half-built.
const buildable = (d) =>
  typeof d?.SUMMARY === "string" &&
  ["CONTACT", "SKILLS", "EXPERIENCE", "EDUCATION", "CERTIFICATIONS"].every((k) => Array.isArray(d[k])) &&
  d.EXPERIENCE.every((e) => Array.isArray(e?.bullets)) &&
  d.EDUCATION.every((e) => Array.isArray(e?.degrees));

// The newest resume built for this profile, or null. Jobs are kept oldest
// first, each with one resume per profile it was written for (`results`).
// Another profile's resume is never used: a style is previewed as its own
// profile's resume will look, so it is filled with that profile's data or,
// until there is some, the sample.
async function latestGenerated(profileId) {
  const { jobs = [] } = await chrome.storage.local.get("jobs");
  for (let i = jobs.length - 1; i >= 0; i--) {
    const built = (jobs[i].detail?.results || []).find(
      (r) => r.profileId === profileId && r.resume?.ok && buildable(r.resume.data)
    );
    if (built) {
      return { data: built.resume.data, from: [jobs[i].company, jobs[i].title].filter(Boolean).join(" — ") };
    }
  }
  return null;
}

// `html` is a template still being written in a profile's editor; without
// it, `style` names one the profile can pick. Answers with the filled
// document and what the builder had to say about the template: the holes Add
// new would refuse it for, and the parts it had to leave as they were.
async function previewStyle({ profileId, html, style }) {
  const template = typeof html === "string" ? html : await loadTemplate(style, profileId);
  const latest = await latestGenerated(profileId);
  const built = buildResumeHtml(template, latest?.data ?? parseModelAnswer(PREVIEW_SAMPLE_ANSWER));
  return {
    ok: true,
    html: built.html,
    from: latest?.from ?? null,
    missing: missingHoles(template),
    // Only the warnings about the template: ones about the data — a role
    // count, a role without bullets — say nothing about the layout.
    warnings: built.warnings.filter((w) => /template/.test(w))
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

// `onStage` hears "waiting" as the request goes out and "building" once the
// answer is back and being laid into the template — the two halves of the
// wait the panel shows against the job.
async function generateResume(writer, detail, signal, onStage = () => {}) {
  if (!writer.apiKey) {
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
    template = await loadTemplate(writer.resumeStyle, writer.profileId);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  const timeout = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
  const abort = signal ? AbortSignal.any([timeout, signal]) : timeout;

  // The prompt goes out exactly as it was typed — nothing is appended to it.
  // The user message carries the two inputs, each under its own heading so the
  // model cannot mistake the candidate's resume for part of the job posting.
  // With the profile's master resume switched off, or none set, the job
  // description goes out on its own.
  const useMaster = writer.masterResumeMode !== "none";
  const masterResume = useMaster ? (writer.masterResume || "").trim() : "";
  const userContent = masterResume
    ? `=== JOB DESCRIPTION ===\n${description}\n\n=== MASTER RESUME ===\n${masterResume}`
    : description;
  if (!useMaster) {
    console.log(`[jobright] ${writer.name}: master resume switched off — sending the job description only`);
  } else if (!masterResume) {
    console.warn(`[jobright] ${writer.name}: no master resume set in Settings → Profile — sending the job description only`);
  }

  const messages = [
    { role: "system", content: writer.prompt },
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
  console.log(`[jobright] → OpenAI request · ${writer.model} · ${writer.name}`, { model: writer.model, profile: writer.name, messages });
  console.log("[jobright]   system message:\n" + messages[0].content);
  console.log("[jobright]   user message:\n" + messages[1].content);

  onStage("waiting");
  try {
    const res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${writer.apiKey}`
      },
      body: JSON.stringify({
        model: writer.model,
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

    onStage("building");
    let parsed;
    try {
      parsed = parseModelAnswer(text);
    } catch (err) {
      // Keep the raw answer on the result so a malformed reply can be read in
      // the panel instead of only being described.
      return { ok: false, error: err.message, raw: text };
    }

    const { html, warnings } = buildResumeHtml(template, parsed);
    if (!parsed.coverletter) warnings.push("no cover letter in the answer (cover_letter)");

    return {
      ok: true,
      html,
      coverletter: parsed.coverletter,
      data: parsed,
      raw: text,
      warnings,
      model: data?.model || writer.model
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
// The models the API key can use
//
// What the Model list under ChatGPT setting offers: OpenAI's own answer to
// "which models can this key use" (GET /v1/models), cut down to the ones that
// can write a resume here — text models that answer Chat Completions. Newest
// first, and the dated snapshots (gpt-4o-2024-08-06) apart from the names
// that always point at the latest. Kept in storage with the key's last four
// characters, so the panel can show it again without asking, and knows when
// the key has changed under it.
// ---------------------------------------------------------------------------

const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";

// Text models, by family: gpt-…, chatgpt-…, and the o-series (o3, o4-mini).
const WRITES_TEXT = /^(gpt-|chatgpt-|o\d)/i;
// …less the ones that are not for this: speech, images, embeddings,
// moderation, search, the older completions-only "instruct", agents and code
// models, and the "pro" models, which only answer the Responses API.
const NOT_FOR_WRITING =
  /audio|realtime|tts|transcribe|whisper|embedding|image|dall-e|moderation|search|instruct|computer-use|codex|sora|deep-research|-pro\b/i;
// A pinned snapshot: a date (or an old four-digit release) at the end.
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

async function listModels(apiKey) {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) return { ok: false, error: "no API key given" };

  try {
    const res = await fetch(OPENAI_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null; // not JSON; the status still tells us what happened
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ${data?.error?.message || res.statusText}` };

    const all = Array.isArray(data?.data) ? data.data : [];
    const usable = all
      .filter((m) => typeof m?.id === "string" && WRITES_TEXT.test(m.id) && !NOT_FOR_WRITING.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id));
    const list = {
      models: usable.filter((m) => !SNAPSHOT.test(m.id)).map((m) => m.id),
      snapshots: usable.filter((m) => SNAPSHOT.test(m.id)).map((m) => m.id),
      total: all.length,
      loadedAt: Date.now(),
      keyEnd: apiKey.slice(-4)
    };
    await chrome.storage.local.set({ openaiModels: list });
    console.log(`[jobright] ← OpenAI models: ${list.models.length} + ${list.snapshots.length} snapshot(s) of ${list.total}`);
    return { ok: true, ...list };
  } catch (err) {
    return {
      ok: false,
      error:
        err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `no response in ${TEST_TIMEOUT_MS / 1000}s`
          : `${err?.message || err} — is api.openai.com reachable?`
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

// One profile's resume for a job: the job's own description, that profile's
// resume and cover letter, filed under that profile's tab (`user`).
async function saveJob(job, detail, resume, signal, user) {
  const payload = {
    // The card's own href, normally — except on ZipRecruiter, where the
    // card's own link does not reliably resolve as the job's own page on a
    // fresh visit. There, the job's real link is only known once it has
    // actually been read: the address the browser is left on once the card
    // is clicked and its description comes up (detail.url) — see readInPane
    // in content-ziprecruiter.js, and the matching line in sidepanel.js's
    // addDetail.
    job_url: job.source === "ziprecruiter" ? detail?.url || job.href : job.href,
    job_des: detail.descriptionHtml,
    resume: resume?.html ?? null,
    coverletter: wrapCoverLetter(resume?.coverletter),
    company: job.company,
    job_title: job.title,
    user
  };

  try {
    const { res, data } = await postJson(SAVE_ENDPOINT, payload, signal);
    if (res.ok) return { ok: true, status: res.status };
    // The collector's own error body, when it sends one — a bare status code
    // on a 500 says nothing about which part of the payload it choked on.
    const detailMsg = data?.error?.message || data?.error || data?.message || data?.detail;
    const error = detailMsg ? `HTTP ${res.status} — ${detailMsg}` : `HTTP ${res.status} ${res.statusText}`;
    return { ok: false, status: res.status, error };
  } catch (err) {
    if (signal?.aborted) return { ok: false, stopped: true, error: STOPPED };
    return { ok: false, error: describeFetchError(err, SAVE_ENDPOINT) };
  }
}

// ---------------------------------------------------------------------------
// A job typed in by hand
//
// Manual mode is the queue's pass -- duplicate check, then generate and save
// for each profile picked -- with the two things visitJob would have read off
// the page handed over instead. As on the feed, a profile whose tab already
// holds the job is counted out at the check, and a job every one of them
// holds goes no further. Nothing here opens a tab or touches the feed, so it can be used
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
  holdAwake();
  try {
    await migrateLegacySettings();
    const selection = await selectedProfiles();
    if (!selection.ok) return { ok: false, error: selection.error };

    // Asked before the model is, so a posting a profile's tab already holds
    // costs that profile no API call. A check that fails fails open, as on
    // the feed: the job goes ahead and the error is reported beside the result.
    const job = { href: url, company, title };
    const check = await checkExisting(job, undefined, selection.profiles);
    if (!check.pending.length) {
      return { ok: true, duplicate: true, existingOn: check.existing, results: [] };
    }

    const detail = {
      ok: true,
      descriptionFound: true,
      descriptionText: description,
      descriptionHtml: manualDescriptionHtml(description)
    };

    // One profile at a time, as the queue does. Same rule as the queue too:
    // nothing is sent for a profile unless its resume built, so a failed
    // generation leaves that tab untouched rather than storing a job with no
    // documents against it. Deliberately not counted into the queue's tally:
    // that strip reports what the feed run did, and a hand-typed job is not
    // part of one.
    const results = [];
    for (const profile of check.pending) {
      const tell = (stage) => broadcast({ type: "MANUAL_STATUS", stage, profile: profile.name });
      tell("generating");
      const resume = await generateResume(writerFor(selection.settings, profile), detail, undefined, tell);
      const result = { profileId: profile.id, profileName: profile.name, resume, save: null };
      if (resume.ok) {
        tell("saving");
        result.save = await saveJob(job, detail, resume, undefined, profile.name);
      }
      results.push(result);
    }

    return { ok: true, duplicate: false, results, existingOn: check.existing, checkError: check.error };
  } finally {
    manualBusy = false;
    releaseAwake();
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

// A wait nothing else can cut short — a content script still working on its
// answer — given up the moment Stop is pressed.
function stoppable(promise, signal) {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      if (signal.aborted) reject(new Error(STOPPED));
      signal.addEventListener("abort", () => reject(new Error(STOPPED)), { once: true });
    })
  ]);
}

// Indeed and ZipRecruiter: the job is read on the search page the run is on.
// The card is clicked in the list tab and the description it brings up read
// from the right-hand pane (READ_PANE in content-indeed.js / content-
// ziprecruiter.js); no tab is opened for the job, ever. A description that
// could not be read for it is a reading that failed, said on the job's row
// like any other.
//
// The click itself cannot open a tab — the content script cancels the
// browser's own action once the site's own handler has had the click — but
// the site's own script could still open one from its handler. So while the
// card is being read, a tab the search tab opens is closed again at once,
// and the search tab put back in front.
async function readInPane(job, signal, onStage) {
  const script = sourceOf(job).script;
  const listTab = feedTabId;
  if (listTab === null) return { ok: false, error: "the search tab is gone — press Start again" };
  // Indeed's own key, when there is one; ZipRecruiter's content script finds
  // its card by its own key instead (job.key), since a ZipRecruiter job
  // carries no href at all — its card's own link does not resolve as a
  // standalone page, so none is shown or saved for it.
  const jk = job.jk || (job.href ? new URL(job.href).searchParams.get("jk") : null);
  const ask = async () => {
    await ensureContentScript(listTab, { signal, script });
    return stoppable(
      chrome.tabs.sendMessage(listTab, { type: "READ_PANE", jk, href: job.href, key: job.key, title: job.title }),
      signal
    );
  };

  const closeStray = (tab) => {
    if (tab.openerTabId !== listTab) return;
    chrome.tabs.remove(tab.id).catch(() => {});
    focusTab(listTab);
  };
  chrome.tabs.onCreated.addListener(closeStray);

  onStage("pane");
  try {
    let detail = await ask();
    // A human check in place of the job: waited out, then the card asked for again.
    while (detail?.blocked && !signal?.aborted) {
      onStage("verify");
      await waitForHumanCheck(listTab, script, signal, "job", job.title);
      onStage("pane");
      detail = await ask();
    }
    if (signal?.aborted) throw new Error(STOPPED);
    if (!detail || typeof detail !== "object") throw new Error("no reading came back from the search tab");
    return detail;
  } catch (err) {
    if (wasStopped(err) || signal?.aborted) throw new Error(STOPPED);
    return { ok: false, error: `the search tab did not answer (${err?.message || err})` };
  } finally {
    chrome.tabs.onCreated.removeListener(closeStray);
  }
}

async function visitJob(job, signal, onStage = () => {}) {
  if (signal?.aborted) throw new Error(STOPPED);
  // Indeed: no tab of its own — the card is clicked and read beside the list.
  if (sourceOf(job).readsInPane) return readInPane(job, signal, onStage);
  return readJobPage(job, signal, onStage);
}

// The job's own page, in a tab of its own: opened, read, closed.
async function readJobPage(job, signal, onStage) {
  const tab = await createDetailTab(job.href);

  // Closing the tab is also what unblocks a pending scrape: sendMessage
  // rejects as soon as its receiver is gone, so Stop does not have to wait for
  // the page to answer.
  const closeNow = () => chrome.tabs.remove(tab.id).catch(() => {});
  signal?.addEventListener("abort", closeNow, { once: true });

  try {
    await waitForComplete(tab.id, DETAIL_LOAD_TIMEOUT, signal);
    onStage("reading");
    const script = sourceOf(job).script;
    await ensureContentScript(tab.id, { signal, script });
    let detail = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_DETAIL" });

    // A human check where the job should be: the queue waits, with the tab
    // left open in front, until someone passes it, then reads the job.
    while (detail?.blocked && !signal?.aborted) {
      onStage("verify");
      await waitForHumanCheck(tab.id, script, signal, "job", job.title);
      onStage("reading");
      await ensureContentScript(tab.id, { signal, script });
      detail = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_DETAIL" });
    }
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
// Recruiter Bid
//
// A list of recruiters' emails, imported from a JSON file in the panel: each
// { email_address, company_name, email_title, email_content, arrived_date }.
// Picking one sends them an email from Gmail: a new message, the recruiter as
// the recipient, RECRUITER_SUBJECT as the subject, and the Summary of the
// profile picked in the tab (Settings → Profile) as the body — then Send.
//
// The tab is opened and filled through chrome.tabs and chrome.scripting. In
// the extension those are Chrome's own; in the desktop app they are the
// Chrome DevTools MCP server's new_page and evaluate_script, in the browser
// profile picked there.
// ---------------------------------------------------------------------------

const GMAIL_COMPOSE_URL = "https://mail.google.com/mail/u/0/#inbox?compose=new";
const RECRUITER_SUBJECT = "I'm just looking for a fully Remote Position.";
const MAX_RECRUITERS = 2000;
const GMAIL_LOAD_TIMEOUT = 45000;
const FILL_ATTEMPTS = 4;

const isEmail = (s) => /^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]+$/.test(s);
const recruiterKey = (r) => `${r.email_address.toLowerCase()}|${r.email_title.toLowerCase()}`;

// The imported entries as stored: those with a usable address, trimmed, one
// per address and title.
function recruitersOf(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const r = {
      email_address: String(e.email_address || "").trim(),
      company_name: String(e.company_name || "").trim(),
      email_title: String(e.email_title || "").trim(),
      email_content: String(e.email_content || ""),
      arrived_date: String(e.arrived_date || "").trim()
    };
    if (!isEmail(r.email_address)) continue;
    const key = recruiterKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.slice(0, MAX_RECRUITERS);
}

async function getRecruiters() {
  const { recruiters = [] } = await chrome.storage.local.get("recruiters");
  return recruiters;
}

// A new import replaces the list; an entry imported before keeps when it was
// sent to.
async function importRecruiters(raw) {
  const fresh = recruitersOf(raw);
  const before = new Map((await getRecruiters()).map((r) => [recruiterKey(r), r]));
  const recruiters = fresh.map((r) => {
    const old = before.get(recruiterKey(r));
    return old?.sentAt ? { ...r, sentAt: old.sentAt, sentAs: old.sentAs } : r;
  });
  await chrome.storage.local.set({ recruiters });
  return recruiters;
}

// Runs inside the Gmail tab, so it carries everything it needs. Waits for
// the new-message window, fills it in the way a person would — focus, insert
// the text (which runs Gmail's own input handling), move on, which turns the
// typed address into a recipient — and, once the recipient, the subject and
// the body are all in place, clicks Send and waits for Gmail to say it went.
// Nothing is sent unless every part is in place.
async function fillAndSendGmail(to, subject, body, waitMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const first = (selectors) => {
    for (const s of selectors) {
      const el = [...document.querySelectorAll(s)].find(shown);
      if (el) return el;
    }
    return null;
  };
  const TO = ['input[aria-label="To recipients"]', 'input[aria-label="To"]', 'div[name="to"] input', 'textarea[name="to"]'];
  const SUBJECT = ['input[name="subjectbox"]', 'input[aria-label="Subject"]'];
  const BODY = ['div[aria-label="Message Body"][contenteditable="true"]', 'div[role="textbox"][aria-label^="Message Body"]', 'div[aria-label="Message Body"]'];
  const SEND = ['div[role="button"][data-tooltip^="Send"]', 'div[role="button"][aria-label^="Send"]', 'button[aria-label^="Send"]'];

  let toEl = null;
  let subjectEl = null;
  let bodyEl = null;
  for (const until = Date.now() + waitMs; Date.now() < until; await sleep(250)) {
    if (/accounts\.google\.com$/.test(location.hostname) || /ServiceLogin|signin/i.test(location.href)) {
      return { ok: false, signedOut: true, error: "Gmail asks to sign in first — sign in, then pick the recruiter again" };
    }
    toEl = first(TO);
    subjectEl = first(SUBJECT);
    bodyEl = first(BODY);
    if (toEl && subjectEl && bodyEl) break;
  }
  if (!toEl || !subjectEl || !bodyEl) return { ok: false, error: "the new-message window did not come up" };

  const type = (el, text) => {
    el.focus();
    el.select?.();
    if (!document.execCommand("insertText", false, text)) {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const escape = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  type(toEl, to);
  await sleep(300);
  // Leaving the field is what makes Gmail take the address as a recipient.
  type(subjectEl, subject);
  toEl.dispatchEvent(new Event("blur"));
  await sleep(300);

  // The body keeps its line breaks.
  bodyEl.focus();
  const html = escape(body).replace(/\r?\n/g, "<br>");
  if (!document.execCommand("insertHTML", false, html)) {
    bodyEl.innerHTML = html;
    bodyEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await sleep(400);

  const recipient = [...document.querySelectorAll("[email], [data-hovercard-id]")].some(
    (el) => (el.getAttribute("email") || el.getAttribute("data-hovercard-id") || "").toLowerCase() === to.toLowerCase()
  );
  const flat = (t) => t.replace(/\s+/g, " ").trim();
  const filled = {
    to: recipient,
    subject: subjectEl.value === subject,
    body: flat(bodyEl.innerText).includes(flat(body).slice(0, 200))
  };
  const missing = Object.entries(filled).filter(([, ok]) => !ok).map(([part]) => part);
  if (missing.length) return { ok: false, filled, error: `not sent — the ${missing.join(", ")} did not fill in` };

  const send = first(SEND);
  if (!send) return { ok: false, filled, error: "not sent — Gmail's Send button was not found" };
  // Gmail's buttons act on the mouse going down and up, as a click does.
  for (const type of ["mousedown", "mouseup", "click"]) {
    send.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // Sent once the new-message window has gone, or Gmail says so.
  for (const until = Date.now() + 15000; Date.now() < until; await sleep(250)) {
    const said = /Message sent/i.test(document.querySelector('[role="alert"], [aria-live]')?.innerText || "");
    if (!shown(subjectEl) || said) return { ok: true, sent: true, filled };
  }
  return { ok: false, filled, error: "Send was clicked, but Gmail did not confirm the message went — check the Gmail tab" };
}

// The summary of a dashboard profile, as Settings → Profile saved it.
async function profileSummary(profileId) {
  const list = await listProfiles();
  if (!list.ok) return { ok: false, error: list.error };
  const profile = list.profiles.find((p) => String(p.id) === String(profileId));
  if (!profile) return { ok: false, error: "pick the profile whose Summary to send" };
  const summary = String(profile.resume?.summary || "").trim();
  if (!summary) return { ok: false, error: `${profile.name} has no Summary yet — add one in Settings → Profile` };
  return { ok: true, profile, summary };
}

async function sendToRecruiter(email, profileId) {
  if (!isEmail(String(email || ""))) return { ok: false, error: "not an email address" };
  const from = await profileSummary(profileId);
  if (!from.ok) return from;

  const tab = await chrome.tabs.create({ url: GMAIL_COMPOSE_URL, active: true });
  await waitForComplete(tab.id, GMAIL_LOAD_TIMEOUT).catch(() => {});

  // Gmail draws the new-message window well after the page itself has
  // loaded; the fill waits for it, and is tried again if the page was still
  // being swapped for Gmail's own. A message filled but not sent is never
  // retried, so nothing goes twice.
  let last = null;
  for (let attempt = 0; attempt < FILL_ATTEMPTS; attempt++) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillAndSendGmail,
        args: [email, RECRUITER_SUBJECT, from.summary, 15000]
      });
      last = result?.result || null;
      if (last?.ok || last?.signedOut || last?.filled) break;
    } catch (err) {
      last = { ok: false, error: err?.message || String(err) };
    }
    await sleep(1500);
  }
  if (!last?.ok) return { ok: false, tabId: tab.id, error: last?.error || "could not send the message" };

  const sentAt = new Date().toISOString();
  const recruiters = (await getRecruiters()).map((r) =>
    r.email_address.toLowerCase() === email.toLowerCase() ? { ...r, sentAt, sentAs: from.profile.name } : r
  );
  await chrome.storage.local.set({ recruiters });
  // Sent: the tab has nothing more to show.
  await chrome.tabs.remove(tab.id).catch(() => {});
  return { ok: true, sentAt, sentAs: from.profile.name };
}

// ---------------------------------------------------------------------------
// Before a run: is everything a job catch needs in place?
//
// Asked by the panel when Start is pressed, before START itself. Each check
// is { key, label, state, detail }: "ok", "warn" (the run goes ahead, but
// something will be missing from what it makes) or "fail" (the run would
// not get anywhere, so it is not started). The panel shows them as a list.
// START keeps its own checks; this is the same ground, said up front and all
// at once rather than one error at a time.
// ---------------------------------------------------------------------------

async function preflight(options = {}) {
  const checks = [];
  const add = (key, label, state, detail) => checks.push({ key, label, state, detail });

  // The job board.
  const sourceKey = options.source || "jobright";
  const source = SOURCES[sourceKey];
  if (!source) {
    add("board", "Job board", "fail", `${sourceKey} has no fetcher yet — pick Jobright, Dice, Glassdoor, Indeed or ZipRecruiter`);
  } else if (source.searched && !searchTerms(options.search).length) {
    add("board", "Job board", "fail", `${source.name}: type a search term`);
  } else {
    const terms = source.searchUrl ? searchTerms(options.search) : [];
    add(
      "board",
      "Job board",
      "ok",
      terms.length ? `${source.name} · ${terms.map((t) => `“${t}”`).join(", ")}` : source.name
    );
  }

  // Capture only needs the board: nothing is checked, written or sent.
  if (options.capture) {
    add("capture", "Capture only", "ok", "company, title, link and description of each job — no resumes, nothing sent");
    return { ready: !checks.some((c) => c.state === "fail"), checks };
  }

  await migrateLegacySettings();
  const settings = await getSettings();

  // The collector, and the profiles it holds.
  const list = await listProfiles();
  if (!list.ok) {
    add("collector", "Collector (localhost:4500)", "fail", `not reachable — ${list.error}`);
  } else {
    add("collector", "Collector (localhost:4500)", "ok", `${list.profiles.length} dashboard profile${list.profiles.length === 1 ? "" : "s"}`);
  }

  let profiles = [];
  if (!settings.country || !settings.role) {
    add("profiles", "Profiles", "fail", "no Country and Role picked — choose them in Settings → Profile");
  } else if (list.ok) {
    profiles = matchingProfiles(list.profiles, settings);
    add(
      "profiles",
      "Profiles",
      profiles.length ? "ok" : "fail",
      profiles.length
        ? `${settings.country} / ${settings.role}: ${profiles.map((p) => p.name).join(", ")}`
        : `no dashboard profile has Country “${settings.country}” and Role “${settings.role}”`
    );
  } else {
    add("profiles", "Profiles", "warn", `${settings.country} / ${settings.role} — not checked, the collector did not answer`);
  }

  // ChatGPT.
  add(
    "chatgpt",
    "ChatGPT",
    settings.apiKey ? "ok" : "fail",
    settings.apiKey ? `API key set · ${settings.model}` : "no API key — add it in Settings → ChatGPT setting; without it no resume is written"
  );

  // Each profile's resume: its style loads, and it has a master resume to work from.
  for (const profile of profiles) {
    const writer = writerFor(settings, profile);
    try {
      await loadTemplate(writer.resumeStyle, profile.id);
      const noMaster = writer.masterResumeMode !== "none" && !String(writer.masterResume || "").trim();
      add(
        `resume:${profile.id}`,
        `Resume · ${profile.name}`,
        noMaster ? "warn" : "ok",
        noMaster ? `style ${writer.resumeStyle} · no master resume set — the job description goes out on its own` : `style ${writer.resumeStyle}`
      );
    } catch (err) {
      add(`resume:${profile.id}`, `Resume · ${profile.name}`, "fail", err?.message || String(err));
    }
  }

  return { ready: !checks.some((c) => c.state === "fail"), checks };
}
// ---------------------------------------------------------------------------
// Panel API
// ---------------------------------------------------------------------------

async function handle(msg) {
  switch (msg?.type) {
    // With the human check being waited on, if there is one, so a panel
    // opened mid-pause says so.
    case "GET_STATE": {
      const { jobs = [] } = await chrome.storage.local.get("jobs");
      return { ok: true, jobs, verifyPause };
    }

    // The panel's "Show the tab" while a run waits on a human check.
    case "FOCUS_VERIFY":
      if (verifyPause) await focusTab(verifyPause.tabId);
      return { ok: true, pause: verifyPause };

    case "PREFLIGHT":
      return { ok: true, ...(await preflight(msg.options)) };

    // Opening the URL and starting the stream are one action, so the panel
    // only has to say "start".
    case "START": {
      // Only boards with a content script can be fetched from. The panel
      // keeps Start off for the others; this is the same rule where the work
      // happens.
      const sourceKey = msg.options?.source || "jobright";
      const source = SOURCES[sourceKey];
      if (!source) {
        return { ok: false, error: `${sourceKey} is not supported yet — only Jobright, Dice, Glassdoor, Indeed and ZipRecruiter` };
      }

      // The panel's search terms, searched one after the other. Indeed opens
      // only a search, so it needs one; the other boards fall back on their
      // fixed page without.
      const search = source.searchUrl ? indeedSearchOf(msg.options?.search) : null;
      const terms = search ? searchTerms(msg.options?.search) : [];
      if (source.searched && !terms.length) return { ok: false, error: `type a search term to search ${source.name} for` };

      captureMode = !!msg.options?.capture;

      // A run that saves builds resumes for the profiles picked in Settings,
      // and with none to build for it would only open pages to read them —
      // said before a tab is opened rather than against every job.
      if (!captureMode && msg.options?.saveJobs !== false) {
        await migrateLegacySettings();
        const selection = await selectedProfiles();
        if (!selection.ok) return { ok: false, error: selection.error };
      }

      visitEnabled = captureMode || msg.options?.visitJobs !== false;
      saveEnabled = !captureMode && msg.options?.saveJobs !== false;
      runSource = sourceKey;
      runOptions = msg.options || {};
      resetTerms(search, terms);
      pagesTurned = 0;
      batchesDone = 0;
      resetFeedScroll();
      beginRun();

      const tabId = await openFeedTab(source, searchPageUrl(source, search, terms[0]));
      const reply = await tell(tabId, { type: "START_STREAM", options: msg.options }, source.script);

      // A human check in front of the list is waited out on its own, not
      // here: the panel would otherwise sit on "Opening…" for as long as it
      // takes someone to pass it. The panel hears about the wait from
      // VERIFY_STATUS, and the stream starts once the check is passed.
      if (reply?.blocked) {
        const signal = runSignal();
        waitForHumanCheck(tabId, source.script, signal, "search")
          .then(() => streamFeed(tabId, source, msg.options, signal))
          .catch((err) => wasStopped(err) || reportFeedError(err));
      }

      // Anything left over from a previous Stop resumes now.
      tellFeed({ type: "ACCEPTED", count: acceptedCount });
      drainChecks();
      // Jobs a Stop left unbuilt are built first; the search goes on after.
      if (visitEnabled) buildNow();

      return {
        ok: true, tabId, visitEnabled, saveEnabled, captureMode, terms, endpoint: SAVE_ENDPOINT, ...reply
      };
    }

    // Everything in flight, at once: the feed tab's observer and scroll
    // harvest, the filter, the visit queue, the page load or scrape being
    // awaited, and the POST. The pending queue is kept rather than thrown
    // away, so a later Start carries on from where this left off.
    case "STOP": {
      visitEnabled = false;
      building = false;
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

    // The settings, and what a profile falls back on when it has no prompt or
    // style of its own — for the panel to show as such.
    case "GET_SETTINGS":
      await migrateLegacySettings();
      return {
        ok: true,
        settings: await getSettings(),
        defaults: { prompt: DEFAULT_PROMPT, resumeStyle: DEFAULT_RESUME_STYLE }
      };

    case "SET_SETTINGS":
      return { ok: true, settings: await setSettings(msg.patch) };

    // Every profile, and the styles each has added: { [profileId]: [{ name }] }.
    case "GET_PROFILES": {
      const list = await listProfiles();
      if (!list.ok) return list;
      const { profileStyles = {} } = await chrome.storage.local.get("profileStyles");
      const styles = Object.fromEntries(list.profiles.map((p) => [p.id, listCustomStyles(profileStyles[p.id] || {})]));
      return { ...list, styles };
    }

    case "UPDATE_PROFILE":
      return updateProfile(msg.id, msg.patch);

    case "ADD_STYLE":
      return { ok: true, ...(await addCustomStyle(msg.profileId, msg.name, msg.html)) };

    case "GET_STYLE_HTML":
      return { ok: true, ...(await getStyleHtml(msg.profileId, msg.name)) };

    case "PREVIEW_STYLE":
      return previewStyle(msg);

    case "REMOVE_STYLE":
      return { ok: true, ...(await removeCustomStyle(msg.profileId, msg.name)) };

    case "TEST_CONNECTION":
      return await testConnection(msg.apiKey, msg.model);

    // The models the given key can use, asked of OpenAI and kept.
    case "LIST_MODELS":
      return await listModels(msg.apiKey);

    // The list last asked for, as kept — or none yet.
    case "GET_MODELS": {
      const { openaiModels = null } = await chrome.storage.local.get("openaiModels");
      return { ok: true, list: openaiModels };
    }

    // Auto Fill's applicant details — one set per profile, by the profile's
    // id: strings under the keys autofill.js fills from, and `extra`, the
    // answers to form questions an imported JSON's "answers" gave,
    // [{ question, answer }]. Kept in this extension's storage, like a
    // profile's added resume styles, under "autofillProfiles".
    //
    // `legacy` is the one set saved before Auto Fill was per profile, offered
    // to a profile that has none of its own until a profile is saved with it.
    case "GET_AUTOFILL": {
      const { autofillProfiles = {}, autofill: legacy = null } = await chrome.storage.local.get([
        "autofillProfiles",
        "autofill"
      ]);
      const details = autofillProfiles[msg.profileId] || null;
      return { ok: true, details, legacy: !details && legacy && Object.keys(legacy).length ? legacy : null };
    }

    case "SET_AUTOFILL": {
      if (msg.profileId === undefined || msg.profileId === null || msg.profileId === "") {
        return { ok: false, error: "no profile picked" };
      }
      const keys = ["firstName", "lastName", "email", "phone", "location", "linkedin", "website"];
      const details = Object.fromEntries(keys.map((k) => [k, String(msg.details?.[k] ?? "").trim()]));
      details.extra = (Array.isArray(msg.details?.extra) ? msg.details.extra : [])
        .map((x) => ({ question: String(x?.question ?? "").trim(), answer: String(x?.answer ?? "").trim() }))
        .filter((x) => x.question && x.answer)
        .slice(0, 200);

      const { autofillProfiles = {} } = await chrome.storage.local.get("autofillProfiles");
      autofillProfiles[msg.profileId] = details;
      await chrome.storage.local.set({ autofillProfiles });
      // The old single set, now saved to the profile it was offered to.
      if (msg.dropLegacy) await chrome.storage.local.remove("autofill");
      return { ok: true, details };
    }

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

    case "RECRUITERS_GET":
      return { ok: true, recruiters: await getRecruiters(), subject: RECRUITER_SUBJECT };

    case "RECRUITERS_IMPORT": {
      const recruiters = await importRecruiters(msg.entries);
      return { ok: true, recruiters, skipped: (Array.isArray(msg.entries) ? msg.entries.length : 1) - recruiters.length };
    }

    case "RECRUITERS_CLEAR":
      await chrome.storage.local.set({ recruiters: [] });
      return { ok: true };

    case "RECRUITER_SEND":
      return sendToRecruiter(msg.email, msg.profileId);

    case "GET_CAPTURES": {
      const { captures = [] } = await chrome.storage.local.get("captures");
      return { ok: true, captures };
    }

    case "CLEAR_CAPTURES":
      await serialize(() => chrome.storage.local.set({ captures: [] }));
      return { ok: true };

    case "CLEAR": {
      batchesDone = 0;
      building = false;
      resetFeedScroll();
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
  if (msg?.type === "FEED_STATUS") {
    noteFeedStatus(msg.status, sender.tab?.id);
    return false;
  }
  // Auto Fill's messages to the sample form page; the page answers them.
  if (msg?.type === "AUTOFILL_RUN" || msg?.type === "AUTOFILL_CATCH") return false;

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
