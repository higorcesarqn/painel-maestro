'use strict';
// Tests for GET /api/state without the hidden organizations (#52): kpis.pending_decisions (total, by_severity, open),
// read by the menu counter, the tab's title and favicon and the browser notification, and the health reasons that name
// an item (merge_check_failed) or a project of a hidden organization (projects_unassigned) leave them out; shown
// again, they are back on the next read. Through the agreed seam only: the bin/flow.js CLI runs as a process inside
// temporary git repositories → temporary maestro.db (MAESTRO_DIR) → the server as a separate process. Contoso stays
// visible, as the control, next to Fabrikam, hidden. gh is a fake script (PANEL_GH_CLI) that always fails. No test
// reads the database. Fake root under tests/tmp/, server on a port between 4790 and 4799 (PANEL_TEST_PORTS narrows it).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, waitFor, kill } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const SERVER = path.join(REPO, 'panel', 'server.js');
const suite = createSuite('/api/state without the hidden organizations: flow CLI → maestro.db → server process');
const roots = [];
const pids = [];

const PR = { widgets: 'https://github.com/contoso/widgets/pull/101', shop: 'https://github.com/fabrikam/shop/pull/201' };
// Fake gh: every PR read fails, as with an expired login.
const FAILING_GH = "'use strict';\nprocess.stderr.write('HTTP 401: Bad credentials');\nprocess.exitCode = 1;\n";

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder, the fake gh and three git repositories (widgets, shop, scratch) with fictitious origins. */
function buildRoot(name) {
  const root = tmpDir(`state-hidden-${name}`);
  roots.push(root);
  const repo = (folder, remote) => {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'feature/issue-12');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'inicio');
    return dir;
  };
  const gh = path.join(root, 'fakes', 'gh.js');
  fs.mkdirSync(path.dirname(gh), { recursive: true });
  fs.writeFileSync(gh, FAILING_GH);
  return {
    root, data: path.join(root, 'data'), gh,
    widgets: repo('widgets', 'https://github.com/contoso/widgets.git'), shop: repo('shop', 'https://github.com/fabrikam/shop.git'),
    scratch: repo('scratch', 'https://github.com/acme/scratch.git'),
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

/** Contoso (visible) with widgets/12 and Fabrikam with shop/48, each with a pending decision open. */
function twoOrganizations(r) {
  flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']);
  flow(r, ['org', 'add', 'fabrikam', '--name', 'Fabrikam']);
  flow(r, ['project', 'add', 'widgets', '--org', 'contoso'], r.widgets);
  flow(r, ['project', 'add', 'shop', '--name', 'Loja', '--org', 'fabrikam'], r.shop);
  flow(r, ['item', 'start', '12', '--title', 'Relatório', '--stage', 'implementation'], r.widgets);
  flow(r, ['item', 'start', '48', '--title', 'Carrinho', '--stage', 'implementation'], r.shop);
}

/** Starts the server as a separate process (env added to the default one) and returns get(path) → JSON (200 only). */
async function start(r, extra = {}) {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'),
    PANEL_INDEX: path.join(r.root, 'x.html'), PANEL_COLLECTOR: '0', PANEL_MERGE_CHECK: '0', PANEL_PORT: '', MAESTRO_NOW: '', PANEL_NOW: '', MAESTRI_TERMINAL_ID: '',
  }, extra);
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

const noSeverity = () => ({ critical: 0, high: 0, normal: 0, low: 0 });

