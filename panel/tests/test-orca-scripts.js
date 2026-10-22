'use strict';
// Tests for the Orca orchestration's helper scripts: skills/docs/orchestration-orca/scripts/create-worktree.sh (creates
// the task's worktree and renames its branch, refusing to touch the maestro's own branch) and wait-workers.sh (loops
// on `orchestration check --wait`, acks heartbeat-only batches, prints the first real delivery). Both run as processes
// (Git Bash) against a fake orca (ORCA_CLI). Without Git Bash (bash.exe next to git) the suite is skipped.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove } = require('./util');

const DIR = path.join(REPO, 'skills', 'docs', 'orchestration-orca', 'scripts');
const suite = createSuite('orca create-worktree.sh and wait-workers.sh: worktree with the task branch, wait without heartbeats');
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

// The fake orca: appends its arguments to orca.log.
// - "worktree create --name <n> --base-branch <b> ...": adds a worktree next to the maestro's on branch fakeuser/<n> and
//   answers its id and path; FAKE_ORCA_PATH=maestro answers the maestro's own path, FAKE_ORCA_PATH=empty no path.
// - "orchestration check ...": prints answers/<k>.txt for the k-th call (1-based), then answers an empty timeout.
const FAKE_ORCA = `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
echo "$*" >> "$here/orca.log"
if [ "$1 $2" = "worktree create" ]; then
  name="$4"; base="$6"; wt="$here/$name"
  git worktree add -q -b "fakeuser/$name" "$wt" "$base" >/dev/null 2>&1
  case "\${FAKE_ORCA_PATH:-}" in
    maestro) wt="$(git rev-parse --show-toplevel)" ;;
    empty) wt="" ;;
  esac
  echo "{\\"ok\\":true,\\"result\\":{\\"worktree\\":{\\"id\\":\\"repo::$wt\\",\\"path\\":\\"$wt\\",\\"branch\\":\\"refs/heads/fakeuser/$name\\"}}}"
  exit 0
fi
if [ "$1 $2" = "orchestration check" ]; then
  n=$(( $(cat "$here/check.count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$here/check.count"
  if [ -f "$here/answers/$n.txt" ]; then cat "$here/answers/$n.txt"; else
    echo '{"_keepalive":true,"_heartbeat":true,"elapsedMs":15000,"deadlineMs":900000}'
    echo '{"ok":true,"result":{"deliveryId":null,"messages":[],"count":0,"timedOut":true}}'
  fi
  exit 0
fi
`;

function buildRoot(name, integration = 'feature/pbi-12') {
  const root = tmpDir(`orca-scripts-${name}`);
  roots.push(root);
  const ground = path.join(root, 'maestro');
  fs.mkdirSync(ground);
  git(ground, 'init', '-q', '-b', integration);
  git(ground, 'commit', '-q', '--allow-empty', '-m', 'inicio');
  const fake = path.join(root, 'fake-orca');
  fs.writeFileSync(fake, FAKE_ORCA);
  fs.chmodSync(fake, 0o755);
  fs.mkdirSync(path.join(root, 'answers'));
  return { root, ground, integration, fake };
}

