'use strict';
// Tests for index.html (frontend) without a browser. The page is the panel/ui Preact app compiled into a single
// file (npm run build); the code rules apply to the SOURCE (ui/src), and the single-file rules to the build:
//   1. single-file rules: nothing external (the font is embedded), valid script;
//   2. no HTML built from text, in the source; no outside links;
//   3. the build compiles and only calls the contract routes;
//   4. the mock (?mock=1) follows the /api/state contract and has the requested numbers;
//   5. the real server.js, on a fake root built from the mock (with hostile data), delivers everything the
//      page reads (fields, filters, modal, flow) and serves index.html with a CSP.
// Test server on a port from 4790 to 4799, killed by the PID it prints.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const { assert, createSuite, TMP, freePort, request, waitFor, kill, remove } = require('./util');

const PANEL = path.resolve(__dirname, '..');
const INDEX = path.join(PANEL, 'index.html');
const SERVER = path.join(PANEL, 'server.js');
const SOURCE = path.join(PANEL, 'ui', 'src');
const html = fs.readFileSync(INDEX, 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const js = scripts.map((m) => m[2]).join('\n');
const suite = createSuite('index.html (frontend)');

/** .js/.jsx files of the app source: { relative path: text }. */
function readSource(dir = SOURCE, base = SOURCE, acc = {}) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) readSource(p, base, acc);
    else if (/\.(js|jsx)$/.test(n.name)) acc[path.relative(base, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
  }
  return acc;
}
const source = readSource();
const allSource = Object.values(source).join('\n');

// Fields of an event in the API (legacy-records.js): the mock does not make up others.
const API_EVENT_FIELDS = new Set(Object.values(require('../legacy-records.js').EVENT_FIELDS));

// XML namespace identifiers Preact uses in createElementNS: never downloaded.
const NAMESPACES = /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml|1998\/Math\/MathML|1999\/xlink|XML\/1998\/namespace)$/;

