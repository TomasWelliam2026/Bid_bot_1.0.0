// Himalayas, capture only, through its public API with no browser tab at all:
// two search terms, paged, with the page limit, a rate limit waited out, the
// filters on the address and old jobs left out. The API is faked at the fetch
// boundary.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, sleep } = require("./helpers/harness");

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

test("Himalayas capture: API only, paged, limited, nothing sent", { timeout: 120000 }, async (t) => {
  const asked = [];
  let limited = false;

  const himalayas = (url) => {
    asked.push(url.pathname + url.search);
    const term = url.searchParams.get("q");
    const page = Number(url.searchParams.get("page") || 1);
    // One answer of the whole run says slow down.
    if (!limited && page === 2) {
      limited = true;
      return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    }
    // "python developer" runs out after page 2; "data engineer" never does.
    const count = /python/i.test(term) && page >= 2 ? (page === 2 ? 3 : 0) : 20;
    const jobs = Array.from({ length: count }, (_, i) => {
      const slug = `${term.replace(/ /g, "-")}-${page}-${i + 1}`;
      return {
        title: `${term} ${page}.${i + 1}`,
        companyName: `Co ${slug}`,
        guid: `https://himalayas.app/companies/co/jobs/${slug}`,
        applicationLink: `https://himalayas.app/companies/co/jobs/${slug}`,
        // Every page's last job is a month old.
        pubDate: String(i === count - 1 ? NOW - 30 * DAY : NOW - DAY),
        description: `<p>About ${slug}</p><ul><li>Python</li></ul>`
      };
    });
    return Response.json({ totalCount: 5000, jobs });
  };

  const h = await startHarness({ himalayas, connect: false });
  t.after(() => h.close());

  const search = { role: "data engineer; Python Developer", country: "GB", jobType: "contract", postedDays: 7, remote: true };
  const pre = await h.send({ type: "PREFLIGHT", options: { source: "himalayas", search, capture: true } });
  assert.equal(pre.ready, true);

  const reply = await h.send({
    type: "START",
    options: { source: "himalayas", search, capture: true, autoScroll: true, visitJobs: true, saveJobs: false }
  });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.tabId, null, "no tab is opened");

  await h.waitFor((m) => m.type === "TERMS_DONE", 100000, "both search terms to be done");
  const expected = 5 * 19 + 19 + 2; // data: 5 pages of 19 recent; python: 19, then 2
  for (let i = 0; i < 20 && (await h.storage("captures")).length < expected; i++) await sleep(500);
  const captures = await h.storage("captures");

  const data = "/jobs/api/search?q=data+engineer&country=GB&employment_type=Contractor";
  const python = "/jobs/api/search?q=Python+Developer&country=GB&employment_type=Contractor";
  assert.deepEqual(asked, [
    data,
    `${data}&page=2`, // told to slow down
    `${data}&page=2`,
    `${data}&page=3`,
    `${data}&page=4`,
    `${data}&page=5`, // the limit: no page 6
    python,
    `${python}&page=2`,
    `${python}&page=3` // empty: the term is over
  ]);

  assert.equal(captures.length, expected);
  const one = captures.find((c) => c.title === "data engineer 2.3");
  assert.ok(one, "a capture keeps the job");
  assert.equal(one.board, "Himalayas");
  assert.equal(one.company, "Co data-engineer-2-3");
  assert.equal(one.url, "https://himalayas.app/companies/co/jobs/data-engineer-2-3");
  assert.equal(one.description, "About data-engineer-2-3\n\n• Python".replace("\n\n", "\n"));
  assert.equal(captures.some((c) => c.title === "data engineer 1.20"), false, "the month-old job is left out");
  assert.equal(h.requests.length, 0, "no page of any site was opened");
});
