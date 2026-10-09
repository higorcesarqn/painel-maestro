#!/usr/bin/env node
'use strict';
// flow · CLI of the new model (ADRs 0001-0003): records each step of an item's flow as an event in maestro.db.
//
//   node bin/flow.js item start <number> --title "..." [--stage <stage>] [--role R] [--agent NAME] [--json -]
//   node bin/flow.js stage <number> <stage> [--role R] [--agent NAME] [--json -]
//   node bin/flow.js task graph <number> --task "<n>|<title>[|<blockers>]"... [--out <n,...>] [...] [--json -]
//   node bin/flow.js task dispatch <number> <task> [--floor F] [--worker W] [--branch B] [...] [--json -]
//   node bin/flow.js task integrate <number> <task> --sha <sha> [--sha-before <sha>] [...] [--json -]
//   node bin/flow.js status "<text>" [--state working|blocked|review|done] [--progress n/m] [--item N] [--task N] [...]
//   node bin/flow.js company list|add …  ·  node bin/flow.js project list|add|edit|move …   (bin/flow-admin.js, #6)
//
// The project comes from the "git remote origin" of the current folder (also inside a floor's worktree); an
// unregistered repository is registered in the company "Sem empresa" and the command goes on. Fields come
// from arguments or from a JSON object on standard input (--json -); arguments win over the JSON.
//
// status is the worker's single command: inside a Maestri terminal (MAESTRI_TERMINAL_ID set) it runs
// "maestri floor status" (executable: FLOW_MAESTRI_CLI, else MAESTRI_CLI, else "maestri"; a .js path runs with
// node) and records task-status; outside of Maestri (a subagent) it only records. The task comes from --item/--task
// or, without them, from the current branch: the task dispatched with this branch, else "task/<n>-…" → task n
// (looked up in the project's items; --item settles an ambiguity). When the maestri call fails the event is
// still recorded (payload.maestri = 'failed') and the command ends with exit 1.
//
// Exit codes: 0 ok · 2 invalid data (clear message on stderr) · 1 anything else.
// Messages for people come from the pt-BR dictionary (bin/i18n/pt-BR.js); nothing else is printed (the
// ExperimentalWarning of node:sqlite is silenced in flow-store.js).
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { t } = require('./i18n');
const { openStore, flowDir, STAGES, UNASSIGNED_COMPANY } = require('./flow-store');
const { originOf, branchOf, describeRemote } = require('./flow-repo');
const { projectItem, trackerRef, EVENT_TYPES, WORKER_STATES } = require('./flow-projection');
const { PENDING_DECISION_KINDS, PENDING_DECISION_SEVERITIES } = require('./flow-projection');
const { createAdmin, isAdminCommand } = require('./flow-admin');

const ROLES = ['maestro', 'worker', 'owner'];
const MAX_TITLE = 300;
const MAX_AGENT = 80;
const MAX_FIELD = 200;
const MAX_STATUS = 300;
const MAX_TASKS = 200;
const MAESTRI_TIMEOUT_MS = 15000;
const SOURCE = 'cli';

class InvalidData extends Error {
  constructor(key, params = {}) {
    super(t(key, params));
    this.key = key;
  }
}

/** Something outside the data failed after the event was recorded (exit 1, the message says what). */
class Failed extends Error {}

// ---------- arguments ----------

const AGENT = ['role', 'agent', 'json'];
const OPTIONS = {
  item: ['title', 'stage', ...AGENT],
  stage: AGENT,
  graph: ['task', 'out', ...AGENT],
  dispatch: ['floor', 'worker', 'branch', ...AGENT],
  integrate: ['sha', 'sha-before', ...AGENT],
  status: ['state', 'progress', 'item', 'task', ...AGENT],
};
const REPEATABLE = { graph: ['task'] };

function parseArgs(argv, allowed, maxPositional, repeatable = []) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!(a.startsWith('--') && a.length > 2)) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value = eq >= 0 ? a.slice(eq + 1) : undefined;
    if (!allowed.includes(name)) throw new InvalidData('errors.unknownOption', { option: name });
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || (value.startsWith('--') && value.length > 2)) throw new InvalidData('errors.missingValue', { option: name });
      i++;
    }
    if (repeatable.includes(name)) {
      (opts[name] = opts[name] || []).push(value);
      continue;
    }
    if (opts[name] !== undefined) throw new InvalidData('errors.repeatedOption', { option: name });
    opts[name] = value;
  }
  if (pos.length > maxPositional) throw new InvalidData('errors.unexpectedArgument', { value: pos[maxPositional] });
  return { opts, pos };
}

const JSON_TEXT = ['title', 'stage', 'role', 'agent', 'floor', 'worker', 'branch', 'sha', 'sha_before', 'text', 'state', 'progress'];
const JSON_NUMBER = ['number', 'task'];

/** The JSON object of "--json -" (standard input). */
function readJson(opts) {
  if (opts.json === undefined) return {};
  if (opts.json !== '-') throw new InvalidData('errors.jsonOnlyStdin');
  if (lib.stdinIsInteractive()) throw new InvalidData('errors.jsonStdinInteractive');
  const text = lib.decodeText(lib.readStdinSync()).trim();
  if (!text) throw new InvalidData('errors.jsonEmpty');
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new InvalidData('errors.jsonInvalid', { detail: e.message });
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new InvalidData('errors.jsonNotObject');
  for (const field of JSON_TEXT) {
    if (o[field] !== undefined && o[field] !== null && typeof o[field] !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'texto' });
  }
  for (const field of JSON_NUMBER) {
    if (o[field] !== undefined && o[field] !== null && typeof o[field] !== 'number' && typeof o[field] !== 'string') {
      throw new InvalidData('errors.jsonFieldType', { field, expected: 'número' });
    }
  }
  if (o.tasks !== undefined && o.tasks !== null && !Array.isArray(o.tasks)) throw new InvalidData('errors.jsonFieldType', { field: 'tasks', expected: 'uma lista' });
  return o;
}

