// Test mode (?mock=1): reads tests/mock-items.json (written by tests/generate-mock-items.js with the server's own code:
// the projection, the APIs, the usage collector and the health) and imitates every route the page calls: /api/state
// and POST /api/recalculate, the companies and projects routes (#6, POST /api/projects/<id>/company in memory),
// /api/items, /api/items/<project>/<number> (and POST .../merged in memory), /api/pending-decisions, /api/log,
// /api/log/<id> (the raw commands are made up on the spot), /api/overview, /api/usage and /api/agents, answering in the
// API shape (English fields and codes), as the real server does. Items, pending decisions, the Log, the Overview, usage
// and agents take ?company=<id> (the company selector of the header) like the server.
// Serve with "npm run demo" and open http://127.0.0.1:4795/?mock=1 (or use npm run dev in panel/ui).
import { t } from '../i18n/index.js';
import { arr, obj, spDay, txt, now } from './format.js';

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

/**
 * /api/pending-decisions from tests/mock-items.json (the unfiltered answer, already in the server's order), with the
 * server's filters (company, project, severity, status: comma-separated lists) and counts (each facet without its own filter).
 */
function mockPendingDecisions(m, sp) {
  const all = obj(m.pending_decisions) || {};
  const set = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)) : null);
  const f = { company: set('company'), project: set('project'), severity: set('severity'), status: set('status') };
  const passes = (p, skip) => (!f.company || f.company.has(p.item.project.company.id)) && (!f.project || f.project.has(p.item.project.id))
    && (skip === 'severity' || !f.severity || f.severity.has(p.severity)) && (skip === 'status' || !f.status || f.status.has(p.status));
  const list = arr(all.pending_decisions);
  const counts = { status: { open: 0, resolved: 0, canceled: 0 }, severity: { critical: 0, high: 0, normal: 0, low: 0 } };
  for (const p of list) {
    if (passes(p, 'status')) counts.status[p.status]++;
    if (passes(p, 'severity')) counts.severity[p.severity]++;
  }
  return { pending_decisions: list.filter((p) => passes(p)), counts, companies: arr(all.companies) };
}

/**
 * Companies and projects (#6) from tests/mock-items.json: GET /api/companies, GET /api/projects[?company=] and
 * POST /api/projects/<id>/company, which moves the project only in this page's memory. null for any other path.
 */
async function mockCompanies(u, method, body) {
  const p = u.pathname;
  const move = /^\/api\/projects\/([^/]+)\/company$/.exec(p);
  if (p !== '/api/companies' && p !== '/api/projects' && !move) return null;
  const m = await loadMockItems();
  const companies = arr(m.companies);
  const projects = arr(m.projects);
  if (p === '/api/companies') {
    return { companies: companies.map((c) => {
      const own = projects.filter((x) => x.company.id === c.id);
      return { ...c, project_count: own.length, item_count: own.reduce((n, x) => n + (Number(x.item_count) || 0), 0) };
    }) };
  }
  if (p === '/api/projects') {
    const company = u.searchParams.get('company');
    return { projects: projects.filter((x) => !company || x.company.id === company) };
  }
  if (method !== 'POST') throw error('method_not_allowed', 405, { method, allowed: ['POST'] });
  const id = decodeURIComponent(move[1]);
  const project = projects.find((x) => x.id === id);
  if (!project) throw error('project_not_found', 404, { project: id });
  const target = companies.find((c) => c.id === (obj(body) && body.company));
  if (!target) throw error('company_not_found', 400, { company: txt(obj(body) && body.company) });
  project.company = { id: target.id, name: target.name };
  project.unassigned = !!target.unassigned;
  for (const it of arr(m.items)) if (it.project.id === id) it.project.company = { ...project.company };
  for (const d of Object.values(obj(m.details) || {})) if (d.project.id === id) d.project.company = { ...project.company };
  for (const x of arr(obj(m.pending_decisions) && m.pending_decisions.pending_decisions)) if (x.item.project.id === id) x.item.project.company = { ...project.company };
  return { project };
}

/**
 * /api/items[?company=&project=&stage=&tracker=], /api/items/<project>/<number>, POST /api/items/<project>/<number>/merged and
 * /api/pending-decisions[?company=&...] from tests/mock-items.json; null for any other path.
 */
