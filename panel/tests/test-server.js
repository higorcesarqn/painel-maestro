'use strict';
// Tests for panel/server.js itself (the rules every route shares): startup and PID, the page, GET /api/state,
// POST /api/recalculate, security (Host, X-Panel, Origin, odd paths, methods), gzip, the data folder and the old
// routes that no longer exist. The routes of each part of the model have their own tests (test-flow*.js,
// test-organizations.js, test-log.js, test-overview.js, test-usage-agents.js, test-merge-check.js).
// Fake root under tests/tmp/, server on a port between 4790 and 4799.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const {
  assert, REPO, createSuite, tmpDir, remove, writeJson,
  freePort, request, rawRequest, waitFor, kill, pidAlive,
} = require('./util');

const SERVER = path.join(REPO, 'panel', 'server.js');
const srv = require(SERVER);

const NOW = '2026-10-08T15:50:00-03:00';
const INDEX = '<!doctype html><meta charset="utf-8"><title>Painel de teste</title><p>ok</p>';
const POST = { 'X-Panel': '1' };

const suite = createSuite('panel server (panel/server.js)');
const roots = [];

/** Fake root: an empty data folder (MAESTRO_DIR), the Maestri plan and a test page. */
function buildRoot(name) {
  const root = tmpDir(`server-${name}`);
  roots.push(root);
  const m = path.join(root, 'maestro');
  const maestri = path.join(root, 'maestri');
  const claude = path.join(root, 'claude');
  fs.mkdirSync(m, { recursive: true });
  writeJson(path.join(maestri, 'usage', 'providers', '.status.json'), {
    providers: [{ id: 'claude', enabled: true, state: 'ready', plan: 'max', lastSuccessAt: '2026-10-08T18:47:00Z', meters: [{ id: 'plan', windows: [
      { id: 'five_hour', usedPercent: 37, resetsAt: '2026-10-08T21:00:00Z', durationSeconds: 18000 },
      { id: 'seven_day', usedPercent: 22, resetsAt: '2026-10-13T12:00:00Z', durationSeconds: 604800 },
    ] }] }],
    updatedAt: '2026-10-08T18:47:00Z',
  });
  const index = path.join(root, 'index-test.html');
  fs.writeFileSync(index, INDEX);
  return { root, m, maestri, claude, index };
}

function environment(r, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.m, MAESTRI_DATA_DIR: r.maestri, CLAUDE_CONFIG_DIR: r.claude, PANEL_INDEX: r.index,
    PANEL_NOW: NOW, MAESTRO_NOW: '', PANEL_PORT: '', MAESTRI_TERMINAL_ID: '',
  }, extra);
}

