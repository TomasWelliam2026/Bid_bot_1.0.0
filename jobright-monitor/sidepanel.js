// The side panel. Renders jobs as they stream in.
//
// The content script broadcasts every card it finds as JOB_FOUND. The service
// worker asks the collector whether it already has each one, and re-broadcasts
// only the new ones as JOB_ADDED — which is what this list renders. So a job
// the collector already holds never appears here at all.

const $ = (id) => document.getElementById(id);

const listEl = $("list");
const statusEl = $("status");
const startEl = $("start");
const stopEl = $("stop");
const queueEl = $("queue");

// Keep in step with MAX_ITEMS in content.js and MAX_STORED in background.js.
const MAX_ITEMS = 30;

const rendered = new Map(); // key -> the <li>, so details can be filled in later
let sawStaleClass = false;

// Two independent things can be running, and Stop has to stay available while
// either is: the feed stream in the jobright tab, and the visit queue, which
// keeps draining after the stream itself has finished.
let feedRunning = false;
let queueRunning = false;
// A run waiting on a human check is still a run: Stop stays on, Start off.
let verifyPaused = false;

function syncButtons() {
  const active = feedRunning || queueRunning || verifyPaused;
  // Start also waits on a job board that can actually be fetched from.
  startEl.disabled = active || !SUPPORTED_SOURCES.has(jobSource);
  stopEl.disabled = !active;
  // The board is fixed while a run is on: switching clears the list, and a
  // stream still running would fill it straight back up from the old board.
  // So is what it was asked to search for.
  $("jobSource").disabled = active;
  $("indeedSearch").disabled = active;
  const captureOnly = $("captureOnly"); // not in the desktop app
  if (captureOnly) captureOnly.disabled = active;
}

// ---------------------------------------------------------------------------
// Job board
//
// The picker under Auto/Manual says where Auto fetches jobs from. Jobright,
// Dice, Glassdoor, Indeed and ZipRecruiter each have a content script; Indeed
// opens at the search the form below asks for rather than a fixed page.
// Monster can be picked but has no fetcher yet, so Start stays off and the
// panel says why. The choice is remembered in this panel's own storage.
// ---------------------------------------------------------------------------

const SOURCE_NAMES = {
  jobright: "Jobright",
  dice: "Dice",
  glassdoor: "Glassdoor",
  indeed: "Indeed",
  monster: "Monster",
  ziprecruiter: "ZipRecruiter"
};
const SUPPORTED_SOURCES = new Set(["jobright", "dice", "glassdoor", "indeed", "ziprecruiter"]);
// Boards the search form applies to. Jobright's feed is its own recommendations.
const SEARCHABLE_SOURCES = new Set(["dice", "glassdoor", "indeed", "ziprecruiter"]);
// What the status line says while a run opens that board's page.
const SOURCE_OPENING = {
  jobright: "Opening jobright.ai/jobs/recommend…",
  dice: "Opening the Dice job search…",
  glassdoor: "Opening the Glassdoor job search…",
  indeed: "Opening the Indeed job search…",
  ziprecruiter: "Opening the ZipRecruiter job search…"
};
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
  li.dataset.source = job.source || "";
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

  // Where it is, what it pays and when it was posted, from boards whose cards
  // say (Indeed's).
  const info = [job.location, job.salary, job.posted].filter(Boolean);
  if (info.length) li.appendChild(tag("job-info", info.join(" · ")));

  // Only what went wrong reading the card; a clean card gets no meta line.
  const missing = [!job.company && "no company found", !job.href && "no link"].filter(Boolean);
  if (missing.length) {
    const meta = document.createElement("div");
    meta.className = "job-meta";
    meta.textContent = missing.join(" · ");
    li.appendChild(meta);
  }

  listEl.appendChild(li);

  // A job restored from storage may already carry its reading.
  if (job.detail) addDetail(job.key, job.detail);

  if (job.staleTitleClass || job.staleCompanyClass) sawStaleClass = true;
}

// ---------------------------------------------------------------------------
// The detail reading, filled in once the worker has opened and read the job's
// own page.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The step the worker is at on the job it is working on, shown on that job's
// own row until its outcome arrives. The worker sends it with every queue
// status, so a panel opened mid-run picks it up too. The seconds count shows
// the slow wait — ChatGPT — is still moving rather than stuck.
// ---------------------------------------------------------------------------

const STAGE_TEXT = {
  opening: "Opening the job page…",
  reading: "Reading the job description…",
  pane: "Clicking the job's card on Indeed…",
  verify: "Paused — waiting for the human check in the Indeed tab…",
  waiting: "Waiting for data from ChatGPT…",
  building: "Building resume…",
  saving: "Sending to localhost:4500…"
};

// With whose resume it is, once the job is being written for each profile.
const stageText = (active) =>
  (STAGE_TEXT[active.stage] || active.stage) + (active.profile ? ` — ${active.profile}` : "");

let stageEl = null;
let stageTimer = null;

function showStage(active) {
  const li = active && rendered.get(active.key);
  if (!li || li.dataset.detailed) {
    clearStage();
    return;
  }

  if (stageEl?.parentNode !== li) {
    clearStage();
    stageEl = tag("job-note stage", "");
    stageEl.setAttribute("role", "status");
    stageEl.append(document.createElement("span"), document.createElement("span"));
    stageEl.lastChild.className = "elapsed";
    li.appendChild(stageEl);
  }

  stageEl.firstChild.textContent = stageText(active);
  const tick = () => {
    const secs = Math.max(0, Math.round((Date.now() - active.at) / 1000));
    stageEl.lastChild.textContent = secs >= 3 ? `${secs}s` : "";
  };
  tick();
  clearInterval(stageTimer);
  stageTimer = setInterval(tick, 1000);
}

function clearStage() {
  clearInterval(stageTimer);
  stageTimer = null;
  stageEl?.remove();
  stageEl = null;
}

function addDetail(key, detail) {
  const li = rendered.get(key);
  if (!li || li.dataset.detailed) return;
  li.dataset.detailed = "1";
  if (stageEl?.parentNode === li) clearStage();

  // ZipRecruiter's card carries no permalink of its own — the job's real
  // link is the address the browser is actually left on once the card is
  // clicked and its description comes up, known only now that it has been
  // read. The title becomes (or stays) a link to exactly that.
  if (li.dataset.source === "ziprecruiter" && detail?.url) {
    let title = li.querySelector(".job-title");
    if (title && title.tagName !== "A") {
      const a = document.createElement("a");
      a.className = title.className;
      a.textContent = title.textContent;
      title.replaceWith(a);
      title = a;
    }
    if (title) {
      title.href = detail.url;
      title.target = "_blank";
      title.rel = "noreferrer";
    }
  }

  if (!detail?.ok) {
    li.classList.add("failed");
    li.appendChild(tag("job-note warn", `Could not read: ${detail?.error || "unknown"}`));
    return;
  }

  // The whole point of the pass: a LinkedIn origin ends it here.
  if (detail.isLinkedIn) {
    li.classList.add("dropped");
    li.appendChild(tag("job-note", detail.captured ? "LinkedIn posting · captured without its description" : "LinkedIn posting · tab closed, skipped"));
    return;
  }

  if (detail.captured) li.appendChild(tag("job-note", "Captured · company, title, link and description kept"));

  // The POST outcomes are the thing you actually need to see at a glance, so
  // they sit on the row rather than inside the collapsed block — one set per
  // profile the job was written for.
  const results = resultsOf(detail);

  // Profiles whose tab already had this job, so it was not written for them.
  if (detail.existingOn?.length) {
    li.appendChild(tag("job-note", `Already on ${detail.existingOn.join(", ")} — not written again`));
  }
  if (detail.profilesError) {
    li.appendChild(tag("job-note warn", `No resumes: ${detail.profilesError}`));
  }

  appendOutcomes(li, results);
  // No resume built for anyone, so this job went nowhere: said by the row's
  // look as well as its notes.
  if (detail.profilesError || (results.length && !results.some((r) => r.resume?.ok))) {
    li.classList.add("failed");
  }

  // Written, but the duplicate check itself was not answered.
  const checkError = detail.checkError ?? detail.save?.checkError;
  if (checkError) li.appendChild(tag("job-note warn", `Duplicate check failed: ${checkError}`));

  if (!detail.descriptionFound) {
    li.appendChild(tag("job-note warn", "No #overview-1 element on the page"));
  }

  const box = document.createElement("details");
  box.className = "detail";

  const summary = document.createElement("summary");
  summary.textContent =
    answersSummary(results) ||
    (detail.captured ? "Job description" : detail.descriptionFound ? "Read, but no answer" : "No description found");
  box.appendChild(summary);

  if (detail.originText || detail.originHref) {
    box.appendChild(field("Source", detail.originText || detail.originHref));
  }

  // Confirms the trim actually bit, rather than leaving you to eyeball the HTML.
  // Only Jobright's reading is trimmed; the other boards' carry no counts.
  if (detail.descriptionFound && detail.droppedSections != null) {
    box.appendChild(
      field(
        "Trimmed",
        `${detail.droppedSections} leading section(s), ${detail.droppedBlocks} block(s) removed`
      )
    );
  }

  appendAnswers(box, results);

  if (detail.staleDetailClass) sawStaleClass = true;

  li.appendChild(box);
}

// One entry per profile a resume was written for: { profileName, resume,
// save }. A job stored by an older build has a single `resume` and `save`
// and no profile — shown as one entry without a name.
function resultsOf(detail) {
  if (detail.results) return detail.results;
  return detail.resume ? [{ profileName: null, resume: detail.resume, save: detail.save }] : [];
}

const whoOf = (result) => (result.profileName ? `${result.profileName} · ` : "");

// What happened for each profile, as notes: a resume that did not build (and
// so was not sent), one that built but not cleanly — wrong number of roles, an
// empty job — and whether its save landed. Generation runs before the save, so
// its outcome comes first. Answers how many were saved.
function appendOutcomes(container, results) {
  let saved = 0;
  for (const r of results) {
    const who = whoOf(r);
    if (!r.resume?.ok) {
      container.appendChild(
        tag(r.resume?.skipped ? "job-note" : "job-note warn", `${who}No resume: ${r.resume?.error || "unknown"}`)
      );
      // The save is gated on the resume, so this one went nowhere. Said
      // plainly rather than leaving it with no outcome at all.
      container.appendChild(tag("job-note warn", `${who}Not sent — nothing is saved without a resume`));
      continue;
    }
    for (const w of r.resume.warnings || []) container.appendChild(tag("job-note warn", `${who}${w}`));
    if (r.save?.ok) saved++;
    container.appendChild(
      r.save?.ok
        ? tag("job-note saved", `${who}Saved with resume`)
        : tag("job-note warn", `${who}Save failed: ${r.save?.error || "unknown"}`)
    );
  }
  return saved;
}

// "Answer · 4,120 chars", or with several profiles, how many answered and
// how much they wrote between them. Empty when none answered.
function answersSummary(results) {
  const answered = results.filter((r) => r.resume?.raw);
  if (!answered.length) return "";
  const chars = answered.reduce((n, r) => n + r.resume.raw.length, 0).toLocaleString();
  return answered.length === 1 && !answered[0].profileName
    ? `Answer · ${chars} chars`
    : `${answered.length} answer(s) · ${chars} chars`;
}

