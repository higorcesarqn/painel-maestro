'use strict';
// api-pending-decisions.js · pending decisions of the new model (#10): GET /api/pending-decisions.
// Read only: the maestro opens, resolves and cancels them with bin/flow.js pending; the owner answers in the
// maestro's Maestri terminal (maestri.workspace / maestri.terminal). Each pending decision is computed from the
// events of its item by the pure projection (bin/flow-projection.js); nothing derived is stored (ADR 0002).
//
// Filters (query string, each one a value or a comma-separated list): organization, project, severity, status.
// Answer: {
//   pending_decisions: [{ id, kind, severity, status, title, context, options, recommendation,
//     item: { key, number, tracker_ref, title, stage, project: { id, name, tracker, organization: { id, name } } },
//     task: { number, title, state } | null, maestri: { workspace, terminal },
//     opened_at, opened_by, closed_at, closed_by, resolution, decision, reason,
//     derived_from: null | { type: 'hml-recorded', passed, failed, blocked, card_url } }]  (derived: opened by a failing
//     HML result itself, title null; see bin/flow-projection.js)
//     open ones first (by severity, then the oldest), then the closed ones (the most recently closed first)
//   counts: { status: {open, resolved, canceled}, severity: {critical, high, normal, low} }
//     each facet counts with the other filters applied but not its own
//   organizations: [{ id, name }]   every organization with a project (for the screen's filter)
// }
// No sentences: an invalid filter is {code: 'invalid_filter', param, value, allowed} (ADR 0004).
const path = require('path');

const { trackerRef, PENDING_DECISION_SEVERITIES, PENDING_DECISION_STATUSES } = require(path.join(__dirname, '..', 'bin', 'flow-projection.js'));
const { projectInfo } = require(path.join(__dirname, 'api-items.js'));

const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

class PendingFilterError extends Error {
  constructor(error) {
    super(error.code);
    this.status = 400;
    this.error = error;
  }
}

/** Values of a filter (comma-separated), checked against the allowed ones (or the id format). null when absent. */
function filterValues(query, param, allowed) {
  const raw = query.get(param);
  if (raw === null || raw.trim() === '') return null;
  const values = raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  for (const value of values) {
    const valid = allowed ? allowed.includes(value) : RE_ID.test(value);
    if (!valid) throw new PendingFilterError({ code: 'invalid_filter', param, value, allowed: allowed || null });
  }
  return new Set(values);
}

function itemInfo(project, state) {
  return {
    key: `${project.id}/${state.number}`,
    number: state.number,
    tracker_ref: trackerRef(project.tracker, state.number),
    title: state.title,
    stage: state.stage,
    project: projectInfo(project),
  };
}

function taskInfo(state, number) {
  if (number === null) return null;
  const task = state.tasks.find((x) => x.number === number);
  return { number, title: task ? task.title : null, state: task ? task.state : null };
}

const SEVERITY_RANK = new Map(PENDING_DECISION_SEVERITIES.map((s, i) => [s, i]));
const time = (v) => {
  const x = Date.parse(v);
  return Number.isFinite(x) ? x : 0;
};

function order(a, b) {
  const openA = a.status === 'open' ? 0 : 1;
  const openB = b.status === 'open' ? 0 : 1;
  if (openA !== openB) return openA - openB;
  if (!openA) return SEVERITY_RANK.get(a.severity) - SEVERITY_RANK.get(b.severity) || time(a.opened_at) - time(b.opened_at) || a.id - b.id;
  return time(b.closed_at) - time(a.closed_at) || b.id - a.id;
}

/** Every pending decision of every item, with its item and task. */
function allPendingDecisions(store) {
  const projects = new Map(store.projects().map((p) => [p.id, p]));
  const out = [];
  for (const { project, state } of store.projectedItems().values()) {
    for (const p of state.pending_decisions) {
      const { task_number: taskNumber, ...rest } = p;
      out.push({ ...rest, item: itemInfo(project, state), task: taskInfo(state, taskNumber) });
    }
  }
  return { list: out, organizations: organizationsOf([...projects.values()]) };
}

function organizationsOf(projects) {
  const seen = new Map();
  for (const p of projects) if (!seen.has(p.organization_id)) seen.set(p.organization_id, { id: p.organization_id, name: p.organization_name });
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
}

/** GET /api/pending-decisions. source: the items source of api-items.js (lazily opened maestro.db). */
function listPendingDecisions(source, query = new URLSearchParams()) {
  const filters = {
    organization: filterValues(query, 'organization'),
    project: filterValues(query, 'project'),
    severity: filterValues(query, 'severity', PENDING_DECISION_SEVERITIES),
    status: filterValues(query, 'status', PENDING_DECISION_STATUSES),
  };
  const counts = {
    status: Object.fromEntries(PENDING_DECISION_STATUSES.map((s) => [s, 0])),
    severity: Object.fromEntries(PENDING_DECISION_SEVERITIES.map((s) => [s, 0])),
  };
  const store = source.store();
  if (!store) return { pending_decisions: [], counts, organizations: [] };
  const { list, organizations } = allPendingDecisions(store);
  const passes = (p, skip) => (!filters.organization || filters.organization.has(p.item.project.organization.id))
    && (!filters.project || filters.project.has(p.item.project.id))
    && (skip === 'severity' || !filters.severity || filters.severity.has(p.severity))
    && (skip === 'status' || !filters.status || filters.status.has(p.status));
  for (const p of list) {
    if (passes(p, 'status')) counts.status[p.status]++;
    if (passes(p, 'severity')) counts.severity[p.severity]++;
  }
  return { pending_decisions: list.filter((p) => passes(p)).sort(order), counts, organizations };
}

module.exports = { listPendingDecisions, PendingFilterError };
