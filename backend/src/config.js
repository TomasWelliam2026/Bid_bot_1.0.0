import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** backend/, regardless of the process's working directory. */
const backendRoot = fileURLToPath(new URL('..', import.meta.url));

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
};

export const config = {
  port: num(process.env.PORT, 4500),

  /**
   * Address to bind. Loopback by default: the API has no login, so anything
   * that can reach it can read, edit or delete the whole archive, and on a
   * machine with a public address `0.0.0.0` means the internet. Set
   * HOST=0.0.0.0 (and CORS_ORIGIN, below) to let a dashboard on another
   * computer in. Only do that on a network you trust.
   */
  host: process.env.HOST || '127.0.0.1',

  /** Root of the archive. Documents land in {dataRoot}/{YYYY-MM-DD}/{company}/. */
  dataRoot: process.env.DATA_ROOT || 'D:/data',

  /** The database lives in the backend's own folder, not the archive. */
  dbFile: process.env.DB_FILE || path.join(backendRoot, 'database', 'jobsaver.db'),

  /**
   * Starting mode when the database has no stored preference:
   * true  — automatic: a submission is rendered and filed on arrival.
   * false — human check: it waits in the queue for someone to approve it.
   */
  autoByDefault: bool(process.env.AUTO_SAVE, true),

  /**
   * Optional .ttf to embed in every PDF. Leave unset for the built-in
   * Helvetica, which covers Latin text only -- point this at a Unicode face
   * (e.g. C:/Windows/Fonts/malgun.ttf) when postings arrive in CJK.
   */
  pdfFont: process.env.PDF_FONT || '',
  pdfFontBold: process.env.PDF_FONT_BOLD || '',

  /** Job description HTML can be large; the default 100kb limit is too small. */
  bodyLimit: process.env.BODY_LIMIT || '25mb',

  /**
   * Origins a browser page may call the API from: comma-separated, or `*` for
   * any. Unset, only pages served from this machine (localhost, 127.0.0.1,
   * [::1], any port) -- so a website open in the same browser cannot reach
   * over and delete the archive. The extension and the desktop app are not
   * browser pages in this sense and need no entry here.
   */
  corsOrigin: process.env.CORS_ORIGIN || '',
};

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export const corsOrigins =
  config.corsOrigin === '*'
    ? '*'
    : [LOOPBACK_ORIGIN, ...config.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean)];
