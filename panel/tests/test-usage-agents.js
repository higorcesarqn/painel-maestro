'use strict';
// Tests for usage and agents per item (#13) through the agreed seam only: the flow CLI records items and tasks (git
// repository with a fictitious remote origin), the hook runs as a process fed by stdin and links each Claude Code
// session to an item or a task in bruto.db, the usage collector runs as a process over the session transcripts →
// temporary databases and usage.json (MAESTRO_DIR) → the server's HTTP API. No test reads a database.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, writeJson, writeJsonl, assistantLine } = require('./util');

const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const FLOW = path.join(REPO, 'bin', 'flow.js');
const COLLECTOR = path.join(REPO, 'bin', 'collect-usage.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('usage and agents per item (flow + hook + collector → API)');
const roots = [];
const NOW = '2026-10-08T15:50:00-03:00';
const sp = (hms, day = '2026-10-08') => `${day}T${hms}-03:00`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Maestri's usage file: 5 h window at pct5 (resets at 18:00 in São Paulo) and the week at pct7. */
function planStatus(pct5 = 36, pct7 = 20) {
  return {
    providers: [{ id: 'claude', enabled: true, state: 'ready', plan: 'max', lastSuccessAt: '2026-10-08T18:47:00Z', meters: [{ id: 'plan', windows: [
      { id: 'five_hour', usedPercent: pct5, resetsAt: '2026-10-08T21:00:00Z', durationSeconds: 18000 },
      { id: 'seven_day', usedPercent: pct7, resetsAt: '2026-10-13T12:00:00Z', durationSeconds: 604800 },
    ] }] }],
    updatedAt: '2026-10-08T18:47:00Z',
  };
}

/** Temporary root: data folder (MAESTRO_DIR), Maestri and Claude folders, and a git repository on "main". */
function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`usage-agents-${name}`);
  roots.push(root);
  const r = { root, data: path.join(root, 'data'), maestri: path.join(root, 'maestri'), claude: path.join(root, 'claude'), repo: path.join(root, 'repo') };
  fs.mkdirSync(r.repo, { recursive: true });
  git(r.repo, 'init', '-q', '-b', 'main');
  git(r.repo, 'remote', 'add', 'origin', remote);
  git(r.repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  writeJson(path.join(r.maestri, 'usage', 'providers', '.status.json'), planStatus());
  return r;
}

/** A floor's (or the maestro's) worktree on the given branch. */
function addWorktree(r, branch, name) {
  const wt = path.join(r.root, name);
  git(r.repo, 'worktree', 'add', '-q', '-b', branch, wt);
  return wt;
}

function env(r, now, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: now || '', NODE_OPTIONS: '', MAESTRI_WORKSPACE_ID: '', MAESTRI_TERMINAL_ID: '',
    MAESTRI_DATA_DIR: r.maestri, CLAUDE_CONFIG_DIR: r.claude, CLAUDE_PROJECT_DIR: '', GIT_CEILING_DIRECTORIES: r.root,
  }, extra);
}

/** Runs the flow CLI as the maestro (or the worker) would. */
function flow(r, args, { cwd = r.repo, now = sp('09:00:00') } = {}) {
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd, env: env(r, now), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
  return x;
}

