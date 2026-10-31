// Runs on ziprecruiter.com — declaratively at page load, and injected on
// demand by background.js when a tab turns out to have no listener.
//
// The ZipRecruiter counterpart of content.js, content-dice.js and
// content-glassdoor.js, answering the same messages (PING, START_STREAM,
// STOP_STREAM, ACCEPTED, FORGET) plus READ_PANE, the way content-indeed.js
// does: the search page is a two-pane layout, so a card is clicked in place
// and the description read from the right-hand pane that click fills — no
// tab is ever opened for a job.
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
  // A card is the direct parent of whatever element carries a tabindex
  // *inside the job list* — the <ul aria-label="Job listings"> — there is
  // exactly one such element per card, so its parent is the card, found
  // without needing a class name at all. Scoped to that list specifically,
  // not the whole page: other tabindex elements sit outside it (filters,
  // pagination, nav) and would otherwise be read as cards of their own.
  //   title   — not the aria-label attribute's own value, but the rendered
  //             text inside the element that carries one. More than one
  //             element in a card can carry an aria-label (a save/bookmark
  //             button's reads "Save", for one), so the one with the longest
  //             aria-label is taken as the title element — a real title's
  //             label reads far longer than a button's — and its own text
  //             content, not that attribute, is the title. ZipRecruiter's own
  //             aria-label often carries more than the title ("View Senior
  //             Data Engineer"), read for a screen reader only; the element's
  //             visible text does not.
  //   company — the text of a <span> whose class list has one class ending
  //             in "xsh4ujf" (a CSS-module hash, so matched by the end of
  //             the class name, not the class name whole).
  //   link    — the title's own element when it is a link, else a job link
  //             in the card, else the card's first link
  //
  // The data-testid names below are kept as a fallback only, from before the
  // card itself was found this way — if ZipRecruiter changes its hashed
  // class names again, these are the lines to adjust.
  // ==========================================================================

  const JOB_LIST = 'ul[aria-label="Job listings"]';
  const TABINDEX_ATTR = "[tabindex]";
  const TABINDEX_EL = `${JOB_LIST} ${TABINDEX_ATTR}`;
  const TITLE_FALLBACK = '[data-testid="serp-job-card-title"], [aria-label="serp-job-card-title"]';
  const COMPANY_CLASS_SUFFIX = "xsh4ujf";
  const COMPANY_FALLBACK = '[data-testid="job-card-company"], [aria-label="job-card-company"]';
  const JOB_LINK = 'a[href*="/c/"], a[href*="/jobs/"], a[href*="jid="], a[href*="/job/"]';

  // The first class in an element's class list ending with `suffix` — a
  // hashed CSS-module class is never the whole class name a selector could
  // match, only its tail, so every class token is checked rather than the
  // class attribute as one string.
  const hasClassEnding = (el, suffix) => [...el.classList].some((cls) => cls.endsWith(suffix));

  // The element in `card` with the longest aria-label, and that label's text
  // — the title, on the theory that a button's aria-label ("Save", "Apply")
  // is always shorter than an actual job title.
  // The title's own link often carries a longer aria-label than the title
  // text alone — "View Senior Data Engineer", "View job: …" — read for a
  // screen reader, not meant to be read back as part of the title.
  function longestAriaLabel(card) {
    let best = null;
    let bestLabelLength = 0;
    for (const el of card.querySelectorAll("[aria-label]")) {
      const label = (el.getAttribute("aria-label") || "").trim();
      if (label.length > bestLabelLength) {
        best = el;
        bestLabelLength = label.length;
      }
    }
    if (!best) return null;
    // The title element's own rendered text, not the attribute that picked
    // it out — the attribute is what singles out the right element, the
    // child content under it is what the title actually is.
    const text = textOf(best);
    return text ? { el: best, text } : null;
  }

  function companyEl(card) {
    for (const span of card.querySelectorAll("span[class]")) {
      if (hasClassEnding(span, COMPANY_CLASS_SUFFIX)) return span;
    }
    return card.querySelector(COMPANY_FALLBACK);
  }

  // --- the job page ----------------------------------------------------------
  // The description sits in ZipRecruiter's own landmark for it: a <section
  // role="region">. That role is also used elsewhere on the page (related
  // jobs, company info), so of every section with it, the one with the most
  // text wins — the posting is always the longest by far.
  const REGION_SECTION = 'section[role="region"]';
  // Older fallback, from before the region landmark was found: an element
  // with class "flex flex-col gap-y-[16px]" that has a "Job description"
  // heading as a child. Those Tailwind classes are on many elements, so the
  // heading is what picks the right one.
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
  const MAX_ITEMS = 30;
  const MAX_CANDIDATES = 400;

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
    const labelled = longestAriaLabel(card);
    const fallbackTitleEl = !labelled ? card.querySelector(TITLE_FALLBACK) : null;
    const titleEl = labelled?.el || fallbackTitleEl;
    const title = labelled?.text || textOf(fallbackTitleEl);
    if (!title) return null; // not a job card (or not rendered yet)

    const companySpan = companyEl(card);
    const company = textOf(companySpan);
    // Shown in the panel as the job's link (opened in a new tab by a human
    // click, same as every other board) and used to push the address bar to
    // match once the card is read in place — see readInPane.
    const href = linkOf(card, titleEl);

    return {
      index,
      source: "ziprecruiter",
      title,
      company: company || null,
      href,
      staleTitleClass: !labelled,
      staleCompanyClass: !companySpan || !hasClassEnding(companySpan, COMPANY_CLASS_SUFFIX),
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
        onRecommendPage: location.pathname.startsWith("/jobs-search"),
        signedOut: false, // search works signed out
        ...extra
      }
    });
  }

  // Every tabindex element's own parent, deduplicated (a card can hold more
  // than one tabindex element — its title link and its save button, say —
  // and both share the same parent). Only ones holding something a title
  // could come from count, and of those the innermost — one per job, never
  // counted twice.
  function cardsIn(root) {
    const parents = new Set();
    for (const el of root.querySelectorAll(TABINDEX_EL)) {
      if (el.parentElement) parents.add(el.parentElement);
    }
    const all = [...parents].filter((c) => c.querySelector("[aria-label]") || c.querySelector(TITLE_FALLBACK));
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
  // One page at a time, on the page itself: the worker finishes every job
  // found here — checked, read, resume built, saved — and only then sends
  // NEXT_PAGE, which clicks the pager's [aria-label="Next page"] the way a
  // person would. The next page's cards are then read by START_STREAM like
  // the first page's, same as Dice and Indeed.
  // ==========================================================================

  const NEXT_PAGE_LINK = '[aria-label="Next page"]';

  const isDisabled = (el) =>
    el.matches(":disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    /\bdisabled\b/i.test(el.getAttribute("class") || "");

  function clickNext() {
    const next = document.querySelector(NEXT_PAGE_LINK);
    if (!next || isDisabled(next)) {
      status({ lastPage: true });
      return { ok: true, clicked: false, url: location.href };
    }

    status({ paging: true });
    const url = location.href;
    // Answered first, clicked a beat later: if the click loads a new document
    // this one is gone, and the worker must already have its reply.
    setTimeout(() => {
      next.scrollIntoView({ block: "center" });
      next.click();
    }, 50);
    return { ok: true, clicked: true, url };
  }

  // ==========================================================================
  // Start / stop
  // ==========================================================================

  // autoScroll is not read here: later pages are reached by NEXT_PAGE, once
  // this page's jobs are done, not harvested up front.
  function start() {
    if (!streaming) {
      streaming = true;
      observer = new MutationObserver(() => scheduleScan());
      observer.observe(document.body, { childList: true, subtree: true });
    }

    scan();
    status({ started: true });

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

  // The <section role="region">, by text length — the posting itself is far
  // longer than any other section sharing the role.
  function regionDescription() {
    const sections = [...document.querySelectorAll(REGION_SECTION)].filter((el) => textOf(el).length > 100);
    return sections.sort((a, b) => textOf(b).length - textOf(a).length)[0] || null;
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

  // The description by any route, region first.
  const anyDescription = () => regionDescription() || labelledDescription();

  // Waits for a real description box, not just any element with the
  // fallback's classes, which can render first.
  function waitForDescription(timeoutMs = 15000) {
    if (anyDescription()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (!anyDescription()) return;
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
    const primaryReady = await waitForDescription();
    const ready = primaryReady || (await waitForAny([DESCRIPTION, STRUCTURED_DATA], 3000));
    const region = regionDescription();
    const labelled = region ? null : labelledDescription();
    const block = region || labelled ? null : descriptionBlock();
    const el = region || labelled || (block ? block.cloneNode(true) : structuredDescription());

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
      // Found, but not the region landmark or the labelled box: the page
      // layout has moved.
      staleDetailClass: !region && !labelled && !!el
    };
  }

  // ==========================================================================
  // Reading a card's description in place
  //
  // The search page is two panes: clicking a card does not navigate — it
  // fills the right-hand pane with that job's own <section role="region">.
  // So the job is read there, on the search page itself; no tab of its own is
  // ever opened for it.
  // ==========================================================================

  const PANE_CLICK_MS = 5000;
  const SETTLE_MS = 3000;

  const sameText = (a, b) => textOf(a) === textOf(b);

  // The card whose own key is this job's — the same cards scan() already
  // finds, read again for the one the worker asked for. By key, not href:
  // `href` is never handed back to the worker (see readCard), so the key —
  // internally still built from the card's own link, just not exposed as
  // one — is what finds it again.
  function cardForKey(key) {
    for (const card of cardsIn(document)) {
      const job = readCard(card, 0);
      if (job && job.key === key) return card;
    }
    return null;
  }

  async function waitUntil(test, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = test();
      if (hit || Date.now() >= deadline) return hit || null;
      await sleep(150);
    }
  }

  // The description shown changes only once it has stopped changing — a
  // click can bring it in over more than one render.
  async function settled() {
    let last = anyDescription();
    let same = 0;
    const deadline = Date.now() + SETTLE_MS;
    while (same < 2 && Date.now() < deadline) {
      await sleep(200);
      const now = anyDescription();
      if (now && last && sameText(now, last)) same++;
      else if (now) {
        last = now;
        same = 0;
      }
    }
    return last;
  }

  // Clicks the card's own clickable element the way a person does — but the
  // browser's own default action (following its href, which would open or
  // navigate a tab) is cancelled once ZipRecruiter's own handler has had the
  // click, by a listener added on window, the last stop a click bubbles
  // through before the default action runs. All the click can do, then, is
  // whatever ZipRecruiter's own script does with it — swap the right pane.
  function clickInPlace(el) {
    const cancel = (e) => e.preventDefault();
    window.addEventListener("click", cancel, { once: true });
    try {
      el.click();
    } finally {
      window.removeEventListener("click", cancel);
    }
  }

  async function readInPane(key) {
    const card = cardForKey(key);
    if (!card) return { ok: false, error: "the job is not on the search page showing now — press Start again for it" };
    const clickable = card.querySelector(TABINDEX_ATTR) || card;

    const before = anyDescription();
    const changed = () => {
      const now = anyDescription();
      return now && !(before && sameText(now, before)) ? now : null;
    };

    clickable.scrollIntoView({ block: "center" });
    clickInPlace(clickable);
    let shown = await waitUntil(changed, PANE_CLICK_MS);
    // Unchanged: the pane showing all along may already be this job's — the
    // first card, which the page can show unasked.
    if (!shown) shown = anyDescription();

    if (!shown) {
      return {
        ok: false,
        error: before
          ? "clicking the job's card did not change the right-hand pane"
          : "no job description appeared in the right-hand pane after clicking the job's card"
      };
    }

    const el = await settled();
    return {
      ok: true,
      url: location.href,
      readFrom: "pane",
      ready: true,
      isLinkedIn: false,
      originHref: null,
      originText: null,
      descriptionHtml: el.outerHTML,
      descriptionText: textOf(el),
      descriptionFound: true,
      // Found, but not the region landmark: the page layout has moved.
      // `labelledDescription()` returns a fresh clone each call, so what is
      // checked is whether a region exists now, not object identity with it.
      staleDetailClass: !regionDescription()
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

      case "READ_PANE":
        readInPane(String(msg.key || "")).then(sendResponse, (err) =>
          sendResponse({ ok: false, error: err?.message || String(err) })
        );
        return true;

      case "PING":
        sendResponse({ ok: true, url: location.href, streaming, total: found.size, keys: [...found.keys()] });
        return false;

      case "START_STREAM":
        sendResponse(start());
        return false;

      case "NEXT_PAGE":
        sendResponse(clickNext());
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
