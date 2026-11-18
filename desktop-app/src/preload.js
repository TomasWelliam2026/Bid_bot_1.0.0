// Runs before the extension's side panel page, in the app window.
//
// 1. Gives the page the chrome.* it uses, carried over IPC to the main
//    process, where the extension's background.js and the MCP browser live.
// 2. Adds the browser bar above the panel: the browsers running on this PC
//    and their profiles, or a new Chrome to start; Connect / Disconnect,
//    the status, and the always-on-top pin.

const { ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// The app's logo for the title bar, twice: teal lines for the light theme,
// and for the dark one the same inverted inside the unicorn's silhouette —
// aqua where it was empty, the lines cut out — with a stroked outline. The panel is served from the
// extension's folder, which does not hold them, so they go in as data URLs.
function logoUrl(file) {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(__dirname, "..", "assets", file)).toString("base64")}`;
  } catch {
    return ""; // no logo: the name alone
  }
}
const LOGO = logoUrl("logo.png");
const LOGO_DARK = logoUrl("logo-dark.png") || LOGO;
// Octo Browser's and Chrome's own icons — wherever the bar names one of them
// (the Octo Settings button, and each profile row's browser label), rather
// than a hand-drawn stand-in or the name alone.
const OCTO_ICON = logoUrl("octo-browser-icon.png");
const CHROME_ICON = logoUrl("chrome-icon.png");
// A plain black silhouette of the same icon, for the Octo Settings button —
// that button follows the other icon buttons' own look (a line glyph in
// --muted, --accent once picked), so a full-colour image there would be the
// odd one out; a CSS mask lets the one glyph still be recolored the same way.
const OCTO_MASK = logoUrl("octo-browser-mask.png");

// ---------------------------------------------------------------------------
// chrome.*, as the panel calls it
// ---------------------------------------------------------------------------

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
          console.error(err);
        }
      }
    }
  };
}

const messageListeners = new Set();
const onActivated = eventSource();
const onUpdated = eventSource();

// The panel's listeners hear the background and the pages, as in Chrome. Its
// answers go nowhere: nothing in the extension asks the panel a question.
ipcRenderer.on("rt:message", (_e, message, sender) => {
  for (const fn of [...messageListeners]) {
    try {
      fn(message, sender || {}, () => {});
    } catch (err) {
      console.error(err);
    }
  }
});
ipcRenderer.on("tabs:activated", (_e, info) => onActivated.emit(info));
ipcRenderer.on("tabs:updated", (_e, id, changes, tab) => onUpdated.emit(id, changes, tab));

window.chrome = {
  runtime: {
    id: "bidbot-desktop",
    getURL: (p) => `app://ext/${String(p).replace(/^\//, "")}`,
    sendMessage: (message) => ipcRenderer.invoke("rt:send", message),
    onMessage: {
      addListener: (fn) => messageListeners.add(fn),
      removeListener: (fn) => messageListeners.delete(fn),
      hasListener: (fn) => messageListeners.has(fn)
    }
  },
  tabs: {
    query: (info) => ipcRenderer.invoke("tabs:query", info),
    create: (props) => ipcRenderer.invoke("tabs:create", props),
    onActivated,
    onUpdated
  },
  scripting: {
    // A function cannot cross IPC; its source can.
    executeScript: (details) =>
      ipcRenderer.invoke("scripting:exec", {
        ...details,
        func: typeof details.func === "function" ? details.func.toString() : details.func
      })
  },
  permissions: {
    request: async () => true,
    contains: async () => true
  }
};

// What only the app knows, for the panel's checks before a run: whether the
// browser is connected, or can be when the run starts.
window.bidbotDesktop = {
  connected: false, // to a browser: the Recruiter Bid list shows only then
  octo: false, // to an Octo Browser profile: Manual only, with Catch Job
  checkBrowser: () => ipcRenderer.invoke("app:checkBrowser"),
  catchJob: () => ipcRenderer.invoke("app:catchJob")
};

// ---------------------------------------------------------------------------
// The browser bar
//
// A row of circles, one per browser profile: every profile of every browser
// running on this PC, then Bid Bot's own profile in each Chrome the app can
// start itself. Picking a circle picks its browser and the one profile the
// app works in. Connect becomes "Turn on debugging" for a running browser
// whose remote debugging is off: that opens the setting in the browser, and
// the app connects as soon as it is switched on.
// ---------------------------------------------------------------------------

