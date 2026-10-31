# Bid Bot for Windows

The Jobright Live Feed extension as a Windows app. One small window that
stays on top of your other windows and can be resized, with the extension's
own panel inside it — Generate, Auto Fill, Settings, all of it. You pick which
Google Chrome to use, press **Start**, and the app drives that Chrome.

## How it works

- **Chrome is driven through MCP.** The app is an MCP client. It starts
  Google's [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  (`chrome-devtools-mcp`) and does everything in the browser through its tools:
  `list_pages`, `new_page`, `select_page`, `close_page` and `evaluate_script`.
- **The extension's code is used as-is, not copied.** `background.js` (the
  whole job pipeline: find, filter, open, write the resume, save, next page)
  runs in the app's main process; `sidepanel.html` is the window; the
  `content-*.js` scripts run inside the Chrome pages. All of it is read from
  `../jobright-monitor`, so a fix there is a fix here.
- **`chrome.*` is provided by the app.** `src/chrome-api.js` gives
  `background.js` the `chrome.tabs`, `chrome.scripting`, `chrome.storage` and
  `chrome.runtime` it expects, built on the MCP server. `src/page-bridge.js`
  gives each Chrome page the `chrome.runtime` messaging its content script
  expects.

```
 ┌──────────── Bid Bot window (always on top) ────────────┐
 │ browser bar: [Google Chrome 141 ▾] [Connect] [Pin]     │
 │ sidepanel.html (the extension's panel)                 │
 └───────────────▲────────────────────────────────────────┘
                 │ IPC (chrome.runtime / tabs / scripting)
 ┌───────────────┴──── main process ──────────────────────┐
 │ background.js  ←→  chrome-api.js  ←→  mcp-browser.js   │
 └──────────────────────────────────────▲─────────────────┘
                                        │ MCP over stdio
                       chrome-devtools-mcp ──CDP──▶ Google Chrome
                                                    └ content-*.js in each page
```

## Run it

```bash
cd desktop-app
npm install
npm start
```

## Picking a browser

The menu in the bar has two groups.

**Running now** — every Chrome, Edge or Brave open on this PC, named by the
profiles open in it (`Google Chrome · General, Sondhey, Crypt`). Pick one and
its profiles are listed under the menu: the open ones highlighted, the rest
plain. A browser started on a data folder of its own is named by that folder.
The list is read again whenever you come back to the window, or with **↻**.

- With its remote debugging on, **Connect** connects to it as it is — your
  own profiles, tabs and sign-ins. The first time, the browser asks
  “Allow remote debugging?”: click Allow.
- With it off, the button reads **Turn on debugging**. That opens
  `chrome://inspect/#remote-debugging` in that browser; switch on
  “Allow remote debugging for this browser instance” there, and the app
  connects by itself as soon as it is on (Chrome 144 or newer).
- **Disconnect** lets go of the browser; it stays open. The run's own tabs
  are the only ones the app opens or closes.

**One profile, picked by name.** Under the menu, a running browser's profiles
are listed; pick the one Bid Bot should work in (a closed one can be picked
too — it opens a window when the run starts). Connect stays off until one is
picked, and while connected the choice is locked; disconnect to pick another.
The pick is remembered per browser.

With a profile picked, Bid Bot works in that profile only:

- Every tab it opens is opened in that profile, by handing the URL to the
  browser's own exe with `--profile-directory` (Chrome's debugging protocol
  cannot choose a profile for a new tab).
- Job-board tabs you open yourself in that profile are caught too, as in the
  extension: Bid Bot takes such a tab over, its cards stream into the list,
  and Start uses it instead of opening another. Chrome cannot say which
  profile a tab is in, so Bid Bot tells by the profile's own site storage —
  each job-board page it opens in the profile leaves a marker
  (`__bidbot_profile`) there, which every tab on that site in the same
  profile sees and a tab in another profile never does. So your own tabs on
  a site are recognised once Bid Bot has opened that site in the profile at
  least once.
- Everything else is left alone. Only job-board tabs (the sites in the
  extension's manifest) are ever asked for that one key; your other tabs —
  in that profile or any other — are never read, listed or touched.

**Start a new browser** — a Chrome installed on this PC (Stable, Beta, Dev,
Canary — per machine and per user), started by the app on a profile of its
own, kept between runs in `%APPDATA%\bid-bot-desktop\chrome-profiles\`. Sign in
to the job sites once there and it stays signed in. **Browse for
chrome.exe…** adds any other build.

Pressing **Start** without connecting first connects to the browser picked
in the menu.

**Pin on top** keeps the window above other windows; click it to let other
windows cover it. The window remembers its size, position and pin.

## Your extension settings come along

The app keeps its own settings, separate from the extension's, and starts
with none — without a Country and Role, Start stops at "no country and role
picked". So when it connects to a running browser that has the Jobright
Live Feed extension, it copies over whatever it is missing: the API key and
model, Country and Role, the prompt, resume styles, Auto Fill and the theme.
They are read from the extension in the profile you picked, or — if it is
not installed there — from the profile of that browser that has it (one of
its pages opens there for a moment and closes again). Anything already set
in the app is kept as it is, and the job list is not copied. The bar says
what was copied and from where.

## Where things are kept

`%APPDATA%\bid-bot-desktop\`:

| File | What |
|---|---|
| `extension-storage.json` | What the extension keeps in `chrome.storage.local`: API key, model, Country/Role, the job list |
| `app-settings.json` | The browser picked, the pin, the window's size and position |
| `chrome-profiles\` | The Chrome profiles the app launches |

## Files

| File | |
|---|---|
| `src/main.js` | The window, the browser choice, IPC |
| `src/preload.js` | The panel's `chrome.*`, and the browser bar |
| `src/engine.js` | Loads `background.js` against the app's `chrome` |
| `src/chrome-api.js` | `chrome.tabs` / `scripting` / `storage` / `runtime` for `background.js` |
| `src/mcp-browser.js` | The MCP client: Chrome's tabs, kept up to date by polling each page |
| `src/page-bridge.js` | What runs inside each page so a content script can send and receive messages |
| `src/chrome-finder.js` | Finds the Chrome installs |
