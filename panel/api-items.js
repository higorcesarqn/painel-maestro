'use strict';
// api-items.js · items of the new model (#5): GET /api/items and GET /api/items/<project>/<number>.
// Reads the events of maestro.db (bin/flow-store.js, MAESTRO_DIR or ~/.painel-maestro) and computes each item's
// state with the pure projection (bin/flow-projection.js); nothing derived is stored (ADR 0002).
// The number goes out as in the tracker (tracker_ref: "#12" on GitHub, "PBI 3100" on Azure DevOps) and the key
// of an item is "<project>/<number>". No sentences: errors are codes (ADR 0004).
const path = require('path');

const { openStore, flowDir } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { projectItem, trackerRef } = require(path.join(__dirname, '..', 'bin', 'flow-projection.js'));

const RE_PROJECT = /^[a-z0-9][a-z0-9-]{0,79}$/;
const RE_NUMBER = /^[1-9]\d{0,8}$/;

/** Lazily opened store (null while maestro.db does not exist: the panel shows no item, without creating it). */
function createItemsSource(env) {
  const dir = flowDir(env);
  let store = null;
  return {
    dir,
    store() {
      if (!store) store = openStore({ dir, create: false });
      return store;
    },
    close() {
      if (store) store.close();
      store = null;
    },
  };
}

function projectInfo(p) {
  return { id: p.id, name: p.name, tracker: p.tracker, company: { id: p.company_id, name: p.company_name } };
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
    stage_since: state.stage_since,
    started_at: state.started_at,
    updated_at: state.updated_at,
    active: state.active,
  };
}

function timelineEntry(e) {
  return { id: e.id, at: e.at, type: e.type, task_number: e.task_number, agent: e.agent, source: e.source, payload: e.payload };
}

/** { items }: every item (or only the active / done ones: active = true | false), most recently updated first. */
function listItems(source, { active = null } = {}) {
  const store = source.store();
  if (!store) return { items: [] };
  const projects = new Map(store.projects().map((p) => [p.id, p]));
  const byItem = new Map();
  for (const e of store.allEvents()) {
    const k = `${e.project_id}/${e.item_number}`;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(e);
  }
  const items = [];
  for (const events of byItem.values()) {
    const project = projects.get(events[0].project_id);
    const state = project && projectItem(events, project);
    if (state && (active === null || state.active === active)) items.push(summary(project, state));
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
  return { item: { ...summary(project, state), stages: state.stages, ...deliveryDetail(state), timeline: events.map(timelineEntry) } };
}

// ---------- delivery (#9): PR, final adjustment, HML and conclusion ----------
// The list carries `active` (false once the item is Done) and accepts ?active=1 (active only) or ?active=0
// (done only); without it, every item. The item page also carries the PR, the final adjustment, the HML result and
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

/** Route of an item page: { project, number } or null when the address is not one. */
function parseItemPath(projectText, numberText) {
  let project;
  try {
    project = decodeURIComponent(projectText);
  } catch (_) {
    return null;
  }
  if (!RE_PROJECT.test(project) || !RE_NUMBER.test(numberText)) return null;
  return { project, number: Number(numberText) };
}

module.exports = { createItemsSource, listItems, itemDetail, parseItemPath, activeFilter };
