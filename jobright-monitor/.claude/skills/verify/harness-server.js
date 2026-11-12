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

// The extension talks to the collector at http://localhost:4500 — on this
// machine, that is the real archive. Set HARNESS_COLLECTOR to a scratch
// backend (e.g. http://localhost:4599, started with its own DB_FILE and
// DATA_ROOT) and every collector call the extension makes goes there instead,
// so a test run never files, edits or deletes anything real.
const COLLECTOR = process.env.HARNESS_COLLECTOR || "";

// The exact PREVIEW_SAMPLE_ANSWER template literal from background.js — read
// once at startup so "Bearer sample" (see the fetch stub below) can hand the
// Manual-generate path the identical text PREVIEW_STYLE builds its preview
// from, letting a test diff the two buildResumeHtml outputs for a genuine
// preview-vs-build parity check.
const PREVIEW_SAMPLE_ANSWER = (() => {
  const src = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const m = /const PREVIEW_SAMPLE_ANSWER = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error("PREVIEW_SAMPLE_ANSWER not found in background.js — has it moved or been renamed?");
  return m[1];
})();

// A deliberately awkward answer, in the DEFAULT_PROMPT profile shape (not
// PREVIEW_SAMPLE_ANSWER's already-converted array shape, so fromProfileShape
// gets exercised too): no certifications key, 7 roles (the upper bound
// buildResumeHtml warns past), an "&" and an em dash needing escaping, and
// one bullet long enough to wrap to 2+ lines.
const EDGE_CASE_ANSWER = `const resume = {
  "name": "Jordan Lee",
  "title": "Platform Engineer",
  "contact": { "email": "jordan.lee@example.com", "phone": "555-0100", "linkedin": "https://linkedin.com/in/jordan-lee", "location": "Remote" },
  "resume": {
    "summary": "Platform engineer at Smith & Co, spanning build systems, release pipelines and the on-call rotation that keeps them honest.",
    "skills": ["Tools: Terraform, Ansible, Jenkins"],
    "experience": [
      { "company": "Smith & Co", "position": "Platform Engineer", "location": "Remote", "duration": "2023 \\u2013 Present", "content": ["Rebuilt the deploy pipeline so a release that used to need a human babysitting it through six separate manual approval steps, one per environment, now goes out on its own and only pages someone when a real check fails.", "Cut CI time by 40%."] },
      { "company": "Globex", "position": "SRE", "location": "Remote", "duration": "2021 \\u2013 2023", "content": ["On-call lead for payments."] },
      { "company": "Initech", "position": "DevOps Engineer", "location": "Remote", "duration": "2019 \\u2013 2021", "content": ["Migrated to Kubernetes."] },
      { "company": "Umbrella Corp", "position": "Build Engineer", "location": "Remote", "duration": "2017 \\u2013 2019", "content": ["Owned the Jenkins fleet."] },
      { "company": "Soylent Corp", "position": "Systems Engineer", "location": "Remote", "duration": "2015 \\u2013 2017", "content": ["Ran the datacenter migration."] },
      { "company": "Wayne Enterprises", "position": "Junior SRE", "location": "Remote", "duration": "2013 \\u2013 2015", "content": ["First on-call rotation."] },
      { "company": "Stark Industries", "position": "Intern", "location": "Remote", "duration": "2012 \\u2013 2013", "content": ["Shadowed the infra team."] }
    ],
    "education": [{ "degree": "B.S.", "field": "Computer Science", "school": "State University", "year": "2012" }]
  },
  "cover_letter": "n/a",
  "ATS_score": "80"
};`;

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf"
};