/** Starts the server as a separate process and returns {port, pid, child, output}. */
async function start(r, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env: environment(r, extra), windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const line = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${err}`);
    const m = /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(out);
    return m ? m : null;
  }, 15000);
  return { port: Number(line[1]), pid: Number(line[2]), child, output: () => out, errors: () => err };
}

let R;
let S;

suite.test('starts on the requested port, prints the PID and writes state/panel.pid in MAESTRO_DIR; the collector runs on startup', async () => {
  R = buildRoot('main');
  S = await start(R);
  assert.ok(S.port >= 4790 && S.port <= 4799);
  assert.strictEqual(S.pid, S.child.pid, 'the printed PID must be the node process');
  const pidFile = fs.readFileSync(path.join(R.m, 'state', 'panel.pid'), 'utf8').trim();
  assert.strictEqual(Number(pidFile), S.pid);
  await waitFor(() => fs.existsSync(path.join(R.m, 'state', 'usage.json')), 10000);
});

suite.test('GET / returns index.html with no-store, CSP and no CORS; HEAD without body', async () => {
  const r = await request(S.port, '/', { headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, INDEX);
  assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.ok(String(r.headers['content-security-policy']).includes("default-src 'none'"));
  // Anti-clickjacking: no outside page can embed the panel in an iframe.
  assert.ok(String(r.headers['content-security-policy']).includes("frame-ancestors 'none'"));
  assert.strictEqual(r.headers['x-frame-options'], 'DENY');
  for (const p of ['/api/state', '/does-not-exist']) assert.strictEqual((await request(S.port, p)).headers['x-frame-options'], 'DENY', p);
  assert.strictEqual((await request(S.port, '/', { host: 'evil.example' })).headers['x-frame-options'], 'DENY');
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')), 'no CORS header');
  const h = await request(S.port, '/', { method: 'HEAD' });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.buf.length, 0);
});

suite.test('GET /api/state: health, the menu counter, the plan usage and the collector (nothing of the old model)', async () => {
  await waitFor(async () => (await request(S.port, '/api/state')).json.collector.last, 10000);
  const r = await request(S.port, '/api/state');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')));
  const e = r.json;
  assert.deepStrictEqual(Object.keys(e).sort(), ['collector', 'generated_at', 'health', 'kpis', 'version', 'warnings']);
  assert.deepStrictEqual(Object.keys(e.kpis).sort(), ['pending_decisions', 'usage']);
  assert.deepStrictEqual(Object.keys(e.health).sort(), ['last_event_at', 'last_raw_at', 'level', 'reasons', 'usage_age_min']);
  assert.strictEqual(e.generated_at, NOW);
  assert.deepStrictEqual([e.health.level, e.health.reasons, e.health.last_event_at, e.health.last_raw_at, e.health.usage_age_min], ['green', [], null, null, 3]);
  assert.deepStrictEqual(e.kpis.pending_decisions, { total: 0, by_severity: { critical: 0, high: 0, normal: 0, low: 0 } });
  const u = e.kpis.usage;
  assert.deepStrictEqual(
    [u.available, u.window_5h_pct, u.reset_5h, u.weekly_pct, u.weekly_reset, u.age_min],
    [true, 37, '2026-10-08T18:00:00-03:00', 22, '2026-10-13T09:00:00-03:00', 3],
  );
  assert.deepStrictEqual(u.source, { code: 'maestri_claude_provider' });
  assert.deepStrictEqual([e.collector.interval_min, e.collector.active, e.collector.last.trigger, e.collector.last.ok], [5, true, 'startup', true]);
  assert.deepStrictEqual(e.warnings, []);
});

suite.test('no response carries a Portuguese sentence: every reason, warning and error is a code', async () => {
  const bodies = [
    (await request(S.port, '/api/state')).json,
    (await request(S.port, '/api/items?active=lixo')).json,
    (await request(S.port, '/api/recalculate', { method: 'POST' })).json,
    (await request(S.port, '/api/recalculate', { method: 'POST', headers: POST })).json,
    (await request(S.port, '/api/nope')).json,
  ];
  const walk = (v, where) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/^(reason|reasons|warnings|error|note|formula|source|basis)$/.test(k) && typeof x === 'string') assert.fail(`${where}.${k} is a sentence: ${x}`);
        walk(x, `${where}.${k}`);
      }
    }
  };
  bodies.forEach((b, i) => walk(b, `body${i}`));
});

suite.test('the old model, Trello, Prospecção and the Brain no longer exist: their routes give 404', async () => {
  for (const c of ['/api/events', '/api/event/EV-20261008-141000-0004', '/api/flow/F-20261008-0002', '/api/estado', '/api/eventos',
    '/api/evento/EV-1', '/api/fluxo/F-1', '/prospeccao', '/api/prospeccao/estado', '/api/trello']) {
    const r = await request(S.port, c);
    assert.deepStrictEqual([c, r.status, r.json], [c, 404, { error: { code: 'route_not_found' } }]);
  }
  for (const c of ['/api/brain', '/api/cerebro', '/api/recalcular', '/api/prospeccao/assumir']) {
    const r = await request(S.port, c, { method: 'POST', headers: POST, body: '{}' });
    assert.strictEqual(r.status, 404, `POST ${c} should be 404 (got ${r.status})`);
  }
});

suite.test('POST /api/recalculate requires X-Panel and the panel\'s own Origin; with them, runs the collector and returns the state', async () => {
  const without = await request(S.port, '/api/recalculate', { method: 'POST' });
  assert.strictEqual(without.status, 403);
  assert.deepStrictEqual(without.json, { error: { code: 'missing_panel_header', header: 'X-Panel' } });
  assert.strictEqual((await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '0' } })).status, 403);
  assert.strictEqual((await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Painel': '1' } })).status, 403, 'the old Portuguese header no longer works');
  const outside = await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1', Origin: 'http://evil.example' } });
  assert.deepStrictEqual([outside.status, outside.json], [403, { error: { code: 'origin_not_allowed' } }]);
  const ok = await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1', Origin: `http://127.0.0.1:${S.port}` }, body: '{}' });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.deepStrictEqual(ok.json.recalculation, { ok: true, duration_ms: ok.json.recalculation.duration_ms, error: null });
  assert.strictEqual(ok.json.generated_at, NOW);
  assert.ok(ok.json.kpis && ok.json.health);
  assert.strictEqual(ok.json.collector.last.trigger, 'recalculate');
});

