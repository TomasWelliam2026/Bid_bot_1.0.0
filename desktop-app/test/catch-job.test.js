// Catch Job: the real MCP server attached to a real headless Chrome, as it is
// to an Octo Browser profile, holding a page laid out as LinkedIn's job search.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { McpBrowser } = require("../src/mcp-browser");
const { findChromes } = require("../src/chrome-finder");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXTENSION_DIR = path.join(__dirname, "..", "..", "jobright-monitor");

const JOB_PAGE = `<!doctype html><title>(3) AI Data Engineer III | Rimini Street | LinkedIn</title>
<body>
<h2>People you can reach out to</h2><span data-testid="expandable-text-box">Not the job</span>
<div><div><h2>About the job</h2></div>
<span data-testid="expandable-text-box" style="display:block;max-height:20px;overflow:hidden">We need a data engineer.<br><br><br><br>Position Summary<br>Build pipelines.<br><br><button data-testid="expandable-text-button">… more</button></span></div>
<h2>About the company</h2><span data-testid="expandable-text-box">Rimini Street is a company.</span>`;

test("Catch Job: reads the LinkedIn tab through MCP and leaves the browser as it was", { timeout: 90000 }, async (t) => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url.startsWith("/in/") ? "<title>Someone | LinkedIn</title>" : JOB_PAGE);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.close());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bidbot-catch-"));
  const child = spawn(findChromes()[0].exe, [
    "--headless=new", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${dir}`,
    `--host-resolver-rules=MAP www.linkedin.com 127.0.0.1:${site.address().port}`,
    "http://www.linkedin.com/in/someone/"
  ], { stdio: "ignore" });
  t.after(() => child.kill());
  const portFile = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
  const debug = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, init);
  const pages = async () => (await (await debug("/json/list")).json()).filter((x) => x.type === "page");

  const browser = new McpBrowser({ extensionDir: EXTENSION_DIR });
  const { webSocketDebuggerUrl: wsEndpoint } = await (await debug("/json/version")).json();
  await browser.connect({ mode: "attach", wsEndpoint, label: "Octo Browser · Test", profile: { dir: "abc", name: "Test", catchOnly: true } });
  t.after(() => browser.disconnect());
  assert.equal(browser.status().octo, true);

  await assert.rejects(browser.catchJob(), /No LinkedIn job is open/);

  await debug(`/json/new?http://www.linkedin.com/jobs/search-results/?currentJobId=4484130052&eBP=x`, { method: "PUT" });
  await sleep(1500);
  const before = await pages();

  assert.deepEqual(await browser.catchJob(), {
    company: "Rimini Street",
    title: "AI Data Engineer III",
    url: "https://www.linkedin.com/jobs/view/4484130052/",
    description: "We need a data engineer.\n\nPosition Summary\nBuild pipelines."
  });

  // Nothing opened, nothing shown to a run, nothing closed, nothing injected.
  await assert.rejects(browser.create({ url: "https://example.com/" }), /Catch Job only/);
  await sleep(2500);
  assert.deepEqual(browser.query({}), []);
  await browser.remove(before.map((_, i) => i + 1));
  assert.equal((await pages()).length, before.length);
  const job = (await browser.catchJob()).title;
  assert.equal(job, "AI Data Engineer III");
  const tab = [...browser.tabs.values()].find((x) => (x.listedUrl || "").includes("/jobs/"));
  const bridged = await browser.call("evaluate_script", { pageId: tab.pageId, function: "() => String(Object.keys(window).filter((k) => k.startsWith('__bidbot')))" });
  assert.equal(bridged.isError, undefined);
  assert.doesNotMatch(JSON.stringify(bridged), /__bidbot/);
});