suite.test('single file: no external script, stylesheet, font or image', () => {
  assert.strictEqual(scripts.length, 1, 'a single embedded <script>');
  assert.ok(!/\bsrc\s*=/.test(scripts[0][1]), 'the <script> has no src');
  assert.ok(!/<link\b(?![^>]*rel="icon"[^>]*href="data:,")[^>]*>/i.test(html), 'no <link> besides the empty icon');
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(html), 'no @import nor external url() in the CSS');
  for (const m of html.matchAll(/url\(\s*['"]?([^'")\s]{0,12})/g)) assert.ok(/^data:/.test(m[1]), `url() only with data: (found ${m[1]})`);
  assert.ok(/@font-face/.test(html) && /Manrope/.test(html), 'the Manrope font is embedded');
  assert.ok(!/<(img|iframe|object|embed|video|audio)\b/i.test(html), 'no external media');
  const urls = (html.match(/https?:\/\/[^\s"'`)<\\]+/g) || []).filter((u) => !NAMESPACES.test(u) && !/^http:\/\/127\.0\.0\.1:4795\//.test(u));
  assert.deepStrictEqual(urls, [], `unexpected URLs: ${urls.join(' ')}`);
  assert.ok(!/fetch\(\s*['"`]https?:/.test(js), 'fetch only to the server itself');
});

suite.test('API text enters as text: no innerHTML, eval or handlers built from strings', () => {
  const forbidden = [/innerHTML/, /dangerouslySetInnerHTML/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/,
    /new\s+Function\s*\(/, /setAttribute\(\s*['"]on/, /createContextualFragment/, /DOMParser/, /\.srcdoc\b/];
  for (const [file, text] of Object.entries(source)) {
    for (const p of forbidden) assert.ok(!p.test(text), `forbidden use in ui/src/${file}: ${p}`);
  }
  // In the build, the only possible innerHTML is Preact's own dangerouslySetInnerHTML, which the source never uses.
  for (const p of forbidden.slice(2)) assert.ok(!p.test(js), `forbidden use in the build: ${p}`);
  // No outside link: neither an href built from data, nor a fixed href (only # anchors).
  const hrefs = [...allSource.matchAll(/\bhref=\{([^}]+)\}/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(hrefs, [], 'no href built from data');
  assert.ok(!/\bhref="(?!#)/.test(allSource), 'no fixed outside href');
});

suite.test('the embedded script compiles and only uses the contract routes', () => {
  new vm.Script(js, { filename: 'index.html#script' });
  const api = source['dados/api.js'];
  for (const route of ["api('/api/state')", '`/api/events?', '`/api/event/${encodeURIComponent(id)}`', "api('/api/recalculate', { method: 'POST' })",
    'api(`/api/pending-decisions/${encodeURIComponent(p.id)}/answer`']) {
    assert.ok(api.includes(route), `the page calls ${route}`);
  }
  for (const route of ['/api/state', '/api/events?', '/api/event/', '/api/recalculate', '/api/pending-decisions/']) {
    assert.ok(js.includes(route), `the build calls ${route}`);
  }
  const allowed = /^\/api\/(state|events|event\/|flow\/|recalculate|brain|pending-decisions\/)$/;
  for (const m of js.matchAll(/\/api\/[a-z_/-]*/g)) assert.ok(allowed.test(m[0]), `route outside the contract in the build: ${m[0]}`);
  assert.ok(/'X-Panel': '1'/.test(api), 'POST carries X-Panel: 1');
  assert.ok(/export const INTERVALO_MS = 20000;/.test(api), 'refreshes every 20 s');
  assert.ok(/export const POR_PAGINA = 50;/.test(api), 'pages of 50');
  assert.ok(/timeZone: TZ/.test(source['dados/formato.js']) && /export const TZ = 'America\/Sao_Paulo'/.test(source['dados/formato.js']), 'dates in America/Sao_Paulo');
  assert.ok(/<meta name="color-scheme" content="dark">/.test(html), 'the brand dark theme');
  assert.ok(/<html lang="pt-BR">/.test(html));
});

suite.test('mock-state.json follows the contract and has the requested scenario', () => {
  const e = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-state.json'), 'utf8'));
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-details.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(e).sort(), ['agents', 'events', 'generated_at', 'health', 'kpis', 'pending_decisions', 'usage', 'workspace']);
  assert.deepStrictEqual(Object.keys(e.health).sort(), ['hooks', 'last_event_age_min', 'level', 'reasons', 'usage_age_min', 'wire']);
  assert.deepStrictEqual(Object.keys(e.kpis).sort(), ['pending_decisions', 'usage']);
  assert.strictEqual(e.agents.length, 2);
  assert.strictEqual(e.pending_decisions.length, 6);
  assert.strictEqual(new Set(e.pending_decisions.map((p) => p.severity)).size, 4, 'the 4 severities');
  assert.ok(e.events.length >= 38 && e.events.length <= 45, `~40 events (${e.events.length})`);
  assert.strictEqual(new Set(e.events.map((x) => x.ts.slice(0, 10))).size, 2, '2 days');
  assert.strictEqual(new Set(e.events.map((x) => x.flow_id)).size, 2, '2 flows');
  assert.strictEqual(e.kpis.usage.window_5h_pct, 37);
  assert.strictEqual(e.kpis.usage.weekly_pct, 22);
  for (const ev of e.events) assert.ok(d.events.some((x) => x.id === ev.id), `detail of ${ev.id}`);
  for (const ev of d.events) assert.deepStrictEqual(Object.keys(ev).filter((k) => !API_EVENT_FIELDS.has(k)), [], `fields outside the event in ${ev.id}`);
  for (let i = 1; i < e.events.length; i++) assert.ok(Date.parse(e.events[i - 1].ts) >= Date.parse(e.events[i].ts), 'most recent first');
  // No sentence from the server: reasons and sources are codes.
  assert.ok(e.health.reasons.every((r) => typeof r.code === 'string'));
  assert.strictEqual(e.usage.plan.source.code, 'maestri_claude_provider');
});

let port = null;
let pid = null;
let root = null;

suite.test('the real server on a fake root (mock + hostile data) delivers what the page reads', async () => {
  root = path.join(TMP, `index-${process.pid}`);
  const build = spawnSync(process.execPath, [path.join(__dirname, 'build-mock-root.js'), path.join(root, 'm'), '--hostile'], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(build.status, 0, build.stderr);
  fs.mkdirSync(path.join(root, 'maestri'), { recursive: true });
  fs.mkdirSync(path.join(root, 'claude'), { recursive: true });
  const mockState = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-state.json'), 'utf8'));
  const p = await freePort();
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: path.join(root, 'm'), MAESTRI_DATA_DIR: path.join(root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    PANEL_NOW: mockState.generated_at, MAESTRO_NOW: '', PANEL_COLLECTOR: '0', PANEL_PORT: '', PANEL_INDEX: '',
  });
  const child = spawn(process.execPath, [SERVER, '--port', String(p)], { env, windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const m = await waitFor(() => /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(out), 15000);
  port = Number(m[1]);
  pid = Number(m[2]);

  const idx = await request(port, '/');
  assert.strictEqual(idx.status, 200);
  assert.strictEqual(idx.text, html, 'serves this index.html');
  assert.ok(/default-src 'none'/.test(idx.headers['content-security-policy'] || ''), 'CSP');
  assert.strictEqual(idx.headers['cache-control'], 'no-store');

  const st = (await request(port, '/api/state')).json;
  assert.ok(st && st.kpis && st.kpis.pending_decisions.total === 5, 'open pending decisions (4 of the mock + 1 hostile)');
  assert.strictEqual(st.pending_decisions[0].severity, 'critica', 'open ones first, by severity');
  assert.ok(st.pending_decisions.some((x) => x.id === 'P-0099'), 'the hostile pending decision is in the list');
  for (const a of st.agents) {
    for (const k of ['slug', 'name', 'color', 'responsibility', 'status', 'model', 'effort', 'skills', 'connected_to', 'events_today', 'open_flows', 'last_raw', 'usage']) assert.ok(k in a, `agent.${k}`);
    assert.ok(a.last_event && a.last_event.id, 'last_event.id to open the modal');
  }
  const ev0 = st.events[0];
  for (const k of ['id', 'ts', 'agent', 'project', 'summary', 'direction', 'result', 'type', 'flow_id', 'needs_owner']) assert.ok(k in ev0, `event.${k}`);

  // filters the page builds
  const q = (s) => request(port, `/api/events?${s}`).then((r) => r.json);
  const all = await q('page=1&per_page=50');
  assert.strictEqual(all.per_page, 50);
  assert.ok(all.events.every((e) => !e.test), 'tests hidden by default');
  const withTests = await q('include_tests=1&per_page=50');
  assert.ok(withTests.total > all.total, 'the "Mostrar testes" filter brings the test ones');
  const fl = await q('flow=F-20261008-0001&per_page=50');
  assert.ok(fl.total > 0 && fl.events.every((e) => e.flow_id === 'F-20261008-0001'), 'flow filter (click in the modal)');
  const owner = await q('owner_only=1');
  assert.ok(owner.events.every((e) => e.needs_owner || ['falhou', 'bloqueado', 'aguardando-dono'].includes(e.result)));
  const search = await q('q=LEITURA%20dependencias&agent=coordenador');
  assert.ok(search.total > 0 && search.events.every((e) => e.agent === 'coordenador'));
  const day = await q('since=2026-10-09&until=2026-10-09');
  assert.ok(day.events.every((e) => e.ts.startsWith('2026-10-09')));

  // modal
  const det = (await request(port, `/api/event/${encodeURIComponent('EV-20261009-102400-beef')}`)).json;
  assert.ok(det.event && det.event.summary.includes('<script>'), 'the hostile text arrives raw; the page shows it as text');
  assert.ok(Array.isArray(det.sequence) && det.sequence.some((s) => s.id === det.event.id), 'sequence with the current one');
  assert.ok(Array.isArray(det.raw_commands) && det.raw_commands.length > 0, 'correlated raw commands');
  assert.ok(det.initial_request && det.initial_request.text, 'initial request');
  assert.ok('previous_id' in det && 'next_id' in det);
  const none = await request(port, '/api/event/EV-nao-existe');
  assert.strictEqual(none.status, 404);
  assert.strictEqual(none.json.error.code, 'event_not_found');

  // header buttons
  const noHeader = await request(port, '/api/recalculate', { method: 'POST' });
  assert.strictEqual(noHeader.status, 403);
  const rec = await request(port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1' } });
  assert.strictEqual(rec.status, 200);
  assert.ok(rec.json && rec.json.generated_at && rec.json.kpis);
  const brain = await request(port, '/api/brain', { method: 'POST', headers: { 'X-Panel': '1' } });
  assert.strictEqual(brain.status, 501);
});

(async () => {
  try {
    await suite.run();
  } finally {
    kill(pid);
    if (root && !process.env.KEEP_TMP) remove(root);
  }
})();
