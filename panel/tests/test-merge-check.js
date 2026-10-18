'use strict';
// Tests for the merge check (#11, the exception of ADR 0001): from time to time the server reads the PR of the items
// whose PR is ready and not merged (GitHub through `gh pr view`, Azure DevOps through the REST API with the `az`
// token), read only, and records the merge with source "panel". Same seam as test-flow.js: the bin/flow.js CLI runs
// as a process in a temporary git repository → temporary maestro.db (MAESTRO_DIR) → the server's HTTP API.
// `gh` and `az` are fake scripts (PANEL_GH_CLI, PANEL_AZ_CLI) that answer from a JSON file and record their
// arguments; the Azure DevOps REST API is a fake local HTTP server (PANEL_AZURE_DEVOPS_URL). No test reads the
// database or calls internal functions.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, waitFor } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('merge check: gh / Azure DevOps → pr-changed merged (source panel) → items API');
const roots = [];

const GH = (n) => `https://github.com/acme/widgets/pull/${n}`;
const AZ_REMOTE = 'https://contoso@dev.azure.com/contoso/CIDAX/_git/cidax-api';
const AZ = (n) => `https://dev.azure.com/contoso/CIDAX/_git/cidax-api/pullrequest/${n}`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// Fake gh: answers by the PR URL from gh.json ({ "<url>": { exit, stdout, stderr } }) and appends its arguments
// to gh-calls.jsonl. Fake az: answers from az.json ({ exit, stdout, stderr }) and appends to az-calls.jsonl. An
// answer with "delay" (ms) takes that long; each call's [start, end] goes to <name>-times.jsonl.
const FAKE_CLI = `'use strict';
const fs = require('fs');
const path = require('path');
const name = path.basename(__filename, '.js');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, name + '-calls.jsonl'), JSON.stringify(args) + '\\n');
let answers = {};
try { answers = JSON.parse(fs.readFileSync(path.join(__dirname, name + '.json'), 'utf8')); } catch (_) { answers = {}; }
const a = (name === 'gh' ? answers[args[2]] : answers) || { exit: 9, stderr: 'no answer prepared' };
const start = Date.now();
if (a.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, a.delay);
fs.appendFileSync(path.join(__dirname, name + '-times.jsonl'), JSON.stringify([start, Date.now()]) + '\\n');
if (a.stdout) process.stdout.write(a.stdout);
if (a.stderr) process.stderr.write(a.stderr);
process.exitCode = a.exit || 0;
`;

