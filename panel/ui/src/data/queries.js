// Queries the page builds: the Log filters (new model, /api/log).
import { PAGE_SIZE } from './api.js';
import { now, spDay } from './format.js';

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
