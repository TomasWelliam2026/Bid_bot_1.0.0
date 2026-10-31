// Fake job boards for the tests: jobright.ai's recommendation feed and
// www.dice.com's search, each with its job pages, served over HTTPS from one
// local port. Chrome is pointed at it with --host-resolver-rules, so the
// extension's content scripts see the real host names and run as on the real
// sites. Only the markup those scripts read is reproduced.

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const HOSTS = ["jobright.ai", "www.jobright.ai", "www.dice.com", "mail.google.com"];

// jobright.ai/jobs/recommend: a react-window style list that renders more
// cards as it nears its end.
//   total     cards in the whole feed
//   firstShown  cards rendered before any scrolling
//   loadDelay ms between reaching the end and the next cards appearing
//   lateScroller  the list's box only becomes scrollable a moment after load,
//                 so a scroller looked for at once is not it
function jobrightFeed({ total, firstShown = 20, loadDelay = 50, lateScroller = false }) {
  return `<!doctype html><meta charset="utf-8"><title>Recommended jobs</title>
<style>
  body { margin: 0; ${lateScroller ? "height: 100vh; overflow: hidden;" : ""} }
  #list { height: 600px; overflow-y: ${lateScroller ? "visible" : "auto"}; }
  #list.ready { overflow-y: auto; }
  [data-index] { height: 100px; border-bottom: 1px solid #ccc; }
</style>
<div id="list"></div>
<script>
  const list = document.getElementById("list");
  let shown = 0;
  function more(n) {
    for (let i = 0; i < n && shown < ${total}; i++, shown++) {
      const d = document.createElement("div");
      d.setAttribute("data-index", String(shown));
      d.innerHTML = '<a href="/jobs/info/j' + shown + '"><h2 class="index_job-title__Riiip">Job ' + shown +
        '</h2></a><div class="index_company-name__jnxCX">Co ' + shown + '</div>';
      list.appendChild(d);
    }
  }
  more(${firstShown});
  ${lateScroller ? 'setTimeout(() => list.classList.add("ready"), 2500);' : ""}
  let loading = false;
  list.addEventListener("scroll", () => {
    if (loading || list.scrollTop + list.clientHeight < list.scrollHeight - 300) return;
    loading = true;
    setTimeout(() => { more(10); loading = false; }, ${loadDelay});
  });
</script>`;
}

const jobrightJob = (id) => `<!doctype html><meta charset="utf-8"><title>${id}</title>
<a class="index_origin__e6tHu" href="https://company.example/apply/${id}">Apply on company site</a>
<div id="overview-1"><section>head</section><section>meta</section>
<section><p>We need a data engineer for ${id}. Python, SQL, Spark.</p></section></div>`;