// What each profile's answer gave, and the answer itself to check that
// against — parsed or not. The job description is deliberately not shown: it
// is readable on the job's own page, and this block is for checking each
// answer against its prompt.
function appendAnswers(box, results) {
  for (const r of results) {
    const who = whoOf(r);
    const resume = r.resume;
    if (resume?.ok) {
      box.appendChild(
        field(
          `${who}Resume built`,
          `${resume.html.length.toLocaleString()} chars of HTML · ` +
            `${resume.data.SKILLS.length} skills line(s) · ` +
            `${resume.data.EXPERIENCE.reduce((n, e) => n + (e.bullets ?? e).length, 0)} bullet(s) across ` +
            `${resume.data.EXPERIENCE.length} role(s)`
        )
      );
      box.appendChild(field(`${who}Summary`, resume.data.SUMMARY));
      if (resume.coverletter) box.appendChild(field(`${who}Cover letter`, resume.coverletter));
    }
    if (resume?.raw) {
      box.appendChild(field(resume.ok ? `${who}Answer` : `${who}Answer (did not parse)`, resume.raw));
    }
  }
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

  if (msg?.type === "VERIFY_STATUS") {
    showVerify(msg.pause);
    return false;
  }

  // A full list, every job in it done: the worker has cleared it and is
  // fetching the next batch — Jobright scrolls on, the other boards turn the
  // page or load more. Only the rows go — the queue strip's tally is the
  // whole run's, so it stays.
  if (msg?.type === "BATCH_CLEARED") {
    clearStage();
    listEl.replaceChildren();
    rendered.clear();
    setStatus(
      `Batch ${msg.batch} done · ${msg.done ?? msg.size} job${(msg.done ?? msg.size) === 1 ? "" : "s"} ${captureRun ? "captured" : "written and sent"} · list cleared, ${msg.board || "Jobright"} ${msg.next || "scrolling for more"}…`,
      "live"
    );
    return false;
  }

  // Every job caught so far is done, the list is not full yet, and the feed
  // has more below: it scrolls on for them.
  if (msg?.type === "SCROLLING_MORE") {
    setStatus(`All caught jobs done · ${msg.accepted} of ${msg.size} · scrolling Jobright for more…`, "live");
    return false;
  }

  // Several search terms: the last one's jobs are all read, and the same tab
  // has gone on to search for the next, from an empty list.
  if (msg?.type === "TERM_STARTED") {
    clearStage();
    listEl.replaceChildren();
    rendered.clear();
    setStatus(`Search ${msg.index + 1} of ${msg.total}: “${msg.term}”…`, "live");
    return false;
  }

  if (msg?.type === "TERMS_DONE") {
    setStatus(`All ${msg.total} search terms done.`);
    return false;
  }

  if (msg?.type === "CAPTURE_ADDED") {
    showCaptureCount(msg.count);
    return false;
  }

  // The search for this batch is over; the resumes are built now.
  if (msg?.type === "BUILD_STARTED") {
    setStatus(
      `Search done · ${msg.count} job${msg.count === 1 ? "" : "s"} caught — ${captureRun ? "reading each one" : "building the resumes"}…`,
      "live"
    );
    return false;
  }

  if (msg?.type === "FEED_DONE") {
    setStatus(`Every caught job is done · Jobright has ${msg.reason}.`);
    return false;
  }

  if (msg?.type === "DETAIL_STATUS") {
    const s = msg.status;
    queueRunning = s.draining;
    syncButtons();
    showStage(s.active);
    queueEl.hidden = !s.draining && !s.pending;
    const tally = captureRun
      ? `${s.visited} read and captured`
      : `${s.visited} read · ${s.generated} written · ${s.saved} saved · ${s.skipped} filtered out`;
    const doing = s.active ? ` · ${s.active.title} — ${stageText(s.active)}` : "";
    queueEl.textContent = s.draining
      ? `Reading · ${s.pending} queued · ${tally}${doing}`
      : s.pending
        ? `${s.pending} caught · searching for more before building · ${tally}`
        : tally;
    return false;
  }

  // The worker moved a manual pass on to its next stage. Only the panel that
  // asked for it has anything on screen to update, and it is the only one
  // listening.
  if (msg?.type === "MANUAL_STATUS") {
    const who = msg.profile ? `${msg.profile}: ` : "";
    if (msg.stage === "generating") showManualStatus(`${who}Writing the resume — this takes as long as the model does…`);
    if (msg.stage === "waiting") showManualStatus(`${who}Waiting for data from ChatGPT — this takes as long as the model does…`);
    if (msg.stage === "building") showManualStatus(`${who}Answer received — building the resume…`);
    if (msg.stage === "saving") showManualStatus(`${who}Resume built — sending it to localhost:4500…`);
    return false;
  }

  if (msg?.type === "FEED_STATUS") {
    const s = msg.status;
    setRunning(s.streaming);

    if (s.signedOut) {
      setStatus("No cards — you are probably signed out of jobright.ai.", "err");
    } else if (s.error) {
      setStatus(`Error: ${s.error}`, "err");
    } else if (s.blocked) {
      // A human check in place of the results; the notice says what to do.
      setStatus("Paused · waiting for the human check in the Indeed tab", "live");
    } else if (s.streaming && !s.onRecommendPage) {
      setStatus("That tab left the job list.", "err");
    } else if (s.atLimit) {
      // Every board goes on in batches of MAX_ITEMS.
      setStatus(`${s.accepted} new · list full — once every job is done, the list is cleared and more are caught`);
    } else if (s.paging) {
      setStatus(`This page is done · clicking Next for more jobs… ${s.accepted} new so far`, "live");
    } else if (s.lastPage) {
      setStatus(`Last page reached · ${s.accepted} new of ${s.total} seen`);
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

// ---------------------------------------------------------------------------
// Before a run
//
// Start first asks the worker whether everything a job catch needs is in
// place — the board, the collector, the profiles, ChatGPT, each profile's
// resume style — and shows the answer as a list. Anything marked ✕ would stop
// the run from getting anywhere, so the run is not started; ! is a warning,
// and the run goes ahead. Run in the desktop app, the list also says whether
// the browser is connected, or can be.
// ---------------------------------------------------------------------------

const preflightEl = $("preflight");
const preflightSummaryEl = $("preflightSummary");
const preflightListEl = $("preflightList");
const CHECK_MARK = { ok: "✓", warn: "!", fail: "✕" };

function showPreflight(checks) {
  const failed = checks.filter((c) => c.state === "fail");
  const warned = checks.filter((c) => c.state === "warn");
  preflightListEl.replaceChildren(
    ...checks.map((c) => {
      const li = document.createElement("li");
      li.className = `check ${c.state}`;
      const mark = document.createElement("span");
      mark.className = "check-mark";
      mark.setAttribute("aria-label", c.state === "ok" ? "OK" : c.state === "warn" ? "Warning" : "Problem");
      mark.textContent = CHECK_MARK[c.state];
      const label = document.createElement("span");
      label.className = "check-label";
      label.textContent = c.label;
      const detail = document.createElement("span");
      detail.className = "check-detail";
      detail.textContent = c.detail || "";
      li.append(mark, label, detail);
      return li;
    })
  );
  preflightSummaryEl.textContent = failed.length
    ? `✕ ${failed.length} of ${checks.length} checks failed — not started`
    : warned.length
      ? `! All ${checks.length} checks passed · ${warned.length} warning${warned.length === 1 ? "" : "s"}`
      : `✓ All ${checks.length} checks passed`;
  preflightEl.className = `preflight ${failed.length ? "fail" : warned.length ? "warn" : "ok"}`;
  // Open when something needs doing; folded to its one line when all is well.
  preflightEl.open = failed.length > 0 || warned.length > 0;
  preflightEl.hidden = false;
}

async function runPreflight(options) {
  const reply = await send({ type: "PREFLIGHT", options });
  const checks = reply.ok ? reply.checks : [{ key: "worker", label: "Bid Bot", state: "fail", detail: reply.error }];
  // The desktop app adds the one thing only it knows: the browser.
  if (window.bidbotDesktop?.checkBrowser) {
    try {
      checks.unshift(await window.bidbotDesktop.checkBrowser());
    } catch (err) {
      checks.unshift({ key: "browser", label: "Browser", state: "fail", detail: err?.message || String(err) });
    }
  }
  showPreflight(checks);
  return !checks.some((c) => c.state === "fail");
}

startEl.addEventListener("click", async () => {
  if (feedRunning || queueRunning) return;

  // The search terms, on every board but Jobright. Indeed has no page of its
  // own to open — only a search, which needs something to search for.
  const search = SEARCHABLE_SOURCES.has(jobSource) ? readSearch() : undefined;
  const capture = captureOnlyEl.checked;

  startEl.disabled = true;
  setStatus("Checking everything a run needs…", "live");
  const ready = await runPreflight({ source: jobSource, search, capture });
  syncButtons();
  if (!ready) {
    setStatus("Not started — fix the items marked ✕, then press Start again.", "err");
    if (search && !search.role) $("searchRole").focus();
    return;
  }

  setStatus(SOURCE_OPENING[jobSource] || "Opening the job board…", "live");
  setRunning(true);
  captureRun = capture;

  // A run always does the whole job: scroll for every card, open each one,
  // and send what it builds to the collector — or, capturing, keep what it
  // read of each job instead.
  const reply = await send({
    type: "START",
    options: { source: jobSource, search, capture, autoScroll: true, visitJobs: true, saveJobs: !capture }
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

// ---------------------------------------------------------------------------
// The human check
//
// While the worker waits for someone to pass a site's human check, the notice
// says so and where: the search page, or a job's own page. The worker looks
// at the tab every few seconds and carries on by itself once it is passed, so
// there is nothing to press here afterwards — only the tab to bring up.
// ---------------------------------------------------------------------------

const verifyNoticeEl = $("verifyNotice");

function showVerify(pause) {
  verifyPaused = !!pause;
  verifyNoticeEl.hidden = !pause;
  syncButtons();
  if (!pause) return;

  const where = pause.page === "job" && pause.title
    ? `before it shows the job “${pause.title}”`
    : "before it shows the search results";
  $("verifyText").textContent =
    `Indeed wants a person to confirm ${where}. Complete the check in the Indeed tab — ` +
    "the run carries on by itself once it is passed. If the tab shows no check to complete, press Stop.";
}

$("verifyShow").addEventListener("click", () => send({ type: "FOCUS_VERIFY" }));

// Empties the list here and in the worker. Clear does it on demand; changing
// the job board does it too, so one board's jobs never sit under another's.
async function clearList() {
  listEl.replaceChildren();
  rendered.clear();
  sawStaleClass = false;
  queueEl.hidden = true;
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
const modeButtons = [...modeSwitchEl.querySelectorAll('[role="radio"]')];

function selectMode(button) {
  for (const b of modeButtons) {
    const on = b === button;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1; // one stop in the tab order, arrows move within
    $(b.getAttribute("aria-controls")).hidden = !on;
  }
  // The feed's own controls belong to Auto: Start/Stop/Clear and the board
  // picker have nothing to act on when the job is being typed in.
  autoControlsEl.hidden = button.id === "mode-manual";
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

// ---------------------------------------------------------------------------
// The Indeed search
//
// What Indeed is searched for: Indeed's own two boxes — the role ("What") and
// where (a city, state, zip code, or "remote") — plus the country whose Indeed
// site is searched, and optionally a job type, how recent, and remote only.
// Shown while Indeed is the board, sent with Start, and remembered in this
// panel's own storage like the board itself.
// ---------------------------------------------------------------------------

const SEARCH_KEY = "indeedSearch";
const searchEl = $("indeedSearch");
const SEARCH_FIELDS = {
  role: $("searchRole"),
  country: $("searchCountry"),
  location: $("searchLocation"),
  jobType: $("searchJobType"),
  postedDays: $("searchPosted"),
  remote: $("searchRemote")
};

function readSearch() {
  const f = SEARCH_FIELDS;
  return {
    role: f.role.value.trim(),
    country: f.country.value,
    location: f.location.value.trim(),
    jobType: f.jobType.value,
    postedDays: Number(f.postedDays.value) || 0,
    remote: f.remote.checked
  };
}

function saveSearch() {
  try {
    localStorage.setItem(SEARCH_KEY, JSON.stringify(readSearch()));
  } catch {
    // not remembered; the fields still hold it until the panel closes
  }
}

function restoreSearch() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SEARCH_KEY) || "null");
  } catch {
    // unreadable: the form starts blank
  }
  if (!saved || typeof saved !== "object") return;

  const f = SEARCH_FIELDS;
  f.role.value = String(saved.role || "");
  f.location.value = String(saved.location || "");
  f.remote.checked = !!saved.remote;
  // A select keeps its first option when the saved value is not one of its own.
  const pick = (select, value) => {
    if ([...select.options].some((o) => o.value === value)) select.value = value;
  };
  pick(f.country, String(saved.country || ""));
  pick(f.jobType, String(saved.jobType || ""));
  pick(f.postedDays, saved.postedDays ? String(saved.postedDays) : "");
}

restoreSearch();
for (const el of Object.values(SEARCH_FIELDS)) {
  el.addEventListener(el.tagName === "INPUT" && el.type === "text" ? "input" : "change", saveSearch);
}

function selectSource(source) {
  jobSource = source;
  jobSourceEl.value = source;
  searchEl.hidden = !SEARCHABLE_SOURCES.has(source);
  $("searchLegend").textContent = `${SOURCE_NAMES[source]} search`;
  $("searchCountryField").hidden = source !== "indeed";
  const supported = SUPPORTED_SOURCES.has(source);
  sourceNoteEl.hidden = supported;
  sourceNoteEl.textContent = supported
    ? ""
    : `${SOURCE_NAMES[source]} is not connected yet — only Jobright, Dice, Glassdoor, Indeed and ZipRecruiter fetch jobs for now.`;
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

// ---------------------------------------------------------------------------
// Capture only
//
// With the switch on, a run reads each job and keeps its company, title,
// link and description — no resume, nothing sent to the collector. What is
// captured builds up across runs, in the worker, until Clear under it; the
// strip above the list says how many and exports them as CSV or JSON.
// ---------------------------------------------------------------------------

const CAPTURE_KEY = "captureOnly";
const captureOnlyEl = $("captureOnly");
let captureRun = false;

// The desktop app has no capture-only runs: the switch and the captured
// list are the extension's alone, and every app run writes resumes.
const CAPTURE_OFFERED = !window.bidbotDesktop;
if (!CAPTURE_OFFERED) captureOnlyEl.closest(".switch-row").remove();

try {
  captureOnlyEl.checked = CAPTURE_OFFERED && localStorage.getItem(CAPTURE_KEY) === "1";
} catch {
  // not remembered: off
}
captureOnlyEl.addEventListener("change", () => {
  try {
    localStorage.setItem(CAPTURE_KEY, captureOnlyEl.checked ? "1" : "0");
  } catch {
    // applies until the panel closes
  }
});

function showCaptureCount(count) {
  $("captures").hidden = !count || !CAPTURE_OFFERED;
  $("captureCount").textContent = `${count} job${count === 1 ? "" : "s"} captured`;
}

const CAPTURE_COLUMNS = ["term", "board", "company", "title", "url", "location", "description", "note", "capturedAt"];

const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// A file handed to the browser's own download, named for today.
function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportCaptures(format) {
  const reply = await send({ type: "GET_CAPTURES" });
  if (!reply.ok) return setStatus(`Error: ${reply.error}`, "err");
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json") {
    download(`jobs-${stamp}.json`, "application/json", JSON.stringify(reply.captures, null, 2));
  } else {
    const rows = [CAPTURE_COLUMNS, ...reply.captures.map((c) => CAPTURE_COLUMNS.map((k) => c[k]))];
    // The byte order mark is what makes Excel read the file as UTF-8.
    download(`jobs-${stamp}.csv`, "text/csv", "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
  }
  setStatus(`Exported ${reply.captures.length} job${reply.captures.length === 1 ? "" : "s"} as ${format.toUpperCase()}.`);
}

$("exportCsv").addEventListener("click", () => exportCaptures("csv"));
$("exportJson").addEventListener("click", () => exportCaptures("json"));
// Two presses, so one stray click cannot throw a whole capture away.
const clearCapturesEl = $("clearCaptures");
let clearArmed = null;
clearCapturesEl.addEventListener("click", async () => {
  if (!clearArmed) {
    clearCapturesEl.textContent = "Press again to clear";
    clearArmed = setTimeout(() => {
      clearArmed = null;
      clearCapturesEl.textContent = "Clear";
    }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  clearCapturesEl.textContent = "Clear";
  await send({ type: "CLEAR_CAPTURES" });
  showCaptureCount(0);
});

const manualGenerateEl = $("manualGenerate");
const manualStatusEl = $("manualStatus");
const manualResultEl = $("manualResult");

function showManualStatus(text, kind = "") {
  manualStatusEl.hidden = !text;
  manualStatusEl.className = `hint ${kind}`.trim();
  manualStatusEl.textContent = text;
}

// The same outcomes the feed puts on a row, under the form instead: for each
// profile, what the model gave back and whether it was sent, and the answers
// themselves to check those against.
function renderManualResult({ results = [], duplicate, existingOn = [], checkError }) {
  manualResultEl.replaceChildren();

  // Found before the model was asked, so nothing was written or sent.
  if (duplicate) {
    showManualStatus(
      `Already exists — ${existingOn.join(", ")} already ${existingOn.length === 1 ? "has" : "have"} this company and job title. Nothing generated.`,
      "warn"
    );
    return;
  }

  if (existingOn.length) {
    manualResultEl.appendChild(tag("job-note", `Already on ${existingOn.join(", ")} — not written again`));
  }

  // The check failing is not a reason to hold the job back, but it means the
  // job went ahead without knowing whether it was a repeat.
  if (checkError) {
    manualResultEl.appendChild(tag("job-note warn", `Duplicate check failed: ${checkError}`));
  }

  // Gated exactly as a feed job is — a resume that did not build means
  // nothing was sent for that profile, so its tab has nothing half-written.
  const saved = appendOutcomes(manualResultEl, results);
  showManualStatus(
    saved === results.length
      ? `Saved with resume${results.length > 1 ? ` for all ${results.length} profiles` : ""} — the collector writes the PDFs from here.`
      : `Saved for ${saved} of ${results.length} profile(s) — see below.`,
    saved === results.length ? "saved" : "warn"
  );

  const answers = answersSummary(results);
  if (!answers) return;
  const box = document.createElement("details");
  box.className = "detail";
  const summary = document.createElement("summary");
  summary.textContent = answers;
  box.appendChild(summary);
  appendAnswers(box, results);
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
// Settings
//
// What this screen saves: the API key and model under ChatGPT setting, the
// Country and Role picked under Profile, and — kept on each dashboard tab
// rather than here — every listed profile's own prompt, master resume and
// resume style. One Save covers the lot; nothing is written on a keystroke.
// ---------------------------------------------------------------------------

// What is saved to this extension's own storage. `model` is a select with a
// free-text escape hatch; country and role are picked from the profiles.
const SETTINGS_FIELDS = ["apiKey", "model", "country", "role"];

const CUSTOM_MODEL = "__custom__";
const modelEl = $("model");
const modelCustomEl = $("modelCustom");
const saveProfileEl = $("saveProfile");
const revertProfileEl = $("revertProfile");
const profileStatusEl = $("profileStatus");
const countryEl = $("profileCountry");
const roleEl = $("profileRole");

// The last saved settings, so "has anything changed?" is a comparison rather
// than a flag that can drift out of step with the fields.
let savedSettings = null;

// What a profile with no prompt or style of its own is written with — the
// worker's own, sent along with the settings.
let defaults = { prompt: "", resumeStyle: "DE-1" };

// Country and role are matched the way the worker and the dashboard match
// them: ignoring case and surrounding spaces.
const matchKey = (s) => String(s ?? "").trim().toLowerCase();

// A model the list does not carry — a pinned snapshot, or one released after
// this build — selects Custom… and shows the free-text box.
function setModelControls(model) {
  const known = [...modelEl.options].some((o) => o.value === model);
  modelEl.value = known ? model : CUSTOM_MODEL;
  modelCustomEl.value = known ? "" : model;
  modelCustomEl.hidden = known;
}

// Only the key is trimmed — silently rewriting what was typed is worse than
// storing it as-is.
function readForm() {
  return {
    apiKey: $("apiKey").value.trim(),
    model: modelEl.value === CUSTOM_MODEL ? modelCustomEl.value.trim() : modelEl.value,
    country: countryEl.value,
    role: roleEl.value
  };
}

function fillForm(settings) {
  $("apiKey").value = settings.apiKey ?? "";
  setModelControls(settings.model ?? "");
  renderChoices(settings.country, settings.role);
}

// A saved "us" shown as the dashboard's own "US" is the same pick, not an edit.
const isDirty = () => {
  if (!savedSettings) return false;
  const now = readForm();
  const changed = SETTINGS_FIELDS.some((f) =>
    f === "country" || f === "role"
      ? matchKey(now[f]) !== matchKey(savedSettings[f])
      : now[f] !== (savedSettings[f] ?? "")
  );
  return changed || profileDrafts.size > 0;
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
    showKeyState(savedSettings?.apiKey);
  }
}

function showKeyState(apiKey) {
  profileStatusEl.className = "hint";
  profileStatusEl.textContent = apiKey
    ? "Key set. Resumes will be generated for jobs the collector does not have."
    : "No key set — nothing will be saved, since a job is only sent once its resume is built.";
}

async function loadSettings() {
  const reply = await send({ type: "GET_SETTINGS" });
  if (!reply.ok) {
    profileStatusEl.className = "hint warn";
    profileStatusEl.textContent = `Could not load: ${reply.error}`;
    return;
  }
  defaults = reply.defaults ?? defaults;
  savedSettings = reply.settings;
  fillForm(savedSettings);
  syncProfileButtons();
  restoreModels(savedSettings.apiKey); // not waited for: it may ask OpenAI
}

// ---------------------------------------------------------------------------
// The models the key can use
//
// The Model list starts as the built-in one in sidepanel.html. Once the key's
// own models are loaded — asked of OpenAI by the worker, on Load models, when
// a new key is entered, or on opening with a key whose list was never loaded
// — it is exactly those: the names that always mean the latest version,
// newest first, then the dated snapshots. Custom… stays for anything else.
// ---------------------------------------------------------------------------

const BUILTIN_MODELS = modelEl.innerHTML; // the HTML's own options, Custom… included
const loadModelsEl = $("loadModels");
const modelsStatusEl = $("modelsStatus");

function showModelsStatus(text, kind = "") {
  modelsStatusEl.hidden = !text;
  modelsStatusEl.className = `hint ${kind}`.trim();
  modelsStatusEl.textContent = text;
}

// Which key a kept list belongs to, by its last four characters.
const keyEnd = (key) => String(key || "").trim().slice(-4);

function describeModels(list) {
  const when = new Date(list.loadedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const snapshots = list.snapshots.length ? ` and ${list.snapshots.length} snapshot(s)` : "";
  return `${list.models.length} model(s)${snapshots} available to this key · loaded ${when}`;
}

// The list's options from a loaded list, or the built-in ones with none,
// keeping whatever model the form shows picked — a pick the new list does
// not carry moves to Custom…, as a saved one always has.
function renderModels(list) {
  const picked = readForm().model;
  if (!list) {
    modelEl.innerHTML = BUILTIN_MODELS;
  } else {
    const group = (label, ids) => {
      const g = document.createElement("optgroup");
      g.label = label;
      for (const id of ids) g.appendChild(new Option(id, id));
      return g;
    };
    modelEl.replaceChildren();
    if (list.models.length) modelEl.appendChild(group(`Available to your API key (${list.models.length})`, list.models));
    if (list.snapshots.length) modelEl.appendChild(group(`Dated snapshots (${list.snapshots.length})`, list.snapshots));
    modelEl.appendChild(new Option("Custom…", CUSTOM_MODEL));
  }
  setModelControls(picked);
  syncProfileButtons();
}

async function loadModels(apiKey) {
  apiKey = String(apiKey || "").trim();
  if (!apiKey) {
    showModelsStatus("Enter an API key first — the list is the models that key can use.", "warn");
    return;
  }
  loadModelsEl.disabled = true;
  showModelsStatus("Loading the models this key can use…");
  const reply = await send({ type: "LIST_MODELS", apiKey });
  loadModelsEl.disabled = false;

  if (!reply.ok) {
    showModelsStatus(`Could not load the models: ${reply.error}`, "warn");
    return;
  }
  // The list stays as it was rather than empty out.
  if (!reply.models.length && !reply.snapshots.length) {
    showModelsStatus(`This key can use none of OpenAI's text models (${reply.total} model(s) in all).`, "warn");
    return;
  }
  renderModels(reply);
  showModelsStatus(describeModels(reply), "saved");
}

// On opening: the list kept for this key — or, for a key whose list was
// never loaded, loaded now.
async function restoreModels(apiKey) {
  const reply = await send({ type: "GET_MODELS" });
  const list = reply.ok ? reply.list : null;
  if (list && apiKey && list.keyEnd === keyEnd(apiKey)) {
    renderModels(list);
    showModelsStatus(describeModels(list));
  } else if (apiKey) {
    loadModels(apiKey);
  }
}

loadModelsEl.addEventListener("click", () => loadModels($("apiKey").value));

// A key typed or pasted in gets its own models, once the field is left. While
// it is being edited, what the line says is about the key before — so it goes.
$("apiKey").addEventListener("input", () => showModelsStatus(""));
$("apiKey").addEventListener("change", () => {
  const key = $("apiKey").value.trim();
  if (key) loadModels(key);
});

// ---------------------------------------------------------------------------
// Profiles
//
// A profile is one of the dashboard's tabs: a person applying in a country
// for a role. The Country and Role picked here — chosen from what the tabs
// carry, which is set in each tab's Sheet sync on the dashboard — list the
// profiles a caught job gets resumes for, one card each: that profile's own
// prompt, master resume and resume style, read from and saved to its tab.
// The list comes from the collector each time Profile is opened, or on
// Reload profiles.
//
// An edit is a draft until Save, kept per profile rather than in its card:
// picking another country or role shows other cards, and edits made in the
// ones it hides are still there — and still saved — all the same.
// ---------------------------------------------------------------------------

const profileListEl = $("profileList");
const profileEmptyEl = $("profileEmpty");
const reloadProfilesEl = $("reloadProfiles");
const profilesStatusEl = $("profilesStatus");

const OWN_FIELDS = ["prompt", "masterResume", "masterResumeMode", "resumeStyle"];

let profiles = []; // every dashboard tab, as last loaded
const profileDrafts = new Map(); // profile id -> its unsaved own values
const openCards = new Set(); // ids of the cards folded open
const profileStyleNames = new Map(); // profile id -> names of the styles it added
const styleEditors = new Map(); // profile id -> its Add a style editor's state

function showProfilesStatus(text, kind = "") {
  profilesStatusEl.hidden = !text;
  profilesStatusEl.className = `hint ${kind}`.trim();
  profilesStatusEl.textContent = text;
}

// A profile's own values as its card shows them. A blank prompt or style is
// shown as the default it stands for, so a fresh profile reads as what it
// will actually be written with.
function savedOwn(profile) {
  const own = profile.resume || {};
  return {
    prompt: String(own.prompt || "").trim() ? own.prompt : defaults.prompt,
    masterResume: own.masterResume || "",
    masterResumeMode: own.masterResumeMode === "none" ? "none" : "use",
    resumeStyle: own.style || defaults.resumeStyle
  };
}

const sameOwn = (a, b) => OWN_FIELDS.every((f) => a[f] === b[f]);

// What changed, as the collector stores it. A prompt or style left at the
// default is saved blank, so the profile keeps following the default rather
// than a copy of it.
function storedPatch(draft, saved) {
  const patch = {};
  for (const f of OWN_FIELDS) {
    if (draft[f] === saved[f]) continue;
    const isDefault =
      (f === "prompt" && draft[f] === defaults.prompt) ||
      (f === "resumeStyle" && draft[f] === defaults.resumeStyle);
    patch[f] = isDefault ? "" : draft[f];
  }
  return patch;
}

// Distinct values in order, the first spelling of each kept, blanks dropped.
function distinct(values) {
  const seen = new Map();
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && !seen.has(matchKey(text))) seen.set(matchKey(text), text);
  }
  return [...seen.values()];
}

// Rebuilds a picker's options, keeping `selected`. A value no profile
// carries — renamed on the dashboard since, or the profiles not loaded yet —
// stays as an option of its own rather than blanking, which would save as
// nothing on the next Save.
function fillChoices(select, values, selected) {
  select.replaceChildren(new Option("— Select —", ""));
  for (const value of values) select.add(new Option(value, value));
  const wanted = matchKey(selected);
  if (!wanted) {
    select.value = "";
    return;
  }
  const match = [...select.options].find((o) => o.value && matchKey(o.value) === wanted);
  if (match) {
    select.value = match.value;
    return;
  }
  select.add(new Option(`${selected} — no profile has it`, selected));
  select.value = selected;
}

// The two pickers, then the cards for what they pick. A role is offered when
// a profile in the picked country has it.
function renderChoices(country, role) {
  fillChoices(countryEl, distinct(profiles.map((p) => p.sheet?.country)), country);
  const inCountry = profiles.filter((p) => matchKey(p.sheet?.country) === matchKey(countryEl.value));
  fillChoices(roleEl, distinct(inCountry.map((p) => p.sheet?.role)), role);
  renderCards();
}

function renderCards() {
  const country = matchKey(countryEl.value);
  const role = matchKey(roleEl.value);
  const shown =
    country && role
      ? profiles.filter((p) => matchKey(p.sheet?.country) === country && matchKey(p.sheet?.role) === role)
      : [];

  // A preview open in a card goes with it, rather than being taken along.
  if (profileListEl.contains(stylePreviewEl)) closePreview();
  // Every card starts folded; only the ones you opened since picking the
  // Profile tab are drawn open again.
  profileListEl.replaceChildren(...shown.map((p) => profileCard(p, openCards.has(p.id))));

  profileEmptyEl.hidden = shown.length > 0;
  profileEmptyEl.textContent =
    !country || !role
      ? "Pick a country and a role."
      : `No profile has Country "${countryEl.value}" and Role "${roleEl.value}".`;
}

// The styles every profile has: the ones that ship with the extension, by the
// name the panel shows them under. Keep in step with RESUME_STYLES in
// background.js. Anything else a profile can pick is one it added itself.
const BUILTIN_STYLES = new Map([
  ["DE-1", "Sisu_DE_1"],
  ["DE-2", "Sisu_DE_2"],
  ["SF-1", "SF Resume style 1"],
  ["SF-2", "CreditStar_SF_1"]
]);

// A built-in style by the name the list shows it under; an added one by its own.
const styleLabel = (value) => BUILTIN_STYLES.get(value) ?? value;

// The names of the styles a profile has added, from the last load.
const ownStyles = (profileId) => profileStyleNames.get(profileId) ?? [];

function el(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text) {
  const node = el("button", "", text);
  node.type = "button";
  return node;
}

// A profile's style picker: the built-in styles, then its own. A style it
// was set to that has since been removed builds with the default, and says so.
function fillStyleOptions(select, profileId, selected) {
  select.replaceChildren();
  for (const [value, label] of BUILTIN_STYLES) select.add(new Option(label, value));
  for (const name of ownStyles(profileId)) select.add(new Option(`${name} — added`, name));
  if (![...select.options].some((o) => o.value === selected)) {
    select.add(new Option(`${selected} — removed, builds with ${styleLabel(defaults.resumeStyle)}`, selected));
  }
  select.value = selected;
}

// One profile's card. Its fields start from that profile's draft, if it has
// one, and every edit updates the draft — or drops it, once the fields are
// back to what is saved.
//
// Handed to Claude (or another model) alongside a resume screenshot, so a
// human can get a working Template HTML style in one pass instead of the
// back-and-forth it otherwise takes: every structural hole the builder
// needs, the DE-1 html/body baseline verbatim (not sampled from the image),
// precisely-measured colors/spacing/line-height, and a live-preview script
// + data.js so the result can be checked by just opening the file, before
// it's ever pasted in here. Kept as one block so "Template prompt" below can
// hand it over unedited — if the rules in it ever drift from what the
// builder actually requires (missingHoles, buildResumeHtml, the DE-1
// template), fix it here too.
const TEMPLATE_STYLE_PROMPT = `I'm attaching a screenshot of a resume. Recreate its visual design — layout, spacing, fonts/weights, colors, section order, dividers/rules, how headings and dates are styled — as closely as you can in one self-contained HTML file.

This isn't just a visual copy, though: the output has to be a TEMPLATE for a Chrome extension that builds resumes by string-replacing specific elements. It will be rejected if it doesn't follow these exact structural rules, so treat them as hard constraints, not suggestions — match the image's look, but keep this structure underneath it.

REQUIRED (the extension refuses the template if any is missing):
1. \`<p id="summary">...</p>\` — the summary/profile paragraph, wherever the image has one (or near the top if it doesn't).
2. \`<div id="skills">...</div>\` — the skills section.
3. At least one \`<div class="job"> ... <ul data-exp="0"> ... </ul> ... </div>\` block — the pattern the builder clones once per job, so match the image's FIRST (or most typical) job entry exactly. Fill it with realistic placeholder content matching the image's own content, since this block also doubles as the template's own preview.

Inside that job block, include:
- one element with class="company", one with class="role"
- EITHER class="location" and class="dates" as separate elements (optionally joined by \`<span class="sep">...</span>\` using whatever separator character/style the image uses, e.g. "|" or "•"), OR — if the image shows location and dates as one combined line — a single element with class="meta" instead.
- \`<ul data-exp="0">\` holding a few \`<li>\` bullets matching the image's bullet style.

OPTIONAL but include if the image has them (filled automatically if present, otherwise just left as placeholder, so give each real sample content):
- \`<h1 class="name">\`, a \`<title>\` tag, class="title" for the headline under the name, and \`<p class="contact">\` with the contact items the image shows, separated by \`<span class="sep">...</span>\`. If the image puts links (LinkedIn/portfolio/GitHub) on their own separate line from the rest of the contact info, put those specifically in a second \`<p class="contact links">\`.
- A repeatable \`<div class="edu-item">\` per school, with class="school", class="year", and a repeatable class="degree" line inside each (for multiple degrees at one school).
- A repeatable \`<div class="cert-item">\` (wrap the whole section in something with class="cert-section" if the image has a distinct certifications block), with class="cert-name" inside each one.

Go through the visual match like a design review, measuring, not guessing:

1. COLORS — look at the actual pixels in the image. Pick out the exact text color, heading color, any accent/rule color, and background, as hex values. Don't guess a "close enough" color (e.g. a generic navy when the image uses a specific teal/slate) — sample it as precisely as you can.

2. SPACING — measure, relative to the page: the margin around the whole page, the gap between sections (name → contact → summary → experience → education, etc.), the gap between a job's heading and its bullets, and the gap between bullets themselves.

3. LINE SPACING — measure this precisely, don't eyeball it:
   - Find a bullet or paragraph in the image that wraps onto at least two lines. Measure the pixel distance from the top of the text on the first wrapped line to the top of the text on the second wrapped line (baseline to baseline, or cap-height to cap-height — pick one and be consistent).
   - Divide that distance by the font size you sampled for that same text. That ratio IS the line-height — state it explicitly before writing any code (e.g. "bullets: ~15px line pitch at 9.8pt font ≈ 1.42 unitless ratio").
   - Do this separately for each block of wrapping text that looks visually different in the image (summary paragraph vs. bullets vs. any dense multi-line block) — they are not always the same ratio, even within one resume.
   - This is strictly about spacing BETWEEN WRAPPED LINES OF THE SAME bullet/paragraph — never confuse it with the gap between one bullet and the next, or between a bullet list and the heading above/below it; those are margins from item 2.
   - Write the result as a bare unitless number (e.g. \`1.45\`), never a px or % value — this project's PDF builder only reliably reads the unitless form.

4. LIVE PREVIEW — the template also needs to be able to render itself when opened directly in a browser, so I can actually see it filled in rather than a blank/placeholder page. Add:
   - \`<script src="./data.js"></script>\` near the top.
   - A \`<script type="module">\` at the end of the body that reads the global \`resume\` object \`data.js\` defines and fills the page from it:
     - \`#summary\` ← \`resume.SUMMARY\`
     - \`#skills\` ← one \`<p>\` per \`resume.SKILLS\` line, splitting on the first \`:\` into a \`.label\` span + \`.colon\` span + the rest
     - \`h1.name\` / \`.title\` / \`.contact\` ← \`resume.CONTACT\` as \`[name, title, ...contactItems]\`, each extra item joined with a \`.sep\` span between them, any \`https://\` item turned into an \`<a>\` (LinkedIn links shown as the text "LinkedIn")
     - the FIRST \`.job\` block is the pattern: clone it once per \`resume.EXPERIENCE\` entry (\`[company, role, location, dates, ...bullets]\`), fill \`.company\`/\`.role\`/\`.location\`/\`.dates\` (or \`.meta\`), set \`data-exp\` on its \`<ul>\` to the entry's index, fill \`<li>\`s from the bullets, then remove the original pattern block(s)
     - same clone-fill-remove pattern for \`.edu-item\` from \`resume.EDUCATION\` (\`[school, [[degree, field], ...], year]\`) and \`.cert-item\` from \`resume.CERTIFICATIONS\` (plain strings) — if there are no certifications, remove \`.cert-section\` entirely instead
   - Also give me a separate \`data.js\` file with realistic sample content matching what's actually in the screenshot, in exactly this shape:
     \`\`\`
     const resume = {
       CONTACT: ["Name", "Title", "location", "phone", "email", "https://linkedin.com/in/..."],
       SUMMARY: "...",
       SKILLS: ["Label: item, item, item"],
       EXPERIENCE: [["Company", "Role", "Location", "Dates", "bullet", "bullet"]],
       CERTIFICATIONS: [],
       EDUCATION: [["School", [["Degree", "Field"]], "Year"]]
     };
     \`\`\`
   This script is for LOCAL PREVIEW ONLY — when this template is actually used, every \`<script>\` in it is stripped and the same content gets baked in by directly string-replacing the elements by their id/class, not by running this JS. So the structural ids/classes themselves must be correct and complete on their own, with or without the script running.

5. PAGE MARGINS (PDF vs. browser preview) — this project's PDF builder adds its own fixed 15mm margin on every side of the page automatically, and reads \`@media print\` rules, overriding the normal ones for the same element. So:
   - \`body\`'s plain \`padding\` controls how it looks when opened directly in a browser (for live preview) — keep whatever padding matches the image there.
   - Never put page-margin spacing in a CSS \`margin\` on \`body\` — only \`padding\` is read for this. A \`margin\` on \`body\` is fine ONLY if it's purely for centering the page in a browser (e.g. \`margin: 0 auto;\`), never as a stand-in for the page margin itself.

6. BODY & HTML — this project's other templates (Sisu_DE_1 above all) use one exact, unstyled \`html\`/\`body\` baseline, and it must be copied verbatim here, not reinvented or sampled from the image:
   - Do not style \`html\` at all — no background, no box-shadow, nothing.
   - \`body\` gets exactly this, character for character, with only the \`color\` value's variable name possibly differing to match this template's own theme variable names:
     \`\`\`css
     body {
       margin: 0 auto;
       padding: 32px 40px 48px;
       max-width: 8.5in;
       font-family: "Segoe UI", Calibri, "Helvetica Neue", Arial, sans-serif;
       font-size: 13.5px;
       line-height: 1.45;
       color: var(--body);
       background: #fff;
     }
     \`\`\`
   - No \`box-shadow\`, no \`min-height\`, no fixed \`width\`, no \`-webkit-font-smoothing\`, no \`font-family\` other than the one above — the page's own paper-like look (the shadow framing it, the gray page background behind it) is already drawn by this project's own Preview panel around every template; the template's own \`body\`/\`html\` must not try to reproduce it.
   - \`@media print { body { padding: 0; font-size: 11pt; } }\` stays exactly this, matching DE-1's own print rule — nothing more under it.
   - Everything else — colors, fonts inside the content, headings, spacing between sections, the specific layout (centered vs. left-aligned, etc.) — stays free to match the image. Only \`html\`/\`body\` themselves are locked to this exact shared baseline.

HARD RULES — do not break these even if it means deviating slightly from the image:
- Any \`<script>\` is stripped when the extension builds a real resume, so the layout can never depend on JS running at build time. A script is only allowed as the self-contained live-preview helper above — never for anything structural or visual.
- One self-contained HTML file: inline/embedded \`<style>\`, no external fonts or assets I'd have to host separately. Use system/web-safe fonts closest to what's in the image.
- Every class/id name above must appear verbatim — the extension matches on these exact strings, not on meaning.

Give me:
- A short list of what you measured and picked (colors as hex, the line-height ratios with your math, the margin/gap values) before the code, so I can tell you if something's misread.
- The corrected, complete HTML file, plus the data.js file.

Output just those two files.`;

// Its resume style is its own as well: picked from the built-in styles and
// the ones added under this card, which no other profile is offered. The
// Add a style editor keeps what is typed in it per profile, so a card drawn
// again — a reload, another country picked and back — still has it.
function profileCard(profile, open) {
  const values = profileDrafts.get(profile.id) ?? savedOwn(profile);
  const idFor = (field) => `profile-${profile.id}-${field}`;

  const card = el("details", "profile-card");
  card.dataset.id = String(profile.id);
  card.open = open;
  card.addEventListener("toggle", () => (card.open ? openCards.add(profile.id) : openCards.delete(profile.id)));

  const summary = el("summary");
  const dirty = el("span", "profile-dirty", "● unsaved");
  dirty.hidden = !profileDrafts.has(profile.id);
  summary.append(
    el("span", "profile-name", profile.name),
    el("span", "profile-sub", profile.sheet?.applicant ? `Profile (D): ${profile.sheet.applicant}` : ""),
    dirty
  );

  const promptLabel = el("label", "field-label", "Prompt");
  promptLabel.htmlFor = idFor("prompt");
  const prompt = el("textarea");
  prompt.id = idFor("prompt");
  prompt.rows = 7;
  prompt.placeholder = "Instructions sent with each job description…";
  prompt.value = values.prompt;

  // Whether the master resume goes to OpenAI with each job — a switch, saved
  // as "use" or "none". Off hides the box; its text is kept, so switching
  // back on shows it again.
  const switchRow = el("label", "switch-row");
  const use = el("input", "switch-input");
  use.type = "checkbox";
  use.setAttribute("role", "switch");
  use.checked = values.masterResumeMode !== "none";
  const track = el("span", "switch");
  track.setAttribute("aria-hidden", "true");
  track.append(el("span", "switch-knob"));
  const useState = el("span");
  switchRow.append(use, track, useState);
  const master = el("textarea");
  master.rows = 10;
  master.setAttribute("aria-label", `${profile.name} — master resume`);
  master.placeholder = "Paste this profile's full resume";
  master.value = values.masterResume;
  const syncMaster = () => {
    master.hidden = !use.checked;
    useState.textContent = use.checked
      ? "Use master resume"
      : "Don't use master resume — only the job description is sent";
  };
  syncMaster();

  // --- resume style -------------------------------------------------------

  const styleSelectLabel = el("label", "field-label", "Resume style");
  styleSelectLabel.htmlFor = idFor("style");
  const style = el("select");
  style.id = idFor("style");
  fillStyleOptions(style, profile.id, values.resumeStyle);
  const preview = button("Preview");
  const copy = button("Copy to editor");
  const remove = button("Remove style");
  const actions = el("div", "controls style-actions");
  actions.append(preview, copy, remove);
  const syncRemove = () => (remove.disabled = !ownStyles(profile.id).includes(style.value));
  syncRemove();

  // This profile's editor, folded away until it is wanted, and its state —
  // kept across redraws: what is typed, what was last copied in or added
  // (anything else in it is work Copy to editor would throw away), and the
  // last thing said about this profile's styles.
  const editor = styleEditors.get(profile.id) ?? { name: "", html: "", kept: "", open: false, armedFor: null, status: null };
  styleEditors.set(profile.id, editor);
  const adder = el("details", "detail style-adder");
  adder.open = editor.open;
  adder.addEventListener("toggle", () => (editor.open = adder.open));
  const nameLabel = el("label", "field-label", "Style name");
  nameLabel.htmlFor = idFor("style-name");
  const name = el("input");
  name.id = idFor("style-name");
  name.type = "text";
  name.autocomplete = "off";
  name.spellcheck = false;
  name.maxLength = 40;
  name.placeholder = "e.g. Clean two-column";
  name.value = editor.name;
  const htmlLabel = el("label", "field-label", "Template HTML");
  htmlLabel.htmlFor = idFor("style-html");
  const html = el("textarea", "code");
  html.id = idFor("style-html");
  html.rows = 12;
  html.wrap = "off";
  html.spellcheck = false;
  html.placeholder = "Paste or type the template's HTML";
  html.value = editor.html;
  const draftPreview = button("Preview");
  const templatePrompt = button("Template prompt");
  const add = button("Add new");
  const adderActions = el("div", "controls style-actions");
  adderActions.append(draftPreview, templatePrompt, add);

  // For a human with no screenshot-to-HTML model of their own handy, or
  // whose clipboard write is blocked (no permission prompt, no https, …):
  // the same prompt, open and selectable, instead of lost to a silent
  // failure.
  const promptPeek = el("details", "style-prompt-peek");
  const promptBox = el("textarea", "code");
  promptBox.readOnly = true;
  promptBox.rows = 8;
  promptBox.value = TEMPLATE_STYLE_PROMPT;
  promptBox.addEventListener("focus", () => promptBox.select());
  promptPeek.append(el("summary", "", "Prompt"), promptBox);

  adder.append(el("summary", "", "Add a style"), nameLabel, name, htmlLabel, html, adderActions, promptPeek);

  const status = el("p", "hint");
  const showStatus = (text, kind = "") => {
    editor.status = text ? { text, kind } : null;
    status.hidden = !text;
    status.className = `hint ${kind}`.trim();
    status.textContent = text;
  };
  showStatus(editor.status?.text ?? "", editor.status?.kind);

  // Handed to a model alongside a resume screenshot — no page here can
  // script that model itself, same reasoning as Sheet sync's own Generate
  // script. Copies silently when it can; the Prompt details below holds the
  // same text, open and selectable, for when it can't.
  templatePrompt.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(TEMPLATE_STYLE_PROMPT);
      showStatus("Prompt copied — paste it into Claude (or another model) along with a resume screenshot.", "saved");
    } catch {
      promptPeek.open = true;
      promptBox.focus();
      showStatus("Could not copy — selected below, so you can copy it by hand.", "warn");
    }
  });

  // Said on the button before it is pressed, not after: a name this profile
  // has already added replaces that style.
  const syncAdd = () => (add.textContent = ownStyles(profile.id).includes(name.value.trim()) ? "Update style" : "Add new");
  syncAdd();

  // --- edits ---------------------------------------------------------------

  const read = () => ({
    prompt: prompt.value,
    masterResume: master.value,
    masterResumeMode: use.checked ? "use" : "none",
    resumeStyle: style.value
  });
  const onEdit = () => {
    const draft = read();
    if (sameOwn(draft, savedOwn(profile))) profileDrafts.delete(profile.id);
    else profileDrafts.set(profile.id, draft);
    dirty.hidden = !profileDrafts.has(profile.id);
    syncProfileButtons();
  };
  prompt.addEventListener("input", onEdit);
  master.addEventListener("input", onEdit);
  style.addEventListener("change", () => {
    syncRemove();
    onEdit();
  });
  use.addEventListener("change", () => {
    syncMaster();
    onEdit();
  });
  name.addEventListener("input", () => {
    editor.name = name.value;
    syncAdd();
  });
  // Typing again starts Copy to editor's question over.
  html.addEventListener("input", () => {
    editor.html = html.value;
    editor.armedFor = null;
  });

  // --- style actions -------------------------------------------------------

  preview.addEventListener("click", () =>
    showPreview(
      { profileId: profile.id, style: style.value },
      `"${styleLabel(style.value)}" — ${profile.name}`,
      preview,
      card,
      showStatus
    )
  );

  draftPreview.addEventListener("click", () => {
    if (!html.value.trim()) {
      showStatus("Type or paste the template's HTML first.", "warn");
      return;
    }
    const title = name.value.trim() ? `"${name.value.trim()}" (editor)` : "the editor's HTML";
    showPreview({ profileId: profile.id, html: html.value }, `${title} — ${profile.name}`, draftPreview, card, showStatus);
  });

  // Replacing edits that were never added asks first — by asking for a
  // second click, since a side panel has no dialog to ask with. Typing again,
  // or picking another style, starts the question over.
  copy.addEventListener("click", async () => {
    const value = style.value;
    const label = styleLabel(value);
    const unkept = html.value.trim() && html.value !== editor.kept;
    if (unkept && editor.armedFor !== value) {
      editor.armedFor = value;
      showStatus(`Template HTML has edits that were never added. Press Copy to editor again to replace them with "${label}".`, "warn");
      return;
    }
    editor.armedFor = null;

    copy.disabled = true;
    const reply = await send({ type: "GET_STYLE_HTML", profileId: profile.id, name: value });
    copy.disabled = false;
    if (!reply.ok) {
      showStatus(`Could not read "${label}": ${reply.error}`, "warn");
      return;
    }

    html.value = editor.html = editor.kept = reply.html;
    // An added style keeps its name, so the button updates it in place; a
    // built-in one cannot be overwritten, so its copy starts under a new name.
    name.value = editor.name = reply.builtin ? `${value} copy` : value;
    adder.open = true;
    syncAdd();
    showStatus(`Copied "${label}" into the editor. Edit it, then press ${add.textContent}.`, "saved");
  });

  // Added to this profile and picked for it, as an edit — Save puts it to use.
  add.addEventListener("click", async () => {
    const styleName = name.value.trim();
    if (!styleName) {
      showStatus("Give the style a name first.", "warn");
      return;
    }
    if (!html.value.trim()) {
      showStatus("Type or paste the template's HTML first.", "warn");
      return;
    }

    add.disabled = true;
    const reply = await send({ type: "ADD_STYLE", profileId: profile.id, name: styleName, html: html.value });
    add.disabled = false;
    if (!reply.ok) {
      showStatus(`Could not add "${styleName}": ${reply.error}`, "warn");
      return;
    }

    editor.kept = html.value;
    profileStyleNames.set(profile.id, reply.styles.map((s) => s.name));
    fillStyleOptions(style, profile.id, reply.name);
    syncRemove();
    syncAdd();
    onEdit();
    showStatus(
      reply.replaced
        ? `Updated "${reply.name}" — used from the next job.`
        : `Added "${reply.name}" and picked it — Save to build with it.`,
      "saved"
    );
  });

  remove.addEventListener("click", async () => {
    const value = style.value;
    if (!ownStyles(profile.id).includes(value)) return;

    remove.disabled = true;
    const reply = await send({ type: "REMOVE_STYLE", profileId: profile.id, name: value });
    if (!reply.ok) {
      remove.disabled = false;
      showStatus(`Could not remove: ${reply.error}`, "warn");
      return;
    }
    // The worker puts the profile back on the default if it was using it.
    // An unsaved pick of it goes the same way; the rest of the edits stay.
    const draft = profileDrafts.get(profile.id);
    if (draft?.resumeStyle === value) draft.resumeStyle = defaults.resumeStyle;
    showStatus(`Removed "${value}". ${profile.name} builds with ${styleLabel(defaults.resumeStyle)} unless another style is picked.`, "saved");
    await loadProfiles();
  });

  card.append(
    summary,
    promptLabel,
    prompt,
    el("p", "field-label", "Master resume"),
    switchRow,
    master,
    styleSelectLabel,
    style,
    actions,
    adder,
    status
  );
  return card;
}

async function loadProfiles() {
  reloadProfilesEl.disabled = true;
  showProfilesStatus("Loading profiles…");
  const reply = await send({ type: "GET_PROFILES" });
  reloadProfilesEl.disabled = false;

  if (!reply.ok) {
    showProfilesStatus(`Could not load the dashboard's profiles: ${reply.error}`, "warn");
    return;
  }

  profiles = reply.profiles;
  profileStyleNames.clear();
  for (const [id, list] of Object.entries(reply.styles || {})) {
    profileStyleNames.set(Number(id), list.map((style) => style.name));
  }
  // A profile gone from the dashboard takes its unsaved edits with it; one
  // whose saved values now match its edits has nothing left to save.
  for (const [id, draft] of [...profileDrafts]) {
    const profile = profiles.find((p) => p.id === id);
    if (!profile || sameOwn(draft, savedOwn(profile))) profileDrafts.delete(id);
  }
  renderChoices(countryEl.value, roleEl.value);
  syncProfileButtons();
  showProfilesStatus(profiles.length ? "" : "The dashboard has no tabs yet — add one there first.", "warn");
}

countryEl.addEventListener("change", () => {
  renderChoices(countryEl.value, roleEl.value);
  syncProfileButtons();
});
roleEl.addEventListener("change", () => {
  renderCards();
  syncProfileButtons();
});
reloadProfilesEl.addEventListener("click", loadProfiles);

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
// Style preview
//
// Fills a template the way a job's resume is filled — the worker's own
// builder, with that profile's newest resume, or a sample until it has one —
// for either the style a profile has picked or whatever is in its editor,
// added or not yet. The one preview box is shown inside the card it was
// opened from, and put back here when it is closed or the cards are redrawn.
// ---------------------------------------------------------------------------

const stylePreviewEl = $("stylePreview");
const stylePreviewTitleEl = $("stylePreviewTitle");
const stylePreviewSizerEl = $("stylePreviewSizer");
const stylePreviewFrameEl = $("stylePreviewFrame");
const previewHomeEl = stylePreviewEl.parentNode;
const PAGE_WIDTH = 816; // a letter page, 8.5in at 96px to the inch

// What the preview is showing, for Open full size.
let previewHtml = "";

// The frame keeps the page's width and is scaled down to the panel's — never
// up past its real size in a panel dragged wide; its height follows the
// document, read once it has loaded.
function fitPreview() {
  const doc = stylePreviewFrameEl.contentDocument;
  if (stylePreviewEl.hidden || !doc?.documentElement) return;
  const scale = Math.min(1, stylePreviewSizerEl.clientWidth / PAGE_WIDTH);
  const height = doc.documentElement.scrollHeight;
  stylePreviewFrameEl.style.height = `${height}px`;
  stylePreviewFrameEl.style.transform = `scale(${scale})`;
  stylePreviewSizerEl.style.height = `${Math.ceil(height * scale)}px`;
}

stylePreviewFrameEl.addEventListener("load", fitPreview);
window.addEventListener("resize", fitPreview);

function closePreview() {
  stylePreviewEl.hidden = true;
  stylePreviewFrameEl.removeAttribute("srcdoc");
  if (stylePreviewEl.parentNode !== previewHomeEl) previewHomeEl.append(stylePreviewEl);
}

// `host` is the card the preview opens in; `report` is that card's status line.
async function showPreview(request, title, trigger, host, report) {
  trigger.disabled = true;
  report("Building the preview…");
  const reply = await send({ type: "PREVIEW_STYLE", ...request });
  trigger.disabled = false;
  if (!reply.ok) {
    report(`Could not preview ${title}: ${reply.error}`, "warn");
    return;
  }

  previewHtml = reply.html;
  stylePreviewTitleEl.textContent = title;
  host.append(stylePreviewEl);
  stylePreviewEl.hidden = false;
  stylePreviewFrameEl.srcdoc = reply.html;
  stylePreviewEl.scrollIntoView({ block: "nearest" });

  const problems = [...reply.missing.map((hole) => `no ${hole}, so it cannot be added`), ...reply.warnings];
  report(
    (reply.from
      ? `Filled with the resume ChatGPT wrote for ${reply.from}.`
      : "Filled with sample data — no resume has been generated for this profile yet.") +
      (problems.length ? ` Template: ${problems.join("; ")}.` : ""),
    problems.length ? "warn" : ""
  );
}

$("stylePreviewOpen").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([previewHtml], { type: "text/html" }));
  window.open(url, "_blank");
  // The tab has loaded it by then; until then it needs the URL to stay good.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

$("stylePreviewClose").addEventListener("click", closePreview);

// Typing, picking a model, or switching to Custom… all re-evaluate. The
// profile cards re-evaluate on their own edits.
$("apiKey").addEventListener("input", syncProfileButtons);
modelCustomEl.addEventListener("input", syncProfileButtons);
modelEl.addEventListener("change", () => {
  modelCustomEl.hidden = modelEl.value !== CUSTOM_MODEL;
  if (!modelCustomEl.hidden) modelCustomEl.focus();
  syncProfileButtons();
});

// The settings to this extension's storage, then each edited profile to its
// own dashboard tab. A profile that fails to save keeps its edits, so the
// next Save tries it again.
saveProfileEl.addEventListener("click", async () => {
  const patch = readForm();

  if (modelEl.value === CUSTOM_MODEL && !patch.model) {
    profileStatusEl.className = "hint warn";
    profileStatusEl.textContent = "Enter a model id, or pick one from the list.";
    return;
  }

  saveProfileEl.disabled = true;
  const reply = await send({ type: "SET_SETTINGS", patch });

  if (!reply.ok) {
    profileStatusEl.className = "hint warn";
    profileStatusEl.textContent = `Could not save: ${reply.error}`;
    saveProfileEl.disabled = false;
    return;
  }
  savedSettings = reply.settings;

  const failed = [];
  for (const [id, draft] of [...profileDrafts]) {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) {
      profileDrafts.delete(id);
      continue;
    }
    const result = await send({ type: "UPDATE_PROFILE", id, patch: storedPatch(draft, savedOwn(profile)) });
    if (!result.ok) {
      failed.push(`${profile.name} (${result.error})`);
      continue;
    }
    profiles = profiles.map((p) => (p.id === id ? result.profile : p));
    profileDrafts.delete(id);
  }

  fillForm(savedSettings); // echo back what was actually stored — the cards with it
  syncProfileButtons();

  if (failed.length) {
    profileStatusEl.className = "hint warn";
    profileStatusEl.textContent = `Saved, except ${failed.join("; ")} — press Save to try again.`;
    return;
  }
  profileStatusEl.className = "hint saved";
  profileStatusEl.textContent = "Saved.";
  setTimeout(() => {
    if (!isDirty()) showKeyState(savedSettings.apiKey);
  }, 1500);
});

revertProfileEl.addEventListener("click", () => {
  profileDrafts.clear();
  if (savedSettings) fillForm(savedSettings);
  syncProfileButtons();
});

// ---------------------------------------------------------------------------
// Tabs
//
// Two independent strips share this wiring: the top-level Generate/Auto Fill
// pair, and the ChatGPT setting/Profile pair inside the settings screen.
// Each is wired separately so arrow-key navigation stays scoped to its own
// strip — switching between the settings tabs must not also step through
// Generate/Auto Fill.
//
// Switching only shows and hides. The feed keeps streaming into the Generate
// pane while the Auto Fill tab is in front, and an edit in a profile's master
// resume survives a trip to ChatGPT setting, because the panes are still in
// the document, just not displayed.
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
  // Auto Fill's profile list is read fresh each time its tab is opened, so a
  // profile just added on the dashboard is there to pick.
  onSelect: (tab) => {
    $("pane-profile").hidden = true;
    $("openSettings").setAttribute("aria-expanded", "false");
    if (tab.id === "tab-bid") loadAfProfiles();
  }
});

