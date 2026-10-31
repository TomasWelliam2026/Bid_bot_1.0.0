// One run of the real job pipeline for a test: the extension's background.js
// and content scripts, loaded by the desktop app's engine, driving a headless
// Chrome of its own against the fake job boards. The collector
// (localhost:4500) and OpenAI are faked at the fetch boundary, and every call
// to them is recorded.
//
// background.js keeps its state at module level, so there is one harness per
// process — node --test runs each test file in a process of its own.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startEngine } = require("../../src/engine");
const { findChromes } = require("../../src/chrome-finder");
const { startFakeSites } = require("./fake-sites");

const EXTENSION_DIR = path.join(__dirname, "..", "..", "..", "jobright-monitor");

// The model's answer in the shape the default prompt asks for.
const RESUME_ANSWER =
  'const resume = {"name":"T","title":"DE","contact":{"email":"t@e.com","phone":"5","linkedin":"https://linkedin.com/in/t","location":"A"},' +
  '"resume":{"summary":"s","skills":["L: a"],"experience":[' +
  '{"company":"A","position":"DE","location":"R","duration":"2021 - Now","content":["b"]},' +
  '{"company":"B","position":"DE","location":"R","duration":"2019 - 2021","content":["b"]},' +
  '{"company":"C","position":"DE","location":"R","duration":"2017 - 2019","content":["b"]}],' +
  '"education":[{"degree":"BS","school":"U","year":"2017"}]},"cover_letter":"hi"};';

const PROFILE = {
  id: 7,
  name: "US (JYZ)",
  sheet: { country: "US", role: "Data Engineer", applicant: "JYZ" },
  resume: { summary: "Hi,\n\nI'm a senior data engineer (Snowflake, Spark, Airflow).\nOpen to fully remote roles only." }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sites: options for startFakeSites. isNew(job_title) says which jobs the
// collector does not have yet (default: all of them). collectorUp: false makes
// every collector call fail as a dead port would.
async function startHarness({ sites = {}, isNew = () => true, collectorUp = true, connect = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bidbot-test-"));
  const fake = await startFakeSites(sites);
  const events = [];
  const calls = { check: [], save: [], openai: 0, users: 0 };
  const listeners = new Set();
  const state = { collectorUp };

  const { browser, api } = await startEngine({
    extensionDir: EXTENSION_DIR,
    dataDir,
    log: () => {},
    toPanel: async (message) => {
      events.push({ at: Date.now(), ...message });
      for (const fn of listeners) fn(message);
      return true;
    },
    onBadge: () => {}
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const s = String(url);
    if (s.startsWith("http://localhost:4500")) {
      if (!state.collectorUp) throw new TypeError("fetch failed");
      if (s.includes("/api/users")) {
        calls.users++;
        return Response.json({ users: [PROFILE] });
      }
      const body = JSON.parse(opts.body || "{}");
      if (s.includes("/get-item")) {
        calls.check.push(body);
        return Response.json(isNew(body.job_title) ? { code: 404 } : { code: 200, msg: "already exist" });
      }
      if (s.includes("/save-data")) {
        calls.save.push(body);
        return Response.json({ code: 200 });
      }
    }
    if (s.includes("api.openai.com")) {
      calls.openai++;
      return Response.json({ choices: [{ message: { content: RESUME_ANSWER } }] });
    }
    return realFetch(url, opts);
  };

  const send = (message) => api.fromPanel(message);
  await send({
    type: "SET_SETTINGS",
    patch: { apiKey: "sk-test", model: "gpt-4o-mini", country: "US", role: "Data Engineer" }
  });

  if (connect) {
    const chrome = findChromes()[0];
    if (!chrome) throw new Error("these tests need Google Chrome installed");
    await browser.connect({
      mode: "launch",
      exe: chrome.exe,
      userDataDir: path.join(dataDir, "chrome"),
      headless: true,
      acceptInsecureCerts: true,
      chromeArgs: fake.chromeArgs,
      label: "test"
    });
  }

  return {
    send,
    browser,
    events,
    calls,
    requests: fake.requests,
    sentMail: fake.sentMail,
    // The collector going away, or coming back, mid-test.
    setCollectorUp: (up) => (state.collectorUp = up),
    // Messages of one type sent to the panel, in order.
    of: (type) => events.filter((e) => e.type === type),
    storage: (key) => api.chrome.storage.local.get(key).then((r) => r[key]),
    // Resolves with the first panel message matching `test`, sent from now
    // on or already sent; rejects after `timeout` ms.
    waitFor(test, timeout = 120000, what = "the expected message") {
      const seen = events.find(test);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(on);
          reject(new Error(`timed out after ${timeout} ms waiting for ${what}`));
        }, timeout);
        const on = (m) => {
          if (!test(m)) return;
          clearTimeout(timer);
          listeners.delete(on);
          resolve(m);
        };
        listeners.add(on);
      });
    },
    async close() {
      await send({ type: "STOP" }).catch(() => {});
      await browser.disconnect().catch(() => {});
      globalThis.fetch = realFetch;
      await fake.close();
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
}

module.exports = { startHarness, sleep, PROFILE };
