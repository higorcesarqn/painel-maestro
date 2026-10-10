'use strict';
// Tests for the health badge's server_outdated reason (#38) through the agreed seams only: the server runs as a process
// with PANEL_REPO_DIR on a temporary git repository and is read through GET /api/state. The repository's history is
// changed with git between reads. The reason comes when a commit after the startup touches what the server runs (bin/,
// the top-level .js files of panel/, package.json), and goes away on a restart on the new HEAD.
// Fake roots under tests/tmp/ (the folder without git under the system's temp), servers on a port between 4790 and 4799.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, waitFor, kill } = require('./util');

const suite = createSuite('server_outdated (the code the server runs changed in git)');
const roots = [];
const SERVER = path.join(REPO, 'panel', 'server.js');
const CACHE_MS = 200; // PANEL_OUTDATED_CACHE_MS: git runs at most once in this time (5 s outside the tests)
// The waits for a change stay under the 5 s default, so a server that ignored PANEL_OUTDATED_CACHE_MS fails here instead
// of passing the "no reason" reads on a stale cache.
const CHANGE_MS = CACHE_MS + 2500;
const PRODUCT = '1.2.3';

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.no-hooks', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

/** Commits files ({ path: text }) and returns the short HEAD. */
function commit(dir, files, message = 'change') {
  for (const [f, text] of Object.entries(files)) write(dir, f, text);
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', message, '--', ...Object.keys(files));
  return git(dir, 'rev-parse', '--short', 'HEAD');
}

/** Fake root: an empty data folder, a test page and a git repository shaped like the painel-maestro's. */
function buildRoot(name) {
  const root = tmpDir(`outdated-${name}`);
  roots.push(root);
  const index = path.join(root, 'index-test.html');
  fs.writeFileSync(index, '<!doctype html><meta charset="utf-8"><title>Painel de teste</title>');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const c0 = commit(repo, {
    'package.json': `{ "name": "painel-maestro", "version": "${PRODUCT}" }\n`,
    'bin/flow.js': '// flow\n', 'bin/i18n/pt-BR.js': '// cli\n',
    'panel/server.js': '// server\n', 'panel/health.js': '// health\n', 'panel/index.html': '<!doctype html>\n',
    'panel/ui/src/App.jsx': '// app\n', 'panel/tests/test-a.js': '// test\n', 'docs/adr/0001.md': '# ADR\n', 'README.md': '# readme\n',
  }, 'start');
  return { root, repo, c0, data: path.join(root, 'maestro'), index };
}

function environment(r, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'),
    PANEL_INDEX: r.index, PANEL_REPO_DIR: r.repo, PANEL_OUTDATED_CACHE_MS: String(CACHE_MS), PANEL_COLLECTOR: '0', PANEL_MERGE_CHECK: '0', PANEL_PORT: '',
    PANEL_NOW: '', MAESTRO_NOW: '', NODE_OPTIONS: '',
  }, extra);
}

/** The environment without git: PATH has only node's folder. */
function withoutGit(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'PATH') out[k] = v;
  out.PATH = path.dirname(process.execPath);
  return out;
}

