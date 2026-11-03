// Glassdoor, capture only, two search terms: each search's list is read in the
// right-hand pane, by clicking each card's job link on the search page, with no
// tab opened for a job. One search has "Show more jobs" to press.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, sleep } = require("./helpers/harness");

test("Glassdoor capture: read in the pane, filters kept, nothing sent", { timeout: 300000 }, async (t) => {
  const h = await startHarness({ sites: { glassdoor: { moreFor: (term) => (/python/.test(term) ? 5 : 0) } } });
  t.after(() => h.close());

  const search = { role: "data engineer; Python Developer", location: "Austin, TX", postedDays: 7, remote: true };
  const reply = await h.send({
    type: "START",
    options: { source: "glassdoor", search, capture: true, autoScroll: true, visitJobs: true, saveJobs: false }
  });
  assert.equal(reply.ok, true, reply.error);

  await h.waitFor((m) => m.type === "TERMS_DONE", 280000, "both search terms to be done");
  for (let i = 0; i < 20 && (await h.storage("captures")).length < 55; i++) await sleep(500);
  const captures = await h.storage("captures");

  // Glassdoor's own address, across the United States, with the filters on it.
  const pages = h.requests.filter((r) => r.host === "www.glassdoor.com").map((r) => r.path);
  assert.equal(pages.filter((p) => /^\/(partner|job-listing)/.test(p)).length, 0, "no job left the search page");
  assert.deepEqual([...new Set(pages.filter((p) => p.startsWith("/Job/")))], [
    "/Job/united-states-data-engineer-jobs-SRCH_IL.0,13_KO14,27.htm?fromAge=7&remoteWorkType=1",
    "/Job/united-states-python-developer-jobs-SRCH_IL.0,13_KO14,30.htm?fromAge=7&remoteWorkType=1"
  ]);

  assert.equal(captures.length, 55);
  const one = captures.find((c) => c.url.endsWith("/job-listing/dataengineer12.htm?jl=dataengineer12"));
  assert.ok(one, "a capture keeps the job's link");
  assert.equal(one.board, "Glassdoor");
  assert.equal(one.company, "data-engineer Co dataengineer12");
  assert.equal(one.title, "data-engineer job dataengineer12");
  assert.equal(one.description, "About dataengineer12\n• Python");

  // Every job got its own description, including the one showing from the
  // start and the ones "Show more jobs" added.
  for (const c of captures) assert.ok(c.description.includes(`About ${c.url.split("jl=")[1]}`), c.url);
});
