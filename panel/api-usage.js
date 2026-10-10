'use strict';
// api-usage.js · usage and agents per item (#13).
//
//   GET /api/usage?company=&project=
//     → { collected_at, reason, plan, periods, totals, note, formula, source, collection, warnings, collector,
//         by_item:  { window_5h | today | 7d: [ItemUsage] },
//         by_agent: { window_5h | today | 7d: [AgentUsage] } }
//     ItemUsage  = { key: '<project>/<n>' | '<project>/-', project: {id, name, tracker, company: {id, name}},
//                    item: {key, number, tracker_ref, title, stage, active} | null (sessions without item), ...Sums }
//     AgentUsage = { key: '<project>/<n>/maestro' | '<project>/<n>/task-<t>' | '<project>/-/other',
//                    role: 'maestro' | 'worker' | 'other', name, project, item, task: {number, title, state, floor} | null,
//                    ...Sums }
//     Sums = { input, output, cache_write, cache_read, messages, relative_consumption, consumption_pct,
//              estimated_plan_pct, plan_week_consumption_pct? (7d) }
//     The sums come from state/usage.json (bin/collect-usage.js); the names, titles and companies from maestro.db
//     (the projection, on every request). The percentages are always of the whole account: the company and project
//     filters only choose the lines. reason: null, {code: 'collector_not_run'} or {code: 'usage_unreadable', ...}.
//
//   GET /api/agents?company=&project=
//     → { agents: [Agent], counts: { maestro, worker } }
//     Agent = { key, role: 'maestro' | 'worker', name, project, item, task: TaskInfo | null, active_tasks (maestro),
//               last_event: {id, at, type, task_number, agent, payload} | null, last_activity_at, usage }
//     No fixed registry: the maestro of every active item (not Done) and the worker of every task being worked on
//     (working, review or blocked), derived from the items' events. last_activity_at is the last time the hook saw a
//     session of that agent (bruto.db); usage is its line in each period of usage.json (or null).
//
// No sentences: an invalid filter is {code: 'invalid_param', param, value, expected: 'id'} (ADR 0004).
const path = require('path');

const { trackerRef } = require(path.join(__dirname, '..', 'bin', 'flow-projection.js'));
const { projectInfo } = require(path.join(__dirname, 'api-items.js'));

const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PERIODS = ['window_5h', 'today', '7d'];
const WORKING = new Set(['working', 'review', 'blocked']);

class UsageApiError extends Error {
  constructor(status, error) {
    super(error.code);
    this.status = status;
    this.error = error;
  }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** { company, project }: Sets of ids (comma-separated in the query) or null. */
function filtersOf(query) {
  const out = {};
  for (const param of ['company', 'project']) {
    const raw = (query && typeof query.get === 'function' ? query.get(param) : null) || '';
    const values = [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))];
    for (const value of values) if (!RE_ID.test(value)) throw new UsageApiError(400, { code: 'invalid_param', param, value: value.slice(0, 40), expected: 'id' });
    out[param] = values.length ? new Set(values) : null;
  }
  return out;
}

const passes = (f, project) => (!f.company || (project.company && f.company.has(project.company.id))) && (!f.project || f.project.has(project.id));

/** Every item of maestro.db with its state and events: { projects: Map, items: Map('<project>/<n>' → {...}) }. */
function itemsOf(source) {
  const store = source.store();
  const projects = new Map();
  if (!store) return { projects, items: new Map() };
  for (const p of store.projects()) projects.set(p.id, p);
  return { projects, items: store.projectedItems() };
}

function itemInfo(it) {
  return {
    key: it.key, number: it.state.number, tracker_ref: trackerRef(it.project.tracker, it.state.number), title: it.state.title,
    stage: it.state.stage, active: it.state.active,
  };
}

function taskInfo(task) {
  return {
    number: task.number, title: task.title, state: task.state, floor: task.floor, branch: task.branch, status_text: task.status_text,
    progress: task.progress, updated_at: task.updated_at,
  };
}

