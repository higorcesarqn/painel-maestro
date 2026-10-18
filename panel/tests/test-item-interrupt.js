'use strict';
// Tests for the "Interromper" button (#70): POST /api/items/<project>/<number>/interrupt with { reason } records the
// same item-interrupted as `flow item interrupt`, as the owner (source panel), and cancels the item's open pending
// decisions. Same seam as test-item-done.js: the bin/flow.js CLI runs as a process in a temporary git repository →
// temporary maestro.db (MAESTRO_DIR) → the server's HTTP API. No test reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('"Interromper": POST /api/items/<project>/<number>/interrupt → item-interrupted (owner, panel) → items API');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`item-interrupt-${name}`);
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
      // POST .../interrupt with a JSON body (a string goes as it is).
      interrupt: (p, body, options = {}) => request(port, p, {
        method: 'POST', ...options, body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'X-Panel': '1', 'Content-Type': 'application/json', ...options.headers },
      }),
    });
  } finally {
    await s.stop();
  }
}

suite.test('POST .../interrupt interrupts an item on its stage as the owner (source panel): out of the active list, with the reason', async () => {
  const r = buildRoot('ok');
  flow(r, ['item', 'start', '12', '--title', 'Parado em Merge', '--stage', 'implementation']);
  flow(r, ['pr', '12', 'ready', '--url', 'https://github.com/acme/widgets/pull/112']);
  flow(r, ['item', 'start', '13', '--title', 'Outro', '--stage', 'specification']);
  await withServer(r, async (api) => {
    const reason = '  O cliente desistiu.\r\nFica para outro ciclo.  ';
    const x = await api.interrupt('/api/items/widgets/12/interrupt', { reason }, { headers: { Origin: `http://127.0.0.1:${api.port}` } });
    assert.strictEqual(x.status, 200, x.text);
    const item = x.json.item;
    assert.deepStrictEqual([item.key, item.stage, item.active, item.completed_at, item.merge_check], ['widgets/12', 'pr_ready', false, null, null]);
    assert.deepStrictEqual([item.interrupted.reason, item.interrupted.by], ['O cliente desistiu.\nFica para outro ciclo.', { role: 'owner', name: null }]);
    const last = item.timeline[item.timeline.length - 1];
    assert.deepStrictEqual([last.type, last.payload, last.source, last.agent],
      ['item-interrupted', { reason: 'O cliente desistiu.\nFica para outro ciclo.' }, 'panel', { role: 'owner', name: null }]);
    assert.deepStrictEqual((await api.get('/api/items?active=1')).items.map((i) => i.key), ['widgets/13']);
    assert.deepStrictEqual((await api.get('/api/items?active=0')).items.map((i) => i.key), ['widgets/12']);
    // Already out of the active list: neither a second interruption nor a conclusion is recorded.
    const again = await api.interrupt('/api/items/widgets/12/interrupt', { reason: 'De novo' });
    assert.deepStrictEqual([again.status, again.json.error], [409, { code: 'item_not_active', project: 'widgets', number: 12 }]);
    assert.strictEqual((await api.post('/api/items/widgets/12/done')).status, 409);
  });
});

suite.test('POST .../interrupt cancels the item\'s open pending decisions with "item interrompido pelo dono"', async () => {
  const r = buildRoot('pending');
  flow(r, ['item', 'start', '12', '--title', 'Com pendência', '--stage', 'merge']);
  const open = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Seguir?']));
  const resolved = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Já resolvida']));
  flow(r, ['pending', 'resolve', String(resolved), '--decision', 'A']);
  await withServer(r, async (api) => {
    const x = await api.interrupt('/api/items/widgets/12/interrupt', { reason: 'Parou' });
    assert.strictEqual(x.status, 200, x.text);
    assert.deepStrictEqual(x.json.item.timeline.slice(-2).map((e) => [e.type, e.source, e.agent.role]),
      [['item-interrupted', 'panel', 'owner'], ['pending-decision-canceled', 'panel', 'owner']]);
    const byId = new Map((await api.get('/api/pending-decisions')).pending_decisions.map((p) => [p.id, p]));
    assert.deepStrictEqual([byId.get(open).status, byId.get(open).reason, byId.get(open).closed_by.role], ['canceled', 'item interrompido pelo dono', 'owner']);
    assert.deepStrictEqual([byId.get(resolved).status, byId.get(resolved).reason], ['resolved', null]);
  });
});

