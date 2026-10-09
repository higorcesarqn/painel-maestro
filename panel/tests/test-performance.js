'use strict';
// Server performance over the SQLite of the new model (#12, ADR 0003): maestro.db with 20 thousand events and
// bruto.db with a big raw log (400 thousand entries in 120 days, a third of them past the 90 days retention).
// The volume is generated with the stores' own write functions (the hook would take hours to write it); every
// check goes through the server API, plus one hook run over the big database.
// Checks times with slack (machine with antivirus). HEAVY_TEST=1 multiplies the raw log by 5.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, waitFor, kill } = require('./util');

const SERVER = path.join(REPO, 'panel', 'server.js');
const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const { openStore } = require(path.join(REPO, 'bin', 'flow-store.js'));
const { openRawStore } = require(path.join(REPO, 'bin', 'raw-store.js'));
// São Paulo has no daylight saving time: -03:00 all year (fast; Intl would take most of the generation).
const isoSP = (d) => `${new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 19)}-03:00`;
const suite = createSuite('server performance (SQLite: 20 thousand events, big raw log)');
const HEAVY = process.env.HEAVY_TEST === '1';
const N_EVENTS = 20000;
const N_RAW = HEAVY ? 2000000 : 400000;
const NOW = '2026-10-08T15:50:00-03:00';
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86400000;
const PROJECTS = ['widgets', 'gadgets', 'cidax-api'];
const ITEMS_PER_PROJECT = 150;
let root;
let S;
let hot; // the item whose maestro has thousands of commands in the last event's window

function build() {
  root = tmpDir('performance');
  const data = path.join(root, 'data');
  const store = openStore({ dir: data });
  const at0 = isoSP(new Date(NOW_MS - 120 * DAY_MS));
  store.transaction(() => {
    store.ensureCompany('contoso', 'Contoso', at0);
    PROJECTS.forEach((id, i) => store.addProject({
      id, name: id, companyId: i === 2 ? 'contoso' : 'contoso', tracker: i === 2 ? 'azure_devops' : 'github',
      remote: `github.com/acme/${id}`, at: at0,
    }));
    const stages = ['implementation', 'final_adjustment', 'pr_ready', 'merge'];
    const step = (60 * DAY_MS) / N_EVENTS;
    const started = new Set();
    for (let i = 0; i < N_EVENTS; i++) {
      const project = PROJECTS[i % PROJECTS.length];
      const number = 1 + (Math.floor(i / PROJECTS.length) % ITEMS_PER_PROJECT);
      const key = `${project}/${number}`;
      const at = isoSP(new Date(NOW_MS - 60 * DAY_MS + i * step));
      const base = { at, projectId: project, itemNumber: number, agentRole: 'maestro', agentName: null, source: 'cli' };
      if (!started.has(key)) {
        started.add(key);
        store.appendEvent({ ...base, type: 'item-started', payload: { title: `Item ${key} com acentuação`, stage: 'specification' } });
      } else {
        store.appendEvent({ ...base, type: 'stage-changed', payload: { stage: stages[i % stages.length] } });
      }
    }
  });
  const last = store.logEvents({}, { limit: 1 }).events[0];
  hot = { id: last.id, project: last.project_id, number: last.item_number, at: Date.parse(last.at) };
  store.close();

  const raw = openRawStore({ dir: data });
  const span = 120 * DAY_MS;
  const batch = [];
  const flush = () => { raw.recordMany(batch); batch.length = 0; };
  for (let i = 0; i < N_RAW; i++) {
    const t = NOW_MS - span + Math.floor((i * span) / N_RAW);
    const project = PROJECTS[i % PROJECTS.length];
    const task = i % 4 === 0 ? 1000 + (i % 300) : null;
    const item = task === null ? 1 + (i % ITEMS_PER_PROJECT) : null;
    batch.push({
      at: isoSP(new Date(t)), t, session_id: `s-${i % 500}`, project_id: project, item_number: item, task_number: task,
      branch: task === null ? `feature/issue-${item}` : `task/${task}`, hook_event: 'PostToolUse', tool: 'Bash',
      input: `comando ${i} ${'arg '.repeat(60)}`, ok: true, output_summary: 'x'.repeat(200), cwd: 'C:/x',
    });
    if (batch.length >= 20000) flush();
  }
  // The hot item's maestro: one command every 3 s in the 6 h before its last event.
  for (let t = hot.at - 6 * 3600000 + 3000; t <= hot.at; t += 3000) {
    batch.push({
      at: isoSP(new Date(t)), t, session_id: 's-hot', project_id: hot.project, item_number: hot.number, task_number: null,
      branch: `feature/issue-${hot.number}`, hook_event: 'PostToolUse', tool: 'Bash', input: `quente ${t}`, ok: true, cwd: 'C:/x',
    });
  }
  flush();
  raw.close();
  // A git repository of a registered project, for one hook run over the big database.
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'task/1042'], ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']]) {
    const x = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(x.status, 0, x.stderr);
  }
  return { data, repo };
}

