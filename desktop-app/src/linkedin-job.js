// Reading a job off a LinkedIn tab, for Manual's Catch Job.

const isLinkedInJobUrl = (url) => {
  try {
    const { hostname, pathname } = new URL(url);
    return /(^|\.)linkedin\.com$/.test(hostname) && pathname.startsWith("/jobs");
  } catch {
    return false;
  }
};

// Runs inside the tab, so it can use nothing from this file. The description
// is all in the page even while "… more" shows only its start.
function readJob() {
  const text = (el) => (el?.innerText || "").trim();
  const heading = [...document.querySelectorAll("h2")].find((h) => text(h) === "About the job");

  let box = document.querySelector("#job-details");
  for (let el = heading; el && !box; el = el.parentElement) {
    box = el.querySelector('[data-testid="expandable-text-box"]');
  }
  let description = text(box);
  // No text box in this layout: the section under the heading, less the heading.
  for (let el = heading; el && !description; el = el.parentElement) {
    if (text(el).length > text(heading).length) description = text(el).slice(text(heading).length).trim();
  }

  // "AI Data Engineer III | Rimini Street | LinkedIn"; unread messages put
  // "(3) " in front.
  const parts = document.title.replace(/^\(\d+\)\s*/, "").split(" | ");
  if (parts.at(-1) === "LinkedIn") parts.pop();
  const company = parts.length > 1 ? parts.pop() : "";

  const id = new URLSearchParams(location.search).get("currentJobId") || /\/jobs\/view\/(\d+)/.exec(location.pathname)?.[1];
  return {
    visible: document.visibilityState === "visible",
    company,
    title: parts.join(" | ").trim(),
    url: id ? `https://www.linkedin.com/jobs/view/${id}/` : "",
    // The "… more" button sits inside the text box.
    description: description.replace(/\s*…\s*more$/, "").replace(/\n{3,}/g, "\n\n")
  };
}

module.exports = { isLinkedInJobUrl, READ_JOB: String(readJob) };
