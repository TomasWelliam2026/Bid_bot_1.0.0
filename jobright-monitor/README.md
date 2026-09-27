# Jobright Live Feed

A Chrome (MV3) extension. Opens `https://jobright.ai/jobs/recommend`, reads
every recommendation card, and streams **job title · company · link** into a
side panel docked to the right of the window — one card at a time, live.

## What it does

1. **Opens the page.** Pressing **Start** finds an open recommendations tab or
   creates one, and waits for it to finish loading.
2. **Extracts each card.** Every element whose `data-index` is a number is
   treated as a card; inside it the extension reads the `h2` job title, the
   company name, and the link URL.
3. **Streams to the panel.** Each card that clears the filter below is pushed
   to the panel the instant it does. Nothing is collected up and dumped at the
   end.
4. **Filters out what the collector already has.** Every card found is a
   candidate, not yet a caught item: `/get-item` is asked about it by company
   and title, and one the collector already holds is dropped outright — never
   listed, never stored, never opened. **The list holds only jobs that are new
   to the collector.**
5. **Visits each survivor.** Opened in its own tab, switched to, and read. If
   the posting's origin links to `https://www.linkedin.com` the tab is closed
   and the job is dropped; otherwise the description block is read out.
6. **Builds a resume and a cover letter.** The description goes to OpenAI with
   the prompt set under **ChatGPT setting**. The answer is JavaScript — a `resume`
   object baked into the resume template as a static, script-free page, and
   a `coverletter` string.
7. **POSTs it** — but only if the resume built. Each job whose resume and
   cover letter came back is sent to `http://localhost:4500/save-data`; one
   whose generation failed is left unsaved, and retried on the next run.

## What matches what

```
[data-index]                                  <- the card (numeric index only)
  ├─ h2[class*="index_job-title__Riiip"]      <- title, exact class first
  │  h2[class*="index_job-title__"]           <- fallback that survives rebuilds
  ├─ [class*="index_company-name__jnxCX"]     <- company, exact class first
  │  [class*="index_company-name__"]          <- fallback
  └─ a[href*="/jobs/"]                        <- link, absolutised
     a[href]                                  <- fallback
```

`index_job-title__Riiip` and `index_company-name__jnxCX` are Next.js
CSS-modules hashes. The suffix after the double underscore is regenerated
whenever Jobright rebuilds the site, so pinning it alone means the extension
silently returns nothing one day. Both are tried; when the prefix matches but
the pinned hash no longer does, the panel says
`class hash changed, prefix match held`.

### On the job detail page

```
[class*="index_origin__e6tHu"]                <- where the posting came from
  └─ a[href] starts with https://www.linkedin.com  =>  close tab, drop job

  otherwise:
#overview-1                                   <- the description block
   minus  <section> #1 and #2                       (headers, not content)
   minus  [class*="index_top__WAMvJ"]               (chrome)
   minus  [class*="index_job-metadata-row__iYsnl"]  (chrome)
```

The origin element is sometimes the anchor itself and sometimes a wrapper
around one, so both are checked. It keeps its `index_origin__` prefix fallback;
`#overview-1` needs none, because an id survives a rebuild in a way a hashed
class does not. The two dropped classes are hashed, so each is tried as the
pinned hash and then as its prefix (`index_top__`,
`index_job-metadata-row__`), flagging the drift when the prefix is what hit.

`#overview-1` supersedes `index_jobDetailContent__rhs3U`, which in turn had
superseded the per-part reads.

### Two things the trimming gets right

**It prunes a clone, never the live DOM.** Removing those nodes from the real
page would visibly dismantle the tab the user is watching go past.

**The first two sections are resolved *before* anything is removed.** Otherwise
a dropped `index_top__` block that happens to be a `<section>` would shift what
"first two" means and eat a section of real content. There is a regression test
for exactly this case.

## Dice

The **job board** select under Auto/Manual picks where Auto fetches from:
Jobright (everything above) or Dice. Glassdoor and Monster are listed but have
no fetcher yet, so Start stays off for them.

