'use strict';
// Tests for the Orca orchestration's integration script (#65): skills/docs/orchestration-orca/scripts/integrate.sh runs
// as a process (Git Bash) in the maestro's worktree of a temporary repository whose origin is a local bare repository,
// with a fake orca (ORCA_CLI) that records its arguments and, on "worktree rm", removes the worktree and its branch the
// way the Orca does. The result is checked on git and through the items API, the same seam the flow tests use. Without
// Git Bash (bash.exe next to git) the suite is skipped.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const SCRIPT = path.join(REPO, 'skills', 'docs', 'orchestration-orca', 'scripts', 'integrate.sh');
const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('orca integrate.sh: Orca worktree branch → integration branch → task integrated in the panel');
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

// The fake orca: appends its arguments to orca.log. "worktree rm --worktree branch:<b> --json" removes the worktree of
// that branch and deletes the branch (what the Orca does), unless FAKE_ORCA_FAIL is set: then it answers { ok: false }.
const FAKE_ORCA = `#!/usr/bin/env bash
echo "$*" >> "$(dirname "$0")/orca.log"
if [ "$1 $2" = "worktree rm" ]; then
  if [ -n "\${FAKE_ORCA_FAIL:-}" ]; then echo '{"ok":false,"error":{"code":"runtime_error","message":"Orca fora do ar"}}'; exit 1; fi
  b="\${4#branch:}"
  wt="$(git worktree list --porcelain | awk -v b="branch refs/heads/$b" '/^worktree /{w=substr($0,10)} $0==b{print w}')"
  git worktree remove "$wt" && git branch -D -q "$b"
  echo '{"ok":true,"result":{"removed":true}}'
fi
`;

/**
 * Temporary root: a bare "widgets.git" as origin, the maestro's worktree on the integration branch (pushed), an Orca
 * worktree on the task branch with one commit, a data folder and the fake orca.
 */
function buildRoot(name, { integration = 'feature/issue-12', branch = 'task/13-gerar-pdf' } = {}) {
  const root = tmpDir(`integrate-orca-${name}`);
  roots.push(root);
  const remote = path.join(root, 'widgets.git');
  const ground = path.join(root, 'maestro');
  const wt = path.join(root, 'task-13-gerar-pdf');
  git(root, 'init', '-q', '--bare', remote);
  fs.mkdirSync(ground);
  git(ground, 'init', '-q', '-b', integration);
  git(ground, 'remote', 'add', 'origin', `file:///${slash(remote)}`);
  git(ground, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  git(ground, 'push', '-q', 'origin', integration);
  git(ground, 'worktree', 'add', '-q', '-b', branch, wt);
  fs.writeFileSync(path.join(wt, 'pdf.txt'), 'gerar o PDF\n');
  git(wt, 'add', 'pdf.txt');
  git(wt, 'commit', '-q', '-m', 'Gera o PDF (#13)');
  const fake = path.join(root, 'fake-orca');
  fs.writeFileSync(fake, FAKE_ORCA);
  fs.chmodSync(fake, 0o755);
  return { root, ground, wt, branch, integration, data: path.join(root, 'data'), fake };
}

function env(r, extra = {}) {
  const e = Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', ORCA_CLI: slash(r.fake), PAINEL_MAESTRO: REPO,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
  }, extra);
  for (const k of ['MAESTRI_TERMINAL_ID', 'MAESTRI_TERMINAL_NAME', 'ORCA_TERMINAL_HANDLE', 'ORCA_WORKTREE_ID']) delete e[k];
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete e[k];
  return e;
}

function flow(r, args) {
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd: r.ground, env: env(r), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
}

function integrate(r, args, extra = {}) {
  return spawnSync(BASH, [slash(SCRIPT), ...args], { cwd: r.ground, env: env(r, extra), encoding: 'utf8', windowsHide: true, timeout: 120000 });
}

