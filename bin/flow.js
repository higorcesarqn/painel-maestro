#!/usr/bin/env node
'use strict';
// flow · CLI of the new model (ADRs 0001-0003): records each step of an item's flow as an event in maestro.db.
//
//   node bin/flow.js item start <number> --title "..." [--stage <stage>] [--role R] [--agent NAME] [--json -]
//   node bin/flow.js stage <number> <stage> [--role R] [--agent NAME] [--json -]
//   node bin/flow.js task graph <number> --task "<n>|<title>[|<blockers>]"... [--out <n,...>] [...] [--json -]
//   node bin/flow.js task dispatch <number> <task> [--floor F] [--worker W] [--branch B] [--mode M] [...] [--json -]
//   node bin/flow.js task integrate <number> <task> --sha <sha> [--sha-before <sha>] [...] [--json -]
//   node bin/flow.js status "<text>" [--state working|blocked|review|done] [--progress n/m] [--item N] [--task N] [...]
//   node bin/flow.js host [--json]                       the Host this runs in (bin/flow-host.js, #62)
//   node bin/flow.js org list|add …  ·  node bin/flow.js project list|add|edit|move …   (bin/flow-admin.js, #6)
//
// The project comes from the "git remote origin" of the current folder (also inside a floor's worktree); an
// unregistered repository is registered in the organization "Sem organização" and the command goes on. Fields come
// from arguments or from a JSON object on standard input (--json -); arguments win over the JSON.
//
// status is the worker's single command: it posts the status to the Host it runs in (bin/flow-host.js, #62: "maestri
// floor status" in a Maestri terminal, "orca worktree set" in an Orca terminal) and records task-status; in a plain
// terminal (a subagent) it only records. Only the worker posts: with --role maestro (or owner) it only records (#60,
// payload.host = { kind, result: 'recorded' }). The task comes from --item/--task or, without them, from the current
// branch: the task dispatched with this branch, else "task/<n>-…" → task n (looked up in the project's items; --item settles an
// ambiguity). The branch convention is parseBranch of flow-repo.js: "task/<item>-ajuste-final" is the final adjustment
// floor, never a task. When the Host's call fails the event is still recorded (payload.host = { kind, result: 'failed' })
// and the command ends with exit 1. Events before #62 recorded payload.maestri instead; the projection reads both.
//
// Exit codes: 0 ok · 2 invalid data (clear message on stderr) · 1 anything else, a maestro.db written by a newer
// painel-maestro included (#28: nothing is recorded and the message says to update the code).
// Messages for people come from the pt-BR dictionary (bin/i18n/pt-BR.js); nothing else is printed (the
// ExperimentalWarning of node:sqlite is silenced in flow-store.js).
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');
const { t } = require('./i18n');
const { openStore, flowDir, STAGES, SchemaTooNew } = require('./flow-store');
const { originOf, branchOf, describeRemote, parseBranch, integrationBranch } = require('./flow-repo');
const { taskDiff } = require('./flow-diff');
const { projectItem, trackerRef, EVENT_TYPES, WORKER_STATES, DISPATCH_MODES } = require('./flow-projection');
const { PENDING_DECISION_KINDS, PENDING_DECISION_SEVERITIES, MAX_PENDING_DECISION } = require('./flow-projection');
const { createAdmin, isAdminCommand } = require('./flow-admin');
const { readVersion } = require('./version');
const host = require('./flow-host');

const ROLES = ['maestro', 'worker', 'owner'];
const MAX_TITLE = 300;
const MAX_AGENT = 80;
const MAX_FIELD = 200;
const MAX_STATUS = 300;
const MAX_TASKS = 200;
const SOURCE = 'cli';

const { InvalidData } = lib;

/** Something outside the data failed after the event was recorded (exit 1, the message says what). */
class Failed extends Error {}

// ---------- arguments ----------

const AGENT = ['role', 'agent', 'json'];
const OPTIONS = {
  item: ['title', 'stage', ...AGENT],
  stage: AGENT,
  graph: ['task', 'out', ...AGENT],
  dispatch: ['floor', 'worker', 'branch', 'mode', ...AGENT],
  integrate: ['sha', 'sha-before', ...AGENT],
  status: ['state', 'progress', 'item', 'task', ...AGENT],
};
const REPEATABLE = { graph: ['task'] };

