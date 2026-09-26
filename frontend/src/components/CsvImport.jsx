import { useRef, useState } from 'react';
import { readRows } from '../lib/csv.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Bulk import from a spreadsheet of applications already made.
 *
 * The file is read in the browser -- columns B, C, E, F and G off each row --
 * and every row is posted to `/save-data` exactly as a live submission would
 * be, bar one flag: these rows land already sent. The spreadsheet being
 * imported is the Google Sheet the ⇪ button writes to, so its rows are in it
 * by definition, and marking them unsent would only invite a click that
 * appends a duplicate.
 *
 * These rows carry no documents, so nothing is rendered and no folder is made;
 * what lands is the log entry, dated the day the application went out rather
 * than the day the file was imported.
 *
 * Nothing is sent on choosing a file: the summary line (row count, skipped
 * count, whether a header was found) is the check, and the import itself is
 * a second, deliberate click.
 */
export default function CsvImport({ auto, userName, onSave, onClose }) {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null); // { done, total }
  const [result, setResult] = useState(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const cancelled = useRef(false);

  const reset = () => {
    setParsed(null);
    setFile(null);
    setError(null);
    setResult(null);
    setProgress(null);
    if (input.current) input.current.value = '';
  };

  const take = async (chosen) => {
    if (!chosen) return;
    setError(null);
    setResult(null);
    setProgress(null);
    setFile(chosen);
    try {
      const text = await chosen.text();
      const read = readRows(text);
      setParsed(read);
      if (read.rows.length === 0) setError('No rows in that file.');
    } catch (problem) {
      setParsed(null);
      setError(`Could not read the file — ${problem.message}`);
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    take(event.dataTransfer.files?.[0]);
  };

  const ready = parsed ? parsed.rows.filter((row) => !row.skip) : [];
  const skipped = parsed ? parsed.rows.filter((row) => row.skip) : [];
  const undated = ready.filter((row) => !row.date).length;
  const untabbed = ready.filter((row) => !row.tab).length;

  const run = async () => {
    cancelled.current = false;
    setResult(null);
    setProgress({ done: 0, total: ready.length });

    const failures = [];
    let sent = 0;

    // One at a time: the server writes to SQLite and streams each record back,
    // and a spreadsheet is not worth flooding a local process for.
    for (const row of ready) {
      if (cancelled.current) break;
      const answer = await onSave({
        company: row.company,
        job_title: row.position,
        job_url: row.url || '',
        ...(row.date ? { date: row.date } : {}),
        // Column C names the tab (country), the same column a sent row is
        // filed under -- so a file with several tabs' rows in it splits
        // across them on import instead of landing on just the one that is
        // open. A blank cell falls back to whichever tab is open, so a file
        // with no Tab column at all still imports the way it always did.
        user: row.tab || userName,
        // The spreadsheet being imported is the sheet these rows already live
        // in, so they land sent. Filing them unsent would leave a ⇪ button
        // whose only effect is a duplicate row at the other end.
        sent: true,
      });
      sent += 1;
      if (answer && answer.error) {
        failures.push({ line: row.line, company: row.company, error: answer.error });
      }
      setProgress({ done: sent, total: ready.length });
    }

    setProgress(null);
    setResult({ sent, failures, stopped: cancelled.current });
  };

  const busy = progress !== null;

  return (
    <section className="panel import">
      <div className="panel-head">
        <h2 className="panel-title">Import from CSV</h2>
        <div className="head-actions">
          {parsed && !busy ? (
            <button className="btn" onClick={reset}>
              Clear
            </button>
          ) : null}
          {/* An import keeps running whether this is on screen or not -- the
              panel stays mounted behind the icon -- so closing mid-import is
              closing a window, not stopping the work. Stop does that. */}
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close CSV import">
            ✕
          </button>
        </div>
      </div>
      {!parsed ? (
        <div
          className={dragging ? 'drop over' : 'drop'}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={input}
            id="csv-file"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="file-input"
            onChange={(event) => take(event.target.files?.[0])}
          />
          <label htmlFor="csv-file" className="btn btn-primary">
            Choose a CSV file
          </label>
          <div className="tile-detail">or drop one here</div>
        </div>
      ) : (
        <>
          <div className="import-summary">
            <span className="mono">{file?.name}</span>
            <span className="tile-detail">
              {plural(ready.length, 'row')} ready
              {skipped.length ? `, ${skipped.length} skipped` : ''}
              {parsed.header ? ', header row ignored' : ''}
              {parsed.delimiter !== ',' ? `, ${parsed.delimiter === '\t' ? 'tab' : 'semicolon'}-separated` : ''}
            </span>
          </div>

          {skipped.length ? (
            <div className="note">
              Skipped {plural(skipped.length, 'row')} — company and position are both required:{' '}
              {skipped
                .slice(0, 5)
                .map((row) => `line ${row.line} (${row.skip})`)
                .join(', ')}
              {skipped.length > 5 ? `, and ${skipped.length - 5} more` : ''}
            </div>
          ) : null}

          {undated ? (
            <div className="note">
              {plural(undated, 'row')} had no readable date and will be dated today.
            </div>
          ) : null}

          {untabbed ? (
            <div className="note">
              {plural(untabbed, 'row')} had no Tab in column C and will be filed
              {userName ? ` under "${userName}"` : ' with no tab'}.
            </div>
          ) : null}

          <div className="import-actions">
            <button className="btn btn-primary" disabled={busy || ready.length === 0} onClick={run}>
              {busy ? `Importing ${progress.done} / ${progress.total}…` : `Import ${plural(ready.length, 'row')}`}
            </button>
            {busy ? (
              <button className="btn" onClick={() => { cancelled.current = true; }}>
                Stop
              </button>
            ) : null}
            <span className="tile-detail">
              {auto
                ? 'Automatic mode: rows are filed as they arrive.'
                : 'Human check is on: every row waits in the review queue.'}
            </span>
          </div>

          {busy ? (
            <div className="bar" role="progressbar" aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}>
              <div className="bar-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            </div>
          ) : null}
        </>
      )}

      {error ? <div className="note critical">{error}</div> : null}

      {result ? (
        <div className={result.failures.length ? 'note critical' : 'note good'}>
          {result.stopped ? 'Stopped after ' : 'Imported '}
          {plural(result.sent - result.failures.length, 'row')}
          {result.failures.length ? `, ${plural(result.failures.length, 'failure')}` : ''}.
          {result.failures.slice(0, 5).map((failure) => (
            <div key={failure.line} className="sub bad">
              line {failure.line} · {failure.company} — {failure.error}
            </div>
          ))}
          {result.failures.length > 5 ? (
            <div className="sub bad">…and {result.failures.length - 5} more</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
