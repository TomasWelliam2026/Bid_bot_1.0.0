// Himalayas' API staying down: said on the panel, not a run that sits silent.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("./helpers/harness");

test("Himalayas: an API that stays down is said on the panel", { timeout: 60000 }, async (t) => {
  const h = await startHarness({ himalayas: () => new Response("{}", { status: 500 }), connect: false });
  t.after(() => h.close());
  const reply = await h.send({
    type: "START",
    options: { source: "himalayas", search: { role: "qa" }, capture: true, autoScroll: true, visitJobs: true, saveJobs: false }
  });
  assert.equal(reply.ok, true);
  const seen = await h.waitFor((m) => /answered 500/.test(JSON.stringify(m)), 20000, "the failure to be reported");
  assert.ok(seen);
});
