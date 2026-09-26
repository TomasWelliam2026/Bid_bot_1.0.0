import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTabTrend, niceMax } from '../lib/tabTrend.js';

// How many days are comfortably visible at once before the rest is reached
// by scrolling -- a day's width is derived from this and the panel's own
// measured width (see viewportWidth below), not a fixed pixel constant, so
// "5 days" keeps meaning five days at any panel width.
const VISIBLE_DAYS = 5;
const HEIGHT = 220; // px -- fixed regardless of width; only the x-axis scrolls
const PAD = { top: 12, right: 16, bottom: 28, left: 40 };

const shortDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const fullDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * One running-total line per tab, sharing a day-by-day x-axis: color is the
 * only channel doing identity work, in the same fixed hue order (by tab id,
 * not by row position) `styles.css` defines as --series-1..8 -- a tab keeps
 * its color as other tabs are added or removed.
 *
 * Each day takes a fixed share of the panel's own width (a fifth of it, so
 * five days fill the panel exactly) rather than the usual squeeze-everything-in
 * scaling -- a history longer than five days makes the chart wider than the
 * panel instead of thinner lines, and the panel scrolls to it horizontally.
 * Opens scrolled to the newest day, and stays there across live updates
 * unless the reader has scrolled away to look at older days -- the same
 * "stick to the end unless you've scrolled up" rule a chat log uses.
 *
 * Hovering (or, with the chart focused, the arrow keys) snaps a crosshair to
 * the nearest day and opens one tooltip listing every tab's running total
 * there, rather than making the reader land the pointer on a 2px line. Every
 * value the tooltip can show is also in the table view behind the toggle --
 * the tooltip is a shortcut to it, not the only way to read it.
 */
