'use strict';
// api-log.js · the Log of the new model (#12): the events of maestro.db with filters and, for one event, the raw
// commands of bruto.db linked to it. Also the raw log itself and its daily cleanup (90 days, ADR 0003).
//
//   GET /api/log?company=&project=&item=<project>/<n>&type=&since=&until=&hours=&page=&per_page=
//       → { total, page, per_page, pages, events: [LogEvent], counts: { company, project, type }, raw_last_at }
//   GET /api/log/<id>  → { event: LogEvent, item, raw_commands: [RawEntry], raw_commands_total, raw_commands_truncated,
//                          raw_link: { by: 'item' | 'task', item_number, task_number, start, end } }
//   GET /api/raw?project=&item=&task=&session=&limit=  → { total, entries: [RawEntry] }
//
// Link of an event to the raw log: the sessions whose branch points to the same task (an event of a task) or to
// the item's maestro (an event of the item itself, without task), in the window from the previous event of the same
// item and task (at most 6 h back) until one minute after the event (the hook writes the command that recorded the
// event right after it). No sentences: errors are codes (ADR 0004).
const path = require('path');

const { openStore, flowDir } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { openRawStore } = require(path.join(__dirname, '..', 'bin', 'raw-store.js'));
const { projectItem, trackerRef } = require(path.join(__dirname, '..', 'bin', 'flow-projection.js'));
const { isoSP } = require(path.join(__dirname, '..', 'bin', 'lib.js'));
const { projectInfo } = require(path.join(__dirname, 'api-items.js'));

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const WINDOW_MAX_MS = 6 * HOUR_MS;
const WINDOW_AFTER_MS = MIN_MS;
const COMMAND_LIMIT = 1500;
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RE_KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const RE_ITEM = /^([a-z0-9][a-z0-9-]{0,79})\/([1-9]\d{0,8})$/;
const RE_NUMBER = /^[1-9]\d{0,8}$/;
const RE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const RE_TYPE = /^[a-z][a-z0-9-]{0,59}$/;

class LogError extends Error {
  constructor(status, error) {
    super(error.code);
    this.status = status;
    this.error = error;
  }
}

/** Lazily opened bruto.db (null while it does not exist: the hook creates it, the server never does). */
function createRawSource(env) {
  const dir = flowDir(env);
  let store = null;
  return {
    dir,
    store() {
      if (!store) store = openRawStore({ dir, create: false });
      return store;
    },
    close() {
      if (store) store.close();
      store = null;
    },
  };
}

/**
 * Deletes what is older than the retention, in rounds of a few thousand entries with a pause between them (the
 * server keeps answering and the hook never waits long). Resolves { entries, sessions } deleted, or null without
 * bruto.db. stopped(): true ends it early (the server is stopping).
 */
