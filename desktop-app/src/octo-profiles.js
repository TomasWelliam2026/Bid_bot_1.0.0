// The Octo Browser profiles running on this PC, for the browser bar. Octo's
// Local API lists them by id only; the name is in each one's window title,
// "Sisu-Br-Paulo - Octium". Octo not running is simply none. A profile can only
// be connected to if it was started with a debug port, and one started from
// Octo's own window has none, so such a profile is started again from here.
//
// The profiles ready to launch come from Octo's cloud API, by the token kept in
// the app's settings: the ones in the folders named in the Browser Profile
// panel. That API has no search by folder, so every profile is read and sorted
// here.

const { execFile } = require("node:child_process");

const OCTO_API = "http://127.0.0.1:58888";
const API_TIMEOUT_MS = 3000;
const START_TIMEOUT_MS = 80000;
const OCTO_CLOUD = "https://app.octobrowser.net";
const CLOUD_TIMEOUT_MS = 15000;
const CLOUD_PAGE = 100;
const CLOUD_MAX_PAGES = 50;

// Window titles by process id.
function windowTitles(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  const script =
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ` +
    "Select-Object Id, MainWindowTitle | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        try {
          resolve(new Map([].concat(JSON.parse(stdout)).map((p) => [p.Id, p.MainWindowTitle])));
        } catch {
          resolve(new Map());
        }
      }
    );
  });
}

async function listOctoProfiles({ api = OCTO_API } = {}) {
  let active;
  try {
    const res = await fetch(`${api}/api/profiles/active`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    active = await res.json();
  } catch {
    return [];
  }
  if (!Array.isArray(active)) return [];

  const pids = active.map((p) => Number(p.browser_pid)).filter(Boolean);
  const titles = await windowTitles(pids);
  return active.map((p) => ({
    uuid: p.uuid,
    name: (titles.get(p.browser_pid) || "").replace(/ - Octium$/, "") || `Profile ${String(p.uuid).slice(0, 6)}`,
    wsEndpoint: p.ws_endpoint || null
  }));
}

async function startOctoProfile(uuid, { api = OCTO_API } = {}) {
  const res = await fetch(`${api}/api/profiles/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uuid, headless: false, debug_port: true, only_local: true, timeout: 60 }),
    signal: AbortSignal.timeout(START_TIMEOUT_MS)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.detail || `Octo Browser answered ${res.status}`);
  return body;
}

async function cloudGet(api, token, path) {
  const res = await fetch(`${api}/api/v2/automation${path}`, {
    headers: { "X-Octo-Api-Token": token },
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS)
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error("Octo Browser refused the API token");
  if (res.status === 429) throw new Error("Octo Browser's request limit was reached — try again in a minute");
  if (!res.ok || body.success === false) throw new Error(body.msg || `Octo Browser answered ${res.status}`);
  return body;
}

// A profile's folder, as the API gives it: its id or name, an object, or null.
const folderKeys = ({ folder }) =>
  (folder && typeof folder === "object" ? [folder.uuid, folder.name] : [folder]).filter(Boolean).map((k) => String(k).toLowerCase());

// { profiles: [{ uuid, name }], missing: names no folder has }
async function listFolderProfiles({ token, folders, api = OCTO_CLOUD }) {
  const { data: known = [] } = await cloudGet(api, token, "/folders");
  const wanted = new Set();
  const missing = [];
  for (const name of folders) {
    const found = known.find((f) => String(f.name).toLowerCase() === name.toLowerCase());
    if (!found) {
      missing.push(name);
      continue;
    }
    wanted.add(String(found.uuid).toLowerCase());
    wanted.add(String(found.name).toLowerCase());
  }
  if (!wanted.size) return { profiles: [], missing };

  const profiles = [];
  for (let page = 0; page < CLOUD_MAX_PAGES; page++) {
    const { data = [] } = await cloudGet(api, token, `/profiles?page_len=${CLOUD_PAGE}&page=${page}&fields=title,folder`);
    for (const p of data) {
      if (folderKeys(p).some((k) => wanted.has(k))) profiles.push({ uuid: p.uuid, name: p.title || `Profile ${String(p.uuid).slice(0, 6)}` });
    }
    if (data.length < CLOUD_PAGE) break;
  }
  return { profiles, missing };
}

module.exports = { listOctoProfiles, startOctoProfile, listFolderProfiles };
