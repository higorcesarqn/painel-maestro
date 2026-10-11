'use strict';
// api-pending-decisions.js · pending decisions of the new model (#10): GET /api/pending-decisions and the owner's answer
// from the panel (#32), POST /api/pending-decisions/<id>/answer. The maestro opens, resolves and cancels them with
// bin/flow.js pending; the owner answers on the Pendências screen or in the maestro's Maestri terminal (maestri.workspace /
// maestri.terminal). Each pending decision is computed from the events of its item by the pure projection
// (bin/flow-projection.js); nothing derived is stored (ADR 0002).
//
// GET filters (query string, each one a value or a comma-separated list): organization, project, severity, status.
// Answer: {
//   pending_decisions: [{ id, kind, severity, status, title, context, options, recommendation,
//     item: { key, number, tracker_ref, title, stage, project: { id, name, tracker, organization: { id, name } } },
//     task: { number, title, state } | null, maestri: { workspace, terminal },
//     notification: 'sent' | 'failed' | 'outside' | null   (the owner's "maestri notify" when it opened, #44; null when
//     derived or opened before #44)
//     opened_at, opened_by, closed_at, closed_by, resolution, decision, reason,
//     derived_from: null | { type: 'hml-recorded', passed, failed, blocked, card_url } }]  (derived: opened by a failing
//     HML result itself, title null; see bin/flow-projection.js)
//     open ones first (by severity, then the oldest), then the closed ones (the most recently closed first)
//   counts: { status: {open, resolved, canceled}, severity: {critical, high, normal, low} }
//     each facet counts with the other filters applied but not its own
//   organizations: [{ id, name }]   every organization with a project (for the screen's filter)
// }
// The pending decisions of a hidden organization (#49), and the organization itself, are left out of all three (#51): its
// owner answers them in the maestro's terminal, and the POST below still accepts them.
// No sentences: an invalid filter is {code: 'invalid_filter', param, value, allowed} (ADR 0004).
//
// POST /api/pending-decisions/<id>/answer (#32), <id> as P-<n> or <n>, body { option: 'B' | null, text: '...' } (at least
// one of them): records the same pending-decision-resolved as flow pending resolve, with role owner, no agent name and
// source panel. The decision is the option as it was opened ('B: Pedir ajuste'), the option and the comment
// ('B: Pedir ajuste — <comment>') or only the comment; at most MAX_PENDING_DECISION characters. Checking that the pending
// decision is open and recording happen in one transaction: when the owner and the maestro answer at once, only one
// becomes the decision. Answer: the pending decision as one element of GET /api/pending-decisions. Errors, as codes:
//   400 invalid_body [field], invalid_option {value}, answer_empty, answer_too_long {length, max},
//       option_not_found {id, option, options: [letters]}
//   404 pending_decision_not_found {id}   (also without maestro.db, which is not created)
//   409 pending_decision_not_open {id, status, closed_at, resolution}
//   503 database_unreadable {file, detail} (schema_too_new, from the server, #28)
const path = require('path');

const { trackerRef, EVENT_TYPES, PENDING_DECISION_SEVERITIES, PENDING_DECISION_STATUSES, MAX_PENDING_DECISION } = require(path.join(__dirname, '..', 'bin', 'flow-projection.js'));
const { SchemaTooNew } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { projectInfo, hiddenOrganizations, visibleItems } = require(path.join(__dirname, 'api-items.js'));

const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SOURCE = 'panel';