/** First defined value: the argument, then the JSON. */
const pick = (...values) => values.find((v) => v !== undefined && v !== null);

function itemNumber(value) {
  if (value === undefined) throw new InvalidData('errors.missingNumber');
  const s = String(value).trim().replace(/^#/, '');
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1) throw new InvalidData('errors.invalidNumber', { value });
  return Number(s);
}

function taskNumber(value) {
  if (value === undefined) throw new InvalidData('errors.missingTask');
  const s = String(value).trim().replace(/^#/, '');
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1) throw new InvalidData('errors.invalidTaskNumber', { value });
  return Number(s);
}

function stageId(value) {
  if (value === undefined || String(value).trim() === '') throw new InvalidData('errors.missingStage');
  const s = String(value).trim().toLowerCase().replace(/-/g, '_');
  if (!STAGES.includes(s)) throw new InvalidData('errors.unknownStage', { stage: value, allowed: STAGES });
  return s;
}

/** Optional text of one line: null when absent or blank. */
function lineText(value, field, max = MAX_FIELD) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (s.length > max || /[\r\n]/.test(s)) throw new InvalidData('errors.invalidText', { field, max });
  return s;
}

function sha(value, field) {
  const s = String(value).trim();
  if (!/^[0-9a-f]{7,64}$/i.test(s)) throw new InvalidData('errors.invalidSha', { field, value });
  return s.toLowerCase();
}

function agentFields(opts, json, defaultRole = 'maestro') {
  const role = String(pick(opts.role, json.role, defaultRole)).trim().toLowerCase();
  if (!ROLES.includes(role)) throw new InvalidData('errors.invalidRole', { value: role, allowed: ROLES.join(', ') });
  const agent = pick(opts.agent, json.agent);
  if (agent !== undefined && (String(agent).length > MAX_AGENT || /[\r\n]/.test(String(agent)))) throw new InvalidData('errors.invalidAgent', { max: MAX_AGENT });
  return { agentRole: role, agentName: agent === undefined || String(agent).trim() === '' ? null : String(agent).trim() };
}

// ---------- task graph ----------

/** "13|Gerar o PDF" or "14|Enviar por e-mail|13,15" (the title may hold "|" when the blockers come last). */
function taskSpec(spec) {
  const parts = String(spec).split('|');
  if (parts.length < 2) throw new InvalidData('errors.invalidTaskSpec', { value: spec });
  const number = parts.shift();
  let blockers = [];
  if (parts.length >= 2 && /^[\s#\d,]*$/.test(parts[parts.length - 1])) blockers = parts.pop().split(',').map((s) => s.trim()).filter(Boolean);
  return { number, title: parts.join('|'), blocked_by: blockers };
}

/** The tasks of a task-graph event, validated: numbers, titles, blockers inside the graph and no cycle. */
function taskGraph(opts, json) {
  let raw;
  if (opts.task) raw = opts.task.map(taskSpec);
  else raw = Array.isArray(json.tasks) ? json.tasks : [];
  if (!raw.length) throw new InvalidData('errors.missingTasks');
  if (raw.length > MAX_TASKS) throw new InvalidData('errors.tooManyTasks', { max: MAX_TASKS });
  const out = opts.out !== undefined ? String(opts.out).split(',').map((s) => s.trim()).filter(Boolean).map(taskNumber) : [];
  const tasks = raw.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new InvalidData('errors.invalidTaskSpec', { value: JSON.stringify(r) });
    const number = taskNumber(r.number);
    const title = typeof r.title === 'string' || typeof r.title === 'number' ? String(r.title).trim() : '';
    if (!title) throw new InvalidData('errors.missingTaskTitle', { task: number });
    if (title.length > MAX_TITLE) throw new InvalidData('errors.titleTooLong', { length: title.length, max: MAX_TITLE });
    if (r.blocked_by !== undefined && r.blocked_by !== null && !Array.isArray(r.blocked_by)) throw new InvalidData('errors.jsonFieldType', { field: 'blocked_by', expected: 'uma lista' });
    const blockedBy = [...new Set((r.blocked_by || []).map(taskNumber))];
    return { number, title, blocked_by: blockedBy, out: r.out === true || out.includes(number) };
  });
  const numbers = new Set();
  for (const task of tasks) {
    if (numbers.has(task.number)) throw new InvalidData('errors.duplicateTask', { task: task.number });
    numbers.add(task.number);
  }
  for (const n of out) if (!numbers.has(n)) throw new InvalidData('errors.unknownOutTask', { task: n });
  for (const task of tasks) {
    for (const b of task.blocked_by) {
      if (b === task.number) throw new InvalidData('errors.selfBlocker', { task: task.number });
      if (!numbers.has(b)) throw new InvalidData('errors.unknownBlocker', { task: task.number, blocker: b });
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) throw new InvalidData('errors.graphCycle', { cycle: cycle.join(' → ') });
  return tasks;
}

/** A cycle of blockers ([13, 14, 13]) or null. */
function findCycle(tasks) {
  const blockers = new Map(tasks.map((x) => [x.number, x.blocked_by]));
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    if (state.get(n) === 'done') return null;
    if (state.get(n) === 'open') return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 'open');
    stack.push(n);
    for (const b of blockers.get(n) || []) {
      const c = visit(b);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 'done');
    return null;
  };
  for (const x of tasks) {
    const c = visit(x.number);
    if (c) return c.reverse();
  }
  return null;
}

