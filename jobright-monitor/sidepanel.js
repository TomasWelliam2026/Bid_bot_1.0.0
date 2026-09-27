// The side panel. Renders jobs as they stream in.
//
// The content script broadcasts every card it finds as JOB_FOUND. The service
// worker asks the collector whether it already has each one, and re-broadcasts
// only the new ones as JOB_ADDED — which is what this list renders. So a job
// the collector already holds never appears here at all.

const $ = (id) => document.getElementById(id);

const listEl = $("list");
const statusEl = $("status");
const countEl = $("count");
const emptyEl = $("empty");
const startEl = $("start");
const stopEl = $("stop");
const queueEl = $("queue");
const bidCountEl = $("bidCount");

// Keep in step with MAX_ITEMS in content.js and MAX_STORED in background.js.
const MAX_ITEMS = 50;

const rendered = new Map(); // key -> the <li>, so details can be filled in later
let sawStaleClass = false;

// Two independent things can be running, and Stop has to stay available while
// either is: the feed stream in the jobright tab, and the visit queue, which
// keeps draining after the stream itself has finished.
let feedRunning = false;
let queueRunning = false;

function syncButtons() {
  const active = feedRunning || queueRunning;
  // Start also waits on a job board that can actually be fetched from.
  startEl.disabled = active || !SUPPORTED_SOURCES.has(jobSource);
  stopEl.disabled = !active;
  // The board is fixed while a run is on: switching clears the list, and a
  // stream still running would fill it straight back up from the old board.
  $("jobSource").disabled = active;
}

// ---------------------------------------------------------------------------
// Job board
//
// The picker under Auto/Manual says where Auto fetches jobs from. Jobright,
// Dice and Glassdoor each have a content script; Monster can be picked but
// has no fetcher yet, so Start stays off and the panel says why. The
// choice is remembered in this panel's own storage.
// ---------------------------------------------------------------------------

const SOURCE_NAMES = { jobright: "Jobright", dice: "Dice", glassdoor: "Glassdoor", monster: "Monster" };
const SUPPORTED_SOURCES = new Set(["jobright", "dice", "glassdoor"]);
// What the status line says while a run opens that board's page.
const SOURCE_OPENING = { jobright: "Opening jobright.ai/jobs/recommend…", dice: "Opening the Dice job search…", glassdoor: "Opening the Glassdoor job search…" };
const SOURCE_KEY = "jobSource";

let jobSource = "jobright";
try {
  const saved = localStorage.getItem(SOURCE_KEY);
  if (Object.hasOwn(SOURCE_NAMES, saved)) jobSource = saved;
} catch {
  // storage unavailable: Jobright, as before
}

// ---------------------------------------------------------------------------
// Messaging
//
// sendMessage rejects if the worker cannot be reached or throws mid-handler.
// Unhandled, that shows up in the console as the same "Could not establish
// connection" noise as a missing content script, so it is turned into a
// rendered error instead.
// ---------------------------------------------------------------------------

