// Bid Bot for Windows.
//
// One always-on-top, resizable window running the extension's own side panel
// page. The extension's background.js runs here in the main process, and
// every browser action it takes goes to Google Chrome through the Chrome
// DevTools MCP server. The bar along the top of the window picks which
// Chrome to drive and connects to it; Start in the panel then works as it
// does in the extension.

const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, protocol, net, shell } = require("electron");
const { findChromes } = require("./chrome-finder");
const { findRunningBrowsers, openDebugSetting, profileArgs } = require("./running-browsers");
const { importFromExtension: importExt } = require("./extension-import");
const { startEngine } = require("./engine");
const { EXT_ORIGIN } = require("./chrome-api");

// The extension sits beside this app in the repo; a packaged build carries a
// copy under resources/extension.
const EXTENSION_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "extension")
  : path.resolve(__dirname, "..", "..", "jobright-monitor");

const DATA_DIR = app.getPath("userData");
const SETTINGS_FILE = path.join(DATA_DIR, "app-settings.json");
const LOG_FILE = path.join(DATA_DIR, "app.log");

// Everything the main process prints — background.js logs every OpenAI
// request, the MCP server its own messages — goes to a file, never to stdout.
// A window app launched from a pipe nobody reads any more would otherwise
// block on its first console.log and freeze.
function installFileLog() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // One run's worth: the previous run's log is kept as app.old.log.
  try {
    fs.renameSync(LOG_FILE, path.join(DATA_DIR, "app.old.log"));
  } catch {}
  const out = fs.createWriteStream(LOG_FILE, { flags: "a" });
  const { format } = require("node:util");
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => out.write(`${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`);
  }
}
const CUSTOM_ID = "custom";

// Only one copy: a second launch brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
installFileLog();

// The panel page is served from app://ext/, a real origin, rather than file://.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

// ---------------------------------------------------------------------------
// App settings: which browser, always on top, where the window was
// ---------------------------------------------------------------------------

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

let settings = { alwaysOnTop: true, ...readSettings() };

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// The browser picker offers two kinds of choice:
//
//   Running now — every browser open on this PC, named by its open profiles,
//     connected to as it is. Possible once its remote debugging is on.
//   Start a new browser — a Chrome the app launches itself, on a profile of
//     its own kept between runs (Chrome does not let a launched-for-debugging
//     browser use the profile you use every day), or a chrome.exe picked by
//     hand.

let running = []; // the last scan of running browsers
let installed = findChromes(); // the Chromes on this PC, refreshed with every scan
let scanning = null;

// One look at the PC: what is running, and what is installed — a running
// chrome.exe counts as installed wherever it was started from.
function scanRunning() {
  if (!scanning) {
    scanning = findRunningBrowsers({ ownDataDir: path.join(DATA_DIR, "chrome-profiles") })
      .then((list) => {
        running = list;
        installed = findChromes(list.map((r) => r.exe).filter((exe) => /chrome\.exe$/i.test(exe)));
        return list;
      })
      .catch(() => running)
      .finally(() => (scanning = null));
  }
  return scanning;
}

// The one profile picked to work in, per running browser — kept while that
// profile still exists in it.
function chosenProfile(r) {
  const dir = settings.profiles?.[r.id];
  return r.profiles.find((p) => p.dir === dir) || null;
}

function runningChoice(r) {
  const open = r.openProfiles;
  const who = r.ownedByApp ? "Bid Bot's profile" : open.length ? open.join(", ") : "no window open";
  return {
    id: r.id,
    group: "running",
    label: `${r.browser}${r.folder && !r.ownedByApp ? ` (${r.folder})` : ""} · ${who}${r.debug ? "" : " · debugging off"}`,
    detail: `${r.userDataDir}\nProfiles: ${r.profiles.map((p) => `${p.name}${p.open ? " (open)" : ""}`).join(", ")}`,
    mode: "attach",
    browser: r.browser,
    profiles: r.profiles,
    openProfiles: open,
    debug: r.debug,
    profile: chosenProfile(r),
    running: r
  };
}