// ---------- status ----------

const STATUS_STATES = Object.keys(WORKER_STATES);

function progress(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const m = /^\s*(\d{1,6})\s*\/\s*(\d{1,6})\s*$/.exec(String(value));
  if (!m || Number(m[2]) < 1 || Number(m[1]) > Number(m[2])) throw new InvalidData('errors.invalidProgress', { value });
  return { done: Number(m[1]), total: Number(m[2]) };
}

/**
 * The item and task a status is about: --item/--task, else the task dispatched with the current branch, else
 * "task/<n>-…" → task n; an item with a single task needs no task. Every candidate is a task of an item of the project.
 */
function locateTask(store, project, cmd, branch) {
  const byItem = new Map();
  for (const e of store.projectEvents(project.id)) {
    if (!byItem.has(e.item_number)) byItem.set(e.item_number, []);
    byItem.get(e.item_number).push(e);
  }
  const items = [];
  for (const events of byItem.values()) {
    const state = projectItem(events, project);
    if (state) items.push(state);
  }
  const key = (n) => `${project.id}/${n}`;
  let scope = items;
  if (cmd.item) {
    scope = items.filter((s) => s.number === cmd.item);
    if (!scope.length) throw new InvalidData('errors.itemNotStarted', { key: key(cmd.item), ref: trackerRef(project.tracker, cmd.item), number: cmd.item });
  }
  const withTask = (n) => {
    const hits = scope.filter((s) => s.tasks.some((x) => x.number === n));
    if (hits.length === 1) return { item: hits[0], task: n };
    if (hits.length > 1) throw new InvalidData('errors.taskAmbiguous', { task: n, items: hits.map((s) => s.number).join(', ') });
    if (cmd.item) throw new InvalidData('errors.taskNotInItem', { key: key(cmd.item), task: n, tasks: scope[0].tasks.map((x) => x.number).join(', ') });
    throw new InvalidData('errors.taskNotFound', { task: n, project: project.id });
  };
  if (cmd.task) return withTask(cmd.task);
  if (branch) {
    const hits = scope.flatMap((s) => s.tasks.filter((x) => x.branch === branch).map((x) => ({ item: s, task: x.number })));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new InvalidData('errors.branchAmbiguous', { branch, tasks: hits.map((h) => `${key(h.item.number)} task ${h.task}`).join(', ') });
    const m = /^task\/(\d{1,9})(?:[-_/.]|$)/i.exec(branch);
    if (m && Number(m[1]) > 0) return withTask(Number(m[1]));
  }
  if (cmd.item && scope[0].tasks.length === 1) return { item: scope[0], task: scope[0].tasks[0].number };
  throw new InvalidData('errors.statusNoTask', { branch: branch || '-' });
}

