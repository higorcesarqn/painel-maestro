'use strict';
// Tests for the end of an item's flow (#9): integration branch and PR, final adjustment, HML validation and the
// item's conclusion. Same seam as test-flow.js: the bin/flow.js CLI runs as a process inside a temporary git
// repository (fictitious remote origin) → temporary maestro.db (MAESTRO_DIR) → the server's HTTP API.
// No test reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('flow CLI: PR, final adjustment, HML and conclusion → items API');
const roots = [];

const GH_PR = 'https://github.com/acme/widgets/pull/34';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder (MAESTRO_DIR) and a git repository whose origin points to a fictitious project. */
function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`delivery-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', remote);
  return { root, data, repo };
}

/** Runs the CLI as the maestro (or the owner) would: node bin/flow.js ... in the project's repository. */
function flow(r, args, { input } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' });
  return spawnSync(process.execPath, [FLOW, ...args], { cwd: r.repo, env, input: input === undefined ? '' : input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
}

function invalid(x, message) {
  assert.strictEqual(x.status, 2, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.ok(x.stderr.startsWith('erro: '), x.stderr);
  assert.ok(message.test(x.stderr), x.stderr);
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') },
  });
  try {
    await fn(async (p) => {
      const x = await request(port, p);
      assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
      return x.json;
    });
  } finally {
    await s.stop();
  }
}

suite.test('the PR moves the item: draft keeps it in Implementation, ready → PR pronto, merged → Merge', async () => {
  const r = buildRoot('pr');
  ok(flow(r, ['item', 'start', '12', '--title', 'Exportar relatório', '--stage', 'implementation']));
  ok(flow(r, ['pr', '12', 'draft', '--url', GH_PR, '--branch', 'feature/issue-12']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'implementation');
    assert.deepStrictEqual([item.pr.state, item.pr.url, item.pr.number, item.pr.branch], ['draft', GH_PR, 34, 'feature/issue-12']);
  });
  ok(flow(r, ['pr', '12', 'ready']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'pr_ready');
    assert.deepStrictEqual([item.pr.state, item.pr.url, item.pr.number, item.pr.branch], ['ready', GH_PR, 34, 'feature/issue-12'], 'URL, number and branch are kept');
  });
  ok(flow(r, ['pr', '12', 'merged']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'merge');
    assert.strictEqual(item.pr.state, 'merged');
    assert.ok(item.pr.merged_at && item.pr.ready_at && item.pr.opened_at);
    assert.deepStrictEqual(item.timeline.map((e) => [e.type, e.payload.state]).slice(1),
      [['pr-changed', 'draft'], ['pr-changed', 'ready'], ['pr-changed', 'merged']]);
  });
});

suite.test('the whole end of the flow: Final adjustment → PR ready → Merge → HML validation → Done, then it leaves the active list', async () => {
  const r = buildRoot('full', 'https://contoso@dev.azure.com/contoso/CIDAX/_git/cidax-api');
  const PR = 'https://dev.azure.com/contoso/CIDAX/_git/cidax-api/pullrequest/812';
  const CARD = 'https://dev.azure.com/contoso/CIDAX/_workitems/edit/3100';
  ok(flow(r, ['item', 'start', '3100', '--title', 'Conciliação de boletos', '--stage', 'implementation']));
  ok(flow(r, ['item', 'start', '3101', '--title', 'Outro item', '--stage', 'implementation']));
  ok(flow(r, ['pr', '3100', 'draft', '--url', PR, '--branch', 'feature/pbi-3100']));
  ok(flow(r, ['final-adjustment', '3100', 'open']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/cidax-api/3100')).item;
    assert.strictEqual(item.stage, 'final_adjustment');
    assert.deepStrictEqual([item.final_adjustment.status, item.final_adjustment.finished_at], ['open', null]);
    assert.ok(item.final_adjustment.opened_at);
  });
  const summary = 'Testes ok; corrigi 2 nits\ndo revisor ("aspas" e acentos: ç)';
  ok(flow(r, ['final-adjustment', '--json', '-'], { input: JSON.stringify({ number: 3100, action: 'result', outcome: 'passed', summary }) }));
  ok(flow(r, ['pr', '3100', 'ready']));
  ok(flow(r, ['pr', '3100', 'merged']));
  ok(flow(r, ['hml', '3100', '--passed', '7', '--failed', '1', '--blocked', '2', '--card', CARD, '--role', 'owner']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/cidax-api/3100')).item;
    assert.strictEqual(item.stage, 'hml_validation');
    assert.deepStrictEqual([item.final_adjustment.status, item.final_adjustment.summary], ['passed', summary]);
    assert.deepStrictEqual([item.pr.state, item.pr.number, item.pr.url, item.pr.branch], ['merged', 812, PR, 'feature/pbi-3100']);
    assert.deepStrictEqual(item.hml, { outcome: 'failed', passed: 7, failed: 1, blocked: 2, card_url: CARD, summary: null, recorded_at: item.hml.recorded_at });
    assert.strictEqual(item.timeline[item.timeline.length - 1].agent.role, 'owner');
    assert.deepStrictEqual(item.stages.map((s) => s.status), ['done', 'done', 'done', 'done', 'done', 'current', 'pending']);
    assert.strictEqual(item.active, true);
    assert.strictEqual(item.completed_at, null);
  });
  ok(flow(r, ['hml', '3100', '--passed', '10']));
  ok(flow(r, ['item', 'done', '3100']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/cidax-api/3100')).item;
    assert.strictEqual(item.stage, 'done');
    assert.strictEqual(item.hml.outcome, 'approved');
    assert.strictEqual(item.active, false);
    assert.strictEqual(item.completed_at, item.stage_since);
    assert.deepStrictEqual(item.timeline.slice(-2).map((e) => e.type), ['hml-recorded', 'item-done']);
    const all = (await get('/api/items')).items;
    assert.deepStrictEqual(all.map((i) => [i.key, i.active]).sort(), [['cidax-api/3100', false], ['cidax-api/3101', true]]);
    assert.deepStrictEqual((await get('/api/items?active=1')).items.map((i) => i.key), ['cidax-api/3101'], 'the done item leaves the active list');
    assert.deepStrictEqual((await get('/api/items?active=0')).items.map((i) => i.key), ['cidax-api/3100'], 'and can still be found');
  });
});

suite.test('a project without HML validation skips that stage: Merge → Done, and an HML result is refused', async () => {
  const r = buildRoot('no-hml');
  // The project declares its stages (no HML) and the state its tracker uses for done items.
  ok(flow(r, ['org', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'widgets', '--name', 'Widgets', '--org', 'personal', '--done-state', 'Committed',
    '--stages', 'specification,implementation,final_adjustment,pr_ready,merge,done']));
  ok(flow(r, ['item', 'start', '40', '--title', 'Sem HML', '--stage', 'implementation']));
  ok(flow(r, ['pr', '40', 'ready', '--url', 'https://github.com/acme/widgets/pull/41']));
  ok(flow(r, ['pr', '40', 'merged']));
  invalid(flow(r, ['hml', '40', '--passed', '3']), /não usa a etapa "hml_validation"/);
  ok(flow(r, ['item', 'done', '40']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/40')).item;
    assert.strictEqual(item.project.organization.name, 'Pessoal', 'the registered project was used');
    assert.strictEqual(item.done_state, 'Committed', 'the page shows the tracker state the project declared, never "Done"');
    assert.deepStrictEqual((await get('/api/items')).items.map((i) => [i.key, i.stage, i.done_state]), [['widgets/40', 'done', 'Committed']]);
    assert.strictEqual(item.stage, 'done');
    assert.strictEqual(item.hml, null);
    assert.deepStrictEqual(item.stages.map((s) => [s.id, s.status]), [
      ['specification', 'done'], ['implementation', 'done'], ['final_adjustment', 'done'], ['pr_ready', 'done'], ['merge', 'done'], ['done', 'current'],
    ]);
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'pr-changed', 'pr-changed', 'item-done']);
  });
});

suite.test('a draft PR takes an item still in Specification to Implementation, but never takes an item back', async () => {
  const r = buildRoot('draft');
  ok(flow(r, ['item', 'start', '1', '--title', 'Em especificação']));
  ok(flow(r, ['pr', '1', 'draft', '--url', 'https://github.com/acme/widgets/pull/2']));
  ok(flow(r, ['item', 'start', '3', '--title', 'Já em PR pronto', '--stage', 'pr_ready']));
  ok(flow(r, ['pr', '3', 'draft', '--url', 'https://github.com/acme/widgets/pull/4', '--pr', '44']));
  await withServer(r, async (get) => {
    assert.strictEqual((await get('/api/items/widgets/1')).item.stage, 'implementation');
    const three = (await get('/api/items/widgets/3')).item;
    assert.strictEqual(three.stage, 'pr_ready');
    assert.strictEqual(three.pr.number, 44, '--pr wins over the number in the URL');
  });
});

suite.test('links only for the trackers\' domains; invalid data ends with exit code 2 and writes nothing', async () => {
  const r = buildRoot('invalid');
  ok(flow(r, ['item', 'start', '5', '--title', 'Válido', '--stage', 'implementation']));
  const cases = [
    [['pr', '5', 'draft', '--url', 'https://evil.example/acme/widgets/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'http://github.com/acme/widgets/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'javascript:alert(1)'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'https://github.com.evil.example/x/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'draft', '--url', 'https://user:pw@github.com/acme/widgets/pull/1'], /precisa ser https de um tracker/],
    [['pr', '5', 'ready'], /falta a URL do PR/],
    [['pr', '5'], /falta o estado do PR/],
    [['pr', '5', 'closed', '--url', GH_PR], /estado de PR inválido: "closed"/],
    [['pr', '5', 'draft', '--url', GH_PR, '--pr', 'x'], /número de PR inválido/],
    [['pr', '5', 'draft', '--url', GH_PR, '--branch', 'a b'], /nome de branch inválido/],
    [['pr', '6', 'draft', '--url', GH_PR], /ainda não foi iniciado/],
    [['final-adjustment', '5', 'result', '--outcome', 'passed'], /não tem ajuste final aberto/],
    [['final-adjustment', '5', 'close'], /ação de ajuste final inválida/],
    [['final-adjustment', '5', 'open', '--outcome', 'passed'], /não leva --outcome/],
    [['hml', '5'], /pelo menos um maior que 0/],
    [['hml', '5', '--passed', '-1'], /quantidade inválida em --passed/],
    [['hml', '5', '--passed', '1', '--card', 'https://trello.com/c/abc'], /--card precisa ser https de um tracker/],
    [['hml', '--json', '-'], /campo "summary" do JSON precisa ser texto/, JSON.stringify({ number: 5, passed: 1, summary: 3 })],
    [['item', 'done'], /falta o número do item/],
  ];
  for (const [args, message, input] of cases) invalid(flow(r, args, { input }), message);
  ok(flow(r, ['final-adjustment', '5', 'open']));
  invalid(flow(r, ['final-adjustment', '5', 'result', '--outcome', 'maybe']), /resultado do ajuste final inválido/);
  ok(flow(r, ['item', 'done', '5']));
  invalid(flow(r, ['item', 'done', '5']), /já está concluído/);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/5')).item;
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'final-adjustment-opened', 'item-done']);
    assert.strictEqual(item.pr, null);
  });
});

/** flow pending wait as a real process (polling every 50 ms); started() resolves once it says it is waiting. */
function startWait(r, id) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', FLOW_WAIT_INTERVAL_MS: '50' });
  const child = spawn(process.execPath, [FLOW, 'pending', 'wait', String(id)], { cwd: r.repo, env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  let onOut = () => {};
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s) => { stdout += s; onOut(); });
  child.stderr.on('data', (s) => { stderr += s; });
  child.stdin.end('');
  const timer = setTimeout(() => child.kill(), 30000);
  const done = new Promise((resolve) => child.on('close', (status) => {
    clearTimeout(timer);
    resolve({ status, stdout, stderr });
  }));
  const started = () => new Promise((resolve, reject) => {
    const check = () => { if (/^Esperando a pendência P-\d+/m.test(stdout)) resolve(); };
    onOut = check;
    check();
    done.then((x) => reject(new Error(`the wait ended before waiting: exit ${x.status}\n${x.stdout}\n${x.stderr}`)));
  });
  return { started, done };
}

function openedId(x) {
  ok(x);
  const m = /\bP-(\d+)\b/.exec(x.stdout);
  assert.ok(m, x.stdout);
  return Number(m[1]);
}

suite.test('item done cancels the item\'s open pending decisions ("item concluído pelo dono") and a waiting maestro wakes up', async () => {
  const r = buildRoot('done-pending');
  ok(flow(r, ['item', 'start', '12', '--title', 'Com pendências', '--stage', 'merge']));
  ok(flow(r, ['item', 'start', '13', '--title', 'Outro item', '--stage', 'merge']));
  const waited = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Seguir?']));
  const other = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Outra']));
  const resolved = openedId(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Já resolvida']));
  const elsewhere = openedId(flow(r, ['pending', 'open', '13', '--kind', 'decision', '--title', 'De outro item']));
  ok(flow(r, ['pending', 'resolve', String(resolved), '--decision', 'A']));
  const wait = startWait(r, waited);
  await wait.started();
  const x = flow(r, ['item', 'done', '12', '--agent', 'Maestro']);
  ok(x);
  assert.match(x.stdout, /2 pendência\(s\) aberta\(s\) cancelada\(s\)/);
  const w = await wait.done;
  assert.strictEqual(w.status, 0, w.stderr);
  assert.match(w.stdout, /fechou: cancelada\./);
  assert.match(w.stdout, /Motivo: item concluído pelo dono/);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/12')).item;
    const byId = new Map((await get('/api/pending-decisions')).pending_decisions.map((p) => [p.id, p]));
    for (const id of [waited, other]) {
      assert.deepStrictEqual([byId.get(id).status, byId.get(id).reason, byId.get(id).closed_by.role], ['canceled', 'item concluído pelo dono', 'maestro']);
    }
    assert.deepStrictEqual([byId.get(resolved).status, byId.get(resolved).reason], ['resolved', null], 'a closed one is left alone');
    assert.deepStrictEqual(item.timeline.slice(-3).map((e) => e.type), ['item-done', 'pending-decision-canceled', 'pending-decision-canceled']);
    assert.strictEqual(byId.get(elsewhere).status, 'open', 'another item\'s pending decisions stay open');
  });
});

suite.test('item done in a project without the Done stage takes the item out of the active list; a later stage brings it back', async () => {
  const r = buildRoot('no-done');
  ok(flow(r, ['org', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'widgets', '--name', 'Widgets', '--org', 'personal', '--stages', 'specification,implementation,pr_ready,merge']));
  ok(flow(r, ['item', 'start', '7', '--title', 'Sem Concluído', '--stage', 'merge']));
  ok(flow(r, ['item', 'start', '8', '--title', 'Ativo', '--stage', 'implementation']));
  ok(flow(r, ['item', 'done', '7']));
  invalid(flow(r, ['item', 'done', '7']), /já está concluído/);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/7')).item;
    assert.deepStrictEqual([item.stage, item.active, item.completed_at], ['merge', false, null], 'it stays on its stage, out of the active list');
    const done = item.timeline.find((e) => e.type === 'item-done');
    assert.strictEqual(item.concluded_at, done.at, 'concluded_at is when item-done was recorded (#67)');
    assert.deepStrictEqual((await get('/api/items?active=1')).items.map((i) => i.key), ['widgets/8']);
    assert.deepStrictEqual((await get('/api/items?active=0')).items.map((i) => [i.key, i.concluded_at]), [['widgets/7', done.at]], 'the list carries it too');
    assert.strictEqual((await get('/api/items/widgets/8')).item.concluded_at, null);
  });
  ok(flow(r, ['stage', '7', 'merge']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/7')).item;
    assert.deepStrictEqual([item.stage, item.active, item.concluded_at], ['merge', true, null], 'a later flow event brings it back, no longer concluded');
  });
});

suite.test('a flow event after item done brings the item back to the active list, on that event\'s stage', async () => {
  const r = buildRoot('back');
  ok(flow(r, ['item', 'start', '9', '--title', 'Volta', '--stage', 'implementation']));
  ok(flow(r, ['item', 'done', '9']));
  ok(flow(r, ['pr', '9', 'ready', '--url', 'https://github.com/acme/widgets/pull/90']));
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/9')).item;
    assert.deepStrictEqual([item.stage, item.active, item.completed_at], ['pr_ready', true, null]);
    assert.deepStrictEqual((await get('/api/items?active=1')).items.map((i) => i.key), ['widgets/9']);
  });
});

suite.test('item interrupt keeps the item on its stage, marked interrupted, out of the active list (#69)', async () => {
  const r = buildRoot('interrupt');
  ok(flow(r, ['item', 'start', '20', '--title', 'Parou no meio', '--stage', 'merge']));
  ok(flow(r, ['item', 'start', '21', '--title', 'Ativo', '--stage', 'implementation']));
  const x = flow(r, ['item', 'interrupt', '20', '--reason', 'O cliente desistiu da mudança', '--agent', 'Maestro']);
  ok(x);
  assert.match(x.stdout, /^Item widgets\/20 \(#20\) interrompido em Merge\. Ele sai da lista de ativos e continua consultável no painel\./);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/20')).item;
    assert.deepStrictEqual([item.stage, item.active, item.completed_at, item.concluded_at], ['merge', false, null, null], 'it stays on the stage where it stopped');
    assert.deepStrictEqual(item.stages.find((s) => s.status === 'current').id, 'merge');
    const last = item.timeline[item.timeline.length - 1];
    assert.deepStrictEqual(item.interrupted, { reason: 'O cliente desistiu da mudança', at: last.at, by: { role: 'maestro', name: 'Maestro' } });
    assert.deepStrictEqual([last.type, last.payload], ['item-interrupted', { reason: 'O cliente desistiu da mudança' }]);
    assert.strictEqual((await get('/api/items/widgets/21')).item.interrupted, null);
    assert.deepStrictEqual((await get('/api/items?active=1')).items.map((i) => i.key), ['widgets/21']);
    const inactive = (await get('/api/items?active=0')).items;
    assert.deepStrictEqual(inactive.map((i) => [i.key, i.stage, i.interrupted && i.interrupted.reason]), [['widgets/20', 'merge', 'O cliente desistiu da mudança']]);
  });
});

suite.test('item interrupt takes the reason as an option or by JSON; without one, or on an item already closed, it ends with exit code 2', async () => {
  const r = buildRoot('interrupt-invalid');
  ok(flow(r, ['item', 'start', '22', '--title', 'Válido', '--stage', 'implementation']));
  ok(flow(r, ['item', 'start', '23', '--title', 'Concluído', '--stage', 'implementation']));
  ok(flow(r, ['item', 'done', '23']));
  const cases = [
    [['item', 'interrupt', '22'], /falta o motivo da interrupção \(--reason/],
    [['item', 'interrupt', '22', '--reason', '   '], /falta o motivo da interrupção/],
    [['item', 'interrupt', '22', '--reason', 'x'.repeat(2001)], /o motivo tem 2001 caracteres; o máximo é 2000/],
    [['item', 'interrupt', '--reason', 'Sem número'], /falta o número do item/],
    [['item', 'interrupt', '24', '--reason', 'Nunca começou'], /ainda não foi iniciado/],
    [['item', 'interrupt', '23', '--reason', 'Tarde demais'], /o item widgets\/23 \(#23\) já está fora da lista de ativos \(concluído\)/],
    [['item', 'interrupt', '--json', '-'], /campo "reason" do JSON precisa ser texto/, JSON.stringify({ number: 22, reason: 5 })],
  ];
  for (const [args, message, input] of cases) invalid(flow(r, args, { input }), message);
  ok(flow(r, ['item', 'interrupt', '--json', '-'], { input: JSON.stringify({ number: 22, reason: 'Pelo JSON\ncom duas linhas', agent: 'Maestro' }) }));
  invalid(flow(r, ['item', 'interrupt', '22', '--reason', 'De novo']), /já está fora da lista de ativos \(interrompido\)/);
  invalid(flow(r, ['item', 'done', '22']), /já está fora da lista de ativos \(interrompido\)/);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/22')).item;
    assert.deepStrictEqual(item.timeline.map((e) => e.type), ['item-started', 'item-interrupted']);
    assert.strictEqual(item.interrupted.reason, 'Pelo JSON\ncom duas linhas');
    assert.deepStrictEqual((await get('/api/items/widgets/23')).item.timeline.map((e) => e.type), ['item-started', 'item-done']);
  });
});

suite.test('item interrupt cancels the item\'s open pending decisions ("item interrompido pelo dono") and a waiting maestro wakes up', async () => {
  const r = buildRoot('interrupt-pending');
  ok(flow(r, ['item', 'start', '25', '--title', 'Com pendências', '--stage', 'hml_validation']));
  ok(flow(r, ['item', 'start', '26', '--title', 'Outro item', '--stage', 'merge']));
  const waited = openedId(flow(r, ['pending', 'open', '25', '--kind', 'decision', '--title', 'Seguir?']));
  const resolved = openedId(flow(r, ['pending', 'open', '25', '--kind', 'decision', '--title', 'Já resolvida']));
  const elsewhere = openedId(flow(r, ['pending', 'open', '26', '--kind', 'decision', '--title', 'De outro item']));
  ok(flow(r, ['pending', 'resolve', String(resolved), '--decision', 'A']));
  ok(flow(r, ['hml', '25', '--passed', '1', '--failed', '1'])); // the derived HML pending decision, open
  const wait = startWait(r, waited);
  await wait.started();
  const x = flow(r, ['item', 'interrupt', '25', '--reason', 'Sem verba', '--role', 'owner']);
  ok(x);
  assert.match(x.stdout, /2 pendência\(s\) aberta\(s\) cancelada\(s\)/);
  const w = await wait.done;
  assert.strictEqual(w.status, 0, w.stderr);
  assert.match(w.stdout, /fechou: cancelada\./);
  assert.match(w.stdout, /Motivo: item interrompido pelo dono/);
  await withServer(r, async (get) => {
    const item = (await get('/api/items/widgets/25')).item;
    const all = (await get('/api/pending-decisions')).pending_decisions;
    const byId = new Map(all.map((p) => [p.id, p]));
    const derived = all.find((p) => p.kind === 'hml');
    for (const p of [byId.get(waited), derived]) {
      assert.deepStrictEqual([p.status, p.reason, p.closed_by.role], ['canceled', 'item interrompido pelo dono', 'owner']);
    }
    assert.deepStrictEqual([byId.get(resolved).status, byId.get(resolved).reason], ['resolved', null], 'a closed one is left alone');
    assert.strictEqual(byId.get(elsewhere).status, 'open', 'another item\'s pending decisions stay open');
    assert.deepStrictEqual(item.timeline.slice(-3).map((e) => e.type), ['item-interrupted', 'pending-decision-canceled', 'pending-decision-canceled']);
    assert.deepStrictEqual([item.stage, item.interrupted.by], ['hml_validation', { role: 'owner', name: null }]);
  });
});

suite.test('a flow event after item interrupt brings the item back to the active list and clears interrupted', async () => {
  const r = buildRoot('interrupt-back');
  ok(flow(r, ['item', 'start', '27', '--title', 'Volta pela etapa', '--stage', 'merge']));
  ok(flow(r, ['item', 'start', '28', '--title', 'Volta pelo PR', '--stage', 'implementation']));
  ok(flow(r, ['item', 'start', '29', '--title', 'Segue parado', '--stage', 'implementation']));
  for (const n of ['27', '28', '29']) ok(flow(r, ['item', 'interrupt', n, '--reason', 'Parado']));
  ok(flow(r, ['stage', '27', 'merge'])); // even to the stage where it stopped
  ok(flow(r, ['pr', '28', 'ready', '--url', 'https://github.com/acme/widgets/pull/91']));
  ok(flow(r, ['task', 'graph', '29', '--task', '30|Uma task'])); // not a flow event that sets a stage
  await withServer(r, async (get) => {
    const back = (await get('/api/items/widgets/27')).item;
    assert.deepStrictEqual([back.stage, back.active, back.interrupted], ['merge', true, null]);
    const pr = (await get('/api/items/widgets/28')).item;
    assert.deepStrictEqual([pr.stage, pr.active, pr.interrupted], ['pr_ready', true, null]);
    const still = (await get('/api/items/widgets/29')).item;
    assert.deepStrictEqual([still.active, still.interrupted.reason], [false, 'Parado']);
    assert.deepStrictEqual((await get('/api/items?active=1')).items.map((i) => i.key).sort(), ['widgets/27', 'widgets/28']);
  });
  ok(flow(r, ['item', 'interrupt', '27', '--reason', 'Parou de novo']));
  ok(flow(r, ['item', 'interrupt', '28', '--reason', 'Parou em PR pronto']));
  ok(flow(r, ['stage', '28', 'done'])); // a flow event to Done: done, out of the active list, no longer interrupted
  await withServer(r, async (get) => {
    const again = (await get('/api/items/widgets/27')).item;
    assert.deepStrictEqual([again.active, again.interrupted.reason], [false, 'Parou de novo']);
    const done = (await get('/api/items/widgets/28')).item;
    assert.deepStrictEqual([done.stage, done.active, done.interrupted], ['done', false, null]);
  });
});

suite.test('the active filter of the list only takes 1 or 0', async () => {
  const r = buildRoot('filter');
  ok(flow(r, ['item', 'start', '1', '--title', 'Ativo']));
  const port = await freePort();
  const s = await srv.start({ argv: ['--port', String(port)], env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') } });
  try {
    const bad = await request(port, '/api/items?active=talvez');
    assert.deepStrictEqual([bad.status, bad.json.error], [400, { code: 'invalid_param', param: 'active', value: 'talvez', expected: 'flag' }]);
    assert.strictEqual((await request(port, '/api/items?active=1')).json.items.length, 1);
    assert.strictEqual((await request(port, '/api/items?active=0')).json.items.length, 0);
  } finally {
    await s.stop();
  }
});

suite.test('help lists the new subcommands', () => {
  const r = buildRoot('help');
  const x = flow(r, ['--help']);
  ok(x);
  for (const re of [/pr <número> draft\|ready\|merged/, /final-adjustment <número> open/, /final-adjustment <número> result --outcome/, /hml <número> --passed/, /item done <número>/, /item interrupt <número> --reason "\.\.\."/]) {
    assert.ok(re.test(x.stdout), `${re}\n${x.stdout}`);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