const BAR_CSS = `
/* The window's own title bar: the logo and the name to drag the window by,
   and minimize, maximize and close. The name is a two-line wordmark in the
   logo's teal. */
#bidbot-titlebar {
  --bt-teal: #319bba;
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--gap, 8px);
  height: 56px;
  padding: 0 var(--gutter, 8px);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bt-teal) 9%, var(--surface, #fff)), var(--surface, #fff));
  color: var(--fg, #1d1d27);
  font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  -webkit-app-region: drag;
  user-select: none;
  /* Pinned at the top of the window, above whatever scrolls below it. */
  position: sticky;
  top: 0;
  z-index: 21;
}
#bidbot-titlebar .bt-logo {
  flex: none;
  width: 40px;
  height: 40px;
  filter: drop-shadow(0 1px 2px color-mix(in srgb, var(--bt-teal) 35%, transparent));
}
/* One logo per theme, shown as the panel's own theme switches. */
#bidbot-titlebar .bt-logo-dark,
#bidbot-titlebar[data-theme="dark"] .bt-logo-light { display: none; }
#bidbot-titlebar[data-theme="dark"] .bt-logo-dark { display: block; }
/* Dark: a brighter aqua for the logo and the wordmark, with a soft glow, so
   both read on the navy; the gradient ends in the dark theme's lighter
   accent. */
#bidbot-titlebar[data-theme="dark"] {
  --bt-teal: #6fd6ee;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bt-teal) 10%, var(--surface, #192f3d)), var(--surface, #192f3d));
}
/* The dark logo is the light one inverted inside its silhouette — the lines
   cut out, the spaces between them filled — with a crisp lavender stroke
   round its outline (#a9a4ff, the accent's family, between the aqua and the
   navy), drawn into the image itself. Nothing blurred on top. */
#bidbot-titlebar[data-theme="dark"] .bt-logo { filter: none; }
#bidbot-titlebar[data-theme="dark"] .bt-title {
  background-image: linear-gradient(90deg, #8be3f6, var(--accent, #8b85f5));
}
#bidbot-titlebar .bt-name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  white-space: nowrap;
  overflow: hidden;
}
#bidbot-titlebar .bt-kicker {
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--bt-teal);
}
#bidbot-titlebar .bt-title {
  font-size: 20px;
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: -0.01em;
  background: linear-gradient(90deg, var(--bt-teal), var(--accent, #6a5fdb));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
/* The panel's ChatGPT Settings, under the browser bar: the GPT button there
   replaces the one beside its gear. */
#openChatgpt,
#openUserSettings { display: none; }
/* The window is one column of three equal parts: Auto and Manual take two, so
   they end where Stop ends, and the run's status takes the third. */
.titlebar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
#modeSwitch { grid-column: span 2; }
.mode { flex: 1 1 0; width: auto; }
/* Browser Profile: each browser profile in use, and the bid profile it is
   linked to. */
#linkPanel .lp-head,
#linkPanel .lp-row {
  display: grid;
  grid-template-columns: 1fr 1.3fr;
  gap: 10px;
  align-items: center;
}
#linkPanel .lp-head { margin-bottom: 6px; }
#linkPanel .lp-head .field-label { margin: 0; }
#linkPanel .lp-row { padding: 5px 0; border-top: 1px solid var(--line-soft, #e6e6ee); }
/* Octo Browser's or Chrome's own icon stands for the name now — no "Octo
   Browser" / "Google Chrome" text label beneath the profile's own name. */
#linkPanel .lp-name { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12.5px; font-weight: 600; }
#linkPanel .lp-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#linkPanel .lp-browser-icon { flex: none; width: 16px; height: 16px; border-radius: 3px; }
#linkPanel select { width: 100%; min-width: 0; }
#linkPanel .form-actions { margin-top: 10px; }
/* Shown in linkPanel while it is still loading (fillLinkPanel's own awaits —
   Octo's profiles, the running browsers, the bid profiles) — the panel is
   otherwise simply blank for that stretch, which reads as broken rather
   than as "still coming". */
#linkPanel .lp-loading { display: flex; align-items: center; gap: 8px; padding: 14px 2px; color: var(--muted, #767685); font-size: 12.5px; }
#linkPanel .lp-spinner { flex: none; width: 15px; height: 15px; border: 2px solid var(--line, #d8d8e2); border-top-color: var(--accent, #6b4eff); border-radius: 50%; animation: lp-spin 0.7s linear infinite; }
@keyframes lp-spin { to { transform: rotate(360deg); } }
/* Octo Settings' Save/Load row, as the two columns above it rather than
   each button its own width. */
.octo-actions { margin-top: 10px; }
.octo-actions button { width: 100%; }
body > .gpt-panel {
  flex: none;
  max-height: 70vh;
  overflow-y: auto;
  margin: 0;
  padding: var(--gutter, 8px);
  border: 0;
  border-bottom: 1px solid var(--panel-line);
  border-radius: 0;
}
#bidbot-titlebar .bt-buttons {
  flex: none;
  display: flex;
  gap: 4px;
}
#bidbot-titlebar .bt-btn {
  width: 28px;
  min-width: 0;
  height: 28px;
  min-height: 0;
  padding: 0;
  margin: 0;
  display: grid;
  place-items: center;
  color: var(--muted, #767685);
  background: transparent;
  border: 0;
  border-radius: 8px;
  -webkit-app-region: no-drag;
  cursor: default;
  transition: background 0.12s ease, color 0.12s ease;
}
#bidbot-titlebar .bt-btn:hover { background: var(--sunken, #eef0f5); color: var(--fg, #1d1d27); }
#bidbot-titlebar .bt-close:hover { background: #e5484d; color: #fff; }
#bidbot-titlebar .bt-btn:focus-visible { outline: 2px solid var(--accent, #6a5fdb); outline-offset: -2px; }
#bidbot-titlebar .bt-btn svg { display: block; }
#bidbot-titlebar[data-maximized="1"] .bt-max-icon,
#bidbot-titlebar:not([data-maximized="1"]) .bt-restore-icon { display: none; }

#bidbot-bar {
  flex: none;
  display: grid;
  gap: var(--gap, 8px);
  padding: 0 var(--gutter, 8px) var(--gutter, 8px);
  background: var(--surface, #fff);
  border-bottom: 1px solid var(--line, #dcdce6);
  font: 12px/1.4 system-ui, "Segoe UI", sans-serif;
  color: var(--fg, #1d1d27);
  /* Pinned right below the title bar, so both stay in view as the panel
     below scrolls. */
  position: sticky;
  top: 56px;
  z-index: 20;
}
/* Who the bot is working as, with the way to connect at the row's end. */
#bidbot-bar .bb-who {
  display: flex;
  align-items: center;
  gap: var(--gap, 8px);
  min-width: 0;
  height: var(--control, 32px);
}
/* The tools, five equal parts of the column. */
#bidbot-bar .bb-tools {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--gap, 8px);
}
#bidbot-bar .bb-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted, #767685);
}
#bidbot-bar[data-state="connected"] .bb-dot { background: var(--ok, #12915f); }
#bidbot-bar[data-state="connecting"] .bb-dot,
#bidbot-bar[data-state="waiting"] .bb-dot { background: var(--accent, #6a5fdb); animation: bb-pulse 1.2s ease-in-out infinite; }
#bidbot-bar[data-error="1"] .bb-dot { background: var(--err, #d6395a); }
@keyframes bb-pulse { 50% { opacity: 0.3; } }
/* The browser profiles as a stack of round avatars, each overlapping the one
   before by a fifth of its width. Every circle is the same plain circle; only
   its colour differs. The picked one wears a ring and sits on top. */
#bidbot-bar .bb-browsers {
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 0 0 6px; /* the first circle's overlap */
}
#bidbot-bar .bb-avatar {
  position: relative;
  flex: none;
  width: 28px;
  min-width: 0;
  height: 28px;
  min-height: 0;
  box-sizing: border-box;
  margin-left: -6px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid var(--surface, #fff);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 24px;
  text-align: center;
  cursor: pointer;
  transition: box-shadow 0.12s ease;
}
#bidbot-bar .bb-avatar.bb-new { font-size: 17px; font-weight: 600; line-height: 23px; }
#bidbot-bar .bb-avatar:hover:not(:disabled),
#bidbot-bar .bb-avatar:focus-visible { z-index: 3; outline: none; }
#bidbot-bar .bb-avatar[aria-checked="true"] {
  z-index: 2;
  box-shadow: 0 0 0 2px var(--accent, #6a5fdb);
}
#bidbot-bar .bb-avatar:disabled { cursor: default; opacity: 1; }
/* An Octo Browser profile: square, to tell it from a Chrome one. */
#bidbot-bar .bb-avatar.bb-octo { border-radius: 7px; cursor: default; }
/* The profile's name and its browser, under the circle the pointer is on. Lives on the page
   itself, not in the bar, so nothing in the bar can cover it. */
#bidbot-tip {
  position: fixed;
  z-index: 2147483647;
  padding: 4px 8px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
  color: #fff;
  background: #1d1d27;
  border-radius: 5px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  pointer-events: none;
}
#bidbot-tip[hidden] { display: none; }
#bidbot-bar .bb-browser-name {
  flex: 1 1 120px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-soft, #3d3d4b);
  font-weight: 600;
}
#bidbot-bar button {
  flex: none;
  height: var(--control, 32px);
  padding: 0 12px;
  font: inherit;
  font-weight: 600;
  color: var(--fg, #1d1d27);
  background: var(--bg, #f6f6fa);
  border: 1px solid var(--line, #dcdce6);
  border-radius: 8px;
  cursor: pointer;
}
#bidbot-bar button:hover:not(:disabled) { border-color: var(--accent, #6a5fdb); }
#bidbot-bar button.bb-stop {
  color: #fff;
  background: var(--err, #d6395a);
  border-color: var(--err, #d6395a);
}
#bidbot-bar button:disabled { opacity: 0.55; cursor: default; }
#bidbot-bar button.bb-primary {
  color: var(--accent-fg, #fff);
  background: var(--accent, #6a5fdb);
  border-color: var(--accent, #6a5fdb);
}
#bidbot-bar .bb-octo-settings,
#bidbot-bar .bb-user,
#bidbot-bar .bb-gpt,
#bidbot-bar .bb-link,
#bidbot-bar .bb-pin {
  width: 100%;
  /* A bit taller than the row's other, text-labelled buttons — the bigger
     icons below need the room, not just more icon crammed into the same
     32px. */
  height: 38px;
  min-width: 0;
  padding: 0;
  font-size: 14px;
}
#bidbot-bar .bb-pin svg,
#bidbot-bar .bb-octo-settings .bb-octo-mask,
#bidbot-bar .bb-user svg,
#bidbot-bar .bb-gpt svg,
#bidbot-bar .bb-link svg { display: block; margin: auto; }
/* The Octo mascot's own silhouette, as a CSS mask rather than a full-colour
   image — a plain glyph in the same colour as the other icon buttons
   (currentColor, via --fg), --accent once picked, the same as theirs (see
   [aria-expanded="true"] below). */
#bidbot-bar .bb-octo-mask {
  width: 24px;
  height: 24px;
  background-color: var(--fg, #1d1d27);
  -webkit-mask-image: var(--octo-mask-image);
  mask-image: var(--octo-mask-image);
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
}
#bidbot-bar button.bb-octo-settings[aria-expanded="true"] .bb-octo-mask { background-color: var(--accent, #6a5fdb); }
#bidbot-bar button.bb-octo-settings[aria-expanded="true"],
#bidbot-bar button.bb-user[aria-expanded="true"],
#bidbot-bar button.bb-link[aria-expanded="true"],
#bidbot-bar button.bb-gpt[aria-expanded="true"] {
  color: var(--accent, #6a5fdb);
  background: var(--accent-soft, #ece9fb);
  border-color: var(--accent-line, #c7bff3);
}
/* Moved into .bb-who, left of Connect — a plain icon-sized square there,
   same height as Connect beside it rather than .bb-tools' 1/5-column share. */
#bidbot-bar .bb-who .bb-rescan {
  flex: none;
  width: var(--control, 32px);
  height: var(--control, 32px);
  min-width: 0;
  padding: 0;
  font-size: 14px;
}
#bidbot-bar button.bb-pin[aria-pressed="true"] {
  color: var(--accent, #6a5fdb);
  background: var(--accent-soft, #ece9fb);
  border-color: var(--accent-line, #c7bff3);
}
#bidbot-bar .bb-status {
  min-width: 0;
  font-family: var(--log-font, monospace);
  font-size: 10.5px;
  color: var(--muted, #767685);
  overflow-wrap: anywhere;
}
#bidbot-bar[data-error="1"] .bb-status { color: var(--err, #d6395a); }
#bidbot-bar .bb-status[hidden] { display: none; }
`;