/** Runs "maestri floor status" for the floor of this terminal: { ok } or { ok: false, detail }. */
function postFloorStatus(cmd, env = process.env) {
  const cli = env.FLOW_MAESTRI_CLI || env.MAESTRI_CLI || 'maestri';
  const args = ['floor', 'status', cmd.text, '--state', cmd.state];
  if (cmd.progress) args.push('--progress', `${cmd.progress.done}/${cmd.progress.total}`);
  const js = /\.[cm]?js$/i.test(cli);
  const r = spawnSync(js ? process.execPath : cli, js ? [cli, ...args] : args, {
    encoding: 'utf8', windowsHide: true, timeout: MAESTRI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { ok: false, detail: r.error.code === 'ENOENT' ? t('errors.maestriNotFound', { cli }) : r.error.message };
  if (r.status !== 0) return { ok: false, detail: String(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] || `exit ${r.status}` };
  return { ok: true };
}

// ---------- project ----------

const slug = (s) => lib.stripAccents(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'projeto';

/** The project of the current folder, registering it in "Sem empresa" when needed. Inside a transaction. */
function resolveProject(store, origin, at) {
  const d = describeRemote(origin);
  const known = store.projectByRemote(d.remote);
  if (known) return { project: known, registered: false, remote: d.remote };
  store.ensureCompany(UNASSIGNED_COMPANY, t('companies.unassigned'), at);
  const project = store.addProject({ id: store.freeProjectId(slug(d.repo)), name: d.repo, companyId: UNASSIGNED_COMPANY, tracker: d.tracker, remote: d.remote, at });
  return { project, registered: true, remote: d.remote };
}

// ---------- delivery (#9): integration branch and PR, final adjustment, HML validation and conclusion ----------
//
//   flow pr <number> draft|ready|merged [--url URL] [--pr N] [--branch NAME]          → event pr-changed
//   flow final-adjustment <number> open                                               → final-adjustment-opened
//   flow final-adjustment <number> result --outcome passed|failed [--summary "..."]   → final-adjustment-finished
//   flow hml <number> --passed N --failed N --blocked N [--card URL] [--summary "..."] → hml-recorded
//   flow item done <number>                                                           → item-done
// The stage each event moves the item to is computed by the projection (bin/flow-projection.js); here the command
// only refuses what the project does not use and links outside the trackers' domains.

const projection = require('./flow-projection');

const MAX_SUMMARY = 4000;
const MAX_BRANCH = 200;
const PR_STAGE = { ready: 'pr_ready', merged: 'merge' };
const DELIVERY_COMMANDS = ['pr', 'final-adjustment', 'hml'];
// The kinds parseDelivery returns: recorded by recordDelivery (the task commands of #7 have their own kinds).
const DELIVERY_KINDS = ['pr', 'adjustment-open', 'adjustment-result', 'hml', 'item-done'];

Object.assign(OPTIONS, {
  pr: ['url', 'pr', 'branch', 'role', 'agent', 'json'],
  'final-adjustment': ['outcome', 'summary', 'role', 'agent', 'json'],
  hml: ['passed', 'failed', 'blocked', 'card', 'summary', 'role', 'agent', 'json'],
  'item-done': ['role', 'agent', 'json'],
});

/** A text field of the JSON (undefined when absent). */
function jsonText(json, field) {
  const v = json[field];
  if (v !== undefined && v !== null && typeof v !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'texto' });
  return v === null ? undefined : v;
}

/** A number field of the JSON (number or text; undefined when absent). */
function jsonNumber(json, field) {
  const v = json[field];
  if (v !== undefined && v !== null && typeof v !== 'number' && typeof v !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'número' });
  return v === null ? undefined : v;
}

/** A link of a tracker (github.com, dev.azure.com, *.visualstudio.com), or null when not given. */
function trackerLink(value, option) {
  if (value === undefined || String(value).trim() === '') return null;
  const url = projection.trackerUrl(String(value));
  if (!url) throw new InvalidData('delivery.errors.linkNotTracker', { option, value });
  return url;
}

function summaryText(value) {
  if (value === undefined) return null;
  const s = String(value).replace(/\r\n?/g, '\n').trim();
  if (s.length > MAX_SUMMARY) throw new InvalidData('delivery.errors.summaryTooLong', { length: s.length, max: MAX_SUMMARY });
  return s || null;
}

function scenarioCount(value, option) {
  if (value === undefined) return 0;
  const s = String(value).trim();
  if (!/^\d{1,6}$/.test(s)) throw new InvalidData('delivery.errors.invalidCount', { option, value });
  return Number(s);
}

/** Validated fields of a delivery command (pr, final-adjustment, hml, item done). */
function parseDelivery(command, args) {
  if (command === 'pr') {
    const { opts, pos, json } = prepare(args, 'pr', 2);
    const number = itemNumber(pick(pos[0], jsonNumber(json, 'number')));
    const state = String(pick(pos[1], jsonText(json, 'state'), '')).trim().toLowerCase();
    if (!state) throw new InvalidData('delivery.errors.missingPrState');
    if (!projection.PR_STATES.includes(state)) throw new InvalidData('delivery.errors.invalidPrState', { value: state });
    const url = trackerLink(pick(opts.url, jsonText(json, 'url')), '--url');
    const prValue = pick(opts.pr, jsonNumber(json, 'pr'));
    if (prValue !== undefined && !/^[1-9]\d{0,8}$/.test(String(prValue).trim())) throw new InvalidData('delivery.errors.invalidPrNumber', { value: prValue });
    const branch = pick(opts.branch, jsonText(json, 'branch'));
    if (branch !== undefined && (String(branch).length > MAX_BRANCH || /\s/.test(String(branch).trim()))) throw new InvalidData('delivery.errors.invalidBranch', { max: MAX_BRANCH });
    return {
      kind: 'pr', number, state, url, prNumber: prValue === undefined ? null : Number(String(prValue).trim()),
      branch: branch === undefined || !String(branch).trim() ? null : String(branch).trim(), ...agentFields(opts, json),
    };
  }
  if (command === 'final-adjustment') {
    const { opts, pos, json } = prepare(args, 'final-adjustment', 2);
    const number = itemNumber(pick(pos[0], jsonNumber(json, 'number')));
    const action = String(pick(pos[1], jsonText(json, 'action'), '')).trim().toLowerCase();
    if (action !== 'open' && action !== 'result') throw new InvalidData('delivery.errors.invalidAdjustmentAction', { value: action });
    const outcomeValue = pick(opts.outcome, jsonText(json, 'outcome'));
    const summary = summaryText(pick(opts.summary, jsonText(json, 'summary')));
    if (action === 'open') {
      if (outcomeValue !== undefined || summary !== null) throw new InvalidData('delivery.errors.openTakesNoResult');
      return { kind: 'adjustment-open', number, ...agentFields(opts, json) };
    }
    const outcome = String(pick(outcomeValue, '')).trim().toLowerCase();
    if (!projection.FINAL_ADJUSTMENT_OUTCOMES.includes(outcome)) throw new InvalidData('delivery.errors.invalidOutcome', { value: outcome });
    return { kind: 'adjustment-result', number, outcome, summary, ...agentFields(opts, json) };
  }
  if (command === 'hml') {
    const { opts, pos, json } = prepare(args, 'hml', 1);
    const number = itemNumber(pick(pos[0], jsonNumber(json, 'number')));
    const passed = scenarioCount(pick(opts.passed, jsonNumber(json, 'passed')), '--passed');
    const failed = scenarioCount(pick(opts.failed, jsonNumber(json, 'failed')), '--failed');
    const blocked = scenarioCount(pick(opts.blocked, jsonNumber(json, 'blocked')), '--blocked');
    if (passed + failed + blocked === 0) throw new InvalidData('delivery.errors.noScenarios');
    const card = trackerLink(pick(opts.card, jsonText(json, 'card')), '--card');
    return { kind: 'hml', number, passed, failed, blocked, card, summary: summaryText(pick(opts.summary, jsonText(json, 'summary'))), ...agentFields(opts, json) };
  }
  // item done
  const { opts, pos, json } = prepare(args, 'item-done', 1);
  return { kind: 'item-done', number: itemNumber(pick(pos[0], jsonNumber(json, 'number'))), ...agentFields(opts, json) };
}

/** Writes the delivery event of cmd (inside the transaction); returns the line to print. */
function recordDelivery(store, cmd, { project, events, base, key, ref }) {
  const before = projection.projectItem(events, project);
  if (!before) throw new InvalidData('errors.itemNotStarted', { key, ref, number: cmd.number });
  const needs = (stage) => {
    if (!project.stages.includes(stage)) throw new InvalidData('errors.stageNotInProject', { project: project.id, stage, allowed: project.stages });
  };
  const append = (type, payload) => store.appendEvent({ ...base, type, payload });
  const T = projection.EVENT_TYPES;
  if (cmd.kind === 'pr') {
    if (PR_STAGE[cmd.state]) needs(PR_STAGE[cmd.state]);
    if (!cmd.url && !(before.pr && before.pr.url)) throw new InvalidData('delivery.errors.missingPrUrl', { number: cmd.number, state: cmd.state });
    const payload = { state: cmd.state };
    if (cmd.url) payload.url = cmd.url;
    if (cmd.prNumber) payload.pr_number = cmd.prNumber;
    if (cmd.branch) payload.branch = cmd.branch;
    append(T.prChanged, payload);
  } else if (cmd.kind === 'adjustment-open') {
    needs('final_adjustment');
    append(T.finalAdjustmentOpened, {});
  } else if (cmd.kind === 'adjustment-result') {
    if (!before.final_adjustment || before.final_adjustment.status !== 'open') throw new InvalidData('delivery.errors.adjustmentNotOpen', { key, ref, number: cmd.number });
    append(T.finalAdjustmentFinished, cmd.summary ? { outcome: cmd.outcome, summary: cmd.summary } : { outcome: cmd.outcome });
  } else if (cmd.kind === 'hml') {
    needs('hml_validation');
    const payload = { passed: cmd.passed, failed: cmd.failed, blocked: cmd.blocked };
    if (cmd.card) payload.card_url = cmd.card;
    if (cmd.summary) payload.summary = cmd.summary;
    append(T.hmlRecorded, payload);
  } else {
    needs('done');
    if (before.stage === 'done') throw new InvalidData('delivery.errors.alreadyDone', { key, ref });
    append(T.itemDone, {});
  }
  const after = projection.projectItem(store.itemEvents(project.id, cmd.number), project);
  return t(`delivery.done.${cmd.kind}`, { key, ref, stage: after.stage, state: cmd.state, outcome: cmd.outcome, passed: cmd.passed, failed: cmd.failed, blocked: cmd.blocked });
}

// ---------- commands ----------

function prepare(argv, kind, maxPositional) {
  const { opts, pos } = parseArgs(argv, OPTIONS[kind], maxPositional, REPEATABLE[kind]);
  const json = readJson(opts);
  return { opts, pos, json };
}

function parseTask(rest) {
  const [sub, ...args] = rest;
  if (sub === 'graph') {
    const { opts, pos, json } = prepare(args, 'graph', 1);
    return { kind: 'graph', number: itemNumber(pick(pos[0], json.number)), tasks: taskGraph(opts, json), ...agentFields(opts, json) };
  }
  if (sub === 'dispatch') {
    const { opts, pos, json } = prepare(args, 'dispatch', 2);
    return {
      kind: 'dispatch', number: itemNumber(pick(pos[0], json.number)), task: taskNumber(pick(pos[1], json.task)),
      floor: lineText(pick(opts.floor, json.floor), 'floor'), worker: lineText(pick(opts.worker, json.worker), 'worker'),
      branch: lineText(pick(opts.branch, json.branch), 'branch'), ...agentFields(opts, json),
    };
  }
  if (sub === 'integrate') {
    const { opts, pos, json } = prepare(args, 'integrate', 2);
    const after = pick(opts.sha, json.sha);
    if (after === undefined || String(after).trim() === '') throw new InvalidData('errors.missingSha');
    const before = pick(opts['sha-before'], json.sha_before);
    return {
      kind: 'integrate', number: itemNumber(pick(pos[0], json.number)), task: taskNumber(pick(pos[1], json.task)),
      sha: sha(after, 'sha'), shaBefore: before === undefined || String(before).trim() === '' ? null : sha(before, 'sha-before'), ...agentFields(opts, json),
    };
  }
  throw new InvalidData(sub === undefined ? 'errors.missingCommand' : 'errors.unknownCommand', { command: `task ${sub || ''}`.trim() });
}

function parseStatus(rest) {
  const { opts, pos, json } = prepare(rest, 'status', 1);
  const text = lineText(pick(pos[0], json.text), 'texto', MAX_STATUS);
  if (!text) throw new InvalidData('errors.missingStatusText');
  const state = String(pick(opts.state, json.state, 'working')).trim().toLowerCase();
  if (!STATUS_STATES.includes(state)) throw new InvalidData('errors.invalidStatusState', { value: state, allowed: STATUS_STATES.join('|') });
  const item = pick(opts.item, json.number);
  const task = pick(opts.task, json.task);
  return {
    kind: 'status', text, state, progress: progress(pick(opts.progress, json.progress)),
    item: item === undefined ? null : itemNumber(item), task: task === undefined ? null : taskNumber(task), ...agentFields(opts, json, 'worker'),
  };
}

/** Validated fields of a command; the project and the database come after (invalid data never opens the database). */
function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (command === 'item') {
    const [sub, ...args] = rest;
    if (sub === 'done') return parseDelivery('item-done', args);
    if (sub !== 'start') throw new InvalidData(sub === undefined ? 'errors.missingCommand' : 'errors.unknownCommand', { command: `item ${sub || ''}`.trim() });
    const { opts, pos, json } = prepare(args, 'item', 1);
    const number = itemNumber(pick(pos[0], json.number));
    const title = String(pick(opts.title, json.title, '')).trim();
    if (!title) throw new InvalidData('errors.missingTitle');
    if (title.length > MAX_TITLE) throw new InvalidData('errors.titleTooLong', { length: title.length, max: MAX_TITLE });
    const stageValue = pick(opts.stage, json.stage);
    return { kind: 'start', number, title, stage: stageValue === undefined ? null : stageId(stageValue), ...agentFields(opts, json) };
  }
  if (command === 'stage') {
    const { opts, pos, json } = prepare(rest, 'stage', 2);
    const number = itemNumber(pick(pos[0], json.number));
    return { kind: 'stage', number, stage: stageId(pick(pos[1], json.stage)), ...agentFields(opts, json) };
  }
  if (command === 'task') return parseTask(rest);
  if (command === 'status') return parseStatus(rest);
  if (DELIVERY_COMMANDS.includes(command)) return parseDelivery(command, rest);
  if (command === 'pending') return parsePending(rest);
  if (command === undefined) throw new InvalidData('errors.missingCommand');
  throw new InvalidData('errors.unknownCommand', { command });
}

