'use strict';
// api-items.js · items of the new model (#5): GET /api/items and GET /api/items/<project>/<number>, and the "Concluir"
// and "Interromper" buttons (#68, #70): POST /api/items/<project>/<number>/done and .../interrupt.
// Reads the events of maestro.db (bin/flow-store.js, MAESTRO_DIR or ~/.painel-maestro) and computes each item's
// state with the pure projection (bin/flow-projection.js); nothing derived is stored (ADR 0002).
// The number goes out as in the tracker (tracker_ref: "#12" on GitHub, "PBI 3100" on Azure DevOps) and the key
// of an item is "<project>/<number>". No sentences: errors are codes (ADR 0004).
const path = require('path');

const { openStore, flowDir, RE_ID } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { projectItem, trackerRef } = require(path.join(__dirname, '..', 'bin', 'flow-projection.js'));
const { concludeItem, interruptItem, interruptionReason } = require(path.join(__dirname, '..', 'bin', 'flow-close.js'));

const RE_NUMBER = /^[1-9]\d{0,8}$/;

/**
 * Lazily opened store (null while maestro.db does not exist: the panel shows no item, without creating it). Only a
 * write that starts the register (creating the first organization, #22) asks for store({ create: true }).
 */
function createItemsSource(env) {
  const dir = flowDir(env);
  let store = null;
  return {
    dir,
    store({ create = false } = {}) {
      if (!store) store = openStore({ dir, create });
      return store;
    },
    close() {
      if (store) store.close();
      store = null;
    },
  };
}

// ---------- hidden organizations (#51) ----------
// The one place that leaves the hidden organizations (#49) out of the panel's listings and aggregates. Every route that
// lists or counts items, pending decisions, events, usage lines or agents reads through it, by default: a new screen is
// born without them. Only the reading of one item by its key (and the routes of its page), the answer to a pending
// decision and ?hidden=include (Configurações, api-projects.js) see them.

/** Ids of the hidden organizations: a Set, empty when none is hidden. */
function hiddenOrganizations(store) {
  return new Set(store.organizations().filter((o) => o.hidden).map((o) => o.id));
}

/**
 * store.projectedItems() without the items of a hidden organization (the same Map, shared, when none is hidden: never
 * change it); withHidden: every item.
 */
function visibleItems(store, { withHidden = false } = {}) {
  const items = store.projectedItems();
  const hidden = withHidden ? new Set() : hiddenOrganizations(store);
  if (!hidden.size) return items;
  return new Map([...items].filter(([, it]) => !hidden.has(it.project.organization_id)));
}

/** The project as every answer of the API shows it: { id, name, tracker, organization: { id, name } }. */
function projectInfo(p) {
  return { id: p.id, name: p.name, tracker: p.tracker, organization: { id: p.organization_id, name: p.organization_name } };
}

function summary(project, state) {
  return {
    key: `${project.id}/${state.number}`,
    project: projectInfo(project),
    number: state.number,
    tracker: project.tracker,
    tracker_ref: trackerRef(project.tracker, state.number),
    title: state.title,
    stage: state.stage,
    // The state the project's tracker uses for a done item ("Committed", "Closed"...; null when not declared): the
    // page shows it next to Concluído, never replacing it by "Done" (#1, story 7).
    done_state: project.done_state || null,
    stage_since: state.stage_since,
    started_at: state.started_at,
    updated_at: state.updated_at,
    active: state.active,
    // { reason, at, by: { role, name } } while the item is interrupted (#69): it stays on its stage, out of the active list.
    interrupted: state.interrupted,
  };
}

function timelineEntry(e) {
  return { id: e.id, at: e.at, type: e.type, task_number: e.task_number, agent: e.agent, source: e.source, payload: e.payload };
}

/**
 * { items }: every item (or only the active / done ones: active = true | false), most recently updated first; those of a
 * hidden organization only with withHidden.
 */
function listItems(source, { active = null, withHidden = false } = {}) {
  const store = source.store();
  if (!store) return { items: [] };
  const items = [];
  for (const { project, state } of visibleItems(store, { withHidden }).values()) {
    if (active === null || state.active === active) items.push(summary(project, state));
  }
  items.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || a.key.localeCompare(b.key));
  return { items };
}

