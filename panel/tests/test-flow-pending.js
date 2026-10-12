'use strict';
// Tests for the pending decisions of the new model (#10) through the agreed seam only: the bin/flow.js CLI runs as a
// process inside a temporary git repository (with a fictitious remote origin) → temporary maestro.db (MAESTRO_DIR)
// → the server's HTTP API (GET /api/pending-decisions and the item's timeline). The "maestri" is a fake script
// (FLOW_MAESTRI_CLI) that only records its arguments (#44: pending open inside Maestri runs "maestri notify"). No test
// reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
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

/** Temporary root: data folder, git repositories with fictitious origins and a fake maestri that writes argv-<n>.json. */
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
  const fake = path.join(root, 'fake-maestri.js');
  fs.writeFileSync(fake, `require('fs').writeFileSync(require('path').join(__dirname, 'argv-' + process.hrtime.bigint() + '.json'), JSON.stringify(process.argv.slice(2)));\n`);
  return { root, data, fake, repo: repo('repo', 'https://github.com/acme/widgets.git'), repo2: repo('repo2', 'https://github.com/acme/gadgets.git') };
}

/** Arguments the fake maestri received, in call order. */
const maestriCalls = (r) => fs.readdirSync(r.root).filter((n) => /^argv-\d+\.json$/.test(n))
  .sort((a, b) => (BigInt(a.slice(5, -5)) < BigInt(b.slice(5, -5)) ? -1 : 1))
  .map((n) => JSON.parse(fs.readFileSync(path.join(r.root, n), 'utf8')));

/**
 * Runs the CLI outside of Maestri, unless extra sets the Maestri variables of a terminal. The maestri it calls is the
 * fake one, unless extra sets FLOW_MAESTRI_CLI: never the real one.
 */
function flow(r, args, { cwd = r.repo, input, extra = {} } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', FLOW_MAESTRI_CLI: r.fake }, extra);
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
        project: { id: 'widgets', name: 'widgets', tracker: 'github', organization: { id: 'unassigned', name: 'Sem organização' } },
      },
      task: { number: 13, title: 'Gerar o PDF', state: 'waiting' },
      host: { kind: 'maestri', workspace: 'Contoso', terminal: 'Maestro 12' }, notification: 'sent',
      opened_at: p.opened_at, opened_by: { role: 'maestro', name: null },
      closed_at: null, closed_by: null, resolution: null, decision: null, reason: null, derived_from: null, report: null,
    });
    assert.ok(Date.parse(p.opened_at) > 0, p.opened_at);
  });
});

// ---------- the last report of the task on its review (#57) ----------

/** Writes the files ({ path: text }) in the folder and commits them; returns the new HEAD. */
function commit(dir, files) {
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'mudança');
  return git(dir, 'rev-parse', 'HEAD');
}

suite.test('a task_review carries the last report of its task (at, sha, tests, diff), even one recorded after it opened; null without a report; the other kinds have no report', async () => {
  const r = buildRoot('report');
  startItem(r);
  const floor = path.join(r.root, 'floor-13');
  git(r.repo, 'worktree', 'add', '-q', '-b', 'task/13-gerar-pdf', floor);
  git(floor, 'config', 'core.autocrlf', 'false');
  ok(flow(r, ['task', 'dispatch', '12', '13', '--worker', 'Ária', '--branch', 'task/13-gerar-pdf']));
  // In the floor's worktree: the task comes from the dispatched branch, the SHA and the diff summary from git.
  const report = (tests) => ok(flow(r, ['report', '--agent', 'Ária', '--json', '-'], {
    cwd: floor, input: JSON.stringify({ status: 'ok', tests, text: 'Pronto.' }),
  }));
  const first = commit(floor, { 'pdf.js': 'a\nb\n' });
  report('npm test: 1 falha');
  const review13 = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--title', 'Revisar a task 13']));
  const review14 = openedId(flow(r, ['pending', 'open', '12', '--task', '14', '--kind', 'task_review', '--title', 'Revisar a task 14']));
  const decision = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'decision', '--title', 'A4 ou Carta?']));
  await withServer(r, async (get) => {
    const p = (await list(get)).find((x) => x.id === review13);
    assert.deepStrictEqual({ sha: p.report.sha, tests: p.report.tests }, { sha: first, tests: 'npm test: 1 falha' });
  });
  // The fix arrives after the pending decision opened: the review shows it, not the report it opened with.
  const second = commit(floor, { 'pdf.js': 'a\nc\nd\n', 'pdf.test.js': 't\n' });
  report('npm test: 2 rodadas, 0 falhas\nnpm run check: ok');
  await withServer(r, async (get) => {
    const all = await list(get);
    const p = all.find((x) => x.id === review13);
    assert.deepStrictEqual(Object.keys(p.report).sort(), ['at', 'diff', 'sha', 'tests']);
    assert.strictEqual(p.report.sha, second);
    assert.strictEqual(p.report.tests, 'npm test: 2 rodadas, 0 falhas\nnpm run check: ok');
    assert.ok(Date.parse(p.report.at) >= Date.parse(p.opened_at), `${p.report.at} after ${p.opened_at}`);
    // The diff summary as the item's reports show it (the projection's own).
    const item = (await get('/api/items/widgets/12')).item;
    const last = item.reports[item.reports.length - 1];
    assert.deepStrictEqual(p.report, { at: last.at, sha: last.sha, tests: last.tests, diff: last.diff });
    assert.deepStrictEqual(p.report.diff.files.map((f) => [f.path, f.added, f.removed]), [['pdf.js', 3, 0], ['pdf.test.js', 1, 0]]);
    assert.strictEqual(p.report.diff.base_ref, 'feature/issue-12');
    assert.strictEqual(all.find((x) => x.id === review14).report, null, 'a task without a report');
    assert.ok(!('report' in all.find((x) => x.id === decision)), 'another kind, even on the same task');
  });
});