const STUB = `<script>
window.__bgListeners = [];
window.__storage = {};

window.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { window.__bgListeners.push(fn); } },
    // Extension files are served from this harness's root, as the real
    // getURL resolves them against the extension's — so the built-in resume
    // templates under resume_temples/ load for real.
    getURL(p) { return "/" + String(p).replace(/^\\//, ""); },
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
      },
      remove(keys) {
        for (const k of [].concat(keys)) delete window.__storage[k];
        return Promise.resolve();
      }
    }
  },
  action: { setBadgeText() { return Promise.resolve(); }, setBadgeBackgroundColor() { return Promise.resolve(); } },
  // Placeholders, so code that looks for these at load finds them: the panel
  // tracks the page in front through chrome.tabs events (Auto Fill). A test
  // replaces whichever methods it drives, and fires the events it needs
  // through window.__tabListeners.
  tabs: {
    query() { return Promise.resolve([]); },
    create(o) { return Promise.resolve({ id: 999, ...o }); },
    onActivated: { addListener(fn) { window.__tabListeners.activated.push(fn); } },
    onUpdated: { addListener(fn) { window.__tabListeners.updated.push(fn); } }
  },
  permissions: { request() { return Promise.resolve(false); }, contains() { return Promise.resolve(false); } },
  scripting: { executeScript() { return Promise.reject(new Error("no pages to inject into in the harness")); } }
};
window.__tabListeners = { activated: [], updated: [] };
window.__ALICE = {
  id: "p1",
  name: "Alice",
  sheet: { country: "US", role: "Engineer", applicant: "Alice" },
  resume: { prompt: "", masterResume: "", masterResumeMode: "use", style: "", summary: "" }
};

// Only api.openai.com is intercepted. EDIT THE RESPONSES BELOW per what
// you're actually testing this session — this is a starting template, not a
// fixed contract. Keep gotcha #4 in mind for any "never responds" case.
const REAL_FETCH = window.fetch.bind(window);
const COLLECTOR_REDIRECT = ${JSON.stringify(COLLECTOR)};
window.fetch = async (url, opts) => {
  if (COLLECTOR_REDIRECT && typeof url === "string" && url.startsWith("http://localhost:4500")) {
    url = COLLECTOR_REDIRECT + url.slice("http://localhost:4500".length);
  }
  if (typeof url === "string" && url.includes("/save-data")) {
    // Never let a test's saveJob call actually write to the real archive at
    // localhost:4500 — ok:true with no code/msg "already exist" is enough
    // for saveJob to report success without a real collector involved.
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true }) };
  }
  if (typeof url === "string" && url.includes("/api/users/") && opts && opts.method === "PATCH") {
    // UPDATE_PROFILE's target: merges the patch into window.__ALICE.resume
    // and returns it the real collector's way ({ user: {...} }), so a test
    // can actually change the profile's own prompt/style/masterResume mid-run
    // (e.g. before Add a style's "pick it and Save") rather than only ever
    // reading the one profile GET /api/users starts with.
    //
    // NOTE for anyone editing this STUB block: this whole block is itself
    // embedded inside harness-server.js's own outer template literal (the
    // STUB variable). A backslash-escaped "\/" inside a regex literal written
    // here gets "cooked" away by that OUTER template literal's own escape
    // processing before this code ever reaches the browser -- "/\/foo\//"
    // silently becomes "//foo//", a line comment. Use url.includes(...) or
    // new RegExp("...") (a plain string, no backslashes) instead of a regex
    // literal with escaped slashes anywhere in this file's STUB section.
    const patch = JSON.parse((opts && opts.body) || "{}");
    Object.assign(window.__ALICE.resume, patch);
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ user: window.__ALICE }) };
  }
  if (typeof url === "string" && url.includes("/api/users") && (!opts || !opts.method || opts.method === "GET")) {
    return {
      ok: true, status: 200, statusText: "OK",
      // Mirrors the real collector's row shape exactly (see server.js's own
      // GET /api/users mapping) -- prompt/masterResume/style/summary all live
      // nested under resume, never as top-level fields. A flatter stub here
      // silently passes writerFor's profile.resume || {} as {}, which hides
      // real bugs in anything that reads the profile's own style/prompt.
      json: async () => ({ users: [window.__ALICE] })
    };
  }
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

    if (auth === "Bearer edge") {
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({
          model: body.model,
          choices: [{ message: { content: window.__EDGE_CASE_ANSWER } }]
        })
      };
    }

    if (auth === "Bearer custom") {
      // Whatever a test set window.__CUSTOM_ANSWER to, in-page, right before
      // the call — for trying one specific answer text against generateResume
      // without hardcoding it into this file.
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({
          model: body.model,
          choices: [{ message: { content: window.__CUSTOM_ANSWER || "" } }]
        })
      };
    }

    if (auth === "Bearer sample") {
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({
          model: body.model,
          choices: [{ message: { content: window.__PREVIEW_SAMPLE_ANSWER } }]
        })
      };
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
window.__PREVIEW_SAMPLE_ANSWER = ${JSON.stringify(PREVIEW_SAMPLE_ANSWER)};
window.__EDGE_CASE_ANSWER = ${JSON.stringify(EDGE_CASE_ANSWER)};
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