/** Item-level commands: item start, stage, delivery (pr, final-adjustment, hml, item done) and task graph/dispatch/integrate. Returns the lines to print. */
function recordItemCommand(store, cmd, { project, at }) {
  const key = `${project.id}/${cmd.number}`;
  const ref = trackerRef(project.tracker, cmd.number);
  const events = store.itemEvents(project.id, cmd.number);
  const started = events.find((e) => e.type === EVENT_TYPES.itemStarted);
  const base = { at, projectId: project.id, itemNumber: cmd.number, agentRole: cmd.agentRole, agentName: cmd.agentName, source: SOURCE };
  if (cmd.kind === 'start') {
    const stage = cmd.stage || project.stages[0];
    if (!project.stages.includes(stage)) throw new InvalidData('errors.stageNotInProject', { project: project.id, stage, allowed: project.stages });
    if (started) throw new InvalidData('errors.itemAlreadyStarted', { key, ref, at: started.at, number: cmd.number });
    store.appendEvent({ ...base, type: EVENT_TYPES.itemStarted, payload: { title: cmd.title, stage } });
    return [t('done.itemStarted', { key, ref, stage })];
  }
  if (DELIVERY_KINDS.includes(cmd.kind)) return [recordDelivery(store, cmd, { project, events, base, key, ref })];
  if (cmd.kind === 'stage' &&!project.stages.includes(cmd.stage)) throw new InvalidData('errors.stageNotInProject', { project: project.id, stage: cmd.stage, allowed: project.stages });
  if (!started) throw new InvalidData('errors.itemNotStarted', { key, ref, number: cmd.number });
  if (cmd.kind === 'stage') {
    store.appendEvent({ ...base, type: EVENT_TYPES.stageChanged, payload: { stage: cmd.stage } });
    return [t('done.stageChanged', { key, ref, stage: cmd.stage })];
  }
  if (cmd.kind === 'graph') {
    store.appendEvent({ ...base, type: EVENT_TYPES.taskGraph, payload: { tasks: cmd.tasks } });
    return [t('done.taskGraph', { key, ref, count: cmd.tasks.length })];
  }
  const tasks = projectItem(events, project).tasks.map((x) => x.number);
  if (!tasks.includes(cmd.task)) throw new InvalidData('errors.taskNotInItem', { key, task: cmd.task, tasks: tasks.join(', ') });
  if (cmd.kind === 'dispatch') {
    store.appendEvent({ ...base, taskNumber: cmd.task, type: EVENT_TYPES.taskDispatched, payload: { floor: cmd.floor, worker: cmd.worker, branch: cmd.branch } });
    return [t('done.taskDispatched', { key, ref, task: cmd.task, floor: cmd.floor, worker: cmd.worker, branch: cmd.branch })];
  }
  store.appendEvent({ ...base, taskNumber: cmd.task, type: EVENT_TYPES.taskIntegrated, payload: { sha: cmd.sha, sha_before: cmd.shaBefore } });
  return [t('done.taskIntegrated', { key, ref, task: cmd.task, sha: cmd.sha })];
}

