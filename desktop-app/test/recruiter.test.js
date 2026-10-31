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

  await t.test("the import keeps entries with an address, once each", async () => {
    const reply = await h.send({
      type: "RECRUITERS_IMPORT",
      entries: [
        entry("tanmay@vaspiretech.com", "Vaspire Technologies"),
        entry("TANMAY@vaspiretech.com", "Vaspire Technologies"), // the same, by address and title
        entry("jo@acme.example", "Acme", "Data Engineer"),
        entry("not an address", "Nobody"),
        null
      ]
    });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.recruiters.map((r) => r.email_address), ["tanmay@vaspiretech.com", "jo@acme.example"]);
    assert.equal(reply.skipped, 3);
    assert.equal((await h.send({ type: "RECRUITERS_GET" })).recruiters.length, 2);
  });

  await t.test("a single object imports too", async () => {
    const reply = await h.send({ type: "RECRUITERS_IMPORT", entries: entry("tanmay@vaspiretech.com", "Vaspire Technologies") });
    assert.deepEqual(reply.recruiters.map((r) => r.company_name), ["Vaspire Technologies"]);
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

  await t.test("a later import keeps that", async () => {
    const reply = await h.send({ type: "RECRUITERS_IMPORT", entries: [entry("tanmay@vaspiretech.com", "Vaspire Technologies")] });
    assert.ok(reply.recruiters[0].sentAt);
  });

  await t.test("nothing is sent without a profile, or to something that is not an address", async () => {
    const before = h.sentMail.length;
    assert.equal((await h.send({ type: "RECRUITER_SEND", email: "tanmay@vaspiretech.com", profileId: 999 })).ok, false);
    assert.equal((await h.send({ type: "RECRUITER_SEND", email: "nobody", profileId: 7 })).ok, false);
    assert.equal(h.sentMail.length, before);
  });
});