wireTabStrip($("settingsTabs"), {
  // Fresh each time, so a profile just added or changed on the dashboard is
  // listed as it is now — and folded, so the list reads as a list of names.
  // Unsaved edits are kept; only which cards were open is forgotten.
  onSelect: (tab) => {
    if (tab.id !== "subtab-profile") return;
    openCards.clear();
    for (const card of profileListEl.querySelectorAll("details.profile-card")) card.open = false;
    loadProfiles();
  }
});

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
// Auto Fill
//
// The applicant's details, kept by the worker, and "Fill this page", which
// puts them into the job application form on the page in front: autofill.js
// is injected there and recognises each field by its label, name and the
// like, filling only the empty ones. A site the extension has no access to
// is asked for once, by Chrome's own prompt (optional_host_permissions). The
// extension's own sample form cannot be injected into, so it is asked by
// message instead.
// ---------------------------------------------------------------------------

const AF_FIELDS = {
  firstName: $("afFirstName"),
  lastName: $("afLastName"),
  email: $("afEmail"),
  phone: $("afPhone"),
  location: $("afLocation"),
  linkedin: $("afLinkedin"),
  website: $("afWebsite")
};
const afFillEl = $("afFill");
const afCatchEl = $("afCatch");
const afSaveEl = $("afSave");
const afStatusEl = $("afStatus");
const afFilledEl = $("afFilled");
const SAMPLE_FORM = "autofill-sample.html";

