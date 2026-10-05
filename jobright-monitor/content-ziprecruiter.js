// Runs on ziprecruiter.com — declaratively at page load, and injected on
// demand by background.js when a tab turns out to have no listener.
//
// The ZipRecruiter counterpart of content.js, content-dice.js and
// content-glassdoor.js, answering the same messages (PING, START_STREAM,
// STOP_STREAM, ACCEPTED, FORGET, SCRAPE_DETAIL). On the search page it streams
// every job card to the side panel; on a job page it reads the description.
//
// ZipRecruiter sits behind a Cloudflare check. In a normal browser session it
// passes; when it does not, the page has no cards and nothing is found.
//
// The card selectors come from the page as described, not from a live check
// (the site would not load for an automated browser), so the link and the
// job-page description are matched loosely with fallbacks. If a run finds
// cards with no links, or jobs with no description, these are the lines to
// adjust.

// Injected twice would mean two listeners and every job streamed twice.
if (!window.__ziprecruiterFeedLoaded) {
  window.__ziprecruiterFeedLoaded = true;
  main();
}

function main() {
  // ==========================================================================
  // Selectors
  //
  // A card is an element whose class contains job_result_two_pane_v2.
  // Inside it:
  //   title   — the text of [data-testid="serp-job-card-title"]
  //   company — the text of [data-testid="job-card-company"]
  //   (the same names as aria-label are accepted too)
  //   link    — the title itself when it is a link, else a job link in the
  //             card, else the card's first link
  // ==========================================================================

  const CARD = '[class*="job_result_two_pane_v2"]';
  const TITLE = '[data-testid="serp-job-card-title"], [aria-label="serp-job-card-title"]';
  const COMPANY = '[data-testid="job-card-company"], [aria-label="job-card-company"]';
  const JOB_LINK = 'a[href*="/c/"], a[href*="/jobs/"], a[href*="jid="], a[href*="/job/"]';

  // --- the job page ----------------------------------------------------------
  // The description sits in an element with class "flex flex-col gap-y-[16px]"
  // that has a "Job description" heading as a child. Those Tailwind classes
  // are on many elements, so the heading is what picks the right one.
  const DESCRIPTION_BOX = ".flex.flex-col.gap-y-\\[16px\\]";
  const DESCRIPTION_HEADING = /^job description:?$/i;
  // Fallbacks when no such box is found.
  const DESCRIPTION = [
    '[class*="job_description"]',
    '[class*="jobDescription"]',
    '[data-testid*="description" i]',
    ".job_details",
    "#job_desc"
  ].join(", ");
  const STRUCTURED_DATA = 'script[type="application/ld+json"]';

  // Keep in step with MAX_ITEMS in content.js, sidepanel.js and MAX_STORED in
  // background.js — how many new jobs a run collects.
  const MAX_ITEMS = 50;
  const MAX_CANDIDATES = 400;
  const PAGE_GAP_MS = 1000;
  const MAX_PAGES = 10;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  // ==========================================================================
  // Reading one card
  // ==========================================================================

  function absolute(href) {
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return null;
    try {
      return new URL(href, location.href).href;
    } catch {
      return null;
    }
  }

  function linkOf(card, titleEl) {
    const own = titleEl?.closest("a[href]") || titleEl?.querySelector("a[href]");
    return (
      absolute(own?.getAttribute("href")) ||
      absolute(card.querySelector(JOB_LINK)?.getAttribute("href")) ||
      absolute(card.querySelector("a[href]")?.getAttribute("href"))
    );
  }

  function readCard(card, index) {
    const titleEl = card.querySelector(TITLE);
    const title = textOf(titleEl);
    if (!title) return null; // not a job card (or not rendered yet)

    const company = textOf(card.querySelector(COMPANY));
    const href = linkOf(card, titleEl);

    return {
      index,
      source: "ziprecruiter",
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
        onRecommendPage: location.pathname.startsWith("/jobs-search"),
        signedOut: false, // search works signed out
        ...extra
      }
    });
  }

  // The class match can also hit a list wrapper or a card's own sub-parts, so
  // only elements holding a title count, and of those the innermost — one per
  // job, never counted twice.
  function cardsIn(root) {
    const all = [...root.querySelectorAll(CARD)].filter((c) => c.querySelector(TITLE));
    return all.filter((c) => !all.some((o) => o !== c && c.contains(o)));
  }

  // One pass over a document — the live page, or a fetched later page.
  function scan(root = document) {
    let fresh = 0;
    for (const card of cardsIn(root)) {
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
  // The next result pages (?page=2, 3, …) are fetched and read without leaving
  // the one on screen, until enough new jobs are accepted, MAX_PAGES, or a
  // page that brings nothing new (the last page, or one that only renders in
  // the browser).
  // ==========================================================================

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
      const current = Number(new URL(location.href).searchParams.get("page")) || 1;
      for (
        let n = current + 1;
        n < current + MAX_PAGES && streaming && accepted < MAX_ITEMS && found.size < MAX_CANDIDATES;
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
        status({ page: n });
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
  // No LinkedIn origin check, as on Dice and Glassdoor.
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

  // The largest description-like block: a page can carry a short teaser and
  // the full text under similar class names.
  function descriptionBlock() {
    const blocks = [...document.querySelectorAll(DESCRIPTION)].filter((el) => textOf(el).length > 100);
    return blocks.sort((a, b) => textOf(b).length - textOf(a).length)[0] || null;
  }

  // The "flex flex-col gap-y-[16px]" box whose child reads "Job description",
  // as a clone without that heading — the text after it is the description.
  function labelledDescription() {
    const box = [...document.querySelectorAll(DESCRIPTION_BOX)].find((el) =>
      [...el.children].some((child) => DESCRIPTION_HEADING.test(textOf(child)))
    );
    if (!box) return null;
    const el = box.cloneNode(true);
    for (const child of [...el.children]) {
      if (DESCRIPTION_HEADING.test(textOf(child))) child.remove();
    }
    return textOf(el) ? el : null;
  }

  // Waits for the labelled box itself, not just any element with those
  // classes, which can render first.
  function waitForLabelled(timeoutMs = 15000) {
    if (labelledDescription()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (!labelledDescription()) return;
        obs.disconnect();
        clearTimeout(timer);
        resolve(true);
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(false);
      }, timeoutMs);
    });
  }

  async function scrapeDetail() {
    const labelledReady = await waitForLabelled();
    const ready = labelledReady || (await waitForAny([DESCRIPTION, STRUCTURED_DATA], 3000));
    const labelled = labelledDescription();
    const block = labelled ? null : descriptionBlock();
    const el = labelled || (block ? block.cloneNode(true) : structuredDescription());

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
      // Found, but not in the labelled box: the page layout has moved.
      staleDetailClass: !labelled && !!el
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
