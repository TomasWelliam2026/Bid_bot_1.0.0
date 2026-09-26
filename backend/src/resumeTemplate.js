/**
 * The resume document.
 *
 * Everything except the summary, the skills and the experience bullets is
 * fixed -- the name, contact line, employers and education do not change per
 * application, only the pitch does. So a submission carries just the variable
 * part:
 *
 *   resume: {
 *     SUMMARY:    "one paragraph",
 *     SKILLS:     ["Languages: Python, SQL", …],   // text before ":" is the label
 *     EXPERIENCE: [["bullet", …], …]               // one array per job, in order
 *   }
 *
 * `resumeHtml()` returns the finished page. The original template left the
 * summary, skills and bullets to a script that filled them in the browser;
 * here they are written into the markup instead, so the file needs no
 * JavaScript to be complete -- which is also what lets `src/htmlPdf.js` read
 * the page back and turn it into the PDF.
 *
 * A submission may override any part of the fixed half by sending NAME, TITLE,
 * CONTACT, JOBS or EDUCATION alongside the three data fields.
 */

export const PROFILE = {
  name: 'Jiangyun Zhu',
  title: 'Senior Data Engineer',
  contact: [
    { text: 'San Carlos, CA 94070' },
    { text: '(310) 896-5119' },
    { text: 'jiang.y.z.1015@gmail.com' },
    {
      text: 'https://linkedin.com/in/jiangyun-zhu-650b8b167',
      href: 'https://linkedin.com/in/jiangyun-zhu-650b8b167',
    },
  ],
  jobs: [
    { company: 'Meta', role: 'Tech Lead Manager, AI/ML Infra Capacity Data', meta: 'San Francisco Bay Area / Sep 2024 - Present' },
    { company: 'Meta', role: 'Data Engineering Manager', meta: 'Menlo Park, CA / Dec 2021 - Sep 2024' },
    { company: 'Facebook / Meta', role: 'Senior Data Engineer, Business Messaging (Messenger &amp; Instagram)', meta: 'Menlo Park, CA / Sep 2019 - Dec 2021' },
    { company: 'Assurant', role: 'Data Engineer, Insurance &amp; E-Commerce Data Systems', meta: 'Atlanta, GA / Jul 2016 - Sep 2019' },
    { company: 'Kearney', role: 'Summer Intern', meta: 'Shanghai, China / Apr 2013 - Dec 2013' },
  ],
  education: [
    { school: 'University of Missouri Columbia', rest: 'Master of Science, 2015' },
    { school: 'East China University of Science and Technology', rest: 'Bachelor of Engineering, 2013' },
  ],
};

/**
 * A resume as a page with its own stylesheet, or null when there is none to
 * read. The structured payload is turned into the template; markup that already
 * carries a <style> block is used as sent. Bare markup returns null and is laid
 * out generically instead, since the styled renderer has no default stylesheet
 * of its own to fall back on.
 *
 * Lives here rather than in storage.js because both the PDF and the .docx have
 * to make this same choice, and they must make it the same way: whichever one
 * they take, the two documents are built from the same page.
 */
export function styledResume(content) {
  if (isResumeData(content)) return resumeHtml(content);
  const html = String(content);
  return /<style[\s>]/i.test(html) ? html : null;
}

/** Is this the structured resume payload, or just a blob of markup? */
export function isResumeData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'SUMMARY' in value || 'SKILLS' in value || 'EXPERIENCE' in value;
}

/** Contact entries may be plain strings or { text, href }. */
function normaliseContact(contact) {
  if (!Array.isArray(contact) || contact.length === 0) return null;
  return contact.map((entry) => (typeof entry === 'string' ? { text: entry } : entry));
}

/** Merge a submission over the fixed profile, tolerating missing pieces. */
export function resumeModel(input = {}) {
  const data = input || {};
  return {
    name: data.NAME || PROFILE.name,
    title: data.TITLE || PROFILE.title,
    contact: normaliseContact(data.CONTACT) || PROFILE.contact,
    jobs: Array.isArray(data.JOBS) && data.JOBS.length ? data.JOBS : PROFILE.jobs,
    education: Array.isArray(data.EDUCATION) && data.EDUCATION.length ? data.EDUCATION : PROFILE.education,
    summary: String(data.SUMMARY || '').trim(),
    skills: (Array.isArray(data.SKILLS) ? data.SKILLS : []).map((line) => String(line)).filter(Boolean),
    experience: (Array.isArray(data.EXPERIENCE) ? data.EXPERIENCE : []).map((bullets) =>
      (Array.isArray(bullets) ? bullets : [bullets]).map((text) => String(text)).filter(Boolean),
    ),
  };
}

/** Split "Label: value" into its bold label and the rest, as the page did. */
export function splitSkill(line) {
  const at = line.indexOf(':');
  return at === -1 ? { label: '', rest: line } : { label: line.slice(0, at + 1), rest: line.slice(at + 1).trim() };
}