async function mockItems(u, method) {
  const p = u.pathname;
  const sp = u.searchParams;
  const merged = /^\/api\/items\/([^/]+)\/([^/]+)\/merged$/.exec(p);
  if (merged && method === 'POST') return mockMarkMerged(decodeURIComponent(merged[1]), Number(merged[2]));
  if (p === '/api/items') {
    const m = await loadMockItems();
    const [company, project, stage, tracker] = ['company', 'project', 'stage', 'tracker'].map((k) => sp.get(k));
    return { items: arr(m.items).filter((it) => (!company || it.project.company.id === company) && (!project || it.project.id === project)
      && (!stage || it.stage === stage) && (!tracker || it.tracker === tracker)) };
  }
  if (p === '/api/pending-decisions') return mockPendingDecisions(await loadMockItems(), sp);
  if (p === '/api/overview') {
    // Overview (#14): the generator wrote the answer of every company of the selector ('' = all).
    const all = obj((await loadMockItems()).overview) || {};
    const answer = all[sp.get('company') || ''];
    if (!answer) throw error('invalid_filter', 400, { param: 'company', value: sp.get('company') });
    return JSON.parse(JSON.stringify(answer));
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
    'hml-recorded': `hml ${n}`, 'item-done': `item done ${n}`, 'pending-decision-opened': `pending open ${n}`,
    'pending-decision-resolved': `pending resolve P-${(ev.payload || {}).pending_decision}`,
    'pending-decision-canceled': `pending cancel P-${(ev.payload || {}).pending_decision}`,
    'task-report': `report --item ${n} --task ${task} --json - < relatorio.json`,
    'finding-recorded': `finding add ${n} --title "…"`,
    'finding-linked': `finding link ${n} ${(ev.payload || {}).finding} --new-task ${((ev.payload || {}).new_task || {}).number}`,
  }[ev.type] || `stage ${n}`;
  // A file edit (sizes as codes in info, like the hook writes them), then the tests and the flow command.
  const commands = [
    { tool: 'Edit', input: 'src/relatorio.js', output_summary: null, info: { input: { code: 'raw_edit', from: 120, to: 180, all: false }, output: { code: 'raw_file_edited', added: 4, removed: 2, all: false } } },
    { tool: 'Bash', input: 'npm test', output_summary: 'ok', info: null },
    { tool: 'Bash', input: `node bin/flow.js ${flowCommand}`, output_summary: 'ok', info: null },
  ];
  return commands.map((c, i) => ({
    id: ev.id * 10 + i, at: new Date(Math.max(start + 1000, tEv - (commands.length - 1 - i) * 90000 + (i === commands.length - 1 ? 5000 : 0))).toISOString(),
    session: `mock-${ev.project.id}-${ev.item_number}`, project_id: ev.project.id, item_number: ev.item_number, task_number: ev.task_number,
    branch, hook_event: 'PostToolUse', ok: true, error: null, duration_ms: null, prompt: null,
    detail: null, agent_id: null, agent_type: null, version: null, ...c,
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

/** "Mark as merged" (#11) in the mock: changes the item in memory only (like the server: only a ready PR). */
async function mockMarkMerged(project, number) {
  const m = await loadMockItems();
  const key = `${project}/${number}`;
  const item = obj(m.details) && m.details[key];
  if (!item) throw error('item_not_found', 404, { project, number });
  const pr = obj(item.pr);
  if (!pr || pr.state !== 'ready') throw error('pr_not_ready', 409, { project, number, state: pr ? pr.state : null });
  const at = new Date().toISOString();
  pr.state = 'merged';
  pr.merged_at = at;
  item.merge_check = null;
  if (arr(item.stages).some((s) => s.id === 'merge')) {
    item.stage = 'merge';
    item.stage_since = at;
    const current = item.stages.findIndex((s) => s.id === 'merge');
    item.stages = item.stages.map((s, i) => ({ ...s, status: i < current ? 'done' : i === current ? 'current' : 'pending', entered_at: i === current ? at : i < current ? s.entered_at : null }));
  }
  item.timeline = [...arr(item.timeline), { id: Date.now(), at, type: 'pr-changed', task_number: null, agent: { role: 'owner', name: null }, source: 'panel', payload: { state: 'merged' } }];
  const listed = arr(m.items).find((it) => it.key === key);
  if (listed) Object.assign(listed, { stage: item.stage, stage_since: item.stage_since, updated_at: at });
  item.updated_at = at;
  return { item };
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

function error(code, status, params = {}) {
  const e = new Error(code);
  e.status = status;
  e.error = { code, ...params };
  return e;
}

/** /api/state and POST /api/recalculate: the answer the generator built with the server's own stateAnswer(). */
async function mockState(p, method) {
  if (p !== '/api/state' && !(p === '/api/recalculate' && method === 'POST')) return null;
  const answer = JSON.parse(JSON.stringify(obj((await loadMockItems()).state) || {}));
  if (p === '/api/recalculate') answer.recalculation = { ok: true, duration_ms: 42, error: null };
  return answer;
}

export async function mockApi(urlPath, method, body) {
  const u = new URL(urlPath, location.href);
  const p = u.pathname;
  const state = await mockState(p, method);
  if (state) return state;
  const companies = await mockCompanies(u, method, body);
  if (companies) return companies;
  const usage = await mockUsage(p, u.searchParams);
  if (usage) return usage;
  const items = await mockItems(u, method);
  if (items) return items;
  const log = await mockLog(p, u.searchParams);
  if (log) return log;
  throw error('route_not_found', 404);
}
