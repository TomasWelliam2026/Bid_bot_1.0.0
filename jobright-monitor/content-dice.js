// Runs on dice.com — declaratively at page load, and injected on demand by
// background.js when a tab turns out to have no listener.
//
// The Dice counterpart of content.js, answering the same messages (PING,
// START_STREAM, STOP_STREAM, ACCEPTED, FORGET, SCRAPE_DETAIL) so the worker
// drives both boards the same way. On the search page it streams every job
// card to the side panel; on a job page it reads the description.

// Injected twice would mean two listeners and every job streamed twice.
if (!window.__diceFeedLoaded) {
  window.__diceFeedLoaded = true;
  main();
}

function main() {
  // ==========================================================================
  // Selectors — the only thing to touch when Dice ships a rebuild.
  //
  // A card is a role="listitem". Inside it:
  //   title   — the aria-label of the job-detail link (its text is the same).
  //             Not the card's first aria-label: that is a hidden overlay link
  //             labelled "View Details for <title> (<hash>)".
  //   company — the job-card-company-name element; a few cards lack it, so
  //             the ?companyname= of the company-profile link stands in.
  //   link    — the job-detail link's href, /job-detail/<uuid>.
  // ==========================================================================

  const CARD = '[role="listitem"]';
  const TITLE_LINK = 'a[data-testid="job-search-job-detail-link"]';
  const COMPANY = '[data-testid="job-card-company-name"]';
  const COMPANY_LINK = 'a[href*="companyname="]';
  const PAGER = 'nav[aria-label="Pagination"]';

  // --- the job page ----------------------------------------------------------
  // The description block carries a CSS-modules hash, so it is matched by the
  // stable part of its class. The page's JobPosting structured data holds the
  // same description and stands in if the class is renamed.
  const DESCRIPTION = '[class*="__jobDescription"]';
  const STRUCTURED_DATA = "script#jobDetailStructuredData";

  // Keep in step with MAX_ITEMS in content.js, sidepanel.js and MAX_STORED in
  // background.js — how many new jobs a run collects.
  const MAX_ITEMS = 50;
  const MAX_CANDIDATES = 400;
  // Search pages after the first are fetched rather than navigated to, one at
  // a time with a gap — this is someone's site.
  const PAGE_GAP_MS = 800;
  const MAX_PAGES = 20;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  // ==========================================================================
  // Reading one card
  // ==========================================================================

  function absolute(href, base = location.href) {
    try {
      return new URL(href, base).href;
    } catch {
      return null;
    }
  }

  function companyFromLink(card) {
    const href = card.querySelector(COMPANY_LINK)?.getAttribute("href");
    if (!href) return "";
    try {
      return new URL(href, location.origin).searchParams.get("companyname")?.trim() || "";
    } catch {
      return "";
    }
  }

  function readCard(card, index) {
    const link = card.querySelector(TITLE_LINK);
    if (!link) return null; // not a job card

    const title = (link.getAttribute("aria-label") || textOf(link)).trim();
    if (!title) return null;

    const company = textOf(card.querySelector(COMPANY)) || companyFromLink(card);
    const href = absolute(link.getAttribute("href"));

    return {
      index,
      source: "dice",
      title,
      company: company || null,
      href,
      staleTitleClass: false,
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
        // The same flag content.js sets for its list page.
        onRecommendPage: location.pathname.startsWith("/jobs"),
        signedOut: false, // Dice search works signed out
        ...extra
      }
    });
  }

  // One pass over a document — the live page, or a fetched later page.
  function scan(root = document) {
    let fresh = 0;
    for (const card of root.querySelectorAll(CARD)) {
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
    scanTimer = setTimeout(() => scan(), delay);
  }

  // ==========================================================================
  // Later pages
  //
  // Dice pages its results (?page=2, 3, …) and renders each page on the
  // server, so the next pages are fetched and read without leaving the one on
  // screen. It stops once enough new jobs have been accepted, at the last
  // page, or on a page with no new cards.
  // ==========================================================================

  function pageCount() {
    const m = /(\d+)\s*of\s*(\d+)/.exec(textOf(document.querySelector(PAGER)));
    return m ? { current: Number(m[1]), total: Number(m[2]) } : { current: 1, total: 1 };
  }

  function pageUrl(n) {
    const url = new URL(location.href);
    url.searchParams.set("page", String(n));
    return url.href;
  }

  async function harvest() {
    if (harvesting) return;
    harvesting = true;
    status();

    try {
      const { current, total } = pageCount();
      const last = Math.min(total, current + MAX_PAGES - 1);
      for (
        let n = current + 1;
        n <= last && streaming && accepted < MAX_ITEMS && found.size < MAX_CANDIDATES;
        n++
      ) {
        await sleep(PAGE_GAP_MS);
        if (!streaming) break;
        let doc;
        try {
          const res = await fetch(pageUrl(n), { credentials: "include" });
          if (!res.ok) break;
          doc = new DOMParser().parseFromString(await res.text(), "text/html");
        } catch {
          break; // offline or blocked — keep what was found
        }
        if (!scan(doc)) break;
        status({ page: n, pages: total });
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
      // The list is React-rendered; cards can arrive after load.
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
  // No origin check here: every Dice page links to Dice's own LinkedIn page in
  // its footer, so Jobright's "drop LinkedIn postings" rule would drop them
  // all. isLinkedIn is always false.
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
  // element. Parsed into an inert document, never the live page, so nothing in
  // it loads or runs.
  function structuredDescription() {
    try {
      const data = JSON.parse(document.querySelector(STRUCTURED_DATA)?.textContent || "null");
      const posting = [data].flat().find((d) => d?.["@type"] === "JobPosting") || data;
      if (!posting?.description) return null;
      const doc = new DOMParser().parseFromString(`<div>${posting.description}</div>`, "text/html");
      return doc.body.firstElementChild;
    } catch {
      return null;
    }
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
      // The class matched, or the structured data had to stand in.
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
