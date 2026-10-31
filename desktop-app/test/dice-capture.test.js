// Dice, capture only, two search terms: each term's search pages are read
// in turn, a batch of 30 at a time, and each job's company, title, link and
// description are kept — with nothing sent to the collector or OpenAI.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, sleep } = require("./helpers/harness");

test("Dice capture: two search terms, paged, batches of 30, nothing sent", { timeout: 300000 }, async (t) => {
  // "data engineer" has 3 pages of 12 jobs (36: a batch of 30, then 6);
  // "python developer" one page of 12.
  const h = await startHarness({
    sites: { dice: { perPage: 12, pagesFor: (term) => (/data/i.test(term) ? 3 : 1) } }
  });
  t.after(() => h.close());

  const search = { role: "data engineer; Python Developer", location: "", jobType: "fulltime", postedDays: 3, remote: true };
  const pre = await h.send({ type: "PREFLIGHT", options: { source: "dice", search, capture: true } });
  assert.equal(pre.ready, true);

  const reply = await h.send({
    type: "START",
    options: { source: "dice", search, capture: true, autoScroll: true, visitJobs: true, saveJobs: false }
  });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(reply.terms, ["data engineer", "Python Developer"]);

  await h.waitFor((m) => m.type === "TERMS_DONE", 280000, "both search terms to be done");
  for (let i = 0; i < 20 && (await h.storage("captures")).length < 48; i++) await sleep(500);
  const captures = await h.storage("captures");

  // The search as Dice's own form writes it, then its pager.
  const searches = h.requests.filter((r) => r.host === "www.dice.com" && r.path.startsWith("/jobs"));
  const first = new URL(searches[0].path, "https://www.dice.com").searchParams;
  assert.equal(first.get("q"), "data engineer");
  assert.equal(first.get("filters.employmentType"), "FULLTIME");
  assert.equal(first.get("filters.postedDate"), "THREE");
  assert.equal(first.get("filters.workplaceTypes"), "Remote");
  assert.deepEqual(
    searches.map((r) => new URL(r.path, "https://x").searchParams).map((p) => `${p.get("q")}#${p.get("page") || 1}`),
    ["data engineer#1", "data engineer#2", "data engineer#3", "Python Developer#1"]
  );

  // Batches: a full 30 first, then what was left of the first term, then the second.
  assert.deepEqual(h.of("BUILD_STARTED").map((m) => m.count), [30, 6, 12]);
  assert.equal(h.of("TERM_STARTED")[0].term, "Python Developer");

  assert.equal(captures.length, 48);
  assert.equal(captures.filter((c) => c.term === "data engineer").length, 36);
  assert.equal(captures.filter((c) => c.term === "Python Developer").length, 12);
  const one = captures.find((c) => c.url.endsWith("/job-detail/data-engineer-1-1"));
  assert.ok(one, "a capture keeps the job's link");
  assert.equal(one.board, "Dice");
  assert.equal(one.company, "data engineer Co 11");
  assert.equal(one.title, "data engineer job 1.1");
  assert.equal(
    one.description,
    'About the role\nWe are hiring for data-engineer-1-1 & more.\n• Python\n• SQL > Excel\nPay: $120k, "remote"'
  );

  assert.equal(h.calls.check.length + h.calls.save.length + h.calls.openai, 0, "capture sends nothing anywhere");
});