// www.dice.com/jobs: one search page of cards, with a pager whose Next is
// disabled on the last page. pagesFor(term) and perPage set its size.
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-");
function diceSearch(term, page, { perPage, pagesFor }) {
  const last = page >= pagesFor(term);
  const cards = Array.from({ length: perPage }, (_, k) => {
    const id = `${slug(term)}-${page}-${k + 1}`;
    return `<div role="listitem"><a data-testid="job-search-job-detail-link" aria-label="${term} job ${page}.${k + 1}"
      href="/job-detail/${id}">${term} job ${page}.${k + 1}</a>
      <span data-testid="job-card-company-name">${term} Co ${page}${k + 1}</span></div>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>${term} p${page}</title>
<div role="list">${cards}</div>
<nav aria-label="Pagination">
  <a aria-label="Next" href="/jobs?q=${encodeURIComponent(term)}&page=${page + 1}"
     ${last ? 'aria-disabled="true" class="disabled"' : ""}>Next</a>
</nav>`;
}

const diceJob = (id) => `<!doctype html><meta charset="utf-8"><title>${id}</title>
<div class="job-details__jobDescription_x1"><h2>About the role</h2><p>We are hiring for ${id} &amp; more.</p>
<ul><li>Python</li><li>SQL &gt; Excel</li></ul><p>Pay: $120k, "remote"</p></div>`;

// mail.google.com: Gmail's inbox, which draws its new-message window a
// moment after loading when the address asks for one (#…?compose=new). Like
// Gmail's, the To field turns the address typed into it into a recipient
// chip when it is left, and Send acts on the mouse going down and up. The
// page reports what it holds on window.__compose, and each message sent to
// the server (POST /__sent), which keeps it in `sentMail`.
const gmail = () => `<!doctype html><meta charset="utf-8"><title>Inbox - Gmail</title>
<div id="inbox">Inbox</div>
<script>
  window.__compose = null;
  if (location.hash.includes("compose=new")) setTimeout(() => {
    const box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.innerHTML = '<div class="to"><span class="chips"></span><input aria-label="To recipients"></div>' +
      '<input name="subjectbox" placeholder="Subject"><div aria-label="Message Body" role="textbox" contenteditable="true"></div>' +
      '<div role="button" class="send" data-tooltip="Send ‪(Ctrl-Enter)‬" aria-label="Send ‪(Ctrl-Enter)‬">Send</div>' +
      '<div role="button" aria-label="More send options">▾</div>';
    document.body.appendChild(box);
    const to = box.querySelector('input[aria-label="To recipients"]');
    const subject = box.querySelector('input[name="subjectbox"]');
    const chips = box.querySelector(".chips");
    const report = () => (window.__compose = {
      recipients: [...chips.querySelectorAll("[email]")].map((c) => c.getAttribute("email")),
      typed: to.value,
      subject: subject.value
    });
    to.addEventListener("blur", () => {
      if (!to.value.trim()) return;
      const chip = document.createElement("span");
      chip.setAttribute("email", to.value.trim());
      chip.textContent = to.value.trim();
      chips.appendChild(chip);
      to.value = "";
      report();
    });
    subject.addEventListener("input", report);
    report();
    const body = box.querySelector('[aria-label="Message Body"]');
    let down = false;
    const send = box.querySelector(".send");
    send.addEventListener("mousedown", () => (down = true));
    send.addEventListener("mouseup", async () => {
      if (!down) return;
      down = false;
      report();
      const message = { ...window.__compose, body: body.innerText };
      await fetch("/__sent", { method: "POST", body: JSON.stringify(message) });
      box.remove();
      const toast = document.createElement("div");
      toast.setAttribute("role", "alert");
      toast.textContent = "Message sent";
      document.body.appendChild(toast);
    });
  }, 2000);
</script>`;

// Starts the server. Every request is kept in `requests` as { host, path }.
async function startFakeSites({ jobright = {}, dice = {} } = {}) {
  const requests = [];
  const sentMail = [];
  const diceOptions = { perPage: 3, pagesFor: () => 3, ...dice };
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(FIXTURES, "test-key.pem")),
      cert: fs.readFileSync(path.join(FIXTURES, "test-cert.pem"))
    },
    (req, res) => {
      const host = String(req.headers.host || "").split(":")[0];
      const url = new URL(req.url, `https://${host}`);
      requests.push({ host, path: url.pathname + url.search });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (host === "mail.google.com" && req.method === "POST" && url.pathname === "/__sent") {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          sentMail.push(JSON.parse(data));
          res.end("{}");
        });
        return;
      }
      if (host === "mail.google.com") return res.end(gmail());
      if (host.endsWith("jobright.ai")) {
        if (url.pathname.startsWith("/jobs/info/")) return res.end(jobrightJob(url.pathname.split("/").pop()));
        return res.end(jobrightFeed({ total: 300, ...jobright }));
      }
      if (url.pathname.startsWith("/job-detail/")) return res.end(diceJob(url.pathname.split("/").pop()));
      res.end(diceSearch(url.searchParams.get("q") || "none", Number(url.searchParams.get("page") || 1), diceOptions));
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    sentMail,
    // What Chrome needs to reach the fake hosts instead of the real ones.
    chromeArgs: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(", ")}`, "--ignore-certificate-errors"],
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startFakeSites };
