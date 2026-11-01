// Recruiter Bid: recruiters imported from a JSON file are kept, and picking
// one sends them an email from Gmail — through the Chrome DevTools MCP server
// in the desktop app — with the recipient, the subject and the picked
// profile's Summary filled in, then Send.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("./helpers/harness");

const SUBJECT = "I'm just looking for a fully remote position.";
const entry = (email, company, title = "Senior Snowflake Data Engineer - Remote") => ({
  email_address: email,
  company_name: company,
  email_title: title,
  email_content: "Hi Jeffrey,\n\nThe job description…",
  arrived_date: "2026-10-27T05:53:12+08:00"
});

test("Recruiter Bid: import, then an email sent from Gmail", { timeout: 120000 }, async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  await h.setStorage({ linkedBidProfile: 7 }); // the list belongs to a bid profile

  await t.test("the import keeps entries with an address, once each", async () => {
    const reply = await h.send({
      type: "RECRUITERS_IMPORT",
      entries: [
        entry("tanmay@vaspiretech.com", "Vaspire Technologies"),
        entry("TANMAY@vaspiretech.com", "Vaspire again", "Another title"), // the same address
        entry("jo@acme.example", "Acme", "Data Engineer"),
        entry("not an address", "Nobody"),
        null
      ]
    });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.recruiters.map((r) => r.email_address), ["tanmay@vaspiretech.com", "jo@acme.example"]);
    assert.equal(reply.added, 2);
    assert.deepEqual(reply.skipped, { existing: 1, sent: 0, invalid: 2 });
    assert.equal((await h.send({ type: "RECRUITERS_GET" })).recruiters.length, 2);
  });

  await t.test("a later import adds to the list and skips addresses already in it", async () => {
    const reply = await h.send({
      type: "RECRUITERS_IMPORT",
      entries: [entry("tanmay@vaspiretech.com", "Vaspire Technologies"), entry("new@globex.example", "Globex")]
    });
    assert.deepEqual(reply.recruiters.map((r) => r.company_name), ["Vaspire Technologies", "Acme", "Globex"]);
    assert.equal(reply.added, 1);
    assert.equal(reply.skipped.existing, 1);
  });

  await t.test("a single object imports too", async () => {
    const reply = await h.send({ type: "RECRUITERS_IMPORT", entries: entry("solo@initech.example", "Initech") });
    assert.equal(reply.added, 1);
    assert.equal(reply.recruiters.at(-1).company_name, "Initech");
  });

  await t.test("picking a recruiter sends the email: To, the subject, the profile's Summary", async () => {
    const reply = await h.send({ type: "RECRUITER_SEND", email: "tanmay@vaspiretech.com", profileId: 7 });
    assert.equal(reply.ok, true, reply.error);
    assert.equal(reply.sentAs, "US (JYZ)");

    assert.equal(h.sentMail.length, 1, "exactly one message went");
    const [mail] = h.sentMail;
    assert.deepEqual(mail.recipients, ["tanmay@vaspiretech.com"]);
    assert.equal(mail.subject, SUBJECT);
    // The summary first, then the signature Gmail had already put in the body.
    assert.equal(
      mail.body.replace(/\s+/g, " ").trim(),
      "Hi, I'm a senior data engineer (Snowflake, Spark, Airflow). Open to fully remote roles only. -- Jeffrey Smith"
    );
    assert.match(mail.body, /Hi,\n+I'm a senior/, "the Summary keeps its line breaks");

    // Gmail's new-message address, carrying the recipient and the subject.
    const opened = h.requests.find((r) => r.host === "mail.google.com" && r.path.startsWith("/mail/u/0/?"));
    assert.ok(opened, "Gmail's new-message address was opened");
    const q = new URL(opened.path, "https://mail.google.com").searchParams;
    assert.equal(q.get("tf"), "cm");
    assert.equal(q.get("to"), "tanmay@vaspiretech.com");
    assert.equal(q.get("su"), SUBJECT);
    const [kept] = (await h.send({ type: "RECRUITERS_GET" })).recruiters;
    assert.equal(kept.sentAt, reply.sentAt, "the list remembers it was sent");
    assert.equal(kept.sentAs, "US (JYZ)");
  });

  await t.test("the send is saved to the database, with its details", async () => {
    assert.equal(h.calls.recruiterSends.length, 1);
    const [saved] = h.calls.recruiterSends;
    assert.equal(saved.email_address, "tanmay@vaspiretech.com");
    assert.equal(saved.company_name, "Vaspire Technologies");
    assert.equal(saved.email_title, "Senior Snowflake Data Engineer - Remote");
    assert.equal(saved.subject, SUBJECT);
    assert.match(saved.body, /^Hi,/);
    assert.equal(saved.profile_id, 7);
    assert.equal(saved.profile_name, "US (JYZ)");
    assert.ok(saved.sent_at);
  });

  await t.test("with the database down the email still counts, and is saved with the next send", async () => {
    h.setRecruiterSendsUp(false);
    const first = await h.send({ type: "RECRUITER_SEND", email: "jo@acme.example", profileId: 7 });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.saved, false);
    assert.ok(first.saveError);
    assert.equal(h.calls.recruiterSends.length, 1);

    h.setRecruiterSendsUp(true);
    const second = await h.send({ type: "RECRUITER_SEND", email: "new@globex.example", profileId: 7 });
    assert.equal(second.saved, true);
    assert.deepEqual(h.calls.recruiterSends.map((s) => s.email_address), [
      "tanmay@vaspiretech.com",
      "jo@acme.example",
      "new@globex.example"
    ]);
  });

  await t.test("an address the database has emailed is skipped, even after Clear", async () => {
    await h.send({ type: "RECRUITERS_CLEAR" });
    const reply = await h.send({
      type: "RECRUITERS_IMPORT",
      entries: [entry("tanmay@vaspiretech.com", "Vaspire Technologies"), entry("fresh@hooli.example", "Hooli")]
    });
    assert.deepEqual(reply.recruiters.map((r) => r.company_name), ["Hooli"]);
    assert.equal(reply.skipped.sent, 1);
  });

  await t.test("nothing is sent without a profile, or to something that is not an address", async () => {
    const before = h.sentMail.length;
    assert.equal((await h.send({ type: "RECRUITER_SEND", email: "tanmay@vaspiretech.com", profileId: 999 })).ok, false);
    assert.equal((await h.send({ type: "RECRUITER_SEND", email: "nobody", profileId: 7 })).ok, false);
    assert.equal(h.sentMail.length, before);
  });
});