// ---------- the owner is told by the Maestri (#44): pending open runs "maestri notify" inside a Maestri terminal ----------

const INSIDE = { MAESTRI_TERMINAL_ID: 'term-1' };
const NOTIFY_FAILED = /^aviso: a pendência P-(\d+) foi gravada, mas o maestri notify falhou: (.+); o dono pode não ter sido avisado\.\r?\n$/;

suite.test('inside a Maestri terminal, pending open runs "maestri notify" with the pending decision, its severity, the item and the title; the API shows notification sent', async () => {
  const r = buildRoot('notify');
  startItem(r);
  const review = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--severity', 'high', '--title', 'Revisar a task 13'], { extra: INSIDE }));
  const decision = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--severity', 'low', '--title', 'Qual formato, "PDF" ou CSV?'], { extra: INSIDE }));
  // The longest title still fits in a notification of up to 500 characters, whole.
  const long = 'Título longo com acentos: ação, conciliação e exportação. '.repeat(6).slice(0, 300).trim();
  const longId = openedId(flow(r, ['pending', 'open', '12', '--task', '14', '--kind', 'worker_blocked', '--severity', 'critical', '--title', long], { extra: INSIDE }));
  // Nothing recorded, no one told.
  invalid(flow(r, ['pending', 'open', '99', '--kind', 'decision', '--title', 'Item que não existe'], { extra: INSIDE }), /99/);
  invalid(flow(r, ['pending', 'open', '12', '--task', '77', '--kind', 'decision', '--title', 'Task que não existe'], { extra: INSIDE }), /77/);
  // Where to answer is checked before the notification too: the owner is never told of one that was not recorded.
  invalid(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Terminal com quebra'], { extra: { ...INSIDE, MAESTRI_TERMINAL_NAME: 'Maestro\n12' } }), /maestri/);
  const calls = maestriCalls(r);
  assert.deepStrictEqual(calls.slice(0, 2), [
    ['notify', 'Pendência nova (alta): revisão de task no item widgets/12 (#12), task 13. Revisar a task 13'],
    ['notify', 'Pendência nova (baixa): decisão no item widgets/12 (#12). Qual formato, "PDF" ou CSV?'],
  ]);
  assert.strictEqual(calls.length, 3, 'one notification per pending open');
  assert.deepStrictEqual(calls[2][0], 'notify');
  assert.ok(calls[2][1].length <= 500 && calls[2][1].startsWith('Pendência nova (crítica): trabalhador bloqueado no item widgets/12 (#12), task 14. ') && calls[2][1].endsWith(long), calls[2][1]);
  await withServer(r, async (get) => {
    const all = await list(get);
    assert.deepStrictEqual(all.map((p) => [p.id, p.notification]).sort((a, b) => a[0] - b[0]), [[review, 'sent'], [decision, 'sent'], [longId, 'sent']]);
    const opened = (await get('/api/items/widgets/12')).item.timeline.filter((e) => e.type === 'pending-decision-opened');
    assert.deepStrictEqual(opened.map((e) => e.payload.notification), ['sent', 'sent', 'sent'], 'the event records it');
  });
});

suite.test('outside of Maestri (no MAESTRI_TERMINAL_ID), pending open calls nothing and the API shows notification outside', async () => {
  const r = buildRoot('notify-outside');
  startItem(r);
  const id = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Qual formato?']));
  const empty = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Outra'], { extra: { MAESTRI_TERMINAL_ID: '' } }));
  assert.deepStrictEqual(maestriCalls(r), []);
  await withServer(r, async (get) => {
    assert.deepStrictEqual((await list(get)).map((p) => [p.id, p.notification]).sort((a, b) => a[0] - b[0]), [[id, 'outside'], [empty, 'outside']]);
  });
});

suite.test('when maestri notify fails or does not exist, pending open still records the pending decision, exits 0, prints it and warns on stderr; the API shows notification failed', async () => {
  const r = buildRoot('notify-fails');
  startItem(r);
  const failing = path.join(r.root, 'failing-maestri.js');
  fs.writeFileSync(failing, `process.stderr.write('Maestro Mode is off\\n'); process.exit(3);\n`);
  const runs = [
    flow(r, ['pending', 'open', '12', '--kind', 'decision', '--severity', 'critical', '--title', 'Com o maestri falhando'], { extra: { ...INSIDE, FLOW_MAESTRI_CLI: failing } }),
    flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Sem o maestri'], { extra: { ...INSIDE, FLOW_MAESTRI_CLI: path.join(r.root, 'nao-existe.exe') } }),
  ];
  const ids = runs.map((x) => {
    assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
    const m = /^Pendência P-(\d+) \(decisão\) aberta no item widgets\/12 \(#12\)\./.exec(x.stdout);
    assert.ok(m, `prints the pending decision as always: ${x.stdout}`);
    const warn = NOTIFY_FAILED.exec(x.stderr);
    assert.ok(warn, `one line on stderr: ${x.stderr}`);
    assert.strictEqual(warn[1], m[1], 'the warning names the pending decision');
    return { id: Number(m[1]), detail: warn[2] };
  });
  assert.strictEqual(ids[0].detail, 'Maestro Mode is off');
  assert.ok(/não achei o executável/.test(ids[1].detail), ids[1].detail);
  assert.deepStrictEqual(maestriCalls(r), []);
  await withServer(r, async (get) => {
    const all = await list(get);
    assert.deepStrictEqual(all.map((p) => [p.id, p.status, p.notification]).sort((a, b) => a[0] - b[0]), [[ids[0].id, 'open', 'failed'], [ids[1].id, 'open', 'failed']]);
  });
});

suite.test('the HML pending decision derived from flow hml calls no maestri, even inside Maestri, and has no notification', async () => {
  const r = buildRoot('notify-hml');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'hml_validation']));
  ok(flow(r, ['hml', '12', '--passed', '7', '--failed', '1'], { extra: INSIDE }));
  ok(flow(r, ['hml', '12', '--passed', '7', '--blocked', '1'], { extra: INSIDE }));
  assert.deepStrictEqual(maestriCalls(r), []);
  await withServer(r, async (get) => {
    const [p, ...rest] = await list(get, '?status=open');
    assert.strictEqual(rest.length, 0);
    assert.deepStrictEqual([p.kind, p.derived_from.type, p.notification], ['hml', 'hml-recorded', null]);
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

suite.test('a failed or blocked HML result opens an "hml" pending decision by itself; an approved result resolves it, without extra events', async () => {
  const r = buildRoot('hml');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'hml_validation']));
  ok(flow(r, ['hml', '12', '--passed', '7', '--failed', '1', '--blocked', '2', '--card', 'https://github.com/acme/widgets/issues/12']));
  let hmlId;
  await withServer(r, async (get) => {
    const open = await list(get, '?status=open');
    assert.strictEqual(open.length, 1);
    const p = open[0];
    hmlId = p.id;
    assert.deepStrictEqual([p.kind, p.severity, p.status, p.title, p.item.key, p.task], ['hml', 'high', 'open', null, 'widgets/12', null]);
    assert.deepStrictEqual(p.derived_from, { type: 'hml-recorded', passed: 7, failed: 1, blocked: 2, card_url: 'https://github.com/acme/widgets/issues/12' });
    const overview = (await get('/api/overview')).pending_decisions;
    assert.deepStrictEqual([overview.total, overview.open[0].id, overview.open[0].derived_from.failed], [1, hmlId, 1]);
    assert.strictEqual((await get('/api/state')).kpis.pending_decisions.by_severity.high, 1);
  });
  // Another failing round keeps one pending decision, with the latest numbers; then everything passes.
  ok(flow(r, ['hml', '12', '--passed', '9', '--failed', '1']));
  await withServer(r, async (get) => {
    const open = await list(get, '?status=open');
    assert.deepStrictEqual(open.map((p) => [p.id, p.derived_from.passed, p.derived_from.failed, p.derived_from.blocked]), [[hmlId, 9, 1, 0]]);
  });
  ok(flow(r, ['hml', '12', '--passed', '10']));
  await withServer(r, async (get) => {
    const all = await list(get);
    assert.deepStrictEqual(all.map((p) => [p.id, p.status, p.resolution]), [[hmlId, 'resolved', 'hml_approved']]);
    const types = (await get('/api/items/widgets/12')).item.timeline.map((e) => e.type);
    assert.deepStrictEqual(types, ['item-started', 'hml-recorded', 'hml-recorded', 'hml-recorded'], 'nothing but the HML results was recorded');
  });
});