/** --name value, --name=value or, for a flag, --name alone (true). Throws InvalidData on anything else. */
function parseArgs(argv, allowed, maxPositional, repeatable = [], flags = []) {
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
    if (!allowed.includes(name) && !flags.includes(name)) throw new InvalidData('errors.unknownOption', { option: name });
    if (flags.includes(name)) {
      if (value !== undefined) throw new InvalidData('errors.unexpectedArgument', { value: a });
      value = true;
    } else if (value === undefined) {
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

const JSON_TEXT = ['title', 'stage', 'role', 'agent', 'floor', 'worker', 'branch', 'mode', 'sha', 'sha_before', 'text', 'state', 'progress'];
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
    if (o[field] !== undefined && o[field] !== null && typeof o[field] !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'text' });
  }
  for (const field of JSON_NUMBER) {
    if (o[field] !== undefined && o[field] !== null && typeof o[field] !== 'number' && typeof o[field] !== 'string') {
      throw new InvalidData('errors.jsonFieldType', { field, expected: 'number' });
    }
  }
  if (o.tasks !== undefined && o.tasks !== null && !Array.isArray(o.tasks)) throw new InvalidData('errors.jsonFieldType', { field: 'tasks', expected: 'list' });
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
  const s = lib.normalizeId(value);
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
    if (r.blocked_by !== undefined && r.blocked_by !== null && !Array.isArray(r.blocked_by)) throw new InvalidData('errors.jsonFieldType', { field: 'blocked_by', expected: 'list' });
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
  const items = [...store.projectedItems({ projectId: project.id }).values()].map((it) => it.state);
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
    const named = parseBranch(branch); // task/<item>-ajuste-final is the final adjustment floor, never a task
    if (named.kind === 'task') return withTask(named.task);
  }
  if (cmd.item && scope[0].tasks.length === 1) return { item: scope[0], task: scope[0].tasks[0].number };
  throw new InvalidData('errors.statusNoTask', { branch: branch || '-' });
}

/** The dispatch mode: --mode (or "mode" in the JSON), else the mode of the Host this runs in (none → subagents). */
function dispatchMode(value, env = process.env) {
  if (value === undefined || value === null || String(value).trim() === '') return host.detectHost(env).mode;
  const mode = String(value).trim().toLowerCase();
  if (!DISPATCH_MODES.includes(mode)) throw new InvalidData('errors.invalidMode', { value, allowed: DISPATCH_MODES });
  return mode;
}

// ---------- project ----------

const slug = (s) => lib.stripAccents(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'projeto';

/** The project of the current folder, registering it in "Sem organização" when needed. Inside a transaction. */
function resolveProject(store, origin, at) {
  const d = describeRemote(origin);
  const known = store.projectByRemote(d.remote);
  if (known) return { project: known, registered: false, remote: d.remote };
  const project = store.addUnregisteredProject({ id: store.freeProjectId(slug(d.repo)), name: d.repo, tracker: d.tracker, remote: d.remote, at });
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
  if (v !== undefined && v !== null && typeof v !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'text' });
  return v === null ? undefined : v;
}

/** A number field of the JSON (number or text; undefined when absent). */
function jsonNumber(json, field) {
  const v = json[field];
  if (v !== undefined && v !== null && typeof v !== 'number' && typeof v !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'number' });
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

// ---------- reports and findings (#8): the worker's report of a task and the maestro's findings ----------
//
//   flow report [--item N] [--task N] [--status ok|blocked] [--reason "..."] [--branch B] [--sha S] [--base B] --json -
//       → task-report: the whole report the worker sends to the maestro, recorded before it is sent. The long
//         fields (tests, changes, decisions, risks, shared_files, text) come by JSON on standard input and are kept
//         exactly as written. The task is found like in "status" (--item/--task or the current branch); branch and
//         SHA default to the current folder's when the task was found by the branch or the folder is on its branch.
//         With a SHA the report also gets the diff summary (payload.diff, bin/flow-diff.js) against the base:
//         --base (or "base" in the JSON), else the item's pr.branch, else the tracker's convention (integrationBranch
//         of flow-repo.js). Without it (no SHA, no base, git failing) the report is recorded all the same, exit 0,
//         and a second line says why; the reason is not recorded.
//   flow finding add <number> --title "..." --classification defect|owner_decision|discarded [--description "..."]
//         [--task <origin task>] [--new-task <n> [--new-task-title "..."]]                    → finding-recorded
//   flow finding link <number> <finding> --new-task <n> [--new-task-title "..."]             → finding-linked
//       A finding's new task is a task of the item in state "out" (for triage); its number is numbered per item.

