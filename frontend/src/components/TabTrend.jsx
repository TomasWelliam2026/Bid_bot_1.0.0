import { useEffect, useMemo, useRef, useState } from 'react';
import { buildTabTrend, niceMax } from '../lib/tabTrend.js';

// How many days are comfortably visible at once before the rest is reached
// by scrolling -- a day's width is derived from this and the panel's own
// measured width (see viewportWidth below), not a fixed pixel constant, so
// "20 days" keeps meaning twenty days at any panel width.
const VISIBLE_DAYS = 20;
const HEIGHT = 140; // px -- fixed regardless of width; only the x-axis scrolls
// Padding inside the scrolling plot. Left and right leave room for half a
// date label at either end; the top holds each day's change label.
const PAD = { top: 20, right: 24, bottom: 24, left: 24 };
// The y-axis labels sit in their own SVG beside the scrolling plot, so they
// stay in view however far back the reader scrolls.
const AXIS_W = 32;

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
 * Each day takes a fixed share of the plot's own width (twenty days fill it
 * exactly, and the axis always has at least twenty) rather than the usual
 * squeeze-everything-in scaling -- a history longer than that makes the
 * chart wider than the panel instead of
 * thinner lines, and the panel scrolls to it horizontally. Opens scrolled to
 * the newest day, and stays there across live updates unless the reader has
 * scrolled away to look at older days -- the same "stick to the end unless
 * you've scrolled up" rule a chat log uses.
 *
 * Every day has a vertical line with that day's change across every tab on
 * top of it. Hovering (or, with the chart focused, the arrow keys) snaps a
 * crosshair to the nearest day and opens one tooltip listing every tab's
 * running total and change there, rather than making the reader land the
 * pointer on a 2px line.
 */
export default function TabTrend({ users, records, activeId }) {
  const { days, series } = useMemo(() => buildTabTrend(records, users, { minDays: VISIBLE_DAYS }), [records, users]);
  const [hoverIndex, setHoverIndex] = useState(null);
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
    if (!scrollEl) return undefined;
    const measure = () => setViewportWidth(scrollEl.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollEl]);

  const dayGap = viewportWidth > 0 ? Math.max(1, viewportWidth - PAD.left - PAD.right) / (VISIBLE_DAYS - 1) : 0;
  const plotW = dayGap * Math.max(1, days.length - 1);
  const width = PAD.left + PAD.right + plotW;

  // Follows new data onto the newest day, but only if the reader was already
  // there -- scrolled left to look at history, a live update never yanks
  // the view back out from under them.
  useEffect(() => {
    if (!scrollEl || viewportWidth === 0) return;
    if (stickToEndRef.current) scrollEl.scrollLeft = scrollEl.scrollWidth;
  }, [scrollEl, days.length, viewportWidth]);

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
  // What each day added, per tab and across every tab: the running total's
  // step from the day before (the first day's step is its whole total).
  const deltaAt = (points, index) => points[index] - (index > 0 ? points[index - 1] : 0);
  const dayChanges = days.map((_, index) => series.reduce((sum, { points }) => sum + deltaAt(points, index), 0));
  // Twenty days to a width leaves too little room to label every one on a
  // narrow panel, so labels go on every nth day, counted back from the newest
  // so today always has one. Every day keeps its line, and the tooltip.
  const labelEvery = (room) => (dayGap > 0 ? Math.max(1, Math.ceil(room / dayGap)) : 1);
  const dateEvery = labelEvery(46);
  const changeEvery = labelEvery(24);
  const labelled = (index, every) => (days.length - 1 - index) % every === 0;
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
          <div className="tab-trend-legend">
            {series.map(({ user }) => (
              <span key={user.id} className="tab-trend-legend-item">
                <span className="tab-trend-key" style={{ background: colorFor(user) }} />
                {user.name}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="tab-trend-body">
        <svg className="tab-trend-yaxis" width={AXIS_W} height={HEIGHT} viewBox={`0 0 ${AXIS_W} ${HEIGHT}`} aria-hidden="true">
          {yTicks.map((value) => (
            <text key={value} className="tab-trend-axis" x={AXIS_W - 6} y={yAt(value)} textAnchor="end" dominantBaseline="middle">
              {Math.round(value)}
            </text>
          ))}
        </svg>
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
              aria-label={`Running total of applications per tab, ${fullDate(days[0])} to ${fullDate(days[days.length - 1])}. Hover or use the arrow keys for each day's numbers.`}
              onPointerMove={(event) => setHoverIndex(indexFromClientX(event.clientX))}
              onPointerLeave={() => setHoverIndex(null)}
              onKeyDown={onKeyDown}
            >
              {yTicks.map((value) => (
                <line key={value} className="tab-trend-grid" x1={0} x2={width} y1={yAt(value)} y2={yAt(value)} />
              ))}

              {/* One vertical line per day, with that day's change across every tab on top of it. */}
              {days.map((day, index) => (
                <g key={day}>
                  <line className="tab-trend-grid" x1={xAt(index)} x2={xAt(index)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
                  {labelled(index, changeEvery) ? (
                    <text
                      className={dayChanges[index] > 0 ? 'tab-trend-change' : 'tab-trend-change zero'}
                      x={xAt(index)}
                      y={PAD.top - 6}
                      textAnchor="middle"
                    >
                      +{dayChanges[index]}
                    </text>
                  ) : null}
                  {labelled(index, dateEvery) ? (
                    <text className="tab-trend-axis" x={xAt(index)} y={HEIGHT - PAD.bottom + 16} textAnchor="middle">
                      {shortDate(day)}
                    </text>
                  ) : null}
                </g>
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
                <div className="tab-trend-tooltip-date">
                  {fullDate(days[hoverIndex])} · +{dayChanges[hoverIndex]}
                </div>
                {series.map(({ user, points }) => (
                  <div key={user.id} className="tab-trend-tooltip-row">
                    <span className="tab-trend-key" style={{ background: colorFor(user) }} />
                    <span className="tab-trend-tooltip-name">{user.name}</span>
                    <span className="tab-trend-tooltip-value">{points[hoverIndex]}</span>
                    <span className="tab-trend-tooltip-delta">+{deltaAt(points, hoverIndex)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
