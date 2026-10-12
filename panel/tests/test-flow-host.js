'use strict';
// Tests for the Host (#62): where the flow runs (a plain terminal, the Maestri or the Orca), through the agreed seam only:
// the bin/flow.js CLI runs as a process inside a temporary git repository (with a fictitious remote origin) → temporary
// maestro.db (MAESTRO_DIR) → the server's HTTP API. The "orca" and the "maestri" are fake scripts (FLOW_ORCA_CLI,
// FLOW_MAESTRI_CLI) that only record the arguments they got; the real ones are never called. Every process gets an
// environment without ORCA_* and MAESTRI_* (util.js clears them at load), plus only the variables the case wants.
// The events written before the Host (payload "maestri") are seeded with the store's appendEvent: the log is append-only
// (ADR 0002) and those events must still read the same.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const { openStore } = require(path.join(REPO, 'bin', 'flow-store.js'));
const suite = createSuite('Host (#62): flow host, status and pending notice in the Orca, dispatch mode');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A fake CLI that records its arguments as <name>-<n>.json; it prints out, writes err and exits with code. */
function fakeCli(root, name, { out = '', err = '', code = 0 } = {}) {
  const file = path.join(root, `${name}.js`);
  fs.writeFileSync(file, [
    `require('fs').writeFileSync(require('path').join(${JSON.stringify(root)}, ${JSON.stringify(`${name}-`)} + process.hrtime.bigint() + '.json'), JSON.stringify(process.argv.slice(2)));`,
    out ? `process.stdout.write(${JSON.stringify(out)});` : '',
    err ? `process.stderr.write(${JSON.stringify(err)});` : '',
    `process.exit(${code});`,
  ].join('\n'));
  return file;
}

const ORCA_OK = JSON.stringify({ id: 'x', ok: true, result: { runtime: { state: 'ready', reachable: true } } });

