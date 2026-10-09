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

/** Filters of /api/log (new model) for the Log filters and page; api.js turns them into the query (withQuery). */
export function logParams(f, page) {
  const [since, until] = dateRange(f);
  return {
    since, until,
    // 24 h: the exact last 24 hours (since yesterday plus hours)
    hours: f.period === '24h' ? '24' : '',
    company: f.company, project: f.project, item: f.item, type: f.type,
    page: String(page), per_page: String(PAGE_SIZE),
  };
}