/** Starts the server as a process; returns {port, pid}. */
async function start(r, env = environment(r)) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const m = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${err}`);
    return /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(out);
  }, 15000);
  return { port: Number(m[1]), pid: Number(m[2]) };
}

async function state(s) {
  const st = await request(s.port, '/api/state');
  assert.strictEqual(st.status, 200);
  return st.json;
}

const outdatedOf = (st) => st.health.reasons.filter((x) => x.code === 'server_outdated');

/** Waits for a server_outdated reason (git runs at most once every CACHE_MS) and returns the state. */
const untilOutdated = (s) => waitFor(async () => {
  const st = await state(s);
  return outdatedOf(st).length ? st : null;
}, CHANGE_MS, 50);

/** Reads the state for longer than the cache and asserts no server_outdated came; returns the last state. */
async function neverOutdated(s) {
  const end = Date.now() + CACHE_MS + 800;
  let st;
  do {
    st = await state(s);
    assert.deepStrictEqual(outdatedOf(st), []);
    await new Promise((x) => setTimeout(x, 100));
  } while (Date.now() < end);
  return st;
}

let R;
let S;

suite.test('started on the repository of PANEL_REPO_DIR: version from it, green, no server_outdated', async () => {
  R = buildRoot('main');
  S = await start(R);
  const st = await state(S);
  // page is null: the fake page has no page id (#37, test-page-id.js).
  assert.deepStrictEqual(st.version, { product: PRODUCT, commit: R.c0, page: null });
  assert.strictEqual(st.health.level, 'green');
  assert.deepStrictEqual(st.health.reasons, []);
});

suite.test('commits only in docs/, ADRs, tests, the UI source or index.html, and uncommitted edits, add no reason', async () => {
  commit(R.repo, { 'docs/adr/0002.md': '# ADR 2\n', 'README.md': '# readme 2\n', 'panel/tests/test-a.js': '// test 2\n', 'panel/tests/util.js': '// util\n' }, 'docs and tests');
  commit(R.repo, { 'panel/ui/src/App.jsx': '// app 2\n', 'panel/ui/src/publish.js': '// publish\n', 'panel/index.html': '<!doctype html><p>2\n' }, 'page');
  write(R.repo, 'bin/flow.js', '// flow, not committed\n');
  write(R.repo, 'package.json', `{ "name": "painel-maestro", "version": "9.9.9" }\n`);
  write(R.repo, 'panel/server.js', '// server, staged\n');
  git(R.repo, 'add', 'panel/server.js');
  const st = await neverOutdated(S);
  assert.strictEqual(st.health.level, 'green');
  assert.deepStrictEqual(st.version, { product: PRODUCT, commit: R.c0, page: null });
});

suite.test('a commit in bin/ after the startup turns the badge yellow with server_outdated and the two commits', async () => {
  const c2 = commit(R.repo, { 'bin/flow.js': '// flow 2\n' }, 'bin');
  const st = await untilOutdated(S);
  assert.strictEqual(st.health.level, 'yellow');
  assert.deepStrictEqual(st.health.reasons, [{ code: 'server_outdated', started_commit: R.c0, head_commit: c2 }]);
  assert.deepStrictEqual(st.version, { product: PRODUCT, commit: R.c0, page: null }, 'the version is still the startup one');
  R.c2 = c2;
});

suite.test('a restart on the new HEAD takes the reason away', async () => {
  kill(S.pid);
  git(R.repo, 'reset', '-q', '--hard');
  S = await start(R);
  const st = await neverOutdated(S);
  assert.deepStrictEqual(st.version, { product: PRODUCT, commit: R.c2, page: null });
  assert.strictEqual(st.health.level, 'green');
});

suite.test('a top-level .js of panel/ counts (a new one too); HEAD back on the startup commit takes the reason away', async () => {
  const c3 = commit(R.repo, { 'panel/api-new.js': '// new route\n' }, 'new route');
  assert.deepStrictEqual(outdatedOf(await untilOutdated(S)), [{ code: 'server_outdated', started_commit: R.c2, head_commit: c3 }]);
  git(R.repo, 'reset', '-q', '--hard', R.c2);
  await waitFor(async () => !outdatedOf(await state(S)).length, CHANGE_MS, 50);
});

suite.test('package.json counts, and so does a switch to a branch whose server code differs', async () => {
  const c4 = commit(R.repo, { 'package.json': `{ "name": "painel-maestro", "version": "1.3.0" }\n` }, 'version');
  assert.deepStrictEqual(outdatedOf(await untilOutdated(S)), [{ code: 'server_outdated', started_commit: R.c2, head_commit: c4 }]);
  git(R.repo, 'checkout', '-q', '-b', 'other', R.c2);
  await waitFor(async () => !outdatedOf(await state(S)).length, CHANGE_MS, 50);
  const c5 = commit(R.repo, { 'bin/i18n/pt-BR.js': '// cli 2\n' }, 'cli text');
  git(R.repo, 'checkout', '-q', 'main');
  git(R.repo, 'merge', '-q', '--no-edit', 'other');
  const head = git(R.repo, 'rev-parse', '--short', 'HEAD');
  assert.notStrictEqual(head, c5);
  assert.deepStrictEqual(outdatedOf(await untilOutdated(S)), [{ code: 'server_outdated', started_commit: R.c2, head_commit: head }]);
  kill(S.pid);
});

suite.test('a folder without git: version with a null commit, no server_outdated, and the server answers normally', async () => {
  const r = buildRoot('nogit-folder');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-outdated-'));
  roots.push(folder);
  write(folder, 'package.json', `{ "name": "painel-maestro", "version": "${PRODUCT}" }\n`);
  const s = await start(r, environment(r, { PANEL_REPO_DIR: folder }));
  try {
    const st = await neverOutdated(s);
    assert.deepStrictEqual(st.version, { product: PRODUCT, commit: null, page: null });
    assert.strictEqual(st.health.level, 'green');
    assert.strictEqual((await request(s.port, '/')).status, 200);
  } finally {
    kill(s.pid);
  }
});

suite.test('without git on the PATH: no commit at the startup, so a later commit in bin/ adds no reason', async () => {
  const r = buildRoot('nogit-path');
  const s = await start(r, withoutGit(environment(r)));
  try {
    commit(r.repo, { 'bin/flow.js': '// flow 2\n' }, 'bin');
    const st = await neverOutdated(s);
    assert.deepStrictEqual(st.version, { product: PRODUCT, commit: null, page: null });
    assert.strictEqual(st.health.level, 'green');
  } finally {
    kill(s.pid);
  }
});

suite.run().finally(() => {
  if (S) kill(S.pid);
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