async function send(msg) {
  try {
    const reply = await chrome.runtime.sendMessage(msg);
    if (reply === undefined) throw new Error("no reply from the extension service worker");
    return reply;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function addJob(job, { animate = true } = {}) {
  if (!job || rendered.has(job.key)) return;
  // Backstop: the feed already stops at MAX_ITEMS, but a restore from storage
  // or a stray broadcast must not grow the list past it either.
  if (rendered.size >= MAX_ITEMS) return;

  const li = document.createElement("li");
  if (animate) li.className = "fresh";
  rendered.set(job.key, li);

  // Title — a link when the card had one, plain text otherwise.
  const title = document.createElement(job.href ? "a" : "span");
  title.className = "job-title";
  title.textContent = job.title;
  if (job.href) {
    title.href = job.href;
    title.target = "_blank";
    title.rel = "noreferrer";
  }
  li.appendChild(title);

  if (job.company) {
    const company = document.createElement("span");
    company.className = "job-company";
    company.textContent = job.company;
    li.appendChild(company);
  }

  const meta = document.createElement("div");
  meta.className = "job-meta";
  meta.textContent = `#${job.index}`;
  if (!job.company) meta.textContent += " · no company found";
  if (!job.href) meta.textContent += " · no link";
  li.appendChild(meta);

  listEl.appendChild(li);

  // A job restored from storage may already carry its reading.
  if (job.detail) addDetail(job.key, job.detail);

  if (job.staleTitleClass || job.staleCompanyClass) sawStaleClass = true;
  updateCount();
}

// ---------------------------------------------------------------------------
// The detail reading, filled in once the worker has opened and read the job's
// own page.
// ---------------------------------------------------------------------------

function addDetail(key, detail) {
  const li = rendered.get(key);
  if (!li || li.dataset.detailed) return;
  li.dataset.detailed = "1";

  if (!detail?.ok) {
    li.classList.add("failed");
    li.appendChild(tag("job-note warn", `Could not read: ${detail?.error || "unknown"}`));
    return;
  }

  // The whole point of the pass: a LinkedIn origin ends it here.
  if (detail.isLinkedIn) {
    li.classList.add("dropped");
    li.appendChild(tag("job-note", "LinkedIn posting · tab closed, skipped"));
    return;
  }

  // The POST outcome is the thing you actually need to see at a glance, so it
  // sits on the row rather than inside the collapsed block.
  // Generation runs before the save, so its outcome is reported first.
  if (detail.resume && !detail.resume.ok) {
    li.appendChild(
      tag(
        detail.resume.skipped ? "job-note" : "job-note warn",
        `No resume: ${detail.resume.error}`
      )
    );
    // The save is gated on the resume, so this job went nowhere. Say so plainly
    // rather than leaving a row with no outcome on it at all.
    li.classList.add("failed");
    li.appendChild(tag("job-note warn", "Not sent — nothing is saved without a resume"));
  }

  // A resume that built but not cleanly — wrong number of roles, an empty job.
  for (const w of detail.resume?.warnings || []) {
    li.appendChild(tag("job-note warn", w));
  }

  if (detail.save) {
    li.appendChild(
      detail.save.ok
        ? tag("job-note saved", detail.resume?.ok ? "Saved with resume" : "Saved to localhost:4500")
        : tag("job-note warn", `Save failed: ${detail.save.error}`)
    );

    // Saved, but the duplicate check itself was not answered.
    if (detail.save.checkError) {
      li.appendChild(tag("job-note warn", `Duplicate check failed: ${detail.save.checkError}`));
    }
  }

  if (!detail.descriptionFound) {
    li.appendChild(tag("job-note warn", "No #overview-1 element on the page"));
  }

  const box = document.createElement("details");
  box.className = "detail";

  const summary = document.createElement("summary");
  summary.textContent = detail.resume?.raw
    ? `Answer · ${detail.resume.raw.length.toLocaleString()} chars`
    : detail.descriptionFound
      ? "Read, but no answer"
      : "No description found";
  box.appendChild(summary);

  if (detail.originText || detail.originHref) {
    box.appendChild(field("Source", detail.originText || detail.originHref));
  }

  // Confirms the trim actually bit, rather than leaving you to eyeball the HTML.
  if (detail.descriptionFound) {
    box.appendChild(
      field(
        "Trimmed",
        `${detail.droppedSections} leading section(s), ${detail.droppedBlocks} block(s) removed`
      )
    );
  }

  if (detail.resume?.ok) {
    const r = detail.resume;
    box.appendChild(
      field(
        "Resume built",
        `${r.html.length.toLocaleString()} chars of HTML · ` +
          `${r.data.SKILLS.length} skills line(s) · ` +
          `${r.data.EXPERIENCE.reduce((n, e) => n + (e.bullets ?? e).length, 0)} bullet(s) across ` +
          `${r.data.EXPERIENCE.length} role(s)`
      )
    );
    box.appendChild(field("Summary", r.data.SUMMARY));
    if (r.coverletter) box.appendChild(field("Cover letter", r.coverletter));
  }

  // What the model actually returned, parsed or not. The job description is
  // deliberately not shown — it is readable on the job's own page, and this
  // block is for checking the answer against the prompt.
  if (detail.resume?.raw) {
    box.appendChild(
      field(detail.resume.ok ? "Answer" : "Answer (did not parse)", detail.resume.raw)
    );
  }

  if (detail.staleDetailClass) sawStaleClass = true;

  li.appendChild(box);
}

function tag(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function field(label, text) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.appendChild(tag("field-label", label));
  wrap.appendChild(tag("field-text", text));
  return wrap;
}

function updateCount() {
  countEl.textContent = String(rendered.size);
  emptyEl.hidden = rendered.size > 0;
  bidCountEl.textContent = String(rendered.size);
}

function setRunning(next) {
  feedRunning = next;
  syncButtons();
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  // JOB_ADDED, not JOB_FOUND: the worker asks the collector about every card
  // the feed finds, and only broadcasts the ones it does not already have. So
  // the list holds exactly the jobs that are new to the collector.
  if (msg?.type === "JOB_ADDED") {
    addJob(msg.job);
    return false;
  }

  if (msg?.type === "JOB_DETAIL") {
    addDetail(msg.key, msg.detail);
    return false;
  }

  if (msg?.type === "DETAIL_STATUS") {
    const s = msg.status;
    queueRunning = s.draining;
    syncButtons();
    queueEl.hidden = !s.draining && !s.pending;
    const tally = `${s.visited} read · ${s.generated} written · ${s.saved} saved · ${s.skipped} filtered out`;
    queueEl.textContent = s.draining
      ? `Reading · ${s.pending} queued · ${tally}${s.current ? ` · ${s.current}` : ""}`
      : tally;
    return false;
  }

  // The worker moved a manual pass on to its next stage. Only the panel that
  // asked for it has anything on screen to update, and it is the only one
  // listening.
  if (msg?.type === "MANUAL_STATUS") {
    if (msg.stage === "generating") showManualStatus("Writing the resume — this takes as long as the model does…");
    if (msg.stage === "saving") showManualStatus("Resume built — sending it to localhost:4500…");
    return false;
  }

  if (msg?.type === "FEED_STATUS") {
    const s = msg.status;
    setRunning(s.streaming);

    if (s.signedOut) {
      setStatus("No cards — you are probably signed out of jobright.ai.", "err");
    } else if (s.streaming && !s.onRecommendPage) {
      setStatus("That tab left the job list.", "err");
    } else if (s.atLimit) {
      setStatus(`${s.accepted} new · limit reached, no more scrolling`);
    } else if (s.harvesting) {
      setStatus(`Scrolling the list… ${s.accepted} new of ${s.limit}`, "live");
    } else if (s.streaming) {
      const tail = sawStaleClass ? " · class hash changed, prefix match held" : "";
      setStatus(`Watching for new cards · ${s.accepted} new of ${s.total} seen${tail}`, "live");
    } else {
      setStatus(`Stopped · ${s.accepted} new of ${s.total} seen`);
    }
    return false;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

startEl.addEventListener("click", async () => {
  if (feedRunning || queueRunning) return;

  setStatus(SOURCE_OPENING[jobSource] || "Opening the job board…", "live");
  setRunning(true);

  const reply = await send({
    type: "START",
    options: {
      source: jobSource,
      autoScroll: $("autoScroll").checked,
      visitJobs: $("visitJobs").checked,
      saveJobs: $("saveJobs").checked
    }
  });

  if (!reply.ok) {
    setRunning(false);
    setStatus(`Error: ${reply.error}`, "err");
  }
});

// Stops everything in flight, not just the next thing: the feed observer and
// its scroll, the visit queue, whatever page load or scrape is being awaited,
// and the POST. The UI flips immediately rather than waiting for the round
// trip, so the button never feels ignored.
stopEl.addEventListener("click", async () => {
  feedRunning = false;
  queueRunning = false;
  syncButtons();
  setStatus("Stopping…");

  const reply = await send({ type: "STOP" });

  setStatus(
    reply.ok
      ? `Stopped${reply.pending ? ` · ${reply.pending} left in the queue` : ""}`
      : `Stopped with errors: ${reply.error}`,
    reply.ok ? "" : "err"
  );
});

// Toggling mid-run takes effect immediately rather than waiting for a restart.
$("visitJobs").addEventListener("change", (e) =>
  send({ type: "SET_VISIT", enabled: e.target.checked })
);

$("saveJobs").addEventListener("change", (e) =>
  send({ type: "SET_SAVE", enabled: e.target.checked })
);

// Empties the list here and in the worker. Clear does it on demand; changing
// the job board does it too, so one board's jobs never sit under another's.
async function clearList() {
  listEl.replaceChildren();
  rendered.clear();
  sawStaleClass = false;
  queueEl.hidden = true;
  updateCount();
  await send({ type: "CLEAR" });
}

$("clear").addEventListener("click", clearList);

// ---------------------------------------------------------------------------
// Auto / Manual
//
// One switch over one pipeline. Auto is what the panel has always done: watch
// the jobright feed and let the queue open, read, write and send each card.
// Manual hands the worker the two things that pass would have read off the
// page — the company and the description — typed in here, and runs the rest
// of it unchanged, so the resume is written and POSTed the same way and the
// collector turns it into the same PDFs.
//
// Switching only shows and hides, like the tab strips below: a run started in
// Auto keeps streaming into the list behind the form, and a half-typed
// description survives a look at the feed.
// ---------------------------------------------------------------------------

const modeSwitchEl = $("modeSwitch");
const autoControlsEl = $("auto-controls");
const manualLeadEl = $("manual-lead");
const modeButtons = [...modeSwitchEl.querySelectorAll('[role="radio"]')];

function selectMode(button) {
  for (const b of modeButtons) {
    const on = b === button;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1; // one stop in the tab order, arrows move within
    $(b.getAttribute("aria-controls")).hidden = !on;
  }
  // The feed's own controls belong to Auto: Start/Stop and the three options
  // have nothing to act on when the job is being typed in.
  const manual = button.id === "mode-manual";
  autoControlsEl.hidden = manual;
  manualLeadEl.hidden = !manual;
}

for (const button of modeButtons) {
  button.addEventListener("click", () => selectMode(button));

  button.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = modeButtons[(modeButtons.indexOf(button) + step + modeButtons.length) % modeButtons.length];
    selectMode(next);
    next.focus();
  });
}

const jobSourceEl = $("jobSource");
const sourceNoteEl = $("sourceNote");

function selectSource(source) {
  jobSource = source;
  jobSourceEl.value = source;
  const supported = SUPPORTED_SOURCES.has(source);
  sourceNoteEl.hidden = supported;
  sourceNoteEl.textContent = supported
    ? ""
    : `${SOURCE_NAMES[source]} is not connected yet — only Jobright, Dice and Glassdoor fetch jobs for now.`;
  try {
    localStorage.setItem(SOURCE_KEY, source);
  } catch {
    // not remembered; the choice still applies until the panel closes
  }
  syncButtons();
}

// A different board starts from an empty list.
jobSourceEl.addEventListener("change", () => {
  if (jobSourceEl.value === jobSource) return;
  selectSource(jobSourceEl.value);
  clearList();
});

selectSource(jobSource);

const manualGenerateEl = $("manualGenerate");
const manualStatusEl = $("manualStatus");
const manualResultEl = $("manualResult");

function showManualStatus(text, kind = "") {
  manualStatusEl.hidden = !text;
  manualStatusEl.className = `hint ${kind}`.trim();
  manualStatusEl.textContent = text;
}

// The same outcomes the feed puts on a row, under the form instead: what the
// model gave back, whether it was sent, and the answer itself to check the
// first two against.
function renderManualResult({ resume, save, duplicate, checkError }) {
  manualResultEl.replaceChildren();

  // Found before the model was asked, so nothing was written or sent.
  if (duplicate) {
    showManualStatus("Already exists — the collector has this company and job title. Nothing generated.", "warn");
    return;
  }

  // The check failing is not a reason to hold the job back, but it means the
  // job went ahead without knowing whether it was a repeat.
  if (checkError) {
    manualResultEl.appendChild(tag("job-note warn", `Duplicate check failed: ${checkError}`));
  }

  if (!resume?.ok) {
    showManualStatus(`No resume: ${resume?.error || "unknown"}`, "warn");
    // Gated exactly as a feed job is — a resume that did not build means
    // nothing was sent, so the collector has nothing half-written in it.
    manualResultEl.appendChild(tag("job-note warn", "Not sent — nothing is saved without a resume"));
    if (resume?.raw) {
      manualResultEl.appendChild(field("Answer (did not parse)", resume.raw));
    }
    return;
  }

  for (const w of resume.warnings || []) {
    manualResultEl.appendChild(tag("job-note warn", w));
  }

  showManualStatus(
    save?.ok
      ? "Saved with resume — the collector writes the PDFs from here."
      : `Save failed: ${save?.error || "unknown"}`,
    save?.ok ? "saved" : "warn"
  );

  const box = document.createElement("details");
  box.className = "detail";

  const summary = document.createElement("summary");
  summary.textContent = `Answer · ${resume.raw.length.toLocaleString()} chars`;
  box.appendChild(summary);

  box.appendChild(
    field(
      "Resume built",
      `${resume.html.length.toLocaleString()} chars of HTML · ` +
        `${resume.data.SKILLS.length} skills line(s) · ` +
        `${resume.data.EXPERIENCE.reduce((n, e) => n + (e.bullets ?? e).length, 0)} bullet(s) across ` +
        `${resume.data.EXPERIENCE.length} role(s)`
    )
  );
  box.appendChild(field("Summary", resume.data.SUMMARY));
  if (resume.coverletter) box.appendChild(field("Cover letter", resume.coverletter));
  box.appendChild(field("Answer", resume.raw));

  manualResultEl.appendChild(box);
}

manualGenerateEl.addEventListener("click", async () => {
  const company = $("manualCompany").value.trim();
  const title = $("manualTitle").value.trim();
  const url = $("manualUrl").value.trim();
  const description = $("manualDescription").value.trim();

  manualResultEl.replaceChildren();

  // /save-data rejects a job with no title, so it is asked for here rather
  // than letting the model spend a call on something that cannot be filed.
  if (!company || !title || !description) {
    showManualStatus("Company, job title and job description are all needed.", "warn");
    return;
  }

  manualGenerateEl.disabled = true;
  showManualStatus("Checking whether the collector already has this job…");

  const reply = await send({ type: "GENERATE_MANUAL", job: { company, title, url, description } });

  manualGenerateEl.disabled = false;

  if (!reply.ok) {
    showManualStatus(`Failed: ${reply.error}`, "warn");
    return;
  }

  renderManualResult(reply);
});

// ---------------------------------------------------------------------------
// Profile
//
// Saved on change, which for a text field and a textarea means on blur — so a
// prompt is not written on every keystroke.
// ---------------------------------------------------------------------------

// Everything the ChatGPT setting screen holds. `model` and `resumeStyle` are
// handled separately because they are selects — model with a free-text escape
// hatch, resumeStyle with the built-in list plus any added with Style add; the
// rest are plain inputs and textareas, read and written the same way.
const PROFILE_TEXT_FIELDS = ["apiKey", "prompt", "masterResume", "countryName"];
const PROFILE_FIELDS = [...PROFILE_TEXT_FIELDS, "model", "resumeStyle"];

const CUSTOM_MODEL = "__custom__";
const DEFAULT_RESUME_STYLE = "DE-1";
const modelEl = $("model");
const resumeStyleEl = $("resumeStyle");
const modelCustomEl = $("modelCustom");
const saveProfileEl = $("saveProfile");
const revertProfileEl = $("revertProfile");
const profileStatusEl = $("profileStatus");

// The last saved values, so "has anything changed?" is a comparison rather
// than a flag that can drift out of step with the fields.
let savedProfile = null;

// A model the list does not carry — a pinned snapshot, or one released after
// this build — selects Custom… and shows the free-text box.
function setModelControls(model) {
  const known = [...modelEl.options].some((o) => o.value === model);
  modelEl.value = known ? model : CUSTOM_MODEL;
  modelCustomEl.value = known ? "" : model;
  modelCustomEl.hidden = known;
}

// Only the key is trimmed — a prompt or an address may legitimately carry
// leading whitespace, and silently rewriting what was typed is worse than
// storing it as-is.
function readForm() {
  const out = {
    model: modelEl.value === CUSTOM_MODEL ? modelCustomEl.value.trim() : modelEl.value,
    resumeStyle: resumeStyleEl.value
  };
  for (const f of PROFILE_TEXT_FIELDS) out[f] = $(f).value;
  out.apiKey = out.apiKey.trim();
  return out;
}

function fillForm(profile) {
  for (const f of PROFILE_TEXT_FIELDS) $(f).value = profile[f] ?? "";
  setModelControls(profile.model ?? "");
  // A style this build does not carry — one stored by a later build, or one
  // since removed — would otherwise leave the select blank. Showing the
  // default instead matches what the worker will actually fall back to, and
  // the row reads as an unsaved change until it is saved.
  const style = profile.resumeStyle ?? DEFAULT_RESUME_STYLE;
  const knownStyle = [...resumeStyleEl.options].some((o) => o.value === style);
  resumeStyleEl.value = knownStyle ? style : DEFAULT_RESUME_STYLE;
  syncRemoveStyle();
}

const isDirty = () => {
  if (!savedProfile) return false;
  const now = readForm();
  return PROFILE_FIELDS.some((f) => now[f] !== (savedProfile[f] ?? ""));
};

// Save is only offered when there is something to save, and an unsaved edit
// says so — without the old save-on-blur, a change left sitting in a field
// would otherwise look identical to a saved one.
function syncProfileButtons() {
  const dirty = isDirty();
  saveProfileEl.disabled = !dirty;
  revertProfileEl.disabled = !dirty;

  if (dirty) {
    profileStatusEl.className = "hint dirty";
    profileStatusEl.textContent = "Unsaved changes.";
  } else {
    showKeyState(savedProfile?.apiKey);
  }
}

function showKeyState(apiKey) {
  profileStatusEl.className = "hint";
  profileStatusEl.textContent = apiKey
    ? "Key set. Resumes will be generated for jobs the collector does not have."
    : "No key set — nothing will be saved, since a job is only sent once its resume is built.";
}

async function loadProfile() {
  const reply = await send({ type: "GET_PROFILE" });
  if (!reply.ok) {
    profileStatusEl.className = "hint warn";
    profileStatusEl.textContent = `Could not load: ${reply.error}`;
    return;
  }
  // Options first: fillForm treats a style the select does not carry as
  // unknown and falls back to the default.
  renderCustomStyles(reply.styles);
  savedProfile = reply.profile;
  fillForm(savedProfile);
  syncProfileButtons();
}

// ---------------------------------------------------------------------------
// Test connection
//
// Uses whatever is currently typed in API key and Model, not the saved
// profile — the point is to check a key or model before committing to Save,
// the same as trying it out. The worker sends one fixed prompt to OpenAI and
// hands back the reply verbatim, so what is shown is exactly what came back,
// not this panel's interpretation of it.
// ---------------------------------------------------------------------------

const testConnectionEl = $("testConnection");
const testStatusEl = $("testStatus");

function showTestStatus(text, kind = "") {
  testStatusEl.hidden = !text;
  testStatusEl.className = `hint ${kind}`.trim();
  testStatusEl.textContent = text;
}

testConnectionEl.addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  const model = modelEl.value === CUSTOM_MODEL ? modelCustomEl.value.trim() : modelEl.value;

  if (!apiKey) {
    showTestStatus("Enter an API key first.", "warn");
    return;
  }
  if (!model) {
    showTestStatus("Enter a model id, or pick one from the list.", "warn");
    return;
  }

  testConnectionEl.disabled = true;
  showTestStatus("Testing…");

  const reply = await send({ type: "TEST_CONNECTION", apiKey, model });

  testConnectionEl.disabled = false;

  if (!reply.ok) {
    showTestStatus(`Failed: ${reply.error}`, "warn");
    return;
  }

  showTestStatus(`Received: "${reply.reply}"`, "saved");
});

