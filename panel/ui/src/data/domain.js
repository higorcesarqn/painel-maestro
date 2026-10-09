// Usage periods of the Usage screen: the plan window each one reads (the names come from the dictionary).
import { t } from '../i18n/index.js';

export const USAGE_PERIODS = [
  { id: 'window_5h', plan: 'window_5h_pct' },
  { id: 'today', plan: null },
  { id: '7d', plan: 'weekly_pct' },
];
export const usagePeriodName = (id) => t(`usage.period.${id}.name`);
export const usagePeriodShort = (id) => t(`usage.period.${id}.short`);