// Made-up details to try the fill with: example.com addresses and a 555-01xx
// number, which are reserved for exactly this.
const SAMPLE_DETAILS = {
  firstName: "Alex",
  lastName: "Morgan",
  email: "alex.morgan@example.com",
  phone: "+1 (555) 010-0123",
  location: "Austin, TX",
  linkedin: "https://www.linkedin.com/in/alex-morgan-example",
  website: "https://alexmorgan.example.com",
  // Answers to the sample form's own questions.
  extra: [
    { question: "How did you hear about us?", answer: "LinkedIn" },
    { question: "Years of experience", answer: "6" },
    { question: "Work authorization", answer: "Authorized to work in the US" }
  ]
};

let savedDetails = {};
// The answers to form questions, from an imported JSON's "answers":
// [{ question, answer }]. Shown below the details, kept with them on Save.
let extraAnswers = [];

const readDetails = () => ({
  ...Object.fromEntries(Object.entries(AF_FIELDS).map(([key, el]) => [key, el.value.trim()])),
  extra: extraAnswers
});

// Something to fill a page with: a detail, or an answer.
const hasDetails = (d) => Object.keys(AF_FIELDS).some((k) => d[k]) || d.extra.length > 0;

function fillDetails(details) {
  for (const [key, el] of Object.entries(AF_FIELDS)) el.value = details?.[key] ?? "";
  extraAnswers = Array.isArray(details?.extra) ? details.extra : [];
  renderExtra();
  syncDetailsSave();
}

