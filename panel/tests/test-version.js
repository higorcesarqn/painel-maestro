'use strict';
// Tests for the panel's version (#36) through the agreed seams only: the server runs as a process and is read through
// GET /api/state; the flow CLI runs as a process and is read through its output. The version is the semver of the root
// package.json and the commit the code is on (null outside a clone or without git on the PATH).
// Fake roots under tests/tmp/, servers on a port between 4790 and 4799.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, waitFor, kill } = require('./util');

const suite = createSuite('version (package.json semver + commit)');
const roots = [];
const PRODUCT = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const COMMIT = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim();

/** Fake root: an empty data folder and a test page. */
function buildRoot(name) {
  const root = tmpDir(`version-${name}`);
  roots.push(root);
  const index = path.join(root, 'index-test.html');
  fs.writeFileSync(index, '<!doctype html><meta charset="utf-8"><title>Painel de teste</title>');
  return { root, data: path.join(root, 'maestro'), index };
}

/** The environment without git: PATH has only node's folder. */
function withoutGit(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'PATH') out[k] = v;
  out.PATH = path.dirname(process.execPath);
  return out;
}

function environment(r, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'),
    PANEL_INDEX: r.index, PANEL_COLLECTOR: '0', PANEL_MERGE_CHECK: '0', PANEL_PORT: '', MAESTRO_NOW: '', NODE_OPTIONS: '',
  }, extra);
}

/** Copy of the code the server and the CLI run (bin/, the panel's .js files and package.json) in a folder outside a clone. */
function copyCode(r) {
  const code = path.join(r.root, 'code');
  fs.cpSync(path.join(REPO, 'bin'), path.join(code, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(code, 'panel'), { recursive: true });
  for (const n of fs.readdirSync(path.join(REPO, 'panel'))) {
    if (n.endsWith('.js')) fs.copyFileSync(path.join(REPO, 'panel', n), path.join(code, 'panel', n));
  }
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(code, 'package.json'));
  return code;
}

/** Starts the server (from the repository or from a copy) as a process; returns {port, pid}. */
async function start(r, { code = REPO, env = environment(r) } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(code, 'panel', 'server.js'), '--port', String(port)], { env, windowsHide: true });
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

async function versionOf(r, options) {
  const s = await start(r, options);
  try {
    const st = await request(s.port, '/api/state');
    assert.strictEqual(st.status, 200);
    return st.json.version;
  } finally {
    kill(s.pid);
  }
}

function flow(r, args, { code = REPO, env = environment(r) } = {}) {
  return spawnSync(process.execPath, [path.join(code, 'bin', 'flow.js'), ...args], { cwd: os.tmpdir(), env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

suite.test('the version under test is a semver and the repository has a commit', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(PRODUCT), PRODUCT);
  assert.ok(/^[0-9a-f]{4,}$/.test(COMMIT), COMMIT);
});

suite.test('GET /api/state brings version: the semver of package.json and the short commit the server started on', async () => {
  const r = buildRoot('server');
  assert.deepStrictEqual(await versionOf(r), { product: PRODUCT, commit: COMMIT });
});

suite.test('outside a clone: the server answers version with a null commit', async () => {
  const r = buildRoot('server-copy');
  assert.deepStrictEqual(await versionOf(r, { code: copyCode(r) }), { product: PRODUCT, commit: null });
});

suite.test('without git on the PATH: the server answers version with a null commit', async () => {
  const r = buildRoot('server-nogit');
  assert.deepStrictEqual(await versionOf(r, { env: withoutGit(environment(r)) }), { product: PRODUCT, commit: null });
});

suite.test('flow --version and flow -v print "painel-maestro <semver> (<commit>)" and exit with 0, outside any repository', () => {
  const r = buildRoot('cli');
  for (const flag of ['--version', '-v']) {
    const x = flow(r, [flag]);
    assert.strictEqual(x.status, 0, x.stderr);
    assert.strictEqual(x.stdout, `painel-maestro ${PRODUCT} (${COMMIT})\n`, flag);
    assert.strictEqual(x.stderr, '');
  }
});

suite.test('flow --version without the commit outside a clone and without git on the PATH', () => {
  const r = buildRoot('cli-nogit');
  const copy = flow(r, ['--version'], { code: copyCode(r) });
  assert.strictEqual(copy.status, 0, copy.stderr);
  assert.strictEqual(copy.stdout, `painel-maestro ${PRODUCT}\n`);
  const noGit = flow(r, ['-v'], { env: withoutGit(environment(r)) });
  assert.strictEqual(noGit.status, 0, noGit.stderr);
  assert.strictEqual(noGit.stdout, `painel-maestro ${PRODUCT}\n`);
});

suite.test('flow --help cites flow --version', () => {
  const r = buildRoot('help');
  const x = flow(r, ['--help']);
  assert.strictEqual(x.status, 0, x.stderr);
  assert.ok(/flow\.js --version/.test(x.stdout) && /-v\b/.test(x.stdout), x.stdout);
});

suite.test('only the root package.json has a version: the UI package (private, build only) has none', () => {
  const ui = JSON.parse(fs.readFileSync(path.join(REPO, 'panel', 'ui', 'package.json'), 'utf8'));
  assert.ok(!('version' in ui), 'panel/ui/package.json has a version');
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'panel', 'ui', 'package-lock.json'), 'utf8'));
  assert.ok(!('version' in lock) && !('version' in lock.packages['']), 'panel/ui/package-lock.json has a version');
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
