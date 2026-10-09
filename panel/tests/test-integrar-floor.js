'use strict';
// Tests for the Maestri orchestration's integration script (#16): skills/docs/orquestracao-maestri/scripts/integrar.sh
// runs as a process (Git Bash) on the Ground of a temporary repository whose origin is a local bare repository, with
// a fake maestri (MAESTRI_CLI) that only records its arguments. The result is checked on git and through the items
// API, the same seam the flow tests use. Without Git Bash (bash.exe next to git) the suite is skipped.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const SCRIPT = path.join(REPO, 'skills', 'docs', 'orquestracao-maestri', 'scripts', 'integrar.sh');
const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('integrar.sh: floor branch → integradora → task integrated in the panel');
const roots = [];
const slash = (p) => p.replace(/\\/g, '/');

/** Git Bash: on Windows the "bash" on PATH is often WSL's, so take the one shipped with git. */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const bash = path.resolve(r.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe'); // <Git>/mingw64/libexec/git-core
  return fs.existsSync(bash) ? bash : null;
}
const BASH = findBash();

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Temporary root: a bare "widgets.git" as origin, the Ground on the integradora (pushed), a floor (worktree) on the
 * task branch with one commit, a data folder and a fake maestri that appends its arguments to maestri.log.
 */
function buildRoot(name, { integradora = 'feature/issue-12', branch = 'task/13-gerar-pdf' } = {}) {
  const root = tmpDir(`integrar-${name}`);
  roots.push(root);
  const remote = path.join(root, 'widgets.git');
  const ground = path.join(root, 'ground');
  const floor = path.join(root, 'floor-13');
  git(root, 'init', '-q', '--bare', remote);
  fs.mkdirSync(ground);
  git(ground, 'init', '-q', '-b', integradora);
  git(ground, 'remote', 'add', 'origin', `file:///${slash(remote)}`);
  git(ground, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  git(ground, 'push', '-q', 'origin', integradora);
  git(ground, 'worktree', 'add', '-q', '-b', branch, floor);
  fs.writeFileSync(path.join(floor, 'pdf.txt'), 'gerar o PDF\n');
  git(floor, 'add', 'pdf.txt');
  git(floor, 'commit', '-q', '-m', 'Gera o PDF (#13)');
  const fake = path.join(root, 'fake-maestri');
  fs.writeFileSync(fake, '#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/maestri.log"\n');
  fs.chmodSync(fake, 0o755);
  return { root, ground, floor, branch, integradora, data: path.join(root, 'data'), fake };
}

function env(r, extra = {}) {
  const e = Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', MAESTRI_CLI: slash(r.fake), PAINEL_MAESTRO: REPO,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
  }, extra);
  delete e.MAESTRI_TERMINAL_ID;
  delete e.MAESTRI_TERMINAL_NAME;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete e[k];
  return e;
}

function flow(r, args) {
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd: r.ground, env: env(r), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
}

function integrar(r, args, extra = {}) {
  return spawnSync(BASH, [slash(SCRIPT), ...args], { cwd: r.ground, env: env(r, extra), encoding: 'utf8', windowsHide: true, timeout: 120000 });
}

/** The item started in Implementação with tasks 13 and 14, and task 13 dispatched to the floor. */
function startItem(r) {
  flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']);
  flow(r, ['task', 'graph', '12', '--task', '13|Gerar o PDF', '--task', '14|Enviar por e-mail|13']);
  flow(r, ['task', 'dispatch', '12', '13', '--floor', 'Gerar PDF', '--worker', 'Aria', '--branch', r.branch]);
}

async function apiGet(r, p) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') },
  });
  try {
    const x = await request(port, p);
    assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
    return x.json;
  } finally {
    await s.stop();
  }
}

const task13 = async (r) => (await apiGet(r, '/api/items/widgets/12')).item.tasks.find((t) => t.number === 13);
const ok = (x) => assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
const maestriLog = (r) => { try { return fs.readFileSync(path.join(r.root, 'maestri.log'), 'utf8'); } catch { return ''; } };