/** The maestro's name: the last one who recorded an event of the item as maestro. */
function maestroName(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = events[i].agent;
    if (a && a.role === 'maestro' && a.name) return a.name;
  }
  return null;
}

/** Project, item and task of a usage line (the item may be gone from maestro.db: then only its number). */
function lineContext(line, ctx) {
  const p = ctx.projects.get(line.project_id);
  const project = p ? projectInfo(p) : { id: String(line.project_id), name: String(line.project_id), tracker: null, company: null };
  const number = Number.isInteger(line.item_number) ? line.item_number : null;
  const it = number === null ? null : ctx.items.get(`${line.project_id}/${number}`);
  let item = null;
  if (it) item = itemInfo(it);
  else if (number !== null) {
    item = { key: `${line.project_id}/${number}`, number, tracker_ref: p ? trackerRef(p.tracker, number) : `#${number}`, title: null, stage: null, active: null };
  }
  return { project, it, item };
}

const SUM_FIELDS = ['input', 'output', 'cache_write', 'cache_read', 'messages', 'relative_consumption', 'consumption_pct', 'estimated_plan_pct', 'plan_week_consumption_pct'];
function sums(line) {
  const out = {};
  for (const k of SUM_FIELDS) if (line[k] !== undefined) out[k] = line[k];
  return out;
}

function itemLine(line, ctx) {
  const { project, item } = lineContext(line, ctx);
  return { key: String(line.key), project, item, ...sums(line) };
}

function agentLine(line, ctx) {
  const { project, it, item } = lineContext(line, ctx);
  const role = ['maestro', 'worker'].includes(line.role) ? line.role : 'other';
  let task = null;
  let name = null;
  if (role === 'worker' && Number.isInteger(line.task_number)) {
    const t = it && it.state.tasks.find((x) => x.number === line.task_number);
    task = t ? taskInfo(t) : { number: line.task_number, title: null, state: null, floor: null, branch: null, status_text: null, progress: null, updated_at: null };
    name = t ? t.worker : null;
  } else if (role === 'maestro') {
    name = it ? maestroName(it.events) : null;
  }
  return { key: String(line.key), role, name, project, item, task, ...sums(line) };
}

const emptyLists = () => Object.fromEntries(PERIODS.map((p) => [p, []]));

/**
 * GET /api/usage. usageFile: {exists, data, error} of state/usage.json; options.plan(plan) checks the plan against
 * the clock (server.js planNow); options.collector: the collector's state ({interval_min, active, last, running}).
 */
function usageAnswer(source, usageFile, query, { plan = (p) => p, collector = null } = {}) {
  const f = filtersOf(query);
  const usage = obj(usageFile && usageFile.data);
  const answer = {
    collected_at: null, reason: null, plan: null, periods: null, totals: null, note: null, formula: null, source: null,
    collection: null, warnings: [], collector, by_item: emptyLists(), by_agent: emptyLists(),
  };
  if (!usage) {
    answer.reason = usageFile && usageFile.exists
      ? { code: 'usage_unreadable', file: 'state/usage.json', error: (usageFile && usageFile.error) || { code: 'unexpected_format' } }
      : { code: 'collector_not_run' };
    return answer;
  }
  for (const k of ['collected_at', 'periods', 'totals', 'note', 'formula', 'source', 'collection']) answer[k] = usage[k] === undefined ? null : usage[k];
  answer.plan = obj(usage.plan) ? plan(usage.plan) : null;
  answer.warnings = Array.isArray(usage.warnings) ? usage.warnings.filter(obj) : [];
  const ctx = itemsOf(source);
  for (const [list, build] of [['by_item', itemLine], ['by_agent', agentLine]]) {
    const lists = obj(usage[list]) || {};
    for (const period of PERIODS) {
      answer[list][period] = (Array.isArray(lists[period]) ? lists[period] : [])
        .filter((l) => obj(l) && typeof l.key === 'string' && typeof l.project_id === 'string')
        .map((l) => build(l, ctx))
        .filter((l) => passes(f, l.project));
    }
  }
  return answer;
}

