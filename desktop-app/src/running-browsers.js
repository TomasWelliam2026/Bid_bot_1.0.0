// Finds the browsers running on this PC right now, and the profiles open in
// each, so the app can list them by name and connect to one.
//
// One running browser is one browser process (the chrome.exe without a
// --type= switch) on one user data folder. Every profile open in it shares
// that process, so it is connected to as a whole. Its profiles, and which of
// them are open, come from the folder's "Local State" file; whether it can be
// connected to at all comes from its "DevToolsActivePort" file, which Chrome
// writes while remote debugging is on — switched on in
// chrome://inspect/#remote-debugging, or started with --remote-debugging-port.

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { execFile } = require("node:child_process");

// The Chromium browsers looked for, and where each keeps its data by default.
// The folder is the install's own folder name: "Google\Chrome Beta\Application\
// chrome.exe" keeps its data in "Google\Chrome Beta\User Data".
const KINDS = [
  { exe: "chrome.exe", vendor: "Google", names: { "Chrome": "Google Chrome", "Chrome Beta": "Google Chrome Beta", "Chrome Dev": "Google Chrome Dev", "Chrome SxS": "Google Chrome Canary" } },
  { exe: "msedge.exe", vendor: "Microsoft", names: { "Edge": "Microsoft Edge", "Edge Beta": "Microsoft Edge Beta", "Edge Dev": "Microsoft Edge Dev", "Edge SxS": "Microsoft Edge Canary" } },
  { exe: "brave.exe", vendor: "BraveSoftware", names: { "Brave-Browser": "Brave", "Brave-Browser-Beta": "Brave Beta", "Brave-Browser-Nightly": "Brave Nightly" } }
];

function listProcesses() {
  const filter = KINDS.map((k) => `Name='${k.exe}'`).join(" or ");
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
    "Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        try {
          resolve([].concat(JSON.parse(stdout)));
        } catch {
          resolve([]);
        }
      }
    );
  });
}

// A switch's value from a command line: --name=value, --name="value with spaces".
function switchValue(commandLine, name) {
  const m = new RegExp(`--${name}=(?:"([^"]*)"|(\\S+))`).exec(commandLine || "");
  return m ? m[1] ?? m[2] : null;
}

function describeInstall(exePath) {
  const exe = path.basename(exePath || "").toLowerCase();
  const kind = KINDS.find((k) => k.exe === exe);
  if (!kind) return null;
  // ...\<Vendor>\<Folder>\Application\chrome.exe
  const folder = path.basename(path.dirname(path.dirname(exePath)));
  const name = kind.names[folder] || `${kind.names[Object.keys(kind.names)[0]]} (${folder})`;
  const defaultUserData = path.join(process.env.LOCALAPPDATA || "", kind.vendor, folder, "User Data");
  return { name, defaultUserData };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Every profile in the folder, by the name the browser shows it under, and
// whether it has a window open now: last_active_profiles is the browser's
// own list of open profiles, kept up to date as windows open and close. A
// browser started in the background (--no-startup-window, as Edge's startup
// boost does) has none open until a window is.
function readProfiles(userDataDir, commandLineProfile, background = false) {
  const state = readJson(path.join(userDataDir, "Local State"));
  const cache = state?.profile?.info_cache || {};
  const open = new Set(state?.profile?.last_active_profiles || []);
  if (!open.size && commandLineProfile && !background) open.add(commandLineProfile);
  const profiles = Object.entries(cache).map(([dir, info]) => ({
    dir,
    name: String(info?.name || dir),
    open: open.has(dir)
  }));
  if (!profiles.length) {
    profiles.push({ dir: commandLineProfile || "Default", name: commandLineProfile || "Default", open: !background && !state });
  }
  // Open ones first, each group in the browser's own order.
  return profiles.sort((a, b) => Number(b.open) - Number(a.open));
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 800 });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

// "9222\n/devtools/browser/<id>" → the WebSocket address, if the port is live.
// The file outlives a browser that crashed, so the port is tried, not trusted.
async function readDebugEndpoint(userDataDir) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
  const port = Number(lines[0]);
  const wsPath = (lines[1] || "").trim();
  if (!port || !wsPath.startsWith("/devtools/browser/")) return null;
  if (!(await portAnswers(port))) return null;
  return { port, wsEndpoint: `ws://127.0.0.1:${port}${wsPath}` };
}