/** Temporary root: data folder, a git repository with a fictitious origin, a fake orca and a fake maestri. */
function buildRoot(name) {
  const root = tmpDir(`host-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'feature/issue-12');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  const orca = fakeCli(root, 'orca', { out: ORCA_OK });
  const maestri = fakeCli(root, 'maestri');
  return { root, data, repo, orca, maestri };
}

const ORCA = { ORCA_TERMINAL_HANDLE: 'term_maestro', ORCA_WORKTREE_ID: 'repo-1::D:/orca/painel', TERM_PROGRAM: 'Orca' };
const MAESTRI = { MAESTRI_TERMINAL_ID: 'term-1', MAESTRI_TERMINAL_NAME: 'Maestro 12', MAESTRI_WORKSPACE_NAME: 'Contoso' };

/** Runs the CLI in a plain terminal, unless extra sets the variables of an Orca or a Maestri terminal. */
function flow(r, args, { cwd = r.repo, input, extra = {} } = {}) {
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', FLOW_ORCA_CLI: r.orca, FLOW_MAESTRI_CLI: r.maestri, GIT_CEILING_DIRECTORIES: r.root,
  }, extra);
  return spawnSync(process.execPath, [FLOW, ...args], { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
  return x;
}

/** Arguments each fake received ("orca" or "maestri"), in call order. */
const calls = (r, name) => fs.readdirSync(r.root).filter((n) => new RegExp(`^${name}-\\d+\\.json$`).test(n))
  .sort((a, b) => (BigInt(a.slice(name.length + 1, -5)) < BigInt(b.slice(name.length + 1, -5)) ? -1 : 1))
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

const hostJson = (x) => {
  ok(x);
  return JSON.parse(x.stdout);
};

// ---------- flow host ----------

suite.test('flow host in a plain terminal: kind none, no check calls anything, exit 0; it needs no repository', () => {
  const r = buildRoot('none');
  const h = hostJson(flow(r, ['host', '--json'], { cwd: r.root }));
  assert.deepStrictEqual(h, { kind: 'none', terminal: null, workspace: null, checks: { orca_terminal: false, maestri_terminal: false, orca_status: null } });
  const text = ok(flow(r, ['host'], { cwd: r.root }));
  assert.ok(/Ambiente: terminal comum/.test(text.stdout), text.stdout);
  // A blank variable counts as absent.
  assert.strictEqual(hostJson(flow(r, ['host', '--json'], { extra: { ORCA_TERMINAL_HANDLE: '', MAESTRI_TERMINAL_ID: ' ' } })).kind, 'none');
  assert.deepStrictEqual(calls(r, 'orca'), []);
  assert.deepStrictEqual(calls(r, 'maestri'), []);
});

suite.test('flow host in a Maestri terminal: kind maestri with its terminal and workspace; the orca is not asked', () => {
  const r = buildRoot('maestri');
  const h = hostJson(flow(r, ['host', '--json'], { extra: { ...MAESTRI, MAESTRI_WORKSPACE_ID: 'ws-9' } }));
  assert.deepStrictEqual(h, { kind: 'maestri', terminal: 'term-1', workspace: 'ws-9', checks: { orca_terminal: false, maestri_terminal: true, orca_status: null } });
  const text = ok(flow(r, ['host'], { extra: MAESTRI }));
  assert.ok(/Ambiente: Maestri/.test(text.stdout), text.stdout);
  assert.deepStrictEqual(calls(r, 'orca'), []);
});

suite.test('flow host in an Orca terminal: kind orca with the terminal and the worktree, and "orca status --json" in the checks', () => {
  const r = buildRoot('orca');
  const h = hostJson(flow(r, ['host', '--json'], { extra: ORCA }));
  assert.deepStrictEqual(h, {
    kind: 'orca', terminal: 'term_maestro', workspace: 'repo-1::D:/orca/painel',
    checks: { orca_terminal: true, maestri_terminal: false, orca_status: { ok: true, detail: null } },
  });
  assert.deepStrictEqual(calls(r, 'orca'), [['status', '--json']]);
  const text = ok(flow(r, ['host'], { extra: ORCA }));
  assert.ok(/Ambiente: Orca/.test(text.stdout) && /orca status/.test(text.stdout), text.stdout);
});

suite.test('flow host with both terminals: the Orca wins and the checks say both exist', () => {
  const r = buildRoot('both');
  const h = hostJson(flow(r, ['host', '--json'], { extra: { ...ORCA, ...MAESTRI } }));
  assert.strictEqual(h.kind, 'orca');
  assert.deepStrictEqual([h.checks.orca_terminal, h.checks.maestri_terminal, h.checks.orca_status.ok], [true, true, true]);
  const text = ok(flow(r, ['host'], { extra: { ...ORCA, ...MAESTRI } }));
  assert.ok(/Maestri/.test(text.stdout), `the text mentions the Maestri terminal too:\n${text.stdout}`);
});

suite.test('flow host in the Orca with "orca status" failing, unreachable or missing still exits 0, and the check says why', () => {
  const r = buildRoot('orca-check');
  const failing = fakeCli(r.root, 'orca-fails', { err: 'Orca is not running\n', code: 1 });
  const down = fakeCli(r.root, 'orca-down', { out: JSON.stringify({ ok: true, result: { runtime: { state: 'stopped', reachable: false } } }) });
  for (const [cli, detail] of [[failing, /Orca is not running/], [down, /stopped|acessível/], [path.join(r.root, 'nao-existe.exe'), /não achei o executável/]]) {
    const h = hostJson(flow(r, ['host', '--json'], { extra: { ...ORCA, FLOW_ORCA_CLI: cli } }));
    assert.strictEqual(h.kind, 'orca');
    assert.strictEqual(h.checks.orca_status.ok, false);
    assert.ok(detail.test(h.checks.orca_status.detail), h.checks.orca_status.detail);
  }
  const text = ok(flow(r, ['host'], { extra: { ...ORCA, FLOW_ORCA_CLI: failing } }));
  assert.ok(/Orca is not running/.test(text.stdout), text.stdout);
  for (const args of [['--verbose'], ['--json', '--json'], ['agora']]) {
    const bad = flow(r, ['host', ...args]);
    assert.strictEqual(bad.status, 2, `${args.join(' ')}: ${bad.stderr}`);
    assert.ok(bad.stderr.startsWith('erro: '), bad.stderr);
  }
});

// ---------- flow status in the Orca ----------

suite.test('flow status in the Orca moves the worktree card: working and blocked → in-progress (blocked also unread), review and done → in-review', async () => {
  const r = buildRoot('status');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '12', '--task', '13|Gerar o PDF']));
  const steps = [
    [['Testes verdes', '--progress', '2/5'], ['in-progress', 'Testes verdes (2/5)']],
    [['Preciso de uma decisão', '--state', 'blocked'], ['in-progress', 'Preciso de uma decisão', '--unread']],
    [['Pronto para revisar', '--state', 'review'], ['in-review', 'Pronto para revisar']],
    [['Tudo pronto', '--state', 'done'], ['in-review', 'Tudo pronto']],
  ];
  for (const [args] of steps) {
    const x = ok(flow(r, ['status', ...args, '--item', '12', '--task', '13'], { extra: ORCA }));
    assert.ok(/Orca/.test(x.stdout), x.stdout);
  }
  assert.deepStrictEqual(calls(r, 'orca'), steps.map(([, [status, comment, ...rest]]) => [
    'worktree', 'set', '--worktree', 'current', '--workspace-status', status, '--comment', comment, ...rest, '--json',
  ]));
  assert.deepStrictEqual(calls(r, 'maestri'), [], 'the maestri is not called in the Orca');
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    const statuses = item.timeline.filter((e) => e.type === 'task-status');
    assert.deepStrictEqual(statuses.map((e) => e.payload.host), Array(4).fill({ kind: 'orca', result: 'posted' }));
    assert.ok(statuses.every((e) => !('maestri' in e.payload)), 'new events record host instead of maestri');
    assert.deepStrictEqual([item.tasks[0].state, item.tasks[0].status_host], ['review', { kind: 'orca', result: 'posted' }]);
  });
});

suite.test('flow status: with both terminals the Orca wins; in the Maestri and in a plain terminal the event records its host', async () => {
  const r = buildRoot('status-hosts');
  ok(flow(r, ['item', 'start', '20', '--title', 'Item', '--stage', 'implementation']));
  ok(flow(r, ['status', 'No Orca e no Maestri', '--item', '20'], { extra: { ...ORCA, ...MAESTRI } }));
  const m = ok(flow(r, ['status', 'Só no Maestri', '--item', '20'], { extra: MAESTRI }));
  assert.ok(/maestri floor status/.test(m.stdout), m.stdout);
  const none = ok(flow(r, ['status', 'Terminal comum', '--item', '20']));
  assert.ok(/só gravado no painel/.test(none.stdout), none.stdout);
  assert.strictEqual(calls(r, 'orca').length, 1);
  assert.deepStrictEqual(calls(r, 'maestri'), [['floor', 'status', 'Só no Maestri', '--state', 'working']]);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/20')).item;
    assert.deepStrictEqual(item.timeline.filter((e) => e.type === 'task-status').map((e) => e.payload.host), [
      { kind: 'orca', result: 'posted' }, { kind: 'maestri', result: 'posted' }, { kind: 'none', result: 'outside' },
    ]);
  });
});

suite.test('when "orca worktree set" fails or does not exist, flow status records the event and exits 1', async () => {
  const r = buildRoot('status-fails');
  ok(flow(r, ['item', 'start', '50', '--title', 'Falha do Orca', '--stage', 'implementation']));
  const failing = fakeCli(r.root, 'orca-fails', { err: 'worktree not found\n', code: 2 });
  const x = flow(r, ['status', 'Trabalhando', '--item', '50'], { extra: { ...ORCA, FLOW_ORCA_CLI: failing } });
  assert.strictEqual(x.status, 1, x.stderr);
  assert.ok(/gravado no painel, mas o orca worktree set falhou: worktree not found/.test(x.stderr), x.stderr);
  const missing = flow(r, ['status', 'Sem orca', '--item', '50'], { extra: { ...ORCA, FLOW_ORCA_CLI: path.join(r.root, 'nao-existe.exe') } });
  assert.strictEqual(missing.status, 1, missing.stderr);
  assert.ok(/não achei o executável .*FLOW_ORCA_CLI/.test(missing.stderr), missing.stderr);
  // Exit 0 with {"ok": false} on --json is a failure too.
  const notOk = fakeCli(r.root, 'orca-not-ok', { out: JSON.stringify({ ok: false, error: { message: 'no current worktree' } }) });
  const y = flow(r, ['status', 'Recusado', '--item', '50'], { extra: { ...ORCA, FLOW_ORCA_CLI: notOk } });
  assert.strictEqual(y.status, 1, y.stderr);
  assert.ok(/no current worktree/.test(y.stderr), y.stderr);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/50')).item;
    assert.deepStrictEqual(item.timeline.filter((e) => e.type === 'task-status').map((e) => e.payload.host.result), ['failed', 'failed', 'failed']);
    assert.strictEqual(item.tasks[0].state, 'working');
  });
});

// ---------- flow pending open in the Orca ----------

const openedId = (x) => {
  ok(x);
  const m = /Pendência P-(\d+)/.exec(x.stdout);
  assert.ok(m, x.stdout);
  return Number(m[1]);
};
const pendingList = async (get) => (await get('/api/pending-decisions')).pending_decisions;

suite.test('flow pending open in the Orca marks the maestro\'s worktree unread and records where to answer: the worktree and the terminal', async () => {
  const r = buildRoot('pending');
  ok(flow(r, ['item', 'start', '12', '--title', 'Item', '--stage', 'implementation']));
  const id = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Qual formato?'], { extra: ORCA }));
  const given = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Outra', '--workspace', 'Painel', '--terminal', 'Maestro 12'], { extra: ORCA }));
  assert.deepStrictEqual(calls(r, 'orca'), Array(2).fill(['worktree', 'set', '--worktree', 'current', '--unread', '--json']));
  assert.deepStrictEqual(calls(r, 'maestri'), []);
  await withServer(r, async (get) => {
    const byId = new Map((await pendingList(get)).map((p) => [p.id, p]));
    assert.deepStrictEqual([byId.get(id).host, byId.get(id).notification], [{ kind: 'orca', workspace: 'repo-1::D:/orca/painel', terminal: 'term_maestro' }, 'sent']);
    assert.deepStrictEqual(byId.get(given).host, { kind: 'orca', workspace: 'Painel', terminal: 'Maestro 12' }, '--workspace/--terminal win');
    assert.ok(!('maestri' in byId.get(id)), 'the API shows host, not maestri');
    const opened = (await get('/api/items/widgets/12')).item.timeline.filter((e) => e.type === 'pending-decision-opened');
    assert.deepStrictEqual(opened.map((e) => [e.payload.host.kind, 'maestri' in e.payload]), [['orca', false], ['orca', false]]);
  });
});

suite.test('when the Orca notice fails, pending open still records it, exits 0 and writes one line on stderr', async () => {
  const r = buildRoot('pending-fails');
  ok(flow(r, ['item', 'start', '12', '--title', 'Item', '--stage', 'implementation']));
  const failing = fakeCli(r.root, 'orca-fails', { err: 'Orca is not running\n', code: 1 });
  const x = flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Com o Orca falhando'], { extra: { ...ORCA, FLOW_ORCA_CLI: failing } });
  assert.strictEqual(x.status, 0, x.stderr);
  const lines = x.stderr.split(/\r?\n/).filter(Boolean);
  assert.strictEqual(lines.length, 1, x.stderr);
  assert.ok(/^aviso: a pendência P-\d+ foi gravada, mas o aviso do Orca \(orca worktree set --unread\) falhou: Orca is not running; o dono pode não ter sido avisado\.$/.test(lines[0]), lines[0]);
  await withServer(r, async (get) => {
    const [p] = await pendingList(get);
    assert.deepStrictEqual([p.status, p.notification, p.host.kind], ['open', 'failed', 'orca']);
  });
});

suite.test('pending open in a plain terminal calls nothing and records host none with what was given', async () => {
  const r = buildRoot('pending-none');
  ok(flow(r, ['item', 'start', '12', '--title', 'Item', '--stage', 'implementation']));
  const id = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Sem ambiente', '--terminal', 'Aba 2']));
  await withServer(r, async (get) => {
    const p = (await pendingList(get)).find((x) => x.id === id);
    assert.deepStrictEqual([p.host, p.notification], [{ kind: 'none', workspace: null, terminal: 'Aba 2' }, 'outside']);
  });
  assert.deepStrictEqual([calls(r, 'orca'), calls(r, 'maestri')], [[], []]);
});

// ---------- events written before the Host ----------

suite.test('events written before the Host (payload maestri) read as kind maestri with the same result', async () => {
  const r = buildRoot('old-events');
  ok(flow(r, ['item', 'start', '30', '--title', 'Item antigo', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '30', '--task', '31|Uma', '--task', '32|Outra']));
  const store = openStore({ dir: r.data });
  let pendingId;
  let outsideId;
  try {
    const base = { at: '2026-10-01T10:00:00-03:00', projectId: 'widgets', itemNumber: 30, source: 'cli' };
    store.appendEvent({ ...base, taskNumber: 31, agentRole: 'maestro', type: 'task-dispatched', payload: { floor: 'Uma', worker: 'Ária', branch: 'task/31-uma' } });
    store.appendEvent({ ...base, taskNumber: 31, agentRole: 'worker', agentName: 'Ária', type: 'task-status', payload: { state: 'review', text: 'Pronta', progress: null, maestri: 'posted' } });
    store.appendEvent({ ...base, taskNumber: 32, agentRole: 'worker', type: 'task-status', payload: { state: 'blocked', text: 'Parada', progress: null, maestri: 'failed' } });
    pendingId = store.appendEvent({ ...base, taskNumber: 31, agentRole: 'maestro', type: 'pending-decision-opened', payload: {
      kind: 'task_review', severity: 'normal', title: 'Revisar a 31', context: null, options: [], recommendation: null,
      maestri: { workspace: 'Contoso', terminal: 'Maestro 30' }, notification: 'failed',
    } });
    outsideId = store.appendEvent({ ...base, agentRole: 'maestro', type: 'pending-decision-opened', payload: {
      kind: 'decision', severity: 'low', title: 'Antes do #44', options: [], maestri: { workspace: null, terminal: null },
    } });
  } finally {
    store.close();
  }
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/30')).item;
    assert.deepStrictEqual(item.tasks.map((x) => [x.number, x.state, x.mode, x.status_host]), [
      [31, 'review', null, { kind: 'maestri', result: 'posted' }],
      [32, 'blocked', null, { kind: 'maestri', result: 'failed' }],
    ]);
    const byId = new Map((await pendingList(get)).map((p) => [p.id, p]));
    assert.deepStrictEqual([byId.get(pendingId).host, byId.get(pendingId).notification], [{ kind: 'maestri', workspace: 'Contoso', terminal: 'Maestro 30' }, 'failed']);
    assert.deepStrictEqual([byId.get(outsideId).host, byId.get(outsideId).notification], [{ kind: 'maestri', workspace: null, terminal: null }, null]);
  });
});

// ---------- flow task dispatch --mode ----------

suite.test('flow task dispatch records the mode: --mode wins; without it, the mode of flow host (none → subagents)', async () => {
  const r = buildRoot('mode');
  ok(flow(r, ['item', 'start', '40', '--title', 'Modos', '--stage', 'implementation']));
  ok(flow(r, ['task', 'graph', '40', '--task', '41|A', '--task', '42|B', '--task', '43|C', '--task', '44|D', '--task', '45|E']));
  const x = ok(flow(r, ['task', 'dispatch', '40', '41', '--mode', 'orca', '--worker', 'Ária']));
  assert.ok(/modo orca/.test(x.stdout), x.stdout);
  ok(flow(r, ['task', 'dispatch', '40', '42']));
  ok(flow(r, ['task', 'dispatch', '40', '43'], { extra: MAESTRI }));
  ok(flow(r, ['task', 'dispatch', '40', '44'], { extra: { ...ORCA, ...MAESTRI } }));
  ok(flow(r, ['task', 'dispatch', '--json', '-'], { extra: ORCA, input: JSON.stringify({ number: 40, task: 45, mode: 'subagents' }) }));
  for (const [args, message] of [
    [['task', 'dispatch', '40', '41', '--mode', 'floor'], /modo inválido: "floor" \(use subagents, maestri ou orca\)/],
  ]) {
    const bad = flow(r, args);
    assert.strictEqual(bad.status, 2, bad.stderr);
    assert.ok(message.test(bad.stderr), bad.stderr);
  }
  assert.deepStrictEqual([calls(r, 'orca'), calls(r, 'maestri')], [[], []], 'dispatching calls no host');
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/40')).item;
    assert.deepStrictEqual(item.tasks.map((t) => [t.number, t.mode]), [[41, 'orca'], [42, 'subagents'], [43, 'maestri'], [44, 'orca'], [45, 'subagents']]);
    assert.deepStrictEqual(item.timeline.filter((e) => e.type === 'task-dispatched').map((e) => e.payload.mode), ['orca', 'subagents', 'maestri', 'orca', 'subagents']);
  });
});

suite.test('help explains flow host, the Orca variables and --mode', () => {
  const r = buildRoot('help');
  const x = ok(flow(r, ['--help']));
  for (const s of ['flow.js host', 'ORCA_TERMINAL_HANDLE', 'ORCA_WORKTREE_ID', 'FLOW_ORCA_CLI', '--mode subagents|maestri|orca', 'orca worktree set']) {
    assert.ok(x.stdout.includes(s), `${s} in:\n${x.stdout}`);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