const MAX_REPORT_TEXT = 20000;
const MAX_REPORT_LIST = 100;
const REPORT_TEXTS = ['tests', 'changes', 'risks', 'text'];
const REPORT_LISTS = ['decisions', 'shared_files'];
const REVIEW_COMMANDS = ['report', 'finding'];
const FINDING_KINDS = ['finding-add', 'finding-link'];

Object.assign(OPTIONS, {
  report: ['item', 'task', 'status', 'reason', 'branch', 'sha', 'base', ...AGENT],
  'finding-add': ['title', 'classification', 'description', 'task', 'new-task', 'new-task-title', ...AGENT],
  'finding-link': ['new-task', 'new-task-title', ...AGENT],
});

/** A free text of a report or finding, kept exactly as written; null when absent or blank. */
function freeText(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'text' });
  if (value.length > MAX_REPORT_TEXT) throw new InvalidData('review.errors.textTooLong', { field, length: value.length, max: MAX_REPORT_TEXT });
  return value.trim() ? value : null;
}

/** A list of texts of the JSON (decisions, shared_files): blank entries are dropped. */
function textList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) throw new InvalidData('errors.jsonFieldType', { field, expected: 'text_list' });
  if (value.length > MAX_REPORT_LIST) throw new InvalidData('review.errors.listTooLong', { field, max: MAX_REPORT_LIST });
  return value.map((x, i) => freeText(x, `${field}[${i}]`)).filter((x) => x !== null);
}

function parseReport(rest) {
  const { opts, json } = prepare(rest, 'report', 0);
  const statusValue = pick(opts.status, jsonText(json, 'status'));
  if (statusValue === undefined || !String(statusValue).trim()) throw new InvalidData('review.errors.missingStatus');
  const status = String(statusValue).trim().toLowerCase();
  if (!projection.REPORT_STATUSES.includes(status)) throw new InvalidData('review.errors.invalidStatus', { value: statusValue });
  const fields = { blocked_reason: freeText(pick(opts.reason, json.blocked_reason), 'blocked_reason') };
  for (const f of REPORT_TEXTS) fields[f] = freeText(json[f], f);
  for (const f of REPORT_LISTS) fields[f] = textList(json[f], f);
  const empty = REPORT_TEXTS.every((f) => fields[f] === null) && REPORT_LISTS.every((f) => !fields[f].length) && !fields.blocked_reason;
  if (empty) throw new InvalidData('review.errors.emptyReport');
  const shaValue = pick(opts.sha, jsonText(json, 'sha'));
  const item = pick(opts.item, jsonNumber(json, 'number'));
  const task = pick(opts.task, jsonNumber(json, 'task'));
  return {
    kind: 'report', status, fields,
    branch: lineText(pick(opts.branch, jsonText(json, 'branch')), 'branch'),
    base: lineText(pick(opts.base, jsonText(json, 'base')), 'base'),
    sha: shaValue === undefined || !String(shaValue).trim() ? null : sha(shaValue, 'sha'),
    item: item === undefined ? null : itemNumber(item), task: task === undefined ? null : taskNumber(task),
    ...agentFields(opts, json, 'worker'),
  };
}

function newTaskFields(opts, json) {
  const value = pick(opts['new-task'], jsonNumber(json, 'new_task'));
  const title = pick(opts['new-task-title'], jsonText(json, 'new_task_title'));
  if (value === undefined) {
    if (title !== undefined) throw new InvalidData('review.errors.missingNewTask');
    return null;
  }
  const t2 = title === undefined ? '' : String(title).trim();
  if (t2.length > MAX_TITLE || /[\r\n]/.test(t2)) throw new InvalidData('errors.invalidText', { field: 'new_task_title', max: MAX_TITLE });
  return { number: taskNumber(value), title: t2 || null };
}

