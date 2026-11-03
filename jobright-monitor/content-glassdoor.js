// Runs on glassdoor.com — declaratively at page load, and injected on demand
// by background.js when a tab turns out to have no listener.
//
// The Glassdoor counterpart of content.js and content-dice.js, answering the
// same messages (PING, START_STREAM, STOP_STREAM, NEXT_PAGE, ACCEPTED, FORGET).
// On the search page it streams every job card to the side panel. As on Indeed,
// each job is read with READ_PANE: its card is clicked and the description read
// from the right-hand pane, with no tab opened for it.
//
// Glassdoor sits behind a bot check ("Humans only"). In a normal browser
// session it passes; when it does not, the worker waits for someone to pass it.

// Injected twice would mean two listeners and every job streamed twice.
if (!window.__glassdoorFeedLoaded) {
  window.__glassdoorFeedLoaded = true;
  main();
}

function main() {
  // ==========================================================================
  // Selectors — the only thing to touch when Glassdoor ships a rebuild.
  //
  // A card is li[data-test="jobListing"]. Inside it:
  //   title   — the text of the job-title link (class JobCard_jobTitle__…)
  //   company — the text of EmployerProfile_compactEmployerName__…
  //   link    — the job-title link's href, /job-listing/…
  //   job id  — the card's data-jobid
  //   opener  — a[data-test="job-link"], the link that fills the pane; a click
  //             on the card itself does nothing
  // data-test attributes are stable; the CSS-modules classes carry a hash
  // that changes on rebuilds, so they are matched by prefix only.
  // ==========================================================================

  const CARD = 'li[data-test="jobListing"]';
  const TITLE_LINK = 'a[data-test="job-title"], a[class*="JobCard_jobTitle__"]';
  const COMPANY = '[class*="EmployerProfile_compactEmployerName__"]';
  const JOB_LINK = 'a[data-test="job-link"]';
  // "Show more jobs" at the foot of the list appends the next batch in place.
  const LOAD_MORE = 'button[data-test="load-more"]';
  // A sign-up prompt sometimes covers the list after loading more.
  const MODAL_CLOSE = '[role="dialog"] button[class*="CloseButton"], [role="dialog"] button[aria-label="Close" i]';

  // --- the right-hand pane -----------------------------------------------------
  // The pane's title has the job's id in its own id, so it says whose the pane
  // is. The whole description is in the page even while "Show more" folds it.
  const paneTitleId = (jobId) => `jd-job-title-${jobId}`;
  const DESCRIPTION = '[class*="JobDetails_jobDescription"]';
  const PANE_WAIT_MS = 10000;
  const SETTLE_MS = 3000;

  // --- the bot check ---------------------------------------------------------
  const CHECK_TEXT = /humans only|verify you are( a)? human|help us protect glassdoor/i;
  const CHECK_ELEMENTS = '#challenge-form, #challenge-stage, iframe[src*="challenges.cloudflare.com"]';

  // Keep in step with MAX_ITEMS in content.js, sidepanel.js and MAX_STORED in
  // background.js — how many new jobs a run collects.
  const MAX_ITEMS = 30;
  const MAX_CANDIDATES = 400;
  const LOAD_WAIT_MS = 6000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  const isBlocked = () =>
    CHECK_TEXT.test(document.title) ||
    CHECK_TEXT.test(document.body?.innerText.slice(0, 1000) || "") ||
    !!document.querySelector(CHECK_ELEMENTS);

  // ==========================================================================
  // Reading one card
  // ==========================================================================

  function absolute(href) {
    try {
      return new URL(href, location.href).href;
    } catch {
      return null;
    }
  }

  function readCard(card, index) {
    const link = card.querySelector(TITLE_LINK);
    const title = textOf(link);
    if (!title) return null; // not a job card (or not rendered yet)

    const company = textOf(card.querySelector(COMPANY));
    const href = absolute(link.getAttribute("href"));

    return {
      index,
      source: "glassdoor",
      // The job's id, for READ_PANE to find its card again.
      jk: card.getAttribute("data-jobid"),
      title,
      company: company || null,
      href,
      // Flags a rebuild: the stable data-test is gone and only the class
      // prefix still matched.
      staleTitleClass: !link.matches('[data-test="job-title"]'),
      staleCompanyClass: false,
      key: href || `${title}␟${company}`,
      foundAt: new Date().toISOString()
    };
  }

  // ==========================================================================
  // Streaming state
  // ==========================================================================

  const found = new Map(); // key -> job, this tab's dedupe
  let observer = null;
  let streaming = false;
  let scanTimer = null;
  let contextLost = false;
  let accepted = 0; // survivors of the collector's filter, per ACCEPTED

  // Fire-and-forget; a throw means this script outlived an extension reload.
  function post(message) {
    if (contextLost) return;
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      contextLost = true;
      teardown();
    }
  }

  function status(extra = {}) {
    post({
      type: "FEED_STATUS",
      status: {
        streaming,
        total: found.size,
        accepted,
        limit: MAX_ITEMS,
        atLimit: accepted >= MAX_ITEMS,
        url: location.href,
        onRecommendPage: location.pathname.startsWith("/Job/"),
        signedOut: false, // search works signed out
        ...extra
      }
    });
  }

  function scan() {
    let fresh = 0;
    for (const card of document.querySelectorAll(CARD)) {
      if (found.size >= MAX_CANDIDATES) break;
      const job = readCard(card, found.size + 1);
      if (!job || found.has(job.key)) continue;
      found.set(job.key, job);
      fresh++;
      post({ type: "JOB_FOUND", job });
    }
    if (fresh) status();
    return fresh;
  }

  function scheduleScan(delay = 150) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  // ==========================================================================
  // More jobs
  //
  // The worker finishes every job in the list, then sends NEXT_PAGE. A search
  // usually shows its whole list at once, with no "Show more jobs" to press,
  // and that is its last page. The button adds to this same page, so the
  // address does not change: the reply gives no address for the worker to see
  // it move from.
  // ==========================================================================

  async function waitForMoreCards(before) {
    const t0 = Date.now();
    while (Date.now() - t0 < LOAD_WAIT_MS) {
      await sleep(300);
      if (document.querySelectorAll(CARD).length > before) {
        await sleep(400); // let the batch finish rendering
        return true;
      }
    }
    return false;
  }

  async function showMore() {
    if (isBlocked()) {
      status({ blocked: true });
      return { ok: true, clicked: false, blocked: true, url: location.href };
    }
    document.querySelector(MODAL_CLOSE)?.click();
    const button = document.querySelector(LOAD_MORE);
    if (!button || button.disabled) {
      status({ lastPage: true });
      return { ok: true, clicked: false, url: location.href };
    }
    const before = document.querySelectorAll(CARD).length;
    button.scrollIntoView({ block: "center" });
    button.click();
    return { ok: true, clicked: await waitForMoreCards(before), url: "" };
  }

  // ==========================================================================
  // Start / stop
  // ==========================================================================

  // A bot check in place of the results is reported rather than watched: the
  // worker waits for someone to pass it, then starts this again.
  function start() {
    if (isBlocked()) {
      teardown();
      status({ blocked: true });
      return { ok: true, total: found.size, fresh: 0, blocked: true, url: location.href };
    }

    if (!streaming) {
      streaming = true;
      observer = new MutationObserver(() => scheduleScan());
      observer.observe(document.body, { childList: true, subtree: true });
    }

    const fresh = scan();
    status({ started: true });

    return { ok: true, total: found.size, fresh, url: location.href };
  }

  function teardown() {
    streaming = false;
    observer?.disconnect();
    observer = null;
    clearTimeout(scanTimer);
  }

  function stop() {
    teardown();
    status({ stopped: true });
    return { ok: true, total: found.size };
  }

  // ==========================================================================
  // Reading a job from the right-hand pane
  //
  // The card's job link is clicked, with the browser's own action on it
  // cancelled: Glassdoor fills the pane and neither the address nor the search
  // page changes. The pane counts as this job's only once its title carries
  // this job's id.
  // ==========================================================================

  const cardFor = (jobId) =>
    [...document.querySelectorAll(CARD)].find((card) => card.getAttribute("data-jobid") === jobId) || null;

  // This job's description, once the pane shows this job.
  function paneDescription(jobId) {
    if (!document.getElementById(paneTitleId(jobId))) return null;
    const block = document.querySelector(DESCRIPTION);
    return block && block.textContent.trim() ? block : null;
  }

  async function readInPane(jobId) {
    const check = { ok: false, blocked: true, url: location.href, error: "Glassdoor showed a bot check" };
    if (isBlocked()) return check;
    const card = cardFor(jobId);
    if (!card) return { ok: false, error: "the job is not on the search page showing now — press Start again for it" };

    if (!paneDescription(jobId)) {
      const link = card.querySelector(JOB_LINK);
      if (!link) return { ok: false, error: `the job's card has no ${JOB_LINK} to open it with` };
      document.querySelector(MODAL_CLOSE)?.click();
      link.scrollIntoView({ block: "center" });
      link.addEventListener("click", (e) => e.preventDefault(), { once: true });
      link.click();
    }

    const deadline = Date.now() + PANE_WAIT_MS;
    let block = paneDescription(jobId);
    while (!block && Date.now() < deadline) {
      if (isBlocked()) return check;
      document.querySelector(MODAL_CLOSE)?.click();
      await sleep(200);
      block = paneDescription(jobId);
    }
    if (!block) return { ok: false, error: "the job's details did not appear in the pane after clicking its card" };

    // The description can arrive in parts: read once it has stopped changing.
    let text = block.textContent;
    let same = 0;
    for (const until = Date.now() + SETTLE_MS; same < 2 && Date.now() < until; ) {
      await sleep(250);
      block = paneDescription(jobId) || block;
      same = block.textContent === text ? same + 1 : 0;
      text = block.textContent;
    }

    // What "Show more" folds is not on screen, so innerText can stop short.
    const shown = (block.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const whole = textOf(block);
    return {
      ok: true,
      url: location.href,
      readFrom: "pane",
      ready: true,
      isLinkedIn: false,
      originHref: null,
      originText: null,
      descriptionHtml: block.cloneNode(true).outerHTML,
      descriptionText: shown.length >= whole.length * 0.9 ? shown : whole,
      descriptionFound: true,
      staleDetailClass: false
    };
  }

  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "READ_PANE":
        readInPane(String(msg.jk || "")).then(sendResponse, (err) =>
          sendResponse({ ok: false, error: err?.message || String(err) })
        );
        return true;

      case "PING":
        sendResponse({ ok: true, url: location.href, streaming, total: found.size, keys: [...found.keys()], blocked: isBlocked() });
        return false;

      case "START_STREAM":
        sendResponse(start());
        return false;

      case "NEXT_PAGE":
        showMore().then(sendResponse, () => sendResponse({ ok: false, clicked: false }));
        return true;

      case "STOP_STREAM":
        sendResponse(stop());
        return false;

      case "ACCEPTED":
        accepted = Number(msg.count) || 0;
        sendResponse({ ok: true });
        return false;

      case "FORGET":
        found.clear();
        accepted = 0;
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  });
}
