'use strict';
// Tests for the work screens without the hidden organizations (#51) through the agreed seam only: the bin/flow.js CLI
// runs as a process (inside temporary git repositories with fictitious remotes) → temporary maestro.db (MAESTRO_DIR) →
// the server's HTTP API. Contoso stays visible, as the control, next to Fabrikam, hidden. usage.json, the collector's
// file, is written as the collector would leave it. No test reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, writeJson } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('work screens without the hidden organizations: flow CLI → maestro.db → API');
const roots = [];
const NOW = '2026-10-08T15:50:00-03:00';
const sp = (hms) => `2026-10-08T${hms}-03:00`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A git repository in <root>/<name> whose origin is remote. */
function repo(r, name, remote) {
  const dir = path.join(r.root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

/** Runs the CLI outside of Maestri at the moment now; by default in a folder outside any repository. */
function flow(r, args, { cwd = r.outside, now = sp('09:00:00') } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: now, NODE_OPTIONS: '', GIT_CEILING_DIRECTORIES: r.root });
  for (const k of ['MAESTRI_TERMINAL_ID', 'MAESTRI_TERMINAL_NAME', 'MAESTRI_WORKSPACE_ID', 'MAESTRI_WORKSPACE_NAME']) delete env[k];
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  return x.stdout;
}

const pendingId = (out) => Number(/\bP-(\d+)\b/.exec(out)[1]);

/**
 * Contoso (visible) with widgets/12 and Fabrikam (hidden) with shop/48, both active for hours on the same stage, each with
 * an open pending decision; Fabrikam's has a high severity.
 */
function twoOrganizations(name) {
  const root = tmpDir(`hidden-screens-${name}`);
  roots.push(root);
  const r = { root, data: path.join(root, 'data'), outside: path.join(root, 'outside') };
  fs.mkdirSync(r.outside, { recursive: true });
  const widgets = repo(r, 'widgets', 'https://github.com/contoso/widgets.git');
  const shop = repo(r, 'shop', 'https://github.com/fabrikam/shop.git');
  flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']);
  flow(r, ['org', 'add', 'fabrikam', '--name', 'Fabrikam']);
  flow(r, ['project', 'add', 'widgets', '--org', 'contoso'], { cwd: widgets });
  flow(r, ['project', 'add', 'shop', '--name', 'Loja', '--org', 'fabrikam'], { cwd: shop });
  flow(r, ['item', 'start', '12', '--title', 'Relatório', '--agent', 'Bento'], { cwd: widgets });
  flow(r, ['item', 'start', '48', '--title', 'Carrinho', '--agent', 'Cora'], { cwd: shop });
  const visible = pendingId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Qual nome?'], { cwd: widgets, now: sp('10:00:00') }));
  const hidden = pendingId(flow(r, ['pending', 'open', '48', '--kind', 'decision', '--title', 'Qual frete?', '--severity', 'high', '--option', 'A: Grátis', '--option', 'B: Pago'], { cwd: shop, now: sp('10:05:00') }));
  flow(r, ['org', 'hide', 'fabrikam']);
  return { r, widgets, shop, pending: { visible, hidden } };
}

/** usage.json as the collector leaves it: one line of each item and of each item's maestro, in every period. */
function writeUsage(r) {
  const sums = { input: 100, output: 200, cache_write: 0, cache_read: 1000, messages: 2, relative_consumption: 1300, consumption_pct: 50, estimated_plan_pct: 18 };
  const lines = (role) => [['widgets', 12], ['shop', 48]].map(([project, n]) => (role
    ? { key: `${project}/${n}/maestro`, role, project_id: project, item_number: n, task_number: null, ...sums }
    : { key: `${project}/${n}`, project_id: project, item_number: n, ...sums }));
  const periods = (role) => ({ window_5h: lines(role), today: lines(role), '7d': lines(role) });
  writeJson(path.join(r.data, 'state', 'usage.json'), {
    collected_at: NOW,
    plan: { available: true, window_5h_pct: 36, reset_5h: '2026-10-08T18:00:00-03:00', weekly_pct: 20, weekly_reset: '2026-10-13T09:00:00-03:00', updated_at: NOW, source: 'maestri' },
    periods: { window_5h: { start: sp('13:00:00'), end: NOW }, today: { start: sp('00:00:00'), end: NOW }, '7d': { start: '2026-10-01T15:50:00-03:00', end: NOW } },
    totals: { window_5h: { input: 200, output: 400 }, today: { input: 200, output: 400 }, '7d': { input: 200, output: 400 } },
    by_item: periods(null),
    by_agent: periods('maestro'),
  });
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), PANEL_NOW: NOW, PANEL_STALE_HOURS: '1' },
  });
  try {
    await fn({
      port,
      get: async (p) => {
        const x = await request(port, p);
        assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
        return x.json;
      },
    });
  } finally {
    await s.stop();
  }
}