/** Temporary root: data folder, a git repository with a fictitious origin and the fake gh and az. */
function buildRoot(name, remote = 'https://github.com/acme/widgets.git') {
  const root = tmpDir(`merge-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  const fakes = path.join(root, 'fakes');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(fakes, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(fakes, 'gh.js'), FAKE_CLI);
  fs.writeFileSync(path.join(fakes, 'az.js'), FAKE_CLI);
  return { root, data, repo, fakes };
}

const ghAnswers = (r, answers) => fs.writeFileSync(path.join(r.fakes, 'gh.json'), JSON.stringify(answers));
const azAnswer = (r, answer) => fs.writeFileSync(path.join(r.fakes, 'az.json'), JSON.stringify(answer));
const calls = (r, name) => {
  const f = path.join(r.fakes, `${name}-calls.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const merged = { exit: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-09T12:00:00Z' }) };
const open = { exit: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }) };

function flow(r, args) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '' });
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd: r.repo, env, input: '', encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: exit ${x.status}\n${x.stderr}`);
}

/** Starts the panel with the fakes; fn(api) where api.get(path) asserts 200 and api.port is the port. */
async function withServer(r, env, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: Object.assign({
      MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_MERGE_CHECK: '1', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'),
      PANEL_GH_CLI: path.join(r.fakes, 'gh.js'), PANEL_AZ_CLI: path.join(r.fakes, 'az.js'), PANEL_AZURE_DEVOPS_URL: 'http://127.0.0.1:1',
    }, env),
  });
  try {
    await fn({
      port,
      async get(p) {
        const x = await request(port, p);
        assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
        return x.json;
      },
    });
  } finally {
    await s.stop();
  }
}

const item = async (api, key) => (await api.get(`/api/items/${key}`)).item;
const until = (fn) => waitFor(fn, 10000, 50);

suite.test('GitHub: only items with a ready, unmerged PR are read; a confirmed merge becomes pr-changed merged (source panel) and moves the item to Merge', async () => {
  const r = buildRoot('gh');
  flow(r, ['item', 'start', '1', '--title', 'Pronto e mergeado', '--stage', 'implementation']);
  flow(r, ['pr', '1', 'ready', '--url', GH(101)]);
  flow(r, ['item', 'start', '2', '--title', 'Pronto e aberto', '--stage', 'implementation']);
  flow(r, ['pr', '2', 'ready', '--url', GH(102)]);
  flow(r, ['item', 'start', '3', '--title', 'Rascunho', '--stage', 'implementation']);
  flow(r, ['pr', '3', 'draft', '--url', GH(103)]);
  flow(r, ['item', 'start', '4', '--title', 'Já mergeado', '--stage', 'implementation']);
  flow(r, ['pr', '4', 'ready', '--url', GH(104)]);
  flow(r, ['pr', '4', 'merged']);
  flow(r, ['item', 'start', '5', '--title', 'Sem PR', '--stage', 'implementation']);
  ghAnswers(r, { [GH(101)]: merged, [GH(102)]: open, [GH(103)]: merged, [GH(104)]: merged });
  await withServer(r, {}, async (api) => {
    const one = await until(async () => { const x = await item(api, 'widgets/1'); return x.stage === 'merge' && x; });
    assert.strictEqual(one.pr.state, 'merged');
    const last = one.timeline[one.timeline.length - 1];
    assert.deepStrictEqual([last.type, last.payload, last.source], ['pr-changed', { state: 'merged' }, 'panel']);
    await until(async () => (await item(api, 'widgets/2')).merge_check.checked_at);
    const two = await item(api, 'widgets/2');
    assert.strictEqual(two.stage, 'pr_ready');
    assert.deepStrictEqual([two.merge_check.enabled, two.merge_check.error], [true, null]);
    assert.strictEqual((await item(api, 'widgets/3')).stage, 'implementation', 'a draft is not read');
    assert.strictEqual((await item(api, 'widgets/3')).merge_check, null);
    assert.strictEqual((await item(api, 'widgets/4')).timeline.length, 3, 'an already merged PR is not recorded again');
  });
  const read = calls(r, 'gh').map((a) => a.join(' ')).sort();
  assert.deepStrictEqual(read, [`pr view ${GH(101)} --json state,mergedAt`, `pr view ${GH(102)} --json state,mergedAt`]);
});

/** Fake Azure DevOps REST API: answers by PR id from answers ({ id: { status, body } }) and records each request. */
async function withAzure(answers, fn) {
  const port = await freePort();
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization || null });
    const m = /\/pullrequests\/(\d+)\?/.exec(req.url);
    const a = (m && answers[m[1]]) || { status: 404, body: { message: 'not found' } };
    res.writeHead(a.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  try {
    await fn({ url: `http://127.0.0.1:${port}`, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

