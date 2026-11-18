// Bid Bot for Windows.
//
// One always-on-top, resizable window, shown from a tray icon, running the extension's own side panel
// page. The extension's background.js runs here in the main process, and
// every browser action it takes goes to Google Chrome through the Chrome
// DevTools MCP server. The bar along the top of the window picks which
// Chrome to drive and connects to it; Start in the panel then works as it
// does in the extension.

const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const { app, BrowserWindow, ipcMain, protocol, net, shell, safeStorage, screen, Tray, Menu, nativeImage } = require("electron");
const { findChromes } = require("./chrome-finder");
const { findRunningBrowsers, openDebugSetting, profileArgs } = require("./running-browsers");
const { importFromExtension: importExt } = require("./extension-import");
const { startEngine } = require("./engine");
const { listOctoProfiles, listFolderProfiles, listAllFolders } = require("./octo-profiles");
const { EXT_ORIGIN } = require("./chrome-api");
const { pinToAllVirtualDesktops } = require("./virtual-desktop");

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
    scanning = Promise.all([findRunningBrowsers({ ownDataDir: path.join(DATA_DIR, "chrome-profiles") }), listOctoProfiles()])
      .then(([list, octo]) => {
        running = list;
        octoProfiles = octo;
        installed = findChromes(list.map((r) => r.exe).filter((exe) => /chrome\.exe$/i.test(exe)));
        return list;
      })
      .catch(() => running)
      .finally(() => (scanning = null));
  }
  return scanning;
}

let octoProfiles = []; // running now
let octoReady = null; // the profiles in the folders named; null: none are named

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

// The Octo API token is kept encrypted on disk. The panel shows it in a
// password field, as it does the GPT key.
function octoToken() {
  try {
    return settings.octoToken ? safeStorage.decryptString(Buffer.from(settings.octoToken, "base64")) : "";
  } catch {
    return "";
  }
}

// Reads Octo's list again, for the folders named in the panel — and, while
// a token is set, the full list of folders Octo actually has, so the panel
// can offer them to pick from rather than have their names typed by hand.
async function refreshOctoFolders() {
  const token = octoToken();
  const folders = String(settings.octoFolders || "").split(",").map((f) => f.trim()).filter(Boolean);
  const state = { ok: true, token, folders: settings.octoFolders || "", count: null, missing: [], allFolders: [] };
  if (!token) {
    octoReady = null;
    return state;
  }
  state.allFolders = await listAllFolders({ token }).catch(() => []);
  if (!folders.length) {
    octoReady = null;
    return state;
  }
  try {
    const { profiles, missing } = await listFolderProfiles({ token, folders });
    octoReady = profiles;
    return { ...state, count: profiles.length, missing };
  } catch (err) {
    return { ...state, ok: false, error: err.message };
  }
}

// An Octo Browser profile. The app connects only to one already open, with its
// remote debugging on (see octo-profiles.js); one in the folders named but not
// running is listed, to be started in Octo Browser.
function octoChoice({ uuid, name, wsEndpoint, closed = false }) {
  const profile = { dir: uuid, name, open: true };
  return {
    id: `octo:${uuid}`,
    group: "running",
    label: `Octo Browser · ${name}`,
    detail: uuid,
    mode: "attach",
    octo: true,
    closed,
    browser: "Octo Browser",
    profiles: [profile],
    openProfiles: [name],
    debug: wsEndpoint ? { wsEndpoint } : null,
    profile
  };
}