// ---------------------------------------------------------------------------
// Style add
//
// The picked HTML file is read here and handed to the worker, which checks it
// has the holes the builder fills and keeps it in storage — an extension
// cannot write into its own folder. It then appears in Resume style and is
// used for every resume built while it is selected and saved.
// ---------------------------------------------------------------------------

const addStyleEl = $("addStyle");
const removeStyleEl = $("removeStyle");
const styleFileEl = $("styleFile");
const styleStatusEl = $("styleStatus");
const BUILTIN_STYLES = new Set([...resumeStyleEl.options].map((o) => o.value));

function renderCustomStyles(styles = []) {
  for (const o of [...resumeStyleEl.options]) {
    if (!BUILTIN_STYLES.has(o.value)) o.remove();
  }
  for (const s of styles) {
    resumeStyleEl.add(new Option(`${s.name} — added from ${s.file || "file"}`, s.name));
  }
  syncRemoveStyle();
}

function syncRemoveStyle() {
  removeStyleEl.disabled = BUILTIN_STYLES.has(resumeStyleEl.value);
}

function showStyleStatus(text, kind = "") {
  styleStatusEl.hidden = !text;
  styleStatusEl.className = `hint ${kind}`.trim();
  styleStatusEl.textContent = text;
}

addStyleEl.addEventListener("click", () => {
  styleFileEl.value = ""; // so picking the same file again still fires change
  styleFileEl.click();
});

