import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Store } from './db.js';
import { KINDS } from './storage.js';

/**
 * Rebuild the record log from the archive on disk.
 *
 * The PDFs are the artefact; the database is a log of them. If the log is lost
 * or you are adopting an archive that predates it, this walks
 * {DATA_ROOT}/{date}/{company}/ and inserts a `saved` record for every set of
 * documents it finds.
 *
 * Additive and repeatable: a record already pointing at a file is left alone,
 * so running it twice changes nothing.
 *
 *   npm run reindex          -- write
 *   npm run reindex -- --dry -- report only
 */

const LABELS = {
  'Job description': 'job_des',
  'Cover letter': 'cover',
  Resume: 'resume',
};

/** `{title} - {label}{-n}.{pdf|html}`, the shapes storeSubmission() writes. */
const FILE = new RegExp(`^(.+) - (${Object.keys(LABELS).join('|')})(-\\d+)?\\.(?:pdf|html?)$`);

const isDateFolder = (name) => /^\d{4}-\d{2}-\d{2}$/.test(name);

export function scan(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;

  for (const date of fs.readdirSync(root, { withFileTypes: true })) {
    if (!date.isDirectory() || !isDateFolder(date.name)) continue;

    for (const company of fs.readdirSync(path.join(root, date.name), { withFileTypes: true })) {
      if (!company.isDirectory()) continue;
      const dir = path.join(root, date.name, company.name);

      // One entry per application: the title plus any -2 suffix that a repeat
      // application to the same company on the same day was given.
      const entries = new Map();
      for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        const match = FILE.exec(file.name);
        if (!match) continue;

        const [, title, label, dup = ''] = match;
        const key = `${title}${dup}`;
        const entry =
          entries.get(key) ||
          { company: company.name, jobTitle: title, date: date.name, dir, files: {}, mtime: 0 };
        const full = path.join(dir, file.name);
        entry.files[LABELS[label]] = full;
        entry.mtime = Math.max(entry.mtime, fs.statSync(full).mtimeMs);
        entries.set(key, entry);
      }
      found.push(...entries.values());
    }
  }
  return found.sort((a, b) => a.mtime - b.mtime);
}

export function reindex(store, root, { dry = false } = {}) {
  // Any path already in the log means that application is accounted for.
  const known = new Set();
  for (const record of store.list({ limit: 100000 })) {
    for (const kind of KINDS) if (record[`${kind}_path`]) known.add(path.resolve(record[`${kind}_path`]));
  }

  const added = [];
  const skipped = [];
  for (const entry of scan(root)) {
    const paths = Object.values(entry.files).map((file) => path.resolve(file));
    if (paths.some((file) => known.has(file))) {
      skipped.push(entry);
      continue;
    }
    added.push(entry);
    if (dry) continue;

    const id = store.insert({
      company: entry.company,
      jobTitle: entry.jobTitle,
      jobUrl: null,
      status: 'saving',
      mode: 'auto',
    });
    store.markSaved(id, { dir: entry.dir, files: entry.files });
    // Keep the created time honest: the file is older than this rebuild.
    store.db
      .prepare('UPDATE records SET created_at = ? WHERE id = ?')
      .run(new Date(entry.mtime).toISOString(), id);
    for (const file of paths) known.add(file);
  }
  return { added, skipped };
}

// Run directly: node src/reindex.js [--dry]
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('reindex.js')) {
  const dry = process.argv.includes('--dry');
  const store = new Store(config.dbFile);
  const { added, skipped } = reindex(store, config.dataRoot, { dry });
  console.log(`[reindex] ${config.dataRoot} -> ${config.dbFile}`);
  for (const entry of added) console.log(`  ${dry ? 'would add' : 'added'}  ${entry.date}  ${entry.company} — ${entry.jobTitle}`);
  console.log(`[reindex] ${dry ? 'would add' : 'added'} ${added.length}, already logged ${skipped.length}`);
  store.close();
}
