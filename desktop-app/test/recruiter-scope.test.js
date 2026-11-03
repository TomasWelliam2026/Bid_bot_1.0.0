// A Recruiter Bid list belongs to the bid profile it was imported under, and
// is shared only with profiles of the same country and role.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness, PROFILE } = require("./helpers/harness");

const SAME = { id: 10, name: "US (Hans)", sheet: { country: "us ", role: "data engineer", applicant: "Hans" }, resume: { summary: "Hi" } };
const OTHER_ROLE = { id: 11, name: "US (Java)", sheet: { country: "US", role: "Java Developer", applicant: "J" }, resume: { summary: "Hi" } };
const OTHER_COUNTRY = { id: 8, name: "BR (Paulo)", sheet: { country: "BR", role: "Data Engineer", applicant: "Paulo" }, resume: { summary: "Olá" } };

const entry = (email) => ({ email_address: email, company_name: email.split("@")[1], email_title: "T" });

test("a recruiter list is its profile's, and shared by country and role", { timeout: 60000 }, async (t) => {
  const h = await startHarness({ connect: false, users: [PROFILE, SAME, OTHER_ROLE, OTHER_COUNTRY] });
  t.after(() => h.close());
  const list = async (profileId) => (await h.send({ type: "RECRUITERS_GET", profileId })).recruiters.map((r) => r.email_address);

  await t.test("the import is under the profile asked for", async () => {
    const reply = await h.send({ type: "RECRUITERS_IMPORT", entries: [entry("a@us.example")], profileId: PROFILE.id });
    assert.equal(reply.added, 1);
    assert.equal(reply.recruiters[0].owner.id, PROFILE.id);
  });

  await t.test("the same country and role see it; any other does not", async () => {
    assert.deepEqual(await list(PROFILE.id), ["a@us.example"]);
    assert.deepEqual(await list(SAME.id), ["a@us.example"]);
    assert.deepEqual(await list(OTHER_ROLE.id), []);
    assert.deepEqual(await list(OTHER_COUNTRY.id), []);
  });

  await t.test("a profile outside it cannot send from it", async () => {
    const reply = await h.send({ type: "RECRUITER_SEND", email: "a@us.example", profileId: OTHER_COUNTRY.id });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /not in BR \(Paulo\)'s list/);
  });

  await t.test("another group imports the same address into a list of its own", async () => {
    const reply = await h.send({ type: "RECRUITERS_IMPORT", entries: [entry("a@us.example")], profileId: OTHER_COUNTRY.id });
    assert.equal(reply.added, 1);
    assert.deepEqual(await list(OTHER_COUNTRY.id), ["a@us.example"]);
  });

  await t.test("a profile sharing the list skips what is in it", async () => {
    const reply = await h.send({ type: "RECRUITERS_IMPORT", entries: [entry("a@us.example")], profileId: SAME.id });
    assert.equal(reply.added, 0);
    assert.equal(reply.skipped.existing, 1);
  });

  await t.test("Clear empties this list only", async () => {
    await h.send({ type: "RECRUITERS_CLEAR", profileId: SAME.id });
    assert.deepEqual(await list(PROFILE.id), []);
    assert.deepEqual(await list(OTHER_COUNTRY.id), ["a@us.example"]);
  });

  await t.test("with no bid profile there is no list, and no import", async () => {
    const get = await h.send({ type: "RECRUITERS_GET" });
    assert.equal(get.ok, false);
    assert.equal(get.noProfile, true);
    const imp = await h.send({ type: "RECRUITERS_IMPORT", entries: [entry("b@us.example")] });
    assert.equal(imp.ok, false);
  });

  await t.test("the linked profile is the one used when none is asked for", async () => {
    await h.setStorage({ linkedBidProfile: OTHER_COUNTRY.id });
    assert.deepEqual((await h.send({ type: "RECRUITERS_GET" })).recruiters.map((r) => r.email_address), ["a@us.example"]);
  });

  await t.test("entries from before lists had owners stay visible to all", async () => {
    await h.setStorage({ recruiters: [entry("old@x.example")] });
    assert.deepEqual(await list(OTHER_ROLE.id), ["old@x.example"]);
  });
});
