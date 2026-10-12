'use strict';
// Tests for the worker's reports, the maestro's findings and the item's timeline (#8), through the agreed seam only:
// the bin/flow.js CLI runs as a process inside a temporary git repository (fictitious remote origin, floors as
// worktrees) → temporary maestro.db (MAESTRO_DIR) → the server's HTTP API. No test reads the database or calls
// internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('reports, findings and timeline: flow CLI → maestro.db → items API');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function buildRoot(name, { branch = 'feature/issue-12', remote = 'https://github.com/acme/widgets.git' } = {}) {
  const root = tmpDir(`reports-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', branch);
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  return { root, data, repo };
}

/** Writes the files ({ path: text | Buffer }) in the folder without committing them; null removes the file. */
function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) {
      fs.rmSync(path.join(dir, file));
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

/** Writes the files ({ path: text | Buffer | null }, as write does) in the folder and commits them; returns the new HEAD. */
function commit(dir, files, message = 'mudança') {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** A floor without a commit of its own: a worktree on a new branch, from the given start point. */
function addWorktree(r, name, branch, start) {
  const wt = path.join(r.root, name);
  git(r.repo, 'worktree', 'add', '-q', '-b', branch, wt, ...(start ? [start] : []));
  return wt;
}

/** The item with one task dispatched on its branch (the report finds the task by the floor's branch). */
function startItem(r, number, task, branch) {
  ok(flow(r, ['item', 'start', String(number), '--title', 'Resumo do diff', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', String(number), '--task', `${task}|Uma task`]));
  ok(flow(r, ['task', 'dispatch', String(number), String(task), '--worker', 'Atlas', '--branch', branch]));
}

const REPORT = JSON.stringify({ status: 'ok', text: 'Pronto.' });
const lines = (x) => x.stdout.trim().split(/\r?\n/);
/** A file of the summary as the API returns it: also_in is computed on read (#56), the recorded one has none. */
const fileRow = (p, added, removed, alsoIn = []) => ({ path: p, added, removed, binary: false, also_in: alsoIn });
const recorded = (diff) => ({ ...diff, files: diff.files.map(({ also_in: _, ...f }) => f) });

/** A floor: a worktree of the repository on the given branch, with one commit of its own. */
function addFloor(r, name, branch) {
  const wt = path.join(r.root, name);
  git(r.repo, 'worktree', 'add', '-q', '-b', branch, wt);
  git(wt, 'commit', '-q', '--allow-empty', '-m', `trabalho em ${branch}`);
  return { dir: wt, head: git(wt, 'rev-parse', 'HEAD') };
}

function flow(r, args, { cwd = r.repo, input } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' });
  delete env.MAESTRI_TERMINAL_ID;
  return spawnSync(process.execPath, [FLOW, ...args], { cwd, env, input: input === undefined ? '' : input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
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

const REPORT_TEXT = [
  'Task 13, branch task/13-gerar-pdf, SHA final no topo da integradora (sem push, sem tracker, sem merge). Status: ok.',
  '',
  'Testes: npm test, duas rodadas seguidas, banco "maestro-13.db" recriado vazio; 0 falhas.',
  'O que mudou: o relatório em PDF sai com cabeçalho, rodapé e acentuação (ç, ã, é, ü) corretos.',
  'Decisões:',
  '  1. Usei a fonte embutida "Noto Sans" — o servidor não tem fontes do sistema.',
  '  2. Página A4 por padrão; Carta fica para depois.',
  'Riscos: o arquivo C:\\temp\\saida.pdf é sobrescrito; tabs\tdentro do texto.',
  'Arquivos compartilhados: panel/server.js e README.md.',
].join('\n');

suite.test('the worker records the whole report by JSON on standard input and it comes back the same through the API', async () => {
  const r = buildRoot('report');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '12', '--task', '13|Gerar o PDF', '--task', '14|Enviar por e-mail|13']));
  const floor = addFloor(r, 'floor-13', 'task/13-gerar-pdf');
  ok(flow(r, ['task', 'dispatch', '12', '13', '--floor', 'Gerar PDF', '--worker', 'Ária', '--branch', 'task/13-gerar-pdf']));
  const report = {
    status: 'ok',
    tests: 'npm test: 2 rodadas seguidas, 0 falhas\nnpm run check: ok',
    changes: 'O relatório sai em PDF com "cabeçalho" e rodapé.\nAcentos: ç ã é ü.',
    decisions: ['Fonte embutida "Noto Sans" — sem fontes do sistema.', 'Página A4 por padrão;\nCarta fica para depois.'],
    risks: 'Sobrescreve C:\\temp\\saida.pdf.',
    shared_files: ['panel/server.js', 'README.md'],
    text: REPORT_TEXT,
  };
  // In the floor's worktree: the task comes from the dispatched branch, the branch and the SHA from git.
  const x = flow(r, ['report', '--agent', 'Ária', '--json', '-'], { cwd: floor.dir, input: `\uFEFF${JSON.stringify(report)}` });
  ok(x);
  assert.ok(/Relatório da task 13 do item widgets\/12 gravado/.test(x.stdout), x.stdout);
  // A second report of the same task (after a fix), blocked, with its fields as arguments.
  ok(flow(r, ['report', '--item', '12', '--task', '13', '--status', 'blocked', '--reason', 'Falta o certificado de HML', '--sha', 'ABCDEF1',
    '--branch', 'task/13-ajuste', '--agent', 'Ária', '--json', '-'], { input: JSON.stringify({ text: 'Travado.\nPreciso do certificado.', status: 'ok', sha: '1234567' }) }));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.reports.length, 2);
    const [first, second] = item.reports;
    assert.deepStrictEqual(
      { status: first.status, blocked_reason: first.blocked_reason, tests: first.tests, changes: first.changes, decisions: first.decisions, risks: first.risks, shared_files: first.shared_files, text: first.text },
      { ...report, blocked_reason: null },
      'every field comes back exactly as written',
    );
    assert.deepStrictEqual([first.task_number, first.branch, first.sha, first.agent], [13, 'task/13-gerar-pdf', floor.head, { role: 'worker', name: 'Ária' }]);
    assert.ok(first.at && first.id, 'moment and event id');
    assert.deepStrictEqual([second.task_number, second.status, second.blocked_reason, second.sha, second.branch, second.text, second.decisions, second.tests],
      [13, 'blocked', 'Falta o certificado de HML', 'abcdef1', 'task/13-ajuste', 'Travado.\nPreciso do certificado.', [], null], 'arguments win over the JSON');
    const timeline = item.timeline.filter((e) => e.type === 'task-report');
    assert.deepStrictEqual(timeline.map((e) => [e.task_number, e.agent.role, e.payload.status]), [[13, 'worker', 'ok'], [13, 'worker', 'blocked']]);
    assert.strictEqual(timeline[0].payload.text, REPORT_TEXT);
  });
});

suite.test('findings of an item: classification, origin task, and a finding that becomes a new task shows as an "out" task of the item', async () => {
  const r = buildRoot('findings');
  ok(flow(r, ['item', 'start', '20', '--title', 'Carrinho salvo', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '20', '--task', '21|Modelo', '--task', '22|API|21']));
  ok(flow(r, ['finding', 'add', '20', '--title', 'Corrida ao juntar carrinhos', '--classification', 'defect', '--task', '22',
    '--description', 'Dois dispositivos ao mesmo tempo\nduplicam itens ("race").', '--new-task', '27', '--agent', 'Bento']));
  ok(flow(r, ['finding', 'add', '--json', '-'], { input: JSON.stringify({ number: 20, title: 'Limite do carrinho', classification: 'owner_decision', description: 'Quantos itens no máximo?' }) }));
  ok(flow(r, ['finding', 'add', '20', '--title', 'Nome de variável', '--classification', 'discarded', '--task', '21']));
  // The owner decided: the second finding also becomes a task for triage, linked later.
  ok(flow(r, ['finding', 'link', '20', '2', '--new-task', '28', '--new-task-title', 'Limitar o carrinho a 50 itens']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/20')).item;
    assert.deepStrictEqual(item.findings.map((f) => [f.number, f.title, f.classification, f.origin_task, f.new_task]), [
      [1, 'Corrida ao juntar carrinhos', 'defect', 22, { number: 27, title: 'Corrida ao juntar carrinhos' }],
      [2, 'Limite do carrinho', 'owner_decision', null, { number: 28, title: 'Limitar o carrinho a 50 itens' }],
      [3, 'Nome de variável', 'discarded', 21, null],
    ]);
    assert.strictEqual(item.findings[0].description, 'Dois dispositivos ao mesmo tempo\nduplicam itens ("race").');
    assert.deepStrictEqual(item.findings[0].agent, { role: 'maestro', name: 'Bento' });
    assert.ok(item.findings[0].recorded_at && !item.findings[0].linked_at);
    assert.ok(item.findings[1].linked_at, 'when the finding was linked to its task');
    assert.deepStrictEqual(item.tasks.map((x) => [x.number, x.title, x.state, x.finding]), [
      [21, 'Modelo', 'waiting', null],
      [22, 'API', 'waiting', null],
      [27, 'Corrida ao juntar carrinhos', 'out', 1],
      [28, 'Limitar o carrinho a 50 itens', 'out', 2],
    ]);
  });
  // Triage brought task 27 into the item: dispatching it puts it to work, still linked to its finding.
  ok(flow(r, ['task', 'dispatch', '20', '27', '--worker', 'Caio', '--branch', 'task/27-corrida']));
  await withServer(r, async (get) => {
    const t27 = (await get('/api/items/widgets/20')).item.tasks.find((x) => x.number === 27);
    assert.deepStrictEqual([t27.state, t27.worker, t27.finding], ['working', 'Caio', 1]);
  });
});

suite.test('the timeline lists every event of the item, in order, with the agent (role and name) and the moment', async () => {
  const r = buildRoot('timeline');
  ok(flow(r, ['item', 'start', '30', '--title', 'Linha do tempo', '--agent', 'Bento']));
  ok(flow(r, ['stage', '30', 'implementation', '--agent', 'Bento']));
  ok(flow(r, ['task', 'graph', '30', '--task', '31|Única', '--agent', 'Bento']));
  ok(flow(r, ['task', 'dispatch', '30', '31', '--worker', 'Ária', '--branch', 'task/31-unica', '--agent', 'Bento']));
  ok(flow(r, ['status', 'Trabalhando', '--item', '30', '--task', '31', '--agent', 'Ária']));
  ok(flow(r, ['report', '--item', '30', '--task', '31', '--status', 'ok', '--branch', 'task/31-unica', '--sha', 'abc1234', '--agent', 'Ária', '--json', '-'], { input: JSON.stringify({ text: 'Pronto.' }) }));
  ok(flow(r, ['finding', 'add', '30', '--title', 'Falta teste de borda', '--classification', 'defect', '--task', '31', '--new-task', '32', '--agent', 'Bento']));
  ok(flow(r, ['task', 'integrate', '30', '31', '--sha', 'abc1234', '--agent', 'Bento']));
  ok(flow(r, ['pr', '30', 'ready', '--url', 'https://github.com/acme/widgets/pull/9', '--agent', 'Bento']));
  ok(flow(r, ['item', 'done', '30', '--role', 'owner', '--agent', 'Higor']));
  await withServer(r, async (get) => {
    const timeline = (await get('/api/items/widgets/30')).item.timeline;
    assert.deepStrictEqual(timeline.map((e) => [e.type, e.task_number, e.agent.role, e.agent.name]), [
      ['item-started', null, 'maestro', 'Bento'],
      ['stage-changed', null, 'maestro', 'Bento'],
      ['task-graph', null, 'maestro', 'Bento'],
      ['task-dispatched', 31, 'maestro', 'Bento'],
      ['task-status', 31, 'worker', 'Ária'],
      ['task-report', 31, 'worker', 'Ária'],
      ['finding-recorded', 31, 'maestro', 'Bento'],
      ['task-integrated', 31, 'maestro', 'Bento'],
      ['pr-changed', null, 'maestro', 'Bento'],
      ['item-done', null, 'owner', 'Higor'],
    ]);
    for (let i = 1; i < timeline.length; i++) {
      assert.ok(timeline[i].id > timeline[i - 1].id && Date.parse(timeline[i].at) >= Date.parse(timeline[i - 1].at), 'in order');
    }
  });
});

suite.test('invalid reports and findings end with a clear message and exit code 2, writing nothing', async () => {
  const r = buildRoot('invalid');
  ok(flow(r, ['item', 'start', '40', '--title', 'Válido', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '40', '--task', '41|Uma', '--task', '42|Outra']));
  ok(flow(r, ['finding', 'add', '40', '--title', 'Primeiro', '--classification', 'defect', '--new-task', '45']));
  const json = (o) => JSON.stringify(o);
  const cases = [
    [['report', '--item', '40', '--task', '41'], /falta o status do relatório/],
    [['report', '--item', '40', '--task', '41', '--status', 'talvez'], /status do relatório inválido: "talvez"/],
    [['report', '--item', '40', '--task', '41', '--status', 'ok'], /o relatório está vazio/],
    [['report', '--item', '40', '--task', '41', '--json', '-'], /campo "decisions" do JSON precisa ser uma lista de textos/, json({ status: 'ok', text: 'x', decisions: 'uma só' })],
    [['report', '--item', '40', '--task', '41', '--json', '-'], /campo "text" do JSON precisa ser texto/, json({ status: 'ok', text: 3 })],
    [['report', '--item', '40', '--task', '41', '--json', '-'], /o campo "text" tem 20001 caracteres; o máximo é 20000/, json({ status: 'ok', text: 'a'.repeat(20001) })],
    [['report', '--item', '40', '--task', '41', '--status', 'ok', '--sha', 'xyz', '--json', '-'], /SHA inválido em sha: "xyz"/, json({ text: 'x' })],
    [['report', '--item', '40', '--task', '49', '--status', 'ok', '--json', '-'], /a task 49 não é do item widgets\/40/, json({ text: 'x' })],
    [['finding', 'add', '40', '--classification', 'defect'], /falta o título do achado/],
    [['finding', 'add', '40', '--title', 'X'], /falta a classificação do achado/],
    [['finding', 'add', '40', '--title', 'X', '--classification', 'bug'], /classificação inválida: "bug" \(use defect, owner_decision ou discarded\)/],
    [['finding', 'add', '40', '--title', 'X', '--classification', 'defect', '--task', '49'], /a task 49 não é do item widgets\/40/],
    [['finding', 'add', '40', '--title', 'X', '--classification', 'defect', '--new-task', '41'], /a task 41 já é do item widgets\/40/],
    [['finding', 'add', '40', '--title', 'X', '--classification', 'discarded', '--new-task', '46'], /achado descartado não vira task/],
    [['finding', 'add', '99', '--title', 'X', '--classification', 'defect'], /ainda não foi iniciado/],
    [['finding', 'link', '40', '7', '--new-task', '46'], /o item widgets\/40 não tem o achado 7/],
    [['finding', 'link', '40', '1', '--new-task', '46'], /o achado 1 do item widgets\/40 já virou a task 45/],
    [['finding', 'link', '40', '1'], /falta a task nova/],
    [['finding', 'close', '40'], /subcomando desconhecido: "finding close"/],
  ];
  for (const [args, message, input] of cases) {
    const x = flow(r, args, { input });
    assert.strictEqual(x.status, 2, `${args.join(' ')} → exit ${x.status}: ${x.stderr}`);
    assert.ok(message.test(x.stderr), `${args.join(' ')} → ${x.stderr}`);
    assert.ok(x.stderr.startsWith('erro: '), x.stderr);
  }
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/40')).item;
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'task-graph', 'finding-recorded']);
    assert.deepStrictEqual(item.reports, []);
  });
});

// ---------- the diff summary of the report (TaskDiff, #54) ----------

suite.test('diff summary: only what the task committed since it left the integration branch (GitHub convention), even after another task was integrated', async () => {
  const r = buildRoot('diff-github');
  const start = commit(r.repo, { 'base.txt': 'um\ndois\ntrês\n', 'docs/leia.md': 'leia\n' }, 'base');
  startItem(r, 12, 13, 'task/13-resumo');
  const a = addWorktree(r, 'floor-13', 'task/13-resumo');
  const b = addWorktree(r, 'floor-14', 'task/14-outra');
  commit(a, { 'a.txt': 'novo\noutro\n' }, 'a');
  commit(a, { 'base.txt': 'um\nDOIS\ntrês\n', 'src/ç.js': 'x\n' }, 'base mexida');
  commit(b, { 'b.txt': 'b\n', 'docs/leia.md': 'leia\nmais\n' }, 'b');
  // Task 14 is integrated after task 13 left the integration branch: 13's summary must not show it.
  git(r.repo, 'merge', '-q', '--no-ff', '-m', 'integra a 14', 'task/14-outra');
  const x = flow(r, ['report', '--agent', 'Atlas', '--json', '-'], { cwd: a, input: REPORT });
  ok(x);
  assert.strictEqual(lines(x).length, 1, `a single line when the summary is recorded:\n${x.stdout}`);
  const expected = {
    base: start, base_ref: 'feature/issue-12',
    files: [fileRow('a.txt', 2, 0), fileRow('base.txt', 1, 1), fileRow('src/ç.js', 1, 0)],
    total: { files: 3, added: 4, removed: 1 }, truncated: false, uncommitted: 0,
  };
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.reports.length, 1);
    assert.deepStrictEqual(item.reports[0].diff, expected);
    assert.strictEqual(item.reports[0].sha, git(a, 'rev-parse', 'HEAD'));
    assert.deepStrictEqual(item.timeline.find((e) => e.type === 'task-report').payload.diff, recorded(expected), 'recorded in the task-report itself, without also_in');
  });
});

suite.test('diff summary: the base comes from --base, then "base" in the JSON, then the item\'s pr.branch, before the convention', async () => {
  const r = buildRoot('diff-base-order', { branch: 'integra/carrinho' });
  const start = commit(r.repo, { 'base.txt': 'base\n' }, 'base');
  startItem(r, 12, 13, 'task/13-ordem');
  const wt = addWorktree(r, 'floor-13', 'task/13-ordem');
  const first = commit(wt, { 'um.txt': '1\n' }, 'um');
  git(r.repo, 'branch', 'marco', first);
  const head = commit(wt, { 'dois.txt': '2\n2\n' }, 'dois');
  // The convention's branch exists too, at the task's HEAD: if it won, the summary would be empty.
  git(r.repo, 'branch', 'feature/issue-12', head);
  ok(flow(r, ['pr', '12', 'draft', '--url', 'https://github.com/acme/widgets/pull/9', '--branch', 'integra/carrinho']));
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: REPORT }));
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: JSON.stringify({ status: 'ok', text: 'Pronto.', base: 'marco' }) }));
  ok(flow(r, ['report', '--base', 'feature/issue-12', '--json', '-'], { cwd: wt, input: JSON.stringify({ status: 'ok', text: 'Pronto.', base: 'marco' }) }));
  // An unknown --base falls back to the next name (pr.branch).
  ok(flow(r, ['report', '--base', 'nao-existe', '--json', '-'], { cwd: wt, input: REPORT }));
  await withServer(r, async (get) => {
    const diffs = (await get('/api/items/widgets/12')).item.reports.map((x) => x.diff);
    assert.deepStrictEqual(diffs.map((d) => [d.base_ref, d.base, d.files.map((f) => f.path), d.total]), [
      ['integra/carrinho', start, ['dois.txt', 'um.txt'], { files: 2, added: 3, removed: 0 }],
      ['marco', first, ['dois.txt'], { files: 1, added: 2, removed: 0 }],
      ['feature/issue-12', head, [], { files: 0, added: 0, removed: 0 }],
      ['integra/carrinho', start, ['dois.txt', 'um.txt'], { files: 2, added: 3, removed: 0 }],
    ]);
  });
});

suite.test('diff summary: Azure DevOps convention (feature/pbi-<n>) and origin/<name> when there is no local ref', async () => {
  const r = buildRoot('diff-azure', { branch: 'main', remote: 'https://dev.azure.com/acme/Loja/_git/widgets' });
  const integration = commit(r.repo, { 'base.txt': 'base\n' }, 'base');
  // Only the remote-tracking ref of the integration branch exists in this clone.
  git(r.repo, 'update-ref', 'refs/remotes/origin/feature/pbi-3100', integration);
  commit(r.repo, { 'main.txt': 'só na main\n' }, 'main anda');
  startItem(r, 3100, 3101, 'task/3101-azure');
  const wt = addWorktree(r, 'floor-3101', 'task/3101-azure', 'origin/feature/pbi-3100');
  commit(wt, { 'pbi.txt': 'a\nb\nc\n' }, 'pbi');
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: REPORT }));
  // The local ref wins over origin/<name> when both exist.
  git(r.repo, 'branch', 'feature/pbi-3100', git(wt, 'rev-parse', 'HEAD'));
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: REPORT }));
  await withServer(r, async (get) => {
    const diffs = (await get('/api/items/widgets/3100')).item.reports.map((x) => x.diff);
    assert.deepStrictEqual(diffs[0], {
      base: integration, base_ref: 'origin/feature/pbi-3100', files: [fileRow('pbi.txt', 3, 0)],
      total: { files: 1, added: 3, removed: 0 }, truncated: false, uncommitted: 0,
    });
    assert.deepStrictEqual([diffs[1].base_ref, diffs[1].files], ['feature/pbi-3100', []]);
  });
});

suite.test('diff summary: an explicit --sha summarizes that commit, not the HEAD', async () => {
  const r = buildRoot('diff-sha');
  const start = git(r.repo, 'rev-parse', 'HEAD');
  startItem(r, 12, 13, 'task/13-sha');
  const wt = addWorktree(r, 'floor-13', 'task/13-sha');
  const first = commit(wt, { 'um.txt': '1\n' }, 'um');
  commit(wt, { 'dois.txt': '2\n' }, 'dois');
  ok(flow(r, ['report', '--sha', first, '--json', '-'], { cwd: wt, input: REPORT }));
  // From another folder (the maestro's), with --item/--task: the explicit SHA still gives the summary.
  ok(flow(r, ['report', '--item', '12', '--task', '13', '--sha', first.slice(0, 7), '--json', '-'], { input: REPORT }));
  await withServer(r, async (get) => {
    const reports = (await get('/api/items/widgets/12')).item.reports;
    for (const x of reports) {
      assert.deepStrictEqual([x.diff.base, x.diff.base_ref, x.diff.files], [start, 'feature/issue-12', [fileRow('um.txt', 1, 0)]]);
    }
    assert.deepStrictEqual(reports.map((x) => x.sha), [first, first.slice(0, 7)]);
  });
});

suite.test('without a summary (no SHA, unknown commit, no base, no common ancestor, git failing) the report is recorded without "diff", exit 0, and a second line says why', async () => {
  const r = buildRoot('diff-none', { branch: 'main' });
  startItem(r, 12, 13, 'task/13-sem');
  const wt = addWorktree(r, 'floor-13', 'task/13-sem');
  commit(wt, { 'a.txt': 'a\n' }, 'a');
  const orphan = git(r.repo, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'sem ancestral');
  const broken = commit(wt, { 'perdido.txt': 'objeto que some\n' }, 'objeto perdido');
  const blob = git(wt, 'rev-parse', `${broken}:perdido.txt`);
  fs.rmSync(path.join(r.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const cases = [
    // No SHA: --item/--task from a folder that is not on the task's branch.
    [{ args: ['--item', '12', '--task', '13'] }, /^Relatório gravado sem o resumo do diff: o relatório não tem SHA/],
    // No base: neither --base, pr.branch nor feature/issue-12 exist (locally or in origin).
    [{ cwd: wt, args: [] }, /^Relatório gravado sem o resumo do diff: nenhuma base encontrada \(feature\/issue-12, origin\/feature\/issue-12\)/],
    [{ cwd: wt, args: ['--base', 'outra'] }, /nenhuma base encontrada \(outra, origin\/outra, feature\/issue-12, origin\/feature\/issue-12\)/],
    // A SHA git does not know (it wins over the missing base).
    [{ cwd: wt, args: ['--sha', 'abcdef1'] }, /^Relatório gravado sem o resumo do diff: o commit abcdef1 não está no repositório/],
    // A commit with no common ancestor with the base.
    [{ cwd: wt, args: ['--base', 'main', '--sha', orphan] }, new RegExp(`^Relatório gravado sem o resumo do diff: o commit ${orphan} não tem ancestral comum com main`)],
    // git itself fails: an object the diff needs is gone.
    [{ cwd: wt, args: ['--base', 'main', '--sha', broken] }, /^Relatório gravado sem o resumo do diff: o git falhou \(.+\)/],
  ];
  for (const [{ cwd, args }, why] of cases) {
    const x = flow(r, ['report', ...args, '--json', '-'], { cwd, input: REPORT });
    ok(x);
    const out = lines(x);
    assert.strictEqual(out.length, 2, x.stdout);
    assert.ok(/^Relatório da task 13 do item widgets\/12 gravado/.test(out[0]), out[0]);
    assert.ok(why.test(out[1]), out[1]);
  }
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.deepStrictEqual(item.reports.map((x) => x.diff), cases.map(() => null));
    for (const e of item.timeline.filter((x) => x.type === 'task-report')) assert.ok(!('diff' in e.payload), 'nothing about the summary in the payload');
  });
});

// ---------- edge cases of the summary: binary, renamed, cut at 200 files, uncommitted (#55) ----------

/** Ten lines of text: a file git recognizes as renamed when only one of them changes. */
const tenLines = (last = 'dez') => `${['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', last].join('\n')}\n`;
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00, 0x01]);

suite.test('edge cases: a binary file has no line counts and stays out of the line totals; a renamed one has "from" and its lines', async () => {
  const r = buildRoot('diff-binary-renamed');
  const start = commit(r.repo, { 'logo.png': BINARY, 'velho.txt': tenLines(), 'leia.md': 'leia\n' }, 'base');
  startItem(r, 12, 13, 'task/13-borda');
  const wt = addWorktree(r, 'floor-13', 'task/13-borda');
  commit(wt, {
    'logo.png': Buffer.concat([BINARY, Buffer.from([0x00, 0x02])]), 'icone.bin': BINARY,
    'velho.txt': null, 'src/novo.txt': tenLines('DEZ'), 'leia.md': 'leia\nmais\n',
  }, 'borda');
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: REPORT }));
  await withServer(r, async (get) => {
    assert.deepStrictEqual((await get('/api/items/widgets/12')).item.reports[0].diff, {
      base: start, base_ref: 'feature/issue-12',
      files: [
        { path: 'icone.bin', added: null, removed: null, binary: true, also_in: [] },
        fileRow('leia.md', 1, 0),
        { path: 'logo.png', added: null, removed: null, binary: true, also_in: [] },
        { path: 'src/novo.txt', from: 'velho.txt', added: 1, removed: 1, binary: false, also_in: [] },
      ],
      total: { files: 4, added: 2, removed: 1 }, truncated: false, uncommitted: 0,
    });
  });
});

suite.test('edge cases: more than 200 files keeps the first 200 in git\'s order (by path), truncated, with the totals of the whole diff', async () => {
  const r = buildRoot('diff-cut');
  const start = git(r.repo, 'rev-parse', 'HEAD');
  startItem(r, 12, 13, 'task/13-corte');
  const wt = addWorktree(r, 'floor-13', 'task/13-corte');
  const name = (i) => `f/${String(i).padStart(3, '0')}.txt`;
  const files = (from, to, text) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, k) => [name(from + k), text]));
  // Exactly 200 files: nothing is cut.
  const exact = commit(wt, files(1, 200, 'a\n'), '200');
  // 205 files: the last five (by path) are cut, but their lines (two each, and a binary one) count in the totals.
  commit(wt, { ...files(201, 204, 'b\nb\n'), 'z.bin': BINARY }, 'mais 5');
  ok(flow(r, ['report', '--sha', exact, '--json', '-'], { cwd: wt, input: REPORT }));
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: REPORT }));
  await withServer(r, async (get) => {
    const [full, cut] = (await get('/api/items/widgets/12')).item.reports.map((x) => x.diff);
    assert.deepStrictEqual([full.files.length, full.truncated, full.total], [200, false, { files: 200, added: 200, removed: 0 }]);
    assert.strictEqual(cut.base, start);
    assert.deepStrictEqual(cut.files.map((f) => f.path), Array.from({ length: 200 }, (_, k) => name(k + 1)));
    assert.deepStrictEqual([cut.truncated, cut.total], [true, { files: 205, added: 208, removed: 0 }]);
  });
});

suite.test('edge cases: uncommitted counts the files changed outside a commit in the worktree, only when the SHA is its HEAD', async () => {
  const r = buildRoot('diff-uncommitted');
  commit(r.repo, { 'a.txt': 'a\n', 'b.txt': tenLines() }, 'base');
  startItem(r, 12, 13, 'task/13-sujo');
  const wt = addWorktree(r, 'floor-13', 'task/13-sujo');
  const first = commit(wt, { 'c.txt': 'c\n' }, 'c');
  commit(wt, { 'd.txt': 'd\n' }, 'd');
  // A clean worktree: 0.
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: REPORT }));
  // Modified (a.txt), renamed in the index (b.txt → e.txt) and two untracked files in a new folder: 4 files.
  write(wt, { 'a.txt': 'a\nsem commit\n', 'novos/um.txt': '1\n', 'novos/dois.txt': '2\n' });
  git(wt, 'mv', 'b.txt', 'e.txt');
  ok(flow(r, ['report', '--json', '-'], { cwd: wt, input: REPORT }));
  // An explicit --sha that is the HEAD counts too; one that is not the HEAD does not.
  ok(flow(r, ['report', '--sha', git(wt, 'rev-parse', 'HEAD'), '--json', '-'], { cwd: wt, input: REPORT }));
  ok(flow(r, ['report', '--sha', first, '--json', '-'], { cwd: wt, input: REPORT }));
  await withServer(r, async (get) => {
    const diffs = (await get('/api/items/widgets/12')).item.reports.map((x) => x.diff);
    assert.deepStrictEqual(diffs.map((d) => [d.uncommitted, d.files.map((f) => f.path)]), [
      [0, ['c.txt', 'd.txt']],
      [4, ['c.txt', 'd.txt']],
      [4, ['c.txt', 'd.txt']],
      [0, ['c.txt']],
    ]);
  });
});

// ---------- "também na task #N": the other tasks of the item that changed the same file (#56) ----------

suite.test('also_in: two tasks that change the same file cite each other, different files do not, and only the last report with a summary of each task counts', async () => {
  const r = buildRoot('also-in');
  commit(r.repo, { 'comum.txt': 'comum\n', 'a.txt': 'a\n' }, 'base');
  ok(flow(r, ['item', 'start', '12', '--title', 'Resumo do diff', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '12', '--task', '13|Uma', '--task', '14|Outra', '--task', '15|Mais uma']));
  for (const [task, branch] of [[13, 'task/13-um'], [14, 'task/14-outra'], [15, 'task/15-mais']]) {
    ok(flow(r, ['task', 'dispatch', '12', String(task), '--worker', 'Atlas', '--branch', branch]));
  }
  const a = addWorktree(r, 'floor-13', 'task/13-um');
  const b = addWorktree(r, 'floor-14', 'task/14-outra');
  const c = addWorktree(r, 'floor-15', 'task/15-mais');
  commit(a, { 'comum.txt': 'comum\nda 13\n', 'a.txt': 'a\nda 13\n' }, 'a');
  const b1 = commit(b, { 'a.txt': 'a\nda 14\n' }, 'b1');
  const b2 = commit(b, { 'comum.txt': 'comum\nda 14\n' }, 'b2');
  commit(c, { 'c.txt': 'c\n' }, 'c');
  // Task 14: a first report with both files, then a later one with only a.txt, then one without a summary (no SHA).
  ok(flow(r, ['report', '--sha', b2, '--json', '-'], { cwd: b, input: REPORT }));
  ok(flow(r, ['report', '--sha', b1, '--json', '-'], { cwd: b, input: REPORT }));
  ok(flow(r, ['report', '--item', '12', '--task', '14', '--json', '-'], { input: REPORT }));
  ok(flow(r, ['report', '--json', '-'], { cwd: a, input: REPORT }));
  ok(flow(r, ['report', '--json', '-'], { cwd: c, input: REPORT }));
  // Task 14 integrated: it still counts (a warning, not a guarantee of conflict).
  ok(flow(r, ['task', 'integrate', '12', '14', '--sha', b1]));
  const files = (x) => (x.diff ? x.diff.files.map((f) => [f.path, f.also_in]) : null);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.deepStrictEqual(item.reports.map((x) => [x.task_number, files(x)]), [
      // 14's older report: 13's last summary also changed both files.
      [14, [['a.txt', [13]], ['comum.txt', [13]]]],
      [14, [['a.txt', [13]]]],
      [14, null],
      // 13: comum.txt only in 14's older report, which no longer counts.
      [13, [['a.txt', [14]], ['comum.txt', []]]],
      [15, [['c.txt', []]]],
    ]);
    for (const e of item.timeline.filter((x) => x.type === 'task-report' && x.payload.diff)) {
      assert.ok(e.payload.diff.files.every((f) => !('also_in' in f)), 'also_in is not recorded (ADR 0002)');
    }
  });
});

suite.test('also_in: a file renamed in one task whose old path (from) is the path another task changed; the two cite each other', async () => {
  const r = buildRoot('also-in-renamed');
  commit(r.repo, { 'velho.txt': tenLines(), 'outro.txt': 'outro\n' }, 'base');
  ok(flow(r, ['item', 'start', '12', '--title', 'Resumo do diff', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '12', '--task', '13|Renomeia', '--task', '14|Altera']));
  for (const [task, branch] of [[13, 'task/13-renomeia'], [14, 'task/14-altera']]) {
    ok(flow(r, ['task', 'dispatch', '12', String(task), '--worker', 'Atlas', '--branch', branch]));
  }
  const a = addWorktree(r, 'floor-13', 'task/13-renomeia');
  const b = addWorktree(r, 'floor-14', 'task/14-altera');
  commit(a, { 'velho.txt': null, 'novo.txt': tenLines('DEZ') }, 'renomeia');
  commit(b, { 'velho.txt': tenLines('10'), 'outro.txt': 'outro\nda 14\n' }, 'altera');
  ok(flow(r, ['report', '--json', '-'], { cwd: a, input: REPORT }));
  ok(flow(r, ['report', '--json', '-'], { cwd: b, input: REPORT }));
  await withServer(r, async (get) => {
    const reports = (await get('/api/items/widgets/12')).item.reports;
    assert.deepStrictEqual(reports.map((x) => [x.task_number, x.diff.files.map((f) => [f.from || null, f.path, f.also_in])]), [
      [13, [['velho.txt', 'novo.txt', [14]]]],
      [14, [[null, 'outro.txt', []], [null, 'velho.txt', [13]]]],
    ]);
  });
});

suite.test('help lists the report and finding subcommands', () => {
  const r = buildRoot('help');
  const x = flow(r, ['--help']);
  ok(x);
  for (const s of ['report [--item <número>] [--task <task>]', '[--base <branch>]', 'finding add <número>', 'finding link <número> <achado>', 'defect|owner_decision|discarded']) {
    assert.ok(x.stdout.includes(s), `${s} in:\n${x.stdout}`);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
