'use strict';
// A maestro.db written by a newer painel-maestro (#28): PRAGMA user_version above SCHEMA_VERSION. Both ways of opening
// it (the writer that migrates and the readOnly reader) refuse it with schema_too_new before writing anything; the CLI
// and the API translate it; the hook leaves a visible record for the health badge; the usage collector warns.
// Every database here is temporary (MAESTRO_DIR under tests/tmp/).
// Exception to the test rule (panel/README.md, Testes): it sets PRAGMA user_version and checks the file's bytes, journal
// mode and tables directly (the only way to prove the refusal wrote nothing), calls openStore() on both ways (the
// readOnly reader of the hook and the collector has no route) and the collector's collect(), as test-collector.js does.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const { openStore, loadSqlite, SCHEMA_VERSION, SchemaTooNew } = require(path.join(REPO, 'bin', 'flow-store.js'));
const { t } = require(path.join(REPO, 'bin', 'i18n'));
const collector = require(path.join(REPO, 'bin', 'collect-usage.js'));
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('maestro.db with a schema newer than the code (#28)');
const roots = [];
const sp = (hms) => `2026-10-08T${hms}-03:00`;
const NEWER = SCHEMA_VERSION + 1;
const REFUSAL = { code: 'schema_too_new', file: 'maestro.db', db_version: NEWER, code_version: SCHEMA_VERSION };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder (MAESTRO_DIR) and a git repository on feature/issue-12 whose origin is a fictitious project. */
function buildRoot(name) {
  const root = tmpDir(`schema-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  git(repo, 'checkout', '-q', '-b', 'feature/issue-12');
  return { root, data, repo, file: path.join(data, 'maestro.db') };
}

function env(r, now, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: now || '', NODE_OPTIONS: '', MAESTRI_WORKSPACE_ID: '', MAESTRI_TERMINAL_ID: '',
    CLAUDE_PROJECT_DIR: '', GIT_CEILING_DIRECTORIES: r.root,
  }, extra);
}

function flow(r, args, now) {
  return spawnSync(process.execPath, [FLOW, ...args], { cwd: r.repo, env: env(r, now), encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function hook(r, payload, now) {
  const x = spawnSync(process.execPath, [HOOK], { cwd: r.root, input: JSON.stringify(payload), env: env(r, now), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.strictEqual(x.status, 0, `hook exit ${x.status}`);
  assert.strictEqual(x.stdout + x.stderr, '', 'the hook prints nothing');
}

/** A registered project with item 12 (the writer at this code's version), its database then set to user_version. */
function registered(r, version = NEWER) {
  for (const args of [['org', 'add', 'acme', '--name', 'Acme'], ['project', 'add', 'widgets', '--org', 'acme'], ['item', 'start', '12', '--title', 'Exportar']]) {
    const x = flow(r, args, sp('09:00:00'));
    assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
  }
  setVersion(r, version);
}

/**
 * Sets user_version as a newer painel-maestro would: by default in rollback journal mode (a single file, so any write
 * shows up in its bytes) and, above this code's version, with a table this code does not know.
 */
function setVersion(r, version, journal = 'DELETE') {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(r.file);
  try {
    db.exec(`PRAGMA journal_mode = ${journal}`);
    if (version > SCHEMA_VERSION) db.exec('CREATE TABLE IF NOT EXISTS future_things (id INTEGER PRIMARY KEY)');
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

/** What must not change: the file's bytes, its schema version, tables and journal mode, and no journal beside it. */
function snapshot(r) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(r.file)).digest('hex');
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(r.file, { readOnly: true });
  try {
    return {
      hash,
      version: db.prepare('PRAGMA user_version').get().user_version,
      journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((x) => x.name),
      beside: fs.readdirSync(r.data).filter((n) => n.startsWith('maestro.db')).sort(),
    };
  } finally {
    db.close();
  }
}

async function withServer(r, fn, now) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: {
      MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'),
      CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'), PANEL_NOW: now || '',
    },
  });
  try {
    await fn((p, o) => request(port, p, o));
  } finally {
    await s.stop();
  }
}

const refusedWith = (e) => e instanceof SchemaTooNew && e.code === 'schema_too_new' && JSON.stringify(e.error) === JSON.stringify(REFUSAL);

suite.test('the writer and the readOnly reader refuse a newer schema with schema_too_new, and the database stays as it was', () => {
  const r = buildRoot('store');
  registered(r);
  const before = snapshot(r);
  assert.deepStrictEqual([before.version, before.journal, before.beside], [NEWER, 'delete', ['maestro.db']]);
  assert.ok(before.tables.includes('future_things') && before.tables.includes('events'), before.tables.join(', '));

  assert.throws(() => openStore({ dir: r.data }), refusedWith);
  assert.deepStrictEqual(snapshot(r), before, 'the writer neither switched to WAL nor migrated');
  assert.throws(() => openStore({ dir: r.data, create: false }), refusedWith);
  assert.throws(() => openStore({ dir: r.data, readOnly: true }), refusedWith);
  assert.throws(() => openStore({ dir: r.data, readOnly: true, busyTimeoutMs: 300 }), refusedWith);
  assert.deepStrictEqual(snapshot(r), before);

  // The same database at this code's version opens as before (no false refusal).
  setVersion(r, SCHEMA_VERSION);
  const store = openStore({ dir: r.data, readOnly: true });
  try {
    assert.strictEqual(store.project('widgets').id, 'widgets');
  } finally {
    store.close();
  }
});

suite.test('a database in WAL (as the writers leave it) is refused the same way, its main file untouched', () => {
  const r = buildRoot('wal');
  registered(r, SCHEMA_VERSION);
  setVersion(r, NEWER, 'WAL');
  const main = (x) => ({ hash: x.hash, version: x.version, journal: x.journal, tables: x.tables });
  const before = main(snapshot(r));
  assert.strictEqual(before.journal, 'wal');
  assert.throws(() => openStore({ dir: r.data }), refusedWith);
  assert.throws(() => openStore({ dir: r.data, readOnly: true, busyTimeoutMs: 300 }), refusedWith);
  const x = flow(r, ['stage', '12', 'implementation'], sp('10:00:00'));
  assert.strictEqual(x.status, 1, x.stderr);
  assert.deepStrictEqual(main(snapshot(r)), before);
});

suite.test('the flow CLI (item commands, status and flow-admin) exits 1 with the translated message and writes nothing', () => {
  const r = buildRoot('cli');
  registered(r);
  const before = snapshot(r);
  const message = `${t('errors.prefix', { message: t('errors.schemaTooNew', { ...REFUSAL, file: r.file.replace(/\\/g, '/') }) })}\n`;
  assert.ok(/versão mais nova do painel-maestro/.test(message) && /atualize o código/.test(message), message);
  for (const args of [['stage', '12', 'implementation'], ['status', 'Testando', '--item', '12', '--task', '12'], ['org', 'list'], ['project', 'list']]) {
    const x = flow(r, args, sp('10:00:00'));
    assert.deepStrictEqual([args.join(' '), x.status, x.stdout, x.stderr], [args.join(' '), 1, '', message]);
  }
  assert.deepStrictEqual(snapshot(r), before);
});

suite.test('the API answers 503 schema_too_new and the health badge says why (red)', async () => {
  const r = buildRoot('api');
  registered(r);
  const before = snapshot(r);
  await withServer(r, async (get) => {
    for (const p of ['/api/items', '/api/items/widgets/12', '/api/organizations', '/api/projects', '/api/pending-decisions', '/api/log', '/api/overview']) {
      const x = await get(p);
      assert.deepStrictEqual([p, x.status, x.json], [p, 503, { error: REFUSAL }]);
    }
    const post = await get('/api/organizations', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'nova', name: 'Nova' }) });
    assert.deepStrictEqual([post.status, post.json], [503, { error: REFUSAL }]);
    const answer = await get('/api/pending-decisions/P-1/answer', { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ option: 'A' }) });
    assert.deepStrictEqual([answer.status, answer.json], [503, { error: REFUSAL }]);
    const st = await get('/api/state');
    assert.strictEqual(st.status, 200, st.text);
    assert.strictEqual(st.json.health.level, 'red');
    assert.deepStrictEqual(st.json.health.reasons, [REFUSAL]);
  }, sp('10:00:00'));
  assert.deepStrictEqual(snapshot(r), before);
});

suite.test('the hook still exits 0 in silence, but leaves hook_failed on the health badge until it records again', async () => {
  const r = buildRoot('hook');
  registered(r, SCHEMA_VERSION);
  const s = { session_id: 'sess-1', cwd: r.repo, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } };
  hook(r, s, sp('09:10:00'));
  setVersion(r, NEWER);
  const before = snapshot(r);
  hook(r, s, sp('09:20:00'));
  assert.deepStrictEqual(snapshot(r), before);
  await withServer(r, async (get) => {
    const health = (await get('/api/state')).json.health;
    assert.deepStrictEqual(health.reasons, [REFUSAL, { code: 'hook_failed', at: sp('09:20:00'), error: REFUSAL }]);
    assert.strictEqual(health.last_raw_at, sp('09:10:00'));
  }, sp('09:30:00'));

  // Without maestro.db readable the server shows its own reason; once the code reads it again, the next entry clears the hook's.
  setVersion(r, SCHEMA_VERSION);
  await withServer(r, async (get) => {
    const health = (await get('/api/state')).json.health;
    assert.deepStrictEqual(health.reasons.map((x) => x.code), ['hook_failed']);
    assert.strictEqual(health.level, 'yellow');
  }, sp('09:30:00'));
  hook(r, s, sp('09:40:00'));
  await withServer(r, async (get) => {
    const health = (await get('/api/state')).json.health;
    assert.deepStrictEqual([health.level, health.reasons, health.last_raw_at], ['green', [], sp('09:40:00')]);
  }, sp('09:45:00'));
});

suite.test('the usage collector does not break on it: it collects what it can and warns with schema_too_new', async () => {
  const r = buildRoot('collector');
  registered(r, SCHEMA_VERSION);
  // A worker session on a task whose item is unknown: the collector asks maestro.db for it.
  git(r.repo, 'checkout', '-q', '-b', 'task/31-pdf');
  const claude = path.join(r.root, 'claude');
  const transcript = path.join(claude, 'projects', 'p', 'sess-w.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  hook(r, { session_id: 'sess-w', cwd: r.repo, transcript_path: transcript, hook_event_name: 'SessionStart', source: 'startup' }, sp('09:10:00'));
  setVersion(r, NEWER);
  const before = snapshot(r);
  const usage = await collector.collect({ maestroDir: r.data, maestriDataDir: path.join(r.root, 'maestri'), claudeDir: claude, env: {}, now: sp('10:00:00'), write: false });
  assert.strictEqual(usage.collection.sessions, 1);
  assert.deepStrictEqual(usage.warnings.filter((w) => w.code === 'schema_too_new'), [REFUSAL]);
  assert.deepStrictEqual(snapshot(r), before);
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const r of roots) remove(r);
});