styleFileEl.addEventListener("change", async () => {
  const file = styleFileEl.files?.[0];
  if (!file) return;

  const name = file.name.replace(/\.html?$/i, "");
  addStyleEl.disabled = true;
  try {
    const reply = await send({ type: "ADD_STYLE", name, file: file.name, html: await file.text() });
    if (!reply.ok) {
      showStyleStatus(`Could not add ${file.name}: ${reply.error}`, "warn");
      return;
    }
    renderCustomStyles(reply.styles);
    resumeStyleEl.value = reply.name;
    syncRemoveStyle();
    syncProfileButtons();
    showStyleStatus(
      `${reply.replaced ? "Replaced" : "Added"} "${reply.name}".` +
        (isDirty() ? " Press Save to build resumes with it." : ""),
      "saved"
    );
  } catch (err) {
    showStyleStatus(`Could not read ${file.name}: ${err?.message || err}`, "warn");
  } finally {
    addStyleEl.disabled = false;
  }
});

removeStyleEl.addEventListener("click", async () => {
  const name = resumeStyleEl.value;
  if (BUILTIN_STYLES.has(name)) return;

  const reply = await send({ type: "REMOVE_STYLE", name });
  if (!reply.ok) {
    showStyleStatus(`Could not remove: ${reply.error}`, "warn");
    return;
  }
  // The worker resets a saved profile that pointed at it; any unsaved edits in
  // the other fields are kept.
  const edits = readForm();
  renderCustomStyles(reply.styles);
  savedProfile = reply.profile;
  fillForm({ ...edits, resumeStyle: edits.resumeStyle === name ? savedProfile.resumeStyle : edits.resumeStyle });
  syncRemoveStyle();
  syncProfileButtons();
  showStyleStatus(`Removed "${name}".`, "saved");
});