suite.test('forged Host → 403 (including variations); localhost and upper case accepted', async () => {
  const p = S.port;
  for (const host of ['evil.example', `evil.example:${p}`, `127.0.0.1:${p}.`, `127.0.0.1.:${p}`, '127.0.0.1', 'localhost', `127.0.0.1:4777`, `[::1]:${p}`, `0.0.0.0:${p}`, `127.0.0.2:${p}`, `localhost.:${p}`, `127.0.0.1:${p}@evil`, ` 127.0.0.1:${p}x`]) {
    const r = await request(p, '/api/state', { host });
    assert.strictEqual(r.status, 403, `Host "${host}" should be 403`);
    assert.ok(!r.text.includes('"kpis"'));
  }
  assert.deepStrictEqual((await request(p, '/api/state', { host: 'evil.example' })).json, { error: { code: 'host_not_allowed', port: p } });
  // Empty, missing (HTTP/1.0 and 1.1) or duplicated Host: refused (Node's 400 or the panel's 403), never 200.
  for (const raw of [
    'GET /api/state HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n',
    'GET /api/state HTTP/1.1\r\nConnection: close\r\n\r\n',
    'GET /api/state HTTP/1.0\r\n\r\n',
    `GET /api/state HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    `GET http://evil.example/api/state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
  ]) {
    const r = await rawRequest(p, raw);
    assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(raw)} → ${r.status}`);
    assert.ok(!r.text.includes('"kpis"'));
  }
  const absolute = await rawRequest(p, `GET http://127.0.0.1:${p}/api/state HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`);
  assert.strictEqual(absolute.status, 404, 'an absolute URL is not a route');
  assert.strictEqual((await request(p, '/', { host: 'evil.example' })).status, 403);
  assert.strictEqual((await request(p, '/api/recalculate', { method: 'POST', host: 'evil.example', headers: POST })).status, 403);
  assert.strictEqual((await request(p, '/api/state', { host: `localhost:${p}` })).status, 200);
  assert.strictEqual((await request(p, '/api/state', { host: `LOCALHOST:${p}` })).status, 200);
});