function parseFinding(rest) {
  const [sub, ...args] = rest;
  if (sub === 'add') {
    const { opts, pos, json } = prepare(args, 'finding-add', 1);
    const number = itemNumber(pick(pos[0], jsonNumber(json, 'number')));
    const title = String(pick(opts.title, jsonText(json, 'title'), '')).trim();
    if (!title) throw new InvalidData('review.errors.missingFindingTitle');
    if (title.length > MAX_TITLE || /[\r\n]/.test(title)) throw new InvalidData('errors.invalidText', { field: 'title', max: MAX_TITLE });
    const classValue = pick(opts.classification, jsonText(json, 'classification'));
    if (classValue === undefined || !String(classValue).trim()) throw new InvalidData('review.errors.missingClassification');
    const classification = String(classValue).trim().toLowerCase();
    if (!projection.FINDING_CLASSIFICATIONS.includes(classification)) throw new InvalidData('review.errors.invalidClassification', { value: classValue });
    const origin = pick(opts.task, jsonNumber(json, 'task'));
    const newTask = newTaskFields(opts, json);
    if (newTask && classification === 'discarded') throw new InvalidData('review.errors.discardedNewTask');
    return {
      kind: 'finding-add', number, title, classification, description: freeText(pick(opts.description, json.description), 'description'),
      origin: origin === undefined ? null : taskNumber(origin), newTask, ...agentFields(opts, json),
    };
  }
  if (sub === 'link') {
    const { opts, pos, json } = prepare(args, 'finding-link', 2);
    const number = itemNumber(pick(pos[0], jsonNumber(json, 'number')));
    const findingValue = pick(pos[1], jsonNumber(json, 'finding'));
    if (findingValue === undefined) throw new InvalidData('review.errors.missingFinding');
    const s = String(findingValue).trim();
    if (!/^[1-9]\d{0,8}$/.test(s)) throw new InvalidData('review.errors.invalidFinding', { value: findingValue });
    const newTask = newTaskFields(opts, json);
    if (!newTask) throw new InvalidData('review.errors.missingNewTask');
    return { kind: 'finding-link', number, finding: Number(s), newTask, ...agentFields(opts, json) };
  }
  throw new InvalidData(sub === undefined ? 'errors.missingCommand' : 'errors.unknownCommand', { command: `finding ${sub || ''}`.trim() });
}

/** Writes the finding event of cmd (inside the transaction); returns the line to print. */
function recordFinding(store, cmd, { project, events, base, key, ref }) {
  const before = projection.projectItem(events, project);
  const taskNumbers = before.tasks.map((x) => x.number);
  const T = projection.EVENT_TYPES;
  const checkNew = (task) => {
    if (taskNumbers.includes(task.number)) throw new InvalidData('review.errors.taskAlreadyInItem', { task: task.number, key });
  };
  if (cmd.kind === 'finding-add') {
    if (cmd.origin !== null && !taskNumbers.includes(cmd.origin)) throw new InvalidData('errors.taskNotInItem', { key, task: cmd.origin, tasks: taskNumbers.join(', ') });
    if (cmd.newTask) checkNew(cmd.newTask);
    const finding = before.findings.reduce((max, f) => Math.max(max, f.number), 0) + 1;
    const newTask = cmd.newTask ? { number: cmd.newTask.number, title: cmd.newTask.title || cmd.title } : null;
    store.appendEvent({
      ...base, taskNumber: cmd.origin, type: T.findingRecorded,
      payload: { finding, title: cmd.title, description: cmd.description, classification: cmd.classification, origin_task: cmd.origin, new_task: newTask },
    });
    return t('review.done.findingRecorded', { key, ref, finding, classification: cmd.classification, task: newTask && newTask.number });
  }
  const found = before.findings.find((f) => f.number === cmd.finding);
  if (!found) throw new InvalidData('review.errors.findingNotFound', { key, finding: cmd.finding });
  if (found.new_task) throw new InvalidData('review.errors.findingAlreadyLinked', { key, finding: cmd.finding, task: found.new_task.number });
  if (found.classification === 'discarded') throw new InvalidData('review.errors.discardedNewTask');
  checkNew(cmd.newTask);
  const newTask = { number: cmd.newTask.number, title: cmd.newTask.title || found.title };
  store.appendEvent({ ...base, taskNumber: found.origin_task, type: T.findingLinked, payload: { finding: cmd.finding, new_task: newTask } });
  return t('review.done.findingLinked', { key, ref, finding: cmd.finding, task: newTask.number });
}

/** The HEAD commit of cwd, or null. */
function headOf(cwd) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim().toLowerCase() || null;
}

/**
 * The worker's report: find the task (as "status" does), compute the diff summary outside the transaction (git may
 * take up to 10 s per call) and record task-report, with payload.diff when there is a summary.
 */