// ---------- GET /api/agents ----------

function eventEntry(e) {
  return e ? { id: e.id, at: e.at, type: e.type, task_number: e.task_number, agent: e.agent, payload: e.payload } : null;
}

/** The maestro's last event: the last one it recorded (as maestro) or, without any, the item's last own event. */
function maestroEvent(events) {
  let own = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.agent && e.agent.role === 'maestro') return e;
    if (!own && e.task_number === null) own = e;
  }
  return own;
}

function taskEvent(events, number) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].task_number === number) return events[i];
  return null;
}

/** Last moment the hook saw each agent: Map(agent key → ISO), from the sessions of bruto.db. */
function lastActivity(raw, items) {
  const out = new Map();
  const store = raw && raw.store();
  if (!store) return out;
  // A task's item may be missing in the session (the task was not in maestro.db yet): the items know it.
  const itemOfTask = new Map();
  for (const it of items.values()) for (const t of it.state.tasks) itemOfTask.set(`${it.project.id}/${t.number}`, it.state.number);
  for (const s of store.sessions()) {
    let key;
    if (s.task_number !== null) {
      const item = s.item_number !== null ? s.item_number : itemOfTask.get(`${s.project_id}/${s.task_number}`);
      if (item === undefined || item === null) continue;
      key = `${s.project_id}/${item}/task-${s.task_number}`;
    } else if (s.item_number !== null) key = `${s.project_id}/${s.item_number}/maestro`;
    else continue;
    if (!out.has(key) || Date.parse(s.seen_at) > Date.parse(out.get(key))) out.set(key, s.seen_at);
  }
  return out;
}

/** Each agent's line in each period of usage.json: Map(key → { window_5h, today, 7d }). */
function usageByAgent(usageFile) {
  const out = new Map();
  const lists = obj(obj(usageFile && usageFile.data) && usageFile.data.by_agent);
  if (!lists) return out;
  for (const period of PERIODS) {
    for (const l of Array.isArray(lists[period]) ? lists[period] : []) {
      if (!obj(l) || typeof l.key !== 'string') continue;
      if (!out.has(l.key)) out.set(l.key, Object.fromEntries(PERIODS.map((p) => [p, null])));
      out.get(l.key)[period] = { consumption_pct: l.consumption_pct, estimated_plan_pct: l.estimated_plan_pct, relative_consumption: l.relative_consumption };
    }
  }
  return out;
}

/** GET /api/agents. source: the items source (maestro.db); raw: the raw log source (bruto.db); usageFile: usage.json. */
function listAgents(source, raw, usageFile, query) {
  const f = filtersOf(query);
  const { items } = itemsOf(source);
  const active = [...items.values()]
    .filter((it) => it.state.active && passes(f, projectInfo(it.project)))
    .sort((a, b) => Date.parse(b.state.updated_at) - Date.parse(a.state.updated_at) || a.key.localeCompare(b.key));
  const seen = lastActivity(raw, items);
  const usage = usageByAgent(usageFile);
  const agents = [];
  const counts = { maestro: 0, worker: 0 };
  const agent = (key, fields) => {
    counts[fields.role]++;
    agents.push({ key, ...fields, last_activity_at: seen.get(key) || null, usage: usage.get(key) || null });
  };
  for (const it of active) {
    const project = projectInfo(it.project);
    const item = itemInfo(it);
    const working = it.state.tasks.filter((t) => WORKING.has(t.state));
    agent(`${it.key}/maestro`, {
      role: 'maestro', name: maestroName(it.events), project, item, task: null, active_tasks: working.length,
      last_event: eventEntry(maestroEvent(it.events)),
    });
    for (const t of working) {
      agent(`${it.key}/task-${t.number}`, {
        role: 'worker', name: t.worker, project, item, task: taskInfo(t), active_tasks: null, last_event: eventEntry(taskEvent(it.events, t.number)),
      });
    }
  }
  return { agents, counts };
}

module.exports = { usageAnswer, listAgents, UsageApiError };
