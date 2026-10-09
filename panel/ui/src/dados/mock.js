// Test mode (?mock=1): reads tests/mock-*.json and imitates /api/state, /api/events, /api/event and /api/flow,
// answering in the API shape (English fields and codes), as the real server does.
// Serve with "node tests/serve-mock.js" and open http://127.0.0.1:4795/?mock=1 (or use npm run dev).
import { arr, obj, diaSP, normalizar, txt, agora } from './formato.js';

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
        throw new Error(`Modo de teste: não consegui ler tests/mock-state.json (${e.message}). Sirva a pasta com "node tests/serve-mock.js" e abra a página com ?mock=1.`);
      });
  }
  return load;
}

const TABLE_FIELDS = ['id', 'ts', 'agent', 'project', 'summary', 'direction', 'result', 'type', 'flow_id', 'needs_owner', 'origin', 'test'];
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
  const { state, det } = await loadMock();
  const u = new URL(urlPath, location.href);
  const p = u.pathname;
  const sp = u.searchParams;
  const evs = arr(det.events).slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const asc = evs.slice().reverse();
  if (p === '/api/state' || (p === '/api/recalculate' && method === 'POST')) return JSON.parse(JSON.stringify(state));
  if (p === '/api/events') {
    // Like the server: hours=N, many comma-separated values and counts where each facet ignores its own filter.
    const set = (n) => (sp.get(n) ? new Set(sp.get(n).split(',').map((x) => x.trim()).filter(Boolean)) : null);
    const ag = set('agent'); const ty = set('type'); const rs = set('result');
    const pj = sp.get('project') ? new Set(sp.get('project').split(',').map((x) => x.trim().toLowerCase())) : null;
    const terms = normalizar(sp.get('q') || '').split(/\s+/).filter(Boolean);
    const since = sp.get('since'); const until = sp.get('until'); const flow = sp.get('flow');
    const hours = Number(sp.get('hours')) || 0; const sinceT = hours > 0 ? agora() - hours * 3600000 : null;
    const tests = sp.get('include_tests') === '1'; const ownerOnly = sp.get('owner_only') === '1';
    const groups = { result: new Map(), agent: new Map(), project: new Map(), type: new Map() };
    const count = (g, k) => { if (typeof k === 'string' && k) g.set(k, (g.get(k) || 0) + 1); };
    let needs = 0;
    const f = evs.filter((e) => {
      if (!tests && e.test === true) return false;
      const d = diaSP(e.ts);
      if (since && d < since) return false;
      if (until && d > until) return false;
      if (sinceT !== null && !(Date.parse(e.ts) >= sinceT)) return false;
      if (flow && e.flow_id !== flow) return false;
      if (terms.length) {
        const t = normalizar([e.summary, e.direction, e.flow_id].map(txt).join(' '));
        if (!terms.every((x) => t.includes(x))) return false;
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