async function time(fn) {
  const t0 = process.hrtime.bigint();
  const r = await fn();
  return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

function memoryMb(pid) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const m = /"([\d.,\s]+) K"/.exec(r.stdout || '');
  return m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : null;
}

let D;

suite.test(`generates ${N_EVENTS} events and ${N_RAW} raw entries and starts the server (the startup cleanup deletes the old third)`, async () => {
  const t0 = Date.now();
  D = build();
  console.log(`        generated in ${((Date.now() - t0) / 1000).toFixed(1)} s · bruto.db ${(fs.statSync(path.join(D.data, 'bruto.db')).size / 1048576).toFixed(0)} MB`);
  const port = await freePort();
  const env = Object.assign({}, process.env, { MAESTRO_DIR: D.data, PANEL_NOW: NOW, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(root, 'x.html'), MAESTRI_DATA_DIR: path.join(root, 'maestri') });
  const t1 = Date.now();
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env, windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const mm = await waitFor(() => /\(PID (\d+)\)/.exec(out), 60000);
  S = { port, pid: Number(mm[1]) };
  // The server answers while the cleanup runs in short rounds; it is up once the first cleanup ends.
  console.log(`        server up (startup cleanup included) in ${Date.now() - t1} ms`);
  const purged = /Log bruto: (\d+) registro/.exec(out);
  assert.ok(purged && Number(purged[1]) > N_RAW / 5, `the cleanup deleted the entries older than 90 days: ${out}`);
});

suite.test('/api/log: first page < 2 s, filters (item, type, period, company) < 1 s each', async () => {
  const cold = await time(() => request(S.port, '/api/log'));
  assert.strictEqual(cold.r.status, 200);
  assert.strictEqual(cold.r.json.total, N_EVENTS);
  assert.strictEqual(cold.r.json.events.length, 50);
  const warm = await time(() => request(S.port, '/api/log?page=200'));
  const queries = [
    `item=${hot.project}/${hot.number}`, 'type=item-started&project=gadgets', 'since=2026-09-20&until=2026-09-30&per_page=500', 'company=contoso&hours=48',
  ];
  const times = [];
  for (const q of queries) {
    const x = await time(() => request(S.port, `/api/log?${q}`));
    assert.strictEqual(x.r.status, 200, q);
    assert.ok(x.r.json.total > 0, q);
    times.push(x.ms);
  }
  console.log(`        /api/log: cold ${cold.ms.toFixed(0)} ms, page 200 ${warm.ms.toFixed(0)} ms, filters ${times.map((x) => x.toFixed(0)).join(' / ')} ms`);
  assert.ok(cold.ms < 2000, `slow first read: ${cold.ms} ms`);
  assert.ok(warm.ms < 1000 && times.every((x) => x < 1000), 'slow filters');
});

suite.test('/api/log/<id> with thousands of linked raw commands < 1.5 s, limited answer', async () => {
  const d = await time(() => request(S.port, `/api/log/${hot.id}`));
  assert.strictEqual(d.r.status, 200);
  assert.strictEqual(d.r.json.raw_commands.length, 1500);
  assert.strictEqual(d.r.json.raw_commands_truncated, true);
  assert.ok(d.r.json.raw_commands_total >= 7000, `${d.r.json.raw_commands_total}`);
  assert.ok(d.r.json.raw_commands.every((c) => c.item_number === hot.number && c.task_number === null));
  const t = await time(() => request(S.port, '/api/raw?project=widgets&task=1036&limit=1500'));
  assert.strictEqual(t.r.status, 200);
  assert.ok(t.r.json.total > 0);
  const mb = memoryMb(S.pid);
  console.log(`        /api/log/<id>: ${d.ms.toFixed(0)} ms (${(d.r.buf.length / 1024).toFixed(0)} KB) · /api/raw by task: ${t.ms.toFixed(0)} ms · server memory: ${mb} MB`);
  assert.ok(d.ms < 1500 && t.ms < 1500);
  if (mb !== null) assert.ok(mb < 400, `high memory: ${mb} MB`);
});

suite.test('the hook writes over the big bruto.db well within its 1.5 s', async () => {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: D.data, MAESTRO_NOW: NOW, NODE_OPTIONS: '', GIT_CEILING_DIRECTORIES: root });
  const payload = { session_id: 'sess-perf', cwd: D.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } };
  const t0 = Date.now();
  const x = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const ms = Date.now() - t0;
  assert.deepStrictEqual([x.status, x.stdout, x.stderr], [0, '', '']);
  const r = (await request(S.port, '/api/raw?session=sess-perf')).json;
  console.log(`        hook: ${ms} ms`);
  assert.deepStrictEqual(r.entries.map((e) => [e.input, e.task_number, e.branch]), [['npm test', 1042, 'task/1042']]);
  assert.ok(ms < 1400, `slow hook: ${ms} ms`);
});

suite.run().then(() => {
  if (S) kill(S.pid);
  if (!process.env.KEEP_TMP && root) remove(root);
});
