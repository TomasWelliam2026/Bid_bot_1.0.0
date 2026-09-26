---
name: verify
description: Verify jobright-monitor (the Chrome MV3 side-panel extension) by actually running its real code in a browser — no real extension host is available, so this launches a small local server that serves the genuine sidepanel.html/css/js and background.js and bridges them together.
---

# Verifying jobright-monitor

This is a Chrome MV3 extension (`sidepanel.html`/`.css`/`.js` = the side
panel page, `background.js` = the service worker). There is no packaged
build step — the files run as-is — but there is also no real extension host
in this environment (no `chrome://extensions`, no real `chrome.*` APIs), so
the side panel can't just be opened as a bare `file://` page: that renders
an inert, unstyled snapshot with no JS execution at all.

## Launch

Use `harness-server.js` in this directory. It serves the **real, unmodified**
`sidepanel.html`, `sidepanel.css`, `sidepanel.js` and `background.js` from
the `jobright-monitor/` root, with a small stub spliced into the served HTML
(only into the HTML — the JS/CSS files themselves are untouched) that:

- bridges `chrome.runtime.onMessage`/`.sendMessage` in-page, so
  `sidepanel.js`'s real `send()` calls and `background.js`'s real `handle()`
  dispatch actually talk to each other;
- stubs `chrome.storage.local` and `chrome.action` (enough for `background.js`
  to load and run without throwing);
- stubs `window.fetch` **only** for `api.openai.com`, so the real
  request-building and response-parsing code runs, with a fake network at
  the very edge (no OpenAI key or spend needed). **Edit the canned responses
  in the stub for whatever you're testing this session** — it's a starting
  template, not a fixed contract. The file's own header comment has the
  gotchas that shaped its design (module-scope collisions, real
  `chrome.runtime` reply semantics, `AbortSignal` handling) — read it before
  changing the bridge/stub logic, not just the canned responses.

Either run it directly:

```bash
node jobright-monitor/.claude/skills/verify/harness-server.js
```

and open `http://localhost:5759/sidepanel.html` in the Browser pane, or add
it to `.claude/launch.json` at the workspace root and use `preview_start`:

```json
{
  "version": "0.0.1",
  "configurations": [{
    "name": "jobright-monitor-verify",
    "runtimeExecutable": "node",
    "runtimeArgs": ["jobright-monitor/.claude/skills/verify/harness-server.js"],
    "port": 5759
  }]
}
```

**`.claude/launch.json` at the workspace root is scratch — remove it when
done** (it's not part of this project's own config; it's only how
`preview_start` finds a command to run). `harness-server.js` itself is the
thing worth keeping.

**Restart after editing `harness-server.js`.** Node does not hot-reload;
`preview_stop` + `preview_start` again (or re-run `node ...`) before
re-testing, or you'll be driving the old stub.

## What a fresh load looks like

Status line reads `Idle.` (not `Error: …`) — that confirms `GET_STATE` and
`GET_PROFILE` round-tripped through the real bridge into the real
`background.js` and back. The **Model** dropdown defaults to `gpt-4o-mini`
and **Prompt** is pre-filled with the real default prompt text from
`background.js`'s `PROFILE_DEFAULTS` — if you see an empty prompt or a
different default model, something in the bridge broke, not the feature
you're testing.

## Flows worth driving

- **Generate/Job bid tabs** (`#mainTabs`) and **Settings → ChatGPT
  setting/Resume style tabs** (`#settingsTabs`, inside the gear icon's
  panel) — two independent tab strips; arrow-key nav and selection should
  stay scoped to whichever one you're in, and picking a top-level tab while
  Settings is open should close Settings.
- **Test connection** (in the ChatGPT setting tab) — reads the *current*
  API key/model fields (not the saved profile). Drive both the failure path
  (fetch stub returns non-ok) and the success path through the real
  `testConnection()` in `background.js`; the OpenAI request is intercepted
  by the harness's `fetch` stub, not real. To exercise the **20s timeout**
  path for real (`TEST_TIMEOUT_MS` in `background.js`), the stub must
  actually listen to the passed `AbortSignal` — see gotcha #4 in
  `harness-server.js`'s header — and you do have to wait out the real 20s.

## Gotchas (see also the header comment in harness-server.js)

- **Refs from `find`/`read_page` can go stale across navigations in this
  harness** — a click on a stale ref failed with "outside the viewport"
  while the page was, unexplainedly, already in a different state than the
  last screenshot showed. If a click's result doesn't match what you just
  saw, don't chase it — close the tab, open a fresh one, `navigate` again,
  and re-verify from a screenshot you just took.
- **`read_console_messages` can report errors from a *previous* load**,
  not the current one — it did not visibly clear across a `navigate` to the
  same origin in this environment. Prefer checking actual current state
  directly (e.g. `javascript_tool` reading `document.getElementById(...)`
  or a fresh `fetch` of the served HTML) over trusting a console-messages
  call to be scoped to "since the last navigation."
- Custom viewport sizes via `resize_window` did not actually constrain
  `window.innerWidth` for this local harness in this environment (screenshots
  rendered at the requested size, but `getBoundingClientRect()`/`innerWidth`
  in the page still reported the full untruncated width). To test narrow-panel
  CSS behavior, inject a real width constraint directly, e.g.:
  ```js
  const s = document.createElement('style');
  s.textContent = 'html, body { width: 260px !important; max-width: 260px !important; }';
  document.head.appendChild(s);
  ```
  then re-measure with `getBoundingClientRect()`.