function octoChoices() {
  if (octoReady) {
    return octoReady.map((p) => {
      const running = octoProfiles.find((r) => r.uuid === p.uuid);
      return octoChoice(running ? { ...running, name: p.name } : { ...p, closed: true });
    });
  }
  return octoProfiles.map(octoChoice);
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
  return [...running.map(runningChoice), ...octoChoices(), ...starts];
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
  if (choice.octo) {
    if (!choice.debug) throw new DebugOffError(`${choice.profile.name} has no debug port`);
    return {
      mode: "attach",
      wsEndpoint: choice.debug.wsEndpoint,
      label: choice.label,
      profile: { dir: choice.profile.dir, name: choice.profile.name, catchOnly: true }
    };
  }
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
    // Hidden at start: the bot lives in the tray and slides out of its icon
    // (see the tray section below), so it has no taskbar button of its own.
    show: false,
    skipTaskbar: true,
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

  // Kept on every virtual desktop (Windows' "Task View"), not only the one
  // it opened on — alwaysOnTop alone only keeps it above other windows on
  // whichever desktop it is on. Tried once the window has actually painted
  // (the shell has no view to pin before then), and again whenever it comes
  // back from being minimized, since Windows has been seen to drop a pin
  // across that. See virtual-desktop.js for what this does and why it can
  // fail: the pin is best-effort, so a failure here only means the window
  // behaves as it always has (pinned to the desktop it opened on) — logged,
  // not surfaced to the person using the app.
  const pinAcrossDesktops = () => {
    if (!win) return;
    pinToAllVirtualDesktops(win).catch((err) => console.error(`[virtual-desktop] could not pin across desktops: ${err.message}`));
  };
  win.once("ready-to-show", pinAcrossDesktops);
  win.on("restore", pinAcrossDesktops);

  // Only the size is remembered: the position always comes from the tray icon.
  const remember = () => {
    if (!win || win.isMinimized() || win.isMaximized() || animating) return;
    const { width, height } = win.getBounds();
    saveSettings({ bounds: { width, height } });
  };
  win.on("resized", remember);
  // Closing (title bar ×, Alt+F4) folds the bot back into the tray; only
  // Quit in the tray menu ends the app.
  win.on("close", (e) => {
    remember();
    if (quitting) return;
    e.preventDefault();
    collapseToTray();
  });
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

// ---------------------------------------------------------------------------
// The tray icon: the window expands out of it and collapses back into it
// ---------------------------------------------------------------------------

let tray = null;
let quitting = false;
let animating = false;
let animTimer = null;
let shown = false;
const ANIM_MS = 220;

// Where the window sits when shown, and the direction it travels from the
// icon: away from the taskbar, whichever screen edge that is on.
function anchorFor(size) {
  const iconB = tray?.getBounds() || { x: 0, y: 0, width: 0, height: 0 };
  const iconKnown = iconB.width > 0 && iconB.height > 0;
  const point = iconKnown ? { x: iconB.x + iconB.width / 2, y: iconB.y + iconB.height / 2 } : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea, db = display.bounds;
  let edge = "bottom";
  if (wa.y > db.y) edge = "top";
  else if (wa.x > db.x) edge = "left";
  else if (wa.x + wa.width < db.x + db.width) edge = "right";
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const { width: w, height: h } = size;
  let x, y, dx = 0, dy = 0;
  if (edge === "bottom" || edge === "top") {
    x = clamp(Math.round(point.x - w / 2), wa.x, wa.x + wa.width - w);
    y = edge === "bottom" ? wa.y + wa.height - h : wa.y;
    dy = edge === "bottom" ? h : -h;
  } else {
    y = clamp(Math.round(point.y - h / 2), wa.y, wa.y + wa.height - h);
    x = edge === "right" ? wa.x + wa.width - w : wa.x;
    dx = edge === "right" ? w : -w;
  }
  // The trip out is the window's own height (its width for a side taskbar,
  // which is the extent it travels along).
  return { x, y, dx, dy };
}

const ease = (t) => 1 - Math.pow(1 - t, 3);

function animate(from, to, opFrom, opTo, done) {
  clearInterval(animTimer);
  animating = true;
  const t0 = Date.now();
  const step = () => {
    if (!win || win.isDestroyed()) { clearInterval(animTimer); animating = false; return; }
    const t = Math.min(1, (Date.now() - t0) / ANIM_MS), k = ease(t);
    win.setBounds({ x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k), width: to.width, height: to.height });
    win.setOpacity(opFrom + (opTo - opFrom) * k);
    if (t >= 1) { clearInterval(animTimer); animating = false; done?.(); }
  };
  animTimer = setInterval(step, 10);
  step();
}

