'use strict';
// Tests for the end of an item's flow (#9): integration branch and PR, final adjustment, HML validation and the
// item's conclusion. Same seam as test-flow.js: the bin/flow.js CLI runs as a process inside a temporary git
// repository (fictitious remote origin) → temporary maestro.db (MAESTRO_DIR) → the server's HTTP API.
// No test reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('flow CLI: PR, final adjustment, HML and conclusion → items API');
const roots = [];

const GH_PR = 'https://github.com/acme/widgets/pull/34';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder (MAESTRO_DIR) and a git repository whose origin points to a fictitious project. */
function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`delivery-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', remote);
  return { root, data, repo };
}

/** Runs the CLI as the maestro (or the owner) would: node bin/flow.js ... in the project's repository. */
function flow(r, args, { input } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' });
  return spawnSync(process.execPath, [FLOW, ...args], { cwd: r.repo, env, input: input === undefined ? '' : input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
}

function invalid(x, message) {
  assert.strictEqual(x.status, 2, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.ok(x.stderr.startsWith('erro: '), x.stderr);
  assert.ok(message.test(x.stderr), x.stderr);
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') },
  });
  try {
    await fn(async (p) => {
      const x = await request(port, p);
      assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
      return x.json;
    });
  } finally {
    await s.stop();
  }
}

suite.test('the PR moves the item: draft keeps it in Implementation, ready → PR pronto, merged → Merge', async () => {
  const r = buildRoot('pr');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']));
  ok(flow(r, ['pr', '12', 'draft', '--url', GH_PR, '--branch', 'feature/issue-12']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'implementation');
    assert.deepStrictEqual([item.pr.state, item.pr.url, item.pr.number, item.pr.branch], ['draft', GH_PR, 34, 'feature/issue-12']);
  });
  ok(flow(r, ['pr', '12', 'ready']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'pr_ready');
    assert.deepStrictEqual([item.pr.state, item.pr.url, item.pr.number, item.pr.branch], ['ready', GH_PR, 34, 'feature/issue-12'], 'URL, number and branch are kept');
  });
  ok(flow(r, ['pr', '12', 'merged']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'merge');
    assert.strictEqual(item.pr.state, 'merged');
    assert.ok(item.pr.merged_at && item.pr.ready_at && item.pr.opened_at);
    assert.deepStrictEqual(item.timeline.map((e) => [e.type, e.payload.state]).slice(1),
      [['pr-changed', 'draft'], ['pr-changed', 'ready'], ['pr-changed', 'merged']]);
  });
});

suite.test('the whole end of the flow: Final adjustment → PR ready → Merge → HML validation → Done, then it leaves the active list', async () => {
  const r = buildRoot('full', 'https://contoso@dev.azure.com/contoso/CIDAX/_git/cidax-api');
  const PR = 'https://dev.azure.com/contoso/CIDAX/_git/cidax-api/pullrequest/812';
  const CARD = 'https://dev.azure.com/contoso/CIDAX/_workitems/edit/3100';
  ok(flow(r, ['item', 'start', '3100', '--title', 'Conciliação de boletos', '--stage', 'implementation']));
  ok(flow(r, ['item', 'start', '3101', '--title', 'Outro item', '--stage', 'implementation']));
  ok(flow(r, ['pr', '3100', 'draft', '--url', PR, '--branch', 'feature/pbi-3100']));
  ok(flow(r, ['final-adjustment', '3100', 'open']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/cidax-api/3100')).item;
    assert.strictEqual(item.stage, 'final_adjustment');
    assert.deepStrictEqual([item.final_adjustment.status, item.final_adjustment.finished_at], ['open', null]);
    assert.ok(item.final_adjustment.opened_at);
  });
  const summary = 'Testes ok; corrigi 2 nits\ndo revisor ("aspas" e acentos: ç)';
  ok(flow(r, ['final-adjustment', '--json', '-'], { input: JSON.stringify({ number: 3100, action: 'result', outcome: 'passed', summary }) }));
  ok(flow(r, ['pr', '3100', 'ready']));
  ok(flow(r, ['pr', '3100', 'merged']));
  ok(flow(r, ['hml', '3100', '--passed', '7', '--failed', '1', '--blocked', '2', '--card', CARD, '--role', 'owner']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/cidax-api/3100')).item;
    assert.strictEqual(item.stage, 'hml_validation');
    assert.deepStrictEqual([item.final_adjustment.status, item.final_adjustment.summary], ['passed', summary]);
    assert.deepStrictEqual([item.pr.state, item.pr.number, item.pr.url, item.pr.branch], ['merged', 812, PR, 'feature/pbi-3100']);
    assert.deepStrictEqual(item.hml, { outcome: 'failed', passed: 7, failed: 1, blocked: 2, card_url: CARD, summary: null, recorded_at: item.hml.recorded_at });
    assert.strictEqual(item.timeline[item.timeline.length - 1].agent.role, 'owner');
    assert.deepStrictEqual(item.stages.map((s) => s.status), ['done', 'done', 'done', 'done', 'done', 'current', 'pending']);
    assert.strictEqual(item.active, true);
    assert.strictEqual(item.completed_at, null);
  });
  ok(flow(r, ['hml', '3100', '--passed', '10']));
  ok(flow(r, ['item', 'done', '3100']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/cidax-api/3100')).item;
    assert.strictEqual(item.stage, 'done');
    assert.strictEqual(item.hml.outcome, 'approved');
    assert.strictEqual(item.active, false);
    assert.strictEqual(item.completed_at, item.stage_since);
    assert.deepStrictEqual(item.timeline.slice(-2).map((e) => e.type), ['hml-recorded', 'item-done']);
    const all = (await get('/api/items')).items;
    assert.deepStrictEqual(all.map((i) => [i.key, i.active]).sort(), [['cidax-api/3100', false], ['cidax-api/3101', true]]);
    assert.deepStrictEqual((await get('/api/items?active=1')).items.map((i) => i.key), ['cidax-api/3101'], 'the done item leaves the active list');
    assert.deepStrictEqual((await get('/api/items?active=0')).items.map((i) => i.key), ['cidax-api/3100'], 'and can still be found');
  });
});

suite.test('a project without HML validation skips that stage: Merge → Done, and an HML result is refused', async () => {
  const r = buildRoot('no-hml');
  // Arrange only: no subcommand declares a project's stages yet, so the project is registered straight in the store.
  const { openStore, STAGES } = require(path.join(REPO, 'bin', 'flow-store.js'));
  const store = openStore({ dir: r.data });
  store.transaction(() => {
    store.ensureCompany('personal', 'Pessoal', '2026-10-01T09:00:00-03:00');
    store.addProject({ id: 'widgets', name: 'Widgets', companyId: 'personal', tracker: 'github', stages: STAGES.filter((s) => s !== 'hml_validation'),
      remote: 'github.com/acme/widgets', at: '2026-10-01T09:00:00-03:00' });
  });
  store.close();
  ok(flow(r, ['item', 'start', '40', '--title', 'Sem HML', '--stage', 'implementation']));
  ok(flow(r, ['pr', '40', 'ready', '--url', 'https://github.com/acme/widgets/pull/41']));
  ok(flow(r, ['pr', '40', 'merged']));
  invalid(flow(r, ['hml', '40', '--passed', '3']), /não usa a etapa "hml_validation"/);
  ok(flow(r, ['item', 'done', '40']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/40')).item;
    assert.strictEqual(item.project.company.name, 'Pessoal', 'the registered project was used');
    assert.strictEqual(item.stage, 'done');
    assert.strictEqual(item.hml, null);
    assert.deepStrictEqual(item.stages.map((s) => [s.id, s.status]), [
      ['specification', 'done'], ['implementation', 'done'], ['final_adjustment', 'done'], ['pr_ready', 'done'], ['merge', 'done'], ['done', 'current'],
    ]);
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'pr-changed', 'pr-changed', 'item-done']);
  });
});

suite.test('a draft PR takes an item still in Specification to Implementation, but never takes an item back', async () => {
  const r = buildRoot('draft');
  ok(flow(r, ['item', 'start', '1', '--title', 'Em especificação']));
  ok(flow(r, ['pr', '1', 'draft', '--url', 'https://github.com/acme/widgets/pull/2']));
  ok(flow(r, ['item', 'start', '3', '--title', 'Já em PR pronto', '--stage', 'pr_ready']));
  ok(flow(r, ['pr', '3', 'draft', '--url', 'https://github.com/acme/widgets/pull/4', '--pr', '44']));
  await withServer(r, async (get) => {
    assert.strictEqual((await get('/api/items/widgets/1')).item.stage, 'implementation');
    const three = (await get('/api/items/widgets/3')).item;
    assert.strictEqual(three.stage, 'pr_ready');
    assert.strictEqual(three.pr.number, 44, '--pr wins over the number in the URL');
  });
});

suite.test('links only for the trackers\' domains; invalid data ends with exit code 2 and writes nothing', async () => {
  const r = buildRoot('invalid');
  ok(flow(r, ['item', 'start', '5', '--title', 'Válido', '--stage', 'implementation']));
  const cases = [
    [['pr', '5', 'draft', '--url', 'https://evil.example/acme/widgets/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'http://github.com/acme/widgets/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'javascript:alert(1)'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'https://github.com.evil.example/x/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'https://user:pw@github.com/acme/widgets/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'ready'], /falta a URL do PR/],
    [['pr', '5'], /falta o estado do PR/],
    [['pr', '5', 'closed', '--url', GH_PR], /estado de PR inválido: "closed"/],
    [['pr', '5', 'draft', '--url', GH_PR, '--pr', 'x'], /número de PR inválido/],
    [['pr', '5', 'draft', '--url', GH_PR, '--branch', 'a b'], /nome de branch inválido/],
    [['pr', '6', 'draft', '--url', GH_PR], /ainda não foi iniciado/],
    [['final-adjustment', '5', 'result', '--outcome', 'passed'], /não tem ajuste final aberto/],
    [['final-adjustment', '5', 'close'], /ação de ajuste final inválida/],
    [['final-adjustment', '5', 'open', '--outcome', 'passed'], /não leva --outcome/],
    [['hml', '5'], /pelo menos um maior que 0/],
    [['hml', '5', '--passed', '-1'], /quantidade inválida em --passed/],
    [['hml', '5', '--passed', '1', '--card', 'https://trello.com/c/abc'], /--card precisa ser https de um tracker/],
    [['hml', '--json', '-'], /campo "summary" do JSON precisa ser texto/, JSON.stringify({ number: 5, passed: 1, summary: 3 })],
    [['item', 'done'], /falta o número do item/],
  ];
  for (const [args, message, input] of cases) invalid(flow(r, args, { input }), message);
  ok(flow(r, ['final-adjustment', '5', 'open']));
  invalid(flow(r, ['final-adjustment', '5', 'result', '--outcome', 'maybe']), /resultado do ajuste final inválido/);
  ok(flow(r, ['item', 'done', '5']));
  invalid(flow(r, ['item', 'done', '5']), /já está concluído/);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/5')).item;
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'final-adjustment-opened', 'item-done']);
    assert.strictEqual(item.pr, null);
  });
});

suite.test('the active filter of the list only takes 1 or 0', async () => {
  const r = buildRoot('filter');
  ok(flow(r, ['item', 'start', '1', '--title', 'Ativo']));
  const port = await freePort();
  const s = await srv.start({ argv: ['--port', String(port)], env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') } });
  try {
    const bad = await request(port, '/api/items?active=talvez');
    assert.deepStrictEqual([bad.status, bad.json.error], [400, { code: 'invalid_param', param: 'active', value: 'talvez', expected: 'flag' }]);
    assert.strictEqual((await request(port, '/api/items?active=1')).json.items.length, 1);
    assert.strictEqual((await request(port, '/api/items?active=0')).json.items.length, 0);
  } finally {
    await s.stop();
  }
});

suite.test('help lists the new subcommands', () => {
  const r = buildRoot('help');
  const x = flow(r, ['--help']);
  ok(x);
  for (const re of [/pr <número> draft\|ready\|merged/, /final-adjustment <número> open/, /final-adjustment <número> result --outcome/, /hml <número> --passed/, /item done <número>/]) {
    assert.ok(re.test(x.stdout), `${re}\n${x.stdout}`);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
