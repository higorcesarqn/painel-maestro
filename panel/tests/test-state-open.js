'use strict';
// Tests for the open pending decisions of GET /api/state (#45): kpis.pending_decisions.open lists every open pending
// decision of every organization (no limit, unlike the Overview's 8), in the Overview's summary shape, for the page's
// browser notification. Through the agreed seam only: the bin/flow.js CLI runs as a process inside temporary git
// repositories → temporary maestro.db (MAESTRO_DIR) → the server as a separate process. No test reads the database.
// Fake root under tests/tmp/, server on a port between 4790 and 4799 (PANEL_TEST_PORTS narrows it).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, waitFor, kill } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const SERVER = path.join(REPO, 'panel', 'server.js');
const suite = createSuite('open pending decisions of /api/state: flow CLI → maestro.db → server process');
const roots = [];
const pids = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder and two git repositories with fictitious origins (widgets goes to Contoso). */
function buildRoot(name) {
  const root = tmpDir(`state-open-${name}`);
  roots.push(root);
  const repo = (folder, remote) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'feature/issue-12');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'inicio');
    return dir;
  };
  return {
    root, data: path.join(root, 'data'),
    widgets: repo('widgets', 'https://github.com/acme/widgets.git'), gadgets: repo('gadgets', 'https://github.com/acme/gadgets.git'),
  };
}

/** Runs the CLI outside of Maestri. */
function flow(r, args, cwd = r.widgets) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' });
  for (const k of ['MAESTRI_TERMINAL_ID', 'MAESTRI_TERMINAL_NAME', 'MAESTRI_WORKSPACE_ID', 'MAESTRI_WORKSPACE_NAME']) delete env[k];
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  return x.stdout;
}

/** Opens a pending decision and returns its id (from "Pendência P-7 aberta …"). */
function open(r, number, args, cwd) {
  const m = /\bP-(\d+)\b/.exec(flow(r, ['pending', 'open', String(number), ...args], cwd));
  assert.ok(m, 'the CLI prints the id');
  return Number(m[1]);
}