// Save is on while the picked profile's details differ from what is saved for
// it, and the profile's line in the list says so.
function syncDetailsSave() {
  afSaveEl.disabled = afProfileId === null || !detailsDirty();
  refreshAfProfileLabel();
}

function renderExtra() {
  const body = $("afExtra");
  body.replaceChildren(
    ...extraAnswers.map(({ question, answer }) => {
      const row = document.createElement("tr");
      row.append(
        Object.assign(document.createElement("td"), { textContent: question }),
        Object.assign(document.createElement("td"), { textContent: answer })
      );
      return row;
    })
  );
  $("afExtraWrap").hidden = extraAnswers.length === 0;
}

$("afExtraClear").addEventListener("click", () => {
  extraAnswers = [];
  renderExtra();
  syncDetailsSave();
});

function showAfStatus(text, kind = "") {
  afStatusEl.hidden = !text;
  afStatusEl.className = `hint ${kind}`.trim();
  afStatusEl.textContent = text;
}

for (const el of Object.values(AF_FIELDS)) el.addEventListener("input", syncDetailsSave);

// --- One set of details per profile ----------------------------------------
//
// Each dashboard profile has its own details, picked at the top of the pane:
// what is shown, saved and filled with is the picked profile's. An edit not
// yet saved stays with its profile while another one is looked at, marked ●
// in the list. The profile picked last is picked again next time. The single
// set saved before Auto Fill was per profile is offered, unsaved, to a
// profile with none of its own, until it is saved to one.

