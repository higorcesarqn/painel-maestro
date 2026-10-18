'use strict';
// Tests for the "Concluir" button (#68): POST /api/items/<project>/<number>/done records the same item-done as
// `flow item done`, as the owner (source panel), and cancels the item's open pending decisions. Same seam as
// test-merge-check.js: the bin/flow.js CLI runs as a process in a temporary git repository → temporary maestro.db
// (MAESTRO_DIR) → the server's HTTP API. No test reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('"Concluir": POST /api/items/<project>/<number>/done → item-done (owner, panel) → items API');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`item-done-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', remote);
  return { root, data, repo };
}

function flow(r, args) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' });
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd: r.repo, env, input: '', encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: exit ${x.status}\n${x.stderr}`);
  return x.stdout;
}

const openedId = (stdout) => Number(/\bP-(\d+)\b/.exec(stdout)[1]);

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') },
  });
  try {
    await fn({
      port,
      async get(p) {
        const x = await request(port, p);
        assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
        return x.json;
      },
      post: (p, options = {}) => request(port, p, { method: 'POST', ...options, headers: { 'X-Panel': '1', ...options.headers } }),
    });
  } finally {
    await s.stop();
  }
}

suite.test('POST .../done concludes an item on any stage as the owner (source panel): Done, skipped stages passed, out of the active list', async () => {
  const r = buildRoot('ok');
  flow(r, ['item', 'start', '12', '--title', 'Parado em Merge', '--stage', 'implementation']);
  flow(r, ['pr', '12', 'ready', '--url', 'https://github.com/acme/widgets/pull/112']);
  flow(r, ['item', 'start', '13', '--title', 'Outro', '--stage', 'specification']);
  await withServer(r, async (api) => {
    const x = await api.post('/api/items/widgets/12/done', { headers: { Origin: `http://127.0.0.1:${api.port}` } });
    assert.strictEqual(x.status, 200, x.text);
    const item = x.json.item;
    assert.deepStrictEqual([item.key, item.stage, item.active, item.merge_check], ['widgets/12', 'done', false, null]);
    assert.strictEqual(item.completed_at, item.stage_since);
    assert.deepStrictEqual(item.stages.map((s) => s.status), ['done', 'done', 'done', 'done', 'done', 'done', 'current']);
    const last = item.timeline[item.timeline.length - 1];
    assert.deepStrictEqual([last.type, last.payload, last.source, last.agent], ['item-done', {}, 'panel', { role: 'owner', name: null }]);
    assert.deepStrictEqual((await api.get('/api/items?active=1')).items.map((i) => i.key), ['widgets/13']);
    assert.deepStrictEqual((await api.get('/api/items?active=0')).items.map((i) => i.key), ['widgets/12']);
    // Its ready PR is no longer checked nor marked: a merge recorded now would bring it back to the active list.
    const merged = await api.post('/api/items/widgets/12/merged');
    assert.deepStrictEqual([merged.status, merged.json.error.code], [409, 'item_not_active']);
  });
});

suite.test('an item interrupted by flow item interrupt (#69) is left alone by the merge check and refuses POST .../done', async () => {
  const r = buildRoot('interrupted');
  flow(r, ['item', 'start', '14', '--title', 'Parou em PR pronto', '--stage', 'implementation']);
  flow(r, ['pr', '14', 'ready', '--url', 'https://github.com/acme/widgets/pull/114']);
  flow(r, ['item', 'interrupt', '14', '--reason', 'Ficou para depois']);
  await withServer(r, async (api) => {
    const item = (await api.get('/api/items/widgets/14')).item;
    assert.deepStrictEqual([item.stage, item.active, item.merge_check, item.interrupted.reason], ['pr_ready', false, null, 'Ficou para depois']);
    const merged = await api.post('/api/items/widgets/14/merged');
    assert.deepStrictEqual([merged.status, merged.json.error.code], [409, 'item_not_active']);
    const done = await api.post('/api/items/widgets/14/done');
    assert.deepStrictEqual([done.status, done.json.error.code], [409, 'item_not_active']);
    assert.deepStrictEqual((await api.get('/api/items/widgets/14')).item.timeline.map((e) => e.type), ['item-started', 'pr-changed', 'item-interrupted']);
  });
});