function browserChoices() {
  // A Chrome installed for this Windows user only is offered only when there
  // is no Chrome installed for the whole computer: it is usually an old copy
  // left behind beside the one actually kept up to date.
  const forEveryone = installed.filter((c) => !/:user\b/.test(c.id));
  const offered = forEveryone.length ? forEveryone : installed;
  const starts = offered.map((c) => ({
    id: c.id,
    group: "start",
    label: `${c.label}${c.version ? ` ${c.version.split(".")[0]}` : ""} — new window, Bid Bot's profile`,
    detail: c.exe,
    mode: "launch",
    exe: c.exe
  }));
  if (settings.customExe) {
    starts.push({ id: CUSTOM_ID, group: "start", label: `Custom: ${path.basename(path.dirname(path.dirname(settings.customExe)))}`, detail: settings.customExe, mode: "launch", exe: settings.customExe });
  }
  return [...running.map(runningChoice), ...starts];
}

// The choice still offered under the saved id; a running browser that has
// since closed falls back to starting a new Chrome.
function currentChoice() {
  const choices = browserChoices();
  return (
    choices.find((c) => c.id === settings.browserId) ||
    choices.find((c) => c.mode === "launch") ||
    choices[0]
  );
}

class DebugOffError extends Error {}
class NoProfileError extends Error {}

function connectOptions(choice) {
  if (choice.mode === "attach") {
    if (!choice.debug) {
      throw new DebugOffError(`remote debugging is off in ${choice.browser} — click "Turn on debugging"`);
    }
    // One profile, picked by name: every tab the app opens goes into it, and
    // it works with no other tab.
    if (!choice.profile) {
      throw new NoProfileError(`pick the ${choice.browser} profile to work in`);
    }
    return {
      mode: "attach",
      wsEndpoint: choice.debug.wsEndpoint,
      label: `${choice.browser} · ${choice.profile.name}`,
      profile: {
        dir: choice.profile.dir,
        name: choice.profile.name,
        exe: choice.running.exe,
        args: profileArgs(choice.running, choice.profile.dir)
      }
    };
  }
  const profileName = choice.id.replace(/[^a-z0-9-]+/gi, "-");
  return {
    mode: "launch",
    exe: choice.exe,
    userDataDir: path.join(DATA_DIR, "chrome-profiles", profileName),
    label: choice.label
  };
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

let win = null;
let engine = null;

function createWindow() {
  const bounds = settings.bounds || {};
  win = new BrowserWindow({
    width: bounds.width || 440,
    height: bounds.height || 860,
    x: bounds.x,
    y: bounds.y,
    minWidth: 340,
    minHeight: 420,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop !== false,
    title: "Valiant Sisu Bid Bot",
    icon: path.join(__dirname, "..", "assets", "logo.png"),
    // No Windows title bar: the panel draws its own, with the logo and the
    // minimize, maximize and close buttons (see preload.js).
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#f6f6fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // The page is the extension's own panel; the preload gives it a chrome
      // object on its window, which context isolation would hide from it.
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false
    }
  });
  // The window keeps the app's own title; the panel page's <title> would
  // otherwise replace it.
  win.on("page-title-updated", (e) => e.preventDefault());
  // Above ordinary windows, but below the screen saver and system dialogs.
  if (settings.alwaysOnTop !== false) win.setAlwaysOnTop(true, "floating");

  const remember = () => {
    if (!win || win.isMinimized() || win.isMaximized()) return;
    saveSettings({ bounds: win.getBounds() });
  };
  win.on("resized", remember);
  win.on("moved", remember);
  win.on("close", remember);
  // The title bar's maximize button shows restore while maximized.
  const sendMaximized = () => win?.webContents.send("win:maximized", win.isMaximized());
  win.on("maximize", sendMaximized);
  win.on("unmaximize", sendMaximized);

  // Links in the panel open in the user's default browser, not in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(`${EXT_ORIGIN}sidepanel.html`);
  win.on("closed", () => (win = null));
}

const sendToWindow = (channel, ...args) => {
  if (!win || win.isDestroyed()) return false;
  win.webContents.send(channel, ...args);
  return true;
};

function pushStatus() {
  sendToWindow("app:status", { ...engine.browser.status(), note: importNote, choice: currentChoice().id, alwaysOnTop: settings.alwaysOnTop !== false });
}

