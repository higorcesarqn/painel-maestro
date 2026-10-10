// Test mode (?mock=1): reads tests/mock-items.json (written by tests/generate-mock-items.js with the server's own code:
// the projection, the APIs, the usage collector and the health) and imitates every route the page calls: /api/state
// and POST /api/recalculate, the organizations and projects routes (#6, POST /api/organizations, POST /api/organizations/<id>/rename,
// POST /api/organizations/<id>/remove and POST /api/projects/<id>/organization in memory),
// /api/items, /api/items/<project>/<number> (and POST .../merged in memory), /api/pending-decisions (and POST
// /api/pending-decisions/<id>/answer in memory, #32), /api/log,
// /api/log/<id> (the raw commands are made up on the spot), /api/overview, /api/usage and /api/agents, answering in the
// API shape (English fields and codes), as the real server does. Items, pending decisions, the Log, the Overview, usage
// and agents take ?organization=<id> (the organization selector of the header) like the server.
// Serve with "npm run demo" and open http://127.0.0.1:4795/?mock=1 (or use npm run dev in panel/ui).
import { t } from '../i18n/index.js';
import { LOCALE } from '../i18n/locale.js';
import { arr, obj, spDay, txt, now } from './format.js';
import { MAX_ORGANIZATION_NAME, RE_ID } from './organizations.js';
import { MAX_DECISION, optionLetters, decisionText } from './domain.js';

const UNASSIGNED = 'unassigned';

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
 * server's filters (organization, project, severity, status: comma-separated lists) and counts (each facet without its own filter).
 */
function mockPendingDecisions(m, sp) {
  const all = obj(m.pending_decisions) || {};
  const set = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)) : null);
  const f = { organization: set('organization'), project: set('project'), severity: set('severity'), status: set('status') };
  const passes = (p, skip) => (!f.organization || f.organization.has(p.item.project.organization.id)) && (!f.project || f.project.has(p.item.project.id))
    && (skip === 'severity' || !f.severity || f.severity.has(p.severity)) && (skip === 'status' || !f.status || f.status.has(p.status));
  const list = arr(all.pending_decisions);
  const counts = { status: { open: 0, resolved: 0, canceled: 0 }, severity: { critical: 0, high: 0, normal: 0, low: 0 } };
  for (const p of list) {
    if (passes(p, 'status')) counts.status[p.status]++;
    if (passes(p, 'severity')) counts.severity[p.severity]++;
  }
  return { pending_decisions: list.filter((p) => passes(p)), counts, organizations: arr(all.organizations) };
}

/**
 * The store's rule of an organization's name (organizationName in bin/flow-store.js): trimmed, 1 to 80 characters on one line and
 * unique ignoring case (and Unicode NFC) among the organizations other than exceptId, the name of "unassigned" (in the
 * demo's organizations) included. Returns the trimmed name.
 */
function mockOrganizationName(organizations, value, exceptId = null) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_ORGANIZATION_NAME || /[\r\n]/.test(name)) {
    throw error('invalid_field', 400, { field: 'name', value: String(value ?? '').slice(0, 100), max: MAX_ORGANIZATION_NAME });
  }
  const key = (s) => s.normalize('NFC').toLowerCase();
  const other = organizations.find((c) => c.id !== exceptId && key(c.name) === key(name));
  if (other) throw error('organization_name_taken', 409, { name, organization: other.id, organization_name: other.name });
  return name;
}

/** The server's order of the organizations: alphabetical, "unassigned" last. */
const sortOrganizations = (organizations) => organizations.sort((a, b) => Number(!!a.unassigned) - Number(!!b.unassigned) || a.name.localeCompare(b.name, LOCALE));

/**
 * POST /api/organizations (#22): creates the organization only in this page's memory, under the store's rules (addOrganization and
 * organizationName in bin/flow-store.js): the id's format, free id ("unassigned" is always taken), name trimmed, 1 to 80
 * characters on one line and unique ignoring case. Keeps the server's order (alphabetical, "unassigned" last).
 */
