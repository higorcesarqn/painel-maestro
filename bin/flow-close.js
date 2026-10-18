'use strict';
/**
 * flow-close.js · closing an item: concluding it (#68) or interrupting it (#69). The same steps whether the maestro runs
 * `flow item done` / `flow item interrupt` or the owner clicks on the item page (panel/server.js). Runs inside the
 * caller's transaction.
 *
 *   concludeItem(store, project, number, { at, agentRole, agentName, source })
 *   interruptItem(store, project, number, reason, { at, agentRole, agentName, source })
 *     → { state, recorded, canceled }
 *     state     the item's projection before (null when it was never started: nothing is written)
 *     recorded  false when the item was already out of the active list (nothing is written)
 *     canceled  the ids of the pending decisions canceled
 *   Appends item-done (or item-interrupted { reason }), then one pending-decision-canceled per pending decision still
 *   open after it (the derived HML one is resolved by item-done itself, bin/flow-projection.js, and canceled like the
 *   others on an interruption), with the reason "item concluído pelo dono" / "item interrompido pelo dono" and the role
 *   of whoever recorded, so a maestro in `flow pending wait` wakes up.
 */
const { projectItem, EVENT_TYPES } = require('./flow-projection');
const { t } = require('./i18n');

function closeItem(store, project, number, { type, payload, reason }, { at, agentRole, agentName = null, source }) {
  const state = projectItem(store.itemEvents(project.id, number), project);
  if (!state || !state.active) return { state, recorded: false, canceled: [] };
  const base = { at, projectId: project.id, itemNumber: number, agentRole, agentName, source };
  store.appendEvent({ ...base, type, payload });
  const after = projectItem(store.itemEvents(project.id, number), project);
  const canceled = [];
  for (const p of after.pending_decisions) {
    if (p.status !== 'open') continue;
    store.appendEvent({ ...base, taskNumber: p.task_number, type: EVENT_TYPES.pendingDecisionCanceled, payload: { pending_decision: p.id, reason } });
    canceled.push(p.id);
  }
  return { state, recorded: true, canceled };
}

function concludeItem(store, project, number, who) {
  return closeItem(store, project, number, { type: EVENT_TYPES.itemDone, payload: {}, reason: t('delivery.concludedReason') }, who);
}

function interruptItem(store, project, number, reason, who) {
  return closeItem(store, project, number, { type: EVENT_TYPES.itemInterrupted, payload: { reason }, reason: t('delivery.interruptedReason') }, who);
}

module.exports = { concludeItem, interruptItem };