suite.test('Azure DevOps: the PR is read through the REST API with the az token; completed → merged, active → stays', async () => {
  const r = buildRoot('azure', AZ_REMOTE);
  flow(r, ['item', 'start', '3100', '--title', 'Conciliação', '--stage', 'implementation']);
  flow(r, ['pr', '3100', 'ready', '--url', AZ(812)]);
  flow(r, ['item', 'start', '3101', '--title', 'Ainda em revisão', '--stage', 'implementation']);
  flow(r, ['pr', '3101', 'ready', '--url', AZ(813)]);
  azAnswer(r, { exit: 0, stdout: 'fake-token\r\n' });
  await withAzure({ 812: { status: 200, body: { pullRequestId: 812, status: 'completed' } }, 813: { status: 200, body: { pullRequestId: 813, status: 'active' } } }, async (azure) => {
    await withServer(r, { PANEL_AZURE_DEVOPS_URL: azure.url }, async (api) => {
      const merged = await until(async () => { const x = await item(api, 'cidax-api/3100'); return x.stage === 'merge' && x; });
      assert.deepStrictEqual([merged.pr.state, merged.timeline[merged.timeline.length - 1].source], ['merged', 'panel']);
      await until(async () => (await item(api, 'cidax-api/3101')).merge_check.checked_at);
      const open = await item(api, 'cidax-api/3101');
      assert.deepStrictEqual([open.stage, open.merge_check.error], ['pr_ready', null]);
    });
    assert.deepStrictEqual(azure.seen.map((s) => s.path).sort(), [
      '/contoso/CIDAX/_apis/git/repositories/cidax-api/pullrequests/812?api-version=7.1',
      '/contoso/CIDAX/_apis/git/repositories/cidax-api/pullrequests/813?api-version=7.1',
    ]);
    assert.ok(azure.seen.every((s) => s.authorization === 'Bearer fake-token'), JSON.stringify(azure.seen));
  });
  assert.deepStrictEqual(calls(r, 'az'), [['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--query', 'accessToken', '-o', 'tsv']],
    'one token per round');
  assert.deepStrictEqual(calls(r, 'gh'), []);
});

const healthReasons = async (api) => (await api.get('/api/state')).health.reasons.filter((x) => x.code === 'merge_check_failed');

suite.test('a failure becomes a code on the item page and in the health badge, without stopping the server; it clears when a later check works', async () => {
  const r = buildRoot('fail');
  flow(r, ['item', 'start', '7', '--title', 'gh falha', '--stage', 'implementation']);
  flow(r, ['pr', '7', 'ready', '--url', GH(107)]);
  flow(r, ['item', 'start', '8', '--title', 'gh responde lixo', '--stage', 'implementation']);
  flow(r, ['pr', '8', 'ready', '--url', GH(108)]);
  ghAnswers(r, { [GH(107)]: { exit: 1, stderr: 'HTTP 401: Bad credentials\nmore' }, [GH(108)]: { exit: 0, stdout: 'não é JSON' } });
  await withServer(r, { PANEL_MERGE_CHECK_SECONDS: '1' }, async (api) => {
    const seven = await until(async () => { const x = await item(api, 'widgets/7'); return x.merge_check.error && x; });
    assert.deepStrictEqual(seven.merge_check.error, { code: 'merge_check_cli_failed', tool: 'gh', exit: 1, detail: 'HTTP 401: Bad credentials' });
    assert.ok(seven.merge_check.checked_at);
    assert.strictEqual(seven.stage, 'pr_ready');
    await until(async () => (await item(api, 'widgets/8')).merge_check.error);
    assert.deepStrictEqual((await item(api, 'widgets/8')).merge_check.error, { code: 'merge_check_bad_answer', tool: 'gh' });
    const reasons = await healthReasons(api);
    assert.deepStrictEqual(reasons.map((x) => [x.item, x.tracker_ref, x.error.code]).sort(), [
      ['widgets/7', '#7', 'merge_check_cli_failed'], ['widgets/8', '#8', 'merge_check_bad_answer'],
    ]);
    assert.notStrictEqual((await api.get('/api/state')).health.level, 'green');
    // The tracker answers again: the next round clears the failure (and records the merge).
    ghAnswers(r, { [GH(107)]: open, [GH(108)]: merged });
    await until(async () => (await item(api, 'widgets/8')).stage === 'merge');
    await until(async () => (await item(api, 'widgets/7')).merge_check.error === null);
    assert.deepStrictEqual(await healthReasons(api), []);
  });
});