class PendingError extends Error {
  constructor(error, status = 400) {
    super(error.code);
    this.status = status;
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
    if (!valid) throw new PendingError({ code: 'invalid_filter', param, value, allowed: allowed || null });
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

/** A pending decision as the API shows it: with its item and task. */
function pendingView(project, state, p) {
  const { task_number: taskNumber, ...rest } = p;
  return { ...rest, item: itemInfo(project, state), task: taskInfo(state, taskNumber) };
}

/** Every pending decision of every item, with its item and task; those of a hidden organization only with withHidden (#51). */
function allPendingDecisions(store, withHidden) {
  const hidden = withHidden ? new Set() : hiddenOrganizations(store);
  const out = [];
  for (const { project, state } of visibleItems(store, { withHidden }).values()) {
    for (const p of state.pending_decisions) out.push(pendingView(project, state, p));
  }
  return { list: out, organizations: organizationsOf(store.projects().filter((p) => !hidden.has(p.organization_id))) };
}

function organizationsOf(projects) {
  const seen = new Map();
  for (const p of projects) if (!seen.has(p.organization_id)) seen.set(p.organization_id, { id: p.organization_id, name: p.organization_name });
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
}

/**
 * GET /api/pending-decisions. source: the items source of api-items.js (lazily opened maestro.db). The pending decisions of a
 * hidden organization (#51), and the organization itself, are left out unless withHidden.
 */
function listPendingDecisions(source, query = new URLSearchParams(), { withHidden = false } = {}) {
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
  const { list, organizations } = allPendingDecisions(store, withHidden);
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

// ---------- the owner's answer (#32) ----------

/** "P-12", "p-12" or "12" in the route → 12; null otherwise (the route does not exist). */
function parsePendingId(text) {
  let raw;
  try {
    raw = decodeURIComponent(text);
  } catch (_) {
    return null;
  }
  const m = /^(?:p-)?(\d{1,12})$/i.exec(raw);
  return m && Number(m[1]) >= 1 ? Number(m[1]) : null;
}

/**
 * The letter of each option: their own ("B: Pedir ajuste" → B) when every option starts with one and no two repeat;
 * otherwise the letter of each one's position (the first is A), so two options never share a letter. The page keeps a
 * copy of this rule (ui/src/data/domain.js, optionLetters).
 */
function optionLetters(options) {
  const own = options.map((o) => {
    const m = /^\s*([a-z])\s*[:)]/i.exec(o);
    return m ? m[1].toUpperCase() : null;
  });
  if (own.every(Boolean) && new Set(own).size === own.length) return own;
  return options.map((_, i) => String.fromCharCode(65 + i));
}

/** The pending decision with this id: its event names the project, and only that project's items are projected. */
function findPending(store, id) {
  const e = store.event(id);
  if (!e) return null;
  for (const { project, state } of store.projectedItems({ projectId: e.project_id }).values()) {
    const pending = state.pending_decisions.find((p) => p.id === id);
    if (pending) return { project, state, pending };
  }
  return null;
}

/** The body { option, text } checked: { letter (upper case) | null, comment ('' when absent) }. */
function answerInput(body) {
  let input;
  try {
    input = JSON.parse(String(body || ''));
  } catch (_) {
    throw new PendingError({ code: 'invalid_body' });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PendingError({ code: 'invalid_body' });
  const { option, text } = input;
  if (text !== undefined && text !== null && typeof text !== 'string') throw new PendingError({ code: 'invalid_body', field: 'text' });
  let letter = null;
  if (option !== undefined && option !== null) {
    if (typeof option !== 'string' || !/^[a-z]$/i.test(option.trim())) throw new PendingError({ code: 'invalid_option', value: String(option).slice(0, 20) });
    letter = option.trim().toUpperCase();
  }
  // The comment as flow pending resolve keeps a decision: line breaks as \n, trimmed.
  const comment = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
  if (!letter && !comment) throw new PendingError({ code: 'answer_empty' });
  if (comment.length > MAX_PENDING_DECISION) throw new PendingError({ code: 'answer_too_long', length: comment.length, max: MAX_PENDING_DECISION });
  return { letter, comment };
}

/**
 * POST /api/pending-decisions/<id>/answer. source: the items source (api-items.js); id: the number of the pending decision;
 * body: the raw JSON body; at: the moment recorded. Returns the pending decision as GET /api/pending-decisions lists it.
 */
function answerPendingDecision(source, id, body, at) {
  const { letter, comment } = answerInput(body);
  let store;
  try {
    store = source.store();
  } catch (e) {
    if (e instanceof SchemaTooNew) throw e;
    throw new PendingError({ code: 'database_unreadable', file: 'maestro.db', detail: String(e && (e.errstr || e.code || e.message)).slice(0, 200) }, 503);
  }
  const notFound = () => new PendingError({ code: 'pending_decision_not_found', id }, 404);
  if (!store) throw notFound();
  store.transaction(() => {
    const found = findPending(store, id);
    if (!found) throw notFound();
    const { project, state, pending } = found;
    if (pending.status !== 'open') {
      throw new PendingError({ code: 'pending_decision_not_open', id, status: pending.status, closed_at: pending.closed_at, resolution: pending.resolution }, 409);
    }
    let chosen = '';
    if (letter) {
      const letters = optionLetters(pending.options);
      const index = letters.indexOf(letter);
      if (index < 0) throw new PendingError({ code: 'option_not_found', id, option: letter, options: letters });
      chosen = pending.options[index];
    }
    const decision = [chosen, comment].filter(Boolean).join(' — ');
    if (decision.length > MAX_PENDING_DECISION) throw new PendingError({ code: 'answer_too_long', length: decision.length, max: MAX_PENDING_DECISION });
    store.appendEvent({
      at, type: EVENT_TYPES.pendingDecisionResolved, projectId: project.id, itemNumber: state.number, taskNumber: pending.task_number,
      agentRole: 'owner', agentName: null, source: SOURCE, payload: { pending_decision: id, decision },
    });
  });
  const { project, state, pending } = findPending(store, id);
  return pendingView(project, state, pending);
}

module.exports = { listPendingDecisions, answerPendingDecision, parsePendingId, optionLetters, PendingError };
