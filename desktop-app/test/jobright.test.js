// Jobright: a run searches first and builds after. It scrolls the feed until
// it has a full list of new jobs, builds a resume for each, clears the list,
// and scrolls on for the next — until the feed has nothing new.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("./helpers/harness");

const BATCH = 30;
// Card n is new to the collector when n is a multiple of NEW_EVERY.
const NEW_EVERY = 8;
const numberIn = (title) => Number(/\d+/.exec(title)?.[0]);

test("Jobright: search a batch of 30, build it, clear, search again until the feed ends", { timeout: 300000 }, async (t) => {
  const h = await startHarness({
    // The awkward feed: its list only becomes scrollable a moment after
    // load, and more cards arrive well after its end is reached.
    sites: { jobright: { total: 300, firstShown: 45, loadDelay: 1200, lateScroller: true } },
    isNew: (title) => numberIn(title) % NEW_EVERY === 0
  });
  t.after(() => h.close());

  const reply = await h.send({ type: "START", options: { source: "jobright", autoScroll: true, visitJobs: true, saveJobs: true } });
  assert.equal(reply.ok, true, reply.error);
  await h.waitFor((m) => m.type === "FEED_DONE", 280000, "the feed to be done");

  const added = h.of("JOB_ADDED").map((m) => m.job.title);
  const expected = Array.from({ length: 300 }, (_, n) => n).filter((n) => n >= 1 && n % NEW_EVERY === 0);
  assert.deepEqual(added.map(numberIn).sort((a, b) => a - b), expected, "every new card in the feed is caught, once");

  // Search first: nothing is read or built before the list is full.
  const firstBuild = h.events.findIndex((e) => e.type === "BUILD_STARTED");
  assert.ok(firstBuild > 0, "a build started");
  assert.equal(h.events[firstBuild].count, BATCH, "the first build is a full batch");
  assert.equal(h.events.slice(0, firstBuild).filter((e) => e.type === "JOB_DETAIL").length, 0, "no job was read during the search");

  // Build after: no job is caught while a batch is being built.
  const firstClear = h.events.findIndex((e) => e.type === "BATCH_CLEARED");
  assert.ok(firstClear > firstBuild, "the list was cleared after the build");
  assert.equal(h.events[firstClear].done, BATCH);
  assert.equal(
    h.events.slice(firstBuild, firstClear).filter((e) => e.type === "JOB_ADDED").length,
    0,
    "no job was caught while the batch was being built"
  );
  assert.ok(h.of("BUILD_STARTED").length >= 2, "the search went on after the first batch");

  // Every caught job got one resume, saved once.
  const saved = h.calls.save.map((s) => s.job_title);
  assert.deepEqual([...saved].sort(), [...added].sort(), "each caught job is saved exactly once");
  assert.ok(h.calls.save.every((s) => s.resume && s.user === "US (JYZ)"), "each save carries a built resume for the profile");

  // The duplicate check was asked once per card seen, never twice.
  const checked = h.calls.check.map((c) => c.job_title);
  assert.equal(new Set(checked).size, checked.length, "no card is checked twice");

  assert.deepEqual(await h.storage("jobs"), [], "the last batch is cleared once built");
});