suite.test('the HML pending decision is not repeated when the maestro opened one, closes when the item is done and can be resolved by id', async () => {
  const r = buildRoot('hml-rules');
  ok(flow(r, ['item', 'start', '12', '--title', 'Já com pendência', '--stage', 'hml_validation']));
  const explicit = openedId(flow(r, ['pending', 'open', '12', '--kind', 'hml', '--title', 'Cenário 4 falhou: aceitar?']));
  ok(flow(r, ['hml', '12', '--passed', '3', '--failed', '1']));
  ok(flow(r, ['item', 'start', '20', '--title', 'Concluído com falha aceita', '--stage', 'hml_validation']));
  ok(flow(r, ['hml', '20', '--passed', '3', '--blocked', '1']));
  ok(flow(r, ['item', 'done', '20']));
  ok(flow(r, ['item', 'start', '30', '--title', 'Resolvido pelo maestro', '--stage', 'hml_validation']));
  ok(flow(r, ['hml', '30', '--passed', '3', '--failed', '2']));
  let derived30;
  await withServer(r, async (get) => {
    const all = await list(get);
    assert.deepStrictEqual(all.filter((p) => p.item.number === 12).map((p) => [p.id, p.status, p.derived_from || null]), [[explicit, 'open', null]]);
    assert.deepStrictEqual(all.filter((p) => p.item.number === 20).map((p) => [p.status, p.resolution]), [['resolved', 'item_done']]);
    derived30 = all.find((p) => p.item.number === 30).id;
  });
  ok(flow(r, ['pending', 'resolve', `P-${derived30}`, '--decision', 'Os 2 cenários viram task nova.']));
  await withServer(r, async (get) => {
    const p = (await list(get)).find((x) => x.id === derived30);
    assert.deepStrictEqual([p.status, p.resolution, p.decision], ['resolved', 'decision', 'Os 2 cenários viram task nova.']);
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
      [d.status, d.resolution, d.decision, d.context, d.options, d.host, d.task, d.closed_by],
      ['resolved', 'decision', 'Fila, com retentativa.\nSem cron.', 'Linha 1 com acentuação\nLinha 2', ['A: Fila', 'B: Cron'], { kind: 'none', workspace: 'Pessoal', terminal: 'Maestro widgets' }, null, { role: 'owner', name: null }],
    );
    const c = all.find((p) => p.id === parallel);
    assert.deepStrictEqual([c.status, c.resolution, c.reason, c.host], ['canceled', null, 'O grafo mudou', { kind: 'none', workspace: null, terminal: null }]);
    const timeline = (await get('/api/items/widgets/12')).item.timeline.filter((e) => e.type.startsWith('pending-decision-'));
    assert.deepStrictEqual(timeline.map((e) => [e.type, e.payload.pending_decision || e.id]), [
      ['pending-decision-opened', decision], ['pending-decision-opened', parallel],
      ['pending-decision-resolved', decision], ['pending-decision-canceled', parallel],
    ]);
    assert.strictEqual(timeline[2].payload.decision, 'Fila, com retentativa.\nSem cron.');
  });
});

