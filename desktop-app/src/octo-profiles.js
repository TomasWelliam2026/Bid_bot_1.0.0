// The Octo Browser profiles running on this PC, for the browser bar. Octo's
// Local API lists them by id only; the name is in each one's window title,
// "Sisu-Br-Paulo - Octium". Octo not running is simply none.
//
// The app connects only to a profile already open: it never starts one, since
// a browser started outside Octo would go without the profile's proxy. One
// started from Octo's own window has no debug port, so its remote debugging is
// switched on by hand in chrome://inspect/#remote-debugging, as Chrome's is.
// The browser then writes DevToolsActivePort into its own data folder, which
// its command line names, and that file gives the address to connect to.
//
// The profiles ready to launch come from Octo's cloud API, by the token kept in
// the app's settings: the ones in the folders named in the Browser Profile
// panel. That API has no search by folder, so every profile is read and sorted
// here.

const { execFile } = require("node:child_process");
const { readDebugEndpoint } = require("./running-browsers");

const OCTO_API = "http://127.0.0.1:58888";
const API_TIMEOUT_MS = 3000;
const OCTO_CLOUD = "https://app.octobrowser.net";
const CLOUD_TIMEOUT_MS = 15000;
const CLOUD_PAGE = 100;
const CLOUD_MAX_PAGES = 50;

// Window title and command line, by process id.
function processInfo(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  const script =
    `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { ` +
    "[pscustomobject]@{ Id = $_.Id; Title = $_.MainWindowTitle; " +
    'CommandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine } } | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        try {
          resolve(new Map([].concat(JSON.parse(stdout)).map((p) => [p.Id, p])));
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
  const info = await processInfo(pids);
  return Promise.all(
    active.map(async (p) => {
      const proc = info.get(p.browser_pid) || {};
      const dir = dataDirOf(proc.CommandLine);
      // Started through the Local API with a port, or switched on by hand.
      const wsEndpoint = p.ws_endpoint || (dir ? (await readDebugEndpoint(dir))?.wsEndpoint : null) || null;
      return {
        uuid: p.uuid,
        name: String(proc.Title || "").replace(/ - Octium$/, "") || `Profile ${String(p.uuid).slice(0, 6)}`,
        wsEndpoint
      };
    })
  );
}

// The --user-data-dir of a command line. Octo quotes the whole switch,
// "--user-data-dir=C:\...\Octo Browser\tmp\19db1ca1", as its path has a space.
function dataDirOf(commandLine) {
  const m = /"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=(\S+)/.exec(commandLine || "");
  return m ? m[1] || m[2] || m[3] : null;
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

module.exports = { listOctoProfiles, listFolderProfiles, dataDirOf };