function recordReport(store, cmd, origin, at, cwd) {
  const branch = branchOf(cwd);
  let found = null;
  const lines = withProject(store, origin, at, (project) => {
    const target = locateTask(store, project, cmd, branch);
    const task = target.item.tasks.find((x) => x.number === target.task);
    const pr = target.item.pr;
    found = {
      target, task, fromCwd: !cmd.task || (branch && task && task.branch === branch), key: `${project.id}/${target.item.number}`,
      bases: [cmd.base, pr && pr.branch, integrationBranch(project.tracker, target.item.number)],
    };
    return [];
  });
  const { target, task, fromCwd, key, bases } = found;
  const worktreeHead = fromCwd ? headOf(cwd) : null;
  const sha = cmd.sha || worktreeHead;
  const summary = taskDiff(cwd, { sha, bases, worktreeHead });
  const payload = {
    status: cmd.status, blocked_reason: cmd.fields.blocked_reason,
    branch: cmd.branch || (fromCwd ? branch : null) || (task && task.branch) || null,
    sha,
    tests: cmd.fields.tests, changes: cmd.fields.changes, decisions: cmd.fields.decisions, risks: cmd.fields.risks,
    shared_files: cmd.fields.shared_files, text: cmd.fields.text,
    ...(summary.diff ? { diff: summary.diff } : {}),
  };
  withProject(store, origin, at, (project) => {
    store.appendEvent({
      at, projectId: project.id, itemNumber: target.item.number, taskNumber: target.task, agentRole: cmd.agentRole, agentName: cmd.agentName,
      source: SOURCE, type: projection.EVENT_TYPES.taskReport, payload,
    });
    return [];
  });
  lines.push(t('review.done.report', { key, task: target.task, status: cmd.status }));
  if (!summary.diff) lines.push(t('review.done.reportWithoutDiff', { reason: t(`review.diff.${summary.reason}`, summary.params) }));
  return lines;
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
      branch: lineText(pick(opts.branch, json.branch), 'branch'), mode: dispatchMode(pick(opts.mode, json.mode)), ...agentFields(opts, json),
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
  if (REVIEW_COMMANDS.includes(command)) return command === 'report' ? parseReport(rest) : parseFinding(rest);
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
  if (FINDING_KINDS.includes(cmd.kind)) return [recordFinding(store, cmd, { project, events, base, key, ref })];
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
    store.appendEvent({ ...base, taskNumber: cmd.task, type: EVENT_TYPES.taskDispatched, payload: { floor: cmd.floor, worker: cmd.worker, branch: cmd.branch, mode: cmd.mode } });
    return [t('done.taskDispatched', { key, ref, task: cmd.task, floor: cmd.floor, worker: cmd.worker, branch: cmd.branch, mode: cmd.mode })];
  }
  store.appendEvent({ ...base, taskNumber: cmd.task, type: EVENT_TYPES.taskIntegrated, payload: { sha: cmd.sha, sha_before: cmd.shaBefore } });
  return [t('done.taskIntegrated', { key, ref, task: cmd.task, sha: cmd.sha })];
}

function withProject(store, origin, at, fn) {
  return store.transaction(() => {
    const { project, registered, remote } = resolveProject(store, origin, at);
    const lines = registered ? [t('done.projectRegistered', { project: project.id, organization: project.organization_name, remote })] : [];
    return lines.concat(fn(project));
  });
}

/**
 * The status of a task: find the task, post it to the Host (Maestri or Orca; nothing in a plain terminal) when the worker
 * sends it, then record task-status. The maestro's (or the owner's) is only recorded (#60): it never moves the card of
 * the maestro's own worktree nor posts on its floor.
 */
function recordStatus(store, cmd, origin, at, branch) {
  const lines = [];
  let target = null;
  let key = null;
  lines.push(...withProject(store, origin, at, (project) => {
    target = locateTask(store, project, cmd, branch);
    key = `${project.id}/${target.item.number}`;
    return [];
  }));
  const where = host.detectHost();
  const worker = cmd.agentRole === 'worker';
  const posted = worker ? host.postStatus(where, cmd) : null;
  const result = !worker ? 'recorded' : !posted ? 'outside' : posted.ok ? 'posted' : 'failed';
  withProject(store, origin, at, (project) => {
    store.appendEvent({
      at, projectId: project.id, itemNumber: target.item.number, taskNumber: target.task, agentRole: cmd.agentRole, agentName: cmd.agentName,
      source: SOURCE, type: EVENT_TYPES.taskStatus, payload: { state: cmd.state, text: cmd.text, progress: cmd.progress, host: { kind: where.kind, result } },
    });
    return [];
  });
  lines.push(t('done.taskStatus', { key, task: target.task, state: cmd.state, text: cmd.text }));
  lines.push(t(worker ? `done.hostStatus.${where.kind}.${result}` : 'done.hostStatus.recorded'));
  for (const l of lines) lib.print(l);
  if (posted && !posted.ok) throw new Failed(t(`errors.${where.kind}Failed`, { detail: posted.detail }));
  return [];
}