/** { item } with the flow's stages and the timeline, or null when the item does not exist. */
function itemDetail(source, projectId, number) {
  const store = source.store();
  if (!store) return null;
  const project = store.project(projectId);
  if (!project) return null;
  const events = store.itemEvents(projectId, number);
  const state = projectItem(events, project);
  if (!state) return null;
  return { item: { ...summary(project, state), stages: state.stages, tasks: state.tasks, ...deliveryDetail(state), ...reviewDetail(state), timeline: events.map(timelineEntry) } };
}

// ---------- delivery (#9): PR, final adjustment, HML and conclusion ----------
// The list carries `active` (false once the item is Done or interrupted, #69) and `interrupted`, and accepts ?active=1
// (active only) or ?active=0 (done or interrupted only); without it, every item. The item page also carries the PR, the final adjustment, the HML result and
// the conclusion moment. Links come already filtered by the projection to the trackers' domains.

/** Filter of GET /api/items: null (every item), true or false; undefined when the value is invalid. */
function activeFilter(query) {
  const v = query && typeof query.get === 'function' ? query.get('active') : null;
  if (v === null || v === '') return null;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}

function deliveryDetail(state) {
  return { completed_at: state.completed_at, pr: state.pr, final_adjustment: state.final_adjustment, hml: state.hml };
}

/**
 * The "Concluir" button (#68): records the same item-done as `flow item done`, as the owner (role owner, no agent name,
 * source panel), and cancels the item's open pending decisions (bin/flow-close.js), in one transaction. The item may be on
 * any stage. { status: 200 } or { status, error }: 404 item_not_found (also without maestro.db, which is not created),
 * 409 item_not_active when it already left the active list.
 */
function markItemDone(source, projectId, number, at) {
  const notFound = { status: 404, error: { code: 'item_not_found', project: projectId, number } };
  const store = source.store();
  const project = store && store.project(projectId);
  if (!project) return notFound;
  const x = store.transaction(() => concludeItem(store, project, number, { at, agentRole: 'owner', source: 'panel' }));
  if (!x.state) return notFound;
  if (!x.recorded) return { status: 409, error: { code: 'item_not_active', project: projectId, number } };
  return { status: 200, canceled: x.canceled };
}

/**
 * The reason of the "Interromper" button (#70) from the raw JSON body { reason }, under the rule shared with `flow item
 * interrupt` (interruptionReason in bin/flow-close.js): { reason } or { error } (400).
 */
function interruptionInput(body) {
  let input;
  try {
    input = JSON.parse(String(body || ''));
  } catch (_) {
    input = null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: { code: 'json_object_required' } };
  const { reason } = input;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return { error: { code: 'invalid_field', field: 'reason', value: String(reason).slice(0, 20) } };
  return interruptionReason(reason);
}

/**
 * The "Interromper" button (#70): records the same item-interrupted { reason } as `flow item interrupt`, as the owner
 * (role owner, no agent name, source panel), and cancels the item's open pending decisions (bin/flow-close.js), in one
 * transaction. The item stays on its stage. { status: 200 } or { status, error }: 400 when the body has no valid reason
 * (checked first), 404 item_not_found (also without maestro.db, which is not created), 409 item_not_active.
 */
function markItemInterrupted(source, projectId, number, body, at) {
  const input = interruptionInput(body);
  if (input.error) return { status: 400, error: input.error };
  const notFound = { status: 404, error: { code: 'item_not_found', project: projectId, number } };
  const store = source.store();
  const project = store && store.project(projectId);
  if (!project) return notFound;
  const x = store.transaction(() => interruptItem(store, project, number, input.reason, { at, agentRole: 'owner', source: 'panel' }));
  if (!x.state) return notFound;
  if (!x.recorded) return { status: 409, error: { code: 'item_not_active', project: projectId, number } };
  return { status: 200, canceled: x.canceled };
}

// ---------- reports and findings (#8) ----------
// The item page also carries the workers' reports (every one, oldest first, with the texts exactly as recorded)
// and the maestro's findings; the tasks that came from a finding carry its number (tasks[].finding).

function reviewDetail(state) {
  return { reports: state.reports, findings: state.findings };
}

/** Route of an item page: { project, number } or null when the address is not one. */
function parseItemPath(projectText, numberText) {
  let project;
  try {
    project = decodeURIComponent(projectText);
  } catch (_) {
    return null;
  }
  if (!RE_ID.test(project) || !RE_NUMBER.test(numberText)) return null;
  return { project, number: Number(numberText) };
}

module.exports = { createItemsSource, listItems, itemDetail, markItemDone, markItemInterrupted, parseItemPath, activeFilter, projectInfo, hiddenOrganizations, visibleItems };