function expandFromTray() {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  const { width, height } = win.getBounds();
  const a = anchorFor({ width, height });
  const end = { x: a.x, y: a.y, width, height };
  const start = { x: a.x + a.dx, y: a.y + a.dy, width, height };
  shown = true;
  hideNotice();
  win.setOpacity(0);
  win.setBounds(start);
  win.show();
  win.focus();
  animate(start, end, 0, 1);
}

function collapseToTray() {
  if (!win || !shown) return;
  shown = false;
  const b = win.getBounds();
  const a = anchorFor(b);
  animate(b, { x: b.x + a.dx, y: b.y + a.dy, width: b.width, height: b.height }, win.getOpacity(), 0, () => {
    if (win && !shown) { win.hide(); win.setOpacity(1); }
  });
}

// Clicking anywhere outside the window folds it back into the tray. Clicking
// the tray icon itself also takes focus from the window first, so a fold that
// just happened from that is the icon's click, not a reason to open again.
let lastBlurFold = 0;
function foldOnBlur() {
  if (!shown || animating) return;
  lastBlurFold = Date.now();
  collapseToTray();
}

const toggleFromTray = () => {
  if (shown) return collapseToTray();
  if (Date.now() - lastBlurFold < 400) return;
  expandFromTray();
};

// Windows gives every tray icon the same small slot, so the logo is cropped
// to the lion's face to fill as much of the
// slot as it can, and handed over at 32px so high-DPI screens get it sharp.
function trayImage() {
  const logo = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "logo.png"));
  const { width, height } = logo.getSize();
  // Zoomed in on the lion's face (a 170px square of the 256px logo; the horn
  // tip and outer mane fall outside) so it reads big in the small slot.
  const s = width / 256;
  const side = Math.round(170 * s);
  const x = Math.max(0, Math.min(Math.round(24 * s), width - side));
  const y = Math.max(0, Math.min(Math.round(58 * s), height - side));
  const small = logo.crop({ x, y, width: side, height: side }).resize({ width: 32, height: 32, quality: "best" });
  // The thin lines wash out at this size: in the logo's own color, with its
  // faint edge pixels made solid so they stand out on the taskbar.
  const px = small.toBitmap(); // BGRA, premultiplied
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a <= 40) continue;
    const na = Math.min(255, Math.round(a * 1.6));
    for (let c = 0; c < 3; c++) px[i + c] = Math.min(na, Math.round((px[i + c] * na) / a));
    px[i + 3] = na;
  }
  return nativeImage.createFromBitmap(px, { width: 32, height: 32 });
}

// ---------------------------------------------------------------------------
// The notification above the tray icon: a small tooltip-style card that says
// an action is done, then fades. Shown only while the bot's window is folded
// away (open, the window says so itself). Clicking it opens the bot.
// ---------------------------------------------------------------------------

let notice = null;
let noticeTimer = null;
const NOTICE_MS = 5000;
const NOTICE_W = 300, NOTICE_H = 86;

const noticeHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font:13px/1.35 "Segoe UI",sans-serif;overflow:hidden;user-select:none;cursor:pointer}
.card{position:absolute;inset:6px 6px 14px 6px;background:#1f2430;color:#fff;border-radius:8px;
  box-shadow:0 4px 14px rgba(0,0,0,.35);padding:9px 12px;box-sizing:border-box;display:flex;gap:10px;align-items:flex-start;
  opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s}
