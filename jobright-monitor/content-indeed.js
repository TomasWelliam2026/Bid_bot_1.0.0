// Runs on indeed.com (every country's site) — declaratively at page load, and
// injected on demand by background.js when a tab turns out to have no
// listener.
//
// The Indeed counterpart of content.js and content-dice.js, answering the same
// list messages (PING, START_STREAM, STOP_STREAM, NEXT_PAGE, ACCEPTED, FORGET)
// so the worker drives every board the same way. Where the others read a job
// in a tab of its own (SCRAPE_DETAIL), this answers READ_PANE: the card is
// clicked on the search page itself and the description read from the
// right-hand pane it opens — no tab is ever opened for a job. It also says
// when Indeed has put a human check in place of the page, so the worker can
// wait for someone to pass it.

// Injected twice would mean two listeners and every job streamed twice.
if (!window.__indeedFeedLoaded) {
  window.__indeedFeedLoaded = true;
  main();
}

function main() {
  // ==========================================================================
  // Selectors — the only thing to touch when Indeed ships a rebuild.
  //
  // Read the way content.js reads Jobright: each part is looked for by the
  // class name or attribute Indeed uses now first, then by the one it used
  // before, and a card read through the fallback is flagged, so the panel
  // says the layout has drifted rather than quietly reading less.
  //
  //   .job_seen_beacon                       <- the card
  //     h2.jobTitle a.jcs-JobTitle[data-jk]  <- title link; data-jk is the job's key
  //       span[title]                        <- title
  //     [data-testid="company-name"]         <- company   (before: .companyName)
  //     [data-testid="text-location"]        <- location  (before: .companyLocation)
  //     [data-testid="attribute_snippet_testid"]  <- the snippet that reads like
  //                                             pay is the salary (before: .salary-snippet-container)
  //     [data-testid="myJobsStateDate"]      <- "Posted 3 days ago" (before: .date)
  //
  // With no .job_seen_beacon on the page at all, every a[data-jk] — or a
  // heading's link carrying jk= — is a card's title link, and the card is the
  // list item around it.
  //
  // Not checked against the live site: Indeed answered the automated browser
  // used to build this with Cloudflare's block page. If a run finds no cards
  // on a page that plainly has some, these are the lines to adjust.
  // ==========================================================================

  const CARD = ".job_seen_beacon";
  const CARD_FALLBACK = ".cardOutline, li";

  const TITLE = "h2.jobTitle a.jcs-JobTitle";
  const TITLE_FALLBACK = 'a[data-jk], h2 a[href*="jk="]';

  const COMPANY = '[data-testid="company-name"]';
  const COMPANY_FALLBACK = ".companyName";

  const LOCATION = '[data-testid="text-location"]';
  const LOCATION_FALLBACK = ".companyLocation";

  const SNIPPETS = '[data-testid="attribute_snippet_testid"]';
  const SNIPPETS_FALLBACK = ".salary-snippet-container, .estimated-salary, .metadata";

  const POSTED = '[data-testid="myJobsStateDate"]';
  const POSTED_FALLBACK = ".date";

  // --- the pager -------------------------------------------------------------
  // Below the list, the pages of results:
  //
  //   .serp-page-z64vyd                        <- where the pager is
  //     [data-testid="pagination-page-next"]   <- Next
  //
  // "z64vyd" is a build hash, like Jobright's class suffixes: the exact class
  // is tried first, then any serp-page-* class, which keeps matching after a
  // rebuild. Inside it, Next is the test id, else a control labelled "Next
  // Page" or "Next" or marked rel=next, else the page link right after the
  // one marked current. With no such element at all, the whole page is
  // looked over — but only for the test id or the "Next Page" label, so a
  // header link marked current can never be mistaken for the pager.
  const PAGER = ".serp-page-z64vyd";
  const PAGER_FALLBACK = '[class*="serp-page-"]';
  const NEXT = '[data-testid="pagination-page-next"]';
  const NEXT_FALLBACK = '[aria-label="Next Page" i], [aria-label="Next" i], a[rel="next"]';
  const NEXT_ANYWHERE = '[data-testid="pagination-page-next"], a[aria-label="Next Page" i]';
  const CURRENT_PAGE = '[data-testid="pagination-page-current"], [aria-current="page"], [aria-current="true"]';

  // --- the job's description -----------------------------------------------
  // The description is one tag: ALL of the first parent of the description
  // heading, heading included. Clicking a card puts that card's job in it.
  //
  //   <parent>                                       <- the description, whole
  //     [data-testid="vj-job-description-heading"]
  //     #jobDescriptionText
  //
  // With no such heading — a layout that dropped it — #jobDescriptionText
  // alone stands in, and the job is flagged as layout drift. Both are looked
  // for across the whole page (the list never has either), and inside
  // #vjs-container-iframe on layouts that frame them.
  const DESCRIPTION_HEADING = '[data-testid="vj-job-description-heading"]';
  const DESCRIPTION_FALLBACK = "#jobDescriptionText";
  const DESCRIPTION_FRAME = "iframe#vjs-container-iframe";
  // Shortcuts only, never requirements: the job's key in the address (vjk=)
  // or the shown job's title saying the description already is this job's,
  // so it can be read without a click.
  const SHOWN_TITLE = '[data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title, h2[class*="JobInfoHeader-title"]';
  // How long a click on the title, and then on the card, has to change the
  // description, and how long a changed description has to settle.
  const LINK_CLICK_MS = 5000;
  const CARD_CLICK_MS = 5000;
  const SETTLE_MS = 3000;

  // --- the human check -------------------------------------------------------
  // Cloudflare's check, which Indeed shows in place of the page it was asked
  // for: "Just a moment..." while it looks at the browser, "Additional
  // Verification Required" or "Verify you are human" when it wants a person.
  const CHECK_TITLE = /^just a moment/i;
  const CHECK_TEXT = /additional verification required|verify you are human|checking your browser|needs to review the security of your connection/i;
  const CHECK_ELEMENTS = '#challenge-form, #challenge-stage, #challenge-running, iframe[src*="challenges.cloudflare.com"]';

  // Keep in step with MAX_ITEMS in content.js, sidepanel.js and MAX_STORED in
  // background.js — how many new jobs a run collects.
  const MAX_ITEMS = 50;
  const MAX_CANDIDATES = 400;
  const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const pick = (root, selector, fallback) => root?.querySelector(selector) || root?.querySelector(fallback) || null;

  const isBlocked = () =>
    CHECK_TITLE.test(document.title) ||
    CHECK_TEXT.test(document.body?.innerText.slice(0, 1000) || "") ||
    !!document.querySelector(CHECK_ELEMENTS);

  // ==========================================================================
  // Reading one card
  // ==========================================================================

  // "$45 an hour", "50,000 - 60,000 a year", "45 000 kr per month" — but not
  // "Day shift", "8 hour shift" or "Up to 40 hours per week", which sit in the
  // same snippets.
  const looksLikePay = (s) =>
    /[$£€₹¥]|\d[\d,.]*\s*(k|kr|zł|rs\.?|chf|sek|nok|dkk|pln|eur)?\s+(an?|per)\s+(hour|year|month|week|day|annum)\b/i.test(s);

  // The job's key: the link's data-jk, else the jk= in its href.
  function jobKey(link) {
    const jk = link.getAttribute("data-jk");
    if (jk) return jk;
    try {
      return new URL(link.getAttribute("href") || "", location.href).searchParams.get("jk");
    } catch {
      return null;
    }
  }

  function readCard({ card, link, staleCard }, index) {
    const jk = link && jobKey(link);
    if (!jk) return null; // no job key => not a job card

    const title = (link.querySelector("span[title]")?.getAttribute("title") || textOf(link)).trim();
    if (!title) return null;

    const companyEl = pick(card, COMPANY, COMPANY_FALLBACK);
    const payIn = (selector) => [...(card?.querySelectorAll(selector) || [])].map(textOf).find(looksLikePay);
    const salary = payIn(SNIPPETS) || payIn(SNIPPETS_FALLBACK);
    // A visually hidden "Posted" can sit before the visible one. "3 days ago"
    // gets it back once; "Just posted" and "Today" read fine as they are.
    const age = textOf(pick(card, POSTED, POSTED_FALLBACK)).replace(/^(posted\s*)+/i, "").trim();

    // The link the card itself carries is a click-tracking redirect, so the
    // job's own page is linked instead.
    const href = new URL(`/viewjob?jk=${encodeURIComponent(jk)}`, location.origin).href;
    return {
      index,
      source: "indeed",
      // The job's key, for READ_PANE to find its card again.
      jk,
      title,
      company: textOf(companyEl) || null,
      href,
      location: textOf(pick(card, LOCATION, LOCATION_FALLBACK)) || null,
      salary: salary || null,
      posted: (/^\d/.test(age) ? `Posted ${age}` : age) || null,
      // Indeed rebuilt its cards: the fallback matched, the current one did not.
      staleTitleClass: staleCard || !link.matches(TITLE),
      staleCompanyClass: !!companyEl && !companyEl.matches(COMPANY),
      key: href,
      foundAt: new Date().toISOString()
    };
  }

  // Every card on the page with its title link: by the card class, or — on a
  // page without it — from each job link out.
  function cardsIn(root) {
    const cards = root.querySelectorAll(CARD);
    if (cards.length) {
      return [...cards].map((card) => ({ card, link: pick(card, TITLE, TITLE_FALLBACK), staleCard: false }));
    }
    return [...root.querySelectorAll(TITLE_FALLBACK)].map((link) => ({
      card: link.closest(CARD_FALLBACK) || link.parentElement,
      link,
      staleCard: true
    }));
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
        // The same flag content.js sets for its list page.
        onRecommendPage: location.pathname.startsWith("/jobs"),
        signedOut: false, // Indeed search works signed out
        ...extra
      }
    });
  }

  function scan(root = document) {
    let fresh = 0;
    for (const entry of cardsIn(root)) {
      if (found.size >= MAX_CANDIDATES) break;
      const job = readCard(entry, found.size + 1);
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
  // As on Dice: the worker finishes every job found on this page — checked,
  // read in the pane, resume built, saved — and only then sends NEXT_PAGE,
  // which clicks the pager's Next the way a person would. The next page's
  // cards are then caught by START_STREAM like the first page's: in a new
  // document, or — if Indeed swaps the list in place — by this one, whose
  // dedupe keeps what was already seen.
  // ==========================================================================

  const isDisabled = (el) =>
    el.matches(":disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    /\bdisabled\b/i.test(el.getAttribute("class") || "");

  // `selector` in `root` or as `root` itself — the class may sit on the Next
  // control rather than around it.
  const within = (root, selector) => (root.matches(selector) ? root : root.querySelector(selector));

  // The page link right after the one marked current, in the pager.
  function afterCurrent(pager) {
    const current = within(pager, CURRENT_PAGE);
    if (!current) return null;
    return (
      [...pager.querySelectorAll("a[href], button")].find(
        (el) =>
          el !== current &&
          !el.contains(current) &&
          !current.contains(el) &&
          current.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
      ) || null
    );
  }

  function findNext() {
    let pagers = [...document.querySelectorAll(PAGER)];
    if (!pagers.length) pagers = [...document.querySelectorAll(PAGER_FALLBACK)];
    for (const pager of pagers) {
      const next = within(pager, NEXT) || within(pager, NEXT_FALLBACK) || afterCurrent(pager);
      if (next) return next;
    }
    return document.querySelector(NEXT_ANYWHERE);
  }

  function clickNext() {
    // A check has no pager either, but it is not the last page.
    if (isBlocked()) {
      status({ blocked: true });
      return { ok: true, clicked: false, blocked: true, url: location.href };
    }

    const next = findNext();
    if (!next || isDisabled(next)) {
      status({ lastPage: true });
      return { ok: true, clicked: false, url: location.href };
    }

    status({ paging: true });
    const url = location.href;
    // Answered first, clicked a beat later: the click may load a new
    // document, and the worker must already have its reply. The next page
    // loads in this tab — a target on the link is set aside for the click, so
    // it can never open the page in a new one.
    setTimeout(() => {
      next.scrollIntoView({ block: "center" });
      const target = next.getAttribute("target");
      next.removeAttribute("target");
      next.click();
      if (target !== null) next.setAttribute("target", target);
    }, 50);
    return { ok: true, clicked: true, url };
  }

  // ==========================================================================
  // Start / stop
  // ==========================================================================

  // autoScroll is not read here: later pages are reached by NEXT_PAGE, once
  // this page's jobs are done, not harvested up front.
  //
  // A human check in place of the results is reported rather than watched:
  // the worker waits for someone to pass it, and passing it loads the results
  // as a new document, which the worker then starts again.
  function start() {
    if (isBlocked()) {
      teardown();
      status({ blocked: true });
      return { ok: true, total: found.size, fresh: 0, blocked: true, url: location.href };
    }

    if (!streaming) {
      streaming = true;
      // Cards can arrive after load.
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
  // Reading a job's description
  //
  // The description is read from its tag. The card is clicked, the way a
  // person would; the description tag then changes to that job, and once it
  // has stopped changing it is read. Nothing else on the page has to agree —
  // not the address, not a title — so a layout that renames those cannot stop
  // the read. No tab is opened, and the search page never changes under the
  // run, so its list and pager stay where they are.
  // ==========================================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The card's title link for a job key.
  const linkFor = (jk) =>
    [...document.querySelectorAll(`${TITLE}, ${TITLE_FALLBACK}`)].find((link) => jobKey(link) === jk) || null;

  // The description tag in a document: the description heading's first
  // parent, whole — else, with no heading, the #jobDescriptionText block,
  // flagged as the stand-in.
  function descriptionIn(root) {
    const heading = root.querySelector(DESCRIPTION_HEADING);
    if (heading?.parentElement) return { block: heading.parentElement, stale: false };
    const fallback = root.querySelector(DESCRIPTION_FALLBACK);
    return fallback ? { block: fallback, stale: true } : null;
  }

  // The description as the page shows it now, from the page itself or from
  // the frame some layouts put it in, with the shown job's title where there
  // is one. Null while there is no description on the page.
  function descriptionNow() {
    const frame = document.querySelector(DESCRIPTION_FRAME);
    let framed = null;
    try {
      framed = frame?.contentDocument || null;
    } catch {
      framed = null; // a frame from elsewhere; not Indeed's
    }
    for (const root of [document, framed].filter(Boolean)) {
      const found = descriptionIn(root);
      if (found) {
        return { ...found, title: textOf(root.querySelector(SHOWN_TITLE)), text: found.block.textContent };
      }
    }
    return null;
  }

  // Which job each description on this page was read for, by its text. A
  // description still showing after a click, and already read for another
  // job, is that other job's — the click did not take — and is never read
  // again for this one.
  const readFor = new Map();

  async function waitUntil(test, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = test();
      if (hit || Date.now() >= deadline) return hit || null;
      await sleep(200);
    }
  }

  // The description can arrive in parts: read once it has stopped changing.
  async function settled(shown) {
    let last = shown;
    let same = 0;
    const deadline = Date.now() + SETTLE_MS;
    while (same < 2 && Date.now() < deadline) {
      await sleep(250);
      const now = descriptionNow();
      if (now && now.text === last.text) same++;
      else if (now) {
        last = now;
        same = 0;
      }
    }
    return last;
  }

  // Clicks the title link the way a person does, with its href and target
  // left as they are — Indeed's own handler may need them. What the browser
  // itself would then do (load the job's page, open a tab) is cancelled by a
  // listener at the very end of the click's path, after Indeed's handler has
  // run, so all the click can do is what Indeed's script does with it.
  function clickTitle(link) {
    const cancel = (e) => e.preventDefault();
    window.addEventListener("click", cancel, { once: true });
    try {
      link.click();
    } finally {
      window.removeEventListener("click", cancel);
    }
  }

  // Answers the reading, { ok: false, error } when the description could not
  // be read for this job, or { blocked } for a human check.
  async function readInPane(jk, title) {
    const check = { ok: false, blocked: true, url: location.href, error: "Indeed showed a human check" };
    if (isBlocked()) return check;
    const link = linkFor(jk);
    if (!link) return { ok: false, error: "the job is not on the search page showing now — press Start again for it" };

    const before = descriptionNow();
    const readBefore = before ? readFor.get(before.text) : undefined;
    // What is showing has not been read for another job, so it may be this one's.
    const couldBeThis = !!before && (readBefore === undefined || readBefore === jk);

    // Already this job's, by the address or the shown title: read it as it is.
    const vjk = new URL(location.href).searchParams.get("vjk");
    const titled = !!title && !!before?.title && before.title.toLowerCase().startsWith(title.toLowerCase());
    let shown = couldBeThis && (vjk === jk || titled) ? before : null;

    if (!shown) {
      // The description tag changed to another job's.
      const changed = () => {
        const now = descriptionNow();
        return now && now.text !== (before ? before.text : null) ? now : null;
      };

      link.scrollIntoView({ block: "center" });
      clickTitle(link);
      shown = await waitUntil(changed, LINK_CLICK_MS);
      // A layout that listens on the card rather than its title: the card
      // itself, outside the link, is the second click.
      if (!shown && !isBlocked()) {
        (link.closest(`${CARD}, ${CARD_FALLBACK}`) || link.parentElement).click();
        shown = await waitUntil(changed, CARD_CLICK_MS);
      }
      // Unchanged by either click: the description showing all along is this
      // job's — the first card, which Indeed shows unasked — unless it was
      // read for another job.
      if (!shown && !isBlocked() && couldBeThis) shown = descriptionNow();
    }

    if (!shown) {
      if (isBlocked()) return check;
      return {
        ok: false,
        error: before
          ? "clicking the job's card did not change the description — it still shows the previous job's"
          : `no job description appeared after clicking the job's card (no ${DESCRIPTION_HEADING} or ${DESCRIPTION_FALLBACK} on the page)`
      };
    }

    const { block, stale, text } = await settled(shown);
    readFor.set(text, jk);
    return {
      ok: true,
      url: location.href,
      readFrom: "pane",
      ready: true,
      isLinkedIn: false, // Indeed pages link to Indeed's own LinkedIn; no LinkedIn rule here
      originHref: null,
      originText: null,
      descriptionHtml: block.cloneNode(true).outerHTML,
      // The text is what the model is given, so the breaks between paragraphs
      // and list items are kept: the tag's text as it reads on screen.
      descriptionText: (block.innerText || block.textContent).replace(/\n{3,}/g, "\n\n").trim(),
      descriptionFound: true,
      // No description heading: #jobDescriptionText had to stand in.
      staleDetailClass: stale
    };
  }

  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case "READ_PANE":
        readInPane(String(msg.jk || ""), String(msg.title || "")).then(sendResponse, (err) =>
          sendResponse({ ok: false, error: err?.message || String(err) })
        );
        return true;

      // `blocked` is how the worker, waiting on a human check, learns that it
      // has been passed.
      case "PING":
        sendResponse({ ok: true, url: location.href, streaming, total: found.size, blocked: isBlocked() });
        return false;

      case "START_STREAM":
        sendResponse(start(msg.options));
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
