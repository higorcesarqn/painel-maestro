'use strict';
// Tests for bin/collect-usage.js with fake transcripts (fake root under tests/tmp/).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assert, REPO, createSuite, tmpDir, remove, writeJson, writeJsonl, append, assistantLine, userLine,
} = require('./util');

const SCRIPT = path.join(REPO, 'bin', 'collect-usage.js');
const collector = require(SCRIPT);

const NOW = new Date('2026-10-08T15:50:00-03:00');
const sp = (hhmm, day = '2026-10-08') => `${day}T${hhmm}:00-03:00`;

const suite = createSuite('usage collector (bin/collect-usage.js)');
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

/** Fake root with 6 sessions, transcripts and subagents. */
function buildBase(name) {
  const root = tmpDir(`collector-${name}`);
  roots.push(root);
  const m = path.join(root, 'maestro');
  const claude = path.join(root, 'claude');
  const maestri = path.join(root, 'maestri');
  const proj = (p) => path.join(claude, 'projects', p);
  // The agent registry is still the old model's file (removed in #18).
  writeJson(path.join(m, 'registro', 'agentes.json'), {
    workspace: { id: 'ws', nome: 'Exemplo', raiz: 'C:/teste' },
    padrao: { modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh' },
    agentes: [{ slug: 'cerebro', nome: 'Cérebro Principal' }, { slug: 'coordenador', nome: 'Coordenador' }, { slug: 'futuro', nome: 'Futuro' }],
  });
  writeJson(path.join(maestri, 'usage', 'providers', '.status.json'), planStatus());
  const session = (id, data) => writeJson(path.join(m, 'state', 'sessions', `${id}.json`), Object.assign({ session_id: id, terminal: 't', cwd: 'C:\\teste', started_at: sp('08:00'), seen_at: sp('15:00') }, data));
  const t1 = path.join(proj('proj-a'), 's1.jsonl');
  session('s1', { agent: 'cerebro', transcript_path: t1 });
  session('s2', { agent: 'coordenador', transcript_path: path.join(proj('proj-b'), 's2.jsonl') });
  session('s3', { agent: null, transcript_path: path.join(proj('proj-a'), 's3.jsonl') });
  session('s4', { agent: 'cerebro', transcript_path: path.join(proj('proj-a'), 's4.jsonl') }); // no file yet
  session('s6', { agent: 'desconhecido:abc12345', transcript_path: path.join(proj('proj-c'), 's6.jsonl') });
  fs.writeFileSync(path.join(m, 'state', 'sessions', 's5.json'), '{"session_id": "s5", "agent": ');
  fs.writeFileSync(path.join(m, 'state', 'sessions', 's9.json.tmp'), 'junk');

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
  return { root, m, claude, maestri, t1, proj };
}

function options(b, extra = {}) {
  return Object.assign({ maestroDir: b.m, maestriDataDir: b.maestri, claudeDir: b.claude, env: {}, now: NOW }, extra);
}

function line(usage, period, agent) {
  return usage.by_agent[period].find((l) => l.agent === agent);
}

suite.test('relative consumption formula and weights', () => {
  assert.deepStrictEqual(collector.WEIGHTS, { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 });
  assert.strictEqual(collector.relativeConsumption({ input: 16, output: 151, cache_write: 1100, cache_read: 5000 }), 2646);
});

suite.test('first collection: dedup by the last line, subagents, sessions without owner and periods', async () => {
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
  const c5 = line(usage, 'window_5h', 'cerebro');
  assert.deepStrictEqual([c5.input, c5.output, c5.cache_write, c5.cache_read, c5.messages], [16, 151, 1100, 5000, 3]);
  assert.strictEqual(c5.relative_consumption, 2646);
  const t5 = line(usage, 'window_5h', 'coordenador');
  assert.strictEqual(t5.relative_consumption, 400);
  const d5 = line(usage, 'window_5h', 'desconhecido:abc12345');
  assert.strictEqual(d5.relative_consumption, 20);
  assert.strictEqual(d5.registered, false);
  assert.strictEqual(c5.consumption_pct, 86.3);
  assert.strictEqual(t5.consumption_pct, 13);
  assert.strictEqual(d5.consumption_pct, 0.7);
  assert.strictEqual(c5.estimated_plan_pct, 34.5);
  assert.strictEqual(t5.estimated_plan_pct, 5.2);
  assert.strictEqual(usage.totals.window_5h.relative_consumption, 3066);
  // A registered agent without a session shows up zeroed; a session without owner (msg_H) is left out.
  const f5 = line(usage, 'window_5h', 'futuro');
  assert.deepStrictEqual([f5.relative_consumption, f5.consumption_pct, f5.messages], [0, 0, 0]);
  assert.ok(!usage.by_agent.window_5h.some((l) => l.input >= 500000));
  // Today: + B. 7d: + C. D (9 days) is left out.
  assert.strictEqual(line(usage, 'today', 'cerebro').relative_consumption, 2716);
  assert.strictEqual(line(usage, 'today', 'cerebro').estimated_plan_pct, null);
  assert.strictEqual(line(usage, '7d', 'cerebro').relative_consumption, 2846);
  assert.strictEqual(line(usage, '7d', 'cerebro').estimated_plan_pct, 17.4);
  assert.strictEqual(usage.totals['7d'].relative_consumption, 3266);
  // Diagnostics
  assert.strictEqual(usage.collection.sessions, 4);
  assert.strictEqual(usage.collection.sessions_without_owner, 1);
  assert.strictEqual(usage.collection.unreadable_sessions, 1);
  assert.strictEqual(usage.collection.missing_transcripts, 1);
  assert.strictEqual(usage.collection.invalid_lines, 1);
  assert.strictEqual(usage.collection.cache, 'new');
  assert.deepStrictEqual(usage.warnings, [{ code: 'sessions_without_agent', count: 1 }, { code: 'invalid_transcript_lines', count: 1 }]);
  // Wrote usage.json and the cache; msg_D was pruned from the cache.
  const written = JSON.parse(fs.readFileSync(path.join(b.m, 'state', 'usage.json'), 'utf8'));
  assert.strictEqual(written.by_agent.window_5h[0].agent, 'cerebro');
  const cache = fs.readFileSync(path.join(b.m, 'state', 'usage-cache.json'), 'utf8');
  assert.ok(cache.includes('msg_A') && !cache.includes('msg_D') && !cache.includes('msg_H') && !cache.includes('msg_J1'));
});

suite.test('7d: the estimated plan % uses the share in the plan week (weekly reset − 7 d)', async () => {
  const b = buildBase('plan-week');
  // The plan week starts on 10/07 09:00: msg_C (10/06) counts in the 7-day bars, but not in the plan %.
  writeJson(path.join(b.maestri, 'usage', 'providers', '.status.json'), planStatus({ reset7: '2026-10-14T12:00:00Z' }));
  const usage = await collector.collect(options(b, { write: false }));
  assert.deepStrictEqual(usage.periods['7d'].plan_basis, { start: '2026-10-07T09:00:00-03:00', end: '2026-10-08T15:50:00-03:00', basis: { code: 'plan_week' } });
  const c = line(usage, '7d', 'cerebro');
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
  const c5 = line(usage, 'window_5h', 'cerebro');
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
  assert.strictEqual(line(partial, 'window_5h', 'cerebro').messages, 3, 'an incomplete line cannot count');
  assert.strictEqual(partial.collection.invalid_lines, 0);
  append(b.t1, `${whole.slice(half)}\n`);
  const complete = await collector.collect(options(b));
  assert.strictEqual(line(complete, 'window_5h', 'cerebro').messages, 4);
  assert.strictEqual(line(complete, 'window_5h', 'cerebro').relative_consumption, 2646 + 12);
  const again = await collector.collect(options(b));
  assert.strictEqual(again.collection.bytes_read, 0);
  assert.strictEqual(line(again, 'window_5h', 'cerebro').relative_consumption, 2646 + 12);
  // A complete last line still without \n also counts (only once).
  append(b.t1, assistantLine({ id: 'msg_N', ts: sp('15:46'), i: 1 }));
  const noNewline = await collector.collect(options(b));
  assert.strictEqual(line(noNewline, 'window_5h', 'cerebro').messages, 5);
  append(b.t1, `\n${assistantLine({ id: 'msg_O', ts: sp('15:47'), i: 1 })}\n`);
  const after = await collector.collect(options(b));
  assert.strictEqual(line(after, 'window_5h', 'cerebro').messages, 6);
});

suite.test('replaced or truncated file starts over; a transcript that appears later is counted', async () => {
  const b = buildBase('replaced');
  await collector.collect(options(b));
  const s2 = path.join(b.proj('proj-b'), 's2.jsonl');
  fs.unlinkSync(s2);
  writeJsonl(s2, [assistantLine({ id: 'msg_G2', ts: sp('15:45'), i: 1, o: 1 }), assistantLine({ id: 'msg_G3', ts: sp('15:46'), i: 1, o: 1 })]);
  let usage = await collector.collect(options(b));
  assert.strictEqual(line(usage, 'window_5h', 'coordenador').relative_consumption, 12);
  fs.writeFileSync(s2, `${assistantLine({ id: 'msg_G4', ts: sp('15:47'), i: 2 })}\n`); // smaller than the offset
  usage = await collector.collect(options(b));
  assert.strictEqual(line(usage, 'window_5h', 'coordenador').relative_consumption, 2);
  assert.ok(usage.collection.restarted_transcripts >= 1);
  writeJsonl(path.join(b.proj('proj-a'), 's4.jsonl'), [assistantLine({ id: 'msg_P', ts: sp('15:48'), i: 4 })]);
  usage = await collector.collect(options(b));
  assert.strictEqual(usage.collection.missing_transcripts, 0);
  assert.strictEqual(line(usage, 'window_5h', 'cerebro').relative_consumption, 2646 + 4);
});

suite.test('session owner changes: attribution follows the session file; a deleted session leaves the cache', async () => {
  const b = buildBase('owner');
  await collector.collect(options(b));
  writeJson(path.join(b.m, 'state', 'sessions', 's6.json'), { session_id: 's6', agent: 'coordenador', transcript_path: path.join(b.proj('proj-c'), 's6.jsonl') });
  let usage = await collector.collect(options(b));
  assert.strictEqual(usage.collection.bytes_read, 0);
  assert.strictEqual(line(usage, 'window_5h', 'coordenador').relative_consumption, 420);
  assert.strictEqual(line(usage, 'window_5h', 'desconhecido:abc12345'), undefined);
  fs.unlinkSync(path.join(b.m, 'state', 'sessions', 's2.json'));
  usage = await collector.collect(options(b));
  assert.strictEqual(line(usage, 'window_5h', 'coordenador').relative_consumption, 20);
  assert.ok(!fs.readFileSync(path.join(b.m, 'state', 'usage-cache.json'), 'utf8').includes('msg_G'));
});

suite.test('session without transcript_path: path derived from the cwd (CLAUDE_CONFIG_DIR/projects)', async () => {
  const b = buildBase('derived');
  writeJson(path.join(b.m, 'state', 'sessions', 's8.json'), { session_id: 's8', agent: 'coordenador', cwd: 'C:\\proj\\x' });
  writeJsonl(path.join(b.claude, 'projects', 'C--proj-x', 's8.jsonl'), [assistantLine({ id: 'msg_L', ts: sp('15:30'), i: 1, o: 1 })]);
  const usage = await collector.collect(options(b));
  assert.strictEqual(line(usage, 'window_5h', 'coordenador').relative_consumption, 406);
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
  assert.strictEqual(usage.plan.reason.code, 'plan_file_missing');
  assert.ok(usage.plan.reason.file.endsWith('.status.json'), usage.plan.reason.file);
  assert.strictEqual(usage.plan.window_5h_pct, null);
  assert.strictEqual(line(usage, 'window_5h', 'cerebro').estimated_plan_pct, null);
  assert.strictEqual(line(usage, '7d', 'cerebro').estimated_plan_pct, null);
  assert.ok(line(usage, 'window_5h', 'cerebro').consumption_pct > 0, 'the share goes on without the plan');
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

suite.test('5 h window that already reset: null % with a reason; a failed read becomes a warning', async () => {
  const b = buildBase('expired');
  const file = path.join(b.maestri, 'usage', 'providers', '.status.json');
  writeJson(file, planStatus({ reset5: '2026-10-08T18:00:00Z' })); // 15:00 in SP, before now
  let usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, true);
  assert.strictEqual(usage.plan.window_5h_pct, null);
  assert.deepStrictEqual(usage.plan.window_5h_reason, { code: 'window_reset', window: '5h', reset_at: '2026-10-08T15:00:00-03:00', read_at: '2026-10-08T15:45:00-03:00' });
  assert.strictEqual(usage.plan.weekly_pct, 20);
  assert.strictEqual(line(usage, 'window_5h', 'cerebro').estimated_plan_pct, null);
  assert.strictEqual(typeof line(usage, '7d', 'cerebro').estimated_plan_pct, 'number');
  assert.strictEqual(usage.periods.window_5h.start, '2026-10-08T10:50:00-03:00');
  writeJson(file, planStatus({ state: 'failed', error: 'timeout' }));
  usage = await collector.collect(options(b));
  assert.strictEqual(usage.plan.available, true);
  assert.deepStrictEqual(usage.plan.warnings, [{ code: 'plan_last_read_failed', state: 'failed', error: 'timeout', read_at: '2026-10-08T15:45:00-03:00' }]);
});

suite.test('big transcript: first read in blocks, second reads nothing again', async () => {
  const b = buildBase('big');
  const t7 = path.join(b.proj('proj-g'), 's7.jsonl');
  writeJson(path.join(b.m, 'state', 'sessions', 's7.json'), { session_id: 's7', agent: 'futuro', transcript_path: t7 });
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
  const f = line(usage, 'window_5h', 'futuro');
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
  assert.strictEqual(line(usage, 'window_5h', 'cerebro').relative_consumption, 2646);
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
