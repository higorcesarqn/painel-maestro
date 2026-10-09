// Test mode (?mock=1): reads tests/mock-*.json and imitates /api/state, /api/events, /api/event, /api/flow and the
// new model's /api/items, /api/items/<project>/<number>, /api/log and /api/log/<id> (tests/mock-items.json, written
// by tests/generate-mock-items.js with the real projection; the Log's raw commands are made up on the spot), and the
// usage and agents per item (#13: /api/usage and /api/agents, written by the real collector and API),
// answering in the API shape (English fields and codes), as the real server does.
// Serve with "node tests/serve-mock.js" and open http://127.0.0.1:4795/?mock=1 (or use npm run dev).
import { t } from '../i18n/index.js';
import { arr, obj, spDay, normalize, txt, now } from './format.js';

const OWNER_RESULTS = new Set(['falhou', 'bloqueado', 'aguardando-dono']);
const needsOwner = (e) => !!(e && (e.needs_owner === true || OWNER_RESULTS.has(e.result)));

let load = null;
function loadMock() {
  if (!load) {
    const get = (name) => fetch(`tests/${name}`, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`tests/${name}: ${r.status}`);
      return r.json();
    });
    load = Promise.all([get('mock-state.json'), get('mock-details.json').catch(() => null)])
      .then(([state, det]) => ({ state, det: det || { events: arr(state.events), raw_commands: [], flows: {} } }))
      .catch((e) => {
        load = null;
        throw new Error(t('mock.loadFailed', { detail: e.message }));
      });
  }
  return load;
}

const TABLE_FIELDS = ['id', 'ts', 'agent', 'project', 'summary', 'direction', 'result', 'type', 'flow_id', 'needs_owner', 'origin', 'test'];

let loadItems = null;
function loadMockItems() {
  if (!loadItems) {
    loadItems = fetch('tests/mock-items.json', { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`tests/mock-items.json: ${r.status}`);
      return r.json();
    }).catch((e) => {
      loadItems = null;
      throw new Error(t('mock.loadFailed', { detail: e.message }));
    });
  }
  return loadItems;
}

/** /api/items and /api/items/<project>/<number> from tests/mock-items.json; null for any other path. */
async function mockItems(p) {
  if (p === '/api/items') {
    const m = await loadMockItems();
    return { items: arr(m.items) };
  }
  const x = /^\/api\/items\/([^/]+)\/([^/]+)$/.exec(p);
  if (!x) return null;
  const m = await loadMockItems();
  const project = decodeURIComponent(x[1]);
  const number = Number(x[2]);
  const item = obj(m.details) && m.details[`${project}/${number}`];
  if (!item) throw error('item_not_found', 404, { project, number });
  return { item };
}