function withProject(store, origin, at, fn) {
  return store.transaction(() => {
    const { project, registered, remote } = resolveProject(store, origin, at);
    const lines = registered ? [t('done.projectRegistered', { project: project.id, company: project.company_name, remote })] : [];
    return lines.concat(fn(project));
  });
}

/** The worker's status: find the task, post "maestri floor status" when inside Maestri, then record task-status. */
function recordStatus(store, cmd, origin, at, branch) {
  const lines = [];
  let target = null;
  let key = null;
  lines.push(...withProject(store, origin, at, (project) => {
    target = locateTask(store, project, cmd, branch);
    key = `${project.id}/${target.item.number}`;
    return [];
  }));
  const inside = !!process.env.MAESTRI_TERMINAL_ID;
  const posted = inside ? postFloorStatus(cmd) : null;
  const maestri = !inside ? 'outside' : posted.ok ? 'posted' : 'failed';
  withProject(store, origin, at, (project) => {
    store.appendEvent({
      at, projectId: project.id, itemNumber: target.item.number, taskNumber: target.task, agentRole: cmd.agentRole, agentName: cmd.agentName,
      source: SOURCE, type: EVENT_TYPES.taskStatus, payload: { state: cmd.state, text: cmd.text, progress: cmd.progress, maestri },
    });
    return [];
  });
  lines.push(t('done.taskStatus', { key, task: target.task, state: cmd.state, text: cmd.text }));
  lines.push(t(inside ? (posted.ok ? 'done.floorStatusPosted' : 'done.floorStatusFailed') : 'done.outsideMaestri'));
  for (const l of lines) lib.print(l);
  if (inside && !posted.ok) throw new Failed(t('errors.maestriFailed', { detail: posted.detail }));
  return [];
}

