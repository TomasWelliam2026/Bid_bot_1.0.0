// The checks Start runs before a run: what each board needs, the collector,
// the profiles and ChatGPT. No browser is needed for these.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("./helpers/harness");

const stateOf = (reply, key) => reply.checks.find((c) => c.key === key)?.state;

test("preflight", { timeout: 60000 }, async (t) => {
  const h = await startHarness({ connect: false });
  t.after(() => h.close());
  const check = (options) => h.send({ type: "PREFLIGHT", options });

  await t.test("a full setup is ready", async () => {
    const r = await check({ source: "jobright" });
    assert.equal(r.ready, true);
    assert.equal(stateOf(r, "collector"), "ok");
    assert.equal(stateOf(r, "profiles"), "ok");
    assert.equal(stateOf(r, "chatgpt"), "ok");
  });

  await t.test("every searched board needs the user's search term; the bot has none of its own", async () => {
    for (const source of ["indeed", "dice", "glassdoor", "ziprecruiter"]) {
      assert.equal(stateOf(await check({ source, search: { role: "" } }), "board"), "fail", source);
      assert.equal(stateOf(await check({ source, search: { role: "qa; dev" } }), "board"), "ok", source);
    }
    assert.equal(stateOf(await check({ source: "jobright" }), "board"), "ok", "Jobright has its own feed");
  });

  await t.test("a board without a fetcher fails", async () => {
    assert.equal((await check({ source: "monster" })).ready, false);
  });

  await t.test("capture only needs nothing but the board", async () => {
    h.setCollectorUp(false);
    try {
      const r = await check({ source: "dice", search: { role: "qa" }, capture: true });
      assert.equal(r.ready, true);
      assert.equal(stateOf(r, "collector"), undefined);
    } finally {
      h.setCollectorUp(true);
    }
  });

  await t.test("a dead collector fails a resume run", async () => {
    h.setCollectorUp(false);
    try {
      const r = await check({ source: "jobright" });
      assert.equal(r.ready, false);
      assert.equal(stateOf(r, "collector"), "fail");
    } finally {
      h.setCollectorUp(true);
    }
  });

  await t.test("no API key fails a resume run", async () => {
    await h.send({ type: "SET_SETTINGS", patch: { apiKey: "" } });
    const r = await check({ source: "jobright" });
    assert.equal(r.ready, false);
    assert.equal(stateOf(r, "chatgpt"), "fail");
  });
});