export default function TabTrend({ users, records, activeId }) {
  const { days, series } = useMemo(() => buildTabTrend(records, users), [records, users]);
  const [hoverIndex, setHoverIndex] = useState(null);
  const [tableView, setTableView] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const svgRef = useRef(null);
  // A callback ref, not a plain useRef: the scrollable div doesn't exist on
  // the first render or two (nothing is dated yet to plot, see the early
  // return below), and a useEffect keyed on state that hasn't changed since
  // would never notice the div showing up a render later. This runs again
  // whenever the node itself is attached or detached, which is the thing
  // that actually needs re-measuring.
  const [scrollEl, setScrollEl] = useState(null);
  // Whether the view was at (or very near) the newest day the last time it
  // was checked -- read before a data/size change, so that change knows
  // whether to follow the reader to the new edge or leave them where they were.
  const stickToEndRef = useRef(true);

  useEffect(() => {
    if (!scrollEl || tableView) return undefined;
    const measure = () => setViewportWidth(scrollEl.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollEl, tableView]);

  const dayGap = viewportWidth > 0 ? viewportWidth / (VISIBLE_DAYS - 1) : 0;
  const plotW = dayGap * Math.max(1, days.length - 1);
  const width = PAD.left + PAD.right + plotW;

  // Follows new data onto the newest day, but only if the reader was already
  // there -- scrolled left to look at history, a live update never yanks
  // the view back out from under them.
  useEffect(() => {
    if (!scrollEl || tableView || viewportWidth === 0) return;
    if (stickToEndRef.current) scrollEl.scrollLeft = scrollEl.scrollWidth;
  }, [scrollEl, days.length, viewportWidth, tableView]);

  const onScroll = () => {
    if (!scrollEl) return;
    stickToEndRef.current = scrollEl.scrollWidth - scrollEl.scrollLeft - scrollEl.clientWidth < 4;
  };

  if (days.length === 0) return null; // nothing dated yet to plot

  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const maxCount = niceMax(Math.max(1, ...series.flatMap((one) => one.points)));
  const xAt = (index) => PAD.left + (days.length === 1 ? plotW / 2 : index * dayGap);
  const yAt = (count) => PAD.top + plotH - (maxCount === 0 ? 0 : (count / maxCount) * plotH);
  const pathFor = (points) =>
    points.map((count, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(count).toFixed(1)}`).join(' ');
  // Fixed hue order keyed to the tab, not to its position in `users` -- a tab
  // keeps its color when another one is renamed, added or deleted.
  const colorFor = (user) => `var(--series-${(user.id % 8) + 1})`;

  const indexFromClientX = (clientX) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || days.length < 2 || dayGap === 0) return 0;
    const x = clientX - box.left - PAD.left;
    return Math.min(days.length - 1, Math.max(0, Math.round(x / dayGap)));
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      setHoverIndex(null);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setHoverIndex((current) => {
      const base = current ?? days.length - 1;
      const next = base + (event.key === 'ArrowRight' ? 1 : -1);
      return Math.min(days.length - 1, Math.max(0, next));
    });
  };

  const yTicks = [0, maxCount / 2, maxCount];
  // Keeps the tooltip's own box from overhanging the scrollable plot at
  // either edge -- half its min-width, not a measurement of the rendered
  // box, but enough to keep it from clipping into .tab-trend-scroll's
  // overflow at the very first or last day.
  const tooltipLeft = hoverIndex === null ? 0 : Math.min(width - 65, Math.max(65, xAt(hoverIndex)));

  return (
    <section className="panel tab-trend">
      <div className="panel-head">
        <h2 className="panel-title">Tab trend</h2>
        <div className="head-actions">
          <span className="tile-detail">
            running total, by day{days.length > VISIBLE_DAYS ? ` · newest ${VISIBLE_DAYS} shown, scroll for more` : ''}
          </span>
          <button type="button" className="btn" onClick={() => setTableView((v) => !v)}>
            {tableView ? 'Chart' : 'Table'}
          </button>
        </div>
      </div>

      {tableView ? (
        <div className="tab-trend-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {series.map(({ user }) => (
                  <th scope="col" key={user.id}>
                    {user.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day, i) => (
                <tr key={day}>
                  <td className="nowrap">{fullDate(day)}</td>
                  {series.map(({ user, points }) => (
                    <td className="num" key={user.id}>
                      {points[i]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tab-trend-scroll" ref={setScrollEl} onScroll={onScroll}>
          <div className="tab-trend-plot" style={{ width: `${width}px` }}>
            <svg
              ref={svgRef}
              className="tab-trend-chart"
              width={width}
              height={HEIGHT}
              viewBox={`0 0 ${width} ${HEIGHT}`}
              role="img"
              tabIndex={0}
              aria-label={`Running total of applications per tab, ${fullDate(days[0])} to ${fullDate(days[days.length - 1])}. Use the Table button for the same numbers as a table.`}
              onPointerMove={(event) => setHoverIndex(indexFromClientX(event.clientX))}
              onPointerLeave={() => setHoverIndex(null)}
              onKeyDown={onKeyDown}
            >
              {yTicks.map((value) => (
                <g key={value}>
                  <line className="tab-trend-grid" x1={PAD.left} x2={width - PAD.right} y1={yAt(value)} y2={yAt(value)} />
                  <text className="tab-trend-axis" x={PAD.left - 8} y={yAt(value)} textAnchor="end" dominantBaseline="middle">
                    {Math.round(value)}
                  </text>
                </g>
              ))}

              {days.map((day, index) => (
                <text key={day} className="tab-trend-axis" x={xAt(index)} y={HEIGHT - PAD.bottom + 18} textAnchor="middle">
                  {shortDate(day)}
                </text>
              ))}

              {hoverIndex !== null ? (
                <line className="tab-trend-crosshair" x1={xAt(hoverIndex)} x2={xAt(hoverIndex)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
              ) : null}

              {series.map(({ user, points }) => (
                <path
                  key={user.id}
                  className={user.id === activeId ? 'tab-trend-line on' : 'tab-trend-line'}
                  d={pathFor(points)}
                  stroke={colorFor(user)}
                  fill="none"
                />
              ))}

              {series.map(({ user, points }) => (
                <circle
                  key={user.id}
                  className="tab-trend-dot"
                  cx={xAt(hoverIndex ?? days.length - 1)}
                  cy={yAt(points[hoverIndex ?? days.length - 1])}
                  r={4}
                  fill={colorFor(user)}
                />
              ))}
            </svg>

            {hoverIndex !== null ? (
              <div className="tab-trend-tooltip" style={{ left: `${tooltipLeft}px` }}>
                <div className="tab-trend-tooltip-date">{fullDate(days[hoverIndex])}</div>
                {series.map(({ user, points }) => (
                  <div key={user.id} className="tab-trend-tooltip-row">
                    <span className="tab-trend-key" style={{ background: colorFor(user) }} />
                    <span className="tab-trend-tooltip-name">{user.name}</span>
                    <span className="tab-trend-tooltip-value">{points[hoverIndex]}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {!tableView ? (
        <div className="tab-trend-legend">
          {series.map(({ user }) => (
            <span key={user.id} className="tab-trend-legend-item">
              <span className="tab-trend-key" style={{ background: colorFor(user) }} />
              {user.name}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
