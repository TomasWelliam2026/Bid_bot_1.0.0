# Jobsaver dashboard

A live view of the job application archive kept by the local `backend`
server, with the Automatic / Human-check switch, resume/cover-letter review,
CSV import, and syncing records out to a Google Sheet. One archive tab per
applicant/profile; the jobright-monitor extension files resumes against the
same archive this dashboard shows.

```
npm install
npm run dev      # http://localhost:5175 by default, talking to backend on :4500
```

The dashboard is only a client: it reads and writes through the `backend`
server's local SQLite database (`backend/database/jobsaver.db` by default).
**That database is local to the machine the backend runs on** — there is no
built-in sync between two separate installs of this project. Running it on a
second computer gets you a second, independent archive, with its own tabs,
settings and history, unless you deliberately point both at one shared
backend over the network.

## Sheet sync

Each archive tab can send its own rows to a Google Sheet via a small Apps
Script Web App (`sheet-sync.gs` at the repo root) deployed from that sheet.
The **Web App URL**, **Sheet URL** and **Sheet tab** are one setting shared
by every archive tab on a given install (`Sheet sync` panel, which also
generates the Apps Script for you); each tab's own **Profile (D)** and
**Country (C)** are sent along with every row it sends.

### Reading a sheet's rows back in

Nothing here pulls from the sheet automatically — if someone edits the sheet
directly (by hand, or from a second computer not wired into the same
backend), bring those rows in with **Import from CSV**:

1. In the Google Sheet, click the worksheet tab you want and
   **File → Download → Comma-separated values (.csv)**. This exports only
   the tab that's currently selected, not the whole spreadsheet — export
   each worksheet tab you need separately.
2. **Import from CSV** reads columns **B** (date), **C** (tab/Country),
   **E** (company), **F** (position), **G** (job URL) by position — see
   `src/lib/csv.js`. Rows import already marked sent, since they're already
   sitting in the sheet a send would otherwise append to again.
3. A row's column C, if filled in on the sheet, files it under the matching
   archive tab regardless of which tab is open in the dashboard when you
   import. A blank column C falls back to whichever tab is open — switch to
   the right one first if the sheet doesn't carry that column.

### Two computers writing into the same spreadsheet, different worksheet tabs

A common setup: Computer 1 and Computer 2 each run their own install of this
project, and you want each one sending its rows into its own worksheet tab
of one shared Google Sheet (e.g. tab `US`, tab `PH`). The Apps Script already
supports this — it reads which worksheet tab to write to out of every
request (`sheetTab`, resolved to that name with `getSheetByName`, see
`sheet-sync.gs`) — but three things have to line up, or it quietly fails
with `forbidden` or `No sheet tab named "…"`:

1. **Both worksheet tabs must already exist in the spreadsheet.** The script
   never creates one — a `Sheet tab` setting that names a tab not already at
   the bottom of the spreadsheet fails outright.
2. **Both computers must point at the exact same Web App URL and Sheet
   URL** — i.e. the same deployment. Deploy the script once, from either
   computer (**Generate script** → paste into the sheet's Apps Script editor
   → **Deploy**), and copy that one Web App URL into both installs' settings
   rather than each generating and deploying its own copy.
3. **Both computers must share the same secret.** Each backend generates its
   own random secret the first time it runs, and a deployment only accepts
   requests whose secret matches the one baked into it as `SHARED_SECRET`.
   There's no field for this in the Sheet sync panel on purpose — it's meant
   to be set once per archive, not edited by hand — but the API still
   accepts it directly for exactly this situation:
   - Read it off whichever computer's script you actually deployed: click
     **Generate script** there and look for `const SHARED_SECRET = "…";`
     near the top.
   - On the other computer, send that value in directly:
     ```
     curl -X PATCH http://localhost:4500/api/sheet-settings \
       -H "Content-Type: application/json" \
       -d '{"secret":"<value from above>","webAppUrl":"<same URL>","sheetUrl":"<same URL>","sheetTabName":"PH"}'
     ```

Each computer's own **Sheet tab** field (set in its Sheet sync panel, last
in the command above) is what actually decides which worksheet tab its own
sends land in. Once the URL and secret match and each install names its own
tab, every computer's ordinary "Send to sheet" button just works — no
further setup, no redeploying.

### Deployed script version

The panel compares the deployed script's own reported version against what
this dashboard expects (`EXPECTED_SCRIPT_VERSION` in `src/lib/sheetSync.js`,
kept equal to `SCRIPT_VERSION` in `sheet-sync.gs`) and warns when they
disagree — Apps Script pins a deployment to whatever code it was created
with, so pasting an update into the editor changes nothing until the
deployment itself is edited and redeployed as a **New version**.