const keys = (list) => list.map((x) => x.key);

suite.test('GET /api/items leaves the items of a hidden organization out; ?organization=<hidden> is empty', async () => {
  const { r } = twoOrganizations('items');
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual(keys((await get('/api/items')).items), ['widgets/12']);
    assert.deepStrictEqual(keys((await get('/api/items?active=1')).items), ['widgets/12']);
    for (const q of ['organization=fabrikam', 'project=shop', 'organization=fabrikam&active=1']) {
      assert.deepStrictEqual([q, (await get(`/api/items?${q}`)).items], [q, []]);
    }
    assert.deepStrictEqual(keys((await get('/api/items?organization=contoso')).items), ['widgets/12']);
    // Shown again, its items are back on the same server.
    flow(r, ['org', 'unhide', 'fabrikam']);
    assert.deepStrictEqual(keys((await get('/api/items')).items).sort(), ['shop/48', 'widgets/12']);
  });
});

suite.test('GET /api/pending-decisions leaves the pending decisions of a hidden organization out, in the list, the counts and the organizations', async () => {
  const { r, pending } = twoOrganizations('pending');
  await withServer(r, async ({ get }) => {
    const all = await get('/api/pending-decisions');
    assert.deepStrictEqual(all.pending_decisions.map((p) => p.id), [pending.visible]);
    assert.deepStrictEqual(all.counts, { status: { open: 1, resolved: 0, canceled: 0 }, severity: { critical: 0, high: 0, normal: 1, low: 0 } });
    assert.deepStrictEqual(all.organizations, [{ id: 'contoso', name: 'Contoso' }]);
    const none = await get('/api/pending-decisions?organization=fabrikam');
    assert.deepStrictEqual([none.pending_decisions, none.counts.status.open, none.counts.severity.high], [[], 0, 0]);
    assert.deepStrictEqual((await get('/api/pending-decisions?project=shop&status=open')).pending_decisions, []);
  });
});

suite.test('GET /api/log leaves the events of a hidden organization out, in the page, the total and the counts of the filters', async () => {
  const { r } = twoOrganizations('log');
  await withServer(r, async ({ get }) => {
    const log = await get('/api/log');
    assert.ok(log.events.length > 0);
    assert.deepStrictEqual([...new Set(log.events.map((e) => e.project.id))], ['widgets']);
    assert.strictEqual(log.total, log.events.length);
    assert.deepStrictEqual(Object.keys(log.counts.organization), ['contoso']);
    assert.deepStrictEqual(Object.keys(log.counts.project), ['widgets']);
    assert.strictEqual(Object.values(log.counts.type).reduce((n, x) => n + x, 0), log.total);
    for (const q of ['organization=fabrikam', 'project=shop', 'item=shop/48', 'organization=contoso,fabrikam&project=shop']) {
      const x = await get(`/api/log?${q}`);
      assert.deepStrictEqual([q, x.total, x.events], [q, 0, []]);
    }
    // The organization facet ignores its own filter: the hidden one is not counted even when chosen.
    const chosen = await get('/api/log?organization=fabrikam');
    assert.deepStrictEqual([chosen.counts.organization, chosen.counts.project, chosen.counts.type], [{ contoso: log.total }, {}, {}]);
  });
});

suite.test('GET /api/overview neither counts nor lists a hidden organization', async () => {
  const { r, pending } = twoOrganizations('overview');
  await withServer(r, async ({ get }) => {
    const o = await get('/api/overview');
    assert.deepStrictEqual([o.active.total, o.active.organizations.map((c) => c.id)], [1, ['contoso']]);
    assert.deepStrictEqual([o.pending_decisions.total, o.pending_decisions.by_severity.high, o.pending_decisions.open.map((p) => p.id)], [1, 0, [pending.visible]]);
    assert.deepStrictEqual(keys(o.stale_items), ['widgets/12']);
    assert.deepStrictEqual([...new Set(o.recent_events.map((e) => e.project.id))], ['widgets']);
    const log = await get('/api/log');
    assert.strictEqual(o.events_today, log.total);

    const none = await get('/api/overview?organization=fabrikam');
    assert.deepStrictEqual([none.organization, none.active, none.pending_decisions.total, none.pending_decisions.open, none.stale_items, none.events_today, none.recent_events],
      ['fabrikam', { total: 0, by_stage: {}, organizations: [] }, 0, [], [], 0, []]);
  });
});