suite.test('the API filters by organization, project, severity and status; each count ignores only its own filter', async () => {
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
    assert.deepStrictEqual(await ids('?organization=unassigned&severity=low,normal'), [low]);
    assert.deepStrictEqual(await ids('?organization=contoso'), []);
    const x = await get('/api/pending-decisions?project=widgets&status=open');
    assert.deepStrictEqual(x.counts, { status: { open: 1, resolved: 1, canceled: 0 }, severity: { critical: 0, high: 1, normal: 0, low: 0 } });
    assert.deepStrictEqual(x.organizations, [{ id: 'unassigned', name: 'Sem organização' }]);
    const bad = await get('/api/pending-decisions?severity=alta', 400);
    assert.deepStrictEqual(bad.error, { code: 'invalid_filter', param: 'severity', value: 'alta', allowed: ['critical', 'high', 'normal', 'low'] });
    assert.strictEqual((await get('/api/pending-decisions?status=aberta', 400)).error.param, 'status');
  });
});

suite.test('the read of a linked pending decision (no organization, no filter) finds one that the selector and the screen\'s filters leave out', async () => {
  // P-440: the browser notification covers every organization; the Pendências screen shows the linked one anyway, read
  // with GET /api/pending-decisions and no parameter (every organization, every status).
  const r = buildRoot('linked');
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'widgets', '--org', 'contoso', '--repo', 'https://github.com/acme/widgets.git']));
  startItem(r);
  ok(flow(r, ['item', 'start', '7', '--title', 'Outro projeto', '--stage', 'implementation'], { cwd: r.repo2 }));
  const here = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--severity', 'high', '--title', 'Da Contoso']));
  const elsewhere = openedId(flow(r, ['pending', 'open', '7', '--kind', 'decision', '--severity', 'low', '--title', 'De outra organização'], { cwd: r.repo2 }));
  await withServer(r, async (get) => {
    const ids = async (q) => (await list(get, q)).map((p) => p.id);
    assert.deepStrictEqual(await ids('?organization=contoso&status=open'), [here], 'the selector on Contoso leaves it out');
    assert.deepStrictEqual(await ids('?organization=unassigned&status=open&severity=high'), [], 'and so does a severity filter');
    const linked = (await list(get, '')).find((p) => p.id === elsewhere);
    assert.deepStrictEqual([linked.status, linked.title, linked.item.project.organization.id], ['open', 'De outra organização', 'unassigned']);
    ok(flow(r, ['pending', 'resolve', String(elsewhere), '--decision', 'Feito'], { cwd: r.repo2 }));
    assert.strictEqual((await list(get, '')).find((p) => p.id === elsewhere).status, 'resolved', 'closed, it is still found, as it is now');
  });
});