// ownDataDir: where the app keeps the Chrome profiles it launches itself, so
// such a browser is named as the app's rather than the user's.
async function findRunningBrowsers({ ownDataDir } = {}) {
  const processes = await listProcesses();
  const byFolder = new Map();

  for (const p of processes) {
    // Renderers, GPU and the like carry --type=; the browser process does not.
    if (!p.CommandLine || /\s--type=/.test(p.CommandLine) || !p.ExecutablePath) continue;
    const install = describeInstall(p.ExecutablePath);
    if (!install) continue;

    const userDataDir = path.resolve(switchValue(p.CommandLine, "user-data-dir") || install.defaultUserData);
    const key = userDataDir.toLowerCase();
    if (byFolder.has(key)) continue; // a second launcher process for the same browser
    byFolder.set(key, {
      pid: p.ProcessId,
      browser: install.name,
      exe: p.ExecutablePath,
      userDataDir,
      commandLineProfile: switchValue(p.CommandLine, "profile-directory"),
      // Started on a data folder of its own (--user-data-dir): named by it,
      // so two Chromes in the list can be told apart.
      folder: key === path.resolve(install.defaultUserData).toLowerCase() ? null : path.basename(userDataDir),
      background: /--no-startup-window/.test(p.CommandLine),
      ownedByApp: !!ownDataDir && key.startsWith(path.resolve(ownDataDir).toLowerCase())
    });
  }

  const found = [];
  for (const b of byFolder.values()) {
    const profiles = readProfiles(b.userDataDir, b.commandLineProfile, b.background && !b.commandLineProfile);
    const debug = await readDebugEndpoint(b.userDataDir);
    found.push({
      id: `running:${b.userDataDir.toLowerCase()}`,
      pid: b.pid,
      browser: b.browser,
      exe: b.exe,
      userDataDir: b.userDataDir,
      ownedByApp: b.ownedByApp,
      folder: b.folder,
      profiles,
      openProfiles: profiles.filter((p) => p.open).map((p) => p.name),
      // Edge, and Chrome with "keep running in the background", stay running
      // with no window open; there is nothing on screen to drive then.
      windows: profiles.some((p) => p.open),
      debug // null: remote debugging is off, so it cannot be connected to yet
    });
  }
  return found;
}

// Opens chrome://inspect/#remote-debugging in that running browser, where its
// remote debugging is switched on. Handing the URL to the browser's own exe
// sends it to the window already open rather than starting a second browser.
function openDebugSetting(running, profileDir) {
  const profile = profileDir || running.profiles.find((p) => p.open)?.dir;
  const scheme = /msedge\.exe$/i.test(running.exe) ? "edge" : "chrome";
  execFile(running.exe, [...profileArgs(running, profile), `${scheme}://inspect/#remote-debugging`], { windowsHide: false }, () => {});
}

// The switches that send a URL to one profile of that running browser: its
// data folder, when it is not the browser's usual one, and the profile.
function profileArgs(running, profileDir) {
  const args = [];
  if (running.folder) args.push(`--user-data-dir=${running.userDataDir}`);
  if (profileDir) args.push(`--profile-directory=${profileDir}`);
  return args;
}

// The profiles of a running browser that have the extension, and its id in
// each. Read from each profile's own Preferences files: an extension loaded
// from a folder ("Load unpacked") is listed there with that folder, and one
// installed from the Web Store has its manifest under the profile's
// Extensions folder; either way it is matched by its manifest's name.
function findExtensionCopies(running, extensionName) {
  const copies = [];
  for (const profile of running.profiles) {
    const dir = path.join(running.userDataDir, profile.dir);
    const settings = {};
    for (const file of ["Secure Preferences", "Preferences"]) {
      Object.assign(settings, readJson(path.join(dir, file))?.extensions?.settings || {});
    }
    for (const [id, entry] of Object.entries(settings)) {
      if (!/^[a-p]{32}$/.test(id) || entry?.state === 0) continue; // 0: switched off
      if (manifestName(entry, dir, id) !== extensionName) continue;
      copies.push({ profileDir: profile.dir, profileName: profile.name, id });
    }
  }
  return copies;
}

function manifestName(entry, profileDir, id) {
  if (entry?.manifest?.name) return entry.manifest.name;
  const folders = [];
  if (entry?.path) folders.push(path.isAbsolute(entry.path) ? entry.path : path.join(profileDir, "Extensions", entry.path));
  try {
    for (const version of fs.readdirSync(path.join(profileDir, "Extensions", id))) {
      folders.push(path.join(profileDir, "Extensions", id, version));
    }
  } catch {}
  for (const folder of folders) {
    const name = readJson(path.join(folder, "manifest.json"))?.name;
    if (name) return name;
  }
  return null;
}

module.exports = { findRunningBrowsers, openDebugSetting, profileArgs, findExtensionCopies };
