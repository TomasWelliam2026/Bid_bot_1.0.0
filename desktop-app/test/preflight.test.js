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

  await t.test("Indeed needs a search term; Dice does not", async () => {
    assert.equal(stateOf(await check({ source: "indeed", search: { role: "" } }), "board"), "fail");
    assert.equal(stateOf(await check({ source: "indeed", search: { role: "qa; dev" } }), "board"), "ok");
    assert.equal(stateOf(await check({ source: "dice", search: { role: "" } }), "board"), "ok");
  });

  await t.test("a board without a fetcher fails", async () => {
    assert.equal((await check({ source: "monster" })).ready, false);
  });

  await t.test("capture only needs nothing but the board", async () => {
    h.setCollectorUp(false);
    try {
      const r = await check({ source: "dice", capture: true });
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
