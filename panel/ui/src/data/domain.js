// Domain lists and texts the screens share: the flow's stages, the trackers, the usage periods and the title of a
// pending decision (names come from the dictionary).
import { t } from '../i18n/index.js';

// The flow's stages in order and the trackers, as the server names them (bin/flow-store.js STAGES and TRACKERS).
export const STAGES = ['specification', 'implementation', 'final_adjustment', 'pr_ready', 'merge', 'hml_validation', 'done'];
export const TRACKERS = ['github', 'azure_devops'];
// The stages an active item can be in (the Overview's funnel: "done" never shows).
export const ACTIVE_STAGES = STAGES.filter((s) => s !== 'done');

// Severities of a pending decision, the most urgent first (bin/flow-projection.js PENDING_DECISION_SEVERITIES), with
// the tone of their badge and the color of their mark.
export const SEVERITIES = ['critical', 'high', 'normal', 'low'];
export const SEVERITY_TONE = { critical: 'danger', high: 'warning', normal: 'blue', low: 'neutral' };
export const SEVERITY_COLOR = { critical: 'var(--danger)', high: 'var(--warning)', normal: 'var(--blue-text)', low: 'var(--muted)' };

/**
 * The title of a pending decision: the maestro's own, or, for the one a failing HML result opened by itself
 * (derived_from, #1 story 51), a sentence from its numbers.
 */
export function pendingTitle(p) {
  const d = p && p.derived_from;
  if (d && typeof d === 'object' && d.type === 'hml-recorded') {
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    return t('pending.derivedHml', { failed: n(d.failed), blocked: n(d.blocked), total: n(d.passed) + n(d.failed) + n(d.blocked) });
  }
  return typeof p.title === 'string' && p.title.trim() ? p.title : t('pending.noTitle');
}

export const USAGE_PERIODS = [
  { id: 'window_5h', plan: 'window_5h_pct' },
  { id: 'today', plan: null },
  { id: '7d', plan: 'weekly_pct' },
];
export const usagePeriodName = (id) => t(`usage.period.${id}.name`);
export const usagePeriodShort = (id) => t(`usage.period.${id}.short`);
