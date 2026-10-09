'use strict';
// Tests for bin/hook-log.js in the new model (#12, ADR 0003) through the agreed seam only: the flow CLI registers
// the project (git repository with a fictitious remote origin), the hook runs as a process fed by stdin with the
// JSON Claude Code sends → temporary bruto.db (MAESTRO_DIR) → the server's HTTP API. No test reads the database.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('raw log hook (bin/hook-log.js → bruto.db → API)');
const roots = [];
const sp = (hms, day = '2026-10-08') => `${day}T${hms}-03:00`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder (MAESTRO_DIR) and a git repository on branch "main" whose origin is a fictitious project. */
function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`hook-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  return { root, data, repo };
}

/** A floor's worktree on the given branch. */
function addWorktree(r, branch, name = 'floor-1') {
  const wt = path.join(r.root, name);
  git(r.repo, 'worktree', 'add', '-q', '-b', branch, wt);
  return wt;
}

function env(r, now, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: now || '', NODE_OPTIONS: '', MAESTRI_WORKSPACE_ID: '', MAESTRI_TERMINAL_ID: '',
    CLAUDE_PROJECT_DIR: '', API_KEY: '', GIT_CEILING_DIRECTORIES: r.root,
  }, extra);
}

/** Runs the flow CLI as the maestro would. */
function flow(r, args, { cwd = r.repo, now } = {}) {
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd, env: env(r, now), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
  return x;
}

/** Runs the hook as Claude Code does: the event JSON on stdin. */
function hook(r, payload, now, extra) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const x = spawnSync(process.execPath, [HOOK], { cwd: r.root, input, env: env(r, now, extra), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.strictEqual(x.status, 0, `hook exit ${x.status}`);
  assert.strictEqual(x.stdout, '', 'nothing on stdout');
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
  return x;
}

async function withServer(r, fn, { now, extra = {} } = {}) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: Object.assign({
      MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'),
      CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'), PANEL_NOW: now || '',
    }, extra),
  });
  try {
    await fn((p, o) => request(port, p, o));
  } finally {
    await s.stop();
  }
}

suite.test('a maestro session on the item branch is linked to the item: the event modal shows its commands, redacted and truncated', async () => {
  const r = buildRoot('item');
  git(r.repo, 'checkout', '-q', '-b', 'feature/issue-12');
  flow(r, ['item', 'start', '12', '--title', 'Exportar relatório'], { now: sp('09:00:00') });
  const s = { session_id: 'sess-maestro', cwd: r.repo, transcript_path: path.join(r.root, 't.jsonl') };
  hook(r, { ...s, hook_event_name: 'UserPromptSubmit', prompt: 'Implemente a issue #12' }, sp('09:50:00'));
  hook(r, { ...s, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abcDEF123456789xyz" https://x' }, tool_response: { stdout: 'feito', stderr: '' } }, sp('09:55:00'));
  hook(r, { ...s, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: `node ${'x'.repeat(2000)}` }, error: 'exit 1' }, sp('09:58:00'));
  flow(r, ['stage', '12', 'implementation'], { now: sp('10:00:00') });
  // The command that recorded the event itself lands a few seconds after it.
  hook(r, { ...s, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'node bin/flow.js stage 12 implementation' }, tool_response: { stdout: 'ok' } }, sp('10:00:05'));
  // After the next event's window: not part of it.
  hook(r, { ...s, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' }, tool_response: { file: { numLines: 3, totalLines: 3 } } }, sp('10:30:00'));
  await withServer(r, async (get) => {
    const log = (await get('/api/log')).json;
    assert.deepStrictEqual(log.events.map((e) => [e.type, e.item_key, e.tracker_ref]), [['stage-changed', 'widgets/12', '#12'], ['item-started', 'widgets/12', '#12']]);
    const ev = log.events[0];
    const d = await get(`/api/log/${ev.id}`);
    assert.strictEqual(d.status, 200, d.text);
    const cmds = d.json.raw_commands;
    assert.deepStrictEqual(cmds.map((c) => [c.at, c.hook_event, c.tool, c.session, c.item_number, c.task_number, c.branch]), [
      [sp('09:50:00'), 'UserPromptSubmit', null, 'sess-maestro', 12, null, 'feature/issue-12'],
      [sp('09:55:00'), 'PostToolUse', 'Bash', 'sess-maestro', 12, null, 'feature/issue-12'],
      [sp('09:58:00'), 'PostToolUseFailure', 'Bash', 'sess-maestro', 12, null, 'feature/issue-12'],
      [sp('10:00:05'), 'PostToolUse', 'Bash', 'sess-maestro', 12, null, 'feature/issue-12'],
    ]);
    assert.strictEqual(cmds[0].prompt, 'Implemente a issue #12');
    assert.ok(cmds[1].input.includes('«redigido»') && !cmds[1].input.includes('abcDEF123456789xyz'), cmds[1].input);
    assert.strictEqual(cmds[1].output_summary, 'feito');
    assert.deepStrictEqual([cmds[2].ok, cmds[2].error], [false, 'exit 1']);
    assert.ok(cmds[2].input.length <= 600 && /…\[\+\d+\]$/.test(cmds[2].input), 'input truncated');
    assert.deepStrictEqual(d.json.raw_link, { by: 'item', item_number: 12, task_number: null, start: sp('09:00:00'), end: sp('10:01:00') });
    assert.strictEqual(d.json.event.id, ev.id);
  });
});

suite.test('a worker session in a floor worktree is linked to the task by the branch; other branches only to the project', async () => {
  const r = buildRoot('task');
  flow(r, ['item', 'start', '7', '--title', 'Issue sem filhas'], { now: sp('08:00:00') });
  const floor = addWorktree(r, 'task/7-exportar-pdf');
  const floor2 = addWorktree(r, 'task/31', 'floor-2');
  const pbi = addWorktree(r, 'feature/pbi-3100', 'maestro');
  hook(r, { session_id: 'sess-w1', cwd: floor, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }, sp('09:00:00'));
  hook(r, { session_id: 'sess-w2', cwd: path.join(floor2, 'sub'), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_response: { stdout: 'ok' } }, sp('09:01:00'));
  hook(r, { session_id: 'sess-m', cwd: pbi, hook_event_name: 'SessionStart', source: 'startup' }, sp('09:02:00'));
  hook(r, { session_id: 'sess-x', cwd: r.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_response: { stdout: '' } }, sp('09:03:00'));
  await withServer(r, async (get) => {
    const all = (await get('/api/raw?project=widgets')).json;
    assert.deepStrictEqual(all.entries.map((e) => [e.session, e.branch, e.item_number, e.task_number]), [
      ['sess-w1', 'task/7-exportar-pdf', 7, 7], // the item that is its own only task
      ['sess-w2', 'task/31', null, 31], // the task's item is not known yet
      ['sess-m', 'feature/pbi-3100', 3100, null],
      ['sess-x', 'main', null, null],
    ]);
    assert.strictEqual(all.entries[2].detail, 'startup');
    assert.deepStrictEqual((await get('/api/raw?project=widgets&task=31')).json.entries.map((e) => e.input), ['npm run build']);
  });
});

suite.test('sessions outside a registered project write nothing; the hook always exits 0 in silence', async () => {
  const r = buildRoot('outside');
  flow(r, ['item', 'start', '1', '--title', 'Cadastra o projeto'], { now: sp('08:00:00') });
  const other = path.join(r.root, 'other');
  fs.mkdirSync(other);
  git(other, 'init', '-q');
  git(other, 'remote', 'add', 'origin', 'https://github.com/acme/unregistered.git');
  const noRepo = path.join(r.root, 'no-repo');
  fs.mkdirSync(noRepo);
  const base = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' } };
  hook(r, { ...base, session_id: 'sess-other', cwd: other }, sp('09:00:00'));
  hook(r, { ...base, session_id: 'sess-norepo', cwd: noRepo }, sp('09:00:00'));
  hook(r, { ...base, session_id: 'sess-gone', cwd: path.join(r.root, 'does-not-exist') }, sp('09:00:00'));
  // Garbage, an empty object, a list and nothing on stdin.
  for (const input of ['not json', '{}', '[1]', '']) hook(r, input, sp('09:00:00'));
  // A registered project but no maestro.db for another data folder: nothing either.
  hook(r, { ...base, session_id: 'sess-nodb', cwd: r.repo }, sp('09:00:00'), { MAESTRO_DIR: path.join(r.root, 'empty-data') });
  await withServer(r, async (get) => {
    assert.deepStrictEqual((await get('/api/raw')).json, { total: 0, entries: [] });
  });
  // stdin never closed: gives up by itself in about 1.5 s, with exit 0 and nothing written.
  const t0 = Date.now();
  const child = spawn(process.execPath, [HOOK], { cwd: r.root, env: env(r, sp('09:00:00')), windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.stdin.write('{"hook_event_name":"PostToolUse",');
  const code = await new Promise((resolve) => child.on('close', resolve));
  const ms = Date.now() - t0;
  assert.strictEqual(code, 0);
  assert.strictEqual(out, '');
  assert.ok(ms >= 1400 && ms < 4000, `gave up after ${ms} ms`);
});

suite.test('raw entries older than 90 days are deleted by the server cleanup', async () => {
  const r = buildRoot('retention');
  flow(r, ['item', 'start', '1', '--title', 'Retenção'], { now: sp('08:00:00', '2026-06-01') });
  const run = (id, day) => hook(r, { session_id: id, cwd: r.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: id }, tool_response: { stdout: '' } }, sp('12:00:00', day));
  run('cmd-100-days', '2026-06-30');
  run('cmd-91-days', '2026-07-09');
  run('cmd-89-days', '2026-07-11');
  run('cmd-yesterday', '2026-10-07');
  await withServer(r, async (get) => {
    assert.deepStrictEqual((await get('/api/raw')).json.entries.map((e) => e.input), ['cmd-89-days', 'cmd-yesterday']);
    assert.deepStrictEqual((await get('/api/raw?session=cmd-100-days')).json, { total: 0, entries: [] });
  }, { now: sp('12:00:00', '2026-10-08') });
});

suite.test('the usage collector counts only the sessions of registered projects, from bruto.db (no session files)', async () => {
  const r = buildRoot('usage');
  flow(r, ['item', 'start', '12', '--title', 'Uso'], { now: sp('08:00:00') });
  const outside = path.join(r.root, 'no-repo');
  fs.mkdirSync(outside);
  for (const [id, cwd] of [['sess-ours', r.repo], ['sess-outside', outside]]) {
    hook(r, { session_id: id, cwd, hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(r.root, `${id}.jsonl`) }, sp('09:00:00'));
    hook(r, { session_id: id, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'oi' }, sp('09:01:00'));
  }
  await withServer(r, async (get) => {
    const rc = (await get('/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1' } })).json;
    assert.strictEqual(rc.usage.collection.sessions, 1);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'state', 'sessions')), 'the old model\'s state/sessions files are gone');
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