suite.test('odd paths → 404; wrong methods → 405; no file served', async () => {
  const p = S.port;
  for (const c of ['/index.html', '/server.js', '/README.md', '/tests/mock-items.json', '/../maestro.db', '/%2e%2e/maestro.db',
    '/..%2f..%2fmaestro.db', '//etc/passwd', '/api', '/api/', '/api/state/', '/api/state/x', '/api/items/..%2f..%2fmaestro.db/1',
    '/api/log/%2e%2e', '/api/items/a/b/c', '/api/log/%E0%A4%A', '/API/STATE', '/state/panel.pid', '/favicon.ico']) {
    const r = await request(p, c);
    assert.strictEqual(r.status, 404, `${c} should be 404 (got ${r.status})`);
  }
  assert.deepStrictEqual((await request(p, '/api')).json, { error: { code: 'route_not_found' } });
  const put = await request(p, '/api/state', { method: 'PUT' });
  assert.strictEqual(put.status, 405);
  assert.strictEqual(put.headers.allow, 'GET, HEAD');
  assert.deepStrictEqual(put.json, { error: { code: 'method_not_allowed', method: 'PUT', allowed: ['GET', 'HEAD'] } });
  const opt = await request(p, '/api/state', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.strictEqual(opt.status, 405);
  assert.ok(!Object.keys(opt.headers).some((h) => h.startsWith('access-control-')));
  assert.strictEqual((await request(p, '/api/recalculate')).status, 405);
  assert.strictEqual((await request(p, '/api/state', { method: 'POST', headers: POST })).status, 405);
});

suite.test('gzip when the client accepts it and the answer is big; the body is still the same', async () => {
  const big = `${INDEX}${'<p>linha</p>'.repeat(1000)}`;
  fs.writeFileSync(R.index, big);
  const r = await request(S.port, '/', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-encoding'], 'gzip');
  assert.strictEqual(zlib.gunzipSync(r.buf).toString('utf8'), big);
  const plain = await request(S.port, '/api/state', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.ok(!plain.headers['content-encoding'], 'small answers go as they are');
});

suite.test('an unreadable usage.json becomes a read warning and the plan says why, not an error', async () => {
  fs.writeFileSync(path.join(R.m, 'state', 'usage.json'), '{"plan": ');
  const e = (await request(S.port, '/api/state')).json;
  assert.strictEqual(e.kpis.usage.available, false);
  assert.deepStrictEqual([e.kpis.usage.reason.code, e.kpis.usage.reason.file], ['usage_unreadable', 'state/usage.json']);
  assert.deepStrictEqual(e.warnings.map((w) => [w.code, w.file, w.error.code]), [['file_unreadable', 'state/usage.json', 'invalid_json']]);
  assert.strictEqual(e.health.level, 'green');
});

suite.test('killing by the printed PID frees the port', async () => {
  kill(S.pid);
  await waitFor(() => !pidAlive(S.pid), 10000);
  await assert.rejects(request(S.port, '/api/state'));
  S = null;
});

suite.test('without MAESTRO_DIR the data lives in ~/.painel-maestro, never inside the repository', async () => {
  const root = tmpDir('server-home');
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const r = { m: '', maestri: path.join(root, 'maestri'), claude: path.join(root, 'claude'), index: path.join(root, 'x.html') };
  const s = await start(r, { MAESTRO_DIR: '', USERPROFILE: home, HOME: home, PANEL_COLLECTOR: '0' });
  try {
    const data = path.join(home, '.painel-maestro');
    assert.strictEqual(Number(fs.readFileSync(path.join(data, 'state', 'panel.pid'), 'utf8')), s.pid);
    assert.ok(s.output().includes(`Dados: ${data.replace(/\\/g, '/')}`), s.output());
    assert.strictEqual((await request(s.port, '/api/state')).status, 200);
  } finally {
    kill(s.pid);
  }
});

suite.test('empty root: everything missing becomes null/zero with clear reason codes; collector unavailable', async () => {
  const root = tmpDir('server-empty');
  roots.push(root);
  const r = { m: path.join(root, 'maestro'), maestri: path.join(root, 'maestri'), claude: path.join(root, 'claude'), index: path.join(root, 'does-not-exist.html') };
  const s = await start(r, { PANEL_COLLECTOR: '0', PAINEL_TRELLO_JANELA: 'lixo' });
  try {
    const idx = await request(s.port, '/');
    assert.strictEqual(idx.status, 503);
    assert.ok(idx.text.includes('não foi encontrado'));
    const e = (await request(s.port, '/api/state')).json;
    assert.strictEqual(e.kpis.usage.available, false);
    assert.deepStrictEqual(e.kpis.usage.reason, { code: 'collector_not_run' });
    assert.deepStrictEqual(e.kpis.pending_decisions.total, 0);
    assert.deepStrictEqual([e.health.level, e.health.reasons, e.health.last_event_at], ['green', [], null]);
    assert.deepStrictEqual(e.collector, { interval_min: 5, active: false, last: null, running: false });
    assert.ok(!fs.existsSync(path.join(r.m, 'maestro.db')), 'reading creates no database');
    // Without the Maestri file, recalculating writes a usage.json with the plan unavailable.
    const rc = await request(s.port, '/api/recalculate', { method: 'POST', headers: POST });
    assert.strictEqual(rc.status, 200);
    assert.strictEqual(rc.json.kpis.usage.available, false);
    assert.strictEqual(rc.json.kpis.usage.reason.code, 'plan_file_missing');
    assert.ok(rc.json.kpis.usage.reason.file.endsWith('.status.json'));
  } finally {
    kill(s.pid);
  }
});

suite.test('port in use: clear message and exit 1; invalid port: exit 2', async () => {
  const root = tmpDir('server-port');
  roots.push(root);
  const r = { m: path.join(root, 'maestro'), maestri: path.join(root, 'maestri'), claude: path.join(root, 'claude'), index: path.join(root, 'x.html') };
  const s = await start(r, { PANEL_COLLECTOR: '0' });
  try {
    const dup = spawnSync(process.execPath, [SERVER, '--port', String(s.port)], { env: environment(r, { PANEL_COLLECTOR: '0' }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(dup.status, 1);
    assert.ok(dup.stderr.includes('já está em uso'), dup.stderr);
    const bad = spawnSync(process.execPath, [SERVER, '--port', 'abc'], { env: environment(r), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(bad.status, 2);
    assert.ok(bad.stderr.includes('Porta inválida'));
    const envPort = spawnSync(process.execPath, [SERVER], { env: environment(r, { PANEL_PORT: 'xyz' }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(envPort.status, 2, 'PANEL_PORT is read');
  } finally {
    kill(s.pid);
  }
});

suite.test('in process: start() writes the PID and stop() deletes it; Host checked against the real port', async () => {
  const root = tmpDir('server-inproc');
  roots.push(root);
  const m = path.join(root, 'maestro');
  const port = await freePort();
  const env = { MAESTRO_DIR: m, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(root, 'x.html'), MAESTRI_DATA_DIR: path.join(root, 'maestri') };
  const s = await srv.start({ argv: ['--port', String(port)], env });
  const pidFile = path.join(m, 'state', 'panel.pid');
  try {
    assert.strictEqual(Number(fs.readFileSync(pidFile, 'utf8')), process.pid);
    assert.strictEqual((await request(port, '/api/state')).status, 200);
    assert.strictEqual((await request(port, '/api/state', { host: `127.0.0.1:${port + 1}` })).status, 403);
  } finally {
    await s.stop();
  }
  assert.ok(!fs.existsSync(pidFile), 'stop() must delete state/panel.pid');
});

suite.run().then(() => {
  if (S) kill(S.pid);
  if (!process.env.KEEP_TMP) for (const r of roots) remove(r);
});
