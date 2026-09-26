// Verification harness for jobright-monitor — a Chrome MV3 extension with no
// real extension host available to a coding agent. Serves the real
// sidepanel.html, sidepanel.css, sidepanel.js and background.js UNMODIFIED,
// and injects a stub (spliced into sidepanel.html only, before its own
// <script> tag) that:
//
//   - implements chrome.runtime.onMessage / .sendMessage as an in-page
//     bridge, so background.js's real onMessage listener and sidepanel.js's
//     real chrome.runtime.sendMessage calls talk to each other exactly as
//     they would across the extension's real message-passing boundary;
//   - stubs chrome.storage.local (get/set against a plain in-page object);
//   - stubs chrome.action (badge calls background.js makes in passing);
//   - stubs window.fetch ONLY for api.openai.com, so the real request-build
//     and response-parse code in background.js runs, with a fake network at
//     the very edge standing in for OpenAI (no real key/spend needed).
//
// Everything else — DOM, event wiring, message dispatch inside handle(),
// request construction, response parsing, UI update — is the real shipped
// code. This is meaningfully more faithful than stubbing sidepanel.js's
// chrome.runtime.sendMessage to return canned replies directly: that
// approach never actually executes background.js at all.
//
// Usage:
//   node harness-server.js            # serves on http://localhost:5759
//   open http://localhost:5759/sidepanel.html in the Browser pane
//
// Or via .claude/launch.json + preview_start (so the Browser pane's
// preview_* tools manage the process):
//   { "version": "0.0.1", "configurations": [{
//       "name": "jobright-monitor-verify",
//       "runtimeExecutable": "node",
//       "runtimeArgs": ["jobright-monitor/.claude/skills/verify/harness-server.js"],
//       "port": 5759
//   }]}
//
// Gotchas hit building this, left here so they are not re-discovered:
//
//   1. background.js and sidepanel.js both declare top-level
//      `const DEFAULT_RESUME_STYLE`. In the real extension they run in
//      separate global scopes (service worker vs. panel page) so this never
//      collides. Loading both as classic <script> tags in one document
//      throws "Identifier has already been declared". Fix: load both as
//      type="module" (each module gets its own top-level scope).
//
//   2. Module scripts are deferred (they run after parsing, in document
//      order among themselves) while a classic <script> runs immediately at
//      its position. Mixing — background.js as a module, sidepanel.js as a
//      classic script — let sidepanel.js run FIRST, before background.js had
//      registered its onMessage listener, so sidepanel's init() calls got no
//      reply. Fix: make BOTH type="module", so both defer and still execute
//      in the intended (document) order.
//
//   3. Real chrome.runtime.onMessage semantics: a listener's plain return
//      value (true/false/undefined) only signals whether THAT listener will
//      call sendResponse asynchronously — it is never itself the reply.
//      sidepanel.js registers its OWN onMessage listener too (for JOB_ADDED
//      etc. broadcasts) which returns `false` for message types it does not
//      recognise, TEST_CONNECTION/GET_STATE/GET_PROFILE/... included. A
//      sendMessage stub that (wrongly) treats a listener's return value as
//      the reply will resolve with sidepanel's own `false` before
//      background.js's real async answer ever lands. Fix: only ever resolve
//      from an explicit sendResponse(...) call, never from a return value.
//
//   4. A fetch stub for a signal-bearing request must actually listen to the
//      passed AbortSignal and reject when it fires. background.js passes
//      `signal: AbortSignal.timeout(N)` to test real timeout handling; a
//      stub that just does `await new Promise(() => {})` to simulate "never
//      answers" will hang forever regardless of that signal, because the
//      stub — not being the real fetch — never wires the two together on
//      its own.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PORT = 5759;

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml"
};

const STUB = `<script>
window.__bgListeners = [];
window.__storage = {};

window.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { window.__bgListeners.push(fn); } },
    // See gotcha #3 above: only sendResponse(...) ever resolves this — a
    // listener's return value is never treated as the reply.
    sendMessage(msg) {
      return new Promise((resolve) => {
        let responded = false;
        const sendResponse = (reply) => { if (!responded) { responded = true; resolve(reply); } };
        for (const fn of window.__bgListeners) {
          try { fn(msg, { tab: undefined }, sendResponse); }
          catch (err) { if (!responded) { responded = true; resolve({ ok: false, error: String(err) }); } }
        }
      });
    }
  },
  storage: {
    local: {
      get(keys) {
        const out = {};
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(window.__storage);
        for (const k of list) if (k in window.__storage) out[k] = window.__storage[k];
        return Promise.resolve(out);
      },
      set(obj) {
        Object.assign(window.__storage, obj);
        return Promise.resolve();
      }
    }
  },
  action: { setBadgeText() { return Promise.resolve(); }, setBadgeBackgroundColor() { return Promise.resolve(); } }
};

// Only api.openai.com is intercepted. EDIT THE RESPONSES BELOW per what
// you're actually testing this session — this is a starting template, not a
// fixed contract. Keep gotcha #4 in mind for any "never responds" case.
const REAL_FETCH = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  if (typeof url === "string" && url.includes("api.openai.com")) {
    const auth = (opts && opts.headers && opts.headers.Authorization) || "";
    const body = JSON.parse((opts && opts.body) || "{}");

    if (auth === "Bearer fail") {
      return {
        ok: false, status: 401, statusText: "Unauthorized",
        json: async () => ({ error: { message: "Incorrect API key provided" } })
      };
    }

    if (auth === "Bearer timeout") {
      return new Promise((_, reject) => {
        const signal = opts && opts.signal;
        if (!signal) return; // caller passed no signal — this would hang for real too
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }

    // Default: echo the model and a canned reply back in the real OpenAI
    // chat-completions response shape.
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => ({
        model: body.model,
        choices: [{ message: { content: "OK" } }]
      })
    };
  }
  return REAL_FETCH(url, opts);
};
</script>
`;

http.createServer((req, res) => {
  const reqPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.join(ROOT, reqPath === "/" ? "/sidepanel.html" : reqPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found: " + reqPath);
      return;
    }
    const ext = path.extname(filePath);
    if (ext === ".html") {
      const withStub = data.toString("utf8").replace(
        '<script src="sidepanel.js">',
        STUB + '<script type="module" src="background.js"></script>\n  <script type="module" src="sidepanel.js">'
      );
      res.writeHead(200, { "Content-Type": TYPES[ext] });
      res.end(withStub);
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`verify harness serving ${ROOT} on http://localhost:${PORT}`));
