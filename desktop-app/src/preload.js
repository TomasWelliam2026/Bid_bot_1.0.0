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
  checkBrowser: () => ipcRenderer.invoke("app:checkBrowser")
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
  gap: 11px;
  height: 60px;
  padding: 0 10px 0 12px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bt-teal) 9%, var(--surface, #fff)), var(--surface, #fff));
  color: var(--fg, #1d1d27);
  font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  -webkit-app-region: drag;
  user-select: none;
}
#bidbot-titlebar .bt-logo {
  flex: none;
  width: 46px;
  height: 46px;
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
#bidbot-titlebar .bt-buttons {
  flex: none;
  display: flex;
  gap: 2px;
  align-self: flex-start;
  margin-top: 8px;
}
#bidbot-titlebar .bt-btn {
  width: 30px;
  min-width: 0;
  height: 30px;
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  background: var(--surface, #fff);
  border-bottom: 1px solid var(--line, #dcdce6);
  font: 12px/1.4 system-ui, "Segoe UI", sans-serif;
  color: var(--fg, #1d1d27);
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
  padding: 3px 2px 3px 9px; /* room for the first circle's overlap and the ring */
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
  height: 28px;
  padding: 0 10px;
  font: inherit;
  font-weight: 600;
  color: var(--fg, #1d1d27);
  background: var(--bg, #f6f6fa);
  border: 1px solid var(--line, #dcdce6);
  border-radius: 6px;
  cursor: pointer;
}
#bidbot-bar button:hover:not(:disabled) { border-color: var(--accent, #6a5fdb); }
#bidbot-bar button:disabled { opacity: 0.55; cursor: default; }
#bidbot-bar button.bb-primary {
  color: var(--accent-fg, #fff);
  background: var(--accent, #6a5fdb);
  border-color: var(--accent, #6a5fdb);
}
#bidbot-bar .bb-rescan,
#bidbot-bar .bb-browse,
#bidbot-bar .bb-pin { width: 28px; min-width: 0; padding: 0; font-size: 14px; }
#bidbot-bar .bb-pin svg { display: block; margin: auto; }
#bidbot-bar button.bb-pin[aria-pressed="true"] {
  color: var(--accent, #6a5fdb);
  background: var(--accent-soft, #ece9fb);
  border-color: var(--accent-line, #c7bff3);
}
#bidbot-bar .bb-status {
  flex: 1 0 100%;
  min-width: 0;
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

  // The logo and wordmark follow the panel's theme (data-theme on <html>,
  // set by its light/dark switch).
  const followTheme = () => (titlebar.dataset.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  followTheme();
  new MutationObserver(followTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  ipcRenderer.invoke("win:isMaximized").then(showMaximized, () => {});

  bar.innerHTML = `
    <span class="bb-dot" aria-hidden="true"></span>
    <div class="bb-browsers" role="radiogroup" aria-label="Browser profile to work in"></div>
    <span class="bb-browser-name"></span>
    <button type="button" class="bb-rescan" title="Look for running browsers again" aria-label="Look for running browsers again">↻</button>
    <button type="button" class="bb-browse" title="Browse for chrome.exe…" aria-label="Browse for chrome.exe">…</button>
    <button type="button" class="bb-connect bb-primary">Connect</button>
    <button type="button" class="bb-pin" aria-pressed="true" title="Keep this window above other windows" aria-label="Pin on top">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 17v5"/>
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
      </svg>
    </button>
    <div class="bb-status" role="status">Looking for running browsers…</div>`;
  document.body.prepend(bar);
  document.body.prepend(titlebar);

  const browsersEl = bar.querySelector(".bb-browsers");
  const browserNameEl = bar.querySelector(".bb-browser-name");
  const rescanEl = bar.querySelector(".bb-rescan");
  const browseEl = bar.querySelector(".bb-browse");
  const tipEl = document.createElement("div");
  tipEl.id = "bidbot-tip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  const connectEl = bar.querySelector(".bb-connect");
  const pinEl = bar.querySelector(".bb-pin");
  const statusEl = bar.querySelector(".bb-status");
  const BROWSE = "__browse__";

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
  function profileItems(list) {
    const items = [];
    for (const c of list.filter((x) => x.group === "running")) {
      for (const p of (c.profiles || []).filter((x) => x.open)) {
        items.push({
          key: keyOf(c.id, p.dir),
          c,
          name: p.name,
          tip: p.name
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

  browseEl.addEventListener("click", () => pick(BROWSE));

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
    const c = choice();
    const attach = c?.mode === "attach";
    const needsDebug = attach && !c.debug;
    const needsProfile = attach && !needsDebug && !c.profile;
    const state = s.state === "disconnected" && waitingFor && waitingFor === chosen ? "waiting" : s.state;

    bar.dataset.state = state;
    bar.dataset.error = s.error && s.state === "disconnected" && state !== "waiting" ? "1" : "0";
    for (const b of browsersEl.children) b.disabled = s.state !== "disconnected";
    browseEl.disabled = s.state !== "disconnected";
    // Only the profile's name: which browser it is in is the circle's business.
    browserNameEl.textContent = !c ? "" : attach ? c.profile?.name || "" : "New window";
    browserNameEl.title = c?.detail || "";
    rescanEl.disabled = s.state !== "disconnected";
    connectEl.disabled = s.state === "connecting" || state === "waiting" || (s.state === "disconnected" && needsProfile);
    connectEl.textContent =
      s.state === "connected" ? "Disconnect"
        : s.state === "connecting" ? "Connecting…"
          : state === "waiting" ? "Waiting…"
            : needsDebug ? "Turn on debugging"
              : "Connect";
    connectEl.classList.toggle("bb-primary", s.state !== "connected");
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
          : state === "waiting"
            ? `In ${name}, on the page that just opened, switch on “Allow remote debugging for this browser instance”. Bid Bot connects as soon as it is on.`
            : s.error
              ? `Not connected — ${s.error}`
              : needsDebug
                ? `${name} is running, but its remote debugging is off. Click “Turn on debugging”.`
                : needsProfile
                  ? `Pick the ${name} profile Bid Bot should work in — click its circle.`
                  : attach
                  ? `Ready to work in ${c.profile.name}. Click Connect, or just press Start.`
                  : !choices.length
                    ? "No Google Chrome found on this PC. Install it from google.com/chrome, or pick its chrome.exe with “Browse for chrome.exe…”."
                    : "Not connected. Pick a profile and click Connect, or just press Start.";
    statusEl.hidden = !statusEl.textContent;
  }

  let pickedByHand = false; // a pick made before the first scan has answered
  // A circle picks its browser and, in a running one, the profile to work in.
  async function pick(key) {
    if (last.state !== "disconnected") return;
    pickedByHand = true;
    waitingFor = null;
    if (key === BROWSE) {
      const picked = await ipcRenderer.invoke("app:browse");
      if (picked) fillChoices(picked.choices, picked.choice);
      return;
    }
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
      return;
    }
    fillChoices(choices, id);
    render({ ...last, error: null });
    await ipcRenderer.invoke("app:choose", id);
  }

  rescanEl.addEventListener("click", async () => {
    statusEl.textContent = "Looking for running browsers…";
    statusEl.hidden = false;
    const s = await ipcRenderer.invoke("app:scan");
    fillChoices(s.choices, s.choice);
  });

  connectEl.addEventListener("click", async () => {
    if (last.state === "connected") {
      render(await ipcRenderer.invoke("app:disconnect"));
      return;
    }
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
    if (!reply.ok) render({ state: "disconnected", error: reply.error });
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
    if (pickedByHand && chosen && s.choices.some((c) => c.id === chosen)) {
      await ipcRenderer.invoke("app:choose", chosen);
      fillChoices(s.choices, chosen);
    } else {
      fillChoices(s.choices, s.choice);
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", buildBar);
} else {
  buildBar();
}