/** Events of the Log (new model) from the item timelines of tests/mock-items.json, newest first. */
function logEvents(m) {
  const out = [];
  for (const it of Object.values(obj(m.details) || {})) {
    for (const e of arr(it.timeline)) {
      out.push({
        id: e.id, at: e.at, type: e.type, project: it.project, item_number: it.number, item_key: it.key, item_title: it.title,
        tracker_ref: it.tracker_ref, task_number: e.task_number ?? null, agent: e.agent, source: e.source, payload: e.payload,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id);
}

/** A few made-up raw commands before each event (the mock has no bruto.db): the maestro working on the item. */
function mockRaw(ev, start) {
  const branch = ev.task_number === null ? `feature/issue-${ev.item_number}` : `task/${ev.task_number}`;
  const tEv = Date.parse(ev.at);
  const n = ev.item_number; const task = ev.task_number ?? n;
  const flowCommand = {
    'item-started': `item start ${n}`, 'stage-changed': `stage ${n}`, 'task-graph': `task graph ${n}`, 'task-dispatched': `task dispatch ${n} ${task}`,
    'task-status': 'status "…"', 'task-integrated': `task integrate ${n} ${task}`, 'pr-changed': `pr ${n}`,
    'final-adjustment-opened': `final-adjustment ${n} open`, 'final-adjustment-finished': `final-adjustment ${n} result`,
    'hml-recorded': `hml ${n}`, 'item-done': `item done ${n}`,
  }[ev.type] || `stage ${n}`;
  const commands = ['git status --short', 'npm test', `node bin/flow.js ${flowCommand}`];
  return commands.map((input, i) => ({
    id: ev.id * 10 + i, at: new Date(Math.max(start + 1000, tEv - (commands.length - 1 - i) * 90000 + (i === commands.length - 1 ? 5000 : 0))).toISOString(),
    session: `mock-${ev.project.id}-${ev.item_number}`, project_id: ev.project.id, item_number: ev.item_number, task_number: ev.task_number,
    branch, hook_event: 'PostToolUse', tool: 'Bash', input, ok: true, output_summary: 'ok', error: null, duration_ms: null, prompt: null,
    detail: null, agent_id: null, agent_type: null, version: null,
  }));
}

/** /api/log and /api/log/<id> like the server: filters, counts where each facet ignores its own filter, the raw link. */
async function mockLog(p, sp) {
  if (p !== '/api/log' && !/^\/api\/log\/\d+$/.test(p)) return null;
  const all = logEvents(await loadMockItems());
  const m = /^\/api\/log\/(\d+)$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    const ev = all.find((e) => e.id === id);
    if (!ev) throw error('event_not_found', 404, { id });
    const previous = all.find((e) => e.item_key === ev.item_key && e.task_number === ev.task_number && e.id < ev.id);
    const start = Math.max(previous ? Date.parse(previous.at) : 0, Date.parse(ev.at) - 6 * 3600000);
    const raw = mockRaw(ev, start);
    return {
      event: ev, item: { key: ev.item_key, title: ev.item_title, tracker_ref: ev.tracker_ref, stage: ev.type === 'stage-changed' ? ev.payload.stage : 'specification' },
      raw_commands: raw, raw_commands_total: raw.length, raw_commands_truncated: false,
      raw_link: { by: ev.task_number === null ? 'item' : 'task', item_number: ev.item_number, task_number: ev.task_number, start: new Date(start).toISOString(), end: new Date(Date.parse(ev.at) + 60000).toISOString() },
    };
  }
  const list = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((x) => x.trim()).filter(Boolean)) : null);
  const co = list('company'); const pj = list('project'); const ty = list('type'); const item = sp.get('item') || '';
  const since = sp.get('since'); const until = sp.get('until');
  const hours = Number(sp.get('hours')) || 0; const sinceT = hours > 0 ? now() - hours * 3600000 : null;
  const groups = { company: new Map(), project: new Map(), type: new Map() };
  const count = (g, k) => { if (k) g.set(k, (g.get(k) || 0) + 1); };
  const f = all.filter((e) => {
    const d = spDay(e.at);
    if ((since && d < since) || (until && d > until) || (sinceT !== null && !(Date.parse(e.at) >= sinceT)) || (item && e.item_key !== item)) return false;
    const company = e.project.company && e.project.company.id;
    const okCo = !co || co.has(company); const okPj = !pj || pj.has(e.project.id); const okTy = !ty || ty.has(e.type);
    if (okPj && okTy) count(groups.company, company);
    if (okCo && okTy) count(groups.project, e.project.id);
    if (okCo && okPj) count(groups.type, e.type);
    return okCo && okPj && okTy;
  });
  const pg = Math.max(1, Number(sp.get('page')) || 1); const pp = Math.max(1, Number(sp.get('per_page')) || 50);
  return {
    total: f.length, page: pg, per_page: pp, pages: Math.max(1, Math.ceil(f.length / pp)), events: f.slice((pg - 1) * pp, pg * pp),
    counts: { company: Object.fromEntries(groups.company), project: Object.fromEntries(groups.project), type: Object.fromEntries(groups.type) },
    raw_last_at: all.length ? all[0].at : null,
  };
}

/**
 * /api/usage and /api/agents (#13) from tests/mock-items.json (written by the real collector and API), with the
 * server's company and project filters: they only choose the lines. null for any other path.
 */
