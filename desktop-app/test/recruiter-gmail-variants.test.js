// Recruiter Bid against a Gmail that is harder to fill: its new message starts
// folded (recipients behind a "Recipients" row, the body not yet editable),
// as Gmail does in a window without the focus, where leaving the To field does
// not make the address a recipient either; its labels are in
// Spanish, so only Gmail's language-free markers find the parts, and the
// compose address alone opens no new message — Gmail's own Compose button
// has to be pressed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("./helpers/harness");

test("Recruiter Bid: a Gmail in another language, with no new message opened by the address", { timeout: 150000 }, async (t) => {
  const h = await startHarness({ sites: { gmail: { autoCompose: false, lang: "es", folded: true, unfocused: true } } });
  t.after(() => h.close());
  await h.setStorage({ linkedBidProfile: 7 }); // the list belongs to a bid profile

  await h.send({
    type: "RECRUITERS_IMPORT",
    entries: [{ email_address: "tanmay@vaspiretech.com", company_name: "Vaspire Technologies", email_title: "Data Engineer" }]
  });
  const reply = await h.send({ type: "RECRUITER_SEND", email: "tanmay@vaspiretech.com", profileId: 7 });
  assert.equal(reply.ok, true, reply.error);

  assert.equal(h.sentMail.length, 1, "exactly one message went");
  const [mail] = h.sentMail;
  assert.deepEqual(mail.recipients, ["tanmay@vaspiretech.com"]);
  assert.equal(mail.subject, "I'm just looking for a fully remote position.");
  assert.match(mail.body, /^Hi,\n+I'm a senior data engineer/, "the Summary opens the body");
  assert.match(mail.body, /Jeffrey Smith\s*$/, "the signature stays after it");
});
