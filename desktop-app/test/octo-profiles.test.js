// The browser bar's list of running Octo Browser profiles, through a fake of
// Octo's Local API. This test's own process stands in for a profile's window.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { listOctoProfiles, listFolderProfiles } = require("../src/octo-profiles");

async function fakeOcto(t, answer) {
  const api = http.createServer((_req, res) => res.end(answer));
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => api.close());
  return `http://127.0.0.1:${api.address().port}`;
}

test("Octo profiles: a window's title names one, its id stands in with no window", async (t) => {
  const api = await fakeOcto(t, JSON.stringify([
    { uuid: "692510ee15464dab", ws_endpoint: null, browser_pid: process.pid },
    { uuid: "aaaaaa11", ws_endpoint: "ws://127.0.0.1:55880/devtools/browser/x", browser_pid: 999999 }
  ]));
  assert.deepEqual(await listOctoProfiles({ api }), [
    { uuid: "692510ee15464dab", name: "Profile 692510", wsEndpoint: null },
    { uuid: "aaaaaa11", name: "Profile aaaaaa", wsEndpoint: "ws://127.0.0.1:55880/devtools/browser/x" }
  ]);
});

test("Octo folders: only the named folders' profiles, across pages, with the token", async (t) => {
  const asked = [];
  const profiles = [
    ...Array.from({ length: 100 }, (_, i) => ({ uuid: `other${i}`, title: `Other ${i}`, folder: i % 2 ? "f9" : null })),
    { uuid: "a1", title: "Sisu-Br-Paulo", folder: "f1" }, // by id
    { uuid: "a2", title: "Sisu-Us-Zhu", folder: "US" }, // by name
    { uuid: "a3", title: "", folder: { uuid: "f1", name: "Brazil" } }
  ];
  const api = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    asked.push({ path: url.pathname, token: req.headers["x-octo-api-token"] });
    if (url.pathname.endsWith("/folders")) {
      return res.end(JSON.stringify({ success: true, data: [{ uuid: "f1", name: "Brazil" }, { uuid: "f2", name: "US" }, { uuid: "f9", name: "Spare" }] }));
    }
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("page_len"));
    res.end(JSON.stringify({ success: true, data: profiles.slice(page * size, (page + 1) * size), total_count: profiles.length, page }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => api.close());

  const found = await listFolderProfiles({ token: "T", folders: ["brazil", "US", "Nowhere"], api: `http://127.0.0.1:${api.address().port}` });
  assert.deepEqual(found, {
    profiles: [{ uuid: "a1", name: "Sisu-Br-Paulo" }, { uuid: "a2", name: "Sisu-Us-Zhu" }, { uuid: "a3", name: "Profile a3" }],
    missing: ["Nowhere"]
  });
  assert.deepEqual(asked.map((a) => a.path.replace("/api/v2/automation", "")), ["/folders", "/profiles", "/profiles"]);
  assert.ok(asked.every((a) => a.token === "T"));
});

test("Octo folders: a refused token and a rate limit are said plainly", async (t) => {
  const answers = async (status) => {
    const api = http.createServer((_req, res) => {
      res.statusCode = status;
      res.end("{}");
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    t.after(() => api.close());
    return `http://127.0.0.1:${api.address().port}`;
  };
  await assert.rejects(listFolderProfiles({ token: "T", folders: ["A"], api: await answers(401) }), /refused the API token/);
  await assert.rejects(listFolderProfiles({ token: "T", folders: ["A"], api: await answers(429) }), /request limit/);
});

test("Octo profiles: none when Octo is closed or answers something else", async (t) => {
  assert.deepEqual(await listOctoProfiles({ api: "http://127.0.0.1:9" }), []);
  assert.deepEqual(await listOctoProfiles({ api: await fakeOcto(t, "not json") }), []);
  assert.deepEqual(await listOctoProfiles({ api: await fakeOcto(t, '{"detail":"nope"}') }), []);
});