/** A Claude Code session in cwd: the hook gets its SessionStart (with the transcript path) on stdin. */
function session(r, id, cwd, now = sp('14:00:00')) {
  const transcript = path.join(r.claude, 'projects', 'p', `${id}.jsonl`);
  const x = spawnSync(process.execPath, [HOOK], {
    cwd: r.root, input: JSON.stringify({ session_id: id, cwd, transcript_path: transcript, hook_event_name: 'SessionStart', source: 'startup' }),
    env: env(r, now), encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.strictEqual(x.status, 0, `hook exit ${x.status}`);
  return transcript;
}

/** Runs the usage collector as the server (or a person) would. */
function collect(r, now = NOW) {
  const x = spawnSync(process.execPath, [COLLECTOR, '--now', now], { env: env(r, ''), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.strictEqual(x.status, 0, `collector: ${x.stderr}`);
  return x;
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: {
      MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: r.maestri,
      CLAUDE_CONFIG_DIR: r.claude, PANEL_NOW: NOW,
    },
  });
  try {
    await fn((p, o) => request(port, p, o));
  } finally {
    await s.stop();
  }
}

const pick = (line) => [line.key, line.relative_consumption, line.consumption_pct, line.estimated_plan_pct];

/** Item 12 with tasks 31 and 32; task 31 dispatched to Ária. Sessions of the maestro, of Ária, on "main" and outside. */
function itemWithSessions(r) {
  flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--agent', 'Bento'], { now: sp('09:00:00') });
  flow(r, ['task', 'graph', '12', '--task', '31|Gerar o PDF', '--task', '32|Botão de exportar|31', '--agent', 'Bento'], { now: sp('09:10:00') });
  flow(r, ['task', 'dispatch', '12', '31', '--floor', 'PDF', '--worker', 'Ária', '--branch', 'task/31-pdf', '--agent', 'Bento'], { now: sp('09:20:00') });
  const maestro = addWorktree(r, 'feature/issue-12', 'maestro');
  const floor = addWorktree(r, 'task/31-pdf', 'floor-1');
  const outside = path.join(r.root, 'outside');
  fs.mkdirSync(outside);
  const t = {
    maestro: session(r, 'sess-maestro', maestro),
    worker: session(r, 'sess-worker', floor),
    main: session(r, 'sess-main', r.repo),
    outside: session(r, 'sess-outside', outside),
  };
  writeJsonl(t.maestro, [assistantLine({ id: 'm1', ts: sp('15:00:00'), i: 100, o: 10 })]); // 150
  writeJsonl(t.worker, [assistantLine({ id: 'm2', ts: sp('15:10:00'), i: 50, o: 10 })]); // 100
  writeJsonl(t.main, [assistantLine({ id: 'm3', ts: sp('15:20:00'), i: 50 })]); // 50
  writeJsonl(t.outside, [assistantLine({ id: 'm4', ts: sp('15:30:00'), i: 9999 })]); // not ours: never counted
  return { maestro, floor, t };
}

suite.test('the collector splits the tokens by item and by agent (the item\'s maestro, the task\'s worker) from the sessions the hook linked', async () => {
  const r = buildRoot('split');
  itemWithSessions(r);
  collect(r);
  assert.ok(!fs.existsSync(path.join(r.data, 'state', 'sessions')), 'the hook writes no session files');
  await withServer(r, async (get) => {
    const res = await get('/api/usage');
    assert.strictEqual(res.status, 200, res.text);
    const u = res.json;
    assert.deepStrictEqual([u.plan.available, u.plan.window_5h_pct, u.plan.weekly_pct], [true, 36, 20]);
    assert.deepStrictEqual(u.by_item.window_5h.map(pick), [['widgets/12', 250, 83.3, 30], ['widgets/-', 50, 16.7, 6]]);
    const item = u.by_item.window_5h[0];
    assert.deepStrictEqual([item.item.number, item.item.tracker_ref, item.item.title, item.project.id, item.project.organization.id],
      [12, '#12', 'Exportar relatório', 'widgets', 'unassigned']);
    assert.strictEqual(u.by_item.window_5h[1].item, null, 'a session on "main" counts for the project, without an item');
    assert.deepStrictEqual(u.by_agent.window_5h.map(pick), [
      ['widgets/12/maestro', 150, 50, 18], ['widgets/12/task-31', 100, 33.3, 12], ['widgets/-/other', 50, 16.7, 6],
    ]);
    assert.deepStrictEqual(u.by_agent.window_5h.map((a) => [a.role, a.name, a.item && a.item.number, a.task && a.task.number, a.task && a.task.title]), [
      ['maestro', 'Bento', 12, null, null], ['worker', 'Ária', 12, 31, 'Gerar o PDF'], ['other', null, null, null, null],
    ]);
    assert.strictEqual(u.totals.window_5h.relative_consumption, 300, 'the session outside a registered project never counts');
    assert.deepStrictEqual(u.by_item['7d'].map(pick).map((x) => x.slice(0, 3)), [['widgets/12', 250, 83.3], ['widgets/-', 50, 16.7]]);
  });
});

/** A repository of a project registered in an organization with the flow CLI (flow org add / flow project add). */
function organizationRepo(r, { organization, organizationName, project, name, remote }) {
  const repo = path.join(r.root, project);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  flow(r, ['org', 'add', organization, '--name', organizationName], { cwd: repo, now: sp('08:00:00') });
  flow(r, ['project', 'add', project, '--name', name, '--org', organization], { cwd: repo, now: sp('08:00:00') });
  return repo;
}

suite.test('the final adjustment floor (task/<item>-ajuste-final) counts for the item\'s maestro, never as a task of the same number', async () => {
  const r = buildRoot('final-adjustment');
  itemWithSessions(r);
  const floor = addWorktree(r, 'task/12-ajuste-final', 'floor-ajuste');
  writeJsonl(session(r, 'sess-adjustment', floor), [assistantLine({ id: 'm6', ts: sp('15:15:00'), i: 50 })]); // 50
  collect(r);
  await withServer(r, async (get) => {
    const u = (await get('/api/usage')).json;
    assert.deepStrictEqual(u.by_agent.window_5h.map((a) => [a.key, a.relative_consumption]), [
      ['widgets/12/maestro', 200], ['widgets/12/task-31', 100], ['widgets/-/other', 50],
    ]);
    const raw = (await get('/api/raw?session=sess-adjustment')).json.entries;
    assert.deepStrictEqual(raw.map((e) => [e.branch, e.item_number, e.task_number]), [['task/12-ajuste-final', 12, null]]);
  });
});

suite.test('a worker session hooked before its task was in the graph counts for the item; organization and project filters choose the lines', async () => {
  const r = buildRoot('filters');
  itemWithSessions(r);
  const gadgets = organizationRepo(r, { organization: 'contoso', organizationName: 'Contoso', project: 'gadgets', name: 'Gadgets', remote: 'git@github.com:contoso/gadgets.git' });
  const floor = path.join(r.root, 'floor-77');
  git(gadgets, 'worktree', 'add', '-q', '-b', 'task/77-tela', floor);
  const early = session(r, 'sess-early', floor, sp('09:30:00')); // the task is not in maestro.db yet
  flow(r, ['item', 'start', '70', '--title', 'Tela de cadastro', '--agent', 'Dora'], { cwd: gadgets, now: sp('10:00:00') });
  flow(r, ['task', 'graph', '70', '--task', '77|Formulário'], { cwd: gadgets, now: sp('10:05:00') });
  flow(r, ['task', 'dispatch', '70', '77', '--worker', 'Caio', '--floor', 'Tela'], { cwd: gadgets, now: sp('10:10:00') });
  writeJsonl(early, [assistantLine({ id: 'm5', ts: sp('15:40:00'), i: 100 })]); // 100
  collect(r);
  await withServer(r, async (get) => {
    const contoso = (await get('/api/usage?organization=contoso')).json;
    assert.deepStrictEqual(contoso.by_item.window_5h.map(pick), [['gadgets/70', 100, 25, 9]], 'shares of the whole account (400)');
    assert.deepStrictEqual(contoso.by_agent.window_5h.map(pick), [['gadgets/70/task-77', 100, 25, 9]]);
    assert.deepStrictEqual([contoso.by_agent.window_5h[0].name, contoso.by_agent.window_5h[0].task.title, contoso.by_item.window_5h[0].project.organization],
      ['Caio', 'Formulário', { id: 'contoso', name: 'Contoso' }]);
    assert.strictEqual(contoso.totals.window_5h.relative_consumption, 400);
    const widgets = (await get('/api/usage?project=widgets')).json;
    assert.deepStrictEqual(widgets.by_item.window_5h.map((l) => l.key), ['widgets/12', 'widgets/-']);
    const both = (await get('/api/usage?organization=contoso,unassigned')).json;
    assert.strictEqual(both.by_agent.window_5h.length, 4);
    const bad = await get('/api/usage?organization=Contoso!');
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(bad.json.error, { code: 'invalid_param', param: 'organization', value: 'Contoso!', expected: 'id' });
  });
});

suite.test('the Agents are derived from the items: the maestro of each active item and the worker of each task in progress', async () => {
  const r = buildRoot('agents');
  // Item 41: its only task already integrated (no worker left); item 40: Done (no maestro left).
  flow(r, ['item', 'start', '41', '--title', 'Ajustar o cabeçalho', '--agent', 'Bento'], { now: sp('08:00:00') });
  flow(r, ['task', 'graph', '41', '--task', '42|Cabeçalho'], { now: sp('08:05:00') });
  flow(r, ['task', 'dispatch', '41', '42', '--worker', 'Zé'], { now: sp('08:10:00') });
  flow(r, ['task', 'integrate', '41', '42', '--sha', 'abc1234'], { now: sp('08:30:00') });
  flow(r, ['item', 'start', '40', '--title', 'Item antigo'], { now: sp('07:00:00') });
  flow(r, ['item', 'done', '40'], { now: sp('07:30:00') });
  const { floor } = itemWithSessions(r);
  flow(r, ['status', 'Gerando o PDF', '--state', 'working', '--progress', '1/3', '--item', '12', '--task', '31', '--agent', 'Ária'], { cwd: floor, now: sp('11:00:00') });
  collect(r);
  await withServer(r, async (get) => {
    const res = await get('/api/agents');
    assert.strictEqual(res.status, 200, res.text);
    const a = res.json;
    assert.deepStrictEqual(a.agents.map((x) => [x.key, x.role, x.name, x.item.key, x.item.title, x.task && x.task.number]), [
      ['widgets/12/maestro', 'maestro', 'Bento', 'widgets/12', 'Exportar relatório', null],
      ['widgets/12/task-31', 'worker', 'Ária', 'widgets/12', 'Exportar relatório', 31],
      ['widgets/41/maestro', 'maestro', 'Bento', 'widgets/41', 'Ajustar o cabeçalho', null],
    ]);
    assert.deepStrictEqual(a.counts, { maestro: 2, worker: 1 });
    const [maestro, worker, idle] = a.agents;
    assert.deepStrictEqual([maestro.active_tasks, maestro.last_event.type, maestro.last_event.at], [1, 'task-dispatched', sp('09:20:00')]);
    assert.deepStrictEqual([worker.task.title, worker.task.state, worker.task.floor, worker.task.status_text, worker.task.progress],
      ['Gerar o PDF', 'working', 'PDF', 'Gerando o PDF', { done: 1, total: 3 }]);
    assert.deepStrictEqual([worker.last_event.type, worker.last_event.at, worker.last_event.payload.text], ['task-status', sp('11:00:00'), 'Gerando o PDF']);
    assert.deepStrictEqual([maestro.last_activity_at, worker.last_activity_at, idle.last_activity_at], [sp('14:00:00'), sp('14:00:00'), null]);
    assert.deepStrictEqual([maestro.usage.window_5h.consumption_pct, worker.usage.window_5h.consumption_pct, worker.usage['7d'].estimated_plan_pct], [50, 33.3, 6.7]);
    assert.strictEqual(idle.usage, null, 'an agent without a session has no usage line');
    assert.strictEqual(maestro.project.organization.id, 'unassigned');
    assert.deepStrictEqual((await get('/api/agents?organization=contoso')).json, { agents: [], counts: { maestro: 0, worker: 0 } });
    assert.strictEqual((await get('/api/agents?project=widgets')).json.agents.length, 3);
  });
});

suite.test('an agent\'s last activity is the latest moment the hook saw its session, even when entries arrive out of order', async () => {
  const r = buildRoot('seen-order');
  flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--agent', 'Bento'], { now: sp('09:00:00') });
  const maestro = addWorktree(r, 'feature/issue-12', 'maestro');
  session(r, 'sess-maestro', maestro, sp('14:00:00'));
  session(r, 'sess-maestro', maestro, sp('13:00:00')); // an older entry written late (a slow hook, a clock behind)
  await withServer(r, async (get) => {
    const a = (await get('/api/agents')).json;
    assert.deepStrictEqual(a.agents.map((x) => [x.key, x.last_activity_at]), [['widgets/12/maestro', sp('14:00:00')]]);
  });
});

suite.test('without a collection the usage says so; without bruto.db the collector still writes the plan', async () => {
  const r = buildRoot('empty');
  await withServer(r, async (get) => {
    const u = (await get('/api/usage')).json;
    assert.deepStrictEqual([u.reason, u.by_item.window_5h, u.by_agent['7d']], [{ code: 'collector_not_run' }, [], []]);
  });
  collect(r);
  await withServer(r, async (get) => {
    const u = (await get('/api/usage')).json;
    assert.strictEqual(u.reason, null);
    assert.strictEqual(u.plan.window_5h_pct, 36);
    assert.deepStrictEqual(u.warnings, [{ code: 'raw_log_missing' }]);
    assert.deepStrictEqual([u.collection.sessions, u.by_item.today], [0, []]);
  });
});

suite.test('without the Maestri file the API says the plan has no source (#63), with no number; old Maestri data shows with its age', async () => {
  const r = buildRoot('no-source');
  itemWithSessions(r);
  fs.rmSync(r.maestri, { recursive: true, force: true });
  collect(r);
  await withServer(r, async (get) => {
    const u = (await get('/api/usage')).json;
    assert.deepStrictEqual([u.plan.available, u.plan.reason.code, u.plan.window_5h_pct, u.plan.weekly_pct, u.plan.age_min],
      [false, 'plan_no_source', null, null, null]);
    assert.ok(u.plan.reason.file.endsWith('usage/providers/.status.json'), u.plan.reason.file);
    assert.deepStrictEqual(u.by_item.window_5h.map(pick), [['widgets/12', 250, 83.3, null], ['widgets/-', 50, 16.7, null]],
      'the tokens per item still come from the transcripts, without a plan share');
    const k = (await get('/api/state')).json.kpis.usage;
    assert.deepStrictEqual([k.available, k.reason.code], [false, 'plan_no_source']);
  });
  // The owner left Maestri two days ago: its last file still shows, with the age (the week has not reset).
  writeJson(path.join(r.maestri, 'usage', 'providers', '.status.json'),
    Object.assign(planStatus(), { updatedAt: '2026-10-06T18:50:00Z' }, { providers: [Object.assign(planStatus().providers[0], { lastSuccessAt: '2026-10-06T18:50:00Z' })] }));
  collect(r);
  await withServer(r, async (get) => {
    const u = (await get('/api/usage')).json;
    assert.deepStrictEqual([u.plan.available, u.plan.weekly_pct, u.plan.age_min], [true, 20, 2 * 24 * 60]);
  });
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
