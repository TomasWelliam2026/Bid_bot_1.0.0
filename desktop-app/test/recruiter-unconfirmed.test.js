// Recruiter Bid when Gmail's "Message sent" never appears: the send is not
// reported as done, not as failed either, and the tab is left open to look at.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("./helpers/harness");

test("Recruiter Bid: no result message from Gmail, so the tab stays and it says to check", { timeout: 120000 }, async (t) => {
  const h = await startHarness({ sites: { gmail: { noConfirm: true } } });
  t.after(() => h.close());
  await h.setStorage({ linkedBidProfile: 7 }); // the list belongs to a bid profile

  await h.send({
    type: "RECRUITERS_IMPORT",
    entries: [{ email_address: "tanmay@vaspiretech.com", company_name: "Vaspire Technologies", email_title: "Data Engineer" }]
  });
  const reply = await h.send({ type: "RECRUITER_SEND", email: "tanmay@vaspiretech.com", profileId: 7 });
  assert.equal(reply.ok, false);
  assert.equal(reply.unconfirmed, true);
  assert.equal(h.sentMail.length, 1, "Send was pressed once, and only once");
  assert.ok(h.browser.get(reply.tabId), "the Gmail tab stays open");
  const [kept] = (await h.send({ type: "RECRUITERS_GET" })).recruiters;
  assert.equal(kept.sentAt, undefined, "not marked as sent");
});