function mockCreateOrganization(organizations, body, summary) {
  if (!obj(body)) throw error('json_object_required', 400);
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!RE_ID.test(id)) throw error('invalid_field', 400, { field: 'id', value: String(body.id ?? '').slice(0, 100) });
  const existing = organizations.find((c) => c.id === id);
  if (existing || id === UNASSIGNED) throw error('organization_exists', 409, { organization: id, name: existing ? existing.name : undefined });
  const organization = { id, name: mockOrganizationName(organizations, body.name), unassigned: false };
  organizations.push(organization);
  sortOrganizations(organizations);
  return { organization: summary(organization) };
}

/**
 * POST /api/organizations/<id>/rename (#23): renames the organization only in this page's memory, under the store's rules
 * (renameOrganization in bin/flow-store.js): "unassigned" is reserved (400), an unknown organization is 404 and the name follows
 * mockOrganizationName without counting the organization itself. As on the server, where every answer reads the name from the
 * register, the whole mock shows the new name: every { id, name } under an "organization" key and every element of a
 * "organizations" list (projects, items, item pages, pending decisions, Overview, usage, agents).
 */
function mockRenameOrganization(m, organizations, id, body, summary) {
  if (!obj(body)) throw error('json_object_required', 400);
  if (id === UNASSIGNED) throw error('organization_reserved', 400, { organization: id });
  const organization = organizations.find((c) => c.id === id);
  if (!organization) throw error('organization_not_found', 404, { organization: id });
  const name = mockOrganizationName(organizations, body.name, id);
  const rename = (x) => {
    if (Array.isArray(x)) {
      x.forEach(rename);
      return;
    }
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'organization' && obj(v) && v.id === id && 'name' in v) v.name = name;
      else if (k === 'organizations' && Array.isArray(v)) for (const c of v) if (obj(c) && c.id === id) c.name = name;
      rename(v);
    }
  };
  rename(m);
  sortOrganizations(organizations);
  return { organization: summary(organization) };
}

/**
 * POST /api/organizations/<id>/remove (#24): removes the organization only in this page's memory, under the store's rules
 * (removeOrganization in bin/flow-store.js): "unassigned" is reserved (400), an unknown organization is 404 and an organization with
 * projects is 409 organization_not_empty, with project_count.
 */
function mockRemoveOrganization(organizations, projects, id) {
  if (id === UNASSIGNED) throw error('organization_reserved', 400, { organization: id });
  const at = organizations.findIndex((c) => c.id === id);
  if (at < 0) throw error('organization_not_found', 404, { organization: id });
  const count = projects.filter((x) => x.organization.id === id).length;
  if (count > 0) throw error('organization_not_empty', 409, { organization: id, name: organizations[at].name, project_count: count });
  organizations.splice(at, 1);
  return { removed: id };
}

/**
 * Organizations and projects (#6) from tests/mock-items.json: GET /api/organizations, POST /api/organizations (mockCreateOrganization),
 * POST /api/organizations/<id>/rename (mockRenameOrganization), POST /api/organizations/<id>/remove (mockRemoveOrganization),
 * GET /api/projects[?organization=] and POST /api/projects/<id>/organization, which moves the project only in this page's memory
 * and, like the store, refuses "unassigned" as a destination (400 organization_reserved, #21). null for any other path.
 */