// Typing, picking a model, or switching to Custom… all re-evaluate.
for (const f of PROFILE_TEXT_FIELDS) $(f).addEventListener("input", syncProfileButtons);
modelCustomEl.addEventListener("input", syncProfileButtons);
modelEl.addEventListener("change", () => {
  modelCustomEl.hidden = modelEl.value !== CUSTOM_MODEL;
  if (!modelCustomEl.hidden) modelCustomEl.focus();
  syncProfileButtons();
});
resumeStyleEl.addEventListener("change", () => {
  syncRemoveStyle();
  syncProfileButtons();
});

saveProfileEl.addEventListener("click", async () => {
  const patch = readForm();

  if (modelEl.value === CUSTOM_MODEL && !patch.model) {
    profileStatusEl.className = "hint warn";
    profileStatusEl.textContent = "Enter a model id, or pick one from the list.";
    return;
  }

  saveProfileEl.disabled = true;
  const reply = await send({ type: "SET_PROFILE", patch });

  if (!reply.ok) {
    profileStatusEl.className = "hint warn";
    profileStatusEl.textContent = `Could not save: ${reply.error}`;
    saveProfileEl.disabled = false;
    return;
  }

  savedProfile = reply.profile;
  fillForm(savedProfile); // echo back what was actually stored, e.g. trimmed
  syncProfileButtons();

  profileStatusEl.className = "hint saved";
  profileStatusEl.textContent = "Saved.";
  setTimeout(() => {
    if (!isDirty()) showKeyState(savedProfile.apiKey);
  }, 1500);
});

