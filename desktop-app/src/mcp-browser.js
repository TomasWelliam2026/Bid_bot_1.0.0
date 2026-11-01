// Google Chrome, driven through the Chrome DevTools MCP server.
//
// The app is an MCP client: it starts chrome-devtools-mcp over stdio and does
// everything to the browser with that server's tools — list_pages, new_page,
// select_page, close_page and evaluate_script. Nothing here talks to Chrome
// directly.
//
// On top of those tools it keeps a model of Chrome's tabs the way the
// extension's chrome.tabs API would see them — id, url, title, load status,
// active — refreshed by polling each page, and raises the same events
// (created, updated, removed, activated). A page's id is the MCP server's
// pageId, which stays the same for as long as the page is open.

const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { BRIDGE_SOURCE, POLL_FUNCTION, wrapContentScript, dispatchFunction } = require("./page-bridge");

const POLL_MS = 500;
const QUIET_EVERY = 8; // a tab nothing is happening in: every 8th poll, ~4s
const LIST_EVERY = 3; // list_pages on every third poll; pages are polled each time
const ANSWER_TIMEOUT_MS = 5 * 60 * 1000;
const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
const PORT_CLOSED = "The message port closed before a response was received.";

// Chrome match patterns (as in manifest.json and chrome.tabs.query) as regexes.
function patternToRegex(pattern) {
  if (pattern === "<all_urls>") return /^(https?|file):/;
  const m = /^(\*|https?|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return /$^/;
  const [, scheme, host, rest] = m;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const schemeRe = scheme === "*" ? "https?" : esc(scheme);
  const hostRe = host === "*" ? "[^/]*" : host.startsWith("*.") ? `(?:[^/]*\\.)?${esc(host.slice(2))}` : esc(host);
  const pathRe = rest.split("*").map(esc).join(".*");
  return new RegExp(`^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`);
}

const matchesAny = (url, patterns) => [].concat(patterns).some((p) => patternToRegex(p).test(url || ""));

// "Script ran on page and returned:\n```json\n…\n```" → the value.
function parseEvaluate(result) {
  const text = (result?.content || []).map((c) => c.text || "").join("\n");
  if (result?.isError) throw new Error(text.replace(/^Error:\s*/, "") || "the script failed in the page");
  const m = /```json\s*([\s\S]*?)\s*```/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return m[1];
  }
}

// "## Pages\n1: Title (url)\n2: about:blank [selected]" → ids, and which one
// the server has selected.
function parsePageIds(result) {
  const text = (result?.content || []).map((c) => c.text || "").join("\n");
  const ids = [];
  let selected = null;
  for (const line of text.split("\n")) {
    const m = /^(\d+):\s/.exec(line.trim());
    if (!m) continue;
    const id = Number(m[1]);
    ids.push(id);
    if (/\[selected\]\s*$/.test(line)) selected = id;
  }
  return { ids, selected };
}

