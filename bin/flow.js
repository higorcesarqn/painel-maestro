#!/usr/bin/env node
'use strict';
// flow · CLI of the new model (ADRs 0001-0003): records each step of an item's flow as an event in maestro.db.
//
//   node bin/flow.js item start <number> --title "..." [--stage <stage>] [--role R] [--agent NAME] [--json -]
//   node bin/flow.js stage <number> <stage> [--role R] [--agent NAME] [--json -]
//
// The project comes from the "git remote origin" of the current folder (also inside a floor's worktree); an
// unregistered repository is registered in the company "Sem empresa" and the command goes on. Fields come
// from arguments or from a JSON object on standard input (--json -); arguments win over the JSON.
// Exit codes: 0 ok · 2 invalid data (clear message on stderr) · 1 anything else.
// Messages for people come from the pt-BR dictionary (bin/i18n/pt-BR.js); nothing else is printed (the
// ExperimentalWarning of node:sqlite is silenced in flow-store.js).
const path = require('path');
const lib = require('./lib');
const { t } = require('./i18n');
const { openStore, flowDir, STAGES, UNASSIGNED_COMPANY } = require('./flow-store');
const { originOf, describeRemote } = require('./flow-repo');
const { trackerRef, EVENT_TYPES } = require('./flow-projection');

const ROLES = ['maestro', 'worker', 'owner'];
const MAX_TITLE = 300;
const MAX_AGENT = 80;
const SOURCE = 'cli';

class InvalidData extends Error {
  constructor(key, params = {}) {
    super(t(key, params));
    this.key = key;
  }
}

// ---------- arguments ----------

const OPTIONS = { item: ['title', 'stage', 'role', 'agent', 'json'], stage: ['role', 'agent', 'json'] };

function parseArgs(argv, allowed, maxPositional) {
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
    if (opts[name] !== undefined) throw new InvalidData('errors.repeatedOption', { option: name });
    opts[name] = value;
  }
  if (pos.length > maxPositional) throw new InvalidData('errors.unexpectedArgument', { value: pos[maxPositional] });
  return { opts, pos };
}

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
  for (const field of ['title', 'stage', 'role', 'agent']) {
    if (o[field] !== undefined && o[field] !== null && typeof o[field] !== 'string') throw new InvalidData('errors.jsonFieldType', { field, expected: 'texto' });
  }
  if (o.number !== undefined && o.number !== null && typeof o.number !== 'number' && typeof o.number !== 'string') {
    throw new InvalidData('errors.jsonFieldType', { field: 'number', expected: 'número' });
  }
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

function stageId(value) {
  if (value === undefined || String(value).trim() === '') throw new InvalidData('errors.missingStage');
  const s = String(value).trim().toLowerCase().replace(/-/g, '_');
  if (!STAGES.includes(s)) throw new InvalidData('errors.unknownStage', { stage: value, allowed: STAGES });
  return s;
}

function agentFields(opts, json) {
  const role = String(pick(opts.role, json.role, 'maestro')).trim().toLowerCase();
  if (!ROLES.includes(role)) throw new InvalidData('errors.invalidRole', { value: role, allowed: ROLES.join(', ') });
  const agent = pick(opts.agent, json.agent);
  if (agent !== undefined && (String(agent).length > MAX_AGENT || /[\r\n]/.test(String(agent)))) throw new InvalidData('errors.invalidAgent', { max: MAX_AGENT });
  return { agentRole: role, agentName: agent === undefined || String(agent).trim() === '' ? null : String(agent).trim() };
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
  const { opts, pos } = parseArgs(argv, OPTIONS[kind], maxPositional);
  const json = readJson(opts);
  return { opts, pos, json };
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
  if (DELIVERY_COMMANDS.includes(command)) return parseDelivery(command, rest);
  if (command === undefined) throw new InvalidData('errors.missingCommand');
  throw new InvalidData('errors.unknownCommand', { command });
}

function run(argv, cwd) {
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    lib.print(t('help', { db: lib.slashes(path.join(flowDir(), 'maestro.db')) }));
    return;
  }
  const cmd = parseCommand(argv);
  const origin = originOf(cwd);
  if (!origin) throw new InvalidData('errors.notARepository', { cwd: lib.slashes(cwd) });
  const at = lib.isoSP(lib.now());
  const store = openStore({ dir: flowDir() });
  try {
    const out = store.transaction(() => {
      const { project, registered, remote } = resolveProject(store, origin, at);
      const key = `${project.id}/${cmd.number}`;
      const ref = trackerRef(project.tracker, cmd.number);
      const stage = cmd.stage || project.stages[0];
      if (!project.stages.includes(stage)) throw new InvalidData('errors.stageNotInProject', { project: project.id, stage, allowed: project.stages });
      const events = store.itemEvents(project.id, cmd.number);
      const started = events.find((e) => e.type === EVENT_TYPES.itemStarted);
      const base = { at, projectId: project.id, itemNumber: cmd.number, agentRole: cmd.agentRole, agentName: cmd.agentName, source: SOURCE };
      const lines = [];
      if (registered) lines.push(t('done.projectRegistered', { project: project.id, company: project.company_name, remote }));
      if (cmd.kind === 'start') {
        if (started) throw new InvalidData('errors.itemAlreadyStarted', { key, ref, at: started.at, number: cmd.number });
        store.appendEvent({ ...base, type: EVENT_TYPES.itemStarted, payload: { title: cmd.title, stage } });
        lines.push(t('done.itemStarted', { key, ref, stage }));
      } else if (cmd.kind !== 'stage') {
        lines.push(recordDelivery(store, cmd, { project, events, base, key, ref }));
      } else {
        if (!started) throw new InvalidData('errors.itemNotStarted', { key, ref, number: cmd.number });
        store.appendEvent({ ...base, type: EVENT_TYPES.stageChanged, payload: { stage } });
        lines.push(t('done.stageChanged', { key, ref, stage }));
      }
      return lines;
    });
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
    process.stderr.write(`${t('errors.prefix', { message: invalid ? e.message : t('errors.unexpected', { detail: e && e.message ? e.message : String(e) }) })}\n`);
    process.exitCode = invalid ? 2 : 1;
  }
}

module.exports = { run };