suite.test('kpis.pending_decisions leaves out those of a hidden organization (a critical one too); shown again, they are back on the next read', async () => {
  const r = buildRoot('kpis');
  twoOrganizations(r);
  const visible = [
    open(r, 12, ['--kind', 'decision', '--severity', 'normal', '--title', 'Qual nome?'], r.widgets),
    open(r, 12, ['--kind', 'finding', '--severity', 'low', '--title', 'Um achado'], r.widgets),
  ];
  const hidden = [
    open(r, 48, ['--kind', 'decision', '--severity', 'critical', '--title', 'Qual frete?'], r.shop),
    open(r, 48, ['--kind', 'decision', '--severity', 'high', '--title', 'Qual prazo?'], r.shop),
  ];
  const get = await start(r);
  const kpi = async () => (await get('/api/state')).kpis.pending_decisions;
  const ids = (kp) => kp.open.map((p) => p.id).sort((a, b) => a - b);

  const all = await kpi();
  assert.deepStrictEqual(ids(all), [...visible, ...hidden].sort((a, b) => a - b), 'nothing hidden yet: every organization');
  assert.deepStrictEqual(all.by_severity, { critical: 1, high: 1, normal: 1, low: 1 });

  flow(r, ['org', 'hide', 'fabrikam']);
  const without = await kpi();
  assert.deepStrictEqual(ids(without), visible, 'only the visible organization\'s open ones');
  assert.deepStrictEqual(without.by_severity, { ...noSeverity(), normal: 1, low: 1 }, 'no critical: the page stays out of the strong tone');
  assert.strictEqual(without.total, 2);
  assert.ok(without.open.every((p) => p.item.project.organization.id === 'contoso'));
  // The same as the Pendências screen, which already leaves them out (#51).
  const screen = (await get('/api/pending-decisions?status=open')).pending_decisions.map((p) => p.id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids(without), screen);

  // Every open one of the visible organization closed: zero, with the hidden ones still open.
  for (const id of visible) flow(r, ['pending', 'cancel', String(id)]);
  assert.deepStrictEqual(await kpi(), { total: 0, by_severity: noSeverity(), open: [] });

  flow(r, ['org', 'unhide', 'fabrikam']);
  const back = await kpi();
  assert.deepStrictEqual(ids(back), hidden, 'shown again: its open ones are back');
  assert.deepStrictEqual(back.by_severity, { ...noSeverity(), critical: 1, high: 1 });
  assert.strictEqual(back.total, 2);
});

suite.test('a hidden "Sem organização" leaves its pending decisions out of the KPIs and its projects out of projects_unassigned', async () => {
  const r = buildRoot('unassigned');
  twoOrganizations(r);
  flow(r, ['item', 'start', '3', '--title', 'Rascunho', '--stage', 'implementation'], r.scratch);
  const visible = open(r, 12, ['--kind', 'decision', '--severity', 'normal', '--title', 'Qual nome?'], r.widgets);
  open(r, 3, ['--kind', 'decision', '--severity', 'critical', '--title', 'Sem dono'], r.scratch);
  const get = await start(r);
  const unassignedReasons = async () => (await get('/api/state')).health.reasons.filter((x) => x.code === 'projects_unassigned');

  assert.deepStrictEqual(await unassignedReasons(), [{ code: 'projects_unassigned', count: 1, projects: ['scratch'] }]);
  flow(r, ['org', 'hide', 'unassigned']);
  const state = await get('/api/state');
  assert.deepStrictEqual(state.kpis.pending_decisions.open.map((p) => p.id), [visible]);
  assert.deepStrictEqual(state.kpis.pending_decisions.by_severity, { ...noSeverity(), normal: 1 });
  assert.deepStrictEqual(await unassignedReasons(), [], 'the health popover does not name its projects');

  flow(r, ['org', 'unhide', 'unassigned']);
  assert.deepStrictEqual(await unassignedReasons(), [{ code: 'projects_unassigned', count: 1, projects: ['scratch'] }]);
  assert.strictEqual((await get('/api/state')).kpis.pending_decisions.by_severity.critical, 1);
});

suite.test('merge_check_failed does not name an item of a hidden organization; shown again, its reason is back', async () => {
  const r = buildRoot('merge');
  twoOrganizations(r);
  flow(r, ['pr', '12', 'ready', '--url', PR.widgets], r.widgets);
  flow(r, ['pr', '48', 'ready', '--url', PR.shop], r.shop);
  flow(r, ['org', 'hide', 'fabrikam']);
  const get = await start(r, { PANEL_MERGE_CHECK: '1', PANEL_MERGE_CHECK_SECONDS: '1', PANEL_GH_CLI: r.gh });
  const failed = async () => (await get('/api/state')).health.reasons.filter((x) => x.code === 'merge_check_failed').map((x) => x.item).sort();

  // The hidden item's PR is still checked (its work goes on): its failure shows on its page, by the key.
  await waitFor(async () => (await get('/api/items/shop/48')).item.merge_check.error, 10000, 50);
  await waitFor(async () => (await get('/api/items/widgets/12')).item.merge_check.error, 10000, 50);
  assert.deepStrictEqual(await failed(), ['widgets/12'], 'only the visible organization\'s item');

  flow(r, ['org', 'unhide', 'fabrikam']);
  assert.deepStrictEqual(await failed(), ['shop/48', 'widgets/12']);
});

suite.run().finally(() => {
  for (const pid of pids) kill(pid);
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