suite.test('integrating a floor fast-forwards and pushes the integradora and records the task integrated with both SHAs', async () => {
  const r = buildRoot('ff');
  startItem(r);
  const before = git(r.ground, 'rev-parse', '--short', 'HEAD');
  const after = git(r.floor, 'rev-parse', '--short', 'HEAD');

  const x = integrar(r, ['Gerar PDF', r.branch, r.integradora]);
  ok(x);
  assert.strictEqual(git(r.ground, 'rev-parse', '--short', 'HEAD'), after);
  assert.strictEqual(git(r.ground, 'rev-parse', `origin/${r.integradora}`), git(r.ground, 'rev-parse', 'HEAD'));
  const t = await task13(r);
  assert.deepStrictEqual([t.state, t.sha, t.sha_before], ['integrated', after, before]);
  assert.match(x.stdout, /painel: task 13 integrada no item 12/);
  assert.match(maestriLog(r), /floor delete Gerar PDF/);
});

suite.test('portable: item and task come out of the branches without GNU extensions (sed --posix as a BSD sed)', async () => {
  const r = buildRoot('posix');
  startItem(r);
  // An exported bash function wins over the PATH (Git Bash puts /usr/bin first): every sed call runs without GNU extensions.
  const x = integrar(r, ['Gerar PDF', r.branch, r.integradora], { 'BASH_FUNC_sed%%': '() {  /usr/bin/sed --posix "$@"\n}' });
  ok(x);
  assert.match(x.stdout, /painel: task 13 integrada no item 12/);
  assert.strictEqual((await task13(r)).state, 'integrated');
});

suite.test('item and task come as arguments when the branches do not follow the convention', async () => {
  const r = buildRoot('args', { integradora: 'feature/exportar', branch: 'task/gerar-pdf' });
  startItem(r);
  const x = integrar(r, ['Gerar PDF', r.branch, r.integradora, '12', '13']);
  ok(x);
  assert.strictEqual((await task13(r)).state, 'integrated');
});

suite.test('a panel that cannot record does not undo the integration: exit 0, a warning and the command to rerun', async () => {
  const r = buildRoot('fail'); // the item was never started: flow answers with code 2
  const x = integrar(r, ['Gerar PDF', r.branch, r.integradora]);
  ok(x);
  assert.strictEqual(git(r.ground, 'rev-parse', 'HEAD'), git(r.floor, 'rev-parse', 'HEAD'));
  assert.match(x.stderr, /integrar: aviso: o painel não registrou/);
  assert.match(x.stderr, /task integrate 12 13 --sha [0-9a-f]+ --sha-before [0-9a-f]+/);
});

suite.test('without PAINEL_MAESTRO the integration happens and the warning says the panel was not recorded', async () => {
  const r = buildRoot('nopanel');
  startItem(r);
  const x = integrar(r, ['Gerar PDF', r.branch, r.integradora], { PAINEL_MAESTRO: undefined });
  ok(x);
  assert.match(x.stderr, /integrar: aviso: o painel não registrou a integração \(PAINEL_MAESTRO não está definida/);
  assert.strictEqual((await task13(r)).state, 'working');
});

suite.test('the final adjustment floor is integrated but is not a task: the panel points to final-adjustment instead', async () => {
  const r = buildRoot('ajuste', { branch: 'task/12-ajuste-final' });
  startItem(r);
  const x = integrar(r, ['12 Ajuste', r.branch, r.integradora]);
  ok(x);
  assert.strictEqual(git(r.ground, 'rev-parse', 'HEAD'), git(r.floor, 'rev-parse', 'HEAD'));
  assert.match(x.stdout, /integrar: painel: ajuste final integrado; registre o resultado com flow final-adjustment 12 result/);
  assert.doesNotMatch(x.stderr, /aviso/);
  const timeline = (await apiGet(r, '/api/items/widgets/12')).item.timeline.map((e) => e.type);
  assert.ok(!timeline.includes('task-integrated'), timeline.join(', '));
});

suite.test('a task branch that is not on top of the integradora is refused before anything changes', async () => {
  const r = buildRoot('stale');
  startItem(r);
  git(r.ground, 'commit', '-q', '--allow-empty', '-m', 'outra task integrada');
  const head = git(r.ground, 'rev-parse', 'HEAD');
  const x = integrar(r, ['Gerar PDF', r.branch, r.integradora]);
  assert.strictEqual(x.status, 1, x.stderr);
  assert.match(x.stderr, /não está sobre/);
  assert.strictEqual(git(r.ground, 'rev-parse', 'HEAD'), head);
  assert.strictEqual((await task13(r)).state, 'working');
});

if (!BASH) {
  console.log('\n== integrar.sh: skipped (Git Bash not found next to git)');
} else {
  suite.run().then(() => {
    if (!process.env.KEEP_TMP) roots.forEach(remove);
  });
}
