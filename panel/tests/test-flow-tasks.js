'use strict';
// Tests for the tasks of an item (#7) through the agreed seam only: the bin/flow.js CLI runs as a process inside a
// temporary git repository (with a fictitious remote origin) → temporary maestro.db (MAESTRO_DIR) → the server's
// HTTP API. The "maestri" is a fake script (FLOW_MAESTRI_CLI) that only records its arguments. No test reads the
// database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('tasks of an item: flow CLI → maestro.db → items API');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder, a git repository with a fictitious origin and a fake maestri that writes argv-<n>.json. */
function buildRoot(name) {
  const root = tmpDir(`tasks-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'feature/issue-12');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  const fake = path.join(root, 'fake-maestri.js');
  fs.writeFileSync(fake, `require('fs').writeFileSync(require('path').join(__dirname, 'argv-' + process.hrtime.bigint() + '.json'), JSON.stringify(process.argv.slice(2)));\n`);
  return { root, data, repo, fake };
}

/** A floor: a worktree of the repository on the given branch. */
function addFloor(r, name, branch) {
  const wt = path.join(r.root, name);
  git(r.repo, 'worktree', 'add', '-q', '-b', branch, wt);
  return wt;
}

/** Runs the CLI: outside of Maestri by default; { maestri: true } runs it as a terminal of a Maestri floor. */
function flow(r, args, { cwd = r.repo, input, maestri = false, extra = {} } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', FLOW_MAESTRI_CLI: r.fake }, extra);
  delete env.MAESTRI_TERMINAL_ID;
  if (maestri) env.MAESTRI_TERMINAL_ID = 'terminal-teste';
  return spawnSync(process.execPath, [FLOW, ...args], { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
}

/** Arguments the fake maestri received, in call order. */
const maestriCalls = (r) => fs.readdirSync(r.root).filter((n) => /^argv-\d+\.json$/.test(n))
  .sort((a, b) => (BigInt(a.slice(5, -5)) < BigInt(b.slice(5, -5)) ? -1 : 1))
  .map((n) => JSON.parse(fs.readFileSync(path.join(r.root, n), 'utf8')));

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

const tasksOf = async (get, key) => (await get(`/api/items/${key}`)).item.tasks;
const byNumber = (tasks, n) => tasks.find((t) => t.number === n);

suite.test('a task goes dispatch → working → review → integrated, and the API shows each state', async () => {
  const r = buildRoot('lifecycle');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '12', '--task', '13|Gerar o PDF', '--task', '14|Enviar por e-mail|13']));
  const floor = addFloor(r, 'floor-13', 'task/13-gerar-pdf');
  await withServer(r, async (get) => {
    let tasks = await tasksOf(get, 'widgets/12');
    assert.deepStrictEqual(tasks.map((t) => [t.number, t.title, t.state, t.blocked_by]), [
      [13, 'Gerar o PDF', 'waiting', []],
      [14, 'Enviar por e-mail', 'waiting', [13]],
    ]);

    ok(flow(r, ['task', 'dispatch', '12', '13', '--floor', 'Gerar PDF', '--worker', 'Ária', '--branch', 'task/13-gerar-pdf']));
    let t13 = byNumber(await tasksOf(get, 'widgets/12'), 13);
    assert.deepStrictEqual([t13.state, t13.floor, t13.worker, t13.branch, t13.sha], ['working', 'Gerar PDF', 'Ária', 'task/13-gerar-pdf', null]);

    ok(flow(r, ['status', 'Testes verdes, ligando a tela', '--progress', '2/5'], { cwd: floor, maestri: true }));
    t13 = byNumber(await tasksOf(get, 'widgets/12'), 13);
    assert.deepStrictEqual([t13.state, t13.status_text, t13.progress], ['working', 'Testes verdes, ligando a tela', { done: 2, total: 5 }]);

    ok(flow(r, ['status', 'Pronto para revisar', '--state', 'review'], { cwd: floor, maestri: true }));
    assert.strictEqual(byNumber(await tasksOf(get, 'widgets/12'), 13).state, 'review');

    ok(flow(r, ['task', 'integrate', '12', '13', '--sha', 'a1b2c3d4e5f6', '--sha-before', '0f9e8d7']));
    tasks = await tasksOf(get, 'widgets/12');
    t13 = byNumber(tasks, 13);
    assert.deepStrictEqual([t13.state, t13.sha, t13.sha_before], ['integrated', 'a1b2c3d4e5f6', '0f9e8d7']);
    assert.strictEqual(byNumber(tasks, 14).state, 'waiting');
    const types = (await get('/api/items/widgets/12')).item.timeline.map((e) => [e.type, e.task_number]);
    assert.deepStrictEqual(types, [['item-started', null], ['task-graph', null], ['task-dispatched', 13], ['task-status', 13], ['task-status', 13], ['task-integrated', 13]]);
  });
  assert.deepStrictEqual(maestriCalls(r), [
    ['floor', 'status', 'Testes verdes, ligando a tela', '--state', 'working', '--progress', '2/5'],
    ['floor', 'status', 'Pronto para revisar', '--state', 'review'],
  ]);
});

suite.test('an item without a task graph shows as one task, itself; outside of Maestri status only records', async () => {
  const r = buildRoot('self');
  ok(flow(r, ['item', 'start', '12', '--title', 'Corrigir o rodapé', '--stage', 'implementation']));
  await withServer(r, async (get) => {
    let [task] = await tasksOf(get, 'widgets/12');
    assert.deepStrictEqual([task.number, task.title, task.self, task.state, task.blocked_by], [12, 'Corrigir o rodapé', true, 'waiting', []]);
    ok(flow(r, ['task', 'dispatch', '12', '12', '--worker', 'subagente', '--branch', 'feature/issue-12']));
    // A subagent works on the item's branch; with --item, an item with a single task needs no --task.
    const x = flow(r, ['status', 'Implementando o rodapé', '--item', '12', '--agent', 'subagente']);
    ok(x);
    assert.ok(/só gravado/.test(x.stdout), x.stdout);
    const tasks = await tasksOf(get, 'widgets/12');
    assert.strictEqual(tasks.length, 1);
    [task] = tasks;
    assert.deepStrictEqual([task.number, task.self, task.state, task.worker, task.floor, task.branch, task.status_text], [12, true, 'working', 'subagente', null, 'feature/issue-12', 'Implementando o rodapé']);
    const status = (await get('/api/items/widgets/12')).item.timeline.find((e) => e.type === 'task-status');
    assert.deepStrictEqual([status.agent, status.payload.maestri], [{ role: 'worker', name: 'subagente' }, 'outside']);
  });
  assert.deepStrictEqual(maestriCalls(r), [], 'outside of Maestri the maestri executable is never called');
});

suite.test('every task state: waiting, working, review, blocked, integrated and out; a new graph replaces the old one', async () => {
  const r = buildRoot('states');
  ok(flow(r, ['item', 'start', '20', '--title', 'Carrinho salvo', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '20', '--task', '21|Modelo', '--task', '22|Velho']));
  ok(flow(r, ['task', 'graph', '20', '--task', '21|Modelo do carrinho', '--task', '22|API|21', '--task', '23|Tela|21,22',
    '--task', '24|Sincronizar | entre dispositivos|22', '--task', '25|Fora do escopo', '--task', '26|Docs', '--out', '25']));
  for (const n of [21, 22, 24, 26]) ok(flow(r, ['task', 'dispatch', '20', String(n), '--floor', `F${n}`, '--worker', `W${n}`, '--branch', `task/${n}-x`]));
  ok(flow(r, ['task', 'integrate', '20', '21', '--sha', 'ABCDEF1']));
  ok(flow(r, ['status', 'Depois de integrada', '--state', 'working', '--item', '20', '--task', '21']));
  ok(flow(r, ['status', 'Pronta', '--state', 'done', '--item', '20', '--task', '22']));
  ok(flow(r, ['status', 'Preciso de uma decisão', '--state', 'blocked', '--item', '20', '--task', '24']));
  await withServer(r, async (get) => {
    let tasks = await tasksOf(get, 'widgets/20');
    assert.deepStrictEqual(tasks.map((x) => [x.number, x.title, x.state, x.blocked_by]), [
      [21, 'Modelo do carrinho', 'integrated', []],
      [22, 'API', 'review', [21]],
      [23, 'Tela', 'waiting', [21, 22]],
      [24, 'Sincronizar | entre dispositivos', 'blocked', [22]],
      [25, 'Fora do escopo', 'out', []],
      [26, 'Docs', 'working', []],
    ]);
    assert.deepStrictEqual([tasks[0].sha, tasks[0].status_text], ['abcdef1', 'Depois de integrada']);
    assert.deepStrictEqual([tasks[3].floor, tasks[3].worker, tasks[3].branch], ['F24', 'W24', 'task/24-x']);
    // Rework: dispatching an integrated task again puts it back to work.
    ok(flow(r, ['task', 'dispatch', '20', '21', '--floor', 'F21b', '--worker', 'W21b', '--branch', 'task/21-ajuste']));
    tasks = await tasksOf(get, 'widgets/20');
    assert.deepStrictEqual([tasks[0].state, tasks[0].floor, tasks[0].status_text], ['working', 'F21b', null]);
  });
});

suite.test('status finds its task by the branch: the dispatched branch, else task/<n>-…; --item settles an ambiguity', async () => {
  const r = buildRoot('branch');
  ok(flow(r, ['item', 'start', '30', '--title', 'Item A', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '30', '--task', '31|Primeira', '--task', '32|Segunda']));
  ok(flow(r, ['item', 'start', '40', '--title', 'Item B', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '40', '--task', '32|Repetida no outro item']));
  ok(flow(r, ['task', 'dispatch', '30', '31', '--floor', 'Primeira', '--worker', 'Ária', '--branch', 'feature/primeira']));
  const byDispatch = addFloor(r, 'floor-a', 'feature/primeira');
  const byName = addFloor(r, 'floor-b', 'task/31-outro-nome');
  const ambiguous = addFloor(r, 'floor-c', 'task/32-segunda');
  const unknown = addFloor(r, 'floor-d', 'experimento');
  ok(flow(r, ['status', 'Pela branch despachada'], { cwd: byDispatch, maestri: true }));
  ok(flow(r, ['status', 'Pelo nome da branch', '--state', 'blocked'], { cwd: byName }));
  const amb = flow(r, ['status', 'Qual item?'], { cwd: ambiguous });
  assert.strictEqual(amb.status, 2, amb.stderr);
  assert.ok(/mais de um item \(30, 40\).*--item/.test(amb.stderr), amb.stderr);
  ok(flow(r, ['status', 'Agora com o item', '--item', '40'], { cwd: ambiguous }));
  const none = flow(r, ['status', 'Sem task'], { cwd: unknown });
  assert.strictEqual(none.status, 2, none.stderr);
  assert.ok(/não sei de qual task.*experimento/.test(none.stderr), none.stderr);
  await withServer(r, async (get) => {
    const a = await tasksOf(get, 'widgets/30');
    assert.deepStrictEqual(a.map((x) => [x.number, x.state, x.status_text]), [[31, 'blocked', 'Pelo nome da branch'], [32, 'waiting', null]]);
    const b = await tasksOf(get, 'widgets/40');
    assert.deepStrictEqual(b.map((x) => [x.number, x.state, x.status_text]), [[32, 'working', 'Agora com o item']]);
  });
  assert.deepStrictEqual(maestriCalls(r), [['floor', 'status', 'Pela branch despachada', '--state', 'working']]);
});

suite.test('the final adjustment floor (task/<item>-ajuste-final) is not a task: status there finds no task and records nothing', async () => {
  const r = buildRoot('final-adjustment');
  ok(flow(r, ['item', 'start', '60', '--title', 'Issue sem filhas', '--stage', 'implementation']));
  const floor = addFloor(r, 'floor-ajuste', 'task/60-ajuste-final');
  const x = flow(r, ['status', 'Revisando tudo'], { cwd: floor });
  assert.strictEqual(x.status, 2, x.stderr);
  assert.ok(/não sei de qual task.*task\/60-ajuste-final/.test(x.stderr), x.stderr);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/60')).item;
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started']);
  });
});

suite.test('when maestri floor status fails the event is still recorded and the command ends with exit 1', async () => {
  const r = buildRoot('maestri-fails');
  ok(flow(r, ['item', 'start', '50', '--title', 'Falha do Maestri', '--stage', 'implementation']));
  const failing = path.join(r.root, 'failing-maestri.js');
  fs.writeFileSync(failing, `process.stderr.write('This terminal is not on a floor\\n'); process.exit(3);\n`);
  const x = flow(r, ['status', 'Trabalhando', '--item', '50'], { maestri: true, extra: { FLOW_MAESTRI_CLI: failing } });
  assert.strictEqual(x.status, 1, x.stderr);
  assert.ok(/gravado no painel, mas o maestri floor status falhou: This terminal is not on a floor/.test(x.stderr), x.stderr);
  const missing = flow(r, ['status', 'Sem maestri', '--item', '50'], { maestri: true, extra: { FLOW_MAESTRI_CLI: path.join(r.root, 'nao-existe.exe') } });
  assert.strictEqual(missing.status, 1, missing.stderr);
  assert.ok(/não achei o executável/.test(missing.stderr), missing.stderr);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/50')).item;
    assert.deepStrictEqual(item.timeline.filter((e) => e.type === 'task-status').map((e) => [e.task_number, e.payload.maestri]), [[50, 'failed'], [50, 'failed']]);
    assert.strictEqual(item.tasks[0].state, 'working');
  });
});

suite.test('graph, dispatch, integration and status by JSON on standard input; arguments win over the JSON', async () => {
  const r = buildRoot('json');
  ok(flow(r, ['item', 'start', '60', '--title', 'JSON', '--stage', 'implementation']));
  const title = 'Título com "aspas", acentos (ç, ã) — C:\\pasta';
  ok(flow(r, ['task', 'graph', '--json', '-'], { input: JSON.stringify({ number: 60, tasks: [{ number: 61, title }, { number: 62, title: 'Segunda', blocked_by: [61] }, { number: 63, title: 'Fora', out: true }] }) }));
  ok(flow(r, ['task', 'dispatch', '--json', '-'], { input: JSON.stringify({ number: 60, task: 61, floor: 'Floor "1"', worker: 'Ária', branch: 'task/61-json' }) }));
  ok(flow(r, ['status', '--json', '-'], { input: `\uFEFF${JSON.stringify({ number: 60, task: 61, text: 'Quase lá: "ok"', state: 'review', progress: '4/4' })}` }));
  ok(flow(r, ['task', 'integrate', '60', '61', '--sha', '1234567', '--json', '-'], { input: JSON.stringify({ sha: 'fedcba9', sha_before: '7654321' }) }));
  await withServer(r, async (get) => {
    const tasks = await tasksOf(get, 'widgets/60');
    assert.deepStrictEqual(tasks.map((x) => [x.number, x.title, x.state, x.blocked_by]), [[61, title, 'integrated', []], [62, 'Segunda', 'waiting', [61]], [63, 'Fora', 'out', []]]);
    assert.deepStrictEqual([tasks[0].floor, tasks[0].worker, tasks[0].status_text, tasks[0].progress, tasks[0].sha, tasks[0].sha_before],
      ['Floor "1"', 'Ária', 'Quase lá: "ok"', { done: 4, total: 4 }, '1234567', '7654321']);
  });
});

suite.test('invalid task data ends with a clear message and exit code 2, writing nothing', async () => {
  const r = buildRoot('invalid');
  ok(flow(r, ['item', 'start', '70', '--title', 'Válido', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '70', '--task', '71|Uma', '--task', '72|Outra|71']));
  const cases = [
    [['task', 'graph', '70'], /falta o grafo de tasks/],
    [['task', 'graph', '70', '--task', 'sem-barra'], /task inválida: "sem-barra"/],
    [['task', 'graph', '70', '--task', 'x|Título'], /número de task inválido: "x"/],
    [['task', 'graph', '70', '--task', '71|'], /falta o título da task 71/],
    [['task', 'graph', '70', '--task', '71|A', '--task', '71|B'], /a task 71 aparece mais de uma vez/],
    [['task', 'graph', '70', '--task', '71|A|71'], /não pode bloquear a si mesma/],
    [['task', 'graph', '70', '--task', '71|A|99'], /bloqueada pela 99, que não está no grafo/],
    [['task', 'graph', '70', '--task', '71|A|73', '--task', '72|B|71', '--task', '73|C|72'], /ciclo: 71 → 73 → 72 → 71|ciclo: /],
    [['task', 'graph', '70', '--task', '71|A', '--out', '75'], /task 75 de --out não está no grafo/],
    [['task', 'graph', '99', '--task', '1|A'], /ainda não foi iniciado/],
    [['task', 'dispatch', '70'], /falta o número da task/],
    [['task', 'dispatch', '70', '79'], /a task 79 não é do item widgets\/70 \(tasks do item: 71, 72\)/],
    [['task', 'integrate', '70', '71'], /falta o SHA/],
    [['task', 'integrate', '70', '71', '--sha', 'xyz'], /SHA inválido em sha: "xyz"/],
    [['task', 'merge', '70'], /subcomando desconhecido: "task merge"/],
    [['status'], /falta o texto do status/],
    [['status', 'Ok', '--state', 'done-ish', '--item', '70', '--task', '71'], /estado inválido: "done-ish"/],
    [['status', 'Ok', '--progress', '6/5', '--item', '70', '--task', '71'], /progresso inválido: "6\/5"/],
    [['status', 'Ok', '--item', '70', '--task', '79'], /a task 79 não é do item widgets\/70/],
    [['status', 'Ok', '--task', '79'], /nenhum item do projeto "widgets" tem a task 79/],
    [['status', '--json', '-'], /falta o texto do status/, JSON.stringify({ text: '  ', number: 70 })],
    [['status', '--json', '-'], /"texto" precisa ter até 300 caracteres, numa linha só/, JSON.stringify({ text: 'duas\nlinhas', number: 70, task: 71 })],
  ];
  for (const [args, message, input] of cases) {
    const x = flow(r, args, { input: input === undefined ? '' : input });
    assert.strictEqual(x.status, 2, `${args.join(' ')} → exit ${x.status}: ${x.stderr}`);
    assert.ok(message.test(x.stderr), `${args.join(' ')} → ${x.stderr}`);
    assert.ok(x.stderr.startsWith('erro: '), x.stderr);
  }
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/70')).item;
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'task-graph']);
  });
  assert.deepStrictEqual(maestriCalls(r), []);
});

suite.test('help lists the task and status subcommands', () => {
  const r = buildRoot('help');
  const x = flow(r, ['--help']);
  ok(x);
  for (const s of ['task graph <número>', 'task dispatch <número> <task>', 'task integrate <número> <task>', 'status "<texto>"', 'FLOW_MAESTRI_CLI', 'MAESTRI_TERMINAL_ID']) {
    assert.ok(x.stdout.includes(s), `${s} in:\n${x.stdout}`);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
