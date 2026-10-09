'use strict';
// Tests for the pending decisions of the new model (#10) through the agreed seam only: the bin/flow.js CLI runs as a
// process inside a temporary git repository (with a fictitious remote origin) → temporary maestro.db (MAESTRO_DIR)
// → the server's HTTP API (GET /api/pending-decisions and the item's timeline). No test reads the database or calls
// internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('pending decisions: flow CLI → maestro.db → pending decisions API');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder and git repositories with fictitious origins. */
function buildRoot(name) {
  const root = tmpDir(`pending-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = (folder, remote) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'feature/issue-12');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'inicio');
    return dir;
  };
  return { root, data, repo: repo('repo', 'https://github.com/acme/widgets.git'), repo2: repo('repo2', 'https://github.com/acme/gadgets.git') };
}

/** Runs the CLI outside of Maestri, unless extra sets the Maestri variables of a terminal. */
function flow(r, args, { cwd = r.repo, input, extra = {} } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' }, extra);
  for (const k of ['MAESTRI_TERMINAL_ID', 'MAESTRI_TERMINAL_NAME', 'MAESTRI_WORKSPACE_ID', 'MAESTRI_WORKSPACE_NAME']) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, [FLOW, ...args], { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
  return x;
}

function invalid(x, pattern) {
  assert.strictEqual(x.status, 2, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.ok(/^erro: /.test(x.stderr), x.stderr);
  if (pattern) assert.ok(pattern.test(x.stderr), x.stderr);
}

/** The id the CLI printed when opening ("Pendência P-7 aberta …"). */
function openedId(x) {
  ok(x);
  const m = /\bP-(\d+)\b/.exec(x.stdout);
  assert.ok(m, x.stdout);
  return Number(m[1]);
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') },
  });
  try {
    await fn(async (p, status = 200) => {
      const x = await request(port, p);
      assert.strictEqual(x.status, status, `${p}: ${x.text}`);
      return x.json;
    }, port);
  } finally {
    await s.stop();
  }
}

const list = async (get, query = '') => (await get(`/api/pending-decisions${query}`)).pending_decisions;

/** An item started in implementation with tasks 13 and 14. */
function startItem(r) {
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '12', '--task', '13|Gerar o PDF', '--task', '14|Enviar por e-mail|13']));
}

suite.test('the maestro opens a pending decision on a task; the API shows it with the item, the task and where to answer', async () => {
  const r = buildRoot('open');
  startItem(r);
  const id = openedId(flow(r, [
    'pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--severity', 'high', '--title', 'Revisar a task 13',
    '--context', 'Gera o PDF com o modelo novo.', '--option', 'A: Integrar', '--option', 'B: Pedir ajuste', '--recommendation', 'A: os testes passaram',
  ], { extra: { MAESTRI_WORKSPACE_NAME: 'Contoso', MAESTRI_TERMINAL_NAME: 'Maestro 12', MAESTRI_TERMINAL_ID: 'term-1' } }));
  await withServer(r, async (get) => {
    const [p, ...rest] = await list(get);
    assert.strictEqual(rest.length, 0);
    assert.deepStrictEqual(p, {
      id, kind: 'task_review', severity: 'high', status: 'open', title: 'Revisar a task 13', context: 'Gera o PDF com o modelo novo.',
      options: ['A: Integrar', 'B: Pedir ajuste'], recommendation: 'A: os testes passaram',
      item: {
        key: 'widgets/12', number: 12, tracker_ref: '#12', title: 'Exportar relatório', stage: 'implementation',
        project: { id: 'widgets', name: 'widgets', tracker: 'github', company: { id: 'unassigned', name: 'Sem empresa' } },
      },
      task: { number: 13, title: 'Gerar o PDF', state: 'waiting' },
      maestri: { workspace: 'Contoso', terminal: 'Maestro 12' },
      opened_at: p.opened_at, opened_by: { role: 'maestro', name: null },
      closed_at: null, closed_by: null, resolution: null, decision: null, reason: null,
    });
    assert.ok(Date.parse(p.opened_at) > 0, p.opened_at);
  });
});

suite.test('integrating a task resolves its review pending decision, without an extra event; the others stay open', async () => {
  const r = buildRoot('integrate');
  startItem(r);
  const review13 = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--title', 'Revisar a task 13']));
  const review14 = openedId(flow(r, ['pending', 'open', '12', '--task', '14', '--kind', 'task_review', '--title', 'Revisar a task 14']));
  const blocked = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'worker_blocked', '--severity', 'critical', '--title', 'Falta o certificado']));
  ok(flow(r, ['task', 'integrate', '12', '13', '--sha', 'a1b2c3d4e5f6', '--agent', 'Bento']));
  await withServer(r, async (get) => {
    const all = await list(get);
    const byId = (id) => all.find((p) => p.id === id);
    assert.deepStrictEqual(
      [byId(review13).status, byId(review13).resolution, byId(review13).decision, byId(review13).closed_by],
      ['resolved', 'task_integrated', null, { role: 'maestro', name: 'Bento' }],
    );
    assert.ok(byId(review13).closed_at);
    assert.deepStrictEqual([byId(review14).status, byId(blocked).status], ['open', 'open']);
    // Open ones first, by severity: the critical one before the normal one.
    assert.deepStrictEqual(all.map((p) => p.id), [blocked, review14, review13]);
    const types = (await get('/api/items/widgets/12')).item.timeline.map((e) => e.type);
    assert.deepStrictEqual(types.slice(-1), ['task-integrated'], 'the integration records no pending decision event');
  });
});

suite.test('the maestro resolves with the owner\'s decision or cancels; the decision stays in the item\'s timeline', async () => {
  const r = buildRoot('resolve');
  startItem(r);
  const input = JSON.stringify({
    number: 12, kind: 'decision', severity: 'low', title: 'Usar "fila" ou cron?',
    context: 'Linha 1 com acentuação\nLinha 2', options: ['A: Fila', 'B: Cron'], recommendation: 'A',
    workspace: 'Pessoal', terminal: 'Maestro widgets',
  });
  const decision = openedId(flow(r, ['pending', 'open', '--json', '-'], { input }));
  const parallel = openedId(flow(r, ['pending', 'open', '12', '--kind', 'parallelize', '--title', 'Paralelizar 13 e 14?']));
  ok(flow(r, ['pending', 'resolve', `P-${decision}`, '--json', '-', '--role', 'owner'], { input: JSON.stringify({ decision: 'Fila, com retentativa.\nSem cron.' }) }));
  ok(flow(r, ['pending', 'cancel', String(parallel), '--reason', 'O grafo mudou']));
  invalid(flow(r, ['pending', 'resolve', String(decision), '--decision', 'De novo']), /já está resolvida/);
  invalid(flow(r, ['pending', 'resolve', String(parallel), '--decision', 'Tarde']), /já está cancelada/);
  await withServer(r, async (get) => {
    const all = await list(get);
    const d = all.find((p) => p.id === decision);
    assert.deepStrictEqual(
      [d.status, d.resolution, d.decision, d.context, d.options, d.maestri, d.task, d.closed_by],
      ['resolved', 'decision', 'Fila, com retentativa.\nSem cron.', 'Linha 1 com acentuação\nLinha 2', ['A: Fila', 'B: Cron'], { workspace: 'Pessoal', terminal: 'Maestro widgets' }, null, { role: 'owner', name: null }],
    );
    const c = all.find((p) => p.id === parallel);
    assert.deepStrictEqual([c.status, c.resolution, c.reason, c.maestri], ['canceled', null, 'O grafo mudou', { workspace: null, terminal: null }]);
    const timeline = (await get('/api/items/widgets/12')).item.timeline.filter((e) => e.type.startsWith('pending-decision-'));
    assert.deepStrictEqual(timeline.map((e) => [e.type, e.payload.pending_decision || e.id]), [
      ['pending-decision-opened', decision], ['pending-decision-opened', parallel],
      ['pending-decision-resolved', decision], ['pending-decision-canceled', parallel],
    ]);
    assert.strictEqual(timeline[2].payload.decision, 'Fila, com retentativa.\nSem cron.');
  });
});

suite.test('the API filters by company, project, severity and status; each count ignores only its own filter', async () => {
  const r = buildRoot('filters');
  startItem(r);
  ok(flow(r, ['item', 'start', '7', '--title', 'Outro projeto', '--stage', 'implementation'], { cwd: r.repo2 }));
  const high = openedId(flow(r, ['pending', 'open', '12', '--kind', 'finding', '--severity', 'high', '--title', 'Achado']));
  const low = openedId(flow(r, ['pending', 'open', '12', '--kind', 'hml', '--severity', 'low', '--title', 'Cenário 3 reprovado']));
  const other = openedId(flow(r, ['pending', 'open', '7', '--kind', 'decision', '--severity', 'high', '--title', 'No gadgets'], { cwd: r.repo2 }));
  ok(flow(r, ['pending', 'resolve', String(low), '--decision', 'Aceito']));
  await withServer(r, async (get) => {
    const ids = async (q) => (await list(get, q)).map((p) => p.id);
    assert.deepStrictEqual(await ids(''), [high, other, low]);
    assert.deepStrictEqual(await ids('?project=gadgets'), [other]);
    assert.deepStrictEqual(await ids('?project=widgets,gadgets&status=open'), [high, other]);
    assert.deepStrictEqual(await ids('?severity=high&project=widgets'), [high]);
    assert.deepStrictEqual(await ids('?status=resolved'), [low]);
    assert.deepStrictEqual(await ids('?company=unassigned&severity=low,normal'), [low]);
    assert.deepStrictEqual(await ids('?company=contoso'), []);
    const x = await get('/api/pending-decisions?project=widgets&status=open');
    assert.deepStrictEqual(x.counts, { status: { open: 1, resolved: 1, canceled: 0 }, severity: { critical: 0, high: 1, normal: 0, low: 0 } });
    assert.deepStrictEqual(x.companies, [{ id: 'unassigned', name: 'Sem empresa' }]);
    const bad = await get('/api/pending-decisions?severity=alta', 400);
    assert.deepStrictEqual(bad.error, { code: 'invalid_filter', param: 'severity', value: 'alta', allowed: ['critical', 'high', 'normal', 'low'] });
    assert.strictEqual((await get('/api/pending-decisions?status=aberta', 400)).error.param, 'status');
  });
});

suite.test('without maestro.db the list is empty and nothing is created', async () => {
  const r = buildRoot('empty');
  await withServer(r, async (get) => {
    assert.deepStrictEqual(await get('/api/pending-decisions'), {
      pending_decisions: [], counts: { status: { open: 0, resolved: 0, canceled: 0 }, severity: { critical: 0, high: 0, normal: 0, low: 0 } }, companies: [],
    });
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')));
});

suite.test('invalid data fails with exit 2 and a clear message, and records nothing', async () => {
  const r = buildRoot('invalid');
  invalid(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Antes do item']), /ainda não foi iniciado/);
  startItem(r);
  invalid(flow(r, ['pending', 'open', '12', '--title', 'Sem tipo']), /falta o tipo/);
  invalid(flow(r, ['pending', 'open', '12', '--kind', 'aprovacao', '--title', 'x']), /tipo de pendência inválido: "aprovacao"/);
  invalid(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--severity', 'alta', '--title', 'x']), /severidade inválida/);
  invalid(flow(r, ['pending', 'open', '12', '--kind', 'decision']), /falta o título/);
  invalid(flow(r, ['pending', 'open', '12', '--kind', 'task_review', '--title', 'Revisar']), /precisa da task/);
  invalid(flow(r, ['pending', 'open', '12', '--kind', 'task_review', '--task', '99', '--title', 'Revisar']), /a task 99 não é do item/);
  invalid(flow(r, ['pending', 'open', '--json', '-'], { input: JSON.stringify({ number: 12, kind: 'decision', title: 'x', options: 'A: sim' }) }), /"options"/);
  invalid(flow(r, ['pending', 'resolve', 'P-1']), /falta a decisão/);
  invalid(flow(r, ['pending', 'resolve', 'xyz', '--decision', 'a']), /id de pendência inválido/);
  invalid(flow(r, ['pending', 'resolve', 'P-999', '--decision', 'a']), /P-999 não existe no projeto "widgets"/);
  invalid(flow(r, ['pending', 'answer', '1']), /subcomando desconhecido: "pending answer"/);
  // A pending decision of another project is not found from this repository.
  ok(flow(r, ['item', 'start', '7', '--title', 'Outro', '--stage', 'implementation'], { cwd: r.repo2 }));
  const other = openedId(flow(r, ['pending', 'open', '7', '--kind', 'decision', '--title', 'De gadgets'], { cwd: r.repo2 }));
  invalid(flow(r, ['pending', 'cancel', String(other)]), /não existe no projeto "widgets"/);
  await withServer(r, async (get) => {
    assert.deepStrictEqual((await list(get)).map((p) => p.id), [other]);
  });
});

suite.test('the panel no longer answers pending decisions: the answer route and the Brain notice are gone', async () => {
  const r = buildRoot('no-answer');
  await withServer(r, async (get, port) => {
    const x = await request(port, '/api/pending-decisions/P-0001/answer', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: '{"option":"A"}' });
    assert.deepStrictEqual([x.status, x.json], [404, { error: { code: 'route_not_found' } }]);
    const post = await request(port, '/api/pending-decisions', { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.strictEqual(post.status, 405);
    const state = await get('/api/state');
    assert.ok(!('answers' in state), 'no brain notice in /api/state');
  });
});

suite.test('help lists the pending subcommands, kinds and where the owner answers', () => {
  const r = buildRoot('help');
  const x = ok(flow(r, ['--help']));
  for (const s of ['pending open <número>', 'pending resolve <id>', 'pending cancel <id>', 'task_review', 'worker_blocked', 'parallelize', 'MAESTRI_WORKSPACE_NAME', 'MAESTRI_TERMINAL_NAME']) {
    assert.ok(x.stdout.includes(s), `${s} in:\n${x.stdout}`);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