let importNote = null; // what was copied from the extension on connecting

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  // app://ext/<path> is a file of the extension folder, and nothing outside it.
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const file = path.resolve(EXTENSION_DIR, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (url.host !== "ext" || !file.startsWith(path.resolve(EXTENSION_DIR) + path.sep)) {
      return new Response("not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(file).href);
  });

  engine = await startEngine({
    extensionDir: EXTENSION_DIR,
    dataDir: DATA_DIR,
    log: (line) => console.log(line),
    toPanel: async (message, sender) => sendToWindow("rt:message", message, sender),
    onBadge: (text) => win?.setTitle(text ? `Valiant Sisu Bid Bot · ${text} jobs` : "Valiant Sisu Bid Bot"),
    // A Start pressed before Connect uses the browser picked in the bar.
    ensureConnected: () => connectChosen()
  });

  // A running browser is looked at again just before it is connected to: its
  // debugging address changes every time it restarts.
  async function connectChosen() {
    if (currentChoice().mode === "attach") await scanRunning();
    const choice = currentChoice();
    await syncLinkedProfile();
    const status = await engine.browser.connect(connectOptions(choice));
    if (choice.mode === "attach") await importFromExtension(choice).catch((err) => console.warn("[import]", err?.message || err));
    return status;
  }

  // The bid profile linked to the browser profile being worked in, told to
  // the extension's code, which then uses it alone for the whole run.
  // settings.profileLinks: "<browser id>\u0001<profile folder>" -> bid profile id.
  async function syncLinkedProfile() {
    const c = currentChoice();
    const key = c?.mode === "attach" && c.profile ? `${c.id}\u0001${c.profile.dir}` : null;
    await api.chrome.storage.local.set({ linkedBidProfile: (key && settings.profileLinks?.[key]) ?? null });
  }

  // What the app needs before a run can write anything. With these in its
  // own settings it works from what was picked in it, and Connect opens no tab.
  const ESSENTIALS = ["apiKey", "country", "role"];
  async function hasEssentials() {
    const { profile = {} } = await api.chrome.storage.local.get("profile");
    return ESSENTIALS.every((k) => String(profile[k] ?? "").trim());
  }

  // Fills in the settings the app is missing from the extension in that
  // browser (see extension-import.js), then has the panel read them again.
  // Reading them means opening one of the extension's pages in the profile,
  // so it is done once per profile, and only while the app still lacks the
  // essentials: after that the app keeps what was picked in it.
  async function importFromExtension(choice) {
    const key = `${choice.id}|${choice.profile?.dir || ""}`;
    if (settings.imported?.[key] || (await hasEssentials())) return;
    saveSettings({ imported: { ...(settings.imported || {}), [key]: new Date().toISOString() } });
    const done = await importExt({
      storage: api.chrome.storage.local,
      browser: engine.browser,
      running: choice.running,
      profile: choice.profile
    });
    if (!done) return;
    importNote = done.note;
    console.log(`[import] from ${done.from}: ${done.filled.join(", ")}`);
    win?.webContents.reload();
  }

  const pushChoices = () => sendToWindow("app:choices", { choices: browserChoices(), choice: currentChoice().id });

  // Coming back to the window — typically from the browser, having opened or
  // closed a profile, or switched debugging on — finds what is running now.
  const rescan = () => scanRunning().then(pushChoices);

  // After "Turn on debugging": watched until that browser's debugging is on,
  // then connected to without another click.
  let debugWatch = null;
  function watchForDebugging(id) {
    clearInterval(debugWatch);
    const until = Date.now() + 3 * 60 * 1000;
    debugWatch = setInterval(async () => {
      if (Date.now() > until || engine.browser.state !== "disconnected" || settings.browserId !== id) {
        clearInterval(debugWatch);
        return;
      }
      await scanRunning();
      pushChoices();
      if (currentChoice().id === id && currentChoice().debug) {
        clearInterval(debugWatch);
        connectChosen().catch((err) => sendToWindow("app:status", { ...engine.browser.status(), error: err?.message || String(err) }));
      }
    }, 2000);
  }

  const { browser, api } = engine;
  browser.on("status", pushStatus);
  browser.on("updated", (id, changes, tab) => sendToWindow("tabs:updated", id, changes, tab));
  browser.on("activated", (info) => sendToWindow("tabs:activated", info));

  // --- the panel's chrome.runtime / chrome.tabs / chrome.scripting ---------
  ipcMain.handle("rt:send", (_e, message) => api.fromPanel(message));
  ipcMain.handle("tabs:query", (_e, info) => api.chrome.tabs.query(info));
  ipcMain.handle("tabs:create", (_e, props) => api.chrome.tabs.create(props));
  ipcMain.handle("scripting:exec", (_e, details) => api.chrome.scripting.executeScript(details));

  // --- the browser bar ------------------------------------------------------
  ipcMain.handle("app:state", async () => {
    await scanRunning();
    await syncLinkedProfile();
    return {
      note: importNote,
      choices: browserChoices(),
      choice: currentChoice().id,
      alwaysOnTop: settings.alwaysOnTop !== false,
      ...browser.status()
    };
  });

  // The browser, as the panel's checks before a run see it: connected, or
  // able to connect when the run starts — or what is in the way.
  ipcMain.handle("app:checkBrowser", async () => {
    const label = "Browser";
    const s = browser.status();
    if (s.state === "connected") {
      return { key: "browser", label, state: "ok", detail: `connected to ${s.browser} through the Chrome DevTools MCP server` };
    }
    if (s.state === "connecting") return { key: "browser", label, state: "ok", detail: "connecting…" };
    if (currentChoice().mode === "attach") await scanRunning();
    const c = currentChoice();
    if (!c) return { key: "browser", label, state: "fail", detail: "no Google Chrome found — install it, or pick chrome.exe in the bar" };
    if (c.mode === "attach") {
      if (!c.debug) return { key: "browser", label, state: "fail", detail: `${c.browser}: remote debugging is off — click “Turn on debugging” in the bar` };
      if (!c.profile) return { key: "browser", label, state: "fail", detail: `${c.browser}: pick the profile to work in, in the bar` };
      return { key: "browser", label, state: "ok", detail: `connects to ${c.browser} · ${c.profile.name} when the run starts` };
    }
    return { key: "browser", label, state: "ok", detail: `starts ${c.label.replace(/ — .*$/, "")} when the run starts` };
  });
  ipcMain.handle("app:scan", async () => {
    await scanRunning();
    return { choices: browserChoices(), choice: currentChoice().id };
  });

  ipcMain.handle("app:enableDebug", async () => {
    await scanRunning();
    const choice = currentChoice();
    if (choice.mode !== "attach") return { ok: false, error: "pick a running browser first" };
    if (choice.debug) return { ok: true, already: true };
    openDebugSetting(choice.running, choice.profile?.dir);
    watchForDebugging(choice.id);
    return { ok: true, browser: choice.browser };
  });

  ipcMain.handle("app:links", () => settings.profileLinks || {});
  ipcMain.handle("app:saveLinks", async (_e, links) => {
    saveSettings({ profileLinks: links || {} });
    await syncLinkedProfile();
    return settings.profileLinks;
  });

  ipcMain.handle("app:choose", async (_e, id) => {
    saveSettings({ browserId: id });
    await syncLinkedProfile();
    pushStatus();
    return currentChoice();
  });

  // One profile of a running browser — the only one the app will work in.
  // Not while connected: the run's tabs are already in the one picked.
  ipcMain.handle("app:chooseProfile", async (_e, id, dir) => {
    if (browser.state !== "disconnected") return { ok: false, error: "disconnect first to work in another profile" };
    saveSettings({ browserId: id, profiles: { ...(settings.profiles || {}), [id]: dir } });
    await syncLinkedProfile();
    return { ok: true, choices: browserChoices(), choice: currentChoice().id };
  });

  ipcMain.handle("app:connect", async () => {
    try {
      await connectChosen();
      return { ok: true, ...browser.status() };
    } catch (err) {
      return { ok: false, debugOff: err instanceof DebugOffError, noProfile: err instanceof NoProfileError, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("app:disconnect", async () => {
    clearInterval(debugWatch); // Stop, while waiting for debugging to be turned on
    // Whatever a run had in flight stops first, so it does not reconnect.
    await api.fromPanel({ type: "STOP" }).catch(() => {});
    await browser.disconnect();
    return browser.status();
  });

  // The panel's own title bar buttons.
  ipcMain.handle("win:minimize", () => win?.minimize());
  ipcMain.handle("win:toggleMaximize", () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("win:close", () => win?.close());
  ipcMain.handle("win:isMaximized", () => !!win?.isMaximized());

  ipcMain.handle("app:onTop", (_e, on) => {
    saveSettings({ alwaysOnTop: !!on });
    win?.setAlwaysOnTop(!!on, "floating");
    pushStatus();
    return !!on;
  });

  createWindow();
  win.on("focus", rescan);
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  engine?.api.storage.flushNow();
  engine?.browser.disconnect().catch(() => {});
});