revertProfileEl.addEventListener("click", () => {
  if (savedProfile) fillForm(savedProfile);
  syncProfileButtons();
});

// ---------------------------------------------------------------------------
// Tabs
//
// Two independent strips share this wiring: the top-level Generate/Job bid
// pair, and the ChatGPT setting/Resume style pair inside the settings screen.
// Each is wired separately so arrow-key navigation stays scoped to its own
// strip — switching between the settings tabs must not also step through
// Generate/Job bid.
//
// Switching only shows and hides. The feed keeps streaming into the Generate
// pane while the Job bid tab is in front, and an edit in the master resume
// survives a trip to the Resume style tab, because the panes are still in the
// document, just not displayed.
// ---------------------------------------------------------------------------

function wireTabStrip(listEl, { onSelect } = {}) {
  const strip = [...listEl.querySelectorAll('[role="tab"]')];

  function select(tab) {
    onSelect?.(tab);
    for (const t of strip) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1; // one stop in the tab order, arrows move within
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
  }

  for (const tab of strip) {
    tab.addEventListener("click", () => select(tab));

    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = strip[(strip.indexOf(tab) + step + strip.length) % strip.length];
      select(next);
      next.focus();
    });
  }

  return { tabs: strip, select };
}

const mainTabs = wireTabStrip($("mainTabs"), {
  // Picking a top-level tab also leaves the settings screen, if it is open.
  onSelect: () => {
    $("pane-profile").hidden = true;
    $("openSettings").setAttribute("aria-expanded", "false");
  }
});