async function purgeRaw(raw, nowMs, { stopped = () => false } = {}) {
  const store = raw.store();
  if (!store) return null;
  const total = { entries: 0, sessions: 0 };
  for (;;) {
    const r = store.purge(nowMs);
    total.entries += r.entries;
    total.sessions += r.sessions;
    if (r.done || stopped()) return total;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------- parameters ----------

const invalid = (param, value, expected) => new LogError(400, { code: 'invalid_param', param, value: String(value).slice(0, 40), expected });

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

function day(sp, name) {
  const v = (sp.get(name) || '').trim();
  if (!v) return null;
  if (!RE_DAY.test(v) || addDays(v, 0) !== v) throw invalid(name, v, 'date');
  return v;
}

function integer(sp, name, fallback, max) {
  const v = (sp.get(name) || '').trim();
  if (!v) return fallback;
  if (!RE_NUMBER.test(v)) throw invalid(name, v, 'positive_integer');
  return Math.min(Number(v), max);
}

function list(sp, name, re) {
  const v = (sp.get(name) || '').trim();
  if (!v) return null;
  const values = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
  for (const x of values) if (!re.test(x)) throw invalid(name, x, 'id');
  return values.length ? values : null;
}

function logFilters(sp, nowMs) {
  const itemText = (sp.get('item') || '').trim();
  let item = null;
  if (itemText) {
    const m = RE_ITEM.exec(itemText);
    if (!m) throw invalid('item', itemText, 'item_key');
    item = { project: m[1], number: Number(m[2]) };
  }
  const since = day(sp, 'since');
  const until = day(sp, 'until');
  const hours = integer(sp, 'hours', null, 24 * 366);
  // Every "at" has the São Paulo offset: text comparison follows time. "until" is the whole day.
  let sinceAt = since;
  if (hours) {
    const h = isoSP(new Date(nowMs - hours * HOUR_MS));
    if (!sinceAt || h > sinceAt) sinceAt = h;
  }
  return {
    companies: list(sp, 'company', RE_KEY), projects: list(sp, 'project', RE_KEY), types: list(sp, 'type', RE_TYPE),
    item, since: sinceAt, until: until ? addDays(until, 1) : null,
    page: integer(sp, 'page', 1, 1e6), perPage: integer(sp, 'per_page', 50, 500),
  };
}

// ---------- answers ----------

/** Titles and stages of the items of a page (computed from their events, like the items API). */
function itemsOf(store, events, projects) {
  const out = new Map();
  for (const e of events) {
    const key = `${e.project_id}/${e.item_number}`;
    if (out.has(key)) continue;
    const project = projects.get(e.project_id);
    const state = project ? projectItem(store.itemEvents(e.project_id, e.item_number), project) : null;
    out.set(key, state ? { key, title: state.title, stage: state.stage, tracker_ref: trackerRef(project.tracker, e.item_number) } : null);
  }
  return out;
}

function logEvent(e, projects, items) {
  const project = projects.get(e.project_id);
  const key = `${e.project_id}/${e.item_number}`;
  const item = items.get(key);
  return {
    id: e.id, at: e.at, type: e.type,
    project: project ? projectInfo(project) : { id: e.project_id, name: e.project_id, tracker: null, company: null },
    item_number: e.item_number, item_key: key, item_title: item ? item.title : null,
    tracker_ref: project ? trackerRef(project.tracker, e.item_number) : `#${e.item_number}`,
    task_number: e.task_number, agent: e.agent, source: e.source, payload: e.payload,
  };
}

const EMPTY_COUNTS = { company: {}, project: {}, type: {} };

function listLog(source, raw, sp, nowMs) {
  const f = logFilters(sp, nowMs);
  const rawStore = raw.store();
  const rawLastAt = rawStore ? rawStore.lastAt() : null;
  const store = source.store();
  if (!store) return { total: 0, page: f.page, per_page: f.perPage, pages: 1, events: [], counts: EMPTY_COUNTS, raw_last_at: rawLastAt };
  const { total, events } = store.logEvents(f, { limit: f.perPage, offset: (f.page - 1) * f.perPage });
  const projects = new Map(store.projects().map((p) => [p.id, p]));
  const items = itemsOf(store, events, projects);
  return {
    total, page: f.page, per_page: f.perPage, pages: Math.max(1, Math.ceil(total / f.perPage)),
    events: events.map((e) => logEvent(e, projects, items)),
    counts: store.logCounts(f),
    raw_last_at: rawLastAt,
  };
}

/** The event with its raw commands, or null when the event does not exist. */
function logDetail(source, raw, id) {
  const store = source.store();
  if (!store) return null;
  const ev = store.event(id);
  if (!ev) return null;
  const projects = new Map(store.projects().map((p) => [p.id, p]));
  const items = itemsOf(store, [ev], projects);
  const t = Date.parse(ev.at);
  const previous = store.previousEvent(ev);
  const start = Math.max(previous ? Date.parse(previous.at) : -Infinity, t - WINDOW_MAX_MS);
  const end = t + WINDOW_AFTER_MS;
  const byTask = ev.task_number !== null;
  const link = { by: byTask ? 'task' : 'item', item_number: ev.item_number, task_number: ev.task_number, start: isoSP(new Date(start)), end: isoSP(new Date(end)) };
  const filter = byTask
    ? { project: ev.project_id, task: ev.task_number, start, end }
    : { project: ev.project_id, item: ev.item_number, task: null, start, end };
  const rawStore = raw.store();
  const found = rawStore ? rawStore.entries(filter, { limit: COMMAND_LIMIT }) : { total: 0, entries: [] };
  return {
    event: logEvent(ev, projects, items),
    item: items.get(`${ev.project_id}/${ev.item_number}`) || null,
    raw_commands: found.entries,
    raw_commands_total: found.total,
    raw_commands_truncated: found.total > found.entries.length,
    raw_link: link,
  };
}

/** The raw log itself, filtered: { total, entries } (the most recent ones, oldest first). */
function listRaw(raw, sp) {
  const f = {};
  const project = (sp.get('project') || '').trim();
  if (project) {
    if (!RE_KEY.test(project)) throw invalid('project', project, 'id');
    f.project = project;
  }
  for (const name of ['item', 'task']) {
    const v = (sp.get(name) || '').trim();
    if (v) f[name] = integer(sp, name, null, 1e9);
  }
  const session = (sp.get('session') || '').trim();
  if (session) {
    if (!RE_SESSION.test(session)) throw invalid('session', session, 'id');
    f.session = session;
  }
  const limit = integer(sp, 'limit', 200, COMMAND_LIMIT);
  const store = raw.store();
  return store ? store.entries(f, { limit }) : { total: 0, entries: [] };
}

/** Route of an event of the Log: its id or null. */
function parseLogId(text) {
  return RE_NUMBER.test(text) ? Number(text) : null;
}

module.exports = { createRawSource, purgeRaw, listLog, logDetail, listRaw, parseLogId, LogError };
