// Domain lists and texts the screens share: the flow's stages, the trackers, the usage periods and the title of a
// pending decision (names come from the dictionary).
import { t, display } from '../i18n/index.js';

// The flow's stages in order and the trackers, as the server names them (bin/flow-store.js STAGES and TRACKERS).
export const STAGES = ['specification', 'implementation', 'final_adjustment', 'pr_ready', 'merge', 'hml_validation', 'done'];
export const TRACKERS = ['github', 'azure_devops'];
// The stages an active item can be in (the Overview's funnel: "done" never shows).
export const ACTIVE_STAGES = STAGES.filter((s) => s !== 'done');

// Where the maestro runs and the dispatch modes of a task (#62), as the server names them (bin/flow-projection.js
// HOST_KINDS and DISPATCH_MODES).
export const HOST_KINDS = ['orca', 'maestri', 'none'];
export const DISPATCH_MODES = ['subagents', 'maestri', 'orca'];

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

// The owner's answer to a pending decision (#32): the longest decision, in characters (bin/flow-projection.js
// MAX_PENDING_DECISION, the CLI's limit), and how the option and the comment become the decision.
export const MAX_DECISION = 2000;
export const DECISION_JOINER = ' — ';

/**
 * The letter of each option: their own ("B: Pedir ajuste" → B) when every option starts with one and no two repeat;
 * otherwise the letter of each one's position (the first is A). A copy of the server's rule
 * (panel/api-pending-decisions.js, optionLetters; test-index.js checks that both agree).
 */
export function optionLetters(options) {
  const own = options.map((o) => {
    const m = /^\s*([a-z])\s*[:)]/i.exec(o);
    return m ? m[1].toUpperCase() : null;
  });
  if (own.every(Boolean) && new Set(own).size === own.length) return own;
  return options.map((_, i) => String.fromCharCode(65 + i));
}

/** The option the recommendation starts with ("A: segue o contrato.", "B, e abrir um achado"), when it is one of letters; else null. */
export function recommendedLetter(recommendation, letters) {
  const m = /^\s*([A-Z])\s*(?:[:,)]|$)/.exec(typeof recommendation === 'string' ? recommendation : '');
  return m && letters.includes(m[1]) ? m[1] : null;
}

/** The decision the panel records: the option as it was opened, the option and the comment, or only the comment. */
export const decisionText = (option, comment) => [option, comment].filter(Boolean).join(DECISION_JOINER);

export const USAGE_PERIODS = [
  { id: 'window_5h', plan: 'window_5h_pct' },
  { id: 'today', plan: null },
  { id: '7d', plan: 'weekly_pct' },
];
export const usagePeriodName = (id) => t(`usage.period.${id}.name`);
export const usagePeriodShort = (id) => t(`usage.period.${id}.short`);

// The plan without a source (#63): no Maestri file, as in Orca or a plain terminal. Nothing else keeps the plan's %,
// so the Usage screen says so instead of sending the owner to the Maestri settings.
const noSource = (reason) => !!(reason && reason.code === 'plan_no_source');

/** The Usage screen's note when the plan is unavailable: the reason, and where to look unless there is no source. */
export function planUnavailableText(reason) {
  const why = (display(reason) || t('overview.noMaestriData')).trim().replace(/[.\s]+$/, '');
  return noSource(reason) ? t('usage.planNoSource', { reason: why }) : t('usage.planUnavailable', { reason: why });
}

/** Where the plan comes from: the usage.json source (the Maestri Claude provider), or none in this environment. */
export function planSourceText(plan) {
  const p = plan || {};
  return noSource(p.reason) ? t('usage.noPlanSource') : display(p.source) || t('codes.maestri_claude_provider');
}