suite.test('a failed check leaves the health at once when the item is concluded or interrupted, without waiting for the next round (#67)', async () => {
  const r = buildRoot('fail-closed');
  for (const n of [7, 8, 9]) {
    flow(r, ['item', 'start', String(n), '--title', `falha ${n}`, '--stage', 'implementation']);
    flow(r, ['pr', String(n), 'ready', '--url', GH(100 + n)]);
  }
  const fail = { exit: 1, stderr: 'HTTP 401: Bad credentials' };
  ghAnswers(r, { [GH(107)]: fail, [GH(108)]: fail, [GH(109)]: fail });
  // One round only (the one at startup): whatever leaves the health afterwards is not a later round's pruning.
  await withServer(r, { PANEL_MERGE_CHECK_SECONDS: '3600' }, async (api) => {
    await until(async () => (await healthReasons(api)).length === 3);
    flow(r, ['item', 'done', '7']);
    flow(r, ['item', 'interrupt', '8', '--reason', 'Parou']);
    assert.deepStrictEqual((await healthReasons(api)).map((x) => x.item), ['widgets/9'], 'only the item still waiting for the merge');
  });
});

suite.test('failures of Azure DevOps and of the executables: az fails, REST answers 401, gh does not exist', async () => {
  const r = buildRoot('azure-fail', AZ_REMOTE);
  flow(r, ['item', 'start', '3200', '--title', 'Token', '--stage', 'implementation']);
  flow(r, ['pr', '3200', 'ready', '--url', AZ(900)]);
  azAnswer(r, { exit: 1, stderr: "Please run 'az login' to setup account." });
  await withServer(r, {}, async (api) => {
    const x = await until(async () => (await item(api, 'cidax-api/3200')).merge_check.error);
    assert.deepStrictEqual(x, { code: 'merge_check_cli_failed', tool: 'az', exit: 1, detail: "Please run 'az login' to setup account." });
    assert.deepStrictEqual((await healthReasons(api)).map((h) => h.tracker_ref), ['PBI 3200']);
  });
  azAnswer(r, { exit: 0, stdout: 'expired-token' });
  await withAzure({ 900: { status: 401, body: {} } }, async (azure) => {
    await withServer(r, { PANEL_AZURE_DEVOPS_URL: azure.url }, async (api) => {
      const x = await until(async () => (await item(api, 'cidax-api/3200')).merge_check.error);
      assert.deepStrictEqual(x, { code: 'merge_check_http_failed', status: 401 });
    });
  });
  const g = buildRoot('no-gh');
  flow(g, ['item', 'start', '9', '--title', 'Sem gh', '--stage', 'implementation']);
  flow(g, ['pr', '9', 'ready', '--url', GH(109)]);
  const missing = path.join(g.root, 'nao-existe', 'gh-inexistente');
  await withServer(g, { PANEL_GH_CLI: missing }, async (api) => {
    const x = await until(async () => (await item(api, 'widgets/9')).merge_check.error);
    assert.deepStrictEqual(x, { code: 'merge_check_cli_missing', tool: 'gh', cli: missing });
    assert.strictEqual((await request(api.port, '/api/items')).status, 200, 'the server keeps answering');
  });
});

suite.test('it can be turned off: PANEL_MERGE_CHECK=0, or by default when the collector is off; the item page says why; an invalid setting stops the start', async () => {
  const r = buildRoot('off');
  flow(r, ['item', 'start', '1', '--title', 'Pronto', '--stage', 'implementation']);
  flow(r, ['pr', '1', 'ready', '--url', GH(101)]);
  ghAnswers(r, { [GH(101)]: merged });
  await withServer(r, { PANEL_MERGE_CHECK: '0', PANEL_MERGE_CHECK_SECONDS: '1' }, async (api) => {
    await new Promise((x) => setTimeout(x, 1500));
    const one = await item(api, 'widgets/1');
    assert.deepStrictEqual([one.stage, one.merge_check], ['pr_ready', { enabled: false, reason: { code: 'merge_check_off', variable: 'PANEL_MERGE_CHECK' }, checked_at: null, error: null }]);
  });
  await withServer(r, { PANEL_MERGE_CHECK: undefined }, async (api) => {
    await new Promise((x) => setTimeout(x, 500));
    assert.deepStrictEqual((await item(api, 'widgets/1')).merge_check.reason, { code: 'merge_check_off', variable: 'PANEL_COLLECTOR' });
  });
  assert.deepStrictEqual(calls(r, 'gh'), [], 'gh was never called');
  for (const env of [{ PANEL_MERGE_CHECK: 'sim' }, { PANEL_MERGE_CHECK_SECONDS: '0' }, { PANEL_MERGE_CHECK_SECONDS: 'x' }]) {
    await assert.rejects(srv.start({ argv: ['--port', String(await freePort())], env: { MAESTRO_DIR: r.data, ...env } }), /PANEL_MERGE_CHECK/);
  }
});