wireTabStrip($("settingsTabs"));

// ---------------------------------------------------------------------------
// Settings
//
// Not a top-level tab: the button on the Generate pane opens this screen in
// place of the feed, and Back — or picking Generate/Job bid — closes it again.
// Like a tab switch it only shows and hides, so the feed keeps streaming and
// an unsaved edit in either settings tab survives a trip back to the list.
// ---------------------------------------------------------------------------

const settingsPaneEl = $("pane-profile");
const openSettingsEl = $("openSettings");
const closeSettingsEl = $("closeSettings");

function showSettings(open) {
  settingsPaneEl.hidden = !open;
  openSettingsEl.setAttribute("aria-expanded", String(open));
  const current = mainTabs.tabs.find((t) => t.getAttribute("aria-selected") === "true") || mainTabs.tabs[0];
  $(current.getAttribute("aria-controls")).hidden = open;
}

openSettingsEl.addEventListener("click", () => {
  showSettings(true);
  closeSettingsEl.focus();
});

closeSettingsEl.addEventListener("click", () => {
  showSettings(false);
  openSettingsEl.focus();
});

// ---------------------------------------------------------------------------
// Theme
//
// Light by default; dark is an explicit, saved choice, not a system-preference
// follow — the panel should not flip on you just because the OS theme does.
// Applying is nothing but a data-theme attribute on <html>: sidepanel.css
// holds both palettes as custom properties, so nothing here touches a color.
// ---------------------------------------------------------------------------

