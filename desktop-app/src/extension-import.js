// The app keeps its own copy of what the extension keeps in Chrome — the API
// key and model, Country and Role, resume styles, Auto Fill — and starts with
// none of it, so Start would stop at "no country and role picked". Connected
// to a browser that has the extension, the app fills in what it is missing
// from the extension's own storage: from the profile picked if the extension
// is there, otherwise from the profile of that browser that has it.
//
// Nothing already set in the app is overwritten, and the job list is not
// copied.

const { profileArgs, findExtensionCopies } = require("./running-browsers");

const EXTENSION_NAME = "Jobright Live Feed";
// What the extension keeps, as background.js names it — all of it but the job list.
const IMPORT_KEYS = ["profile", "profileStyles", "customStyles", "autofill", "autofillProfiles", "openaiModels", "theme"];
const PROFILE_FIELDS = ["apiKey", "model", "country", "role", "prompt"];

const NAMES = {
  apiKey: "API key",
  model: "model",
  country: "Country",
  role: "Role",
  prompt: "prompt",
  profileStyles: "resume styles",
  customStyles: "resume styles",
  autofill: "Auto Fill",
  autofillProfiles: "Auto Fill",
  openaiModels: "model list",
  theme: "theme"
};

const isEmpty = (v) =>
  v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

// storage: the app's chrome.storage.local. browser: the connected McpBrowser.
// running / profile: the running browser and the profile picked in it.
// Answers { filled, from, note } when something was copied, else null.
async function importFromExtension({ storage, browser, running, profile }) {
  const own = await storage.get(null);
  const settings = own.profile || {};
  const missing = IMPORT_KEYS.filter((k) => k !== "profile" && isEmpty(own[k]));
  const settingsMissing = PROFILE_FIELDS.filter((f) => isEmpty(settings[f]));
  if (!missing.length && !settingsMissing.length) return null;

  const copies = findExtensionCopies(running, EXTENSION_NAME);
  const copy = copies.find((c) => c.profileDir === profile?.dir) || copies[0];
  if (!copy) return null;

  const from = { exe: running.exe, args: profileArgs(running, copy.profileDir), name: copy.profileName };
  const theirs = await browser.readExtensionStorage(from, copy.id, IMPORT_KEYS);

  const patch = {};
  const filled = [];
  for (const key of missing) {
    if (!isEmpty(theirs[key])) {
      patch[key] = theirs[key];
      filled.push(key);
    }
  }
  if (theirs.profile) {
    const merged = { ...settings };
    for (const field of settingsMissing) {
      if (!isEmpty(theirs.profile[field])) {
        merged[field] = theirs.profile[field];
        filled.push(field);
      }
    }
    patch.profile = { ...theirs.profile, ...merged };
  }
  if (!filled.length) return null;

  await storage.set(patch);
  storage.flushNow?.();
  const what = [...new Set(filled.map((f) => NAMES[f] || f))].join(", ");
  return {
    filled,
    from: copy.profileName,
    note: `Copied your extension settings (${what}) from ${running.browser} · ${copy.profileName}.`
  };
}

module.exports = { importFromExtension };