async function mockUsage(p, sp) {
  if (p !== '/api/usage' && p !== '/api/agents') return null;
  const m = await loadMockItems();
  const set = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((x) => x.trim()).filter(Boolean)) : null);
  const co = set('company'); const pj = set('project');
  const passes = (x) => { const pr = obj(x.project) || {}; return (!co || (obj(pr.company) && co.has(pr.company.id))) && (!pj || pj.has(pr.id)); };
  if (p === '/api/agents') {
    const agents = arr(obj(m.agents) && m.agents.agents).filter(passes);
    return { agents, counts: { maestro: agents.filter((a) => a.role === 'maestro').length, worker: agents.filter((a) => a.role === 'worker').length } };
  }
  const u = JSON.parse(JSON.stringify(obj(m.usage) || {}));
  for (const list of ['by_item', 'by_agent']) for (const [period, lines] of Object.entries(obj(u[list]) || {})) u[list][period] = arr(lines).filter(passes);
  return u;
}

function tableFields(e) {
  const r = {};
  for (const k of TABLE_FIELDS) if (e[k] !== undefined) r[k] = e[k];
  return r;
}
function error(code, status, params = {}) {
  const e = new Error(code);
  e.status = status;
  e.error = { code, ...params };
  return e;
}

export async function mockApi(urlPath, method) {
  const u = new URL(urlPath, location.href);
  const p = u.pathname;
  const items = await mockItems(p);
  if (items) return items;
  const log = await mockLog(p, u.searchParams);
  if (log) return log;
  const usage = await mockUsage(p, u.searchParams);
  if (usage) return usage;
  const { state, det } = await loadMock();
  const sp = u.searchParams;
  const evs = arr(det.events).slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const asc = evs.slice().reverse();
  if (p === '/api/state' || (p === '/api/recalculate' && method === 'POST')) return JSON.parse(JSON.stringify(state));
  if (p === '/api/events') {
    // Like the server: hours=N, many comma-separated values and counts where each facet ignores its own filter.
    const set = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((x) => x.trim()).filter(Boolean)) : null);
    const ag = set('agent'); const ty = set('type'); const rs = set('result');
    const pj = sp.get('project') ? new Set(sp.get('project').split(',').map((x) => x.trim().toLowerCase())) : null;
    const terms = normalize(sp.get('q') || '').split(/\s+/).filter(Boolean);
    const since = sp.get('since'); const until = sp.get('until'); const flow = sp.get('flow');
    const hours = Number(sp.get('hours')) || 0; const sinceT = hours > 0 ? now() - hours * 3600000 : null;
    const tests = sp.get('include_tests') === '1'; const ownerOnly = sp.get('owner_only') === '1';
    const groups = { result: new Map(), agent: new Map(), project: new Map(), type: new Map() };
    const count = (g, k) => { if (typeof k === 'string' && k) g.set(k, (g.get(k) || 0) + 1); };
    let needs = 0;
    const f = evs.filter((e) => {
      if (!tests && e.test === true) return false;
      const d = spDay(e.ts);
      if (since && d < since) return false;
      if (until && d > until) return false;
      if (sinceT !== null && !(Date.parse(e.ts) >= sinceT)) return false;
      if (flow && e.flow_id !== flow) return false;
      if (terms.length) {
        const hay = normalize([e.summary, e.direction, e.flow_id].map(txt).join(' '));
        if (!terms.every((x) => hay.includes(x))) return false;
      }
      const proj = String(e.project || '');
      const okAg = !ag || ag.has(e.agent); const okPr = !pj || pj.has(proj.toLowerCase());
      const okTy = !ty || ty.has(e.type); const okRe = !rs || rs.has(e.result); const okOw = !ownerOnly || needsOwner(e);
      if (okPr && okTy && okRe && okOw) count(groups.agent, e.agent);
      if (okAg && okTy && okRe && okOw) count(groups.project, proj.toUpperCase());
      if (okAg && okPr && okRe && okOw) count(groups.type, e.type);
      if (okAg && okPr && okTy && okOw) count(groups.result, e.result);
      if (okAg && okPr && okTy && okRe && needsOwner(e)) needs++;
      return okAg && okPr && okTy && okRe && okOw;
    });
    const pg = Math.max(1, Number(sp.get('page')) || 1); const pp = Math.max(1, Number(sp.get('per_page')) || 50);
    const counts = {
      result: Object.fromEntries(groups.result), agent: Object.fromEntries(groups.agent),
      project: Object.fromEntries(groups.project), type: Object.fromEntries(groups.type), needs_owner: needs,
    };
    return { total: f.length, page: pg, per_page: pp, pages: Math.max(1, Math.ceil(f.length / pp)), events: f.slice((pg - 1) * pp, pg * pp).map(tableFields), counts };
  }
  const raw = arr(det.raw_commands).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const flowInfo = (id, list) => {
    const r = obj(det.flows) && det.flows[id];
    if (!r && !list.length) return null;
    return { id, title: (r && r.title) || null, created_at: (r && r.created_at) || (list[0] && list[0].ts) || null, agent: (r && r.agent) || null };
  };
  const requestOf = (list, id) => {
    const ev = list.find((e) => e.type === 'pedido-recebido') || list.find((e) => e.original_type === 'pedido-recebido');
    if (ev) return { text: ev.request || ev.text || ev.summary, origin: ev.origin || null, ts: ev.ts, agent: ev.agent, source: 'event' };
    const b = raw.find((x) => typeof x.prompt === 'string' && id && x.prompt.includes(id));
    return b ? { text: b.prompt, origin: null, ts: b.ts, agent: b.agent, source: 'prompt', origin_inferred: true } : null;
  };
  const fmtCmd = (b, corr) => ({ ts: b.ts, agent: b.agent, hook_event: b.hook_event, tool: b.tool || null, input: b.input || null, ok: typeof b.ok === 'boolean' ? b.ok : null, session: b.session || null, flow_id: b.flow_id || null, correlation: corr, prompt: b.prompt, error: b.error });
  let m = /^\/api\/event\/(.+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const ev = evs.find((e) => e.id === id);
    if (!ev) throw error('event_not_found', 404, { id });
    const seq = ev.flow_id ? asc.filter((e) => e.flow_id === ev.flow_id && (ev.test === true || e.test !== true)) : [ev];
    const tEv = Date.parse(ev.ts);
    const previousOfAgent = asc.filter((e) => e.agent === ev.agent && Date.parse(e.ts) < tEv).pop();
    const start = previousOfAgent ? Date.parse(previousOfAgent.ts) : tEv - 2 * 3600000;
    const cmds = raw.filter((b) => (ev.flow_id && b.flow_id === ev.flow_id))
      .map((b) => fmtCmd(b, 'flow_id'))
      .concat(raw.filter((b) => !b.flow_id && b.agent === ev.agent && Date.parse(b.ts) > start && Date.parse(b.ts) <= tEv).map((b) => fmtCmd(b, 'window')))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const vis = asc.filter((e) => e.test !== true || ev.test === true);
    const i = vis.indexOf(ev);
    return {
      event: ev, flow: ev.flow_id ? flowInfo(ev.flow_id, seq) : null, initial_request: requestOf(seq, ev.flow_id),
      sequence: seq, raw_commands: cmds, raw_commands_truncated: false, raw_commands_omitted: 0, raw_commands_warnings: null,
      window_without_flow: { start: new Date(start).toISOString(), end: ev.ts, session: ev.session || null },
      previous_id: i > 0 ? vis[i - 1].id : null, next_id: i >= 0 && i < vis.length - 1 ? vis[i + 1].id : null,
    };
  }
  m = /^\/api\/flow\/(.+)$/.exec(p);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const list = asc.filter((e) => e.flow_id === id && e.test !== true);
    const fl = flowInfo(id, list);
    if (!fl) throw error('flow_not_found', 404, { id });
    return { flow: fl, events: list, raw_commands: raw.filter((b) => b.flow_id === id).map((b) => fmtCmd(b, 'flow_id')), raw_commands_truncated: false, raw_commands_omitted: 0, raw_commands_warnings: null, initial_request: requestOf(list, id) };
  }
  throw error('route_not_found', 404);
}
