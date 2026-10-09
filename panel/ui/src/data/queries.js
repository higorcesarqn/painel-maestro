// Queries the page builds: the Log filters (new model, /api/log) and the analysis of the last 7 days (old model).
import { PAGE_SIZE } from './api.js';
import { t } from '../i18n/index.js';
import { now, spDay, spHour, dayMonth, weekdayShort, dayHeading, arr } from './format.js';
import { RESULTS } from './domain.js';

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

/** Query parameters of /api/log (new model) for the Log filters and page. */
export function logParams(f, page) {
  const sp = new URLSearchParams();
  const [since, until] = dateRange(f);
  if (since) sp.set('since', since);
  if (until) sp.set('until', until);
  // 24 h: the exact last 24 hours (since yesterday plus hours)
  if (f.period === '24h') sp.set('hours', '24');
  for (const k of ['company', 'project', 'item', 'type']) {
    if (typeof f[k] === 'string' && f[k]) sp.set(k, f[k]);
  }
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