suite.test('POST .../interrupt: 400 without a reason or over 2000 characters; refused requests write nothing', async () => {
  const r = buildRoot('reason');
  flow(r, ['item', 'start', '12', '--title', 'Ativo', '--stage', 'implementation']);
  await withServer(r, async (api) => {
    const PATH = '/api/items/widgets/12/interrupt';
    for (const body of [{}, { reason: '' }, { reason: ' \n\t ' }, { reason: null }]) {
      const x = await api.interrupt(PATH, body);
      assert.deepStrictEqual([x.status, x.json.error], [400, { code: 'reason_empty' }], JSON.stringify(body));
    }
    const notText = await api.interrupt(PATH, { reason: 12 });
    assert.deepStrictEqual([notText.status, notText.json.error], [400, { code: 'invalid_field', field: 'reason', value: '12' }]);
    for (const body of ['', 'não é json', '[1]', '"texto"']) {
      const x = await api.interrupt(PATH, body);
      assert.deepStrictEqual([x.status, x.json.error.code], [400, 'json_object_required'], body);
    }
    const long = await api.interrupt(PATH, { reason: 'x'.repeat(2001) });
    assert.deepStrictEqual([long.status, long.json.error], [400, { code: 'reason_too_long', length: 2001, max: 2000 }]);
    const big = await api.interrupt(PATH, { reason: 'x'.repeat(17 * 1024) });
    assert.deepStrictEqual([big.status, big.json.error.code], [413, 'body_too_large']);
    assert.strictEqual((await api.get('/api/items/widgets/12')).item.timeline.length, 1, 'refused requests write nothing');
    const max = await api.interrupt(PATH, { reason: 'y'.repeat(2000) });
    assert.deepStrictEqual([max.status, max.json.item.interrupted.reason.length], [200, 2000]);
  });
});

suite.test('POST .../interrupt: 404 item_not_found, 409 item_not_active, 403 under the POST safety rules; refused requests write nothing', async () => {
  const r = buildRoot('refused');
  flow(r, ['item', 'start', '12', '--title', 'Ativo', '--stage', 'implementation']);
  flow(r, ['item', 'start', '14', '--title', 'Já concluído', '--stage', 'implementation']);
  flow(r, ['item', 'done', '14']);
  await withServer(r, async (api) => {
    const PATH = '/api/items/widgets/12/interrupt';
    const body = { reason: 'Parou' };
    const host = await api.interrupt(PATH, body, { host: 'evil.example' });
    assert.deepStrictEqual([host.status, host.json.error.code], [403, 'host_not_allowed']);
    const noHeader = await request(api.port, PATH, { method: 'POST', body: JSON.stringify(body) });
    assert.deepStrictEqual([noHeader.status, noHeader.json.error.code], [403, 'missing_panel_header']);
    const foreign = await api.interrupt(PATH, body, { headers: { Origin: 'http://evil.example' } });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const get = await request(api.port, PATH);
    assert.deepStrictEqual([get.status, get.json.error.code, get.headers.allow], [405, 'method_not_allowed', 'POST']);
    assert.strictEqual((await api.get('/api/items/widgets/12')).item.timeline.length, 1, 'refused requests write nothing');
    const done = await api.interrupt('/api/items/widgets/14/interrupt', body);
    assert.deepStrictEqual([done.status, done.json.error], [409, { code: 'item_not_active', project: 'widgets', number: 14 }]);
    assert.strictEqual((await api.get('/api/items/widgets/14')).item.timeline.length, 2, 'one item-done only');
    const missing = await api.interrupt('/api/items/widgets/99/interrupt', body);
    assert.deepStrictEqual([missing.status, missing.json.error], [404, { code: 'item_not_found', project: 'widgets', number: 99 }]);
    assert.strictEqual((await api.interrupt('/api/items/nao-existe/1/interrupt', body)).status, 404);
    assert.strictEqual((await api.interrupt('/api/items/Widgets!/1/interrupt', body)).status, 404);
  });
});

suite.test('POST .../interrupt without maestro.db answers 404 and creates nothing', async () => {
  const r = buildRoot('no-db');
  await withServer(r, async (api) => {
    const x = await api.interrupt('/api/items/widgets/1/interrupt', { reason: 'Parou' });
    assert.deepStrictEqual([x.status, x.json.error.code], [404, 'item_not_found']);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')));
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
