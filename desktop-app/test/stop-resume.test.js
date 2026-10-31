// Stop in the middle of a build halts everything at once, and Start carries
// on where it left off: the jobs not yet built are built first, and no job
// is built or saved twice.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, sleep } = require("./helpers/harness");

const numberIn = (title) => Number(/\d+/.exec(title)?.[0]);

test("Stop mid-build, then Start: the rest is built, nothing twice", { timeout: 300000 }, async (t) => {
  // 120 cards, every 4th new: 29 jobs, so one batch that never fills and is
  // built once the feed has run out.
  const h = await startHarness({
    sites: { jobright: { total: 120 } },
    isNew: (title) => numberIn(title) % 4 === 0
  });
  t.after(() => h.close());

  const options = { source: "jobright", autoScroll: true, visitJobs: true, saveJobs: true };
  assert.equal((await h.send({ type: "START", options })).ok, true);

  await h.waitFor((m) => m.type === "BUILD_STARTED", 120000, "the build to start");
  while (h.calls.save.length < 3) await sleep(200);
  const stop = await h.send({ type: "STOP" });
  assert.equal(stop.ok, true);
  assert.ok(stop.pending > 0, "jobs were still waiting to be built");

  // Nothing moves while stopped.
  const savedAtStop = h.calls.save.length;
  await sleep(4000);
  assert.ok(h.calls.save.length <= savedAtStop + 1, "at most the job in flight finished after Stop");

  const builds = h.of("BUILD_STARTED").length;
  assert.equal((await h.send({ type: "START", options })).ok, true);
  await h.waitFor((m) => m.type === "BUILD_STARTED" && h.of("BUILD_STARTED").length > builds, 30000, "the rest to be built first");
  await h.waitFor((m) => m.type === "FEED_DONE", 240000, "the feed to be done");

  const added = h.of("JOB_ADDED").map((m) => m.job.title);
  assert.equal(added.length, 29);
  const saved = h.calls.save.map((s) => s.job_title);
  assert.deepEqual([...saved].sort(), [...added].sort(), "every job saved, none twice");
});
