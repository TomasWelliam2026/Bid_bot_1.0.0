// Runs on jobright.ai — declaratively at page load, and injected on demand by
// background.js when a tab turns out to have no listener.
//
// Finds every element whose data-index is a number, reads the job title,
// company name and link out of it, and streams each new card to the side panel
// the moment it appears. Nothing is batched up and reported at the end: the
// panel is fed one job at a time.

// The service worker re-injects this file into tabs whose state it cannot be
// sure of. Injecting twice would register two listeners and stream every job
// twice, so the whole file is a no-op after the first run in a frame.
if (!window.__jobrightFeedLoaded) {
  window.__jobrightFeedLoaded = true;
  main();
}

function main() {
  // ==========================================================================
  // Selectors — the only thing to touch when Jobright ships a rebuild.
  //
  // `index_job-title__Riiip` and `index_company-name__jnxCX` are Next.js
  // CSS-modules hashes. The suffix after the double underscore is regenerated
  // on every site build, so the exact class is tried first (so a drift is easy
  // to spot) and the prefix match is what actually keeps working.
  // ==========================================================================

  const TITLE_EXACT = 'h2[class*="index_job-title__Riiip"]';
  const TITLE_PREFIX = 'h2[class*="index_job-title__"]';

  const COMPANY_EXACT = '[class*="index_company-name__jnxCX"]';
  const COMPANY_PREFIX = '[class*="index_company-name__"]';

  // --- the job detail page ---------------------------------------------------
  // Same exact-then-prefix pairing, for the page behind each card's link.
  //
  // ORIGIN carries the "where this posting came from" link. When it points at
  // linkedin.com the job is dropped and the tab closed without reading further.
  const ORIGIN_EXACT = '[class*="index_origin__e6tHu"]';
  const ORIGIN_PREFIX = '[class*="index_origin__"]';

  // The description block, by id rather than by hashed class — an id survives a
  // rebuild, so this one needs no prefix fallback. Supersedes
  // index_jobDetailContent__rhs3U.
  const DETAIL_ID = "#overview-1";

  // Chrome, not description: stripped out before the block is posted. Each is
  // tried as the pinned hash first, then as the prefix, the same way every
  // other selector here works.
  const DROP_CLASSES = ["index_top__WAMvJ", "index_job-metadata-row__iYsnl"];

  // The first two <section>s are headers rather than content.
  const DROP_LEADING_SECTIONS = 2;

  const LINKEDIN = "https://www.linkedin.com";

  // Spec: "data-index property is a number more than 0".
  //
  // Worth knowing: react-window numbers its rows from 0, so the very first
  // card on the page carries data-index="0" and is skipped by this threshold.
  // Set this to 0 to include it.
  const MIN_DATA_INDEX = 1;

  // How many cards a run ends up with. This counts items that survived the
  // collector's duplicate filter, not cards seen on the page — the worker
  // reports the running total back via ACCEPTED. The harvest keeps scrolling
  // while it is under this, so a feed full of jobs already in the collector is
  // scrolled further rather than yielding a short list.
  //
  // Keep in step with MAX_ITEMS in sidepanel.js and MAX_STORED in
  // background.js — they are separate contexts with no shared module.
  const MAX_ITEMS = 50;

  // A safety bound on candidates, since the accepted count may never reach
  // MAX_ITEMS on a feed the collector already holds in full.
  const MAX_CANDIDATES = 400;

  const CARD = "[data-index]";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ==========================================================================
  // Reading one card
  // ==========================================================================

  // Returns the numeric data-index, or null when the attribute is missing,
  // empty, or not a number ("", "abc", undefined all fall out here).
  function cardIndex(el) {
    const raw = el.getAttribute("data-index");
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) >= 0 ? n : null;
  }

  const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  function readCard(el, index) {
    const titleEl = el.querySelector(TITLE_EXACT) || el.querySelector(TITLE_PREFIX);
    const title = textOf(titleEl);
    if (!title) return null; // no title => not a job card

    const companyEl = el.querySelector(COMPANY_EXACT) || el.querySelector(COMPANY_PREFIX);
    const company = textOf(companyEl);

    // Prefer a link that points at a job; fall back to the first link in the
    // card so a rebuilt URL shape still gives the panel something clickable.
    const linkEl = el.querySelector('a[href*="/jobs/"]') || el.querySelector("a[href]");
    let href = null;
    if (linkEl) {
      try {
        href = new URL(linkEl.getAttribute("href"), location.href).href;
      } catch {
        href = null; // malformed href, keep the job without a link
      }
    }

    return {
      index,
      title,
      company: company || null,
      href,
      // Flags a Jobright rebuild: the prefix still matches, the pinned hash
      // does not. The panel says so rather than silently drifting.
      staleTitleClass: !!titleEl && !titleEl.matches(TITLE_EXACT),
      staleCompanyClass: !!companyEl && !companyEl.matches(COMPANY_EXACT),
      // href is the stable identity; title+company is the fallback when a card
      // has no link yet.
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
  let urlTimer = null;
  let contextLost = false;
  let accepted = 0; // survivors of the collector's filter, per ACCEPTED
  let lastUrl = location.href;

  // Fire-and-forget. chrome.runtime.sendMessage rejects when no extension page
  // is listening, which is the normal state whenever the panel is closed, so
  // the rejection is swallowed rather than logged as an error.
  //
  // A *throw* is different: it means the extension context is gone (reloaded
  // or updated while this page stayed open) and this script is orphaned. Tear
  // down silently — going through stop() would call status(), which calls
  // post(), which throws again.
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
        onRecommendPage: /\/jobs\/recommend/.test(location.pathname),
        signedOut: looksSignedOut(),
        ...extra
      }
    });
  }

  function looksSignedOut() {
    if (found.size > 0) return false;
    const text = (document.body?.innerText || "").slice(0, 3000);
    return /\b(sign in|log in|login|signin)\b/i.test(text);
  }

  // One pass over whatever is currently in the DOM. Emits each newly seen card
  // individually, in document order, so the panel fills in one by one.
  function scan() {
    let fresh = 0;
    for (const el of document.querySelectorAll(CARD)) {
      if (found.size >= MAX_CANDIDATES) break;

      const index = cardIndex(el);
      if (index === null || index < MIN_DATA_INDEX) continue;

      const job = readCard(el, index);
      if (!job || found.has(job.key)) continue;

      found.set(job.key, job);
      fresh++;
      post({ type: "JOB_FOUND", job });
    }
    if (fresh) status();
    return fresh;
  }

  // The list is React-rendered, so cards arrive (and are recycled) long after
  // load. Coalesce bursts of mutations into one scan.
  function scheduleScan(delay = 150) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  // ==========================================================================
  // Virtual list harvesting
  //
  // data-index is the react-window signature: only the visible slice of the
  // list exists in the DOM at any moment, so a single querySelectorAll sees
  // ~10 cards, not the whole feed. Scrolling the container forces the rest to
  // mount, and the observer streams them as they appear.
  // ==========================================================================

  function findScroller() {
    let node = document.querySelector(CARD);
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 50) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollStep(el) {
    const before = el.scrollTop;
    el.scrollTop = before + Math.max(200, el.clientHeight * 0.8);
    return el.scrollTop === before; // unchanged => bottom reached
  }

  async function harvest({ maxScrolls = 60, pauseMs = 350 } = {}) {
    if (harvesting) return;
    harvesting = true;
    status();

    try {
      const scroller = findScroller();
      const startTop = scroller.scrollTop;
      let idleRounds = 0;

      // Scrolls on while fewer than MAX_ITEMS have been accepted, and stops the
      // moment enough have. Because duplicates never count, a feed the
      // collector mostly holds is scrolled further rather than yielding a
      // short list. The other exits are the list genuinely ending, the
      // candidate bound, and the scroll budget — so this always terminates.
      for (
        let i = 0;
        i < maxScrolls && streaming && accepted < MAX_ITEMS && found.size < MAX_CANDIDATES;
        i++
      ) {
        const before = found.size;
        const atBottom = scrollStep(scroller);
        await sleep(pauseMs);
        scan();

        if (found.size === before) {
          // Two dry rounds at the bottom, rather than one, so a slow render
          // does not end the harvest early.
          if (atBottom && ++idleRounds >= 2) break;
        } else {
          idleRounds = 0;
        }
      }

      scroller.scrollTop = startTop; // leave the page as we found it
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

      // jobright.ai is a Next.js SPA, so route changes are pushState, not
      // document loads. Poll for them and re-scan the new route.
      urlTimer = setInterval(() => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        scheduleScan(400);
        status({ navigated: true });
      }, 800);
    }

    scan();
    status({ started: true });
    if (autoScroll) harvest(options);

    return { ok: true, total: found.size, url: location.href };
  }

  function teardown() {
    streaming = false;
    observer?.disconnect();
    observer = null;
    clearTimeout(scanTimer);
    clearInterval(urlTimer);
  }

  function stop() {
    teardown();
    status({ stopped: true });
    return { ok: true, total: found.size };
  }

  // ==========================================================================
  // Job detail page
  //
  // background.js opens each caught card's URL in its own tab and asks this
  // for a reading. The origin link decides whether the rest is even read: a
  // LinkedIn posting is reported straight back so the worker can close the tab
  // without paying for the wait.
  // ==========================================================================

  const pick = (exact, prefix) =>
    document.querySelector(exact) || document.querySelector(prefix);

  // Resolves as soon as any of the selectors matches, so a LinkedIn job is
  // recognised the moment the origin renders instead of waiting on sections
  // that will never be read.
  function waitForAny(selectors, timeoutMs = 15000) {
    const hit = () => selectors.some((s) => document.querySelector(s));
    if (hit()) return Promise.resolve(true);

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!hit()) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(true);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, timeoutMs);
    });
  }

  // The origin element is sometimes the anchor itself and sometimes a wrapper
  // around one, so both are checked.
  function readOrigin() {
    const el = pick(ORIGIN_EXACT, ORIGIN_PREFIX);
    if (!el) return { el: null, href: null, hrefs: [], text: null };

    const anchors = [
      ...(el.matches("a[href]") ? [el] : []),
      ...el.querySelectorAll("a[href]")
    ];
    const hrefs = anchors
      .map((a) => {
        try {
          return new URL(a.getAttribute("href"), location.href).href;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return { el, href: hrefs[0] || null, hrefs, text: textOf(el) };
  }

  // Reads #overview-1 and trims it down to the description.
  //
  // The pruning happens on a *clone*. Removing these nodes from the live DOM
  // would visibly dismantle the page the user is looking at, and this runs on
  // a tab they are watching go past.
  function readDescription() {
    const source = document.querySelector(DETAIL_ID);
    if (!source) return null;

    const el = source.cloneNode(true);

    // Resolved before anything is removed: dropping a class-matched node first
    // could change which <section>s count as the first two.
    const sections = [...el.querySelectorAll("section")].slice(0, DROP_LEADING_SECTIONS);

    const blocks = [];
    let stale = false;
    for (const name of DROP_CLASSES) {
      const exact = [...el.querySelectorAll(`[class*="${name}"]`)];
      if (exact.length) {
        blocks.push(...exact);
        continue;
      }
      // Pinned hash missed — fall back to the prefix and flag the drift.
      const prefix = name.replace(/__.*$/, "__");
      const loose = [...el.querySelectorAll(`[class*="${prefix}"]`)];
      if (loose.length) {
        blocks.push(...loose);
        stale = true;
      }
    }

    for (const node of [...sections, ...blocks]) node.remove();

    return {
      el,
      droppedSections: sections.length,
      droppedBlocks: blocks.length,
      stale
    };
  }

  async function scrapeDetail() {
    const ready = await waitForAny([ORIGIN_EXACT, ORIGIN_PREFIX, DETAIL_ID]);

    const origin = readOrigin();

    // The check the whole pass turns on.
    const isLinkedIn = origin.hrefs.some((h) => h.startsWith(LINKEDIN));

    if (isLinkedIn) {
      return {
        ok: true,
        url: location.href,
        ready,
        isLinkedIn: true,
        originHref: origin.href,
        originText: origin.text
      };
    }

    const description = readDescription();

    return {
      ok: true,
      url: location.href,
      ready,
      isLinkedIn: false,
      originHref: origin.href,
      originText: origin.text,
      // A DOM element cannot cross a message port, so it is serialised here.
      // The markup is what gets posted as job_des; the text is what the panel
      // previews.
      descriptionHtml: description ? description.el.outerHTML : null,
      descriptionText: description ? textOf(description.el) : null,
      descriptionFound: !!description,
      droppedSections: description?.droppedSections ?? 0,
      droppedBlocks: description?.droppedBlocks ?? 0,
      // Same rebuild tripwire as the cards: prefix matched, pinned hash did not.
      staleDetailClass:
        (!!origin.el && !origin.el.matches(ORIGIN_EXACT)) || !!description?.stale
    };
  }

  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "SCRAPE_DETAIL":
        scrapeDetail().then(sendResponse, (err) =>
          sendResponse({ ok: false, error: err?.message || String(err) })
        );
        return true; // async reply

      // How the service worker tells "no listener here" apart from
      // "listener is busy" before it decides to inject.
      case "PING":
        sendResponse({ ok: true, url: location.href, streaming, total: found.size });
        return false;

      case "START_STREAM":
        sendResponse(start(msg.options));
        return false;

      case "STOP_STREAM":
        sendResponse(stop());
        return false;

      // Drops this tab's dedupe without emitting anything. Clear has to wipe
      // the list and leave it wiped — but the map still has to go, or a later
      // Start would find every card "already seen" and stream nothing.
      // The worker's running count of candidates that cleared the filter.
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
