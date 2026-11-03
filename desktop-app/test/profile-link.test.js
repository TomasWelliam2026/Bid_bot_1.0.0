// A browser profile linked to a bid profile: that bid profile alone is used
// for the whole run — the duplicate check, the resume, the save — whatever
// Settings' country and role say.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, PROFILE } = require("./helpers/harness");

const BRAZIL = {
  id: 8,
  name: "BR (Paulo)",
  sheet: { country: "BR", role: "Data Engineer", applicant: "Paulo" },
  resume: { summary: "Olá." }
};

test("a linked bid profile is the only one a run uses", { timeout: 120000 }, async (t) => {
  const h = await startHarness({
    users: [PROFILE, BRAZIL],
    sites: { jobright: { total: 12, firstShown: 12 } },
    isNew: (title) => /\b8\b/.test(title)
  });
  t.after(() => h.close());

  await t.test("the checks before a run name it", async () => {
    await h.setStorage({ linkedBidProfile: BRAZIL.id });
    const r = await h.send({ type: "PREFLIGHT", options: { source: "jobright" } });
    const check = r.checks.find((c) => c.key === "profiles");
    assert.equal(check.state, "ok");
    assert.match(check.detail, /BR \(Paulo\)/);
  });

  await t.test("the Recruiter Bid tab can ask for it", async () => {
    assert.equal((await h.send({ type: "GET_LINKED_PROFILE" })).id, BRAZIL.id);
  });

  await t.test("a run checks, builds and saves for it alone", async () => {
    const reply = await h.send({ type: "START", options: { source: "jobright", autoScroll: true, visitJobs: true, saveJobs: true } });
    assert.equal(reply.ok, true, reply.error);
    await h.waitFor((m) => m.type === "FEED_DONE", 100000, "the feed to be done");
    assert.ok(h.calls.save.length >= 1, "a job was saved");
    assert.ok(h.calls.save.every((s) => s.user === BRAZIL.name), "every save is the linked profile's");
    assert.ok(h.calls.check.every((c) => c.user === BRAZIL.name), "every duplicate check is the linked profile's");
  });

  await t.test("Recruiter Bid sends as it, with no profile asked for", async () => {
    await h.send({ type: "RECRUITERS_IMPORT", entries: [{ email_address: "jo@acme.example", company_name: "Acme", email_title: "T" }] });
    const reply = await h.send({ type: "RECRUITER_SEND", email: "jo@acme.example" });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.sentAs, BRAZIL.name);
    assert.match(h.sentMail.at(-1).body, /Olá\./);
  });

  await t.test("a link to a profile gone from the dashboard stops the run with a reason", async () => {
    await h.setStorage({ linkedBidProfile: 999 });
    const r = await h.send({ type: "PREFLIGHT", options: { source: "jobright" } });
    assert.equal(r.ready, false);
    assert.match(r.checks.find((c) => c.key === "profiles").detail, /no longer on the dashboard/);
  });

  await t.test("with no link, Settings' country and role pick the profiles again", async () => {
    await h.setStorage({ linkedBidProfile: null });
    const r = await h.send({ type: "PREFLIGHT", options: { source: "jobright" } });
    assert.match(r.checks.find((c) => c.key === "profiles").detail, /US \(JYZ\)/);
  });

  await t.test("with no link Recruiter Bid says so, and sends nothing", async () => {
    const before = h.sentMail.length;
    const reply = await h.send({ type: "RECRUITER_SEND", email: "jo@acme.example" });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /Browser Profile/);
    assert.equal(h.sentMail.length, before);
  });
});