// ---------- pending decisions (#10) ----------
//
//   flow pending open <item> --kind <kind> --title "..." [--task N] [--severity S] [--context "..."] [--option "A: ..."]...
//        [--recommendation "..."] [--workspace W] [--terminal T]   → pending-decision-opened (its id is the event id)
//   flow pending resolve <id> --decision "..."                     → pending-decision-resolved
//   flow pending cancel <id> [--reason "..."]                      → pending-decision-canceled
//   flow pending wait <id>                                         → nothing: waits for it to close (#33, ADR 0005)
// Where the owner answers (payload.host: { kind, workspace, terminal }, #62): --workspace/--terminal, else the terminal
// and workspace of the Host this runs in (flow-host.js answerIn: the ones flow host shows), else (but in the Orca) the
// project's Maestri workspace. Events before #62 recorded payload.maestri: { workspace, terminal }; the projection reads
// both.
// open tells the owner through the Host (bin/flow-host.js: "maestri notify" in the Maestri, the maestro's worktree marked
// unread in the Orca) and records how it went in the event (notification: sent | failed | outside); a failure only
// writes one line on stderr, never changes the exit code (#44). The HML pending decision derived from flow hml has no
// event of its own and tells no one.
// wait only reads maestro.db (readOnly, a fresh connection each FLOW_WAIT_INTERVAL_MS, default 3 s), with no time
// limit and no panel server, and never registers the project; it ends when the pending decision closes in any way.

const PENDING_OPTIONS = {
  open: ['task', 'kind', 'severity', 'title', 'context', 'option', 'recommendation', 'workspace', 'terminal', ...AGENT],
  resolve: ['decision', ...AGENT],
  cancel: ['reason', ...AGENT],
  wait: ['json'],
};
const WAIT_INTERVAL_MS = 3000;
const PENDING_TEXT = ['kind', 'severity', 'title', 'context', 'recommendation', 'workspace', 'terminal', 'decision', 'reason'];
const MAX_CONTEXT = 4000;
const MAX_OPTION = 300;
const MAX_OPTIONS = 10;
const MAX_RECOMMENDATION = 1000;
const MAX_DECISION = MAX_PENDING_DECISION;

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
    if (json[field] !== undefined && json[field] !== null && typeof json[field] !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'text' });
  }
  if (json.options !== undefined && json.options !== null && !(Array.isArray(json.options) && json.options.every((o) => typeof o === 'string'))) {
    throw new InvalidData('errors.jsonFieldType', { field: 'options', expected: 'text_list' });
  }
  if (json.id !== undefined && json.id !== null && typeof json.id !== 'number' && typeof json.id !== 'string') throw new InvalidData('errors.jsonFieldType', { field: 'id', expected: 'number' });
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
    const kind = lib.normalizeId(pick(opts.kind, json.kind, ''));
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
  if (sub === 'wait') return { kind: 'pending-wait', id };
  if (sub === 'resolve') {
    const decision = longText(pick(opts.decision, json.decision), 'decision', MAX_DECISION);
    if (!decision) throw new InvalidData('pending.errors.missingDecision');
    return { kind: 'pending-resolve', id, decision, ...agentFields(opts, json) };
  }
  return { kind: 'pending-cancel', id, reason: longText(pick(opts.reason, json.reason), 'reason', MAX_DECISION), ...agentFields(opts, json) };
}

/** Where the owner answers (flow-host.js answerIn), each value checked like an argument: InvalidData names the Host. */
function answerIn(cmd, project, where) {
  const field = where.kind === 'none' ? 'host' : where.kind; // the error names the Host whose variable is wrong
  const answer = host.answerIn(where, cmd, project.maestri_workspace);
  return { ...answer, workspace: lineText(answer.workspace, field), terminal: lineText(answer.terminal, field) };
}

/** The pending decision with this id among the project's items: { item, pending } (InvalidData when absent). */
function findPending(store, project, id) {
  for (const { state: item } of store.projectedItems({ projectId: project.id }).values()) {
    const pending = item.pending_decisions.find((p) => p.id === id);
    if (pending) return { item, pending };
  }
  throw new InvalidData('pending.errors.notFound', { id, project: project.id });
}

/**
 * Everything of a pending open that can be refused, checked before the owner is told: the item was started and has the
 * task, and where to answer is valid. { key, ref } of the item and answer: { kind, workspace, terminal }.
 */