function buildBar() {
  const style = document.createElement("style");
  style.textContent = BAR_CSS;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "bidbot-bar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Browser");
  // The title bar goes above everything, the browser bar under it.
  const titlebar = document.createElement("div");
  titlebar.id = "bidbot-titlebar";
  const icon = (path) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  titlebar.innerHTML = `
    <img class="bt-logo bt-logo-light" alt="" src="${LOGO}">
    <img class="bt-logo bt-logo-dark" alt="" src="${LOGO_DARK}">
    <span class="bt-name" aria-label="Valiant Sisu Bid Bot">
      <span class="bt-kicker">Valiant Sisu</span>
      <span class="bt-title">Bid Bot</span>
    </span>
    <span class="bt-buttons">
      <button type="button" class="bt-btn" data-act="minimize" title="Minimize" aria-label="Minimize">${icon('<path d="M4 8.5h8"/>')}</button>
      <button type="button" class="bt-btn" data-act="toggleMaximize" title="Maximize" aria-label="Maximize">
        <span class="bt-max-icon">${icon('<rect x="4" y="4" width="8" height="8" rx="2"/>')}</span>
        <span class="bt-restore-icon">${icon('<rect x="3.5" y="5.5" width="7" height="7" rx="1.6"/><path d="M6 5.5v-.7c0-.7.6-1.3 1.3-1.3h4c.7 0 1.3.6 1.3 1.3v4c0 .7-.6 1.3-1.3 1.3h-.8"/>')}</span>
      </button>
      <button type="button" class="bt-btn bt-close" data-act="close" title="Close" aria-label="Close">${icon('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>')}</button>
    </span>`;
  for (const button of titlebar.querySelectorAll(".bt-btn")) {
    button.addEventListener("click", () => ipcRenderer.invoke(`win:${button.dataset.act}`));
  }
  const maxButton = titlebar.querySelector('[data-act="toggleMaximize"]');
  const showMaximized = (on) => {
    titlebar.dataset.maximized = on ? "1" : "0";
    maxButton.title = on ? "Restore" : "Maximize";
    maxButton.setAttribute("aria-label", maxButton.title);
  };
  ipcRenderer.on("win:maximized", (_e, on) => showMaximized(on));

  // The logo and wordmark follow the panel's theme (data-theme on <html>).
  const followTheme = () => (titlebar.dataset.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  followTheme();
  new MutationObserver(followTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  ipcRenderer.invoke("win:isMaximized").then(showMaximized, () => {});

  bar.innerHTML = `
    <div class="bb-who">
    <span class="bb-dot" aria-hidden="true"></span>
    <div class="bb-browsers" role="radiogroup" aria-label="Browser profile to work in"></div>
    <span class="bb-browser-name"></span>
    <button type="button" class="bb-rescan" title="Look for running browsers again" aria-label="Look for running browsers again">↻</button>
    <button type="button" class="bb-connect bb-primary">Connect</button>
    </div>
    <div class="bb-tools">
    <button type="button" class="bb-octo-settings" title="Octo Browser Settings" aria-label="Octo Browser Settings" aria-expanded="false" aria-controls="octoPanel">
      <span class="bb-octo-mask" aria-hidden="true" style="--octo-mask-image: url('${OCTO_MASK}')"></span>
    </button>
    <button type="button" class="bb-user" title="User Settings" aria-label="User Settings" aria-expanded="false" aria-controls="userPanel">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="7" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h3"/><circle cx="18" cy="17" r="2.5"/><path d="M18 12.5v2M18 19.5v2M13.5 17h2M20.5 17h2M14.8 13.8l1.4 1.4M19.8 18.8l1.4 1.4M14.8 20.2l1.4-1.4M19.8 15.2l1.4-1.4"/>
      </svg>
    </button>
    <button type="button" class="bb-gpt" title="ChatGPT Settings" aria-label="ChatGPT Settings" aria-expanded="false" aria-controls="gptPanel">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="currentColor">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>
      </svg>
    </button>
    <button type="button" class="bb-link" title="Browser Profile" aria-label="Browser Profile" aria-expanded="false" aria-controls="linkPanel">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>
        <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>
      </svg>
    </button>
    <button type="button" class="bb-pin" aria-pressed="true" title="Keep this window above other windows" aria-label="Pin on top">
      <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 17v5"/>
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
      </svg>
    </button>
    </div>
    <div class="bb-status" role="status">Looking for running browsers…</div>`;
  document.body.prepend(bar);
  document.body.prepend(titlebar);
  // User Settings and ChatGPT Settings: the panel's own forms, moved beneath
  // this bar, whose buttons stand in for the ones the panel has.
  let after = bar;
  for (const [selector, panelId, panelButton] of [[".bb-user", "userPanel", "openUserSettings"], [".bb-gpt", "gptPanel", "openChatgpt"]]) {
    const button = bar.querySelector(selector);
    button.addEventListener("click", () => document.getElementById(panelButton)?.click());
    const panel = document.getElementById(panelId);
    if (!panel) continue;
    after.after(panel);
    after = panel;
    new MutationObserver(() => {
      button.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) {
        showLinkPanel(false); // one panel at a time
        showOctoPanel(false);
      }
    }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  }

  const browsersEl = bar.querySelector(".bb-browsers");
  const browserNameEl = bar.querySelector(".bb-browser-name");
  const rescanEl = bar.querySelector(".bb-rescan");
  const tipEl = document.createElement("div");
  tipEl.id = "bidbot-tip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  const connectEl = bar.querySelector(".bb-connect");
  const pinEl = bar.querySelector(".bb-pin");
  const statusEl = bar.querySelector(".bb-status");

  let choices = [];
  let chosen = null;
  let last = { state: "disconnected" };
  let waitingFor = null; // the browser whose debugging is being waited for
  let note = null; // what the app copied from the extension on connecting

  const choice = () => choices.find((c) => c.id === chosen) || null;

  // The browser's name: "Google Chrome", "Microsoft Edge", or "Google Chrome
  // 142" for one the app starts.
  const fullName = (c) => String(c.browser || String(c.label || "?").split(" — ")[0]);
  const letterOf = (name) => (String(name).match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();

  // One circle per profile: each profile with a window open in a running
  // browser — a browser running in the background with no window shows none —
  // then each Chrome the app can start, whose one profile is Bid Bot's own.
  // A circle's key is its browser's id and the profile's folder.
  const SEP = "\u0001";
  const keyOf = (id, dir = "") => `${id}${SEP}${dir}`;
  // Browser profile -> bid profile, by circle key. With any profile linked,
  // only linked ones get a circle, within Chrome and within Octo Browser each:
  // a folder can hold many profiles. A running Octo profile always has one.
  // An Octo profile that is not actually running has no real connection to
  // pick, so it never gets a circle here, linked or not.
  let links = {};
  const profileItems = (list) => {
    const items = allProfileItems(list).filter((item) => !(item.c.octo && item.c.closed));
    const keys = Object.keys(links);
    const narrowed = keys.some((key) => !key.startsWith("octo:"));
    const octoNarrowed = keys.some((key) => key.startsWith("octo:"));
    return items.filter((item) => {
      const linked = links[item.key] != null;
      return item.c.octo ? !octoNarrowed || linked : !narrowed || linked;
    });
  };
  function allProfileItems(list) {
    const items = [];
    for (const c of list.filter((x) => x.group === "running")) {
      for (const p of (c.profiles || []).filter((x) => x.open)) {
        items.push({
          key: keyOf(c.id, p.dir),
          c,
          name: p.name,
          tip: !c.octo ? p.name : `${p.name} · Octo Browser${c.closed ? " · not running" : c.debug ? "" : " · debugging off"}`
        });
      }
    }
    for (const c of list.filter((x) => x.group !== "running")) {
      // A new window rather than a profile already there: a "+" in its circle.
      items.push({ key: keyOf(c.id), c, name: "Bid Bot", mark: "+", tip: "New window" });
    }
    return items;
  }
  // The circle picked: the browser picked, and in a running one its profile.
  function pickedKey() {
    const c = choice();
    if (!c) return null;
    if (c.mode !== "attach") return keyOf(c.id);
    return c.profile ? keyOf(c.id, c.profile.dir) : null;
  }
  // A colour of its own per profile, kept from one scan to the next.
  const AVATAR_COLOURS = ["#6a5fdb", "#12915f", "#d6395a", "#d9822b", "#2b7bd9", "#8a4fbf", "#1f9aa8", "#b5527a"];
  function colourOf(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
  }

  // Arrow keys move the pick, as in any radio group.
  function fillChoices(list, id) {
    const hadFocus = browsersEl.contains(document.activeElement);
    choices = list;
    chosen = id;
    browsersEl.replaceChildren();
    const picked = pickedKey();
    for (const item of profileItems(list)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bb-avatar";
      b.dataset.key = item.key;
      b.textContent = item.mark || letterOf(item.name);
      if (item.mark) b.classList.add("bb-new");
      if (item.c.octo) b.classList.add("bb-octo");
      b.style.background = colourOf(item.key);
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(item.key === picked));
      b.setAttribute("aria-label", item.tip);
      b.tabIndex = item.key === picked ? 0 : -1;
      b.addEventListener("click", () => pick(item.key));
      b.addEventListener("mouseenter", () => showTip(b, item.tip));
      b.addEventListener("mouseleave", hideTip);
      b.addEventListener("focus", () => showTip(b, item.tip));
      b.addEventListener("blur", hideTip);
      browsersEl.appendChild(b);
    }
    hideTip();
    const first = browsersEl.firstElementChild;
    if (first && !browsersEl.querySelector('[tabindex="0"]')) first.tabIndex = 0;
    if (hadFocus) browsersEl.querySelector('[tabindex="0"]')?.focus();
    render(last);
  }

  // Centred under the circle, kept inside the window.
  function showTip(el, text) {
    tipEl.textContent = text;
    tipEl.hidden = false;
    const at = el.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, at.left + at.width / 2 - w / 2));
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${at.bottom + 6}px`;
  }
  function hideTip() {
    tipEl.hidden = true;
  }

  browsersEl.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const avatars = [...browsersEl.querySelectorAll(".bb-avatar")];
    if (!avatars.length) return;
    const at = avatars.findIndex((b) => b.dataset.key === pickedKey());
    const next = avatars[(at + step + avatars.length) % avatars.length];
    const key = next.dataset.key;
    pick(key).then(() => [...browsersEl.children].find((b) => b.dataset.key === key)?.focus());
  });

  function render(s) {
    last = s;
    const connected = s.state === "connected";
    if (connected !== window.bidbotDesktop.connected) {
      window.bidbotDesktop.connected = connected;
      profileChanged();
    }
    const octo = connected && !!s.octo;
    if (octo !== window.bidbotDesktop.octo) {
      window.bidbotDesktop.octo = octo;
      window.dispatchEvent(new Event("bidbot-octo-changed"));
    }
    const c = choice();
    const attach = c?.mode === "attach";
    const needsDebug = attach && !c.debug;
    const needsProfile = attach && !needsDebug && !c.profile;
    const state = s.state === "disconnected" && waitingFor && waitingFor === chosen ? "waiting" : s.state;

    bar.dataset.state = state;
    bar.dataset.error = s.error && s.state === "disconnected" && state !== "waiting" ? "1" : "0";
    for (const b of browsersEl.children) b.disabled = s.state !== "disconnected";
    // Only the profile's name: which browser it is in is the circle's business.
    browserNameEl.textContent = !c ? "" : attach ? c.profile?.name || "" : "New window";
    browserNameEl.title = c?.detail || "";
    rescanEl.disabled = s.state !== "disconnected";
    // While a connection is being made, or waited for, it can be stopped.
    const stoppable = s.state === "connecting" || state === "waiting";
    connectEl.disabled = s.state === "disconnected" && !stoppable && needsProfile;
    connectEl.textContent =
      s.state === "connected" ? "Disconnect"
        : stoppable ? "Stop"
          : needsDebug && !c.octo ? "Turn on debugging"
            : "Connect";
    connectEl.classList.toggle("bb-primary", s.state !== "connected" && !stoppable);
    connectEl.classList.toggle("bb-stop", stoppable);
    if (typeof s.alwaysOnTop === "boolean") pinEl.setAttribute("aria-pressed", String(s.alwaysOnTop));

    const name = c?.browser || c?.label || "the browser";
    if (s.note !== undefined) note = s.note;
    // Connected and connecting say nothing more — the dot and the Connect
    // button say it — unless settings were just copied from the extension.
    statusEl.textContent =
      s.state === "connected"
        ? note || ""
        : s.state === "connecting"
          ? "" // the pulsing dot and "Connecting…" say it
          : state === "waiting" && c?.octo
            ? `In ${c.profile.name}, open chrome://inspect/#remote-debugging and switch on “Allow remote debugging for this browser instance”. Bid Bot connects as soon as it is on.`
          : state === "waiting"
            ? `In ${name}, on the page that just opened, switch on “Allow remote debugging for this browser instance”. Bid Bot connects as soon as it is on.`
            : s.error
              ? `Not connected — ${s.error}`
              : needsDebug && c.octo
                ? c.closed
                  ? `${c.profile.name} is not running. Start it in Octo Browser, then click Connect.`
                  : `${c.profile.name} is open, but its remote debugging is off. Click Connect to see how to turn it on.`
              : needsDebug
                ? `${name} is running, but its remote debugging is off. Click “Turn on debugging”.`
                : needsProfile
                  ? `Pick the ${name} profile Bid Bot should work in — click its circle.`
                  : attach
                  ? ""
                  : !choices.length
                    ? "No Google Chrome found on this PC. Install it from google.com/chrome."
                    : "Not connected. Pick a profile and click Connect, or just press Start.";
    statusEl.hidden = !statusEl.textContent;
  }

  // -------------------------------------------------------------------------
  // Browser Profile: which bid profile each browser profile in use works as.
  // Saved links narrow the circles to those profiles, and the app's main side
  // tells the run which bid profile to use.
  // -------------------------------------------------------------------------

  const linkButton = bar.querySelector(".bb-link");
  const linkPanel = document.createElement("div");
  linkPanel.id = "linkPanel";
  linkPanel.className = "form gpt-panel";
  linkPanel.hidden = true;
  (document.getElementById("gptPanel") || bar).after(linkPanel);

  // Octo Browser Settings: its own panel, opened by the Octo button in the
  // title bar — the API token and folder name used to live inside Browser
  // Profile (linkPanel) itself; pulled out so each button opens exactly one
  // thing, the way the others do.
  const octoButton = bar.querySelector(".bb-octo-settings");
  const octoPanel = document.createElement("div");
  octoPanel.id = "octoPanel";
  octoPanel.className = "form gpt-panel";
  octoPanel.hidden = true;
  linkPanel.after(octoPanel);

  // Bid profiles grouped by country, as a dropdown's options.
  function bidOptions(select, bidProfiles, current) {
    select.append(new Option("— Not linked —", ""));
    const byCountry = new Map();
    for (const p of bidProfiles) {
      const country = String(p.sheet?.country || "").trim() || "No country";
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country).push(p);
    }
    for (const country of [...byCountry.keys()].sort()) {
      const group = document.createElement("optgroup");
      group.label = country;
      for (const p of byCountry.get(country)) {
        group.append(new Option(p.sheet?.role ? `${p.name} · ${p.sheet.role}` : p.name, String(p.id)));
      }
      select.append(group);
    }
    if (current != null) select.value = String(current);
  }

  function linkMessage(text) {
    const p = document.createElement("p");
    p.className = "hint warn";
    p.textContent = text;
    return p;
  }

  function linkNote(text) {
    const p = linkMessage(text);
    p.className = "hint";
    return p;
  }

  // A note confirming something actually succeeded — the green check mark
  // .hint.saved carries everywhere else in the panel (Save on the other
  // settings forms, Load models), not plain neutral text.
  function linkSaved(text) {
    const p = linkMessage(text);
    p.className = "hint saved";
    return p;
  }

  // The API token and folder names, side by side. Save Octo Settings keeps
  // them; Load profiles reads the list again with what is saved. What is
  // typed and not yet saved survives a Load.
  function octoSettings(octo, draft = {}) {
    const form = document.createElement("div");
    // The same two-column field-row every other settings panel uses (see
    // #gptApiFields in sidepanel.html) — each field its own label-over-input
    // column, not the plain inline pairing this form started with.
    const row = (...children) => {
      const div = document.createElement("div");
      div.className = "field-row";
      div.append(...children);
      form.append(div);
    };
    const field = (text, input) => {
      const wrap = document.createElement("div");
      const label = document.createElement("label");
      label.className = "field-label";
      label.htmlFor = input.id;
      label.textContent = text;
      wrap.append(label, input);
      return wrap;
    };
    const token = document.createElement("input");
    token.id = "octoToken";
    token.type = "password";
    token.autocomplete = "off";
    token.spellcheck = false;
    token.placeholder = "From Octo's settings";
    token.value = draft.token ?? (octo.token || "");

    // The folders Octo's own API actually has for this token (loaded with
    // it, in app:octoRefresh) — picked from, the same plain dropdown as the
    // Bid profile field below, rather than typed and matched by hand. A
    // saved name the list does not carry (the token changed, or the fetch
    // failed) stays offered and picked, so it is not silently dropped out
    // from under the saved setting.
    const savedNames = String(draft.folders ?? (octo.folders || ""))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const names = [...new Set([...(octo.allFolders || []).map((f) => f.name), ...savedNames])].sort((a, b) => a.localeCompare(b));
    const folders = document.createElement("select");
    folders.id = "octoFolder";
    folders.append(new Option(names.length ? "— Select —" : "No folders found — save a token first", ""));
    for (const name of names) folders.append(new Option(name, name));
    if (savedNames[0] && names.includes(savedNames[0])) folders.value = savedNames[0];
    const readFolders = () => folders.value;
    row(field("Octo API token", token), field("Folder name", folders));

    const button = (text, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      if (primary) b.className = "primary";
      b.textContent = text;
      return b;
    };
    const save = button("Save Octo Settings", true);
    const load = button("Load profiles");
    // The same two columns as the token/folder fields above (field-row),
    // not a flex row sized by each button's own text — so Save lines up
    // under the token field and Load profiles under the folder field,
    // rather than Save simply being wider because its label is longer.
    const actions = document.createElement("div");
    actions.className = "field-row octo-actions";
    actions.append(save, load);
    form.append(actions);
    const note = document.createElement("div");
    form.append(note);
    const say = (...lines) => note.replaceChildren(...lines);

    save.addEventListener("click", async () => {
      save.disabled = true;
      const reply = await ipcRenderer.invoke("app:saveOcto", { token: token.value.trim(), folders: readFolders() });
      save.disabled = false;
      if (!reply.ok) return say(linkMessage(reply.error));
      say(linkSaved("Octo settings saved. Click Load profiles to see their profiles."));
    });
    load.addEventListener("click", async () => {
      load.disabled = true;
      load.textContent = "Loading…";
      await fillOctoPanel({ token: token.value, folders: readFolders() });
      // Browser Profile's own table reads the saved folder too — kept in
      // step if it is open; if not, it reads fresh next time it is.
      if (!linkPanel.hidden) await fillLinkPanel();
    });

    const unsaved =
      (draft.token !== undefined && draft.token.trim() !== (octo.token || "")) ||
      (draft.folders !== undefined && draft.folders.trim() !== (octo.folders || ""));
    say(
      ...[
        octo.error && linkMessage(octo.error),
        octo.missing?.length && linkMessage(`No folder named ${octo.missing.join(", ")}.`),
        unsaved && linkMessage("Not saved yet — the list below uses the saved settings."),
        octo.ok && octo.count === null && linkNote("Save a token and a folder name, then click Load profiles."),
        octo.ok && octo.count !== null && linkSaved(`${octo.count} profile${octo.count === 1 ? "" : "s"} in ${octo.folders}.`)
      ].filter(Boolean)
    );
    return form;
  }

  function loadingSpinner(text) {
    const row = document.createElement("div");
    row.className = "lp-loading";
    const spinner = document.createElement("span");
    spinner.className = "lp-spinner";
    spinner.setAttribute("aria-hidden", "true");
    row.append(spinner, document.createTextNode(text));
    return row;
  }

  async function fillLinkPanel() {
    linkPanel.replaceChildren(loadingSpinner("Loading Octo and browser profiles…"));
    // What is running now, and what Octo has ready, Octo's profiles first.
    const octo = await ipcRenderer.invoke("app:octoRefresh");
    const scan = await ipcRenderer.invoke("app:scan");
    fillChoices(scan.choices, chosen && scan.choices.some((c) => c.id === chosen) ? chosen : scan.choice);
    const rows = allProfileItems(choices).filter((item) => item.c.mode === "attach");
    // Only the Octo profiles actually running now — one not open has no tab
    // to link a bid profile to yet, and only clutters the list until it is.
    const octoRows = rows.filter((item) => item.c.octo && !item.c.closed);
    const browserRows = rows.filter((item) => !item.c.octo);
    const reply = await ipcRenderer.invoke("rt:send", { type: "GET_PROFILES" }).catch((err) => ({ ok: false, error: err.message }));
    linkPanel.replaceChildren(); // the loading spinner's done its job
    if (!reply?.ok) return linkPanel.append(linkMessage(`Could not load the bid profiles: ${reply?.error || "no answer"}`));

    const head = document.createElement("div");
    head.className = "lp-head";
    for (const text of ["Browser profile", "Bid profile"]) {
      const label = document.createElement("span");
      label.className = "field-label";
      label.textContent = text;
      head.append(label);
    }
    const selects = new Map();
    // The browser's own icon stands for "Octo Browser" / "Google Chrome"
    // now — not Edge, Brave, or one of Chrome's own other channels
    // (Beta/Dev/Canary), which still get the name itself, as before.
    const browserIcon = (c) => {
      const browserLabel = fullName(c);
      return browserLabel === "Octo Browser" ? OCTO_ICON : browserLabel === "Google Chrome" ? CHROME_ICON : "";
    };
    const addRow = (item) => {
      const row = document.createElement("div");
      row.className = "lp-row";
      const name = document.createElement("span");
      name.className = "lp-name";
      name.title = item.name;
      const browserLabel = fullName(item.c);
      const icon = browserIcon(item.c);
      if (icon) {
        const img = document.createElement("img");
        img.src = icon;
        img.alt = browserLabel;
        img.title = browserLabel;
        img.className = "lp-browser-icon";
        name.append(img);
      }
      const nameText = document.createElement("span");
      nameText.className = "lp-name-text";
      nameText.textContent = item.name;
      name.append(nameText);
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Bid profile for ${item.name}`);
      bidOptions(select, reply.profiles, links[item.key]);
      selects.set(item.key, select);
      row.append(name, select);
      linkPanel.append(row);
    };

    if (octoRows.length || browserRows.length) linkPanel.append(head);
    if (octoRows.length) octoRows.forEach(addRow);
    else {
      linkPanel.append(
        linkMessage(
          octo.count === 0
            ? "Those folders have no profiles."
            : octo.folders
              ? "No Octo Browser profile is running — start one in Octo Browser."
              : "No folder set — open Octo Browser Settings (the Octo button) to pick one."
        )
      );
    }
    if (browserRows.length) browserRows.forEach(addRow);
    else linkPanel.append(linkMessage("No browser profile is open."));

    const actions = document.createElement("div");
    actions.className = "controls form-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Save";
    save.addEventListener("click", async () => {
      // Links of profiles not open now are kept.
      const next = { ...links };
      for (const [key, select] of selects) {
        if (select.value) next[key] = Number(select.value);
        else delete next[key];
      }
      links = await ipcRenderer.invoke("app:saveLinks", next);
      profileChanged();
      showLinkPanel(false);
      fillChoices(choices, chosen);
      // The profile being worked in may no longer have a circle.
      const first = profileItems(choices)[0];
      if (first && !profileItems(choices).some((item) => item.key === pickedKey())) pick(first.key);
    });
    actions.append(save);
    linkPanel.append(actions);
  }

  // Same slide as the extension's own settings panels (sidepanel.js's
  // setPanelVisible, duplicated here since this script and that one never
  // share scope) — linkPanel carries the same .gpt-panel class, and so the
  // same CSS transition, as gptPanel/userPanel/searchPanel.
  function setPanelVisible(el, open) {
    if (open) {
      el.hidden = false;
      el.classList.add("slide-animating");
      el.style.maxHeight = "0px";
      void el.offsetHeight;
      const target = el.scrollHeight;
      el.classList.add("slide-open");
      el.style.maxHeight = `${target}px`;
      el.addEventListener(
        "transitionend",
        () => {
          el.classList.remove("slide-animating");
          el.style.maxHeight = "none";
        },
        { once: true }
      );
    } else {
      if (el.hidden) return;
      el.classList.add("slide-animating");
      el.style.maxHeight = `${el.scrollHeight}px`;
      void el.offsetHeight;
      el.classList.remove("slide-open");
      el.style.maxHeight = "0px";
      el.addEventListener(
        "transitionend",
        () => {
          el.classList.remove("slide-animating");
          el.hidden = true;
          el.style.maxHeight = "";
        },
        { once: true }
      );
    }
  }

  function showLinkPanel(open) {
    linkButton.setAttribute("aria-expanded", String(open));
    if (!open) {
      setPanelVisible(linkPanel, open);
      return;
    }
    for (const [panelId, panelButton] of [["gptPanel", "openChatgpt"], ["userPanel", "openUserSettings"], ["searchPanel", "openSearch"]]) {
      const panel = document.getElementById(panelId);
      if (panel && !panel.hidden) document.getElementById(panelButton)?.click();
    }
    showOctoPanel(false);
    fillLinkPanel();
    setPanelVisible(linkPanel, open);
  }

  linkButton.addEventListener("click", () => showLinkPanel(linkPanel.hidden));

  async function fillOctoPanel(draft) {
    octoPanel.replaceChildren(loadingSpinner("Loading Octo Browser settings…"));
    const octo = await ipcRenderer.invoke("app:octoRefresh");
    octoPanel.replaceChildren(octoSettings(octo, draft));
  }

  function showOctoPanel(open) {
    octoButton.setAttribute("aria-expanded", String(open));
    if (!open) {
      setPanelVisible(octoPanel, open);
      return;
    }
    for (const [panelId, panelButton] of [["gptPanel", "openChatgpt"], ["userPanel", "openUserSettings"], ["searchPanel", "openSearch"]]) {
      const panel = document.getElementById(panelId);
      if (panel && !panel.hidden) document.getElementById(panelButton)?.click();
    }
    showLinkPanel(false);
    fillOctoPanel();
    setPanelVisible(octoPanel, open);
  }

  octoButton.addEventListener("click", () => showOctoPanel(octoPanel.hidden));

  // The panel's Recruiter Bid list follows the bid profile.
  const profileChanged = () => window.dispatchEvent(new Event("bidbot-profile-changed"));

  // Search Settings stays in the panel, by the job site menu: still one
  // settings panel at a time.
  const searchPanel = document.getElementById("searchPanel");
  if (searchPanel) {
    new MutationObserver(() => {
      if (!searchPanel.hidden) {
        showLinkPanel(false);
        showOctoPanel(false);
      }
    }).observe(searchPanel, { attributes: true, attributeFilter: ["hidden"] });
  }

  let pickedByHand = false; // a pick made before the first scan has answered
  // A circle picks its browser and, in a running one, the profile to work in.
  async function pick(key) {
    if (last.state !== "disconnected") return;
    pickedByHand = true;
    waitingFor = null;
    if (key === pickedKey()) return;
    const [id, dir] = key.split(SEP);
    const c = choices.find((x) => x.id === id);
    if (!c) return;
    if (c.mode === "attach") {
      // Shown picked at once; the app's own answer follows.
      const profile = c.profiles.find((p) => p.dir === dir);
      fillChoices(choices.map((x) => (x === c ? { ...x, profile } : x)), id);
      render({ ...last, error: null });
      const reply = await ipcRenderer.invoke("app:chooseProfile", id, dir);
      if (reply.ok) fillChoices(reply.choices, reply.choice);
      else render({ ...last, error: reply.error });
      profileChanged();
      return;
    }
    fillChoices(choices, id);
    render({ ...last, error: null });
    await ipcRenderer.invoke("app:choose", id);
    profileChanged();
  }

  rescanEl.addEventListener("click", async () => {
    statusEl.textContent = "Looking for running browsers…";
    statusEl.hidden = false;
    const s = await ipcRenderer.invoke("app:scan");
    fillChoices(s.choices, s.choice);
  });

  let stopping = false; // Stop pressed: the connect it ended is no error
  connectEl.addEventListener("click", async () => {
    if (last.state !== "disconnected" || waitingFor) {
      stopping = last.state === "connecting";
      waitingFor = null;
      render(await ipcRenderer.invoke("app:disconnect"));
      return;
    }
    stopping = false;
    const c = choice();
    if (c?.mode === "attach" && !c.debug) {
      const reply = await ipcRenderer.invoke("app:enableDebug");
      if (reply.ok && !reply.already) {
        waitingFor = c.id;
        render({ state: "disconnected" });
        return;
      }
      if (!reply.ok) return render({ state: "disconnected", error: reply.error });
    }
    render({ state: "connecting" });
    const reply = await ipcRenderer.invoke("app:connect");
    if (!reply.ok && !stopping) render({ state: "disconnected", error: reply.error });
  });

  pinEl.addEventListener("click", async () => {
    const on = pinEl.getAttribute("aria-pressed") !== "true";
    pinEl.setAttribute("aria-pressed", String(await ipcRenderer.invoke("app:onTop", on)));
  });

  ipcRenderer.on("app:status", (_e, s) => {
    if (s.state !== "disconnected") waitingFor = null;
    render(s);
  });
  ipcRenderer.on("app:choices", (_e, s) => {
    // The list is refreshed, not the choice: a pick made a moment ago is left
    // alone. What is picked stays picked, even if the refresh was sent
    // before that pick was saved; only a browser that has gone falls back.
    const keep = chosen && s.choices.some((c) => c.id === chosen) ? chosen : s.choice;
    fillChoices(s.choices, keep);
  });

  // The first scan takes a second or two. A browser picked meanwhile stays
  // picked; the scan only fills in the list around it.
  ipcRenderer.invoke("app:state").then(async (s) => {
    last = s;
    links = (await ipcRenderer.invoke("app:links")) || {};
    if (pickedByHand && chosen && s.choices.some((c) => c.id === chosen)) {
      await ipcRenderer.invoke("app:choose", chosen);
      fillChoices(s.choices, chosen);
    } else {
      fillChoices(s.choices, s.choice);
    }
  });
}

// Finished actions, told to the main process so it can pop a notification up
// above the tray icon. The panel already reports each one in a status line;
// these are the lines and the states that mean "done" rather than "working"
// or "went wrong":
//   #status       the run: a batch done, every search term done, the feed
//                 done (plain, or "live" for a batch done mid-run)
//   #manualStatus Generate → Manual: the resume saved ("saved")
//   #rbStatus     Recruiter Bid: the email sent ("success")
function watchFinishedActions() {
  const done = {
    status: (el, text) => {
      const kind = el.className.trim();
      if (kind === "live") return /^Batch \d+ done\b/.test(text);
      return kind === "" && /\bdone\b/i.test(text);
    },
    manualStatus: (el) => el.classList.contains("saved"),
    rbStatus: (el) => el.classList.contains("success")
  };
  const last = {};
  for (const [id, isDone] of Object.entries(done)) {
    const el = document.getElementById(id);
    if (!el) continue;
    last[id] = el.textContent.trim();
    new MutationObserver(() => {
      const text = el.textContent.trim();
      if (el.hidden || !text) { last[id] = ""; return; }
      if (text === last[id]) return;
      last[id] = text;
      if (isDone(el, text)) ipcRenderer.send("app:actionDone", text);
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
  }
}

function onPanelReady() {
  buildBar();
  watchFinishedActions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", onPanelReady);
} else {
  onPanelReady();
}
