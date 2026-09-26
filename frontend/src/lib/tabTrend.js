/**
 * Turns records into one running-total line per tab, aligned to the same
 * day-by-day axis -- the shape TabTrend draws and hovers over.
 *
 * A point exists for every calendar day from the archive's first record to
 * its last, for every tab, not just the days a given tab actually received
 * one: two points with the same count are what draw as a flat segment, so a
 * quiet stretch has to carry real, adjacent points the way an active one
 * does, or there would be nothing there to connect flat between.
 */

/** Local calendar day, not UTC -- matches how RecordsTable already reads `created_at`. */
export function dateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every calendar day from `startKey` to `endKey`, inclusive. */
export function eachDay(startKey, endKey) {
  const days = [];
  const cursor = new Date(`${startKey}T00:00:00`);
  const end = new Date(`${endKey}T00:00:00`);
  while (cursor <= end) {
    days.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * One running total per user, over the shared `days` axis. `days` is empty
 * when there is nothing dated yet to plot.
 */
export function buildTabTrend(records, users) {
  const newPerDay = new Map(users.map((user) => [user.id, new Map()]));
  let minDate = null;
  let maxDate = null;

  for (const record of records) {
    const perDay = newPerDay.get(record.user_id);
    if (!perDay) continue; // unassigned, or a tab that no longer exists
    const key = dateKey(record.created_at);
    if (minDate === null || key < minDate) minDate = key;
    if (maxDate === null || key > maxDate) maxDate = key;
    perDay.set(key, (perDay.get(key) || 0) + 1);
  }

  if (minDate === null) return { days: [], series: [] };
  const days = eachDay(minDate, maxDate);

  const series = users.map((user) => {
    const perDay = newPerDay.get(user.id);
    let running = 0;
    const points = days.map((day) => {
      running += perDay.get(day) || 0;
      return running;
    });
    return { user, points };
  });

  return { days, series };
}

/** The next clean value at or above `value` -- 0 stays 0, everything else
 *  rounds up to a step sized for its own magnitude (5/10/25/50/100/...). */
export function niceMax(value) {
  if (value <= 0) return 0;
  const steps = [1, 2, 2.5, 5, 10];
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of steps) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}