With Dice, Start opens a fixed search (`DICE_SEARCH_URL` in `background.js`:
full-time, remote, United States, "data engineer") and `content-dice.js` reads
it. Everything after the list (the duplicate filter, the visit queue, the
resume, the save) is the same as for Jobright.

```
[role="listitem"]                                   <- the card
  ├─ a[data-testid="job-search-job-detail-link"]    <- title = its aria-label,
  │                                                    link = its href (/job-detail/<uuid>)
  └─ [data-testid="job-card-company-name"]          <- company
     a[href*="companyname="]                        <- fallback: ?companyname=
```

The card's *first* `aria-label` is not the title: it is a hidden overlay
link labelled "View Details for <title> (<hash>)".

- **Pages.** Dice shows about 34 jobs per page and renders each page on the
  server, so pages 2, 3, … are fetched (`?page=N`) and read without leaving
  the one on screen. This stops at 50 accepted jobs, the last page, or a page
  with nothing new.
- **Job page.** The description is `[class*="__jobDescription"]`; if Dice
  renames that class, the `JobPosting` structured data
  (`script#jobDetailStructuredData`) stands in, and the panel flags it as a
  drift.
- **No LinkedIn rule.** Every Dice page links to Dice's own LinkedIn in its
  footer, so Jobright's "drop LinkedIn postings" check would drop them all.
  Dice jobs are never dropped for it.

## Glassdoor

With Glassdoor, Start opens a fixed search (`GLASSDOOR_SEARCH_URL` in
`background.js`: remote "data engineer" jobs) and `content-glassdoor.js`
reads it. The rest of the pipeline is shared, and there is no LinkedIn rule,
as on Dice.

```
li[data-test="jobListing"]                             <- the card
  ├─ a[data-test="job-title"]                          <- title = its text,
  │  (class JobCard_jobTitle__…)                          link = its href (/job-listing/…)
  └─ [class*="EmployerProfile_compactEmployerName__"]  <- company
```

- **More jobs.** The list starts at about 30 cards. "Show more jobs"
  (`button[data-test="load-more"]`) is pressed until 50 jobs are accepted,
  the button is gone, or a press brings nothing new. A sign-up prompt over
  the list is closed first if one appears.
- **Job page.** The description is `[class*="JobDetails_jobDescription__"]`,
  with the page's `JobPosting` structured data standing in if that class is
  renamed.
- **Bot check.** Glassdoor sometimes answers with a "Humans only" page
  instead of results. In a normal signed-in browser this is rare. When it
  happens the page has no cards, so nothing is found. Pass the check in the
  tab and press Start again.

## What a caught item shows

Every row is a job the collector did **not** already have — duplicates are
filtered out before the list, so they never appear. Each row carries the title,
company and link, then its outcome: saved, dropped as LinkedIn, or not sent.
Expanding it shows:

| | |
|---|---|
| **Source** | where the posting came from |
| **Trimmed** | how much of `#overview-1` was cut |
| **Resume built** | size, skills lines, bullets per role |
| **Summary** and **Cover letter** | the readable parts of the answer |
| **Answer** | the model's reply, verbatim |

**The job description is not shown.** It is a click away on the job's own page,
and this block is for checking the answer against the prompt — so the space
goes to what came back rather than what went in. `job_des` is still read and
still POSTed; only the panel omits it.

An answer that failed to parse is shown too, under **Answer (did not parse)**,
so the prompt can be fixed against what the model actually said.

### 50 items

A run collects at most **50 items** — and that counts jobs that survived the
duplicate filter, not cards seen on the page. The harvest keeps scrolling while
fewer than 50 have been accepted, so **a feed the collector mostly already
holds is scrolled further** rather than yielding a short list.

That is the whole reason the count is fed back: `content.js` cannot know which
candidates survived, so the worker reports the running total to the tab as
`ACCEPTED`, and the scroll loop reads it.

Four exits, so it always terminates: 50 accepted, the list genuinely ending
(two dry rounds at the bottom), the candidate bound (`MAX_CANDIDATES`, 400 —
in case the collector holds so much that 50 new ones never appear), or the
scroll budget.