function checkPendingOpen(store, cmd, project, where) {
  const key = `${project.id}/${cmd.number}`;
  const ref = trackerRef(project.tracker, cmd.number);
  const item = projectItem(store.itemEvents(project.id, cmd.number), project);
  if (!item) throw new InvalidData('errors.itemNotStarted', { key, ref, number: cmd.number });
  if (cmd.task !== null && !item.tasks.some((x) => x.number === cmd.task)) {
    throw new InvalidData('errors.taskNotInItem', { key, task: cmd.task, tasks: item.tasks.map((x) => x.number).join(', ') });
  }
  return { key, ref, answer: answerIn(cmd, project, where) };
}

/**
 * pending open: check the item, tell the owner through the Host this runs in (#44, #62: "maestri notify" in the Maestri,
 * the maestro's worktree marked unread in the Orca), then record pending-decision-opened with where to answer (host) and
 * how the notice went (notification). A failed notice never fails the command: the pending decision is recorded,
 * printed as always, and one line on stderr says the owner may not have been told.
 */
function openPending(store, cmd, origin, at) {
  const where = host.detectHost();
  let checked = null;
  const lines = withProject(store, origin, at, (project) => {
    checked = checkPendingOpen(store, cmd, project, where);
    return [];
  });
  const { key, ref } = checked;
  const told = host.notifyOwner(where, { severity: cmd.severity, kind: cmd.pendingKind, key, ref, task: cmd.task, title: cmd.title });
  const notification = !told ? 'outside' : told.ok ? 'sent' : 'failed';
  let id = null;
  lines.push(...withProject(store, origin, at, (project) => {
    const { answer } = checked;
    id = store.appendEvent({
      at, projectId: project.id, itemNumber: cmd.number, taskNumber: cmd.task, agentRole: cmd.agentRole, agentName: cmd.agentName,
      source: SOURCE, type: EVENT_TYPES.pendingDecisionOpened,
      payload: {
        kind: cmd.pendingKind, severity: cmd.severity, title: cmd.title, context: cmd.context, options: cmd.options,
        recommendation: cmd.recommendation, host: answer, notification,
      },
    });
    return [t('pending.done.opened', { id, key, ref, task: cmd.task, kind: cmd.pendingKind, host: answer.kind, workspace: answer.workspace, terminal: answer.terminal })];
  }));
  for (const l of lines) lib.print(l);
  if (told && !told.ok) process.stderr.write(`${t('pending.notify.failed', { id, host: where.kind, detail: told.detail })}\n`);
}

