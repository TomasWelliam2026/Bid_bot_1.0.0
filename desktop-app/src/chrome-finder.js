// Finds the Google Chrome installs on this PC, for the browser picker.
//
// Chrome can be installed per machine (Program Files) or per user
// (LocalAppData), on any drive, in four channels, each in its own folder —
// or anywhere at all, for a copy someone unzipped or moved. So it is looked
// for in every place that can say where it is:
//
//   1. the standard folders, on every drive;
//   2. what the installer told Windows: the "App Paths" entry that lets
//      `start chrome` work, and the "Uninstall" entry's install location —
//      per machine, per user, and the 32-bit view of both;
//   3. the chrome.exe of every Chrome running right now, from wherever it
//      was started (passed in by the caller, which scans the processes).
//
// Every chrome.exe found once is offered once, named by its channel.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CHANNELS = [
  { channel: "stable", folder: "Chrome", label: "Google Chrome" },
  { channel: "beta", folder: "Chrome Beta", label: "Google Chrome Beta" },
  { channel: "dev", folder: "Chrome Dev", label: "Google Chrome Dev" },
  { channel: "canary", folder: "Chrome SxS", label: "Google Chrome Canary" }
];

// --- 1. the standard folders, on every drive --------------------------------

function standardRoots() {
  const env = process.env;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA];
  // Program Files on other drives too: a PC whose apps live on D:.
  for (let code = 67; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    roots.push(path.join(drive, "Program Files"), path.join(drive, "Program Files (x86)"));
  }
  return [...new Set(roots.filter(Boolean).map((r) => path.resolve(r)))];
}

function standardExes() {
  const exes = [];
  for (const root of standardRoots()) {
    for (const { folder } of CHANNELS) exes.push(path.join(root, "Google", folder, "Application", "chrome.exe"));
  }
  return exes;
}

// --- 2. what the installer told Windows -------------------------------------

function regQuery(key, value) {
  try {
    const out = execFileSync("reg", ["query", key, ...(value ? ["/v", value] : ["/ve"])], {
      windowsHide: true,
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"]
    }).toString();
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(out);
    return m ? m[1].trim().replace(/^"|"$/g, "") : null;
  } catch {
    return null; // no such key — the usual answer
  }
}

function registryExes() {
  const exes = [];
  const hives = ["HKLM\\SOFTWARE", "HKCU\\SOFTWARE", "HKLM\\SOFTWARE\\WOW6432Node", "HKCU\\SOFTWARE\\WOW6432Node"];
  for (const hive of hives) {
    const appPath = regQuery(`${hive}\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`);
    if (appPath) exes.push(appPath);
    for (const name of ["Google Chrome", "Google Chrome Beta", "Google Chrome Dev", "Google Chrome SxS"]) {
      const location = regQuery(`${hive}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${name}`, "InstallLocation");
      if (location) exes.push(path.join(location, "chrome.exe"));
    }
  }
  return exes;
}

// --- naming what was found --------------------------------------------------

// The version is the name of the numbered folder beside chrome.exe.
function versionOf(appDir) {
  try {
    const versions = fs
      .readdirSync(appDir)
      .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions[0] || "";
  } catch {
    return "";
  }
}

function describe(exe) {
  const appDir = path.dirname(exe);
  const folder = path.basename(path.dirname(appDir)); // ...\Google\<folder>\Application\chrome.exe
  const known = CHANNELS.find((c) => c.folder.toLowerCase() === folder.toLowerCase());
  const local = (process.env.LOCALAPPDATA || "").toLowerCase();
  const perUser = !!local && exe.toLowerCase().startsWith(local);
  const standard = standardRoots().some((root) => exe.toLowerCase().startsWith(path.join(root, "Google").toLowerCase()));
  const channel = known?.channel || "stable";
  return {
    id: `${channel}:${perUser ? "user" : "machine"}${standard ? "" : `:${exe.toLowerCase()}`}`,
    channel,
    label: `${known?.label || "Google Chrome"}${perUser ? " (this user)" : ""}${standard ? "" : ` (${path.dirname(appDir)})`}`,
    version: versionOf(appDir),
    exe
  };
}

// alsoExes: the chrome.exe of each Chrome running now.
function findChromes(alsoExes = []) {
  const found = [];
  const seen = new Set();
  const ids = new Set();
  for (const candidate of [...standardExes(), ...registryExes(), ...alsoExes]) {
    if (!candidate || !/chrome\.exe$/i.test(candidate)) continue;
    const exe = path.resolve(candidate);
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(exe)) continue;
    const chrome = describe(exe);
    // Two installs that would read the same — a second per-machine Chrome
    // on another drive — are told apart by where they are.
    if (ids.has(chrome.id)) {
      chrome.id = `${chrome.id}:${key}`;
      chrome.label = `${chrome.label} (${path.dirname(path.dirname(exe))})`;
    }
    ids.add(chrome.id);
    found.push(chrome);
  }
  return found;
}

module.exports = { findChromes };