// list_pages as { id, url }: "3: Title (https://…) [selected]", or "1: about:blank".
function parsePages(result) {
  const text = (result?.content || []).map((c) => c.text || "").join("\n");
  const pages = [];
  for (const raw of text.split("\n")) {
    const m = /^(\d+):\s(.*)$/.exec(raw.trim());
    if (!m) continue;
    const rest = m[2].replace(/\s*\[selected\]\s*$/, "");
    const inParens = /\(([a-z][a-z0-9+.-]*:[^\s]*)\)$/i.exec(rest);
    pages.push({ id: Number(m[1]), url: inParens ? inParens[1] : rest });
  }
  return pages;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE_TAB_TIMEOUT_MS = 20000;
// What the MCP server says when a script's page was closed under it, and how
// long a tab is given to show up on its new page.
const PAGE_GONE = /Target closed|No page found|Session closed|detached|Execution context was destroyed|No tab with id/i;
const PAGE_SWAP_TIMEOUT_MS = 8000;
const PAGE_SETTLE_GRACE_MS = 20000;
// The key, in a job board's site storage, naming the profile a tab is in.
const PROFILE_MARKER = "__bidbot_profile";

class McpBrowser extends EventEmitter {
  // extensionDir: where content scripts and manifest.json are read from.
  constructor({ extensionDir, log = () => {} }) {
    super();
    this.extensionDir = extensionDir;
    this.log = log;
    this.client = null;
    this.transport = null;
    this.state = "disconnected"; // disconnected | connecting | connected
    this.error = null;
    this.tabs = new Map(); // id -> tab, as chrome.tabs would describe it
    this.docs = new Map(); // id -> docId of the bridge last seen in that page
    this.ours = new Set(); // ids of the tabs the app opened — kept for the whole connection
    this.missing = new Map(); // id -> lists in a row it has been absent from
    this.byPage = new Map(); // MCP page id -> tab id
    this.markerChecked = new Map(); // tab id -> the URL its profile marker was last read at
    this.pending = new Map(); // reqId -> { tabId, docId, resolve, reject, timer }
    this.reqSeq = 0;
    this.pollTimer = null;
    this.polls = 0;
    this.activeId = null;
    this.connecting = null;
    this.autoScripts = this.readAutoScripts();
  }

  // The manifest's content_scripts: the extension's scripts run by themselves
  // on matching pages, and so they do here.
  readAutoScripts() {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(this.extensionDir, "manifest.json"), "utf8"));
      return (manifest.content_scripts || []).map((cs) => ({ matches: cs.matches, js: cs.js }));
    } catch {
      return [];
    }
  }

  status() {
    const tabs = [...this.tabs.keys()].filter((id) => this.visible(id)).length;
    return { state: this.state, error: this.error, tabs, browser: this.browserLabel || null, profile: this.profileScope?.name || null };
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit("status", this.status());
  }

  // browser: { mode: "launch", exe, userDataDir, label } — a Chrome started by
  //          the MCP server, on a profile of the app's own;
  //          { mode: "attach", wsEndpoint, label, profile? } — a browser
  //          already open, with remote debugging on. With a profile —
  //          { dir, name, exe, args } — the app opens its tabs in that profile
  //          and works only with the tabs it opened there.
  async connect(browser) {
    if (this.connecting) return this.connecting;
    if (this.state === "connected") await this.disconnect();
    this.connecting = this.doConnect(browser).finally(() => (this.connecting = null));
    return this.connecting;
  }

  async doConnect(browser) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    this.browserLabel = browser.label;
    // Page ids start again with every MCP session.
    this.ours.clear();
    this.missing.clear();
    this.byPage.clear();
    this.markerChecked.clear();
    this.profileScope = browser.mode === "attach" && browser.profile ? browser.profile : null;
    this.stopRequested = false;
    this.setState("connecting");

    const server = require.resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
    const args = [server, "--no-usage-statistics", "--no-performance-crux"];
    if (browser.mode === "attach") {
      // A browser already running, by the WebSocket address its
      // DevToolsActivePort file gives: any Chrome, Edge or Brave, on any data
      // folder. The first connection makes Chrome ask "Allow remote
      // debugging?" in that browser.
      if (browser.wsEndpoint) args.push("--wsEndpoint", browser.wsEndpoint);
      else args.push("--autoConnect", "--channel", browser.channel || "stable");
      // Lists the extension's own pages too: its settings are read from one.
      // The server lists extension pages only with both switched on.
      args.push("--experimentalIncludeAllPages", "--categoryExtensions");
    } else {
      fs.mkdirSync(browser.userDataDir, { recursive: true });
      args.push("--executablePath", browser.exe, "--userDataDir", browser.userDataDir);
      if (browser.headless) args.push("--headless");
      for (const arg of browser.chromeArgs || []) args.push(`--chromeArg=${arg}`);
      if (browser.acceptInsecureCerts) args.push("--acceptInsecureCerts");
    }

    // The server is a Node script; Electron's own binary runs it as Node.
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
      stderr: "pipe"
    });
    this.transport.stderr?.on("data", (d) => this.log(`[mcp] ${String(d).trim()}`));

    this.client = new Client({ name: "bid-bot-desktop", version: "1.0.0" });
    this.client.onclose = () => this.onClosed();

    try {
      await this.client.connect(this.transport);
      if (this.stopRequested) throw new Error("stopped");
      // The first call is what actually starts (or reaches) Chrome.
      const listed = await this.call("list_pages", {});
      const { ids } = parsePageIds(listed);
      for (const id of ids) this.ensureTab(id);
      // A Chrome just launched has one blank tab; the first page opened uses it.
      this.spareTabId = browser.mode === "launch" && ids.length === 1 ? ids[0] : null;
      this.setState("connected");
      this.startPolling();
      await this.pollOnce(true);
      return this.status();
    } catch (err) {
      const message = err?.message || String(err);
      // Stopped by hand is not a failure to report.
      const stopped = this.stopRequested;
      await this.disconnect();
      this.setState("disconnected", stopped ? null : message);
      throw new Error(stopped ? "stopped" : message);
    }
  }

  async disconnect() {
    // Also how a connection still being made is stopped: closing its client
    // ends the wait, in doConnect.
    if (this.state === "connecting") this.stopRequested = true;
    clearInterval(this.pollTimer);
    this.missing.clear();
    this.pollTimer = null;
    const client = this.client;
    this.client = null;
    for (const [, p] of this.pending) p.reject(new Error(PORT_CLOSED));
    this.pending.clear();
    for (const id of [...this.tabs.keys()]) this.dropTab(id);
    this.ours.clear();
    if (client) await client.close().catch(() => {});
    if (this.state !== "disconnected") this.setState("disconnected");
  }

  onClosed() {
    if (!this.client) return;
    this.client = null;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const id of [...this.tabs.keys()]) this.dropTab(id);
    this.ours.clear();
    this.missing.clear();
    this.setState("disconnected", "the browser closed, or the MCP server stopped");
  }

  async call(name, args) {
    if (!this.client && this.connecting) await this.connecting.catch(() => {});
    if (!this.client && this.ensureConnected && this.state !== "connecting") await this.ensureConnected();
    if (!this.client) throw new Error("not connected to Chrome — pick a browser and click Connect");
    return this.client.callTool({ name, arguments: args });
  }

  // id is the tab's id; the call goes to whatever page is in that tab now.
  // A page can be closed under a script running in it: Chrome swaps the page
  // in a tab for a new one as a site moves itself on (Gmail does, opening a
  // new message). The page list is read again until the tab has its new
  // page, and the script is run once more there.
  async evaluate(id, fn, { format = "function" } = {}) {
    const run = () => this.call("evaluate_script", { pageId: this.pageOf(id), function: fn, format, waitForStableDom: false });
    try {
      return parseEvaluate(await run());
    } catch (err) {
      if (!PAGE_GONE.test(err?.message || "") || !this.tabs.has(Number(id))) throw err;
      const gone = this.pageOf(id);
      for (const until = Date.now() + PAGE_SWAP_TIMEOUT_MS; Date.now() < until; await sleep(400)) {
        this.syncList(await this.call("list_pages", {}));
        if (!this.tabs.has(Number(id))) break;
        if (this.pageOf(id) !== gone) {
          this.log(`[tabs] ${id}: page ${gone} closed under a script — running it again on page ${this.pageOf(id)}`);
          return parseEvaluate(await run());
        }
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // The tab model
  // -------------------------------------------------------------------------

  // A tab's id is the page id it was first seen with, and stays its id when
  // Chrome swaps the page inside it for a new one (a tab opened from the
  // command line starts on about:blank and gets a new page, under a new MCP
  // page id, once the site it was opened for loads). tab.pageId is the page
  // in it now; every MCP call goes there.
  pageOf(id) {
    return this.tabs.get(Number(id))?.pageId ?? Number(id);
  }

  ensureTab(pageId) {
    const known = this.byPage.get(pageId);
    if (known != null) return this.tabs.get(known);
    const id = pageId;
    const tab = { id, pageId, windowId: 1, index: this.tabs.size, url: "", title: "", status: "loading", active: false };
    // When this page was first listed: a page seen only after one of the
    // app's tabs went to its current page can be that tab's page, swapped.
    Object.defineProperty(tab, "seenAt", { value: Date.now(), writable: true });
    this.log(`[tabs] + ${id}`);
    this.tabs.set(id, tab);
    this.byPage.set(pageId, id);
    if (this.visible(id)) {
      this.emit("created", { ...tab });
      this.emit("status", this.status());
    }
    return tab;
  }

  // With a profile chosen, the only tabs that exist as far as the extension
  // can tell are the ones the app opened in it. The user's other tabs, in
  // that profile or any other, are never looked into, reported or touched.
  visible(id) {
    return !this.profileScope || this.ours.has(id);
  }

  // A tab the app opened: from now on it is the app's to work in.
  claim(pageId) {
    const tab = this.ensureTab(pageId);
    const id = tab.id;
    if (this.ours.has(id)) return tab;
    const announce = !this.visible(id);
    this.ours.add(id);
    if (announce) {
      this.emit("created", { ...tab });
      this.emit("status", this.status());
    }
    return tab;
  }

  dropTab(id) {
    if (!this.tabs.has(id)) return;
    this.log(`[tabs] - ${id} (${this.tabs.get(id).url})`);
    const wasVisible = this.visible(id);
    this.byPage.delete(this.tabs.get(id).pageId);
    this.tabs.delete(id);
    this.docs.delete(id);
    for (const [reqId, p] of this.pending) {
      if (p.tabId === id) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.reject(new Error(PORT_CLOSED));
      }
    }
    if (this.activeId === id) this.activeId = null;
    if (!wasVisible) return;
    this.emit("removed", id);
    this.emit("status", this.status());
  }

  // One list_pages answer, applied to the tabs.
  syncList(listed) {
    const pages = parsePages(listed);
    const present = new Set(pages.map((p) => p.id));
    const fresh = pages.filter((p) => !this.byPage.has(p.id));

    // A tab of the app's whose page has gone, and a new page on the site that
    // tab was opening: the same tab, its page swapped by Chrome.
    // The old page is usually gone by then, but Chrome can also keep the blank
    // start page alongside the new one: a tab still waiting on about:blank
    // follows the new page either way.
    //
    // Chrome can also list the old page and the new one together for a
    // moment, so the new one was taken for a tab of the person's own by the
    // time the old one goes. A page first seen after the app's tab went to
    // its current page, on the same site, and not the app's, is that new
    // page too — never an older tab of the person's.
    for (const tab of [...this.tabs.values()]) {
      if (!this.ours.has(tab.id)) continue;
      const host = tab.goingTo || hostOf(tab.url);
      if (!host) continue;
      const stillBlank = /^(about:blank)?$/.test(tab.url || "");
      if (present.has(tab.pageId) && !(stillBlank && tab.goingTo)) continue;
      let i = fresh.findIndex((p) => hostOf(p.url) === host);
      let page = null;
      if (i !== -1) {
        [page] = fresh.splice(i, 1);
      } else if (!present.has(tab.pageId)) {
        const since = tab.pageSince ?? tab.seenAt ?? 0;
        const taken = pages.find((p) => {
          const other = this.tabs.get(this.byPage.get(p.id));
          return other && !this.ours.has(other.id) && other.seenAt >= since && hostOf(p.url) === host;
        });
        if (taken) {
          page = taken;
          const otherId = this.byPage.get(taken.id);
          this.tabs.delete(otherId);
          this.docs.delete(otherId);
          this.missing.delete(otherId);
        }
      }
      if (!page) continue;
      this.byPage.delete(tab.pageId);
      tab.pageId = page.id;
      tab.pageSince = Date.now();
      this.byPage.set(page.id, tab.id);
      this.docs.delete(tab.id);
      this.missing.delete(tab.id);
      this.log(`[tabs] ${tab.id} is now page ${page.id} (${page.url.slice(0, 60)})`);
    }
    for (const page of fresh) this.ensureTab(page.id);
    for (const page of pages) {
      const tab = this.tabs.get(this.byPage.get(page.id));
      if (tab) tab.listedUrl = page.url;
    }

    // A page can drop out of one list while Chrome attaches to it (a tab
    // just opened, another profile's window) and be back in the next. It
    // is only gone once it has been missing twice running.
    for (const tab of [...this.tabs.values()]) {
      if (present.has(tab.pageId)) {
        this.missing.delete(tab.id);
        continue;
      }
      const times = (this.missing.get(tab.id) || 0) + 1;
      // A tab the app opened a moment ago can be between pages for longer,
      // as a site settles (Gmail goes through about:blank and an error page).
      const settling = this.ours.has(tab.id) && Date.now() - (tab.pageSince ?? tab.seenAt ?? 0) < PAGE_SETTLE_GRACE_MS;
      if (times >= 2 && !settling) {
        this.missing.delete(tab.id);
        this.dropTab(tab.id);
      } else {
        this.missing.set(tab.id, times);
      }
    }
  }

  startPolling() {    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollOnce().catch(() => {}), POLL_MS);
  }

  async pollOnce(forceList = false) {
    if (!this.client || this.polling) return;
    this.polling = true;
    try {
      if (forceList || ++this.polls % LIST_EVERY === 0) {
        const listed = await this.call("list_pages", {});
        const { ids } = parsePageIds(listed);
        const key = ids.join(",");
        if (key !== this.lastListed) {
          this.lastListed = key;
          this.log(`[tabs] list_pages: ${(listed?.content || []).map((c) => c.text).join(" ").replace(/\s+/g, " ").slice(0, 400)}`);
        }
        this.syncList(listed);
        await this.adoptFromProfile();
      }
      // A browser connected to while in use can have dozens of tabs of the
      // user's own. Those are looked at every few seconds; the ones a run is
      // working in are looked at every time.
      const quietTurn = this.polls % QUIET_EVERY === 0;
      for (const id of [...this.tabs.keys()]) {
        if (!this.visible(id)) continue;
        if (quietTurn || this.isBusy(id)) await this.pollTab(id);
      }
    } finally {
      this.polling = false;
    }
  }

  // Opened by the app, loading, running a content script, owed an answer, or
  // on a job board.
  isBusy(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (this.ours.has(id) || this.docs.has(id) || tab.status !== "complete") return true;
    for (const p of this.pending.values()) if (p.tabId === id) return true;
    return this.autoScripts.some((cs) => matchesAny(tab.url, cs.matches));
  }

  async pollTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    let info;
    try {
      info = await this.evaluate(id, POLL_FUNCTION);
    } catch {
      // Mid-navigation the page cannot run a script: that is a load, not a loss.
      this.applyTabInfo(tab, { status: "loading" });
      return;
    }
    if (!info) return;

    // A tab opened for a site sits on about:blank until the site's page takes
    // over; it is still loading then, as chrome.tabs would say, not finished.
    const onTheWay = tab.goingTo && /^(about:blank)?$/.test(info.url || "");
    const status = info.readyState === "complete" && !onTheWay ? "complete" : "loading";
    this.applyTabInfo(tab, { url: info.url, title: info.title, status });

    if (info.visible && this.activeId !== id) {
      const previous = this.activeId;
      this.activeId = id;
      for (const t of this.tabs.values()) t.active = t.id === id;
      if (previous !== id) this.emit("activated", { tabId: id, windowId: 1 });
    }

    const bridge = info.bridge;
    const lastDoc = this.docs.get(id);
    const docNow = bridge?.docId ?? null;
    if (lastDoc && lastDoc !== docNow) this.failPendingFor(id, lastDoc);
    if (docNow) this.docs.set(id, docNow);
    else this.docs.delete(id);

    if (bridge) {
      for (const [reqId, r] of Object.entries(bridge.results || {})) this.settle(reqId, r);
      for (const message of bridge.outbox || []) {
        this.emit("message", message, { tab: { ...tab }, url: tab.url });
      }
    }

    if (status === "complete") {
      await this.markProfile(tab);
      await this.autoInject(tab, bridge);
    }
  }

  applyTabInfo(tab, info) {
    const changes = {};
    for (const key of ["url", "title", "status"]) {
      if (info[key] !== undefined && info[key] !== tab[key]) {
        tab[key] = info[key];
        changes[key] = info[key];
      }
    }
    if (changes.status || changes.url) this.log(`[tabs] ${tab.id} ${tab.status} ${tab.url.slice(0, 80)}`);
    if (Object.keys(changes).length) this.emit("updated", tab.id, changes, { ...tab });
  }

  async autoInject(tab, bridge) {
    for (const cs of this.autoScripts) {
      if (!matchesAny(tab.url, cs.matches)) continue;
      for (const file of cs.js) {
        if (bridge?.scripts?.[file]) continue;
        await this.injectFile(tab.id, file).catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Job-board tabs the user opened in the chosen profile
  //
  // The MCP server cannot say which profile a tab belongs to, but every
  // profile keeps its own site storage. So each job-board page the app opens
  // in the chosen profile gets a marker in that site's storage naming the
  // profile, and any other tab on that site in the same profile sees the same
  // marker — a tab in another profile never does. A job-board tab the user
  // opened with the marker is in the chosen profile, and the app takes it
  // over, so its job cards are caught as in the extension.
  //
  // Only job-board tabs (the manifest's content-script sites) are ever asked,
  // and only for that one key; every other tab stays unread.
  // -------------------------------------------------------------------------

  isJobBoard(url) {
    return this.autoScripts.some((cs) => matchesAny(url, cs.matches));
  }

  async markProfile(tab) {
    if (!this.profileScope || !this.ours.has(tab.id) || !this.isJobBoard(tab.url)) return;
    const origin = new URL(tab.url).origin;
    if (tab.markedOrigin === origin) return;
    const dir = JSON.stringify(this.profileScope.dir);
    const ok = await this.evaluate(tab.id, `() => { try { localStorage.setItem(${JSON.stringify(PROFILE_MARKER)}, ${dir}); return true; } catch { return false; } }`).catch(() => false);
    if (ok) {
      tab.markedOrigin = origin;
      this.log(`[tabs] ${tab.id} marked as ${this.profileScope.name} on ${origin}`);
    }
  }

  async adoptFromProfile() {
    if (!this.profileScope) return;
    for (const tab of [...this.tabs.values()]) {
      if (this.ours.has(tab.id) || !tab.listedUrl || !this.isJobBoard(tab.listedUrl)) continue;
      // Asked once per page it shows: a tab that moves to another page is asked again.
      if (this.markerChecked.get(tab.id) === tab.listedUrl) continue;
      this.markerChecked.set(tab.id, tab.listedUrl);
      let found;
      try {
        found = await this.evaluate(tab.id, `() => { try { return localStorage.getItem(${JSON.stringify(PROFILE_MARKER)}); } catch { return null; } }`);
      } catch {
        this.markerChecked.delete(tab.id); // mid-load; asked again next time
        continue;
      }
      if (found !== this.profileScope.dir) continue;
      this.claim(tab.pageId);
      this.log(`[tabs] ${tab.id} is the user's own ${this.profileScope.name} tab (${tab.listedUrl.slice(0, 60)}) — taken over`);
    }
  }

  // -------------------------------------------------------------------------
  // chrome.tabs / chrome.scripting, in terms of MCP tools
  // -------------------------------------------------------------------------

  query(info = {}) {
    let list = [...this.tabs.values()].filter((t) => this.visible(t.id));
    if (info.url) list = list.filter((t) => matchesAny(t.url, info.url));
    if (info.active) {
      const active = this.activeId ?? list[list.length - 1]?.id;
      list = list.filter((t) => t.id === active);
    }
    return list.map((t) => ({ ...t }));
  }

  get(id) {
    const tab = this.tabs.get(Number(id));
    if (!tab || !this.visible(tab.id)) throw new Error(`No tab with id: ${id}.`);
    return { ...tab };
  }

  // A file URL the extension built with getURL opens as the file itself.
  async create({ url = "about:blank", active = true } = {}) {
    if (!this.client) await this.call("list_pages", {}); // connects if need be
    if (this.profileScope) return this.createInProfile(url);

    // The first page a launched Chrome opens takes its blank start tab rather
    // than leaving it behind. Chrome can restart itself just after launch,
    // which gives every tab a new id, so the list is read now, not remembered.
    if (this.spareTabId != null) {
      this.spareTabId = null;
      const listed = await this.call("list_pages", {});
      const { ids } = parsePageIds(listed);
      this.syncList(listed);
      const only = ids.length === 1 ? this.ensureTab(ids[0]) : null;
      if (only && /^(about:blank|chrome:\/\/new-tab-page\/?|chrome:\/\/newtab\/?)?$/.test(only.url)) {
        this.claim(only.id);
        if (url !== "about:blank") await this.navigate(only.id, url);
        if (active) await this.update(only.id, { active: true });
        return { ...this.tabs.get(only.id), pendingUrl: url };
      }
    }
    const before = new Set(this.byPage.keys());
    // Opened blank, then sent on its way: new_page waits for the load, and a
    // slow job page would hold up every other page while it did.
    const result = await this.call("new_page", { url: "about:blank", background: !active });
    const { ids, selected } = parsePageIds(result);
    const id = ids.find((i) => !before.has(i)) ?? selected;
    if (id == null) throw new Error("Chrome did not open a new tab");
    const tab = this.claim(id);
    if (url !== "about:blank") await this.navigate(tab.id, url);
    if (active) this.markActive(tab.id);
    return { ...tab, pendingUrl: url };
  }

  // A new tab in the chosen profile. Chrome's debugging protocol cannot say
  // which profile a new tab belongs to, but the browser's own exe can: run
  // with --profile-directory and a URL, it hands the URL to the browser
  // already running, which opens it in that profile — in a window of its own
  // if the profile had none. The tab is then picked out of the MCP server's
  // page list as the one that was not there before.
  async createInProfile(url) {
    const { name } = this.profileScope;
    const page = await this.openInProfile(this.profileScope, url);
    const tab = this.claim(page.id);
    tab.goingTo = hostOf(url);
    this.applyTabInfo(tab, { url: page.url || url, status: "loading" });
    this.markActive(tab.id);
    this.log(`[tabs] opened ${tab.id} in profile ${name}`);
    return { ...tab, pendingUrl: url };
  }

  // Hands url to the browser's exe for one profile ({ exe, args, name }) and
  // finds the page it opened: the new one on the site asked for, or any new
  // one once a moment has passed (a redirect, or still on about:blank).
  // reuse: a page already open on that site will do — Chrome switches to an
  // open tab of an extension's page rather than opening another.
  async openInProfile({ exe, args, name }, url, { reuse = false } = {}) {
    const listedBefore = parsePages(await this.call("list_pages", {}));
    const before = new Set(listedBefore.map((p) => p.id));
    const wanted = hostOf(url);

    spawn(exe, [...args, url], { detached: true, stdio: "ignore", windowsHide: false }).unref();

    const deadline = Date.now() + PROFILE_TAB_TIMEOUT_MS;
    let firstSeen = null;
    while (Date.now() < deadline) {
      await sleep(300);
      const fresh = parsePages(await this.call("list_pages", {})).filter((p) => !before.has(p.id));
      const match = fresh.find((p) => wanted && hostOf(p.url) === wanted);
      if (fresh.length && firstSeen == null) firstSeen = Date.now();
      const pick = match || (firstSeen && Date.now() - firstSeen > 2500 ? fresh[0] : null);
      if (pick) return pick;
      if (reuse && !fresh.length && Date.now() > deadline - PROFILE_TAB_TIMEOUT_MS + 3000) {
        const open = listedBefore.find((p) => p.url === url) || listedBefore.find((p) => wanted && hostOf(p.url) === wanted);
        if (open) return { ...open, existing: true };
      }
    }
    throw new Error(`the ${name} profile did not open the page — is that browser still running?`);
  }

  // The extension's own settings in one profile: one of its pages is opened
  // there, chrome.storage.local is read from it, and the page is closed. The
  // page is never one of the app's tabs.
  async readExtensionStorage(profile, extensionId, keys) {
    const url = `chrome-extension://${extensionId}/autofill-sample.html`;
    const page = await this.openInProfile(profile, url, { reuse: true });
    const close = () => (page.existing ? null : this.call("close_page", { pageId: page.id }).catch(() => {}));
    if (hostOf(page.url) !== extensionId) {
      await close();
      throw new Error(`the extension did not open in ${profile.name}`);
    }
    try {
      for (let i = 0; i < 20; i++) {
        try {
          const raw = await this.call("evaluate_script", {
            pageId: page.id,
            waitForStableDom: false,
            function: `async () => JSON.stringify(await chrome.storage.local.get(${JSON.stringify(keys)}))`
          });
          const value = parseEvaluate(raw);
          if (typeof value === "string") return JSON.parse(value);
        } catch {
          // still loading
        }
        await sleep(300);
      }
      throw new Error("the extension's page did not answer");
    } finally {
      await close();
    }
  }
  async navigate(id, url) {
    const tab = this.tabs.get(id);
    if (tab) {
      tab.goingTo = hostOf(url) || tab.goingTo;
      this.applyTabInfo(tab, { status: "loading" });
    }
    await this.evaluate(id, `() => { setTimeout(() => { location.href = ${JSON.stringify(url)}; }, 0); return true; }`);
  }

  markActive(id) {
    this.activeId = id;
    for (const t of this.tabs.values()) t.active = t.id === id;
  }

  async update(id, props = {}) {
    id = Number(id);
    if (!this.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
    if (props.url) await this.navigate(id, props.url);
    if (props.active) {
      await this.call("select_page", { pageId: this.pageOf(id), bringToFront: true }).catch(() => {});
      this.markActive(id);
    }
    return { ...this.tabs.get(id) };
  }

  async remove(ids) {
    for (const id of [].concat(ids).map(Number)) {
      try {
        await this.call("close_page", { pageId: this.pageOf(id) });
      } catch (err) {
        // Chrome cannot close its last page: send it somewhere blank instead.
        if (this.tabs.size <= 1) await this.navigate(id, "about:blank").catch(() => {});
        else throw err;
      }
      this.dropTab(id);
    }
  }

  async injectFile(tabId, file) {
    const source = fs.readFileSync(path.join(this.extensionDir, file), "utf8");
    // Content scripts carry the bridge; a plain page script (autofill.js) runs as it is.
    const isContent = this.autoScripts.some((cs) => cs.js.includes(file)) || /^content.*\.js$/.test(file);
    const code = isContent ? wrapContentScript(file, source) : source;
    await this.evaluate(Number(tabId), code, { format: "script" });
  }

  // chrome.scripting.executeScript: files run in order, or one function with
  // JSON args. The answer is shaped as Chrome's: [{ result }].
  async executeScript({ target, files, func, args = [] }) {
    const tabId = Number(target?.tabId);
    if (!this.tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
    if (files?.length) {
      for (const file of files) await this.injectFile(tabId, file);
      return [{ result: undefined }];
    }
    const source = typeof func === "function" ? func.toString() : String(func);
    const result = await this.evaluate(tabId, `async () => (${source})(...${JSON.stringify(args)})`);
    return [{ result }];
  }

  // chrome.tabs.sendMessage: the page's listeners answer through the bridge;
  // a page without one — no content script yet — has no receiving end.
  async sendMessage(tabId, message) {
    tabId = Number(tabId);
    if (!this.tabs.has(tabId)) throw new Error(NO_RECEIVER);
    const reqId = `r${++this.reqSeq}`;
    let reply;
    try {
      reply = await this.evaluate(tabId, dispatchFunction(reqId, message));
    } catch {
      throw new Error(NO_RECEIVER);
    }
    if (!reply || reply.state === "none") throw new Error(NO_RECEIVER);
    if (reply.state === "done") return unwrap(reply.result);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(PORT_CLOSED));
      }, ANSWER_TIMEOUT_MS);
      this.pending.set(reqId, { tabId, docId: this.docs.get(tabId), resolve, reject, timer });
    });
  }

  settle(reqId, result) {
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    try {
      p.resolve(unwrap(result));
    } catch (err) {
      p.reject(err);
    }
  }

  failPendingFor(tabId, docId) {
    for (const [reqId, p] of this.pending) {
      if (p.tabId === tabId && (!p.docId || p.docId === docId)) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.reject(new Error(PORT_CLOSED));
      }
    }
  }

  fileUrl(file) {
    return pathToFileURL(path.join(this.extensionDir, file)).href;
  }
}

function unwrap(result) {
  if (!result) return undefined;
  if (result.ok) return result.value === null ? undefined : result.value;
  throw new Error(result.error || "the page's listener failed");
}

module.exports = { McpBrowser, patternToRegex, matchesAny, BRIDGE_SOURCE };
