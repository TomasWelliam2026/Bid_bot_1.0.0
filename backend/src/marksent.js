/**
 * Mark the rows that came from a spreadsheet as already sent to the sheet.
 *
 * The importer does this at the point of import now, but rows filed before it
 * did are still marked unsent -- an archive full of ⇪ buttons whose only
 * effect would be to append a duplicate of a row the sheet already has.
 *
 * An imported row is recognised by having no documents: a CSV row is a note
 * about a posting, so nothing was rendered and no folder was made for it. A
 * live submission carries at least one document and is left alone.
 *
 *   node src/marksent.js            # what would change, changing nothing
 *   node src/marksent.js --apply    # do it
 *   node src/marksent.js --apply --undo    # put those rows back to unsent
 *
 * `sent_at` is set to the row's own date, being as close to when it reached
 * the sheet as anything here knows -- the same rule the importer uses.
 */
import { config } from './config.js';
import { Store } from './db.js';

const flags = new Set(process.argv.slice(2));
const apply = flags.has('--apply');
const undo = flags.has('--undo');

const store = new Store(config.dbFile);
const db = store.db;

const want = undo ? 'sent' : 'unsent';
const rows = db
  .prepare(`SELECT id, company, job_title, created_at FROM records WHERE dir_path IS NULL AND sent_status = ?`)
  .all(want);

console.log(`[db]     ${config.dbFile}`);
console.log(`[found]  ${rows.length} imported row(s) currently ${want}`);
for (const row of rows.slice(0, 5)) {
  console.log(`         #${row.id} ${row.company} — ${row.job_title}`);
}
if (rows.length > 5) console.log(`         …and ${rows.length - 5} more`);

if (!apply) {
  console.log(`[dry run] nothing was changed. Add --apply to ${undo ? 'unsend' : 'mark'} them.`);
  store.close();
  process.exit(0);
}

const update = db.prepare('UPDATE records SET sent_status = ?, sent_at = ? WHERE id = ?');
let changed = 0;
for (const row of rows) {
  update.run(undo ? 'unsent' : 'sent', undo ? null : row.created_at, row.id);
  changed += 1;
}

console.log(`[done]   ${changed} row(s) set to ${undo ? 'unsent' : 'sent'}`);
console.log('         Reload the dashboard, or restart the server, to see it.');
store.close();
