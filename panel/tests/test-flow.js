'use strict';
// Tests for the new model (#5, ADRs 0001-0003) through the agreed seam only: the bin/flow.js CLI runs as a
// process inside a temporary git repository (with a fictitious remote origin) → temporary maestro.db
// (MAESTRO_DIR) → the server's HTTP API. No test reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('new model: flow CLI → maestro.db → items API');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder (MAESTRO_DIR) and a git repository whose origin points to a fictitious project. */
function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`flow-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  if (remote) git(repo, 'remote', 'add', 'origin', remote);
  return { root, data, repo };
}

function addWorktree(r) {
  git(r.repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  const wt = path.join(r.root, 'floor-1');
  git(r.repo, 'worktree', 'add', '-q', '-b', 'task/1', wt);
  return wt;
}

function env(r, extra = {}) {
  return Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' }, extra);
}

/** Runs the CLI as the maestro would: node bin/flow.js ... in the given folder. */
function flow(r, args, { cwd = r.repo, input, extra } = {}) {
  return spawnSync(process.execPath, [FLOW, ...args], { cwd, env: env(r, extra), input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

/** The same, without waiting (for concurrent writers). */
function flowAsync(r, args, { cwd = r.repo } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FLOW, ...args], { cwd, env: env(r), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr (no ExperimentalWarning)');
  assert.ok(!/ExperimentalWarning|experimental/i.test(x.stdout), x.stdout);
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') },
  });
  try {
    await fn((p) => request(port, p));
  } finally {
    await s.stop();
  }
}

suite.test('start an item and change its stage: the API lists the item and shows it in the right stage', async () => {
  const r = buildRoot('basic');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório em PDF']));
  ok(flow(r, ['stage', '12', 'implementation']));
  await withServer(r, async (get) => {
    const list = await get('/api/items');
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.json.items.length, 1);
    const it = list.json.items[0];
    assert.strictEqual(it.key, 'widgets/12');
    assert.strictEqual(it.number, 12);
    assert.strictEqual(it.tracker, 'github');
    assert.strictEqual(it.tracker_ref, '#12');
    assert.strictEqual(it.title, 'Exportar relatório em PDF');
    assert.strictEqual(it.stage, 'implementation');
    assert.strictEqual(it.project.id, 'widgets');
    const one = await get('/api/items/widgets/12');
    assert.strictEqual(one.status, 200, one.text);
    const item = one.json.item;
    assert.strictEqual(item.stage, 'implementation');
    assert.deepStrictEqual(item.stages.map((s) => [s.id, s.status]), [
      ['specification', 'done'], ['implementation', 'current'], ['final_adjustment', 'pending'], ['pr_ready', 'pending'],
      ['merge', 'pending'], ['hml_validation', 'pending'], ['done', 'pending'],
    ]);
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'stage-changed']);
  });
});

suite.test('an unregistered repository goes to "Sem empresa"; inside a worktree the project is the same', async () => {
  const r = buildRoot('worktree');
  const wt = addWorktree(r);
  const first = flow(r, ['item', 'start', '7', '--title', 'Primeiro item']);
  ok(first);
  assert.ok(/Sem empresa/.test(first.stdout), `says where the project was registered: ${first.stdout}`);
  ok(flow(r, ['stage', '7', 'final_adjustment'], { cwd: wt }));
  ok(flow(r, ['item', 'start', '8', '--title', 'Segundo item', '--stage', 'implementation'], { cwd: wt }));
  await withServer(r, async (get) => {
    const { items } = (await get('/api/items')).json;
    assert.deepStrictEqual(items.map((i) => [i.key, i.stage]).sort(), [['widgets/7', 'final_adjustment'], ['widgets/8', 'implementation']]);
    for (const i of items) assert.deepStrictEqual(i.project, { id: 'widgets', name: 'widgets', tracker: 'github', company: { id: 'unassigned', name: 'Sem empresa' } });
  });
});

suite.test('Azure DevOps: the number shows as "PBI 3100"; the SSH and HTTPS remotes of a repository are the same project', async () => {
  const r = buildRoot('azure', 'https://contoso@dev.azure.com/contoso/CIDAX/_git/cidax-api');
  ok(flow(r, ['item', 'start', '3100', '--title', 'Conciliação de boletos']));
  const other = path.join(r.root, 'other-clone');
  fs.mkdirSync(other);
  git(other, 'init', '-q');
  git(other, 'remote', 'add', 'origin', 'git@ssh.dev.azure.com:v3/contoso/CIDAX/cidax-api');
  ok(flow(r, ['stage', '3100', 'pr_ready'], { cwd: other }));
  await withServer(r, async (get) => {
    const { items } = (await get('/api/items')).json;
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual([items[0].key, items[0].tracker, items[0].tracker_ref, items[0].stage], ['cidax-api/3100', 'azure_devops', 'PBI 3100', 'pr_ready']);
    const one = (await get('/api/items/cidax-api/3100')).json.item;
    assert.strictEqual(one.tracker_ref, 'PBI 3100');
  });
});

suite.test('fields by JSON on standard input arrive intact; arguments win over the JSON', async () => {
  const r = buildRoot('json');
  const title = 'Título com "aspas", acentos (ç, ã) e\nduas linhas — C:\\pasta';
  ok(flow(r, ['item', 'start', '--json', '-'], { input: JSON.stringify({ number: 21, title, stage: 'implementation', role: 'maestro', agent: 'Ária' }) }));
  ok(flow(r, ['stage', '--json', '-'], { input: `\uFEFF${JSON.stringify({ number: '21', stage: 'pr_ready' })}` }));
  ok(flow(r, ['stage', '21', '--json', '-'], { input: JSON.stringify({ number: 99, stage: 'merge' }) }));
  ok(flow(r, ['item', 'start', '22', '--title', 'Pelo argumento', '--json', '-'], { input: JSON.stringify({ number: 23, title: 'Pelo JSON' }) }));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/21')).json.item;
    assert.strictEqual(item.title, title);
    assert.strictEqual(item.stage, 'merge');
    assert.deepStrictEqual(item.timeline[0].agent, { role: 'maestro', name: 'Ária' });
    assert.strictEqual((await get('/api/items/widgets/22')).json.item.title, 'Pelo argumento');
    assert.strictEqual((await get('/api/items/widgets/23')).status, 404);
  });
});

suite.test('invalid data ends with a clear message and exit code 2, writing nothing', async () => {
  const r = buildRoot('invalid');
  const noRepo = path.join(r.root, 'not-a-repo');
  fs.mkdirSync(noRepo);
  ok(flow(r, ['item', 'start', '5', '--title', 'Válido']));
  const cases = [
    [['item', 'start', 'abc', '--title', 'x'], /número de item inválido: "abc"/],
    [['item', 'start', '0', '--title', 'x'], /número de item inválido/],
    [['item', 'start', '6'], /falta o título/],
    [['item', 'start', '6', '--title', 'x', '--stage', 'review'], /etapa desconhecida: "review"/],
    [['item', 'start', '5', '--title', 'De novo'], /já foi iniciado/],
    [['item', 'start', '6', '--title', 'x', '--color', 'azul'], /opção desconhecida: --color/],
    [['item', 'start', '6', '--title'], /falta o valor de --title/],
    [['item', 'finish', '6'], /subcomando desconhecido/],
    [['stage', '6', 'implementation'], /ainda não foi iniciado/],
    [['stage', '5'], /falta a etapa/],
    [['stage', '5', 'implementation', '--role', 'chefe'], /papel inválido: "chefe"/],
    [['stage', '--json', '-'], /JSON da entrada padrão é inválido/, '{"number": 5,'],
    [['stage', '--json', '-'], /precisa ser um objeto/, '[5]'],
    [[], /falta o subcomando/],
  ];
  for (const [args, message, input] of cases) {
    const x = flow(r, args, { input: input === undefined ? '' : input });
    assert.strictEqual(x.status, 2, `${args.join(' ')} → exit ${x.status}: ${x.stderr}`);
    assert.ok(message.test(x.stderr), `${args.join(' ')} → ${x.stderr}`);
    assert.ok(x.stderr.startsWith('erro: ') && !/ExperimentalWarning|at .+\.js:\d+/.test(x.stderr), x.stderr);
  }
  // The temporary root lives inside this repository's folder: the ceiling stops git from climbing to it.
  const outside = flow(r, ['item', 'start', '9', '--title', 'x'], { cwd: noRepo, extra: { GIT_CEILING_DIRECTORIES: r.root } });
  assert.strictEqual(outside.status, 2);
  assert.ok(/git remote origin/.test(outside.stderr), outside.stderr);
  await withServer(r, async (get) => {
    const { items } = (await get('/api/items')).json;
    assert.deepStrictEqual(items.map((i) => [i.key, i.title, i.stage]), [['widgets/5', 'Válido', 'specification']]);
    assert.strictEqual((await get('/api/items/widgets/5')).json.item.timeline.length, 1);
  });
});

suite.test('concurrent processes writing at the same time lose no event (fresh database and unregistered repository)', async () => {
  const r = buildRoot('concurrent');
  const wt = addWorktree(r);
  const N = 12;
  // Phase 1: N processes open the database for the first time and register the same repository at once.
  const starts = await Promise.all(Array.from({ length: N }, (_, i) => flowAsync(r, ['item', 'start', String(i + 1), '--title', `Item ${i + 1}`], { cwd: i % 2 ? wt : r.repo })));
  starts.forEach(ok);
  // Phase 2: N processes change the stage of the same item at once.
  const stages = ['implementation', 'final_adjustment', 'pr_ready', 'merge'];
  const moves = await Promise.all(Array.from({ length: N }, (_, i) => flowAsync(r, ['stage', '1', stages[i % stages.length], '--role', 'worker', '--agent', `w${i}`], { cwd: i % 2 ? wt : r.repo })));
  moves.forEach(ok);
  await withServer(r, async (get) => {
    const { items } = (await get('/api/items')).json;
    assert.deepStrictEqual(items.map((i) => i.number).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1));
    assert.ok(items.every((i) => i.project.id === 'widgets'), 'a single project, registered once');
    const item = (await get('/api/items/widgets/1')).json.item;
    assert.strictEqual(item.timeline.length, 1 + N);
    assert.deepStrictEqual(item.timeline.slice(1).map((e) => e.agent.name).sort(), Array.from({ length: N }, (_, i) => `w${i}`).sort());
    const ids = item.timeline.map((e) => e.id);
    assert.deepStrictEqual(ids, ids.slice().sort((a, b) => a - b), 'timeline in writing order');
    const last = item.timeline[item.timeline.length - 1].payload.stage;
    assert.strictEqual(item.stage, last, 'the current stage is the last one written');
  });
});

suite.test('items API: codes for what does not exist, the server security rules and no database yet', async () => {
  const empty = buildRoot('api-empty');
  await withServer(empty, async (get) => {
    assert.deepStrictEqual((await get('/api/items')).json, { items: [] });
    const none = await get('/api/items/widgets/1');
    assert.deepStrictEqual([none.status, none.json], [404, { error: { code: 'item_not_found', project: 'widgets', number: 1 } }]);
  });
  const r = buildRoot('api');
  ok(flow(r, ['item', 'start', '12', '--title', '<script>alert(1)</script>']));
  const port = await freePort();
  const s = await srv.start({ argv: ['--port', String(port)], env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') } });
  try {
    const one = await request(port, '/api/items/widgets/12');
    assert.strictEqual(one.json.item.title, '<script>alert(1)</script>', 'text goes out raw; the page shows it as text');
    assert.strictEqual(one.headers['cache-control'], 'no-store');
    assert.strictEqual(one.headers['access-control-allow-origin'], undefined);
    assert.strictEqual((await request(port, '/api/items', { host: 'evil.example:80' })).status, 403);
    assert.strictEqual((await request(port, '/api/items/widgets/12', { host: `attacker.test:${port}` })).status, 403);
    assert.strictEqual((await request(port, '/api/items', { method: 'POST' })).status, 403);
    const post = await request(port, '/api/items', { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.deepStrictEqual([post.status, post.json.error.code], [405, 'method_not_allowed']);
    for (const p of ['/api/items/widgets/012', '/api/items/Widgets/12', '/api/items/..%2Fx/12', '/api/items/widgets/12/x', '/api/items/widgets', '/api/items/widgets/-1']) {
      const x = await request(port, p);
      assert.deepStrictEqual([p, x.status, x.json && x.json.error.code], [p, 404, 'route_not_found']);
    }
    const missing = await request(port, '/api/items/widgets/13');
    assert.deepStrictEqual([missing.status, missing.json.error.code], [404, 'item_not_found']);
  } finally {
    await s.stop();
  }
});

suite.test('help is in Portuguese and lists the subcommands', () => {
  const r = buildRoot('help');
  const x = flow(r, ['--help']);
  ok(x);
  assert.ok(/item start <número>/.test(x.stdout) && /stage <número> <etapa>/.test(x.stdout) && /--json -/.test(x.stdout), x.stdout);
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