/** Escape text for markup. Values already containing entities are left alone. */
const escape = (value) =>
  String(value ?? '')
    .replace(/&(?!(?:[a-z]+|#\d+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function resumeHtml(input = {}) {
  const model = resumeModel(input);

  const contact = model.contact
    .map((entry) =>
      entry.href ? `<a href="${escape(entry.href)}">${escape(entry.text)}</a>` : escape(entry.text),
    )
    .join('<span class="sep">&bull;</span>');

  const skills = model.skills
    .map((line) => {
      const { label, rest } = splitSkill(line);
      return label
        ? `    <p><span class="label">${escape(label)}</span> ${escape(rest)}</p>`
        : `    <p>${escape(line)}</p>`;
    })
    .join('\n');

  const jobs = model.jobs
    .map((job, index) => {
      const bullets = (model.experience[index] || [])
        .map((text) => `      <li>${escape(text)}</li>`)
        .join('\n');
      return `  <div class="job">
    <p class="job-line"><span class="company">${escape(job.company)}</span>, <span class="role">${escape(job.role)}</span></p>
    <p class="meta">${escape(job.meta)}</p>
    <ul data-exp="${index}">
${bullets}
    </ul>
  </div>`;
    })
    .join('\n\n');

  const education = model.education
    .map((entry) => `    <div><span class="school">${escape(entry.school)}</span>, ${escape(entry.rest)}</div>`)
    .join('\n');

  return `<!DOCTYPE html><html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escape(model.name)} - ${escape(model.title)}</title>
<style>
  :root {
    --teal: #17838a;
    --teal-dark: #0f6b73;
    --body: #2f4f57;
    --muted: #5b7078;
    --rule: #b9d3d6;
    --skills-bg: #e3f0f1;
  }

  * { box-sizing: border-box; }

  /* A4, to match the PDFs filed beside this page. */
  @page {
    size: A4 portrait;
    margin: 14mm 15mm;
  }

  body {
    margin: 0 auto;
    padding: 32px 40px 48px;
    max-width: 210mm;
    font-family: "Segoe UI", Calibri, "Helvetica Neue", Arial, sans-serif;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--body);
    background: #fff;
  }

  a { color: var(--teal); }

 h1.name {
    margin: 0;
    font-size: 32px;
    font-weight: 700;
    color: #1a1a1a;
    letter-spacing: -0.3px;
  }

 .title {
    margin: 4px 0 8px;
    font-size: 17px;
    font-weight: 700;
    color: var(--teal);
  }

 .header-rule {
    border: 0;
    border-top: 2px solid var(--teal);
    margin: 0 0 8px;
  }

 .contact {
    margin-bottom: 14px;
    font-size: 12px;
    color: var(--muted);
  }

 .contact .sep { margin: 0 6px; }

 h2.section {
    margin: 16px 0 4px;
    padding-bottom: 3px;
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--teal);
    border-bottom: 1px solid var(--rule);
  }

  .summary { margin: 8px 0 0; }

  /* ---------- Skills ---------- */
  .skills {
    margin-top: 10px;
    padding: 10px 14px;
    background: var(--skills-bg);
    border-left: 4px solid var(--teal);
  }

  .skills p { margin: 0 0 5px; }
  .skills p:last-child { margin-bottom: 0; }
  .skills .label { font-weight: 700; color: var(--teal-dark); }

  /* ---------- Experience ---------- */
  .job { margin-top: 12px; }

  .job-line {
    margin: 0;
    font-size: 14px;
    color: #1a1a1a;
  }

  .company { font-weight: 700; color: var(--teal); }
  .role { font-weight: 700; }

  .meta {
    margin: 1px 0 4px;
    font-size: 12px;
    font-style: italic;
    color: var(--muted);
  }

  ul {
    margin: 0;
    padding-left: 18px;
    list-style: none;
  }

  ul li {
    position: relative;
    margin-bottom: 5px;
  }

  ul li::before {
    content: "\\2022";
    position: absolute;
    left: -12px;
  }

  /* ---------- Education ---------- */
  .edu { margin-top: 8px; }
  .edu div { margin-bottom: 2px; }
  .edu .school { font-weight: 700; color: #1a1a1a; }

  @media print {
    body { padding: 0; font-size: 11pt; }
    .job, .edu { page-break-inside: avoid; }
    h2.section { page-break-after: avoid; }
  }
</style>
</head>
<body>

  <h1 class="name">${escape(model.name)}</h1>
  <p class="title">${escape(model.title)}</p>
  <hr class="header-rule">
  <p class="contact">
    ${contact}
  </p>

  <h2 class="section">Professional Summary</h2>
  <p class="summary" id="summary">${escape(model.summary)}</p>

  <h2 class="section">Technical Skills</h2>
  <div class="skills" id="skills">
${skills}
  </div>

  <h2 class="section">Professional Experience</h2>

${jobs}

  <h2 class="section">Education</h2>
  <div class="edu">
${education}
  </div>

</body>
</html>
`;
}