suite.test('the PRs are read a few at a time (at most 4 at once), not one after the other', async () => {
  const r = buildRoot('parallel');
  const answers = {};
  for (let n = 1; n <= 8; n++) {
    flow(r, ['item', 'start', String(n), '--title', `Pronto ${n}`, '--stage', 'implementation']);
    flow(r, ['pr', String(n), 'ready', '--url', GH(100 + n)]);
    answers[GH(100 + n)] = { ...open, delay: 1200 };
  }
  ghAnswers(r, answers);
  const t0 = Date.now();
  await withServer(r, {}, async (api) => {
    await waitFor(async () => {
      const list = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => item(api, `widgets/${n}`)));
      return list.every((x) => x.merge_check.checked_at);
    }, 20000, 100);
  });
  const ms = Date.now() - t0;
  const times = fs.readFileSync(path.join(r.fakes, 'gh-times.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const most = Math.max(...times.map(([s]) => times.filter(([a, b]) => a <= s && s < b).length));
  assert.strictEqual(times.length, 8);
  assert.ok(most <= 4, `${most} reads at once`);
  assert.ok(most >= 2, 'reads overlap');
  assert.ok(ms < 8 * 1200, `8 reads of 1.2 s took ${ms} ms: one after the other`);
});

suite.test('stopping the server does not wait for a slow read of the tracker', async () => {
  const r = buildRoot('stop');
  flow(r, ['item', 'start', '1', '--title', 'Lento', '--stage', 'implementation']);
  flow(r, ['pr', '1', 'ready', '--url', GH(101)]);
  ghAnswers(r, { [GH(101)]: { ...open, delay: 20000 } });
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: {
      MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_MERGE_CHECK: '1', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'),
      PANEL_GH_CLI: path.join(r.fakes, 'gh.js'), PANEL_AZ_CLI: path.join(r.fakes, 'az.js'),
    },
  });
  await waitFor(() => calls(r, 'gh').length === 1, 10000, 50); // the read is running
  const t0 = Date.now();
  await s.stop();
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `stop waited ${ms} ms for the read`);
});