async function mockOrganizations(u, method, body) {
  const p = u.pathname;
  const move = /^\/api\/projects\/([^/]+)\/organization$/.exec(p);
  const own = /^\/api\/organizations\/([^/]+)\/(rename|remove)$/.exec(p);
  if (p !== '/api/organizations' && p !== '/api/projects' && !move && !own) return null;
  const m = await loadMockItems();
  if (!Array.isArray(m.organizations)) m.organizations = [];
  const organizations = m.organizations;
  const projects = arr(m.projects);
  const summary = (c) => {
    const own = projects.filter((x) => x.organization.id === c.id);
    return { ...c, project_count: own.length, item_count: own.reduce((n, x) => n + (Number(x.item_count) || 0), 0) };
  };
  if (p === '/api/organizations') {
    if (method === 'POST') return mockCreateOrganization(organizations, body, summary);
    return { organizations: organizations.map(summary) };
  }
  if (p === '/api/projects') {
    const organization = u.searchParams.get('organization');
    return { projects: projects.filter((x) => !organization || x.organization.id === organization) };
  }
  if (method !== 'POST') throw error('method_not_allowed', 405, { method, allowed: ['POST'] });
  if (own && own[2] === 'rename') return mockRenameOrganization(m, organizations, decodeURIComponent(own[1]), body, summary);
  if (own) return mockRemoveOrganization(organizations, projects, decodeURIComponent(own[1]));
  const id = decodeURIComponent(move[1]);
  const project = projects.find((x) => x.id === id);
  if (!project) throw error('project_not_found', 404, { project: id });
  const wanted = obj(body) && body.organization;
  if (wanted === UNASSIGNED) throw error('organization_reserved', 400, { organization: wanted });
  const target = organizations.find((c) => c.id === wanted);
  if (!target) throw error('organization_not_found', 400, { organization: txt(obj(body) && body.organization) });
  project.organization = { id: target.id, name: target.name };
  project.unassigned = !!target.unassigned;
  for (const it of arr(m.items)) if (it.project.id === id) it.project.organization = { ...project.organization };
  for (const d of Object.values(obj(m.details) || {})) if (d.project.id === id) d.project.organization = { ...project.organization };
  for (const x of arr(obj(m.pending_decisions) && m.pending_decisions.pending_decisions)) if (x.item.project.id === id) x.item.project.organization = { ...project.organization };
  return { project };
}

/**
 * POST /api/pending-decisions/<id>/answer (#32) in the mock: resolves the pending decision only in this page's memory, under
 * the server's rules (panel/api-pending-decisions.js): the same codes, the decision built the same way, the owner as who
 * closed it. The pending decision moves to the closed ones, the menu counter drops and the item's timeline gets the event.
 */
async function mockAnswerPending(idText, body) {
  const m = await loadMockItems();
  const id = Number((/^(?:p-)?(\d{1,12})$/i.exec(idText) || [])[1]);
  if (!id) throw error('route_not_found', 404);
  if (!obj(body)) throw error('invalid_body', 400);
  const { option, text } = body;
  if (text !== undefined && text !== null && typeof text !== 'string') throw error('invalid_body', 400, { field: 'text' });
  let letter = null;
  if (option !== undefined && option !== null) {
    if (typeof option !== 'string' || !/^[a-z]$/i.test(option.trim())) throw error('invalid_option', 400, { value: String(option).slice(0, 20) });
    letter = option.trim().toUpperCase();
  }
  const comment = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
  if (!letter && !comment) throw error('answer_empty', 400);
  const list = arr(obj(m.pending_decisions) && m.pending_decisions.pending_decisions);
  const p = list.find((x) => x.id === id);
  if (!p) throw error('pending_decision_not_found', 404, { id });
  if (p.status !== 'open') throw error('pending_decision_not_open', 409, { id, status: p.status, closed_at: p.closed_at, resolution: p.resolution });
  const options = arr(p.options);
  const letters = optionLetters(options);
  if (letter && !letters.includes(letter)) throw error('option_not_found', 400, { id, option: letter, options: letters });
  const decision = decisionText(letter ? options[letters.indexOf(letter)] : '', comment);
  if (decision.length > MAX_DECISION) throw error('answer_too_long', 400, { length: decision.length, max: MAX_DECISION });
  const at = new Date().toISOString();
  const owner = { role: 'owner', name: null };
  Object.assign(p, { status: 'resolved', resolution: 'decision', decision, closed_at: at, closed_by: owner });
  // The server's order: the open ones, then the closed ones, the most recently closed first.
  list.splice(list.indexOf(p), 1);
  const firstClosed = list.findIndex((x) => x.status !== 'open');
  list.splice(firstClosed < 0 ? list.length : firstClosed, 0, p);
  const counter = obj(m.state) && obj(m.state.kpis) && obj(m.state.kpis.pending_decisions);
  if (counter) {
    counter.total = Math.max(0, counter.total - 1);
    if (obj(counter.by_severity) && counter.by_severity[p.severity] > 0) counter.by_severity[p.severity]--;
  }
  const item = obj(m.details) && m.details[p.item.key];
  if (item) {
    item.timeline = [...arr(item.timeline), {
      id: Date.now(), at, type: 'pending-decision-resolved', task_number: p.task ? p.task.number : null, agent: owner, source: 'panel',
      payload: { pending_decision: id, decision },
    }];
  }
  return JSON.parse(JSON.stringify(p));
}