const afProfileEl = $("afProfile");
const AF_PROFILE_KEY = "autofillProfile";
let afProfiles = [];
let afProfileId = null; // the picked profile's id, or null with none to pick
const afDrafts = new Map(); // profile id -> { details, fromLegacy } not yet saved
let afFromLegacy = false; // the form holds the old single set, offered to this profile

const afProfile = () => afProfiles.find((p) => p.id === afProfileId) || null;

// The form differs from what is saved for the picked profile.
function detailsDirty() {
  const now = readDetails();
  return (
    Object.keys(AF_FIELDS).some((k) => now[k] !== (savedDetails[k] ?? "")) ||
    JSON.stringify(now.extra) !== JSON.stringify(savedDetails.extra ?? [])
  );
}

function profileLabel(p) {
  const sheet = p.sheet || {};
  const where = [sheet.country, sheet.role].filter(Boolean).join(" · ");
  const who = sheet.applicant && sheet.applicant !== p.name ? ` · ${sheet.applicant}` : "";
  const unsaved = p.id === afProfileId ? detailsDirty() : afDrafts.has(p.id);
  return `${unsaved ? "● " : ""}${p.name}${who}${where ? ` (${where})` : ""}`;
}

function renderAfProfiles() {
  afProfileEl.replaceChildren(
    ...(afProfiles.length
      ? afProfiles.map((p) => new Option(profileLabel(p), String(p.id), false, p.id === afProfileId))
      : [new Option("— No profiles —", "", true, true)])
  );
  afProfileEl.disabled = !afProfiles.length;
}

