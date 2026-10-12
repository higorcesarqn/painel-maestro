'use strict';
// Tests for bin/collect-usage.js with fake transcripts (fake root under tests/tmp/). The sessions are written the way
// they are in real use: the flow CLI registers the project (item 12, task 31 dispatched) and the hook runs as a process,
// fed by stdin, in a worktree on the branch of the link (the item's maestro, a task's worker or only the project, #13).
// The collector is called through collect(), the function the panel server runs.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assert, REPO, createSuite, tmpDir, remove, writeJson, writeJsonl, append, assistantLine, userLine,
} = require('./util');

const SCRIPT = path.join(REPO, 'bin', 'collect-usage.js');
const collector = require(SCRIPT);
const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const FLOW = path.join(REPO, 'bin', 'flow.js');

const NOW = new Date('2026-10-08T15:50:00-03:00');
const sp = (hhmm, day = '2026-10-08') => `${day}T${hhmm}:00-03:00`;

const suite = createSuite('usage collector (bin/collect-usage.js)');
// Agents of the fake root: the maestro of item 12, the worker of its task 31 and a session only in the project.
const C = 'widgets/12/maestro';
const T = 'widgets/12/task-31';
const D = 'widgets/-/other';
const roots = [];

function planStatus({ pct5 = 40, reset5 = '2026-10-08T20:50:00Z', pct7 = 20, reset7 = '2026-10-11T18:50:00Z', state = 'ready', error, at = '2026-10-08T18:45:00Z', noMeters = false } = {}) {
  const p = { enabled: true, id: 'claude', name: 'Claude Code', plan: 'max', state, lastSuccessAt: at, notes: [] };
  if (error) p.error = error;
  p.meters = noMeters ? [] : [{
    id: 'plan', label: 'Limites do plano',
    windows: [
      { id: 'five_hour', usedPercent: pct5, resetsAt: reset5, durationSeconds: 18000, ring: 'session' },
      { id: 'seven_day', usedPercent: pct7, resetsAt: reset7, durationSeconds: 604800, ring: 'weekly' },
    ],
  }, { id: 'Fable', label: 'Fable', windows: [{ id: 'limit', usedPercent: 3, resetsAt: reset7, durationSeconds: 604800 }] }];
  return { providers: [p, { id: 'codex', state: 'executableNotFound', meters: [] }], updatedAt: at };
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function env(b) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: b.m, MAESTRO_NOW: sp('15:00'), NODE_OPTIONS: '', MAESTRI_TERMINAL_ID: '', GIT_CEILING_DIRECTORIES: b.root,
  });
}