suite.test('"mark as merged": POST /api/items/<project>/<number>/merged records the same event (source panel, as the owner) under the POST safety rules', async () => {
  const r = buildRoot('button');
  flow(r, ['item', 'start', '12', '--title', 'Consulta falha', '--stage', 'implementation']);
  flow(r, ['pr', '12', 'ready', '--url', GH(112)]);
  flow(r, ['item', 'start', '13', '--title', 'Rascunho', '--stage', 'implementation']);
  flow(r, ['pr', '13', 'draft', '--url', GH(113)]);
  flow(r, ['item', 'start', '14', '--title', 'Sem PR', '--stage', 'implementation']);
  ghAnswers(r, { [GH(112)]: { exit: 1, stderr: 'rate limit' } });
  await withServer(r, {}, async (api) => {
    const post = (p, options = {}) => request(api.port, p, { method: 'POST', ...options, headers: { 'X-Panel': '1', ...options.headers } });
    const PATH = '/api/items/widgets/12/merged';
    await until(async () => (await item(api, 'widgets/12')).merge_check.error);
    // Refused by the safety rules: nothing is written.
    const noHeader = await request(api.port, PATH, { method: 'POST' });
    assert.deepStrictEqual([noHeader.status, noHeader.json.error.code], [403, 'missing_panel_header']);
    const foreign = await post(PATH, { headers: { Origin: 'http://evil.example' } });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const host = await post(PATH, { host: 'evil.example' });
    assert.deepStrictEqual([host.status, host.json.error.code], [403, 'host_not_allowed']);
    const get = await request(api.port, PATH);
    assert.deepStrictEqual([get.status, get.json.error.code, get.headers.allow], [405, 'method_not_allowed', 'POST']);
    assert.strictEqual((await item(api, 'widgets/12')).timeline.length, 2, 'refused requests write nothing');
    // Accepted, from the panel's own origin.
    const okay = await post(PATH, { headers: { Origin: `http://127.0.0.1:${api.port}` } });
    assert.strictEqual(okay.status, 200, okay.text);
    assert.deepStrictEqual([okay.json.item.stage, okay.json.item.pr.state, okay.json.item.merge_check], ['merge', 'merged', null]);
    const last = okay.json.item.timeline[okay.json.item.timeline.length - 1];
    assert.deepStrictEqual([last.type, last.payload, last.source, last.agent.role], ['pr-changed', { state: 'merged' }, 'panel', 'owner']);
    assert.deepStrictEqual(await healthReasons(api), [], 'the failure of the item is gone from the health badge');
    // Only an item with a ready PR can be marked.
    const again = await post(PATH);
    assert.deepStrictEqual([again.status, again.json.error], [409, { code: 'pr_not_ready', project: 'widgets', number: 12, state: 'merged' }]);
    const draft = await post('/api/items/widgets/13/merged');
    assert.deepStrictEqual([draft.status, draft.json.error.state], [409, 'draft']);
    const none = await post('/api/items/widgets/14/merged');
    assert.deepStrictEqual([none.status, none.json.error.state], [409, null]);
    const missing = await post('/api/items/widgets/99/merged');
    assert.deepStrictEqual([missing.status, missing.json.error], [404, { code: 'item_not_found', project: 'widgets', number: 99 }]);
    assert.strictEqual((await post('/api/items/nao-existe/1/merged')).status, 404);
    assert.strictEqual((await post('/api/items/Widgets!/1/merged')).status, 404);
    assert.strictEqual((await item(api, 'widgets/12')).timeline.length, 3, 'one event only');
  });
});

suite.test('"mark as merged" without maestro.db answers 404 and creates nothing', async () => {
  const r = buildRoot('no-db');
  await withServer(r, {}, async (api) => {
    const x = await request(api.port, '/api/items/widgets/1/merged', { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.deepStrictEqual([x.status, x.json.error.code], [404, 'item_not_found']);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')));
});

suite.test('the page translates the codes of the merge check (pt-BR dictionary)', async () => {
  const { pathToFileURL } = require('url');
  const { translateCode } = await import(pathToFileURL(path.join(REPO, 'panel', 'ui', 'src', 'i18n', 'index.js')).href);
  const c = translateCode;
  assert.strictEqual(c({ code: 'merge_check_failed', item: 'cidax-api/3100', tracker_ref: 'PBI 3100', error: { code: 'merge_check_http_failed', status: 401 } }),
    'Consulta do merge de PBI 3100 (cidax-api/3100) falhou: o Azure DevOps respondeu HTTP 401 (o token do az tem acesso? rode az login)');
  assert.strictEqual(c({ code: 'merge_check_cli_failed', tool: 'gh', exit: 1, detail: 'HTTP 401: Bad credentials' }), 'gh falhou (saída 1): HTTP 401: Bad credentials');
  assert.strictEqual(c({ code: 'merge_check_cli_missing', tool: 'az', cli: 'az' }), 'não achei o az (instalado e no PATH?)');
  assert.strictEqual(c({ code: 'merge_check_off', variable: 'PANEL_MERGE_CHECK' }), 'desligada (PANEL_MERGE_CHECK=0)');
  assert.strictEqual(c({ code: 'pr_not_ready', state: 'merged' }), 'O PR já está mergeado.');
  assert.strictEqual(c({ code: 'pr_not_ready', state: null }), 'O item não tem PR registrado.');
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