// ---------- pending decisions (#10) ----------
//
//   flow pending open <item> --kind <kind> --title "..." [--task N] [--severity S] [--context "..."] [--option "A: ..."]...
//        [--recommendation "..."] [--workspace W] [--terminal T]   → pending-decision-opened (its id is the event id)
//   flow pending resolve <id> --decision "..."                     → pending-decision-resolved
//   flow pending cancel <id> [--reason "..."]                      → pending-decision-canceled
// Where the owner answers: --workspace/--terminal, else the Maestri terminal this runs in (MAESTRI_WORKSPACE_NAME or
// MAESTRI_WORKSPACE_ID, MAESTRI_TERMINAL_NAME or MAESTRI_TERMINAL_ID), else the project's Maestri workspace.

const PENDING_OPTIONS = {
  open: ['task', 'kind', 'severity', 'title', 'context', 'option', 'recommendation', 'workspace', 'terminal', ...AGENT],
  resolve: ['decision', ...AGENT],
  cancel: ['reason', ...AGENT],
};
const PENDING_TEXT = ['kind', 'severity', 'title', 'context', 'recommendation', 'workspace', 'terminal', 'decision', 'reason'];
const MAX_CONTEXT = 4000;
const MAX_OPTION = 300;
const MAX_OPTIONS = 10;
const MAX_RECOMMENDATION = 1000;
const MAX_DECISION = 2000;

/** Optional text that may hold several lines: null when absent or blank. */
function longText(value, field, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).replace(/\r\n?/g, '\n').trim();
  if (s.length > max) throw new InvalidData('pending.errors.textTooLong', { field, length: s.length, max });
  return s;
}

/** "P-12", "p-12" or "12" → 12. */
function pendingId(value) {
  if (value === undefined || value === null || String(value).trim() === '') throw new InvalidData('pending.errors.missingId');
  const m = /^(?:p-)?(\d{1,12})$/i.exec(String(value).trim());
  if (!m || Number(m[1]) < 1) throw new InvalidData('pending.errors.invalidId', { value });
  return Number(m[1]);
}

function pendingJson(opts) {
  const json = readJson(opts);
  for (const field of PENDING_TEXT) {
    if (json[field] !== undefined && json[field] !== null && typeof json[field] !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'texto' });
  }
  if (json.options !== undefined && json.options !== null && !(Array.isArray(json.options) && json.options.every((o) => typeof o === 'string'))) {
    throw new InvalidData('errors.jsonFieldType', { field: 'options', expected: 'uma lista de textos' });
  }
  if (json.id !== undefined && json.id !== null && typeof json.id !== 'number' && typeof json.id !== 'string') throw new InvalidData('errors.jsonFieldType', { field: 'id', expected: 'número' });
  return json;
}

function parsePending(rest) {
  const [sub, ...args] = rest;
  if (!Object.prototype.hasOwnProperty.call(PENDING_OPTIONS, sub)) {
    throw new InvalidData(sub === undefined ? 'errors.missingCommand' : 'errors.unknownCommand', { command: `pending ${sub || ''}`.trim() });
  }
  const { opts, pos } = parseArgs(args, PENDING_OPTIONS[sub], 1, sub === 'open' ? ['option'] : []);
  const json = pendingJson(opts);
  if (sub === 'open') {
    const kind = String(pick(opts.kind, json.kind, '')).trim().toLowerCase().replace(/-/g, '_');
    if (!kind) throw new InvalidData('pending.errors.missingKind', { allowed: PENDING_DECISION_KINDS.join(', ') });
    if (!PENDING_DECISION_KINDS.includes(kind)) throw new InvalidData('pending.errors.invalidKind', { value: kind, allowed: PENDING_DECISION_KINDS.join(', ') });
    const severity = String(pick(opts.severity, json.severity, 'normal')).trim().toLowerCase();
    if (!PENDING_DECISION_SEVERITIES.includes(severity)) throw new InvalidData('pending.errors.invalidSeverity', { value: severity, allowed: PENDING_DECISION_SEVERITIES.join(', ') });
    const title = lineText(pick(opts.title, json.title), 'title', MAX_TITLE);
    if (!title) throw new InvalidData('pending.errors.missingTitle');
    const options = (opts.option || json.options || []).map((o) => lineText(o, 'option', MAX_OPTION)).filter(Boolean);
    if (options.length > MAX_OPTIONS) throw new InvalidData('pending.errors.tooManyOptions', { max: MAX_OPTIONS });
    const task = pick(opts.task, json.task);
    if (kind === 'task_review' && task === undefined) throw new InvalidData('pending.errors.reviewNeedsTask');
    return {
      kind: 'pending-open', number: itemNumber(pick(pos[0], json.number)), task: task === undefined ? null : taskNumber(task),
      pendingKind: kind, severity, title, options,
      context: longText(pick(opts.context, json.context), 'context', MAX_CONTEXT),
      recommendation: longText(pick(opts.recommendation, json.recommendation), 'recommendation', MAX_RECOMMENDATION),
      workspace: lineText(pick(opts.workspace, json.workspace), 'workspace'),
      terminal: lineText(pick(opts.terminal, json.terminal), 'terminal'),
      ...agentFields(opts, json),
    };
  }
  const id = pendingId(pick(pos[0], json.id));
  if (sub === 'resolve') {
    const decision = longText(pick(opts.decision, json.decision), 'decision', MAX_DECISION);
    if (!decision) throw new InvalidData('pending.errors.missingDecision');
    return { kind: 'pending-resolve', id, decision, ...agentFields(opts, json) };
  }
  return { kind: 'pending-cancel', id, reason: longText(pick(opts.reason, json.reason), 'reason', MAX_DECISION), ...agentFields(opts, json) };
}