/** The project "widgets" (github.com/acme/widgets) with item 12 and its task 31 dispatched, registered by the flow CLI. */
function registerProject(b) {
  b.repo = path.join(b.root, 'repo');
  fs.mkdirSync(b.repo, { recursive: true });
  git(b.repo, 'init', '-q', '-b', 'main');
  git(b.repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(b.repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  for (const args of [['item', 'start', '12', '--title', 'Exportar'], ['task', 'graph', '12', '--task', '31|PDF'], ['task', 'dispatch', '12', '31', '--worker', 'Ária']]) {
    const x = spawnSync(process.execPath, [FLOW, ...args], { cwd: b.repo, env: env(b), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
  }
}

/** The folder of a link: a worktree on task/<task> (the worker), on feature/issue-<item> (the maestro), else the repository. */
function folderOf(b, { item = null, task = null }) {
  const branch = task !== null ? `task/${task}` : item !== null ? `feature/issue-${item}` : null;
  if (!branch) return b.repo;
  const wt = path.join(b.root, branch.replace(/\//g, '-'));
  if (!fs.existsSync(wt)) git(b.repo, 'worktree', 'add', '-q', '-b', branch, wt);
  return wt;
}

/** A Claude Code session in the folder of its link: the hook gets its SessionStart on stdin. Returns the folder. */
function session(b, id, link = {}, { transcript_path = null } = {}) {
  const cwd = folderOf(b, link);
  const input = { session_id: id, cwd, hook_event_name: 'SessionStart', source: 'startup' };
  if (transcript_path) input.transcript_path = transcript_path;
  const x = spawnSync(process.execPath, [HOOK], { cwd: b.root, input: JSON.stringify(input), env: env(b), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.strictEqual(x.status, 0, `hook exit ${x.status}`);
  return cwd;
}

/** Fake root with 4 linked sessions, transcripts (one of them without a session) and subagents. */
function buildBase(name) {
  const root = tmpDir(`collector-${name}`);
  roots.push(root);
  const m = path.join(root, 'maestro');
  const claude = path.join(root, 'claude');
  const maestri = path.join(root, 'maestri');
  const proj = (p) => path.join(claude, 'projects', p);
  writeJson(path.join(maestri, 'usage', 'providers', '.status.json'), planStatus());
  const b = { root, m };
  registerProject(b);
  const t1 = path.join(proj('proj-a'), 's1.jsonl');
  session(b, 's1', { item: 12 }, { transcript_path: t1 });
  session(b, 's2', { item: 12, task: 31 }, { transcript_path: path.join(proj('proj-b'), 's2.jsonl') });
  session(b, 's4', { item: 12 }, { transcript_path: path.join(proj('proj-a'), 's4.jsonl') }); // no file yet
  session(b, 's6', {}, { transcript_path: path.join(proj('proj-c'), 's6.jsonl') });
  // s3.jsonl has no session: the hook never linked it (outside a registered project), so it never counts.

  writeJsonl(t1, [
    userLine('hi, show the "usage" of the "assistant"'),
    assistantLine({ id: 'msg_A', ts: sp('15:00'), i: 10, o: 8, stop: null }),
    assistantLine({ id: 'msg_A', ts: '2026-10-08T15:00:01-03:00', i: 10, o: 100, cw: 1000, cr: 5000 }),
    assistantLine({ id: 'msg_B', ts: sp('09:50'), i: 20, o: 10 }),
    assistantLine({ id: 'msg_C', ts: sp('10:00', '2026-10-06'), i: 30, cr: 1000 }),
    assistantLine({ id: 'msg_D', ts: sp('10:00', '2026-09-29'), i: 999 }),
    '{"type":"assistant","message":{"usage": {"input_tokens": 5', // line broken in the middle
    JSON.stringify({ type: 'system', subtype: 'turn_duration', usage: 'x' }),
  ]);
  const sub = path.join(proj('proj-a'), 's1', 'subagents');
  writeJsonl(path.join(sub, 'agent-x1.jsonl'), [
    assistantLine({ id: 'msg_E', ts: sp('15:10'), o: 7, sub: true, stop: null }),
    assistantLine({ id: 'msg_E', ts: '2026-10-08T15:10:02-03:00', i: 5, o: 50, sub: true }),
  ]);
  writeJsonl(path.join(sub, 'workflows', 'wf_1', 'agent-y1.jsonl'), [assistantLine({ id: 'msg_F', ts: sp('15:20'), i: 1, o: 1, cw: 100, sub: true })]);
  writeJsonl(path.join(sub, 'workflows', 'wf_1', 'journal.jsonl'), [assistantLine({ id: 'msg_J1', ts: sp('15:20'), i: 100000 })]);
  writeJson(path.join(sub, 'workflows', 'wf_1', 'agent-y1.meta.json'), { agentType: 'x' });
  writeJsonl(path.join(proj('proj-b'), 's2.jsonl'), [assistantLine({ id: 'msg_G', ts: sp('14:00'), i: 100, o: 20, cr: 2000 })]);
  writeJsonl(path.join(proj('proj-a'), 's3.jsonl'), [assistantLine({ id: 'msg_H', ts: sp('15:00'), i: 500000 })]);
  writeJsonl(path.join(proj('proj-c'), 's6.jsonl'), [assistantLine({ id: 'msg_K', ts: sp('15:30'), i: 10, o: 2 })]);
  return { root, m, repo: b.repo, claude, maestri, t1, proj };
}

function options(b, extra = {}) {
  return Object.assign({ maestroDir: b.m, maestriDataDir: b.maestri, claudeDir: b.claude, env: {}, now: NOW }, extra);
}

function line(usage, period, agent) {
  return usage.by_agent[period].find((l) => l.key === agent);
}

suite.test('relative consumption formula and weights', () => {
  assert.deepStrictEqual(collector.WEIGHTS, { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 });
  assert.strictEqual(collector.relativeConsumption({ input: 16, output: 151, cache_write: 1100, cache_read: 5000 }), 2646);
});

suite.test('first collection: dedup by the last line, subagents, a transcript without session and periods; by item and by agent', async () => {
  const b = buildBase('base');
  const usage = await collector.collect(options(b));
  // Plan
  assert.strictEqual(usage.plan.available, true);
  assert.strictEqual(usage.plan.window_5h_pct, 40);
  assert.strictEqual(usage.plan.weekly_pct, 20);
  assert.strictEqual(usage.plan.reset_5h, '2026-10-08T17:50:00-03:00');
  assert.strictEqual(usage.plan.weekly_reset, '2026-10-11T15:50:00-03:00');
  assert.strictEqual(usage.plan.age_min, 5);
  assert.deepStrictEqual(usage.plan.source, { code: 'maestri_claude_provider' });
  assert.deepStrictEqual(usage.note, { code: 'usage_note' });
  assert.deepStrictEqual(usage.formula, { code: 'usage_formula' });
  assert.deepStrictEqual(usage.source, { code: 'usage_source' });
  assert.strictEqual(usage.collected_at, '2026-10-08T15:50:00-03:00');
  assert.strictEqual(usage.periods.window_5h.start, '2026-10-08T12:50:00-03:00');
  assert.deepStrictEqual(usage.periods.window_5h.basis, { code: 'since_5h_window_start' });
  assert.strictEqual(usage.periods.today.start, '2026-10-08T00:00:00-03:00');
  assert.deepStrictEqual(usage.periods.today.basis, { code: 'since_midnight' });
  assert.strictEqual(usage.periods['7d'].start, '2026-10-01T15:50:00-03:00');
  // 5 h window: A (last line) + E (last line) + F; B outside (09:50), journal ignored.
  const c5 = line(usage, 'window_5h', C);
  assert.deepStrictEqual([c5.input, c5.output, c5.cache_write, c5.cache_read, c5.messages], [16, 151, 1100, 5000, 3]);
  assert.strictEqual(c5.relative_consumption, 2646);
  assert.deepStrictEqual([c5.role, c5.project_id, c5.item_number, c5.task_number], ['maestro', 'widgets', 12, null]);
  const t5 = line(usage, 'window_5h', T);
  assert.strictEqual(t5.relative_consumption, 400);
  assert.deepStrictEqual([t5.role, t5.item_number, t5.task_number], ['worker', 12, 31]);
  const d5 = line(usage, 'window_5h', D);
  assert.strictEqual(d5.relative_consumption, 20);
  assert.deepStrictEqual([d5.role, d5.item_number, d5.task_number], ['other', null, null]);
  assert.strictEqual(c5.consumption_pct, 86.3);
  assert.strictEqual(t5.consumption_pct, 13);
  assert.strictEqual(d5.consumption_pct, 0.7);
  assert.strictEqual(c5.estimated_plan_pct, 34.5);
  assert.strictEqual(t5.estimated_plan_pct, 5.2);
  assert.strictEqual(usage.totals.window_5h.relative_consumption, 3066);
  // By item: the maestro and the worker of item 12 together; the session without item on its own line.
  assert.deepStrictEqual(usage.by_item.window_5h.map((l) => [l.key, l.project_id, l.item_number, l.relative_consumption, l.consumption_pct, l.estimated_plan_pct]),
    [['widgets/12', 'widgets', 12, 3046, 99.3, 39.7], ['widgets/-', 'widgets', null, 20, 0.7, 0.3]]);
  // A transcript without session (msg_H) is left out.
  assert.ok(!usage.by_agent.window_5h.some((l) => l.input >= 500000));
  // Today: + B. 7d: + C. D (9 days) is left out.
  assert.strictEqual(line(usage, 'today', C).relative_consumption, 2716);
  assert.strictEqual(line(usage, 'today', C).estimated_plan_pct, null);
  assert.strictEqual(line(usage, '7d', C).relative_consumption, 2846);
  assert.strictEqual(line(usage, '7d', C).estimated_plan_pct, 17.4);
  assert.strictEqual(usage.totals['7d'].relative_consumption, 3266);
  // Diagnostics
  assert.strictEqual(usage.collection.sessions, 4);
  assert.strictEqual(usage.collection.raw_log, 'found');
  assert.strictEqual(usage.collection.missing_transcripts, 1);
  assert.strictEqual(usage.collection.invalid_lines, 1);
  assert.strictEqual(usage.collection.cache, 'new');
  assert.deepStrictEqual(usage.warnings, [{ code: 'invalid_transcript_lines', count: 1 }]);
  // Wrote usage.json and the cache; msg_D was pruned from the cache.
  const written = JSON.parse(fs.readFileSync(path.join(b.m, 'state', 'usage.json'), 'utf8'));
  assert.strictEqual(written.by_agent.window_5h[0].key, C);
  const cache = fs.readFileSync(path.join(b.m, 'state', 'usage-cache.json'), 'utf8');
  assert.ok(cache.includes('msg_A') && !cache.includes('msg_D') && !cache.includes('msg_H') && !cache.includes('msg_J1'));
});

suite.test('7d: the estimated plan % uses the share in the plan week (weekly reset − 7 d)', async () => {
  const b = buildBase('plan-week');
  // The plan week starts on 10/07 09:00: msg_C (10/06) counts in the 7-day bars, but not in the plan %.
  writeJson(path.join(b.maestri, 'usage', 'providers', '.status.json'), planStatus({ reset7: '2026-10-14T12:00:00Z' }));
  const usage = await collector.collect(options(b, { write: false }));
  assert.deepStrictEqual(usage.periods['7d'].plan_basis, { start: '2026-10-07T09:00:00-03:00', end: '2026-10-08T15:50:00-03:00', basis: { code: 'plan_week' } });
  const c = line(usage, '7d', C);
  assert.strictEqual(c.relative_consumption, 2846);
  assert.strictEqual(c.consumption_pct, 87.1);
  assert.strictEqual(c.plan_week_consumption_pct, 86.6);
  assert.strictEqual(c.estimated_plan_pct, 17.3);
  // Without a valid weekly reset: plan_basis null and the plan % falls back to the 7-day share.
  writeJson(path.join(b.maestri, 'usage', 'providers', '.status.json'), planStatus({ reset7: null }));
  const without = await collector.collect(options(b, { write: false }));
  assert.strictEqual(without.periods['7d'].plan_basis, null);
});

suite.test('incremental cache: only new bytes, the same message replaced (not added)', async () => {
  const b = buildBase('incremental');
  await collector.collect(options(b));
  const again = await collector.collect(options(b));
  assert.strictEqual(again.collection.bytes_read, 0, 'a second round without changes must read nothing');
  assert.strictEqual(again.collection.cache, 'reused');
  const added = `${assistantLine({ id: 'msg_A', ts: '2026-10-08T15:00:02-03:00', i: 10, o: 120, cw: 1000, cr: 5000 })}\n${assistantLine({ id: 'msg_I', ts: sp('15:40'), i: 3, o: 3 })}\n`;
  append(b.t1, added);
  const usage = await collector.collect(options(b));
  assert.strictEqual(usage.collection.bytes_read, Buffer.byteLength(added));
  const c5 = line(usage, 'window_5h', C);
  assert.strictEqual(c5.relative_consumption, 2646 + 100 + 18);
  assert.strictEqual(c5.messages, 4);
  assert.strictEqual(c5.output, 151 + 20 + 3);
});

suite.test('growing file: an incomplete last line waits for the next round', async () => {
  const b = buildBase('growing');
  await collector.collect(options(b));
  const whole = assistantLine({ id: 'msg_J', ts: sp('15:45'), i: 7, o: 1 });
  const half = Math.floor(whole.length / 2);
  append(b.t1, whole.slice(0, half));
  const partial = await collector.collect(options(b));
  assert.strictEqual(line(partial, 'window_5h', C).messages, 3, 'an incomplete line cannot count');
  assert.strictEqual(partial.collection.invalid_lines, 0);
  append(b.t1, `${whole.slice(half)}\n`);
  const complete = await collector.collect(options(b));
  assert.strictEqual(line(complete, 'window_5h', C).messages, 4);
  assert.strictEqual(line(complete, 'window_5h', C).relative_consumption, 2646 + 12);
  const again = await collector.collect(options(b));
  assert.strictEqual(again.collection.bytes_read, 0);
  assert.strictEqual(line(again, 'window_5h', C).relative_consumption, 2646 + 12);
  // A complete last line still without \n also counts (only once).
  append(b.t1, assistantLine({ id: 'msg_N', ts: sp('15:46'), i: 1 }));
  const noNewline = await collector.collect(options(b));
  assert.strictEqual(line(noNewline, 'window_5h', C).messages, 5);
  append(b.t1, `\n${assistantLine({ id: 'msg_O', ts: sp('15:47'), i: 1 })}\n`);
  const after = await collector.collect(options(b));
  assert.strictEqual(line(after, 'window_5h', C).messages, 6);
});

suite.test('replaced or truncated file starts over; a transcript that appears later is counted', async () => {
  const b = buildBase('replaced');
  await collector.collect(options(b));
  const s2 = path.join(b.proj('proj-b'), 's2.jsonl');
  fs.unlinkSync(s2);
  writeJsonl(s2, [assistantLine({ id: 'msg_G2', ts: sp('15:45'), i: 1, o: 1 }), assistantLine({ id: 'msg_G3', ts: sp('15:46'), i: 1, o: 1 })]);
  let usage = await collector.collect(options(b));
  assert.strictEqual(line(usage, 'window_5h', T).relative_consumption, 12);
  fs.writeFileSync(s2, `${assistantLine({ id: 'msg_G4', ts: sp('15:47'), i: 2 })}\n`); // smaller than the offset
  usage = await collector.collect(options(b));
  assert.strictEqual(line(usage, 'window_5h', T).relative_consumption, 2);
  assert.ok(usage.collection.restarted_transcripts >= 1);
  writeJsonl(path.join(b.proj('proj-a'), 's4.jsonl'), [assistantLine({ id: 'msg_P', ts: sp('15:48'), i: 4 })]);
  usage = await collector.collect(options(b));
  assert.strictEqual(usage.collection.missing_transcripts, 0);
  assert.strictEqual(line(usage, 'window_5h', C).relative_consumption, 2646 + 4);
});

suite.test('the hook relinks a session: the attribution follows it without reading the transcript again', async () => {
  const b = buildBase('owner');
  await collector.collect(options(b));
  session(b, 's6', { item: 12, task: 31 }, { transcript_path: path.join(b.proj('proj-c'), 's6.jsonl') });
  const usage = await collector.collect(options(b));
  assert.strictEqual(usage.collection.bytes_read, 0);
  assert.strictEqual(line(usage, 'window_5h', T).relative_consumption, 420);
  assert.strictEqual(line(usage, 'window_5h', D), undefined);
  assert.deepStrictEqual(usage.by_item.window_5h.map((l) => l.key), ['widgets/12']);
});

suite.test('session without transcript_path: path derived from the cwd (CLAUDE_CONFIG_DIR/projects)', async () => {
  const b = buildBase('derived');
  const cwd = session(b, 's8', { item: 12, task: 31 });
  // Claude Code keeps a session's transcript in projects/<the cwd with every other character as "-">.
  writeJsonl(path.join(b.claude, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 's8.jsonl'), [assistantLine({ id: 'msg_L', ts: sp('15:30'), i: 1, o: 1 })]);
  const usage = await collector.collect(options(b));
  assert.strictEqual(line(usage, 'window_5h', T).relative_consumption, 406);
});

suite.test('a corrupt cache is recreated without changing the result', async () => {
  const b = buildBase('bad-cache');
  const before = await collector.collect(options(b));
  fs.writeFileSync(path.join(b.m, 'state', 'usage-cache.json'), '{junk');
  const after = await collector.collect(options(b));
  assert.strictEqual(after.collection.cache, 'recreated');
  assert.deepStrictEqual(after.by_agent, before.by_agent);
});

suite.test('plan unavailable: no .status.json, provider missing, off, no windows', async () => {
  const b = buildBase('no-plan');
  const file = path.join(b.maestri, 'usage', 'providers', '.status.json');
  fs.unlinkSync(file);
  let usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, false);
  assert.strictEqual(usage.plan.reason.code, 'plan_no_source');
  assert.ok(usage.plan.reason.file.endsWith('.status.json'), usage.plan.reason.file);
  assert.deepStrictEqual([usage.plan.window_5h_pct, usage.plan.weekly_pct, usage.plan.age_min, usage.plan.updated_at], [null, null, null, null]);
  assert.strictEqual(line(usage, 'window_5h', C).estimated_plan_pct, null);
  assert.strictEqual(line(usage, '7d', C).estimated_plan_pct, null);
  assert.ok(line(usage, 'window_5h', C).consumption_pct > 0, 'the share goes on without the plan');
  assert.strictEqual(usage.periods.window_5h.start, '2026-10-08T10:50:00-03:00', 'no reset: last 5 h');
  assert.deepStrictEqual(usage.periods.window_5h.basis, { code: 'last_5h_no_reset' });
  fs.writeFileSync(file, '{"providers": [');
  usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.reason.code, 'plan_file_unreadable');
  assert.strictEqual(usage.plan.reason.error.code, 'invalid_json');
  writeJson(file, { providers: [{ id: 'codex', state: 'ready', meters: [] }] });
  usage = await collector.collect(options(b));
  assert.deepStrictEqual(usage.plan.reason, { code: 'plan_provider_missing' });
  const off = planStatus();
  off.providers[0].enabled = false;
  writeJson(file, off);
  usage = await collector.collect(options(b));
  assert.deepStrictEqual(usage.plan.reason, { code: 'plan_provider_off' });
  writeJson(file, planStatus({ state: 'executableNotFound', error: 'The executable wasn\'t found', noMeters: true }));
  usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, false);
  assert.deepStrictEqual(usage.plan.reason, { code: 'plan_read_failed', state: 'executableNotFound', error: 'The executable wasn\'t found' });
});

suite.test('without the Maestri file (Orca, plain terminal) the plan has no source (#63): its own code, no number, and the summary does not send the owner to the Maestri settings', async () => {
  const b = buildBase('no-source');
  fs.rmSync(b.maestri, { recursive: true, force: true });
  const usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, false);
  assert.strictEqual(usage.plan.reason.code, 'plan_no_source');
  assert.ok(!['plan_file_unreadable', 'plan_provider_missing', 'plan_provider_off'].includes(usage.plan.reason.code));
  assert.deepStrictEqual([usage.plan.window_5h_pct, usage.plan.weekly_pct, usage.plan.age_min], [null, null, null]);
  assert.ok(line(usage, 'window_5h', C).consumption_pct > 0, 'the tokens per agent still come from the transcripts');
  const r = runCli(b, ['--no-write', '--now', '2026-10-08T15:50:00-03:00']);
  assert.strictEqual(r.status, 0, r.stderr);
  const planLine = r.stdout.split('\n').find((l) => l.startsWith('Plano:'));
  assert.ok(/sem fonte/i.test(planLine) && !/Configurações/.test(planLine), planLine);
});

suite.test('old Maestri data (the owner left Maestri days ago) still shows, with its age (#63)', async () => {
  const b = buildBase('stale');
  const file = path.join(b.maestri, 'usage', 'providers', '.status.json');
  writeJson(file, planStatus({ at: '2026-10-06T18:50:00Z', reset5: '2026-10-06T20:00:00Z' }));
  const usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, true);
  assert.strictEqual(usage.plan.weekly_pct, 20);
  assert.strictEqual(usage.plan.age_min, 2 * 24 * 60);
  assert.strictEqual(usage.plan.window_5h_reason.code, 'window_reset');
});

suite.test('5 h window that already reset: null % with a reason; a failed read becomes a warning', async () => {
  const b = buildBase('expired');
  const file = path.join(b.maestri, 'usage', 'providers', '.status.json');
  writeJson(file, planStatus({ reset5: '2026-10-08T18:00:00Z' })); // 15:00 in SP, before now
  let usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, true);
  assert.strictEqual(usage.plan.window_5h_pct, null);
  assert.deepStrictEqual(usage.plan.window_5h_reason, { code: 'window_reset', window: '5h', reset_at: '2026-10-08T15:00:00-03:00', read_at: '2026-10-08T15:45:00-03:00' });
  assert.strictEqual(usage.plan.weekly_pct, 20);
  assert.strictEqual(line(usage, 'window_5h', C).estimated_plan_pct, null);
  assert.strictEqual(typeof line(usage, '7d', C).estimated_plan_pct, 'number');
  assert.strictEqual(usage.periods.window_5h.start, '2026-10-08T10:50:00-03:00');
  writeJson(file, planStatus({ state: 'failed', error: 'timeout' }));
  usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, true);
  assert.deepStrictEqual(usage.plan.warnings, [{ code: 'plan_last_read_failed', state: 'failed', error: 'timeout', read_at: '2026-10-08T15:45:00-03:00' }]);
});

suite.test('big transcript: first read in blocks, second reads nothing again', async () => {
  const b = buildBase('big');
  const t7 = path.join(b.proj('proj-g'), 's7.jsonl');
  session(b, 's7', { item: 40 }, { transcript_path: t7 });
  const big = 'x'.repeat(2000);
  const parts = [];
  for (let i = 0; i < 6000; i++) {
    parts.push(userLine(big));
    parts.push(assistantLine({ id: `msg_big_${i}`, ts: sp('15:30'), i: 1, o: 1, stop: null }));
    parts.push(assistantLine({ id: `msg_big_${i}`, ts: sp('15:30'), i: 1, o: 2 }));
  }
  fs.mkdirSync(path.dirname(t7), { recursive: true });
  fs.writeFileSync(t7, `${parts.join('\n')}\n`);
  const size = fs.statSync(t7).size;
  const t0 = Date.now();
  let usage = await collector.collect(options(b));
  const first = Date.now() - t0;
  const f = line(usage, 'window_5h', 'widgets/40/maestro');
  assert.strictEqual(f.messages, 6000);
  assert.strictEqual(f.relative_consumption, 6000 * (1 + 10));
  assert.ok(usage.collection.bytes_read >= size);
  const t1 = Date.now();
  usage = await collector.collect(options(b));
  const second = Date.now() - t1;
  assert.strictEqual(usage.collection.bytes_read, 0);
  assert.ok(first < 15000, `slow first read: ${first} ms`);
  console.log(`        (${(size / 1048576).toFixed(1)} MB: first ${first} ms, second ${second} ms)`);
});

function runCli(b, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { MAESTRO_DIR: b.m, MAESTRI_DATA_DIR: b.maestri, CLAUDE_CONFIG_DIR: b.claude, MAESTRO_NOW: '' }),
  });
}