.card.on{opacity:1;transform:none}
.card:after{content:"";position:absolute;bottom:-7px;left:var(--tip,50%);margin-left:-7px;border:7px solid transparent;border-bottom:0;border-top-color:#1f2430}
body.below .card{inset:14px 6px 6px 6px}
body.below .card:after{bottom:auto;top:-7px;border-top:0;border-bottom:7px solid #1f2430;border-left-color:transparent;border-right-color:transparent}
.tick{flex:none;width:18px;height:18px;border-radius:50%;background:#2fb67c;color:#fff;font-size:12px;display:grid;place-items:center;margin-top:1px}
.t{font-weight:600;font-size:12px;opacity:.75;margin-bottom:2px}
.m{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
</style></head><body><div class="card" id="c"><div class="tick">✓</div><div><div class="t">Bid Bot</div><div class="m" id="m"></div></div></div>
<script>
const { ipcRenderer } = require("electron");
ipcRenderer.on("notice", (_e, { text, tip, below }) => {
  document.getElementById("m").textContent = text;
  document.body.classList.toggle("below", !!below);
  document.getElementById("c").style.setProperty("--tip", tip + "px");
  const c = document.getElementById("c"); c.classList.remove("on"); void c.offsetWidth; c.classList.add("on");
});
ipcRenderer.on("notice:hide", () => document.getElementById("c").classList.remove("on"));
document.addEventListener("click", () => ipcRenderer.send("notice:click"));
</script></body></html>`;

function ensureNotice() {
  if (notice && !notice.isDestroyed()) return notice;
  notice = new BrowserWindow({
    width: NOTICE_W, height: NOTICE_H, show: false, frame: false, transparent: true,
    resizable: false, movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
  });
  notice.setAlwaysOnTop(true, "screen-saver");
  notice.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(noticeHtml));
  notice.on("closed", () => (notice = null));
  return notice;
}

ipcMain.on("notice:click", () => {
  hideNotice();
  if (!shown) expandFromTray();
});

function hideNotice() {
  clearTimeout(noticeTimer);
  if (!notice || notice.isDestroyed() || !notice.isVisible()) return;
  notice.webContents.send("notice:hide");
  noticeTimer = setTimeout(() => notice?.hide(), 200);
}

// Places the card just off the tray icon on the taskbar's side, its arrow
// pointing at the icon.
function showNotice(text) {
  if (!text || shown || !tray) return;
  const n = ensureNotice();
  const iconB = tray.getBounds();
  const point = iconB.width ? { x: iconB.x + iconB.width / 2, y: iconB.y + iconB.height / 2 } : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const wa = display.workArea;
  const below = wa.y > display.bounds.y; // taskbar along the top
  const x = Math.max(wa.x, Math.min(Math.round(point.x - NOTICE_W / 2), wa.x + wa.width - NOTICE_W));
  const y = below ? wa.y : wa.y + wa.height - NOTICE_H;
  const tip = Math.max(20, Math.min(Math.round(point.x - x), NOTICE_W - 20));
  const send = () => {
    n.setBounds({ x, y, width: NOTICE_W, height: NOTICE_H });
    n.showInactive();
    n.webContents.send("notice", { text, tip, below });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  };
  if (n.webContents.isLoading()) n.webContents.once("did-finish-load", send);
  else send();
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip("Valiant Sisu Bid Bot");
  keepTrayIconOnTaskbar();
  tray.on("click", toggleFromTray);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show / Hide", click: toggleFromTray },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } }
  ]));
}

// Windows 11 puts a new tray icon in the "^" overflow. Explorer records each
// app's icon under HKCU\Control Panel\NotifyIconSettings, keyed by an id it
// picks, with the exe's path; IsPromoted=1 on that entry is what Settings >
// Personalization > Taskbar > "Other system tray icons" sets to keep the icon
// on the taskbar. This sets it for the app's own entry (Explorer writes the
// entry a moment after the icon first appears, so it looks a few times).
// Explorer reads the flag when it starts; while it is running only that
// Settings switch, or dragging the icon out of "^", moves the icon.
// Best-effort: on failure the icon stays where Windows put it.
function keepTrayIconOnTaskbar(triesLeft = 5) {
  if (process.platform !== "win32") return;
  const exe = process.execPath.replace(/'/g, "''");
  const ps = [
    "$n=0",
    "Get-ChildItem 'HKCU:\\Control Panel\\NotifyIconSettings' -EA 0 | % {",
    "  $p = Get-ItemProperty $_.PSPath",
    `  if ($p.ExecutablePath -eq '${exe}') { $n++; if ($p.IsPromoted -ne 1) { Set-ItemProperty $_.PSPath IsPromoted 1 -Type DWord } }`,
    "}",
    "exit ([int]($n -eq 0))"
  ].join("\n");
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }, (err) => {
    if (err && triesLeft > 1) setTimeout(() => keepTrayIconOnTaskbar(triesLeft - 1), 3000);
    else if (err) console.error("[tray] could not keep the icon on the taskbar");
  });
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
  if (!shown) expandFromTray();
  else win.focus();
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
    if (choice.mode === "attach" && !choice.octo) await importFromExtension(choice).catch((err) => console.warn("[import]", err?.message || err));
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
    refreshOctoFolders().then(pushChoices);
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
    if (currentChoice().octo) return { key: "browser", label, state: "fail", detail: "Octo Browser works in Manual, with Catch Job — pick a Chrome profile for Auto" };
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
  ipcMain.handle("app:catchJob", async () => {
    const s = browser.status();
    if (s.state !== "connected" || !s.octo) return { ok: false, error: "Connect to an Octo Browser profile first." };
    try {
      return { ok: true, job: await browser.catchJob() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("app:scan", async () => {
    await scanRunning();
    return { choices: browserChoices(), choice: currentChoice().id };
  });

  // An Octo profile is never started or restarted from here. One open with its
  // remote debugging off is watched until it is switched on in the profile,
  // then connected to, as Chrome is; the app does not open the setting page,
  // since that would start Octo's browser outside Octo.
  function waitForOcto(choice) {
    if (choice.closed) return { ok: false, error: `${choice.profile.name} is not running — start it in Octo Browser, then click Connect` };
    watchForDebugging(choice.id);
    return { ok: true, octo: true, browser: choice.profile.name };
  }

  ipcMain.handle("app:enableDebug", async () => {
    await scanRunning();
    const choice = currentChoice();
    if (choice.mode !== "attach") return { ok: false, error: "pick a running browser first" };
    if (choice.debug) return { ok: true, already: true };
    if (choice.octo) return waitForOcto(choice);
    openDebugSetting(choice.running, choice.profile?.dir);
    watchForDebugging(choice.id);
    return { ok: true, browser: choice.browser };
  });

  ipcMain.handle("app:links", () => settings.profileLinks || {});
  ipcMain.handle("app:octoRefresh", () => refreshOctoFolders());
  // Saved only: Load profiles reads the list with what is saved. A blank
  // token removes the one saved.
  ipcMain.handle("app:saveOcto", async (_e, { token, folders }) => {
    if (token && !safeStorage.isEncryptionAvailable()) return { ok: false, error: "Windows could not protect the token, so it was not saved" };
    saveSettings({ octoToken: token ? safeStorage.encryptString(token).toString("base64") : "", octoFolders: folders });
    return { ok: true, token: octoToken(), folders: settings.octoFolders };
  });
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
  ipcMain.handle("win:minimize", () => collapseToTray());
  ipcMain.handle("win:toggleMaximize", () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  // The panel's × folds the bot into the tray (see the window's close).
  ipcMain.handle("win:close", () => collapseToTray());
  ipcMain.handle("win:isMaximized", () => !!win?.isMaximized());

  // The panel reports a finished action (see preload.js); it pops up above
  // the tray icon.
  ipcMain.on("app:actionDone", (_e, text) => showNotice(String(text || "").slice(0, 200)));

  ipcMain.handle("app:onTop", (_e, on) => {
    saveSettings({ alwaysOnTop: !!on });
    win?.setAlwaysOnTop(!!on, "floating");
    pushStatus();
    return !!on;
  });

  createWindow();
  createTray();
  win.on("focus", rescan);
  win.on("blur", foldOnBlur);
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  quitting = true;
  tray?.destroy();
  engine?.api.storage.flushNow();
  engine?.browser.disconnect().catch(() => {});
});
