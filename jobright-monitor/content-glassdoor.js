// Runs on glassdoor.com — declaratively at page load, and injected on demand
// by background.js when a tab turns out to have no listener.
//
// The Glassdoor counterpart of content.js and content-dice.js, answering the
// same messages (PING, START_STREAM, STOP_STREAM, ACCEPTED, FORGET,
// SCRAPE_DETAIL). On the search page it streams every job card to the side
// panel; on a job page it reads the description.
//
// Glassdoor sits behind a bot check ("Humans only"). In a normal browser
// session it passes; when it does not, the page has no cards and the panel
// shows nothing found.

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
  // data-test attributes are stable; the CSS-modules classes carry a hash
  // that changes on rebuilds, so they are matched by prefix only.
  // ==========================================================================

  const CARD = 'li[data-test="jobListing"]';
  const TITLE_LINK = 'a[data-test="job-title"], a[class*="JobCard_jobTitle__"]';
  const COMPANY = '[class*="EmployerProfile_compactEmployerName__"]';
  // "Show more jobs" at the foot of the list appends the next batch in place.
  const LOAD_MORE = 'button[data-test="load-more"]';
  // A sign-up prompt sometimes covers the list after loading more.
  const MODAL_CLOSE = '[role="dialog"] button[class*="CloseButton"], [role="dialog"] button[aria-label="Close" i]';

  // --- the job page ----------------------------------------------------------
  const DESCRIPTION = '[class*="JobDetails_jobDescription__"]';
  const STRUCTURED_DATA = 'script[type="application/ld+json"]';

  // Keep in step with MAX_ITEMS in content.js, sidepanel.js and MAX_STORED in
  // background.js — how many new jobs a run collects.
  const MAX_ITEMS = 50;
  const MAX_CANDIDATES = 400;
  const MAX_LOAD_MORE = 15;
  const LOAD_WAIT_MS = 6000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

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
  let harvesting = false;
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
        harvesting,
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
  // The list starts at about 30 cards; "Show more jobs" appends the next batch
  // to the same page. It is pressed until enough new jobs are accepted, the
  // button is gone, or a press brings nothing new.
  // ==========================================================================

  // Resolves once the card count rises, or after LOAD_WAIT_MS.
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

  async function harvest() {
    if (harvesting) return;
    harvesting = true;
    status();

    try {
      for (
        let i = 0;
        i < MAX_LOAD_MORE && streaming && accepted < MAX_ITEMS && found.size < MAX_CANDIDATES;
        i++
      ) {
        document.querySelector(MODAL_CLOSE)?.click();
        const button = document.querySelector(LOAD_MORE);
        if (!button || button.disabled) break;

        const before = document.querySelectorAll(CARD).length;
        button.scrollIntoView({ block: "center" });
        button.click();
        if (!(await waitForMoreCards(before))) break;
        scan();
      }
    } finally {
      harvesting = false;
      status({ harvestComplete: true });
    }
  }

  // ==========================================================================
  // Start / stop
  // ==========================================================================

  function start(options = {}) {
    const { autoScroll = true } = options;

    if (!streaming) {
      streaming = true;
      observer = new MutationObserver(() => scheduleScan());
      observer.observe(document.body, { childList: true, subtree: true });
    }

    scan();
    status({ started: true });
    if (autoScroll) harvest();

    return { ok: true, total: found.size, url: location.href };
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
  // Job page
  //
  // No LinkedIn origin check, as on Dice: postings are Glassdoor's own pages.
  // ==========================================================================

  function waitForAny(selectors, timeoutMs = 15000) {
    const hit = () => selectors.some((s) => document.querySelector(s));
    if (hit()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (!hit()) return;
        obs.disconnect();
        clearTimeout(timer);
        resolve(true);
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(false);
      }, timeoutMs);
    });
  }

  // The JobPosting's description (HTML) from the structured data, as an
  // element — parsed into an inert document, so nothing in it loads or runs.
  function structuredDescription() {
    for (const script of document.querySelectorAll(STRUCTURED_DATA)) {
      try {
        const data = JSON.parse(script.textContent);
        const posting = [data, ...(data?.["@graph"] || [])].flat().find((d) => d?.["@type"] === "JobPosting");
        if (!posting?.description) continue;
        const doc = new DOMParser().parseFromString(`<div>${posting.description}</div>`, "text/html");
        return doc.body.firstElementChild;
      } catch {
        // not JSON, or not a posting — try the next one
      }
    }
    return null;
  }

  async function scrapeDetail() {
    const ready = await waitForAny([DESCRIPTION, STRUCTURED_DATA]);
    const block = document.querySelector(DESCRIPTION);
    const el = block ? block.cloneNode(true) : structuredDescription();

    return {
      ok: true,
      url: location.href,
      ready,
      isLinkedIn: false,
      originHref: null,
      originText: null,
      descriptionHtml: el ? el.outerHTML : null,
      descriptionText: el ? textOf(el) : null,
      descriptionFound: !!el,
      staleDetailClass: !block && !!el
    };
  }

  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "SCRAPE_DETAIL":
        scrapeDetail().then(sendResponse, (err) =>
          sendResponse({ ok: false, error: err?.message || String(err) })
        );
        return true;

      case "PING":
        sendResponse({ ok: true, url: location.href, streaming, total: found.size });
        return false;

      case "START_STREAM":
        sendResponse(start(msg.options));
        return false;

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