The status line reads `Scrolling the list… 12 new of 50` while short, then
`50 new · limit reached, no more scrolling`, and `Watching for new cards ·
12 new of 30 seen` once the harvest is done — seen and new are different
numbers now, and both are shown.

The cap lives in three places, because the three contexts have no shared
module: `MAX_ITEMS` in `content.js` is the scroll target, `MAX_ITEMS` in
`sidepanel.js` backstops the rendered list, and `MAX_STORED` in
`background.js` caps both storage and the filter. **They must agree** —
`verify.js` fails if they drift apart.

### Clear

**Clear** empties the list and leaves it empty. It drops the rendered rows, the
stored jobs, the badge, the pending visit queue and the counters.

It also tells the feed tab to **forget** what it has seen — but only to forget,
not to re-scan. Those are different, and the difference is the whole behaviour:
the content script dedupes per tab, so without dropping that map a later
**Start** would find every card "already seen" and stream nothing. Dropping it
*and* re-scanning, which is what this used to do, streamed every mounted card
straight back in and made Clear look like it had done nothing.

So: Clear leaves an empty list, a later Start refills it, and a card found in
between still arrives normally. There are tests for all three.

## Tabs

The panel has two top-level tabs:

| Tab | State |
|-----|-------|
| **Generate JD & Resume** | The feed, the duplicate filter, the visit queue, generation, the POST |
| **Job bid** | Shell only, no behaviour yet |

The **Settings** button on the Generate tab opens a third screen — not a
top-level tab itself — in place of the feed; **← Back** (or picking Generate
or Job bid) returns to it. Settings holds its own trio of tabs: **ChatGPT
setting** (the OpenAI API key, model, prompt and master resume), **Resume
style** (the layout picker and Style add/Remove), and **Profile** (just
**Country name** — see below).

Switching only shows and hides, at both levels. The feed keeps streaming into
the Generate pane while Job bid is in front, and an unsaved edit in the master
resume survives a trip to the Resume style tab — nothing is torn down or
re-fetched on the way back, because every pane stays in the document and is
merely not displayed.

One thing to watch if you restyle this: `.pane` sets `display: flex` so its
list can take the leftover height, and that **beats the browser's built-in
`[hidden] { display: none }`**. `.pane[hidden] { display: none }` is declared
explicitly for that reason; drop it and both panes render at once. There is a
test asserting the hidden pane really computes to `display: none`.

Arrow keys move between tabs, and each strip is its own single stop in the tab
order (roving `tabindex`) — the standard tablist pattern, wired separately per
strip so the settings pair and the top-level pair never cycle into each other.

## Light and dark mode

**Light by default.** The sun/moon button next to **Settings** on the
Generate tab switches to dark and back; it is not a `prefers-color-scheme`
follow, so the panel will not flip on you just because the OS theme changes
mid-session. The choice is saved (`chrome.storage.local`, key `theme`) and
restored the next time the panel opens — a fresh install with nothing stored
yet reads as light.

Applying a theme is nothing but a `data-theme="dark"` (or no attribute, for
light) on `<html>`. Every color in `sidepanel.css` is a custom property under
`:root`; `:root[data-theme="dark"]` overrides the same set. Nothing else in
the page touches a color directly, so a new control never needs its own
theme-awareness — it just has to use the existing tokens.

The toggle lives in the Generate tab's titlebar only, so it is one tab switch
away while Settings or Job bid is in front rather than reachable from
everywhere. That's a placement choice, not a limitation of the toggle itself.

## Stop

**Stop** halts everything in flight, not just the next thing. Clearing the
queue alone would not be enough — the job already being visited would keep
going, holding its tab open for up to 25s and still POSTing its result after
the user asked it to stop.

One `AbortController` per run covers the lot. Stop aborts it, which unblocks
every await at once:

| In flight | How Stop reaches it |
|-----------|---------------------|
| Feed observer + scroll harvest | `STOP_STREAM` to the content script |
| Waiting for a detail page to load | `waitForComplete` rejects on the signal |
| Injecting the content script | the retry loop checks the signal each pass |
| Waiting for the scrape reply | the tab is closed, so `sendMessage` rejects |
| The POST | `AbortSignal.any([timeout, signal])` |

