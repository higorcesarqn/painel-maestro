// Domain lists the screens share: the flow's stages, the trackers and the usage periods (names come from the dictionary).
import { t } from '../i18n/index.js';

// The flow's stages in order and the trackers, as the server names them (bin/flow-store.js STAGES and TRACKERS).
export const STAGES = ['specification', 'implementation', 'final_adjustment', 'pr_ready', 'merge', 'hml_validation', 'done'];
export const TRACKERS = ['github', 'azure_devops'];

export const USAGE_PERIODS = [
  { id: 'window_5h', plan: 'window_5h_pct' },
  { id: 'today', plan: null },
  { id: '7d', plan: 'weekly_pct' },
];
export const usagePeriodName = (id) => t(`usage.period.${id}.name`);
export const usagePeriodShort = (id) => t(`usage.period.${id}.short`);