/** Starts the server as a separate process and returns get(path) → JSON (200 only). */
async function start(r) {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'),
    PANEL_INDEX: path.join(r.root, 'x.html'), PANEL_COLLECTOR: '0', PANEL_PORT: '', MAESTRO_NOW: '', PANEL_NOW: '', MAESTRI_TERMINAL_ID: '',
  });
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const line = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${err}`);
    return /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(out);
  }, 15000);
  pids.push(Number(line[2]));
  return async (p) => {
    const x = await request(Number(line[1]), p);
    assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
    return x.json;
  };
}

/** The Overview's summary of an open pending decision, from the whole one of /api/pending-decisions. */
const summary = (p) => ({ id: p.id, kind: p.kind, severity: p.severity, title: p.title, derived_from: p.derived_from, opened_at: p.opened_at, item: p.item, task: p.task });

suite.test('open lists every open pending decision of every organization, more than 8, in the Overview\'s shape and order; total and by_severity stay', async () => {
  const r = buildRoot('all');
  flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']);
  flow(r, ['project', 'add', 'widgets', '--org', 'contoso', '--repo', 'https://github.com/acme/widgets.git']);
  flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']);
  flow(r, ['task', 'graph', '12', '--task', '13|Gerar o PDF', '--task', '14|Enviar por e-mail|13']);
  flow(r, ['item', 'start', '7', '--title', 'Outro', '--stage', 'hml_validation'], r.gadgets);

  const severities = ['critical', 'high', 'normal', 'low', 'high', 'normal', 'normal', 'low', 'high'];
  const ids = severities.map((s, n) => open(r, 12, ['--kind', 'decision', '--severity', s, '--title', `Decisão ${n + 1}`]));
  const review = open(r, 12, ['--task', '13', '--kind', 'task_review', '--title', 'Revisar a task 13']);
  const toResolve = open(r, 12, ['--kind', 'decision', '--severity', 'high', '--title', 'Vai ser decidida']);
  const toCancel = open(r, 12, ['--kind', 'finding', '--severity', 'low', '--title', 'Vai ser cancelada']);
  const other = open(r, 7, ['--kind', 'decision', '--severity', 'critical', '--title', 'De gadgets'], r.gadgets);
  // The HML one derived from flow hml warns too (any severity, any kind).
  flow(r, ['hml', '7', '--passed', '7', '--failed', '1'], r.gadgets);

  const get = await start(r);
  const check = async (expected) => {
    const kp = (await get('/api/state')).kpis.pending_decisions;
    const whole = (await get('/api/pending-decisions?status=open')).pending_decisions;
    assert.deepStrictEqual(Object.keys(kp).sort(), ['by_severity', 'open', 'total']);
    assert.deepStrictEqual(kp.open, whole.map(summary), 'the open ones of /api/pending-decisions, the most urgent first, summarized');
    assert.deepStrictEqual(kp.open.map((p) => p.id).sort((a, b) => a - b), expected.slice().sort((a, b) => a - b));
    assert.strictEqual(kp.total, kp.open.length, 'total counts the listed ones');
    const bySeverity = { critical: 0, high: 0, normal: 0, low: 0 };
    for (const p of kp.open) bySeverity[p.severity]++;
    assert.deepStrictEqual(kp.by_severity, bySeverity);
    return kp;
  };

  const hmlId = (await get('/api/pending-decisions')).pending_decisions.find((p) => p.kind === 'hml').id;
  const before = await check([...ids, review, toResolve, toCancel, other, hmlId]);
  assert.ok(before.open.length > 8, 'no limit of 8');
  const organizations = new Set(before.open.map((p) => p.item.project.organization.id));
  assert.deepStrictEqual([...organizations].sort(), ['contoso', 'unassigned'], 'every organization');
  const hml = before.open.find((p) => p.kind === 'hml');
  assert.deepStrictEqual([hml.title, hml.derived_from.type, hml.item.key, hml.task], [null, 'hml-recorded', 'gadgets/7', null]);
  assert.deepStrictEqual(before.open.find((p) => p.id === review).task, { number: 13, title: 'Gerar o PDF', state: 'waiting' });
  assert.deepStrictEqual(Object.keys(before.open[0]), ['id', 'kind', 'severity', 'title', 'derived_from', 'opened_at', 'item', 'task']);

  // Resolved, canceled or closed by the integration: out of the list, on the next read of the same server.
  flow(r, ['pending', 'resolve', String(toResolve), '--decision', 'A']);
  flow(r, ['pending', 'cancel', String(toCancel)]);
  flow(r, ['task', 'integrate', '12', '13', '--sha', 'a1b2c3d4e5f6']);
  flow(r, ['hml', '7', '--passed', '8'], r.gadgets);
  await check([...ids, other]);
});

suite.test('without maestro.db, open is an empty list', async () => {
  const r = buildRoot('empty');
  const get = await start(r);
  assert.deepStrictEqual((await get('/api/state')).kpis.pending_decisions, { total: 0, by_severity: { critical: 0, high: 0, normal: 0, low: 0 }, open: [] });
});

suite.test('with an unreadable maestro.db, open is null (unknown), never an empty list the page would take for "all closed"', async () => {
  const r = buildRoot('unreadable');
  fs.mkdirSync(r.data, { recursive: true });
  fs.writeFileSync(path.join(r.data, 'maestro.db'), 'isto não é um banco SQLite '.repeat(100));
  const get = await start(r);
  const state = await get('/api/state');
  assert.deepStrictEqual(state.kpis.pending_decisions, { total: 0, by_severity: { critical: 0, high: 0, normal: 0, low: 0 }, open: null });
  assert.ok(state.health.reasons.some((x) => x.code === 'database_unreadable'), 'the health badge says why');
});

suite.run().finally(() => {
  for (const pid of pids) kill(pid);
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