suite.test('without maestro.db the list is empty and nothing is created', async () => {
  const r = buildRoot('empty');
  await withServer(r, async (get) => {
    assert.deepStrictEqual(await get('/api/pending-decisions'), {
      pending_decisions: [], counts: { status: { open: 0, resolved: 0, canceled: 0 }, severity: { critical: 0, high: 0, normal: 0, low: 0 } }, organizations: [],
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

// ---------- the owner's answer from the panel (#32): POST /api/pending-decisions/<id>/answer ----------

/** POST of an answer as the page sends it (X-Panel: 1, JSON). body: a value (sent as JSON) or a raw string. */
function answer(port, id, body, { headers = {}, method = 'POST' } = {}) {
  return request(port, `/api/pending-decisions/${id}/answer`, {
    method, headers: { 'X-Panel': '1', 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The answer must fail with this status and this error ({ code, ...params }). */
async function refused(port, id, body, status, error, options) {
  const x = await answer(port, id, body, options);
  assert.deepStrictEqual([x.status, x.json], [status, { error }], `${id} ${JSON.stringify(body)}: ${x.text}`);
}

suite.test('the owner answers from the panel with an option, an option and a comment, or only a comment; the API and the timeline show the owner\'s decision', async () => {
  const r = buildRoot('answer');
  startItem(r);
  const review = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--title', 'Revisar a task 13', '--option', 'A: Integrar', '--option', 'B: Pedir ajuste']));
  const parallel = openedId(flow(r, ['pending', 'open', '12', '--kind', 'parallelize', '--title', 'Paralelizar?', '--option', 'A: Paralelizar', '--option', 'B: Uma depois da outra']));
  const open = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Qual nome para o campo?']));
  // Options without a letter take the letter of their position.
  const plain = openedId(flow(r, ['pending', 'open', '12', '--kind', 'finding', '--title', 'Achado', '--option', 'Corrigir agora', '--option', 'Task nova']));
  // When some option has no letter (or two repeat), every option takes the letter of its position: none is shadowed.
  const mixed = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Misturadas', '--option', 'A: Integrar', '--option', 'Pedir ajuste', '--option', 'B: Descartar']));
  await withServer(r, async (get, port) => {
    const answered = async (id, body, decision) => {
      const x = await answer(port, id, body);
      assert.strictEqual(x.status, 200, x.text);
      const listed = (await list(get)).find((p) => p.id === x.json.id);
      assert.deepStrictEqual(x.json, listed, 'the answer is the pending decision as GET /api/pending-decisions lists it');
      assert.deepStrictEqual(
        [x.json.status, x.json.resolution, x.json.decision, x.json.closed_by, x.json.reason],
        ['resolved', 'decision', decision, { role: 'owner', name: null }, null],
      );
      assert.ok(Date.parse(x.json.closed_at) > 0, x.json.closed_at);
      return x.json;
    };
    await answered(`P-${review}`, { option: 'B', text: null }, 'B: Pedir ajuste');
    await answered(String(parallel), { option: 'a', text: '  pode, mas a 14 integra primeiro  ' }, 'A: Paralelizar — pode, mas a 14 integra primeiro');
    await answered(`p-${open}`, { text: 'Use "valor_total".\r\nSem abreviação.' }, 'Use "valor_total".\nSem abreviação.');
    await answered(`P-${plain}`, { option: 'B', text: '' }, 'Task nova');
    await answered(`P-${mixed}`, { option: 'C' }, 'B: Descartar');
    const timeline = (await get('/api/items/widgets/12')).item.timeline.filter((e) => e.type === 'pending-decision-resolved');
    assert.deepStrictEqual(timeline.map((e) => [e.payload, e.agent, e.source, e.task_number]), [
      [{ pending_decision: review, decision: 'B: Pedir ajuste' }, { role: 'owner', name: null }, 'panel', 13],
      [{ pending_decision: parallel, decision: 'A: Paralelizar — pode, mas a 14 integra primeiro' }, { role: 'owner', name: null }, 'panel', null],
      [{ pending_decision: open, decision: 'Use "valor_total".\nSem abreviação.' }, { role: 'owner', name: null }, 'panel', null],
      [{ pending_decision: plain, decision: 'Task nova' }, { role: 'owner', name: null }, 'panel', null],
      [{ pending_decision: mixed, decision: 'B: Descartar' }, { role: 'owner', name: null }, 'panel', null],
    ]);
    // The menu counter no longer counts them.
    assert.strictEqual((await get('/api/state')).kpis.pending_decisions.total, 0);
  });
  // The maestro's resolve of a pending decision the panel already answered is the usual "not open".
  invalid(flow(r, ['pending', 'resolve', `P-${review}`, '--decision', 'A']), /já está resolvida/);
});

suite.test('an answer to a pending decision that is no longer open is 409 pending_decision_not_open, with how and when it closed', async () => {
  const r = buildRoot('answer-closed');
  startItem(r);
  const twice = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Duas respostas', '--option', 'A: Sim', '--option', 'B: Não']));
  const canceled = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Cancelada']));
  const review = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--title', 'Revisar a task 13']));
  const byCli = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Resolvida no terminal']));
  ok(flow(r, ['pending', 'cancel', String(canceled), '--reason', 'Não precisa mais']));
  ok(flow(r, ['task', 'integrate', '12', '13', '--sha', 'a1b2c3d4e5f6']));
  ok(flow(r, ['pending', 'resolve', String(byCli), '--decision', 'Dito no terminal']));
  await withServer(r, async (get, port) => {
    const first = await answer(port, `P-${twice}`, { option: 'A' });
    assert.strictEqual(first.status, 200, first.text);
    const closed = async (id) => (await list(get)).find((p) => p.id === id);
    for (const id of [twice, canceled, review, byCli]) {
      const p = await closed(id);
      await refused(port, `P-${id}`, { option: 'B', text: 'de novo' }, 409, { code: 'pending_decision_not_open', id, status: p.status, closed_at: p.closed_at, resolution: p.resolution });
    }
    const p = await closed(twice);
    assert.deepStrictEqual([p.decision, p.closed_by], ['A: Sim', { role: 'owner', name: null }], 'the first answer is the decision');
    assert.deepStrictEqual([(await closed(canceled)).status, (await closed(review)).resolution, (await closed(byCli)).decision], ['canceled', 'task_integrated', 'Dito no terminal']);
    const resolved = (await get('/api/items/widgets/12')).item.timeline.filter((e) => e.type === 'pending-decision-resolved');
    assert.deepStrictEqual(resolved.map((e) => e.payload.pending_decision), [byCli, twice], 'a refused answer records nothing');
  });
});

suite.test('a bad answer is refused with a code and records nothing; the route follows the rules of the other POSTs', async () => {
  const r = buildRoot('answer-invalid');
  startItem(r);
  const id = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Com opções', '--option', 'A: Fila', '--option', 'B: Cron']));
  const bare = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Sem opções']));
  await withServer(r, async (get, port) => {
    const P = `P-${id}`;
    await refused(port, P, 'isto não é JSON', 400, { code: 'invalid_body' });
    await refused(port, P, '[]', 400, { code: 'invalid_body' });
    await refused(port, P, '', 400, { code: 'invalid_body' });
    await refused(port, P, { text: 42 }, 400, { code: 'invalid_body', field: 'text' });
    await refused(port, P, { option: 7 }, 400, { code: 'invalid_option', value: '7' });
    await refused(port, P, { option: 'AB' }, 400, { code: 'invalid_option', value: 'AB' });
    await refused(port, P, { option: '' }, 400, { code: 'invalid_option', value: '' });
    await refused(port, P, {}, 400, { code: 'answer_empty' });
    await refused(port, P, { option: null, text: '  \n ' }, 400, { code: 'answer_empty' });
    await refused(port, P, { option: 'C' }, 400, { code: 'option_not_found', id, option: 'C', options: ['A', 'B'] });
    await refused(port, `P-${bare}`, { option: 'A', text: 'ok' }, 400, { code: 'option_not_found', id: bare, option: 'A', options: [] });
    // The CLI's limit for a decision: 2000 characters, the option and the comment together.
    await refused(port, P, { text: 'x'.repeat(2001) }, 400, { code: 'answer_too_long', length: 2001, max: 2000 });
    await refused(port, P, { option: 'A', text: 'x'.repeat(1995) }, 400, { code: 'answer_too_long', length: 'A: Fila — '.length + 1995, max: 2000 });
    await refused(port, 'P-999', { option: 'A' }, 404, { code: 'pending_decision_not_found', id: 999 });
    await refused(port, 'xyz', { option: 'A' }, 404, { code: 'route_not_found' });
    await refused(port, 'P-0', { option: 'A' }, 404, { code: 'route_not_found' });
    await refused(port, P, { option: 'A' }, 403, { code: 'missing_panel_header', header: 'X-Panel' }, { headers: { 'X-Panel': '' } });
    await refused(port, P, { option: 'A' }, 403, { code: 'origin_not_allowed' }, { headers: { Origin: 'http://evil.example' } });
    await refused(port, P, undefined, 405, { code: 'method_not_allowed', method: 'GET', allowed: ['POST'] }, { method: 'GET' });
    await refused(port, P, JSON.stringify({ text: 'x'.repeat(20 * 1024) }), 413, { code: 'body_too_large', limit_kb: 16 });
    const still = (await list(get)).filter((p) => p.status === 'open').map((p) => p.id).sort();
    assert.deepStrictEqual(still, [id, bare].sort(), 'nothing was recorded');
    // The panel's own Origin and the full 2000 characters are accepted.
    const x = await answer(port, P, { text: 'y'.repeat(2000) }, { headers: { Origin: `http://127.0.0.1:${port}` } });
    assert.strictEqual(x.status, 200, x.text);
    assert.strictEqual(x.json.decision.length, 2000);
  });
});

suite.test('an answer without maestro.db is 404 and creates nothing; an unreadable maestro.db is 503 database_unreadable', async () => {
  const r = buildRoot('answer-no-db');
  await withServer(r, async (get, port) => {
    await refused(port, 'P-1', { option: 'A' }, 404, { code: 'pending_decision_not_found', id: 1 });
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')));
  fs.mkdirSync(r.data, { recursive: true });
  fs.writeFileSync(path.join(r.data, 'maestro.db'), 'isto não é um banco SQLite '.repeat(100));
  await withServer(r, async (get, port) => {
    const x = await answer(port, 'P-1', { option: 'A' });
    assert.deepStrictEqual([x.status, x.json.error.code, x.json.error.file, typeof x.json.error.detail], [503, 'database_unreadable', 'maestro.db', 'string']);
  });
});

suite.test('POST on the list of pending decisions is still 405', async () => {
  const r = buildRoot('list-post');
  await withServer(r, async (get, port) => {
    const post = await request(port, '/api/pending-decisions', { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.strictEqual(post.status, 405);
  });
});

suite.test('the menu counter (/api/state) counts the open pending decisions of every organization, by severity', async () => {
  const r = buildRoot('counter');
  await withServer(r, async (get) => {
    assert.deepStrictEqual((await get('/api/state')).kpis.pending_decisions, { total: 0, by_severity: { critical: 0, high: 0, normal: 0, low: 0 }, open: [] });
  });
  startItem(r);
  ok(flow(r, ['item', 'start', '7', '--title', 'Outro', '--stage', 'implementation'], { cwd: r.repo2 }));
  openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'worker_blocked', '--severity', 'critical', '--title', 'Falta o certificado']));
  openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Qual formato?']));
  openedId(flow(r, ['pending', 'open', '7', '--kind', 'decision', '--severity', 'high', '--title', 'De gadgets'], { cwd: r.repo2 }));
  const resolved = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--severity', 'high', '--title', 'Já decidida']));
  ok(flow(r, ['pending', 'resolve', String(resolved), '--decision', 'A']));
  const canceled = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--severity', 'low', '--title', 'Cancelada']));
  ok(flow(r, ['pending', 'cancel', String(canceled)]));
  await withServer(r, async (get) => {
    const { open, ...counter } = (await get('/api/state')).kpis.pending_decisions;
    assert.deepStrictEqual(counter, { total: 3, by_severity: { critical: 1, high: 1, normal: 1, low: 0 } });
    assert.strictEqual(open.length, 3, 'the open ones are listed too (#45, test-state-open.js)');
  });
});

// ---------- the maestro waits for the pending decision (#33): flow pending wait <id> ----------

const WAITING = /^Esperando a pendência P-\d+/m;
const FROM_PANEL = 'A decisão veio do painel e já está gravada: siga com ela; não rode flow pending resolve.';

/**
 * flow pending wait as a real process, polling every 50 ms (FLOW_WAIT_INTERVAL_MS). started(): resolves once it said it
 * is waiting (so whatever closes the pending decision afterwards happens while it runs); done: { status, stdout, stderr }.
 */
function startWait(r, args, { cwd = r.repo, input } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', FLOW_WAIT_INTERVAL_MS: '50' });
  for (const k of ['MAESTRI_TERMINAL_ID', 'MAESTRI_TERMINAL_NAME', 'MAESTRI_WORKSPACE_ID', 'MAESTRI_WORKSPACE_NAME']) delete env[k];
  const child = spawn(process.execPath, [FLOW, 'pending', 'wait', ...args], { cwd, env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  let onOut = () => {};
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s) => { stdout += s; onOut(); });
  child.stderr.on('data', (s) => { stderr += s; });
  child.stdin.end(input === undefined ? '' : input);
  const timer = setTimeout(() => child.kill(), 30000);
  const done = new Promise((resolve) => child.on('close', (status) => {
    clearTimeout(timer);
    resolve({ status, stdout, stderr });
  }));
  const started = () => new Promise((resolve, reject) => {
    const check = () => { if (WAITING.test(stdout)) resolve(); };
    onOut = check;
    check();
    done.then((x) => reject(new Error(`the wait ended before waiting: exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`)));
  });
  return { started, done, running: () => child.exitCode === null };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The lines the wait printed when it ended, without the "Esperando…" one. */
async function ended(w) {
  const x = ok(await w.done);
  return x.stdout.split(/\r?\n/).filter((l) => l && !WAITING.test(l));
}

suite.test('pending wait, started while the pending decision is open, ends with exit 0 when the owner answers from the panel and says the decision came from it', async () => {
  const r = buildRoot('wait-panel');
  startItem(r);
  const id = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--title', 'Revisar a task 13', '--option', 'A: Integrar', '--option', 'B: Pedir ajuste']));
  const w = startWait(r, [`P-${id}`]);
  await w.started();
  await pause(300);
  assert.ok(w.running(), 'no timeout: it keeps waiting while the pending decision is open');
  let closedAt;
  await withServer(r, async (get, port) => {
    const x = await answer(port, `P-${id}`, { option: 'B', text: 'mantenha o nome antigo' });
    assert.strictEqual(x.status, 200, x.text);
    closedAt = x.json.closed_at;
  });
  assert.deepStrictEqual(await ended(w), [
    `Pendência P-${id} do item widgets/12 (#12), task 13, fechou: resolvida com a decisão do dono.`,
    'Título: Revisar a task 13',
    'Decisão: B: Pedir ajuste — mantenha o nome antigo',
    `Fechada por: dono, pelo painel, em ${closedAt}.`,
    FROM_PANEL,
  ]);
});

suite.test('pending wait also ends when the maestro resolves, cancels, integrates the task, replaces the HML one, the HML passes or the item is done, with how it closed, the decision or the reason and who closed it', async () => {
  const r = buildRoot('wait-other');
  startItem(r);
  ok(flow(r, ['item', 'start', '20', '--title', 'Com HML reprovada', '--stage', 'hml_validation']));
  ok(flow(r, ['hml', '20', '--passed', '3', '--failed', '1']));
  ok(flow(r, ['item', 'start', '30', '--title', 'HML substituída', '--stage', 'hml_validation']));
  ok(flow(r, ['hml', '30', '--passed', '3', '--blocked', '1']));
  ok(flow(r, ['item', 'start', '40', '--title', 'HML aprovada depois', '--stage', 'hml_validation']));
  ok(flow(r, ['hml', '40', '--passed', '3', '--failed', '2']));
  const resolved = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Fila ou cron?']));
  const canceled = openedId(flow(r, ['pending', 'open', '12', '--kind', 'parallelize', '--title', 'Paralelizar 13 e 14?']));
  const silent = openedId(flow(r, ['pending', 'open', '12', '--kind', 'finding', '--title', 'Cancelada sem motivo']));
  const review = openedId(flow(r, ['pending', 'open', '12', '--task', '13', '--kind', 'task_review', '--title', 'Revisar a task 13']));
  let hml;
  let replaced;
  let approved;
  await withServer(r, async (get) => {
    const all0 = await list(get);
    const derived = (n) => all0.find((p) => p.item.number === n).id;
    [hml, replaced, approved] = [derived(20), derived(30), derived(40)];
  });
  const waits = {};
  for (const [name, id] of Object.entries({ resolved, canceled, silent, review, hml, replaced, approved })) waits[name] = startWait(r, [String(id)]);
  await Promise.all(Object.values(waits).map((w) => w.started()));
  ok(flow(r, ['pending', 'resolve', `P-${resolved}`, '--decision', 'Fila, com retentativa.\nSem cron.', '--agent', 'Maestro widgets']));
  ok(flow(r, ['pending', 'cancel', `P-${canceled}`, '--reason', 'O grafo mudou']));
  ok(flow(r, ['pending', 'cancel', `P-${silent}`]));
  ok(flow(r, ['task', 'integrate', '12', '13', '--sha', 'a1b2c3d4e5f6', '--agent', 'Bento']));
  ok(flow(r, ['item', 'done', '20', '--role', 'owner']));
  ok(flow(r, ['pending', 'open', '30', '--kind', 'hml', '--title', 'Cenário 4 bloqueado: seguir?', '--agent', 'Maestro widgets']));
  ok(flow(r, ['hml', '40', '--passed', '5', '--role', 'owner']));
  const out = {};
  for (const [name, w] of Object.entries(waits)) out[name] = await ended(w);
  let all;
  await withServer(r, async (get) => {
    all = await list(get);
  });
  const at = (id) => all.find((p) => p.id === id).closed_at;
  assert.deepStrictEqual(out.resolved, [
    `Pendência P-${resolved} do item widgets/12 (#12), fechou: resolvida com a decisão do dono.`,
    'Título: Fila ou cron?',
    'Decisão: Fila, com retentativa.',
    'Sem cron.',
    `Fechada por: maestro (Maestro widgets), em ${at(resolved)}.`,
  ]);
  assert.deepStrictEqual(out.canceled, [
    `Pendência P-${canceled} do item widgets/12 (#12), fechou: cancelada.`,
    'Título: Paralelizar 13 e 14?',
    'Motivo: O grafo mudou',
    `Fechada por: maestro, em ${at(canceled)}.`,
  ]);
  assert.deepStrictEqual(out.silent.slice(2, 3), ['Motivo: não informado.']);
  assert.deepStrictEqual(out.review, [
    `Pendência P-${review} do item widgets/12 (#12), task 13, fechou: resolvida pela integração da task.`,
    'Título: Revisar a task 13',
    `Fechada por: maestro (Bento), em ${at(review)}.`,
  ]);
  // The HML pending decision derived from the result has no title.
  assert.deepStrictEqual(out.hml, [
    `Pendência P-${hml} do item widgets/20 (#20), fechou: resolvida porque o item foi concluído.`,
    `Fechada por: dono, em ${at(hml)}.`,
  ]);
  assert.deepStrictEqual(out.replaced, [
    `Pendência P-${replaced} do item widgets/30 (#30), fechou: resolvida porque o maestro abriu outra pendência de HML no lugar dela.`,
    `Fechada por: maestro (Maestro widgets), em ${at(replaced)}.`,
  ]);
  assert.deepStrictEqual(out.approved, [
    `Pendência P-${approved} do item widgets/40 (#40), fechou: resolvida porque uma Validação HML seguinte passou em tudo.`,
    `Fechada por: dono, em ${at(approved)}.`,
  ]);
});

suite.test('pending wait ends at once when the pending decision was already closed, and takes the id by --json -', async () => {
  const r = buildRoot('wait-closed');
  startItem(r);
  const id = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Já decidida', '--option', 'A: Sim', '--option', 'B: Não']));
  await withServer(r, async (get, port) => {
    assert.strictEqual((await answer(port, `P-${id}`, { option: 'A' })).status, 200);
  });
  const t0 = Date.now();
  const x = ok(await startWait(r, ['--json', '-'], { input: JSON.stringify({ id: `P-${id}` }) }).done);
  assert.ok(Date.now() - t0 < 15000);
  assert.ok(!WAITING.test(x.stdout), x.stdout);
  assert.ok(x.stdout.startsWith(`Pendência P-${id} do item widgets/12 (#12), fechou: resolvida com a decisão do dono.\n`), x.stdout);
  assert.ok(x.stdout.includes('Decisão: A: Sim\n') && x.stdout.includes(FROM_PANEL), x.stdout);
});

suite.test('pending wait exits 2 with a clear message for an invalid id or a pending decision the project does not have, and records nothing', async () => {
  const r = buildRoot('wait-invalid');
  const waitSync = (args, cwd = r.repo) => flow(r, ['pending', 'wait', ...args], { cwd, extra: { FLOW_WAIT_INTERVAL_MS: '50' } });
  // Before any maestro.db: nothing is created.
  invalid(waitSync(['P-1']), /a pendência P-1 não existe: ainda não há banco do painel em .*\/data\/maestro\.db/);
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')));
  startItem(r);
  invalid(waitSync([]), /falta o id da pendência/);
  invalid(waitSync(['xyz']), /id de pendência inválido: "xyz"/);
  invalid(waitSync(['P-999']), /a pendência P-999 não existe no projeto "widgets"/);
  invalid(waitSync(['P-1', '--decision', 'a']), /opção desconhecida: --decision/);
  const id = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'De widgets']));
  // From another repository (not registered): the wait only reads, so it does not register it.
  invalid(waitSync([String(id)], r.repo2), /não existe: o repositório github\.com\/acme\/gadgets não tem projeto no painel/);
  await withServer(r, async (get) => {
    assert.deepStrictEqual((await get('/api/projects')).projects.map((p) => p.id), ['widgets']);
  });
});

suite.test('help lists the pending subcommands, kinds and where the owner answers', () => {
  const r = buildRoot('help');
  const x = ok(flow(r, ['--help']));
  for (const s of ['pending open <número>', 'pending resolve <id>', 'pending cancel <id>', 'pending wait <id>', 'FLOW_WAIT_INTERVAL_MS', 'task_review', 'worker_blocked', 'parallelize', 'MAESTRI_WORKSPACE_NAME', 'MAESTRI_TERMINAL_NAME', 'maestri notify']) {
    assert.ok(x.stdout.includes(s), `${s} in:\n${x.stdout}`);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