/** The item started in Implementação with tasks 13 and 14, and task 13 dispatched to the Orca worktree. */
function startItem(r) {
  flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']);
  flow(r, ['task', 'graph', '12', '--task', '13|Gerar o PDF', '--task', '14|Enviar por e-mail|13']);
  flow(r, ['task', 'dispatch', '12', '13', '--floor', 'task-13-gerar-pdf', '--worker', 'Aria', '--branch', r.branch, '--mode', 'orca']);
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
const orcaLog = (r) => { try { return fs.readFileSync(path.join(r.root, 'orca.log'), 'utf8'); } catch { return ''; } };
const branchExists = (r, b) => git(r.ground, 'branch', '--list', b) !== '';

suite.test('integrating an Orca worktree fast-forwards and pushes, records the task with both SHAs and removes the worktree with orca worktree rm', async () => {
  const r = buildRoot('ff');
  startItem(r);
  const before = git(r.ground, 'rev-parse', '--short', 'HEAD');
  const after = git(r.wt, 'rev-parse', '--short', 'HEAD');

  const x = integrate(r, [r.branch, r.integration]);
  ok(x);
  assert.strictEqual(git(r.ground, 'rev-parse', '--short', 'HEAD'), after);
  assert.strictEqual(git(r.ground, 'rev-parse', `origin/${r.integration}`), git(r.ground, 'rev-parse', 'HEAD'));
  const t = await task13(r);
  assert.deepStrictEqual([t.state, t.sha, t.sha_before], ['integrated', after, before]);
  assert.match(x.stdout, /integrar: painel: task 13 integrada no item 12/);
  // Only the removal: no worker-release nor terminal close, so a terminal retained by user_takeover does not stop it.
  assert.deepStrictEqual(orcaLog(r).trim().split('\n'), [`worktree rm --worktree branch:${r.branch} --json`]);
  assert.ok(!fs.existsSync(r.wt), 'the worktree folder is gone');
  assert.ok(!git(r.ground, 'worktree', 'list').includes(slash(r.wt)), 'git still lists the worktree');
  assert.ok(!branchExists(r, r.branch), 'the task branch is gone');
});

suite.test('item and task come as arguments when the branches do not follow the convention', async () => {
  const r = buildRoot('args', { integration: 'feature/exportar', branch: 'task/gerar-pdf' });
  startItem(r);
  const x = integrate(r, [r.branch, r.integration, '12', '13']);
  ok(x);
  assert.strictEqual((await task13(r)).state, 'integrated');
});

suite.test('a panel that cannot record does not undo the integration: exit 0, a warning and the command to rerun', async () => {
  const r = buildRoot('fail'); // the item was never started: flow answers with code 2
  const x = integrate(r, [r.branch, r.integration]);
  ok(x);
  assert.strictEqual(git(r.ground, 'rev-parse', 'HEAD'), git(r.ground, 'rev-parse', `origin/${r.integration}`));
  assert.match(x.stderr, /integrar: aviso: o painel não registrou/);
  assert.match(x.stderr, /task integrate 12 13 --sha [0-9a-f]+ --sha-before [0-9a-f]+/);
  assert.ok(!fs.existsSync(r.wt), 'the worktree is removed all the same');
});

suite.test('without PAINEL_MAESTRO the integration happens and the warning says the panel was not recorded', async () => {
  const r = buildRoot('nopanel');
  startItem(r);
  const x = integrate(r, [r.branch, r.integration], { PAINEL_MAESTRO: undefined });
  ok(x);
  assert.match(x.stderr, /integrar: aviso: o painel não registrou a integração \(PAINEL_MAESTRO não está definida/);
  assert.strictEqual((await task13(r)).state, 'working');
});

suite.test('an orca that does not remove the worktree keeps the integration: exit 0, a warning and the command to run', async () => {
  const r = buildRoot('orcafail');
  startItem(r);
  const x = integrate(r, [r.branch, r.integration], { FAKE_ORCA_FAIL: '1' });
  ok(x);
  assert.strictEqual((await task13(r)).state, 'integrated');
  assert.match(x.stdout, /integrar: painel: task 13 integrada no item 12/);
  assert.match(x.stderr, /integrar: aviso: o Orca não removeu o worktree .*Orca fora do ar/);
  assert.match(x.stderr, new RegExp(`worktree rm --worktree branch:${r.branch} --json`));
  assert.ok(fs.existsSync(r.wt), 'the worktree stays for the Orca to remove');
  assert.ok(branchExists(r, r.branch), 'the branch stays with its worktree');
});

suite.test('the final adjustment worktree is integrated but is not a task: the panel points to final-adjustment instead', async () => {
  const r = buildRoot('ajuste', { branch: 'task/12-ajuste-final' });
  startItem(r);
  const after = git(r.wt, 'rev-parse', 'HEAD');
  const x = integrate(r, [r.branch, r.integration]);
  ok(x);
  assert.strictEqual(git(r.ground, 'rev-parse', 'HEAD'), after);
  assert.match(x.stdout, /integrar: painel: ajuste final integrado; registre o resultado com flow final-adjustment 12 result/);
  assert.doesNotMatch(x.stderr, /aviso/);
  const timeline = (await apiGet(r, '/api/items/widgets/12')).item.timeline.map((e) => e.type);
  assert.ok(!timeline.includes('task-integrated'), timeline.join(', '));
  assert.match(orcaLog(r), /worktree rm --worktree branch:task\/12-ajuste-final --json/);
});

suite.test('a task branch that is not on top of the integration branch is refused before anything changes', async () => {
  const r = buildRoot('stale');
  startItem(r);
  git(r.ground, 'commit', '-q', '--allow-empty', '-m', 'outra task integrada');
  const head = git(r.ground, 'rev-parse', 'HEAD');
  const x = integrate(r, [r.branch, r.integration]);
  assert.strictEqual(x.status, 1, x.stderr);
  assert.match(x.stderr, /não está sobre/);
  assert.strictEqual(git(r.ground, 'rev-parse', 'HEAD'), head);
  assert.strictEqual((await task13(r)).state, 'working');
  assert.strictEqual(orcaLog(r), '', 'the orca is not called');
  assert.ok(fs.existsSync(r.wt));
});

suite.test('a worktree with uncommitted changes is refused and the Orca is not called', async () => {
  const r = buildRoot('dirty');
  startItem(r);
  fs.writeFileSync(path.join(r.wt, 'rascunho.txt'), 'não commitado\n');
  const x = integrate(r, [r.branch, r.integration]);
  assert.strictEqual(x.status, 1, x.stderr);
  assert.match(x.stderr, /integrar: o worktree .* tem alterações não commitadas/);
  assert.strictEqual(orcaLog(r), '');
});

if (!BASH) {
  console.log('\n== orca integrate.sh: skipped (Git Bash not found next to git)');
} else {
  suite.run().then(() => {
    if (!process.env.KEEP_TMP) roots.forEach(remove);
  });
}
