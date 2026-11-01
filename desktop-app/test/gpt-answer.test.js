// The answer in the shape the bot now receives from GPT: a bare object, with
// ATS_score beside cover_letter, and trailing commas as models write them.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHarness } = require("./helpers/harness");

const role = (n) => `{
        "company": "Company Name${n}",
        "position": "Position${n}",
        "location": "Company Location${n}",
        "duration": "Period${n}",
        "content": [
          "Bullet1",
          "Bullet2",
          "Bullet3",
          "Bullet4",
          "Bullet5",
        ]
      },`;

const ANSWER = `{
  "name": "Here is Name",
  "title": "Job title",
  "contact": {
    "email": "Email",
    "phone": "Phone Number",
    "linkedin": "LinkedIn url",
    "location": "location"
  },
  "resume": {
    "summary": "Here is summary",
    "skills": [
      "Categories1: skill1, skill2, skill3",
      "Categories2: skill1, skill2, skill3",
      "Categories3: skill1, skill2, skill3",
      "Categories4: skill1, skill2, skill3",
    ],
    "experience": [
      ${role(1)}
      ${role(2)}
      ${role(3)}
    ],
    "education": [
      {
        "degree": "Degree content in Major",
        "school": "University Name",
        "year": "Period"
      }
    ]
  },
  "cover_letter": "Here is cover letter",
  "ATS_score": "87",
}`;

test("the answer's new shape builds a resume, and keeps its ATS score", { timeout: 90000 }, async (t) => {
  const h = await startHarness({
    answer: ANSWER,
    sites: { jobright: { total: 12, firstShown: 12 } },
    isNew: (title) => /\b8\b/.test(title)
  });
  t.after(() => h.close());

  const reply = await h.send({ type: "START", options: { source: "jobright", autoScroll: true, visitJobs: true, saveJobs: true } });
  assert.equal(reply.ok, true, reply.error);
  const { detail } = await h.waitFor((m) => m.type === "JOB_DETAIL", 80000, "a job to be built");

  const resume = detail.results[0].resume;
  assert.equal(resume.ok, true, resume.error);
  assert.equal(resume.data.atsScore, "87");
  assert.deepEqual(resume.data.CONTACT, ["Here is Name", "Job title", "location", "Phone Number", "Email", "LinkedIn url"]);
  assert.equal(resume.data.SUMMARY, "Here is summary");
  assert.equal(resume.data.SKILLS.length, 4);
  assert.equal(resume.data.EXPERIENCE.length, 3);
  assert.deepEqual(resume.data.EXPERIENCE[2].bullets, ["Bullet1", "Bullet2", "Bullet3", "Bullet4", "Bullet5"]);
  assert.equal(resume.data.EDUCATION[0].school, "University Name");
  assert.equal(resume.coverletter, "Here is cover letter");
  assert.ok(h.calls.save[0].resume, "the built resume is saved");
});
