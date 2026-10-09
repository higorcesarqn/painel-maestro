'use strict';
// Tests for the Log of the new model (#12) through the agreed seam only: the flow CLI writes events in temporary
// git repositories (fictitious remotes) → temporary maestro.db (MAESTRO_DIR) → GET /api/log and /api/log/<id>.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('new model Log: flow CLI → maestro.db → /api/log');
const roots = [];
const sp = (hms, day = '2026-10-08') => `${day}T${hms}-03:00`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function buildRoot(name) {
  const root = tmpDir(`log-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = (dir, remote) => {
    const p = path.join(root, dir);
    fs.mkdirSync(p, { recursive: true });
    git(p, 'init', '-q');
    git(p, 'remote', 'add', 'origin', remote);
    return p;
  };
  return { root, data, widgets: repo('widgets', 'https://github.com/acme/widgets.git'), cidax: repo('cidax', 'https://dev.azure.com/contoso/CIDAX/_git/cidax-api') };
}

function flow(r, cwd, now, ...args) {
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd, env: Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: now, NODE_OPTIONS: '' }), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), PANEL_NOW: sp('12:00:00') },
  });
  try {
    await fn((p) => request(port, p));
  } finally {
    await s.stop();
  }
}

suite.test('lists the events newest first, with project, company and item, and filters by company, project, item, type and period', async () => {
  const r = buildRoot('filters');
  flow(r, r.widgets, sp('09:00:00', '2026-10-06'), 'item', 'start', '12', '--title', 'Exportar PDF');
  flow(r, r.widgets, sp('10:00:00', '2026-10-07'), 'stage', '12', 'implementation');
  flow(r, r.cidax, sp('11:00:00', '2026-10-07'), 'item', 'start', '3100', '--title', 'Conciliação', '--agent', 'Ária');
  flow(r, r.widgets, sp('08:00:00'), 'item', 'start', '13', '--title', 'Outro item');
  flow(r, r.widgets, sp('11:30:00'), 'stage', '12', 'pr_ready', '--role', 'worker');
  await withServer(r, async (get) => {
    const all = (await get('/api/log')).json;
    assert.strictEqual(all.total, 5);
    assert.deepStrictEqual(all.events.map((e) => [e.at, e.type, e.item_key, e.tracker_ref]), [
      [sp('11:30:00'), 'stage-changed', 'widgets/12', '#12'],
      [sp('08:00:00'), 'item-started', 'widgets/13', '#13'],
      [sp('11:00:00', '2026-10-07'), 'item-started', 'cidax-api/3100', 'PBI 3100'],
      [sp('10:00:00', '2026-10-07'), 'stage-changed', 'widgets/12', '#12'],
      [sp('09:00:00', '2026-10-06'), 'item-started', 'widgets/12', '#12'],
    ]);
    const pbi = all.events[2];
    assert.deepStrictEqual(pbi.project, { id: 'cidax-api', name: 'cidax-api', tracker: 'azure_devops', company: { id: 'unassigned', name: 'Sem empresa' } });
    assert.deepStrictEqual([pbi.item_title, pbi.agent, pbi.payload.title], ['Conciliação', { role: 'maestro', name: 'Ária' }, 'Conciliação']);
    assert.deepStrictEqual(all.counts, { company: { unassigned: 5 }, project: { widgets: 4, 'cidax-api': 1 }, type: { 'item-started': 3, 'stage-changed': 2 } });

    const keys = async (q) => (await get(`/api/log?${q}`)).json.events.map((e) => `${e.item_key}:${e.type}`);
    assert.deepStrictEqual(await keys('project=cidax-api'), ['cidax-api/3100:item-started']);
    assert.deepStrictEqual(await keys('item=widgets/12&type=stage-changed'), ['widgets/12:stage-changed', 'widgets/12:stage-changed']);
    assert.deepStrictEqual(await keys('since=2026-10-07&until=2026-10-07'), ['cidax-api/3100:item-started', 'widgets/12:stage-changed']);
    assert.deepStrictEqual(await keys('hours=4'), ['widgets/12:stage-changed', 'widgets/13:item-started']);
    assert.deepStrictEqual(await keys('company=unassigned&project=widgets,cidax-api&type=item-started&per_page=2&page=2'), ['widgets/12:item-started']);
    const none = (await get('/api/log?company=contoso')).json;
    assert.deepStrictEqual([none.total, none.events, none.counts.company], [0, [], { unassigned: 5 }], 'each facet ignores its own filter');
  });
});

suite.test('codes for invalid parameters and missing events; no database yet gives an empty log', async () => {
  const r = buildRoot('codes');
  await withServer(r, async (get) => {
    const empty = (await get('/api/log')).json;
    assert.deepStrictEqual([empty.total, empty.events, empty.raw_last_at], [0, [], null]);
    assert.strictEqual((await get('/api/log/1')).status, 404);
  });
  flow(r, r.widgets, sp('09:00:00'), 'item', 'start', '1', '--title', 'x');
  await withServer(r, async (get) => {
    for (const [q, param] of [['since=2026-02-31', 'since'], ['item=widgets', 'item'], ['page=0', 'page'], ['project=Widgets!', 'project']]) {
      const x = await get(`/api/log?${q}`);
      assert.deepStrictEqual([x.status, x.json.error.code, x.json.error.param], [400, 'invalid_param', param], q);
    }
    const missing = await get('/api/log/99');
    assert.deepStrictEqual([missing.status, missing.json.error], [404, { code: 'event_not_found', id: 99 }]);
    for (const p of ['/api/log/abc', '/api/log/0', '/api/log/1/x']) assert.strictEqual((await get(p)).status, 404, p);
    const one = (await get('/api/log/1')).json;
    assert.deepStrictEqual([one.event.type, one.item.title, one.raw_commands, one.raw_link.by], ['item-started', 'x', [], 'item']);
  });
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