suite.test('CLI: --json --no-write writes nothing; readable summary; invalid option exits 2', () => {
  const b = buildBase('cli');
  const usageFile = path.join(b.m, 'state', 'usage.json');
  const r = runCli(b, ['--json', '--no-write', '--now', '2026-10-08T15:50:00-03:00']);
  assert.strictEqual(r.status, 0, r.stderr);
  const usage = JSON.parse(r.stdout);
  assert.strictEqual(line(usage, 'window_5h', C).relative_consumption, 2646);
  assert.ok(!fs.existsSync(usageFile) && !fs.existsSync(path.join(b.m, 'state', 'usage-cache.json')), '--no-write wrote something');
  const h = runCli(b, ['--now=2026-10-08T15:50:00-03:00']);
  assert.strictEqual(h.status, 0, h.stderr);
  assert.ok(h.stdout.includes('Plano: 5 h 40%') && h.stdout.includes('Gravado em state/usage.json'), h.stdout);
  assert.ok(fs.existsSync(usageFile));
  const bad = runCli(b, ['--option-that-does-not-exist']);
  assert.strictEqual(bad.status, 2);
  assert.strictEqual(bad.stdout, '');
  assert.ok(bad.stderr.includes('Opção desconhecida'));
  const badNow = runCli(b, ['--now', 'yesterday']);
  assert.strictEqual(badNow.status, 2);
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const r of roots) remove(r);
});