suite.test('POST .../done cancels the item\'s open pending decisions with "item concluído pelo dono"', async () => {
  const r = buildRoot('pending');
  flow(r, ['item', 'start', '12', '--title', 'Com pendência', '--stage', 'merge']);
  const open = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Seguir?']));
  const resolved = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Já resolvida']));
  flow(r, ['pending', 'resolve', String(resolved), '--decision', 'A']);
  await withServer(r, async (api) => {
    const x = await api.post('/api/items/widgets/12/done');
    assert.strictEqual(x.status, 200, x.text);
    assert.deepStrictEqual(x.json.item.timeline.slice(-2).map((e) => [e.type, e.source, e.agent.role]),
      [['item-done', 'panel', 'owner'], ['pending-decision-canceled', 'panel', 'owner']]);
    const byId = new Map((await api.get('/api/pending-decisions')).pending_decisions.map((p) => [p.id, p]));
    assert.deepStrictEqual([byId.get(open).status, byId.get(open).reason, byId.get(open).closed_by.role], ['canceled', 'item concluído pelo dono', 'owner']);
    assert.deepStrictEqual([byId.get(resolved).status, byId.get(resolved).reason], ['resolved', null]);
  });
});

suite.test('POST .../done in a project without the Done stage takes the item out of the active list', async () => {
  const r = buildRoot('no-done');
  flow(r, ['org', 'add', 'personal', '--name', 'Pessoal']);
  flow(r, ['project', 'add', 'widgets', '--name', 'Widgets', '--org', 'personal', '--stages', 'specification,implementation,merge']);
  flow(r, ['item', 'start', '7', '--title', 'Sem Concluído', '--stage', 'merge']);
  await withServer(r, async (api) => {
    const x = await api.post('/api/items/widgets/7/done');
    assert.strictEqual(x.status, 200, x.text);
    assert.deepStrictEqual([x.json.item.stage, x.json.item.active], ['merge', false]);
    assert.deepStrictEqual((await api.get('/api/items?active=1')).items, []);
  });
});

suite.test('POST .../done: 404 item_not_found, 409 item_not_active, 403 under the POST safety rules; refused requests write nothing', async () => {
  const r = buildRoot('refused');
  flow(r, ['item', 'start', '12', '--title', 'Ativo', '--stage', 'implementation']);
  flow(r, ['item', 'start', '14', '--title', 'Já concluído', '--stage', 'implementation']);
  flow(r, ['item', 'done', '14']);
  await withServer(r, async (api) => {
    const PATH = '/api/items/widgets/12/done';
    const host = await api.post(PATH, { host: 'evil.example' });
    assert.deepStrictEqual([host.status, host.json.error.code], [403, 'host_not_allowed']);
    const noHeader = await request(api.port, PATH, { method: 'POST' });
    assert.deepStrictEqual([noHeader.status, noHeader.json.error.code], [403, 'missing_panel_header']);
    const foreign = await api.post(PATH, { headers: { Origin: 'http://evil.example' } });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const get = await request(api.port, PATH);
    assert.deepStrictEqual([get.status, get.json.error.code, get.headers.allow], [405, 'method_not_allowed', 'POST']);
    assert.strictEqual((await api.get('/api/items/widgets/12')).item.timeline.length, 1, 'refused requests write nothing');
    const done = await api.post('/api/items/widgets/14/done');
    assert.deepStrictEqual([done.status, done.json.error], [409, { code: 'item_not_active', project: 'widgets', number: 14 }]);
    assert.strictEqual((await api.get('/api/items/widgets/14')).item.timeline.length, 2, 'one item-done only');
    const missing = await api.post('/api/items/widgets/99/done');
    assert.deepStrictEqual([missing.status, missing.json.error], [404, { code: 'item_not_found', project: 'widgets', number: 99 }]);
    assert.strictEqual((await api.post('/api/items/nao-existe/1/done')).status, 404);
    assert.strictEqual((await api.post('/api/items/Widgets!/1/done')).status, 404);
    // Once concluded, a second click is refused.
    assert.strictEqual((await api.post(PATH)).status, 200);
    assert.strictEqual((await api.post(PATH)).status, 409);
  });
});

suite.test('POST .../done without maestro.db answers 404 and creates nothing', async () => {
  const r = buildRoot('no-db');
  await withServer(r, async (api) => {
    const x = await api.post('/api/items/widgets/1/done');
    assert.deepStrictEqual([x.status, x.json.error.code], [404, 'item_not_found']);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')));
});

suite.test('the page translates item_not_active (pt-BR dictionary)', async () => {
  const { pathToFileURL } = require('url');
  const { translateCode } = await import(pathToFileURL(path.join(REPO, 'panel', 'ui', 'src', 'i18n', 'index.js')).href);
  assert.strictEqual(translateCode({ code: 'item_not_active', project: 'widgets', number: 14 }), 'O item já não está mais ativo.');
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
