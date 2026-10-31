// The `chrome` the extension's background.js runs against in the app.
//
// background.js is the extension's service worker, loaded unchanged into
// Electron's main process. Everything it asks of the browser goes through the
// MCP browser (mcp-browser.js); storage is a JSON file in the app's data
// folder; runtime messages go to and from the app window, which runs the
// extension's own side panel page.
//
// Only what background.js and sidepanel.js actually call is here.

const fs = require("node:fs");
const path = require("node:path");

const EXT_ORIGIN = "app://ext/";

function eventSource() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    emit: (...args) => {
      for (const fn of [...listeners]) {
        try {
          fn(...args);
        } catch (err) {
          console.error("[chrome event]", err);
        }
      }
    }
  };
}

// chrome.runtime.onMessage semantics: a listener answers with sendResponse,
// and returning true means it will answer later. The first answer wins; with
// nobody answering, the sender gets undefined.
function dispatchMessage(listeners, message, sender) {
  return new Promise((resolve) => {
    let answered = false;
    let pending = false;
    const sendResponse = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    for (const fn of [...listeners]) {
      try {
        if (fn(message, sender, sendResponse) === true) pending = true;
      } catch (err) {
        console.error("[onMessage]", err);
      }
    }
    if (!answered && !pending) resolve(undefined);
  });
}

// chrome.storage.local, kept in one JSON file. Writes are coalesced so a
// burst of set() calls is one write.
function fileStorage(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = {};
  }
  let timer = null;
  const flush = () => {
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 150);
  };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  return {
    async get(keys) {
      if (keys == null) return clone(data);
      if (typeof keys === "string") return keys in data ? { [keys]: clone(data[keys]) } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([k, fallback]) => [k, k in data ? clone(data[k]) : fallback])
      );
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) data[k] = clone(v);
      schedule();
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
      schedule();
    },
    async clear() {
      data = {};
      schedule();
    },
    flushNow: () => {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    }
  };
}

// Builds the chrome object. `toPanel(message)` delivers a message to the app
// window and resolves false when there is no window to take it.
function createChromeApi({ browser, extensionDir, storageFile, toPanel, onBadge = () => {} }) {
  const backgroundListeners = new Set();
  const storage = fileStorage(storageFile);

  const tabsEvents = {
    onCreated: eventSource(),
    onUpdated: eventSource(),
    onRemoved: eventSource(),
    onActivated: eventSource()
  };
  browser.on("created", (tab) => tabsEvents.onCreated.emit(tab));
  browser.on("updated", (id, changes, tab) => tabsEvents.onUpdated.emit(id, changes, tab));
  browser.on("removed", (id) => tabsEvents.onRemoved.emit(id, { windowId: 1, isWindowClosing: false }));
  browser.on("activated", (info) => tabsEvents.onActivated.emit(info));

  // What the page's content scripts send reaches the background — and, as in
  // Chrome, the panel too (it listens for the feed's own status).
  browser.on("message", (message, sender) => {
    dispatchMessage(backgroundListeners, message, sender);
    toPanel(message, sender);
  });

  // An extension URL opened in Chrome is the file itself.
  const toBrowserUrl = (url) =>
    typeof url === "string" && url.startsWith(EXT_ORIGIN) ? browser.fileUrl(url.slice(EXT_ORIGIN.length)) : url;

  const chrome = {
    runtime: {
      id: "bidbot-desktop",
      getURL: (p) => EXT_ORIGIN + String(p).replace(/^\//, ""),
      getPlatformInfo: async () => ({ os: "win", arch: "x86-64", nacl_arch: "x86-64" }),
      getManifest: () => JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8")),
      onMessage: {
        addListener: (fn) => backgroundListeners.add(fn),
        removeListener: (fn) => backgroundListeners.delete(fn),
        hasListener: (fn) => backgroundListeners.has(fn)
      },
      // From the background the only other context is the panel.
      sendMessage: async (message) => {
        const delivered = await toPanel(message, { id: "bidbot-desktop" });
        if (delivered === false) throw new Error("Could not establish connection. Receiving end does not exist.");
        return undefined;
      },
      onInstalled: eventSource(),
      onStartup: eventSource()
    },

    tabs: {
      query: async (info) => browser.query(info),
      get: async (id) => browser.get(id),
      create: async (props = {}) => browser.create({ ...props, url: toBrowserUrl(props.url) }),
      update: async (id, props = {}) => browser.update(id, { ...props, url: toBrowserUrl(props.url) }),
      remove: async (ids) => browser.remove(ids),
      sendMessage: async (id, message) => browser.sendMessage(id, message),
      ...tabsEvents
    },

    scripting: {
      executeScript: async (details) => browser.executeScript(details)
    },

    windows: {
      // Bringing Chrome forward is done per tab, by select_page.
      update: async (id) => ({ id, focused: true })
    },

    storage: { local: storage },

    action: {
      setBadgeText: async ({ text }) => onBadge(text),
      setBadgeBackgroundColor: async () => {}
    },

    sidePanel: { setPanelBehavior: async () => {} },

    // The app may touch every site it opens; there is nothing to grant.
    permissions: {
      request: async () => true,
      contains: async () => true
    }
  };

  return {
    chrome,
    storage,
    // A message from the panel, answered by background.js's listeners.
    fromPanel: (message) => dispatchMessage(backgroundListeners, message, { id: "bidbot-desktop", url: `${EXT_ORIGIN}sidepanel.html` }),
    toBrowserUrl
  };
}

// fetch() for app://ext/ — background.js reads its resume templates with
// fetch(chrome.runtime.getURL(file)).
function installExtensionFetch(extensionDir) {
  extensionDir = path.resolve(extensionDir);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (typeof url === "string" && url.startsWith(EXT_ORIGIN)) {
      const rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
      const file = path.resolve(extensionDir, rel);
      if (!file.startsWith(extensionDir + path.sep) || !fs.existsSync(file)) {
        return new Response("not found", { status: 404, statusText: "Not Found" });
      }
      return new Response(fs.readFileSync(file), { status: 200 });
    }
    return realFetch(input, init);
  };
}

module.exports = { createChromeApi, installExtensionFetch, dispatchMessage, EXT_ORIGIN };