// Just the picked profile's line, as the form is edited.
function refreshAfProfileLabel() {
  const option = afProfileEl.selectedOptions[0];
  const profile = afProfile();
  if (option && profile) option.text = profileLabel(profile);
}

function showAfProfileNote(text, kind = "") {
  const el = $("afProfileNote");
  el.hidden = !text;
  el.className = `hint ${kind}`.trim();
  el.textContent = text;
}

function rememberedProfile() {
  try {
    return localStorage.getItem(AF_PROFILE_KEY);
  } catch {
    return null;
  }
}

async function pickAfProfile(id) {
  // The profile being left keeps what was typed for it.
  if (afProfileId !== null) {
    if (detailsDirty()) afDrafts.set(afProfileId, { details: readDetails(), fromLegacy: afFromLegacy });
    else afDrafts.delete(afProfileId);
  }
  afProfileId = id;
  try {
    if (id !== null) localStorage.setItem(AF_PROFILE_KEY, String(id));
  } catch {
    // not remembered; picked for now all the same
  }
  $("afDetails").disabled = id === null;
  afFilledEl.replaceChildren();
  showAfStatus("");

  if (id === null) {
    savedDetails = {};
    afFromLegacy = false;
    fillDetails({});
    renderAfProfiles();
    return;
  }

  const reply = await send({ type: "GET_AUTOFILL", profileId: id });
  if (afProfileId !== id) return; // another was picked while this one loaded
  const profile = afProfile();
  savedDetails = (reply.ok && reply.details) || {};
  const draft = afDrafts.get(id);
  afDrafts.delete(id);
  afFromLegacy = draft?.fromLegacy ?? false;

  if (draft) {
    fillDetails(draft.details);
  } else if (reply.ok && !reply.details && reply.legacy) {
    afFromLegacy = true;
    fillDetails(reply.legacy);
    showAfStatus(
      `These are the details saved before Auto Fill kept them per profile — Save details to keep them for ${profile?.name}, or change them first.`
    );
  } else {
    fillDetails(savedDetails);
  }
  if (!reply.ok) showAfStatus(`Could not load this profile's details: ${reply.error}`, "warn");
  renderAfProfiles();
}

// The dashboard's profiles, fresh: on opening the tab, and on Reload. The
// profile picked stays picked, with whatever is in the form; otherwise the
// one picked last time, then the first with the Country and Role picked in
// Settings, then the first.
async function loadAfProfiles() {
  const reloadEl = $("afReloadProfiles");
  reloadEl.disabled = true;
  const reply = await send({ type: "GET_PROFILES" });
  reloadEl.disabled = false;

  if (!reply.ok) {
    afProfiles = [];
    showAfProfileNote(`Could not load the dashboard's profiles: ${reply.error}`, "warn");
    await pickAfProfile(null);
    return;
  }
  afProfiles = reply.profiles || [];
  // A profile gone from the dashboard takes its unsaved edits with it.
  for (const id of [...afDrafts.keys()]) if (!afProfiles.some((p) => p.id === id)) afDrafts.delete(id);

  if (!afProfiles.length) {
    showAfProfileNote("The dashboard has no profiles yet — add one there first.", "warn");
    await pickAfProfile(null);
    return;
  }
  showAfProfileNote("");

  const has = (id) => afProfiles.some((p) => p.id === id);
  const remembered = afProfiles.find((p) => String(p.id) === rememberedProfile());
  const forSettings =
    savedSettings &&
    afProfiles.find(
      (p) =>
        matchKey(p.sheet?.country) === matchKey(savedSettings.country) &&
        matchKey(p.sheet?.role) === matchKey(savedSettings.role)
    );
  const id = has(afProfileId) ? afProfileId : (remembered || forSettings || afProfiles[0]).id;

  if (id === afProfileId) renderAfProfiles();
  else await pickAfProfile(id);
}

afProfileEl.addEventListener("change", () => {
  const profile = afProfiles.find((p) => String(p.id) === afProfileEl.value);
  if (profile) pickAfProfile(profile.id);
});

$("afReloadProfiles").addEventListener("click", loadAfProfiles);

// Saves whatever is in the table now to the picked profile. Used by the Save
// button itself, and by Catch, which remembers what it caught right away
// rather than leaving it to be lost if the panel is closed first.
async function saveAfDetails() {
  const profile = afProfile();
  if (!profile) return { ok: false, error: "no profile picked" };
  const reply = await send({
    type: "SET_AUTOFILL",
    profileId: profile.id,
    details: readDetails(),
    dropLegacy: afFromLegacy
  });
  if (!reply.ok) return reply;
  savedDetails = reply.details;
  afFromLegacy = false;
  syncDetailsSave();
  return reply;
}

afSaveEl.addEventListener("click", async () => {
  const profile = afProfile();
  if (!profile) return;
  const reply = await saveAfDetails();
  showAfStatus(
    reply.ok ? `Details saved for ${profile.name}.` : `Could not save: ${reply.error}`,
    reply.ok ? "saved" : "warn"
  );
});

$("afSample").addEventListener("click", () => {
  fillDetails(SAMPLE_DETAILS);
  showAfStatus("Sample details filled in — Save them, or just press Fill this page.");
});

$("afTry").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(SAMPLE_FORM) });
});

// --- JSON import --------------------------------------------------------------
//
// A JSON file of applicants: one object, an array of them, or an object
// holding the array under "applicants" (or "profiles", "people"). Each
// applicant's keys name the details — firstName, lastName (or one name),
// email, phone, location, linkedin, website — and "answers"
// holds the answers to form questions, as { "question": "answer" }. Keys are
// matched loosely ("first_name", "E-mail"), and a nested "contact" object
// counts too, so a resume answer's own "contact" shape can be imported as it
// is. With more than one applicant, the one to load is picked from a list. The
// file is read here, in the panel; nothing of it is kept but the applicant
// loaded into the form, and that only once Save details is pressed.

// A key, compared without case, spaces or punctuation: "First_Name" is
// "firstname".
const normKey = (k) =>
  String(k || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const JSON_KEYS = {
  firstName: ["firstname", "givenname", "first"],
  lastName: ["lastname", "surname", "familyname", "last"],
  fullName: ["name", "fullname", "applicantname", "candidatename"],
  email: ["email", "emailaddress", "mail"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "telephone", "tel", "cell"],
  location: ["location", "city", "address"],
  linkedin: ["linkedin", "linkedinurl", "linkedinprofile"],
  website: ["website", "portfolio", "url", "github", "personalwebsite"]
};
const DETAIL_KEY = new Map(Object.entries(JSON_KEYS).flatMap(([key, names]) => names.map((n) => [n, key])));
const ANSWER_KEYS = new Set(["answers", "questions", "extra", "qa"]);
const CONTACT_KEYS = new Set(["contact", "contactinfo", "contacts"]);
const LIST_KEYS = ["applicants", "profiles", "people"];

// A value as text: strings and numbers as they are, a list of paragraphs
// joined with blank lines; anything else is no value.
function textOf(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((p) => typeof p === "string")) return v.join("\n\n").trim();
  return "";
}

// { question: answer } or [{ question, answer }] (or [question, answer] pairs).
function answersFrom(v) {
  const pairs = Array.isArray(v)
    ? v.map((x) => (Array.isArray(x) ? [x[0], x[1]] : [x?.question, x?.answer]))
    : v && typeof v === "object"
      ? Object.entries(v)
      : [];
  return pairs
    .map(([q, a]) => ({ question: String(q ?? "").trim(), answer: textOf(a) }))
    .filter((x) => x.question && x.answer);
}

// One applicant as details. Keys that are neither a detail, "answers" nor
// "contact" are reported back as ignored, not guessed at.
function entryDetails(entry) {
  const details = { extra: [] };
  const ignored = [];
  const take = (obj) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const nk = normKey(k);
      const key = DETAIL_KEY.get(nk);
      if (key) {
        const value = textOf(v);
        if (value && !details[key]) details[key] = value;
      } else if (ANSWER_KEYS.has(nk)) details.extra.push(...answersFrom(v));
      else if (CONTACT_KEYS.has(nk) && v && typeof v === "object") take(v);
      else ignored.push(k);
    }
  };
  take(entry);
  // One "name": first word first name, the rest last name.
  if (details.fullName && !details.firstName && !details.lastName) {
    const [firstName, ...rest] = details.fullName.split(/\s+/);
    details.firstName = firstName;
    details.lastName = rest.join(" ");
  }
  delete details.fullName;
  return { details, ignored };
}