suite.test('GET /api/usage leaves the lines of a hidden organization out; the plan, the periods and the totals stay the whole account', async () => {
  const { r } = twoOrganizations('usage');
  writeUsage(r);
  await withServer(r, async ({ get }) => {
    const u = await get('/api/usage');
    for (const period of ['window_5h', 'today', '7d']) {
      assert.deepStrictEqual(keys(u.by_item[period]), ['widgets/12'], period);
      assert.deepStrictEqual(keys(u.by_agent[period]), ['widgets/12/maestro'], period);
    }
    // The percentages of a line are of the whole account, as written.
    assert.deepStrictEqual([u.by_item['7d'][0].consumption_pct, u.by_item['7d'][0].estimated_plan_pct], [50, 18]);
    assert.deepStrictEqual([u.plan.window_5h_pct, u.plan.weekly_pct, u.totals['7d']], [36, 20, { input: 200, output: 400 }]);

    const none = await get('/api/usage?organization=fabrikam');
    assert.deepStrictEqual([none.by_item, none.by_agent], [{ window_5h: [], today: [], '7d': [] }, { window_5h: [], today: [], '7d': [] }]);
    assert.deepStrictEqual([none.plan, none.periods, none.totals], [u.plan, u.periods, u.totals]);
    assert.deepStrictEqual((await get('/api/usage?project=shop')).by_item['7d'], []);
  });
});

suite.test('GET /api/agents leaves the agents of a hidden organization out', async () => {
  const { r, widgets, shop } = twoOrganizations('agents');
  flow(r, ['task', 'graph', '12', '--task', '31|Gerar o PDF', '--agent', 'Bento'], { cwd: widgets });
  flow(r, ['task', 'dispatch', '12', '31', '--floor', 'PDF', '--worker', 'Ária', '--branch', 'task/31-pdf', '--agent', 'Bento'], { cwd: widgets });
  flow(r, ['task', 'graph', '48', '--task', '50|Tabela de frete', '--agent', 'Cora'], { cwd: shop });
  flow(r, ['task', 'dispatch', '48', '50', '--floor', 'Frete', '--worker', 'Dante', '--branch', 'task/50-frete', '--agent', 'Cora'], { cwd: shop });
  await withServer(r, async ({ get }) => {
    const a = await get('/api/agents');
    assert.deepStrictEqual(a.agents.map((x) => [x.key, x.name]), [['widgets/12/maestro', 'Bento'], ['widgets/12/task-31', 'Ária']]);
    assert.deepStrictEqual(a.counts, { maestro: 1, worker: 1 });
    assert.deepStrictEqual(await get('/api/agents?organization=fabrikam'), { agents: [], counts: { maestro: 0, worker: 0 } });
    assert.deepStrictEqual((await get('/api/agents?project=shop')).agents, []);
  });
});

suite.test('the item of a hidden organization still answers by its key, and its pending decision is answered by the API', async () => {
  const { r, pending } = twoOrganizations('item-page');
  await withServer(r, async ({ port, get }) => {
    const { item } = await get('/api/items/shop/48');
    assert.deepStrictEqual([item.key, item.title, item.project.organization], ['shop/48', 'Carrinho', { id: 'fabrikam', name: 'Fabrikam' }]);
    assert.ok(item.timeline.length > 0);

    const answer = await request(port, `/api/pending-decisions/P-${pending.hidden}/answer`, {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ option: 'B', text: 'só acima de R$ 100' }),
    });
    assert.strictEqual(answer.status, 200, answer.text);
    assert.deepStrictEqual([answer.json.id, answer.json.status, answer.json.decision, answer.json.item.key], [pending.hidden, 'resolved', 'B: Pago — só acima de R$ 100', 'shop/48']);
    // Still out of the list, open or closed.
    assert.deepStrictEqual((await get('/api/pending-decisions')).pending_decisions.map((p) => p.id), [pending.visible]);
  });
});

suite.test('GET /api/state leaves the pending decisions of a hidden organization out of its KPIs, as the Pendências screen (#52, test-state-hidden.js)', async () => {
  const { r, pending } = twoOrganizations('state');
  await withServer(r, async ({ get }) => {
    const { kpis } = await get('/api/state');
    assert.deepStrictEqual([kpis.pending_decisions.total, kpis.pending_decisions.by_severity.high, kpis.pending_decisions.open.map((p) => p.id)],
      [1, 0, [pending.visible]]);
  });
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