function run(r, script, args, extra = {}) {
  const env = Object.assign({}, process.env, { ORCA_CLI: slash(r.fake), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }, extra);
  return spawnSync(BASH, [slash(path.join(DIR, script)), ...args], { cwd: r.ground, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
}

const ok = (x) => assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
const orcaLog = (r) => { try { return fs.readFileSync(path.join(r.root, 'orca.log'), 'utf8').trim().split('\n'); } catch { return []; } };
const answer = (r, n, ...lines) => fs.writeFileSync(path.join(r.root, 'answers', `${n}.txt`), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
const batch = (delivery, ...messages) => ({ ok: true, result: { deliveryId: delivery, messages, count: messages.length, timedOut: false } });
const heartbeat = (id) => ({ id, type: 'heartbeat', subject: 'alive', body: '', payload: '{"phase":"implementing"}' });

suite.test('create-worktree.sh creates the worktree from the integration branch and renames only its branch', () => {
  const r = buildRoot('create');
  const x = run(r, 'create-worktree.sh', ['13', 'gerar-pdf', r.integration]);
  ok(x);
  const wt = path.join(r.root, 'task-13-gerar-pdf');
  assert.match(x.stdout, /^worktree: repo::.+task-13-gerar-pdf$/m);
  assert.match(x.stdout, /^path: .+task-13-gerar-pdf$/m);
  assert.match(x.stdout, /^branch: task\/13-gerar-pdf$/m);
  assert.strictEqual(git(wt, 'branch', '--show-current'), 'task/13-gerar-pdf');
  assert.strictEqual(git(r.ground, 'branch', '--show-current'), r.integration);
  assert.strictEqual(git(r.ground, 'branch', '--list', 'fakeuser/*'), '');
  assert.deepStrictEqual(orcaLog(r), [`worktree create --name task-13-gerar-pdf --base-branch ${r.integration} --parent-worktree current --json`]);
});

suite.test('create-worktree.sh refuses a maestro off the integration branch before calling the Orca', () => {
  const r = buildRoot('offbranch');
  git(r.ground, 'checkout', '-q', '-b', 'outra');
  const x = run(r, 'create-worktree.sh', ['13', 'gerar-pdf', r.integration]);
  assert.strictEqual(x.status, 1, x.stderr);
  assert.match(x.stderr, /worktree: o worktree do maestro está em "outra", não na integradora feature\/pbi-12/);
  assert.deepStrictEqual(orcaLog(r), []);
});

for (const [mode, message] of [['maestro', /o Orca respondeu o path do próprio worktree do maestro/], ['empty', /a resposta do Orca não traz o id e o path/]]) {
  suite.test(`create-worktree.sh never renames the maestro's branch (answer path: ${mode})`, () => {
    const r = buildRoot(`path-${mode}`);
    const x = run(r, 'create-worktree.sh', ['13', 'gerar-pdf', r.integration], { FAKE_ORCA_PATH: mode });
    assert.strictEqual(x.status, 1, x.stderr);
    assert.match(x.stderr, message);
    assert.strictEqual(git(r.ground, 'branch', '--show-current'), r.integration);
    assert.strictEqual(git(r.ground, 'branch', '--list', 'task/*'), '');
  });
}

suite.test('wait-workers.sh acks a heartbeat-only batch by itself and prints the next real delivery without acking it', () => {
  const r = buildRoot('wait');
  answer(r, 1, { _keepalive: true, _heartbeat: true, elapsedMs: 15000 }, batch('delivery_1', heartbeat('msg_1')));
  answer(r, 2, { _keepalive: true, _heartbeat: true, elapsedMs: 15000 },
    batch('delivery_2', heartbeat('msg_2'), { id: 'msg_3', type: 'worker_done', subject: '#13 ok: "PDF" {gerado}', body: 'Gerei o PDF.\nTestes verdes.', payload: '{"outcome":"succeeded"}' }));
  const x = run(r, 'wait-workers.sh', ['--run', 'run_1', '--ack', 'delivery_0', '--timeout-ms', '1000']);
  ok(x);
  assert.match(x.stdout, /^esperar: entrega delivery_2 \(2 mensagem\(ns\)\)$/m);
  assert.match(x.stdout, /^--- worker_done msg_3 · #13 ok: "PDF" \{gerado\}$/m);
  assert.match(x.stdout, /^payload: \{"outcome":"succeeded"\}$/m);
  assert.match(x.stdout, /Gerei o PDF\.\nTestes verdes\./);
  assert.doesNotMatch(x.stdout, /heartbeat|msg_2|_keepalive/);
  const calls = orcaLog(r);
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0], /orchestration check --wait --types worker_done,escalation,question --timeout-ms 1000 --json --run run_1 --ack delivery_0$/);
  assert.match(calls[1], /--ack delivery_1$/);
});

suite.test('wait-workers.sh gives up after the empty waits in a row and points to worker-list', () => {
  const r = buildRoot('empty');
  const x = run(r, 'wait-workers.sh', ['--run', 'run_1', '--rounds', '2', '--timeout-ms', '1000']);
  assert.strictEqual(x.status, 3, x.stderr);
  assert.match(x.stdout, /esperar: 2 esperas vazias seguidas/);
  assert.match(x.stdout, /orchestration worker-list --run run_1 --json/);
  assert.strictEqual(orcaLog(r).length, 2);
  assert.doesNotMatch(orcaLog(r)[1], /--ack/);
});

suite.test('wait-workers.sh stops with exit 1 when the check answers no valid JSON', () => {
  const r = buildRoot('bad');
  answer(r, 1, 'Orca fora do ar');
  const x = run(r, 'wait-workers.sh', ['--timeout-ms', '1000']);
  assert.strictEqual(x.status, 1);
  assert.match(x.stderr, /esperar: resposta do check sem JSON válido: Orca fora do ar/);
});

if (!BASH) {
  console.log('\n== orca create-worktree.sh and wait-workers.sh: skipped (Git Bash not found next to git)');
} else {
  suite.run().then(() => {
    if (!process.env.KEEP_TMP) roots.forEach(remove);
  });
}