const themeToggleEl = $("themeToggle");
const iconMoonEl = $("iconMoon");
const iconSunEl = $("iconSun");

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  themeToggleEl.setAttribute("aria-pressed", String(dark));
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  themeToggleEl.setAttribute("aria-label", label);
  themeToggleEl.title = label;
  // The icon shown is the mode a click would switch TO, matching the label.
  iconMoonEl.hidden = dark;
  iconSunEl.hidden = !dark;
}

themeToggleEl.addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next); // instant — do not wait on the storage round trip to flip
  await send({ type: "SET_THEME", theme: next });
});

async function loadTheme() {
  const reply = await send({ type: "GET_THEME" });
  applyTheme(reply.ok && reply.theme === "dark" ? "dark" : "light");
}

loadTheme();

// ---------------------------------------------------------------------------
// Refill from storage on open, so reopening the panel is not a blank slate.
// ---------------------------------------------------------------------------

async function init() {
  const state = await send({ type: "GET_STATE" });

  if (!state.ok) {
    setStatus(`Error: ${state.error}`, "err");
    return;
  }

  for (const job of state.jobs) addJob(job, { animate: false });
  await loadProfile();
  updateCount();

  if (rendered.size) setStatus(`${rendered.size} from the last run · press Start to resume`);
  else setStatus("Idle.");
}

init();
