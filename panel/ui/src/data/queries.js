// Queries the page builds: the Log filters and the analysis of the last 7 days.
import { PAGE_SIZE } from './api.js';
import { t } from '../i18n/index.js';
import { now, spDay, spHour, dayMonth, weekdayShort, dayHeading, arr } from './format.js';
import { RESULTS } from './domain.js';

/** Many-value filter (agent, project, result): kept as the text "a,b"; returns the list. */
export function filterList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
  return typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

/** Adds or removes a value of a many-value filter; returns the text "a,b" ('' when empty). */
export function toggleFilter(v, item) {
  const l = filterList(v);
  return (l.includes(item) ? l.filter((x) => x !== item) : [...l, item]).join(',');
}

export function dateRange(f) {
  const today = spDay(now());
  const daysAgo = (n) => spDay(now() - n * 86400000);
  switch (f.period) {
    case 'today': return [today, today];
    case 'yesterday': return [daysAgo(1), daysAgo(1)];
    case '24h': return [daysAgo(1), ''];
    case '7d': return [daysAgo(6), ''];
    case '30d': return [daysAgo(29), ''];
    case 'custom': return [f.since || '', f.until || ''];
    default: return ['', ''];
  }
}

/** Query parameters of /api/events for the Log filters and page. */
export function logParams(f, page) {
  const sp = new URLSearchParams();
  const [since, until] = dateRange(f);
  if (since) sp.set('since', since);
  if (until) sp.set('until', until);
  // 24 h: yesterday onwards (valid on an old server) and the exact last 24 h on the new one (hours)
  if (f.period === '24h') sp.set('hours', '24');
  for (const k of ['agent', 'project', 'type', 'result']) {
    const v = filterList(f[k]).join(',');
    if (v) sp.set(k, v);
  }
  if (f.q.trim()) sp.set('q', f.q.trim());
  if (f.owner_only) sp.set('owner_only', '1');
  if (f.include_tests) sp.set('include_tests', '1');
  if (f.flow) sp.set('flow', f.flow);
  sp.set('page', String(page));
  sp.set('per_page', String(PAGE_SIZE));
  return sp;
}

/** The n Sao Paulo days ending today, oldest first. */
export function lastDays(n = 7) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const ms = now() - i * 86400000;
    days.push({ day: spDay(ms), label: i === 0 ? t('time.today') : `${weekdayShort(ms)} ${dayMonth(ms).slice(0, 2)}`, title: dayHeading(ms) });
  }
  return days;
}

/**
 * Analysis of the events of the last 7 days (from /api/events, without the test ones):
 * by day and agent, by result, by hour of today and by agent.
 */
export function analyze(events) {
  const days = lastDays(7);
  const byDay = new Map(days.map((d) => [d.day, {}]));
  const results = {};
  const today = spDay(now());
  const hoursToday = new Array(24).fill(0);
  const byAgent = {};
  const byAgentDay = {};
  let needsOwner = 0;
  for (const e of arr(events)) {
    if (!e || !e.ts) continue;
    const d = spDay(e.ts);
    const ag = e.agent || '?';
    if (byDay.has(d)) {
      const row = byDay.get(d);
      row[ag] = (row[ag] || 0) + 1;
      byAgentDay[ag] = byAgentDay[ag] || {};
      byAgentDay[ag][d] = (byAgentDay[ag][d] || 0) + 1;
    }
    const r = RESULTS[e.result] ? e.result : 'other';
    results[r] = (results[r] || 0) + 1;
    byAgent[ag] = (byAgent[ag] || 0) + 1;
    if (d === today) { const h = spHour(e.ts); if (h !== null) hoursToday[h] += 1; }
    if (e.needs_owner === true) needsOwner += 1;
  }
  return {
    days: days.map((d) => ({ ...d, values: byDay.get(d.day) || {} })),
    results,
    hoursToday,
    byAgent,
    agentSeries: (slug) => days.map((d) => (byAgentDay[slug] && byAgentDay[slug][d.day]) || 0),
    total: arr(events).length,
    needsOwner,
  };
}
