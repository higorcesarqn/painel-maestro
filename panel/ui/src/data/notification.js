// The browser notification (#45): the owner turns it on with the bell in the header, and a pending decision opened
// while the tab is hidden shows up as a system notification. The list is kpis.pending_decisions.open of GET /api/state:
// every open pending decision of every organization, whatever the top selector says, of any severity.
// Pure functions, like data/tab.js: the shell (App) is the only one touching the Notification API; it asks
// pendingNotice at each state read and keeps the ids for the next one. The owner's choice is remembered in this browser
// (localStorage, which may be blocked: then it only lasts while the page is open).
import { obj, txt } from './format.js';
import { pendingTitle } from './domain.js';
import { t } from '../i18n/index.js';

const STORAGE_KEY = 'painel-maestro.notifications';
// The tag of the group notification: one at a time, and never a pending decision's (those are "P-<id>").
export const GROUP_TAG = 'pending-new';

/**
 * What to notify after a state read: null, { pending } (one new pending decision) or { count } (several in the same
 * read). previousIds: the ids of the previous read (any iterable), null on the first one, which never notifies;
 * open: kpis.pending_decisions.open now; visible: whether the tab is in sight, which never notifies either.
 */
export function pendingNotice(previousIds, open, visible) {
  if (previousIds === null || previousIds === undefined || visible || !Array.isArray(open)) return null;
  const before = new Set(previousIds);
  const fresh = open.filter((p) => obj(p) && !before.has(p.id));
  if (!fresh.length) return null;
  return fresh.length === 1 ? { pending: fresh[0] } : { count: fresh.length };
}

/** The open pending decisions of a state read (kpis.pending_decisions.open), or null when it has no list (an older server). */
export function openList(state) {
  const kp = state && obj(state.kpis) && obj(state.kpis.pending_decisions);
  return kp && Array.isArray(kp.open) ? kp.open.filter(obj) : null;
}

/**
 * The bell's state: null without the Notification API (the bell is not drawn), 'demo' in the demo (disabled, never
 * asks), 'blocked' when the browser denied it, 'on' when the owner chose it and the browser granted it, else 'off'.
 */
export function bellState({ supported, mock, permission, wanted }) {
  if (!supported) return null;
  if (mock) return 'demo';
  if (permission === 'denied') return 'blocked';
  return permission === 'granted' && wanted ? 'on' : 'off';
}

/**
 * The notification of a notice: { title, body, tag, target }. One pending decision: its title, severity and item,
 * tagged with its id (two tabs never show it twice), target its id for goToPendingDecision; the group: the count with
 * a fixed tag, target null (the list of pending decisions).
 */
export function noticeContent(notice) {
  if (notice.pending) {
    const p = notice.pending;
    const item = obj(p.item) || {};
    const project = obj(item.project) || {};
    const ref = `P-${p.id}`;
    return {
      title: pendingTitle(p),
      body: t('notification.pendingBody', {
        severity: t(`pending.severities.${p.severity}`), project: txt(project.name), ref: txt(item.tracker_ref), item: txt(item.title),
      }),
      tag: ref,
      target: ref,
    };
  }
  return { title: t('notification.groupTitle', { count: notice.count }), body: t('notification.groupBody'), tag: GROUP_TAG, target: null };
}

/** The owner's choice in this browser: true when they turned the bell on. */
export function loadWanted() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch (_) {
    return false;
  }
}

export function saveWanted(on) {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch (_) { /* blocked storage: the choice lasts while the page is open */ }
}
