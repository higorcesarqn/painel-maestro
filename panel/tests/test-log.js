'use strict';
// Tests for the Log of the new model (#12) through the agreed seam only: the flow CLI writes events in temporary
// git repositories (fictitious remotes) → temporary maestro.db (MAESTRO_DIR) → GET /api/log and /api/log/<id>.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('new model Log: flow CLI → maestro.db → /api/log');
const roots = [];
const sp = (hms, day = '2026-10-08') => `${day}T${hms}-03:00`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function buildRoot(name) {
  const root = tmpDir(`log-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = (dir, remote) => {
    const p = path.join(root, dir);
    fs.mkdirSync(p, { recursive: true });
    git(p, 'init', '-q');
    git(p, 'remote', 'add', 'origin', remote);
    return p;
  };
  return { root, data, widgets: repo('widgets', 'https://github.com/acme/widgets.git'), cidax: repo('cidax', 'https://dev.azure.com/contoso/CIDAX/_git/cidax-api') };
}

function flow(r, cwd, now, ...args) {
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd, env: Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: now, NODE_OPTIONS: '' }), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), PANEL_NOW: sp('12:00:00') },
  });
  try {
    await fn((p) => request(port, p));
  } finally {
    await s.stop();
  }
}

suite.test('lists the events newest first, with project, organization and item, and filters by organization, project, item, type and period', async () => {
  const r = buildRoot('filters');
  flow(r, r.widgets, sp('09:00:00', '2026-10-06'), 'item', 'start', '12', '--title', 'Exportar PDF');
  flow(r, r.widgets, sp('10:00:00', '2026-10-07'), 'stage', '12', 'implementation');
  flow(r, r.cidax, sp('11:00:00', '2026-10-07'), 'item', 'start', '3100', '--title', 'Conciliação', '--agent', 'Ária');
  flow(r, r.widgets, sp('08:00:00'), 'item', 'start', '13', '--title', 'Outro item');
  flow(r, r.widgets, sp('11:30:00'), 'stage', '12', 'pr_ready', '--role', 'worker');
  await withServer(r, async (get) => {
    const all = (await get('/api/log')).json;
    assert.strictEqual(all.total, 5);
    assert.deepStrictEqual(all.events.map((e) => [e.at, e.type, e.item_key, e.tracker_ref]), [
      [sp('11:30:00'), 'stage-changed', 'widgets/12', '#12'],
      [sp('08:00:00'), 'item-started', 'widgets/13', '#13'],
      [sp('11:00:00', '2026-10-07'), 'item-started', 'cidax-api/3100', 'PBI 3100'],
      [sp('10:00:00', '2026-10-07'), 'stage-changed', 'widgets/12', '#12'],
      [sp('09:00:00', '2026-10-06'), 'item-started', 'widgets/12', '#12'],
    ]);
    const pbi = all.events[2];
    assert.deepStrictEqual(pbi.project, { id: 'cidax-api', name: 'cidax-api', tracker: 'azure_devops', organization: { id: 'unassigned', name: 'Sem organização' } });
    assert.deepStrictEqual([pbi.item_title, pbi.agent, pbi.payload.title], ['Conciliação', { role: 'maestro', name: 'Ária' }, 'Conciliação']);
    assert.deepStrictEqual(all.counts, { organization: { unassigned: 5 }, project: { widgets: 4, 'cidax-api': 1 }, type: { 'item-started': 3, 'stage-changed': 2 } });

    const keys = async (q) => (await get(`/api/log?${q}`)).json.events.map((e) => `${e.item_key}:${e.type}`);
    assert.deepStrictEqual(await keys('project=cidax-api'), ['cidax-api/3100:item-started']);
    assert.deepStrictEqual(await keys('item=widgets/12&type=stage-changed'), ['widgets/12:stage-changed', 'widgets/12:stage-changed']);
    assert.deepStrictEqual(await keys('since=2026-10-07&until=2026-10-07'), ['cidax-api/3100:item-started', 'widgets/12:stage-changed']);
    assert.deepStrictEqual(await keys('hours=4'), ['widgets/12:stage-changed', 'widgets/13:item-started']);
    assert.deepStrictEqual(await keys('organization=unassigned&project=widgets,cidax-api&type=item-started&per_page=2&page=2'), ['widgets/12:item-started']);
    const none = (await get('/api/log?organization=contoso')).json;
    assert.deepStrictEqual([none.total, none.events, none.counts.organization], [0, [], { unassigned: 5 }], 'each facet ignores its own filter');
  });
});

suite.test('codes for invalid parameters and missing events; no database yet gives an empty log', async () => {
  const r = buildRoot('codes');
  await withServer(r, async (get) => {
    const empty = (await get('/api/log')).json;
    assert.deepStrictEqual([empty.total, empty.events, empty.raw_last_at], [0, [], null]);
    assert.strictEqual((await get('/api/log/1')).status, 404);
  });
  flow(r, r.widgets, sp('09:00:00'), 'item', 'start', '1', '--title', 'x');
  await withServer(r, async (get) => {
    for (const [q, param] of [['since=2026-02-31', 'since'], ['item=widgets', 'item'], ['page=0', 'page'], ['project=Widgets!', 'project']]) {
      const x = await get(`/api/log?${q}`);
      assert.deepStrictEqual([x.status, x.json.error.code, x.json.error.param], [400, 'invalid_param', param], q);
    }
    const missing = await get('/api/log/99');
    assert.deepStrictEqual([missing.status, missing.json.error], [404, { code: 'event_not_found', id: 99 }]);
    for (const p of ['/api/log/abc', '/api/log/0', '/api/log/1/x']) assert.strictEqual((await get(p)).status, 404, p);
    const one = (await get('/api/log/1')).json;
    assert.deepStrictEqual([one.event.type, one.item.title, one.raw_commands, one.raw_link.by], ['item-started', 'x', [], 'item']);
  });
});

/** Runs the hook as Claude Code does (the event JSON on stdin), without leaving the temporary root. */
function hook(r, payload, now) {
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: now, NODE_OPTIONS: '', MAESTRI_WORKSPACE_ID: '', MAESTRI_TERMINAL_ID: '', CLAUDE_PROJECT_DIR: '', GIT_CEILING_DIRECTORIES: r.root,
  });
  const x = spawnSync(process.execPath, [HOOK], { cwd: r.root, input: JSON.stringify(payload), env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.deepStrictEqual([x.status, x.stdout, x.stderr], [0, '', ''], 'the hook exits 0 in silence');
}

suite.test('end to end: a task event (flow task dispatch on a task/<id>-… branch) opens with the raw commands of that task', async () => {
  const r = buildRoot('task');
  git(r.widgets, 'checkout', '-q', '-b', 'feature/issue-12');
  git(r.widgets, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  const floor = path.join(r.root, 'floor-13');
  git(r.widgets, 'worktree', 'add', '-q', '-b', 'task/13-gerar-pdf', floor);
  flow(r, r.widgets, sp('09:00:00'), 'item', 'start', '12', '--title', 'Exportar PDF');
  flow(r, r.widgets, sp('09:05:00'), 'task', 'graph', '12', '--task', '13|Gerar o PDF', '--task', '14|Enviar por e-mail|13');
  const worker = { session_id: 'sess-worker-13', cwd: floor, transcript_path: path.join(r.root, 'w.jsonl') };
  const maestro = { session_id: 'sess-maestro', cwd: r.widgets, transcript_path: path.join(r.root, 'm.jsonl') };
  hook(r, { ...worker, hook_event_name: 'UserPromptSubmit', prompt: 'Implemente a task 13' }, sp('09:08:00'));
  hook(r, { ...maestro, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git log --oneline' }, tool_response: { stdout: 'ok' } }, sp('09:09:00'));
  hook(r, { ...worker, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }, sp('09:09:30'));
  flow(r, floor, sp('09:10:00'), 'task', 'dispatch', '12', '13', '--floor', 'Floor 13', '--worker', 'Bento', '--branch', 'task/13-gerar-pdf');
  hook(r, { ...worker, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m pdf' }, tool_response: { stdout: 'ok' } }, sp('09:10:40'));
  // After the event's window (one minute after it): not part of it.
  hook(r, { ...worker, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: { stdout: 'ok' } }, sp('09:15:00'));
  await withServer(r, async (get) => {
    const log = (await get('/api/log?type=task-dispatched')).json;
    assert.deepStrictEqual(log.events.map((e) => [e.type, e.item_key, e.task_number]), [['task-dispatched', 'widgets/12', 13]]);
    const d = await get(`/api/log/${log.events[0].id}`);
    assert.strictEqual(d.status, 200, d.text);
    assert.deepStrictEqual(d.json.raw_commands.map((c) => [c.at, c.session, c.task_number, c.branch, c.input || c.prompt]), [
      [sp('09:08:00'), 'sess-worker-13', 13, 'task/13-gerar-pdf', 'Implemente a task 13'],
      [sp('09:09:30'), 'sess-worker-13', 13, 'task/13-gerar-pdf', 'npm test'],
      [sp('09:10:40'), 'sess-worker-13', 13, 'task/13-gerar-pdf', 'git commit -m pdf'],
    ]);
    assert.deepStrictEqual([d.json.raw_link.by, d.json.raw_link.item_number, d.json.raw_link.task_number, d.json.raw_link.end], ['task', 12, 13, sp('09:11:00')]);
    assert.deepStrictEqual([d.json.item.key, d.json.item.title], ['widgets/12', 'Exportar PDF']);
  });
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