/**
 * /api/items[?organization=&project=&stage=&tracker=], /api/items/<project>/<number>, POST /api/items/<project>/<number>/merged,
 * /api/pending-decisions[?organization=&...] and POST /api/pending-decisions/<id>/answer from tests/mock-items.json; null for any
 * other path.
 */
async function mockItems(u, method, body) {
  const p = u.pathname;
  const sp = u.searchParams;
  const merged = /^\/api\/items\/([^/]+)\/([^/]+)\/merged$/.exec(p);
  if (merged && method === 'POST') return mockMarkMerged(decodeURIComponent(merged[1]), Number(merged[2]));
  const answer = /^\/api\/pending-decisions\/([^/]+)\/answer$/.exec(p);
  if (answer) {
    if (method !== 'POST') throw error('method_not_allowed', 405, { method, allowed: ['POST'] });
    return mockAnswerPending(decodeURIComponent(answer[1]), body);
  }
  if (p === '/api/items') {
    const m = await loadMockItems();
    const [organization, project, stage, tracker] = ['organization', 'project', 'stage', 'tracker'].map((k) => sp.get(k));
    return { items: arr(m.items).filter((it) => (!organization || it.project.organization.id === organization) && (!project || it.project.id === project)
      && (!stage || it.stage === stage) && (!tracker || it.tracker === tracker)) };
  }
  if (p === '/api/pending-decisions') return mockPendingDecisions(await loadMockItems(), sp);
  if (p === '/api/overview') {
    // Overview (#14): the generator wrote the answer of every organization of the selector ('' = all).
    const all = obj((await loadMockItems()).overview) || {};
    const answer = all[sp.get('organization') || ''];
    if (!answer) throw error('invalid_filter', 400, { param: 'organization', value: sp.get('organization') });
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
  const og = list('organization'); const pj = list('project'); const ty = list('type'); const item = sp.get('item') || '';
  const since = sp.get('since'); const until = sp.get('until');
  const hours = Number(sp.get('hours')) || 0; const sinceT = hours > 0 ? now() - hours * 3600000 : null;
  const groups = { organization: new Map(), project: new Map(), type: new Map() };
  const count = (g, k) => { if (k) g.set(k, (g.get(k) || 0) + 1); };
  const f = all.filter((e) => {
    const d = spDay(e.at);
    if ((since && d < since) || (until && d > until) || (sinceT !== null && !(Date.parse(e.at) >= sinceT)) || (item && e.item_key !== item)) return false;
    const organization = e.project.organization && e.project.organization.id;
    const okOg = !og || og.has(organization); const okPj = !pj || pj.has(e.project.id); const okTy = !ty || ty.has(e.type);
    if (okPj && okTy) count(groups.organization, organization);
    if (okOg && okTy) count(groups.project, e.project.id);
    if (okOg && okPj) count(groups.type, e.type);
    return okOg && okPj && okTy;
  });
  const pg = Math.max(1, Number(sp.get('page')) || 1); const pp = Math.max(1, Number(sp.get('per_page')) || 50);
  return {
    total: f.length, page: pg, per_page: pp, pages: Math.max(1, Math.ceil(f.length / pp)), events: f.slice((pg - 1) * pp, pg * pp),
    counts: { organization: Object.fromEntries(groups.organization), project: Object.fromEntries(groups.project), type: Object.fromEntries(groups.type) },
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
 * server's organization and project filters: they only choose the lines. null for any other path.
 */
async function mockUsage(p, sp) {
  if (p !== '/api/usage' && p !== '/api/agents') return null;
  const m = await loadMockItems();
  const set = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((x) => x.trim()).filter(Boolean)) : null);
  const og = set('organization'); const pj = set('project');
  const passes = (x) => { const pr = obj(x.project) || {}; return (!og || (obj(pr.organization) && og.has(pr.organization.id))) && (!pj || pj.has(pr.id)); };
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
  const organizations = await mockOrganizations(u, method, body);
  if (organizations) return organizations;
  const usage = await mockUsage(p, u.searchParams);
  if (usage) return usage;
  const items = await mockItems(u, method, body);
  if (items) return items;
  const log = await mockLog(p, u.searchParams);
  if (log) return log;
  throw error('route_not_found', 404);
}