The job interrupted mid-read is **put back at the front of the queue** rather
than stored as a half-reading, and the pending queue is kept, so pressing
**Start** again carries on where it left off. It stays in the dedupe set while
it waits, so it cannot be enqueued twice.

The button is disabled when nothing is running and enabled while *either* the
feed stream or the visit queue is active — the queue keeps draining after the
stream itself has finished, and Stop has to stay available for it. The UI flips
the moment you click, before the round trip, so the button never feels ignored.

## Posting to the collector

### 1. The duplicate filter, before the list

Every card the feed finds is a **candidate**. Before it becomes a caught item,
the collector is asked about it:

```
POST http://localhost:4500/get-item
{ "company": "Acme Corp", "job_title": "Senior Frontend Engineer" }
        │
   { code: 200, msg: "already exist" }  ─▶  dropped: not listed, not stored,
        │                                   not opened, not saved
   anything else  ─▶  listed, then opened, read, generated for, and saved
```

**Only the exact answer `{ "code": 200, "msg": "already exist" }` on an HTTP 200
drops the job.** Everything else means "not a duplicate": a different `code`, a
different `msg`, a non-200 status (your `401 / "not exist"` included), a
non-JSON body, a timeout, or the server not being up.

That last part is deliberate — **the filter fails open.** A check you could not
make must never silently cost you a job. When one got through without a working
check, the panel says so on that row rather than hiding it.

The filter only runs while **POST to localhost:4500/save-data** is ticked. With
saving off the collector holds nothing, so every candidate is new.

### Why the filter is its own queue

The two stages run at completely different speeds. A `/get-item` call is a
localhost round trip; a visit is a page load plus a generation. Running the
filter inside the work queue would fill the list one row every half-minute
instead of as fast as the feed finds cards — so the filter drains on its own,
and hands survivors to the slow queue behind it.

### 2. The resume document

A job the collector does not have is worth generating for. The description
**text** (not the markup — that would be tokens spent on chrome) goes to OpenAI
with the prompt from ChatGPT setting, and the answer is built into a full HTML
resume.

**The model returns JavaScript, not prose.** The resume template holds only
the layout; every word comes from the answer — the header, the summary, the
skills lines, every role with its bullets, the certifications and the
education. So the answer has to come back in the shape of the template's
`data.js`, plus the cover letter:

```js
const resume = {
  "CONTACT": ["Full name", "Headline title", "City, ST ZIP", "phone", "email", "https://linkedin.com/in/…"],
  "SUMMARY": "one paragraph",
  "SKILLS": ["Languages: Python, SQL"],
  "EXPERIENCE": [
    ["Company", "Job title", "Location", "Start – End", "bullet", "bullet"]
  ],
  "CERTIFICATIONS": ["Certification name"],
  "EDUCATION": [
    ["School", [["Degree", "Field of study"]], "Year"]
  ]
};
const coverletter = "the cover letter for this job, plain text";
```

`CONTACT` is the name, the headline title, then the rest of the contact line in
the order given; a URL is shown as a link (*LinkedIn* for a linkedin.com one).
`EXPERIENCE` holds one array per role — 3 to 7 is expected, and a count outside
that builds anyway with a warning. `CERTIFICATIONS` is a list of names; empty
or left out, the certification section is removed from the resume.
`EDUCATION` holds one array per school, whose middle item lists every degree
earned there as `[degree, field]`. The school is shown bold with its years
hard right, and under it one line per degree, as *Bachelor of Science (B.S.),
Business Data Analytics*. A plain `"Degree"` string there is read too. Left out, the template's own education stays, with a
warning. The `coverletter` may also be a key of the object instead of its own
`const`.

### Your prompt is sent exactly as you set it

Nothing is appended to it. The prompt goes out as the system message byte for
byte, and the job description text goes out alongside it as the user message.

That means **your prompt has to ask for the shape above itself** — otherwise the
answer cannot be built and the job saves with `resume: null` and the panel
saying so. The default prompt already asks for it.