function recordPending(store, cmd, { project, at }) {
  const base = { at, projectId: project.id, agentRole: cmd.agentRole, agentName: cmd.agentName, source: SOURCE };
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

/**
 * One read-only look at the pending decision of the project of origin: { project, item, pending, fromPanel }, where
 * fromPanel says the owner's decision was recorded by the panel (#32). itemNumber: where it was found the last time
 * (only that item is projected again). InvalidData when the project or the pending decision does not exist.
 */
function lookAtPending(origin, id, itemNumber = null) {
  const { remote } = describeRemote(origin);
  const store = openStore({ dir: flowDir(), readOnly: true });
  if (!store) throw new InvalidData('pending.errors.noDatabase', { id, file: lib.slashes(path.join(flowDir(), 'maestro.db')) });
  try {
    const project = store.projectByRemote(remote);
    if (!project) throw new InvalidData('pending.errors.noProject', { id, remote });
    let found = null;
    if (itemNumber !== null) {
      const item = projectItem(store.itemEvents(project.id, itemNumber), project);
      const pending = item && item.pending_decisions.find((p) => p.id === id);
      if (pending) found = { item, pending };
    }
    found = found || findPending(store, project, id);
    let fromPanel = false;
    if (found.pending.resolution === 'decision') {
      // The first resolution of an open pending decision is the one that closed it (the projection ignores the others).
      const closing = store.itemEvents(project.id, found.item.number)
        .find((e) => e.type === EVENT_TYPES.pendingDecisionResolved && e.payload.pending_decision === id);
      fromPanel = !!closing && closing.source === 'panel';
    }
    return { project, ...found, fromPanel };
  } finally {
    store.close();
  }
}

/** What the wait prints when the pending decision closed: how, the decision or the reason, who closed it and when. */
function closedLines({ project, item, pending, fromPanel }) {
  const lines = [t('pending.wait.closed', {
    id: pending.id, key: `${project.id}/${item.number}`, ref: trackerRef(project.tracker, item.number), task: pending.task_number,
    status: pending.status, resolution: pending.resolution,
  })];
  if (pending.title) lines.push(t('pending.wait.title', { title: pending.title }));
  if (pending.status === 'canceled') lines.push(t(pending.reason ? 'pending.wait.reason' : 'pending.wait.noReason', { reason: pending.reason }));
  else if (pending.decision) lines.push(t('pending.wait.decision', { decision: pending.decision }));
  lines.push(t('pending.wait.closedBy', { ...(pending.closed_by || {}), panel: fromPanel, at: pending.closed_at }));
  if (fromPanel) lines.push(t('pending.wait.fromPanel'));
  return lines;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** flow pending wait: polls maestro.db until the pending decision closes, then prints how it closed. */
async function waitPending(cmd, origin, env = process.env) {
  const ms = Number(env.FLOW_WAIT_INTERVAL_MS);
  const interval = Number.isInteger(ms) && ms >= 10 ? ms : WAIT_INTERVAL_MS;
  let seen = lookAtPending(origin, cmd.id);
  if (seen.pending.status === 'open') {
    lib.print(t('pending.wait.waiting', { id: cmd.id, key: `${seen.project.id}/${seen.item.number}`, ref: trackerRef(seen.project.tracker, seen.item.number) }));
    while (seen.pending.status === 'open') {
      await sleep(interval);
      seen = lookAtPending(origin, cmd.id, seen.item.number);
    }
  }
  for (const l of closedLines(seen)) lib.print(l);
}

/** flow host [--json]: the Host this runs in; never fails on what it finds (exit 0), only on an unknown argument. */
function printHost(args, env = process.env) {
  const { opts } = parseArgs(args, [], 0, [], ['json']);
  const report = host.hostReport(env);
  if (opts.json) {
    lib.print(JSON.stringify(report));
    return;
  }
  lib.print(t(`host.kind.${report.kind}`, report));
  if (report.checks.orca_status) lib.print(t(report.checks.orca_status.ok ? 'host.orcaStatusOk' : 'host.orcaStatusFailed', report.checks.orca_status));
  if (report.kind === 'orca' && report.checks.maestri_terminal) lib.print(t('host.bothTerminals'));
}

function run(argv, cwd) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    lib.print(t('help', { db: lib.slashes(path.join(flowDir(), 'maestro.db')) }));
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    lib.print(t('version', readVersion()));
    return;
  }
  if (argv[0] === 'host') {
    printHost(argv.slice(1));
    return;
  }
  if (isAdminCommand(argv)) {
    createAdmin({ InvalidData, parseArgs, readJson, pick }).run(argv, cwd);
    return;
  }
  const cmd = parseCommand(argv);
  const origin = originOf(cwd);
  if (!origin) throw new InvalidData('errors.notARepository', { cwd: lib.slashes(cwd) });
  if (cmd.kind === 'pending-wait') return waitPending(cmd, origin);
  const at = lib.isoSP(lib.now());
  const store = openStore({ dir: flowDir() });
  try {
    if (cmd.kind === 'status') {
      recordStatus(store, cmd, origin, at, branchOf(cwd));
      return;
    }
    if (cmd.kind === 'report') {
      for (const l of recordReport(store, cmd, origin, at, cwd)) lib.print(l);
      return;
    }
    if (cmd.kind === 'pending-open') {
      openPending(store, cmd, origin, at);
      return;
    }
    const record = cmd.kind.startsWith('pending-') ? recordPending : recordItemCommand;
    const out = withProject(store, origin, at, (project) => record(store, cmd, { project, at }));
    for (const l of out) lib.print(l);
  } finally {
    store.close();
  }
}

function fail(e) {
  const invalid = e instanceof InvalidData;
  let message;
  if (invalid || e instanceof Failed) message = e.message;
  else if (e instanceof SchemaTooNew) message = t('errors.schemaTooNew', { ...e.error, file: lib.slashes(path.join(flowDir(), e.error.file)) });
  else message = t('errors.unexpected', { detail: e && e.message ? e.message : String(e) });
  process.stderr.write(`${t('errors.prefix', { message })}\n`);
  process.exitCode = invalid ? 2 : 1;
}

if (require.main === module) {
  try {
    // Only pending wait returns a promise.
    const waiting = run(process.argv.slice(2), process.cwd());
    if (waiting) waiting.catch(fail);
  } catch (e) {
    fail(e);
  }
}

module.exports = { run };