// The applicants in a file's text. Plain JSON — or, forgivingly, a JS
// declaration around it (`const resume = {…};`), as a saved model answer is.
function parseApplicants(text) {
  const src = String(text).replace(/^﻿/, "").trim();
  let data;
  try {
    data = JSON.parse(src);
  } catch (err) {
    const bare = src.replace(/^(?:export\s+default|(?:const|let|var)\s+[\w$]+\s*=)\s*/, "").replace(/;\s*$/, "");
    try {
      data = JSON.parse(bare);
    } catch {
      throw new Error(`it is not valid JSON (${err.message})`);
    }
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? LIST_KEYS.map((k) => data[k]).find(Array.isArray) || [data]
      : [];
  return list.filter((x) => x && typeof x === "object" && !Array.isArray(x));
}

let applicants = null; // { fileName, entries } of the file imported this session
const afRowEl = $("afRow");

function showImportStatus(text, kind = "") {
  const el = $("afImportStatus");
  el.hidden = !text;
  el.className = `hint ${kind}`.trim();
  el.textContent = text;
}

const nameOf = (d) => [d.firstName, d.lastName].filter(Boolean).join(" ");

function loadEntry(index) {
  const { details } = entryDetails(applicants.entries[index]);
  fillDetails(details);
  afFilledEl.replaceChildren();
  showAfStatus(
    `${nameOf(details) || `Applicant ${index + 1}`} loaded from the JSON — Save details to keep them, or just press Fill this page.`
  );
}

$("afImport").addEventListener("click", () => $("afJsonFile").click());

$("afJsonFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // the same file picked again still counts as a change
  if (!file) return;

  let entries;
  try {
    entries = parseApplicants(await file.text());
  } catch (err) {
    showImportStatus(`Could not read ${file.name}: ${err?.message || err}`, "warn");
    return;
  }
  if (!entries.length) {
    showImportStatus(`${file.name} has no applicant in it — an object, or an array of them.`, "warn");
    return;
  }

  applicants = { fileName: file.name, entries };
  const read = entries.map(entryDetails);
  const ignored = [...new Set(read.flatMap((r) => r.ignored))];
  const answers = read.reduce((n, r) => n + r.details.extra.length, 0);
  showImportStatus(
    `${file.name} · ${entries.length} applicant(s) · ${answers} answer(s) to form questions` +
      (ignored.length ? ` · ignored: ${ignored.slice(0, 6).join(", ")}${ignored.length > 6 ? "…" : ""}` : ""),
    "saved"
  );

  // One applicant: loaded as it is. Several: picked from a list — starting
  // at the one named like the picked profile's applicant, if one is.
  afRowEl.replaceChildren(
    ...read.map(({ details: d }, i) => new Option(`${i + 1} · ${nameOf(d) || "(no name)"}${d.email ? ` · ${d.email}` : ""}`, String(i)))
  );
  $("afRowWrap").hidden = entries.length < 2;
  const profile = afProfile();
  const wanted = normKey(profile?.sheet?.applicant || profile?.name);
  const match = wanted ? read.findIndex(({ details: d }) => normKey(nameOf(d)) === wanted) : -1;
  const start = match === -1 ? 0 : match;
  afRowEl.value = String(start);
  loadEntry(start);
});

afRowEl.addEventListener("change", () => {
  if (applicants) loadEntry(Number(afRowEl.value));
});

// A ready-made file showing the layout, with two made-up applicants whose
// answers are to the sample form's questions.
const JSON_TEMPLATE = [
  {
    firstName: "Alex",
    lastName: "Morgan",
    email: "alex.morgan@example.com",
    phone: "+1 (555) 010-0123",
    location: "Austin, TX",
    linkedin: "https://www.linkedin.com/in/alex-morgan-example",
    website: "https://alexmorgan.example.com",
    answers: {
      "How did you hear about us?": "LinkedIn",
      "Years of experience": "6",
      "Work authorization": "Authorized to work in the US"
    }
  },
  {
    firstName: "Jordan",
    lastName: "Lee",
    email: "jordan.lee@example.com",
    phone: "+1 (555) 010-0177",
    location: "Denver, CO",
    linkedin: "https://www.linkedin.com/in/jordan-lee-example",
    website: "https://jordanlee.example.com",
    answers: {
      "How did you hear about us?": "A friend",
      "Years of experience": "9",
      "Work authorization": "Require sponsorship"
    }
  }
];

$("afTemplate").addEventListener("click", () => {
  const text = JSON.stringify(JSON_TEMPLATE, null, 2) + "\n";
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: "autofill-template.json" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// The page in front, kept up to date, so that asking for its site's
// permission can be the very first thing a click on Fill does — Chrome shows
// that prompt only from inside the click.
let frontTab = null;

async function refreshFrontTab() {
  try {
    [frontTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    frontTab = null;
  }
}

chrome.tabs?.onActivated?.addListener(refreshFrontTab);
chrome.tabs?.onUpdated?.addListener((_id, info) => {
  if (info.url || info.status === "complete") refreshFrontTab();
});
refreshFrontTab();

// What was filled, what already held something and was left, and a question
// whose dropdown has no option for the answer.
function showAfReport(reply) {
  afFilledEl.replaceChildren();
  if (!reply?.ok) {
    showAfStatus(`Could not fill the page: ${reply?.error || "it did not answer"}`, "warn");
    return;
  }
  const missed = reply.missed || [];
  const page = reply.title ? `“${reply.title}”` : "this page";
  const kept = reply.kept.length ? ` ${reply.kept.length} already had something and were left as they were.` : "";
  const noOption = missed.length ? ` ${missed.length} question(s) had no option matching the answer.` : "";
  showAfStatus(
    reply.filled.length
      ? `Filled ${reply.filled.length} field(s) on ${page}.${kept}${noOption}`
      : `Nothing filled on ${page} — no empty field it recognises.${kept}${noOption}`,
    reply.filled.length ? "saved" : "warn"
  );
  const pill = (className, textContent) => afFilledEl.appendChild(Object.assign(document.createElement("li"), { className, textContent }));
  for (const f of reply.filled) pill("", f.name);
  for (const f of reply.kept) pill("kept", `${f.name} · kept`);
  for (const f of missed) pill("missed", `${f.name} · no option “${f.answer}”`);
}

afFillEl.addEventListener("click", async () => {
  const details = readDetails();
  if (!hasDetails(details)) {
    showAfStatus("Enter your details first — or press Use sample details, or Import JSON.", "warn");
    return;
  }
  const tab = frontTab;
  const url = tab?.url || "";
  afFilledEl.replaceChildren();

  let reply;
  afFillEl.disabled = true;
  try {
    if (url.startsWith(chrome.runtime.getURL(SAMPLE_FORM))) {
      reply = await chrome.runtime.sendMessage({ type: "AUTOFILL_RUN", details });
    } else if (/^https?:\/\//i.test(url)) {
      const site = new URL(url);
      // First, while the click still counts: a site the extension may not
      // touch yet is asked for. Chrome answers at once for one it may.
      const allowed = await chrome.permissions.request({ origins: [`${site.origin}/*`] });
      if (!allowed) {
        showAfStatus(`Not filled — the extension needs your OK to fill forms on ${site.hostname}.`, "warn");
        return;
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["autofill.js"] });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (d) => window.__jobrightAutofill(d),
        args: [details]
      });
      reply = result?.result;
    } else {
      showAfStatus(
        tab
          ? "This page cannot be filled — Chrome's own pages and the Web Store are off limits to extensions. Open the application form first."
          : "No page to fill — open the application form in a tab first.",
        "warn"
      );
      return;
    }
  } catch (err) {
    showAfStatus(`Could not fill the page: ${err?.message || err}`, "warn");
    return;
  } finally {
    afFillEl.disabled = false;
  }
  showAfReport(reply);
});

// For comparing a caught question against the ones already in the table —
// case, punctuation and spacing do not count. Mirrors autofill.js's own norm().
const normQ = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// What a catch found: how many table rows it added or updated to match what
// is on the page now — a row already holding the same value does not count,
// but one that differs is overwritten, not skipped, so editing an answer on
// the page and catching again actually updates the table instead of always
// reporting nothing new. Then remembered at once, so it is not lost if the
// panel closes before Save details is pressed by hand.
async function showAfCatchReport(reply) {
  if (!reply?.ok) {
    showAfStatus(`Could not catch from the page: ${reply?.error || "it did not answer"}`, "warn");
    return;
  }
  const page = reply.title ? `“${reply.title}”` : "this page";
  const details = { ...reply.details };
  if (details.fullName && !details.firstName && !details.lastName) {
    const parts = String(details.fullName).trim().split(/\s+/);
    details.firstName = parts.shift() || "";
    details.lastName = parts.join(" ");
  }

  let caught = 0;
  for (const key of Object.keys(AF_FIELDS)) {
    const value = details[key];
    if (value && AF_FIELDS[key].value.trim() !== value) {
      AF_FIELDS[key].value = value;
      caught++;
    }
  }

  const byQuestion = new Map(extraAnswers.map((x, i) => [normQ(x.question), i]));
  for (const x of reply.extra || []) {
    const q = normQ(x.question);
    if (!q) continue;
    const at = byQuestion.get(q);
    if (at === undefined) {
      byQuestion.set(q, extraAnswers.length);
      extraAnswers.push(x);
      caught++;
    } else if (extraAnswers[at].answer !== x.answer) {
      extraAnswers[at] = x;
      caught++;
    }
  }
  renderExtra();
  syncDetailsSave();

  if (!caught) {
    showAfStatus(`Nothing new caught from ${page}.`, "warn");
    return;
  }

  const profile = afProfile();
  if (!profile) {
    showAfStatus(`Caught ${caught} item(s) from ${page} — pick a profile to remember them.`, "warn");
    return;
  }
  const saved = await saveAfDetails();
  showAfStatus(
    saved.ok
      ? `Caught ${caught} item(s) from ${page} and saved them for ${profile.name}.`
      : `Caught ${caught} item(s) from ${page}, but could not save: ${saved.error}`,
    saved.ok ? "saved" : "warn"
  );
}

afCatchEl.addEventListener("click", async () => {
  const tab = frontTab;
  const url = tab?.url || "";

  let reply;
  afCatchEl.disabled = true;
  try {
    if (url.startsWith(chrome.runtime.getURL(SAMPLE_FORM))) {
      reply = await chrome.runtime.sendMessage({ type: "AUTOFILL_CATCH" });
    } else if (/^https?:\/\//i.test(url)) {
      const site = new URL(url);
      // First, while the click still counts: a site the extension may not
      // touch yet is asked for. Chrome answers at once for one it may.
      const allowed = await chrome.permissions.request({ origins: [`${site.origin}/*`] });
      if (!allowed) {
        showAfStatus(`Not caught — the extension needs your OK to read forms on ${site.hostname}.`, "warn");
        return;
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["autofill.js"] });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__jobrightAutofillCatch()
      });
      reply = result?.result;
    } else {
      showAfStatus(
        tab
          ? "This page cannot be read — Chrome's own pages and the Web Store are off limits to extensions. Open the application form first."
          : "No page to catch from — open the application form in a tab first.",
        "warn"
      );
      return;
    }
  } catch (err) {
    showAfStatus(`Could not catch from the page: ${err?.message || err}`, "warn");
    return;
  } finally {
    afCatchEl.disabled = false;
  }
  await showAfCatchReport(reply);
});

loadAfProfiles();

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
  const captured = await send({ type: "GET_CAPTURES" });
  if (captured.ok) showCaptureCount(captured.captures.length);
  await loadSettings();
  loadProfiles(); // reports its own failure beside the list; nothing waits on it

  if (rendered.size) setStatus(`${rendered.size} from the last run · press Start to resume`);
  else setStatus("Idle.");

  // Opened while a run waits on a human check.
  if (state.verifyPause) showVerify(state.verifyPause);
}

init();