The ChatGPT setting screen shows that shape under **What the builder reads back**, together
with the exact roles read out of your template, so you can copy what you need
into your prompt. It is reference only — displayed, never sent. A test asserts
the system message reaching the endpoint is character-for-character your prompt,
with no contract and no role list added.

### That code is parsed, never run

MV3 forbids `eval` and `new Function` outright, and running text a model wrote
would be a bad idea even where it is allowed. The two declarations are located
and read as literals by a small string-aware scanner.

Being a scanner rather than `JSON.parse`, it copes with what models actually
emit: bare keys, single quotes, backtick template literals with real newlines,
trailing commas, a comma dropped between two strings, `//` and `/* */`
comments, and a ```` ```js ```` fence around the whole thing. It also
survives the traps — a `{` or a `Role:` *inside* a string does not end the
object or become a key.

There is no `response_format` on the request: JSON mode would force a bare JSON
object, and the answer wanted is JavaScript source carrying two declarations.

### How the roles are laid out

The template's **first `<div class="job">` block is the pattern**. The builder
makes one copy of it per `EXPERIENCE` entry, fills its `.company`, `.role`,
`.location` and `.dates` with the first four strings and its `<ul data-exp>`
with the rest, and replaces every job block in the template with those copies.

Education and certifications work the same way. The first `.edu-item` is
copied once per `EDUCATION` entry, with `.school` and `.year` filled and its
first `.degree` line copied once per degree. The first `.cert-item` is copied once per certification — into its
`.cert-name` if it has one, otherwise into the item itself — and with no
certifications the whole `.cert-section` is removed. The employers, schools
and certifications written in the template are only there so it previews
sensibly on its own.

### Editing your resume

Edit the template for the style you use — it is the layout only, plain HTML,
no code change needed. Name, contact line, roles, certifications and education
all come from the answer, so change those in your master resume or prompt, not the template.

One caveat: the builder finds the holes with regexes over the file's text, so
it cannot tell a tag in a comment from a real one. Don't write `class="job"`,
`class="company"`, `class="role"`, `class="meta"`, `class="edu-item"`,
`class="year"`, `class="cert-item"` or `class="cert-section"` inside an HTML
comment.

### Resume styles

**Resume style**, its own tab in Settings next to **ChatGPT setting**, picks
the layout. Two ship:

| Style  | Looks like |
|--------|------------|
| `DE-1` | Teal section headings, sans-serif, skills in a tinted box |
| `SF-1` | Navy caps name and section labels, sans-serif; every section is a label-left/content-right row with dates hard right and a hairline under each row; skills flow into two bulleted columns |

They are interchangeable — every style carries the same holes and is filled
from the same answer, so switching is purely cosmetic and takes
effect on the next job generated. A style whose file has gone missing falls
back to `DE-1` rather than failing the job.

Adding a third is a file, a line in `RESUME_STYLES` in `background.js`, and an
`<option>` in `sidepanel.html`. Nothing else.

#### Style add

**Style add**, under the Resume style list, adds your own template without
touching the extension's files. Pick an `.html` file and it appears in the list
as *name — added from file.html*, named after the file. Select it and press
**Save**; every resume built after that uses it and is sent to the collector as
usual.

- An extension cannot write into its own install folder, so the file's HTML is
  kept in `chrome.storage.local` under `customStyles`, not copied beside the
  built-in templates.
- The file must carry the holes the builder cannot do without —
  `<p id="summary">`, `<div id="skills">`, and a `<div class="job">` holding a
  `<ul data-exp="0">` (with `.company`, `.role`, `.location` and `.dates`
  inside it — or a single `.meta`, which then gets "location | dates"). A
  file missing any of them is refused, with the missing ones named. The header
  (`h1.name`, `.title`, `.contact`), education (`.edu-item`) and
  certifications (`.cert-item`) are filled where the file has them and left
  alone where it does not. A style added before job blocks existed still
  builds, keeping its own employer lines, with a warning.
- Adding a file with the same name again replaces that style, and the next job
  uses the new file. A built-in name (`DE-1`, `SF-1`) is refused.
- **Remove style** deletes the selected added style. A saved profile that
  pointed at it goes back to `DE-1`.

### The document that gets built

The template renders itself in a browser from a `resume` global loaded via
`./data.js`. What gets **stored** is the same output with the data already baked
into the markup and **every `<script>` removed** — including the template's own
renderer and the `data.js` reference.

That matters: the stored `resume` is static HTML. No JavaScript, nothing to
load, no `data.js` to ship alongside it. It prints, converts to PDF, and renders
in an email client or an iframe exactly as-is.

**Model output is HTML-escaped** on the way in. A stray `<` in a bullet would
otherwise break the markup, and a deliberate `</p><script>` would inject into a
document you are about to store and open. There are tests firing both at it.

**A malformed reply does not build.** Unparseable code, or an answer with no
`SUMMARY`, fails the generation — the job still saves with `resume: null`, and the panel shows
the raw answer so you can fix the prompt against what the model actually said.
A reply that is merely short still builds, with a warning naming each empty
role.

**Nothing is sent unless the resume builds.** A job whose generation fails —
rate limit, bad key, unparseable answer — is left unsaved rather than stored
half-done. The panel marks it `Not sent — nothing is saved without a resume`
and shows why, surfacing OpenAI's own error message rather than just a status
code.

That has a useful consequence: because the job was never saved, `/get-item`
still reports it missing, so **the next run picks it up and tries again**. There
is a test for exactly that sequence.

It has a blunt consequence too: **with no API key set, nothing is saved at
all**, since no job can get past the resume gate. The ChatGPT setting screen says so
rather than leaving you to work it out from an empty collector.

Generation gets its own 120s budget rather than the 10s the localhost calls
use, and Stop interrupts it like everything else.

### 3. The save

Then the job is POSTed as JSON to `http://localhost:4500/save-data`
(`SAVE_ENDPOINT` in `background.js`):

```json
{
  "job_url":     "https://jobright.ai/jobs/info/…",
  "job_des":     "<div id=\"overview-1\">…</div>",
  "resume":      "<!DOCTYPE html><html>…the built resume page…</html>",
  "coverletter": "<textarea>Dear hiring manager, …</textarea>",
  "company":     "Acme Corp",
  "job_title":   "Senior Frontend Engineer",
  "user":        "United States"
}
```

**`user` is whatever Profile's Country name field holds** — plain text, sent
as typed, so the collector knows which country tab this application belongs
on. Left blank, the job still saves; the collector just has no tab to file it
under.

**`coverletter` is wrapped in a `<textarea>`**, so it drops straight into a form
on the other side:

```html
<textarea>Dear hiring manager,

I would like to apply…</textarea>
```

The letter is HTML-escaped going in. Textarea content is RCDATA — a literal
`</textarea>` in the letter would close the element early and spill the rest as
markup — and character references are decoded on parse, so the escaping
round-trips back to the original text. A test fires
`</textarea><script>` at it and checks the element still closes exactly once.

When the model returns no cover letter, this is `null` rather than an empty
textarea.

**`job_des` is the element's `outerHTML`.** A DOM element cannot cross a
message port, so it has to be serialised; the markup was chosen over plain text
because the spec said *html element*. To send text instead, swap
`descriptionHtml` for `descriptionText` in `saveJob()` — the content script
already extracts both, and the panel previews the text either way.

The POST is made by the **service worker**, not the content script. A content
script's `fetch` runs against the page's own origin, so posting to localhost
from jobright.ai would be a cross-origin request needing CORS headers on your
server. The worker fetches as the extension, and a host permission covers it
with no CORS involvement.

The manifest grants `http://localhost/*`, **not** `http://localhost:4500/*` —
Chrome match patterns cannot carry a port, and a manifest containing one is
rejected outright. The portless form covers every port on that host.

Failures never stop the queue: the request has a 10s abort timeout, and the
outcome is reported per job in the panel (`✓ Saved to localhost:4500`, or the
error). Untick **POST to localhost:4500/save-data** to visit and read jobs
without sending anything.

### One thing to know about `data-index`

The spec for this build was "`data-index` is a number **more than 0**", so
`MIN_DATA_INDEX` in [`content.js`](content.js) is `1`.

react-window numbers its rows from zero, so the **first card on the page
carries `data-index="0"` and is skipped**. If you want it, set that constant
to `0` — it is the only place the threshold appears.

## Files

| File             | Role |
|------------------|------|
| `manifest.json`  | MV3 manifest, scoped to `jobright.ai` and `*.jobright.ai` |
| `content.js`     | Selectors, extraction, MutationObserver, virtual-list scrolling |
| `content-dice.js` | The same for dice.com: cards, later pages by fetch, the job page |
| `content-glassdoor.js` | The same for glassdoor.com: cards, "Show more jobs", the job page |
| `background.js`  | Opens the tab, guarantees an injected content script, persists jobs |
| `sidepanel.html` | The panel shell — tab bar and the three panes |
| `sidepanel.css`  | Panel styling, light and dark |
| `sidepanel.js`   | Live rendering |
| `resume_temples/resume-template-DE-1.html` | Your resume, style `DE-1`: fixed half, plus the holes the model fills |
| `resume_temples/resume-template-sf1.html` | The same resume, style `SF-1` |
| `resume_temples/resume-template-sf2.html` | Style `SF-2`: blue headline and headings, "Company \| Role" in blue italics, dates before location |

## Load it

1. `chrome://extensions` → **Developer mode** on
2. **Load unpacked** → pick this folder
3. Sign in to jobright.ai in the same Chrome profile
4. Click the toolbar icon — the side panel opens on the right
5. **Start** to run, **Stop** to halt everything in flight

Chrome 116+ (`chrome.sidePanel.open`). There is no popup: the toolbar button
opens the panel directly via `openPanelOnActionClick`.

## Two things that make this page harder than it looks

**The list is virtualized.** `data-index` is the react-window signature: only
the visible slice of the list exists in the DOM at any moment, so a single
`querySelectorAll` sees ~10 cards, not the whole feed. With **Scroll the list
to load every card** ticked, `harvest()` scrolls the container so the rest
mount, and the observer streams them as they appear; the original scroll
position is restored afterwards.

The feed tab is **focused**, not opened in the background, on purpose — a
backgrounded tab throttles timers and may not mount offscreen rows at all,
which stalls the harvest.

**The cards render after load.** A `MutationObserver` watches for them rather
than scraping once at `document_idle`, which would come up empty. It keeps
watching after the harvest, so cards that appear later still stream in.

## How "live" works

The content script broadcasts each job with `chrome.runtime.sendMessage`, which
every extension page receives. The panel is a listener, so jobs land in it
directly — no polling, no round trip through storage. The service worker
listens to the same broadcast purely to persist jobs, which is what refills the
list when you close and reopen the panel.

## "Could not establish connection. Receiving end does not exist."

That error means `chrome.tabs.sendMessage` found no content script listening in
the target tab. Four separate causes are handled:

| Cause | Fix |
|-------|-----|
| Extension reloaded or updated while the tab was already open — the old script is dead, no new one is injected | `ensureContentScript()` pings, then injects with `chrome.scripting.executeScript` |
| SPA navigation: jobright.ai is Next.js, so reaching `/jobs/recommend` from another route is a `pushState`, which never triggers injection | Match the whole site, plus the same inject-on-demand path |
| Tab reached `status === "complete"` before the script registered its listener at `document_idle` | Ping/inject retried five times with a widening gap |
| Tab was on `www.jobright.ai`, outside the match patterns | `https://*.jobright.ai/*` in both `matches` and `host_permissions` |

`content.js` is guarded by `window.__jobrightFeedLoaded`, so re-injecting a tab
that already has it is a no-op rather than a second listener streaming every
job twice.

Related: `waitForComplete()` arms its listeners *before* reading `tab.status`,
so a tab that finishes loading between those two steps does not wait out the
full 30s timeout for an event that already fired.

## The visit queue

Jobs are visited **one at a time**, with a 700ms gap between them
(`DETAIL_GAP_MS` in `background.js`). This is someone's site being opened once
per job; a burst of parallel tabs would be both rude and, in practice, slower.

Each detail tab is **switched to**, not opened in the background
(`FOCUS_DETAIL_TABS` in `background.js`). Besides being what you see, this makes
the read more reliable: a backgrounded tab can defer rendering, so a page that
is never shown may never paint the block being waited for. The cost is that the
browser visibly walks through jobs while the queue drains — set the constant to
`false` to read them out of sight instead.

Detail tabs are created as the feed tab's **child** (`openerTabId`), so closing
one hands focus back to the recommendations list rather than to whatever tab
happened to sit next to it. The opener is optional: Chrome rejects it if the
feed tab has since closed or moved to another window, and the visit proceeds
fine without it.

The tab is closed in a `finally` either way. The spec only calls for closing it
on a LinkedIn origin, but a tab opened to be read has no reason to outlive the
read.

A LinkedIn job stays visible in the panel, struck through and dimmed, rather
than disappearing — so you can see the filter working instead of watching jobs
silently vanish. Untick **Open each job** to skip the whole pass; toggling it
mid-run takes effect immediately and empties the queue.

## Behaviour notes

- Jobs are deduplicated by link URL, falling back to title + company.
- The last 500 jobs persist in `chrome.storage.local`; the badge shows the
  count. **Clear** empties the list and re-emits whatever is still mounted.
- Signed out → no cards. The panel calls that out separately from a selector
  break, so you know which one you are looking at.

## ChatGPT setting

Opened with the **Settings** button on the Generate tab, under the **ChatGPT
setting** tab (next to **Resume style**); **← Back** returns to the feed.

Three settings — **API key**, **Model**, **Prompt** — and an explicit **Save**.

Nothing is written until you press it. Because there is no save-on-blur, an
edit sitting in a field would otherwise look exactly like a saved one, so the
form tracks what changed against what is stored:

- **Save** and **Revert** are disabled until something actually differs.
- An unsaved edit shows `● Unsaved changes`.
- Editing a field *back* to its stored value disables them again — it is a
  comparison, not a flag.
- **Revert** restores the stored values without writing anything.
- A failed save keeps your edit in the field and leaves **Save** enabled to
  retry, rather than dropping what you typed.

The key is trimmed on save, and the form is refilled from what the worker
actually stored, so what you see is what is held.

### The model list

The **Model** dropdown carries a few general-purpose models rather than making
you type an id. Every one of them supports JSON mode, which the resume builder
requires.

The list is a convenience, not a limit: **Custom…** reveals a text box for any
model id — a pinned snapshot like `gpt-4o-2024-11-20`, or anything released
after this build. A stored model the list does not carry loads into Custom…
automatically, so upgrading the extension never silently changes which model
you are paying for. Saving with Custom… selected and the box empty is refused
rather than storing a blank model.

### Test connection

**Test connection**, under Model, sends one fixed message straight to OpenAI —
`Hello, GPT. can you receive this message? if you received data, reply OK or
not reply NOT` — and shows exactly what came back beneath the button.

It reads the **API key** and **Model** fields as they currently stand, not the
saved profile, so a new key can be checked before **Save** — nothing here is
written to storage. No prompt, no master resume, no job description: this is
only a "does this key and model answer at all" check, not a rehearsal of a
real generation. A bad key, a bad model id, or no response inside 20s comes
back as `Failed: …` with OpenAI's own error message where there is one.

## Your API key

The key from **ChatGPT setting** is held in `chrome.storage.local`, which is
**not encrypted**. Anyone who can read this Chrome profile's directory can read
the key. That is true of any extension holding a credential, but it is worth
knowing before you paste in a key with a high spend limit — a scoped,
low-limit key is the right thing to use here.

It is sent only to `api.openai.com`, and only from the service worker, so it
never enters a page's JavaScript context.

## Scope

This reads your own logged-in recommendations in your own browser. Check
Jobright's terms before pointing it at anything beyond personal use.