/** Where the owner answers: the arguments, else the Maestri terminal this command runs in, else the project's workspace. */
function answerIn(cmd, project, env = process.env) {
  const first = (...values) => values.map((v) => lineText(v, 'maestri')).find(Boolean) || null;
  return {
    workspace: first(cmd.workspace, env.MAESTRI_WORKSPACE_NAME, env.MAESTRI_WORKSPACE_ID, project.maestri_workspace),
    terminal: first(cmd.terminal, env.MAESTRI_TERMINAL_NAME, env.MAESTRI_TERMINAL_ID),
  };
}

/** The pending decision with this id among the project's items: { item, pending } (InvalidData when absent). */
function findPending(store, project, id) {
  const byItem = new Map();
  for (const e of store.projectEvents(project.id)) {
    if (!byItem.has(e.item_number)) byItem.set(e.item_number, []);
    byItem.get(e.item_number).push(e);
  }
  for (const events of byItem.values()) {
    const item = projectItem(events, project);
    const pending = item && item.pending_decisions.find((p) => p.id === id);
    if (pending) return { item, pending };
  }
  throw new InvalidData('pending.errors.notFound', { id, project: project.id });
}

function recordPending(store, cmd, { project, at }) {
  const base = { at, projectId: project.id, agentRole: cmd.agentRole, agentName: cmd.agentName, source: SOURCE };
  if (cmd.kind === 'pending-open') {
    const key = `${project.id}/${cmd.number}`;
    const ref = trackerRef(project.tracker, cmd.number);
    const item = projectItem(store.itemEvents(project.id, cmd.number), project);
    if (!item) throw new InvalidData('errors.itemNotStarted', { key, ref, number: cmd.number });
    if (cmd.task !== null && !item.tasks.some((x) => x.number === cmd.task)) {
      throw new InvalidData('errors.taskNotInItem', { key, task: cmd.task, tasks: item.tasks.map((x) => x.number).join(', ') });
    }
    const maestri = answerIn(cmd, project);
    const id = store.appendEvent({
      ...base, itemNumber: cmd.number, taskNumber: cmd.task, type: EVENT_TYPES.pendingDecisionOpened,
      payload: {
        kind: cmd.pendingKind, severity: cmd.severity, title: cmd.title, context: cmd.context, options: cmd.options,
        recommendation: cmd.recommendation, maestri,
      },
    });
    return [t('pending.done.opened', { id, key, ref, task: cmd.task, kind: cmd.pendingKind, ...maestri })];
  }
  const { item, pending } = findPending(store, project, cmd.id);
  if (pending.status !== 'open') throw new InvalidData('pending.errors.notOpen', { id: cmd.id, status: pending.status, at: pending.closed_at });
  const event = { ...base, itemNumber: item.number, taskNumber: pending.task_number };
  const key = `${project.id}/${item.number}`;
  if (cmd.kind === 'pending-resolve') {
    store.appendEvent({ ...event, type: EVENT_TYPES.pendingDecisionResolved, payload: { pending_decision: cmd.id, decision: cmd.decision } });
    return [t('pending.done.resolved', { id: cmd.id, key })];
  }
  store.appendEvent({ ...event, type: EVENT_TYPES.pendingDecisionCanceled, payload: { pending_decision: cmd.id, reason: cmd.reason } });
  return [t('pending.done.canceled', { id: cmd.id, key })];
}

function run(argv, cwd) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    lib.print(t('help', { db: lib.slashes(path.join(flowDir(), 'maestro.db')) }));
    return;
  }
  if (isAdminCommand(argv)) {
    createAdmin({ InvalidData, parseArgs, readJson, pick }).run(argv, cwd);
    return;
  }
  const cmd = parseCommand(argv);
  const origin = originOf(cwd);
  if (!origin) throw new InvalidData('errors.notARepository', { cwd: lib.slashes(cwd) });
  const at = lib.isoSP(lib.now());
  const store = openStore({ dir: flowDir() });
  try {
    if (cmd.kind === 'status') {
      recordStatus(store, cmd, origin, at, branchOf(cwd));
      return;
    }
    const record = cmd.kind.startsWith('pending-') ? recordPending : recordItemCommand;
    const out = withProject(store, origin, at, (project) => record(store, cmd, { project, at }));
    for (const l of out) lib.print(l);
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try {
    run(process.argv.slice(2), process.cwd());
  } catch (e) {
    const invalid = e instanceof InvalidData;
    const message = invalid || e instanceof Failed ? e.message : t('errors.unexpected', { detail: e && e.message ? e.message : String(e) });
    process.stderr.write(`${t('errors.prefix', { message })}\n`);
    process.exitCode = invalid ? 2 : 1;
  }
}

module.exports = { run };
