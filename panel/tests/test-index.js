'use strict';
// Tests for index.html (frontend) without a browser. The page is the panel/ui Preact app compiled into a single
// file (npm run build); the code rules apply to the SOURCE (ui/src), and the single-file rules to the build:
//   1. single-file rules: nothing external (the font is embedded), valid script;
//   2. no HTML built from text, in the source; no outside links;
//   3. the build compiles and only calls the contract routes;
//   4. the mock (?mock=1, tests/mock-items.json) has the requested scenario, with the server's own answers;
//   5. the real server.js, on a fake root built from the mock (build-mock-root.js, with hostile data), delivers
//      everything the page reads and serves index.html with a CSP.
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
  // No outside link: an href built from data only through trackerHref (links to the trackers, #9), and no fixed
  // href (only # anchors).
  const hrefs = [...allSource.matchAll(/\bhref=\{([^}]+)\}/g)].map((m) => m[1].trim());
  assert.ok(hrefs.length > 0, 'the item page links to the PR and the card');
  assert.deepStrictEqual(hrefs.filter((h) => !/^trackerHref\([\w.]+\)$/.test(h)), [], 'an href from data only through trackerHref()');
  for (const m of allSource.matchAll(/<a\b[^>]*>/g)) {
    if (/\bhref=\{/.test(m[0])) assert.ok(/rel="noopener noreferrer"/.test(m[0]), `outside link without rel="noopener noreferrer": ${m[0]}`);
  }
  assert.ok(!/\bhref="(?!#)/.test(allSource), 'no fixed outside href');
});

suite.test('the embedded script compiles and only uses the contract routes', () => {
  new vm.Script(js, { filename: 'index.html#script' });
  const api = source['data/api.js'];
  for (const route of ["api('/api/state')", "api('/api/recalculate', { method: 'POST' })",
    "api(withQuery('/api/pending-decisions', params))", "api(withQuery('/api/items', filters))",
    'api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}`)', "api(withQuery('/api/log', params))", 'api(`/api/log/${encodeURIComponent(id)}`)',
    "api('/api/companies')", "api(withQuery('/api/projects', filters))",
    "api(`/api/projects/${encodeURIComponent(project)}/company`, { method: 'POST', body: { company } })",
    "api(withQuery('/api/usage', filters))", "api(withQuery('/api/agents', filters))", "api(withQuery('/api/overview', filters))"]) {
    assert.ok(api.includes(route), `the page calls ${route}`);
  }
  for (const route of ['/api/state', '/api/recalculate', '/api/pending-decisions', '/api/items', '/api/log', '/api/log/',
    '/api/companies', '/api/projects', '/api/usage', '/api/agents', '/api/overview']) {
    assert.ok(js.includes(route), `the build calls ${route}`);
  }
  // Nothing of the old model: no events/flows routes, no Brain.
  for (const old of ['/api/events', '/api/event/', '/api/flow/', '/api/brain']) assert.ok(!js.includes(old), `the build still calls ${old}`);
  const allowed = /^\/api\/(state|recalculate|pending-decisions|items|items\/|log|log\/|companies|projects|projects\/|usage|agents|overview)$/;
  for (const m of js.matchAll(/\/api\/[a-z_/-]*/g)) assert.ok(allowed.test(m[0]), `route outside the contract in the build: ${m[0]}`);
  assert.ok(!/new URLSearchParams\(\)/.test(api.replace(/export function withQuery[\s\S]*?\r?\n}\r?\n/, '')), 'every query string goes through withQuery');
  assert.ok(/'X-Panel': '1'/.test(api), 'POST carries X-Panel: 1');
  assert.ok(/export const REFRESH_MS = 20000;/.test(api), 'refreshes every 20 s');
  assert.ok(/export const PAGE_SIZE = 50;/.test(api), 'pages of 50');
  assert.ok(/timeZone: TZ/.test(source['data/format.js']) && /export const TZ = 'America\/Sao_Paulo'/.test(source['data/format.js']), 'dates in America/Sao_Paulo');
  assert.ok(/<meta name="color-scheme" content="dark">/.test(html), 'the brand dark theme');
  assert.ok(/<html lang="pt-BR">/.test(html));
});

suite.test('the demo is only the new model: mock-items.json answers /api/state too, and the old mocks are gone', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const e = m.state;
  assert.deepStrictEqual(Object.keys(e).sort(), ['collector', 'generated_at', 'health', 'kpis', 'warnings']);
  assert.deepStrictEqual(Object.keys(e.health).sort(), ['last_event_at', 'last_raw_at', 'level', 'reasons', 'usage_age_min']);
  assert.deepStrictEqual(Object.keys(e.kpis).sort(), ['pending_decisions', 'usage']);
  const open = m.pending_decisions.pending_decisions.filter((p) => p.status === 'open');
  assert.strictEqual(e.kpis.pending_decisions.total, open.length, 'the menu counter counts the open pending decisions of the demo');
  assert.ok(e.kpis.pending_decisions.by_severity.critical > 0, 'a critical one turns the counter strong');
  assert.deepStrictEqual([e.kpis.usage.window_5h_pct, e.kpis.usage.weekly_pct, e.generated_at], [37, 22, m.generated_at]);
  // No sentence from the server: reasons and sources are codes.
  assert.ok(e.health.reasons.every((r) => typeof r.code === 'string'));
  assert.strictEqual(e.kpis.usage.source.code, 'maestri_claude_provider');
  for (const old of ['mock-state.json', 'mock-details.json', 'generate-mock.js']) assert.ok(!fs.existsSync(path.join(__dirname, old)), `${old} still exists`);
  assert.ok(!/mock-state|mock-details/.test(js), 'the page reads only mock-items.json');
});

suite.test('mock-items.json: items in different stages, both trackers, several companies; the item page has a fixed address', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const stages = require('../../bin/flow-store.js').STAGES;
  assert.deepStrictEqual([...new Set(m.items.map((i) => i.stage))].sort(), stages.slice().sort(), 'every stage has an item');
  assert.deepStrictEqual([...new Set(m.items.map((i) => i.tracker))].sort(), ['azure_devops', 'github']);
  assert.ok(new Set(m.items.map((i) => i.project.company.id)).size >= 3, 'several companies');
  for (const it of m.items) {
    assert.strictEqual(it.tracker_ref, it.tracker === 'azure_devops' ? `PBI ${it.number}` : `#${it.number}`);
    const d = m.details[it.key];
    assert.ok(d && d.stage === it.stage && Array.isArray(d.stages) && d.stages.some((s) => s.status === 'current' && s.id === it.stage), `details of ${it.key}`);
  }
  // Tasks (#7): one item has a task in every state; an item without a task graph is a single task, itself.
  const everyState = Object.values(m.details).find((d) => ['waiting', 'working', 'review', 'blocked', 'integrated', 'out'].every((s) => d.tasks.some((x) => x.state === s)));
  assert.ok(everyState && everyState.tasks.some((x) => x.blocked_by.length), 'an item with tasks in every state and blockers');
  assert.ok(Object.values(m.details).some((d) => d.tasks.length === 1 && d.tasks[0].self && d.tasks[0].number === d.number), 'an item that is its own task');
  // The page of an item: #items/<project>/<number> (subroute of the Items screen).
  assert.ok(/RE_ITEM = \/\^\(\[a-z0-9\]\[a-z0-9-\]\*\)\\\/\(\[1-9\]\\d\*\)\$\//.test(source['screens/Items.jsx']), 'Items reads <project>/<number> from the address');
  assert.ok(/goTo\('items', it\.key\)/.test(source['screens/Items.jsx']), 'a click on an item opens #items/<key>');
  assert.ok(js.includes('mock-items.json'), 'the test mode reads mock-items.json');
  // Pending decisions (#10): open and closed ones of every kind, with where to answer.
  const pd = m.pending_decisions.pending_decisions;
  assert.deepStrictEqual([...new Set(pd.map((p) => p.kind))].sort(), ['decision', 'finding', 'hml', 'parallelize', 'task_review', 'worker_blocked']);
  assert.deepStrictEqual([...new Set(pd.map((p) => p.status))].sort(), ['canceled', 'open', 'resolved']);
  assert.ok(pd.some((p) => p.resolution === 'task_integrated') && pd.some((p) => p.resolution === 'decision' && p.decision), 'resolved by integration and by decision');
  assert.ok(pd.filter((p) => p.status === 'open').every((p) => p.maestri.workspace && p.maestri.terminal), 'open ones say where to answer');
  assert.ok(js.includes('/api/pending-decisions'), 'the Pending decisions screen reads the new model');
});

suite.test('the address picks the screen: a malformed address (bad percent-encoding) falls back to the Overview instead of breaking the page', async () => {
  const { parseHash } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'screens.js')).href);
  assert.deepStrictEqual(parseHash('#items/widgets/12'), { id: 'items', sub: 'widgets/12' });
  assert.deepStrictEqual(parseHash('#items/caf%C3%A9/3'), { id: 'items', sub: 'café/3' });
  assert.deepStrictEqual(parseHash('#visao'), { id: 'overview', sub: '' }, 'old address');
  assert.deepStrictEqual(parseHash(''), { id: 'overview', sub: '' });
  assert.deepStrictEqual(parseHash('#nao-existe'), { id: 'overview', sub: '' });
  for (const bad of ['#items/%E0%A4%A', '#log/%', '#%ZZ']) assert.deepStrictEqual(parseHash(bad), { id: 'overview', sub: '' }, bad);
});

suite.test('the Items filters offer the server\'s stages and trackers (the page keeps its own copy of the lists)', async () => {
  const { STAGES, TRACKERS } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'domain.js')).href);
  // Parity between the page's copy and the server's lists (a contract constant, not a database read): same exception
  // as trackerHref × trackerUrl below.
  const store = require('../../bin/flow-store.js');
  assert.deepStrictEqual(STAGES, store.STAGES);
  assert.deepStrictEqual(TRACKERS, store.TRACKERS);
  assert.ok(/stage/.test(source['screens/Items.jsx']) && /tracker/.test(source['screens/Items.jsx']), 'the Items screen filters by stage and tracker');
});

suite.test('links of the item page only go to the trackers (github.com, dev.azure.com, *.visualstudio.com)', async () => {
  const { trackerHref } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'links.js')).href);
  for (const good of ['https://github.com/acme/widgets/pull/34', 'https://dev.azure.com/contoso/CIDAX/_git/api/pullrequest/812',
    'https://contoso.visualstudio.com/Billing/_workitems/edit/3100']) assert.strictEqual(trackerHref(good), good);
  for (const bad of ['http://github.com/acme/widgets/pull/34', 'https://github.com.evil.example/pull/1', 'https://evil.example/github.com',
    'javascript:alert(1)', 'https://user:pw@github.com/x', 'https://github.com:8443/x', 'https://gist.github.com/x', '//github.com/x',
    'data:text/html,x', '', null, 42]) assert.strictEqual(trackerHref(bad), null, String(bad));
  // The page's rule is the same as the server's (the projection only keeps tracker links). Exception to "no test calls
  // internal functions" (panel/README.md): this is a parity between the page's copy (ESM, the build cannot import the
  // CommonJS of bin/) and the server's rule, and the API never answers a link the rule refused, so it cannot show it.
  const { trackerUrl } = require('../../bin/flow-projection.js');
  for (const u of ['https://github.com/a/b/pull/1', 'https://x.visualstudio.com/p', 'https://evil.example/', 'http://dev.azure.com/x']) {
    assert.strictEqual(trackerHref(u), trackerUrl(u), u);
  }
});

suite.test('mock-items.json: items in Final adjustment, PR ready, Merge, HML validation and Done, with PR, adjustment and HML', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const details = Object.values(m.details);
  for (const stage of ['final_adjustment', 'pr_ready', 'merge', 'hml_validation', 'done']) {
    assert.ok(details.some((d) => d.stage === stage && d.pr && d.pr.url), `an item in ${stage} with a PR`);
  }
  assert.deepStrictEqual([...new Set(details.map((d) => d.pr && d.pr.state).filter(Boolean))].sort(), ['draft', 'merged', 'ready']);
  assert.deepStrictEqual([...new Set(details.map((d) => d.final_adjustment && d.final_adjustment.status).filter(Boolean))].sort(), ['open', 'passed']);
  assert.deepStrictEqual([...new Set(details.map((d) => d.hml && d.hml.outcome).filter(Boolean))].sort(), ['approved', 'failed']);
  assert.ok(details.some((d) => d.stage === 'done' && !d.stages.some((s) => s.id === 'hml_validation')), 'a done item of a project without HML');
  assert.ok(m.items.some((i) => i.active === false) && m.items.some((i) => i.active === true), 'active and done items');
  for (const d of details) assert.strictEqual(d.active, d.stage !== 'done');
});

suite.test('companies (#6): the demo has two companies and "Pessoal" with GitHub and Azure DevOps projects; the selector is remembered', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const named = m.companies.filter((c) => !c.unassigned);
  assert.ok(named.length >= 3 && named.some((c) => c.name === 'Pessoal'), 'two companies and Pessoal');
  assert.deepStrictEqual([...new Set(m.projects.map((p) => p.tracker))].sort(), ['azure_devops', 'github']);
  assert.ok(m.projects.some((p) => p.tracker === 'azure_devops' && p.repos.length > 1), 'an Azure DevOps project with several repositories');
  assert.ok(m.projects.some((p) => p.unassigned), 'a project in "Sem empresa" to move');
  for (const c of m.companies) assert.strictEqual(c.project_count, m.projects.filter((p) => p.company.id === c.id).length, c.id);
  // The choice lives in localStorage, always behind try/catch (blocked storage must not break the page).
  const companies = source['data/companies.js'];
  assert.ok(/localStorage\.getItem/.test(companies) && /localStorage\.setItem/.test(companies), 'remembered in the browser');
  assert.strictEqual((companies.match(/try \{/g) || []).length >= 2, true, 'reads and writes behind try/catch');
  assert.ok(/readItems\(\{ \.\.\.companyFilter/.test(source['screens/Items.jsx']), 'the Items list reads with the company filter');
  assert.ok(js.includes('painel-maestro.company'));
});

suite.test('Companies screen (#21): in the menu, sharing the project line with "Sem empresa"; the mock refuses "Sem empresa" as a destination', async () => {
  const { SCREENS, parseHash } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'screens.js')).href);
  assert.ok(SCREENS.some((s) => s.id === 'companies' && s.group === 'workspace'));
  assert.deepStrictEqual(parseHash('#companies'), { id: 'companies', sub: '' });
  for (const f of ['screens/Companies.jsx', 'screens/UnassignedProjects.jsx']) assert.ok(/import \{ ProjectRow \} from '\.\/ProjectRow\.jsx'/.test(source[f]), f);
  // Exception to the seam rule (panel/README.md, Testes): the mock lives only in the page (?mock=1), with no server or
  // process to drive, so its refusal of "Sem empresa" is checked by calling mockApi() with the page's address and its
  // one file (tests/mock-items.json), without a browser.
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const saved = { location: globalThis.location, fetch: globalThis.fetch };
  globalThis.location = new URL('http://127.0.0.1:4795/?mock=1');
  globalThis.fetch = async () => ({ ok: true, json: async () => m });
  try {
    const { mockApi } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'mock.js')).href);
    const p = m.projects.find((x) => !x.unassigned);
    await assert.rejects(mockApi(`/api/projects/${p.id}/company`, 'POST', { company: 'unassigned' }),
      (e) => e.status === 400 && e.error.code === 'company_reserved' && e.error.company === 'unassigned');
    const target = m.companies.find((c) => !c.unassigned && c.id !== p.company.id);
    const count = async (id) => (await mockApi('/api/companies', 'GET')).companies.find((c) => c.id === id).project_count;
    const origin = p.company.id;
    const before = [await count(origin), await count(target.id)];
    const moved = await mockApi(`/api/projects/${p.id}/company`, 'POST', { company: target.id });
    assert.deepStrictEqual(moved.project.company, { id: target.id, name: target.name });
    assert.deepStrictEqual([await count(origin), await count(target.id)], [before[0] - 1, before[1] + 1], 'the counts follow the move');
  } finally {
    globalThis.location = saved.location;
    globalThis.fetch = saved.fetch;
  }
});

suite.test('mock-items.json: reports by task (ok and blocked) and findings of every classification, one of them an "out" task', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const details = Object.values(m.details);
  const reports = details.flatMap((d) => d.reports);
  const findings = details.flatMap((d) => d.findings);
  assert.deepStrictEqual([...new Set(reports.map((r) => r.status))].sort(), ['blocked', 'ok']);
  assert.ok(reports.some((r) => r.decisions.length && r.shared_files.length && /\n/.test(r.text)), 'a full report with many lines');
  assert.deepStrictEqual([...new Set(findings.map((f) => f.classification))].sort(), ['defect', 'discarded', 'owner_decision']);
  assert.ok(details.some((d) => d.findings.some((f) => f.new_task && d.tasks.some((x) => x.number === f.new_task.number && x.state === 'out' && x.finding === f.number))),
    'a finding that became an "out" task of its item');
  assert.ok(/reviewEventText/.test(source['screens/Items.jsx']), 'the timeline names the report and finding events');
});

suite.test('mock-items.json: usage per item and per agent and the active agents (#13), from the real collector and API', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const u = m.usage;
  assert.strictEqual(u.plan.window_5h_pct, 37, 'the demo plan');
  for (const period of ['window_5h', 'today', '7d']) assert.ok(u.by_item[period].length >= 3 && u.by_agent[period].length >= 4, period);
  assert.ok(new Set(u.by_item['7d'].map((l) => l.project.company && l.project.company.id)).size >= 3, 'items of several companies');
  assert.ok(u.by_item['7d'].some((l) => l.item === null), 'a session outside any item');
  assert.deepStrictEqual([...new Set(u.by_agent['7d'].map((l) => l.role))].sort(), ['maestro', 'other', 'worker']);
  const agents = m.agents.agents;
  assert.ok(agents.some((a) => a.role === 'maestro') && agents.some((a) => a.role === 'worker' && a.task && a.task.state === 'blocked'), 'maestros and workers');
  assert.ok(agents.some((a) => a.last_activity_at && a.usage) && agents.some((a) => !a.last_activity_at), 'with and without sessions');
  assert.ok(js.includes('/api/usage') && js.includes('/api/agents'), 'the screens read the usage and agents API');
});

suite.test('Overview (#14): the demo has stale items and open pending decisions per company, and the health of the new model', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const all = m.overview[''];
  assert.ok(all && all.active.total > 0 && all.active.companies.length >= 3, 'active items by company');
  assert.ok(all.stale_items.length >= 2, 'items parked on the same stage');
  assert.ok(all.pending_decisions.total >= 3 && all.pending_decisions.open.length > 0, 'open pending decisions');
  assert.ok(all.recent_events.length > 0 && all.events_today > 0, 'recent activity');
  for (const c of m.companies) assert.strictEqual(m.overview[c.id].company, c.id, `the Overview of ${c.id}`);
  assert.ok(m.overview.contoso.active.total < all.active.total, 'the company narrows it');
  assert.ok(m.state.health && typeof m.state.health.level === 'string' && m.state.health.reasons.every((r) => typeof r.code === 'string'), 'health of the new model, by codes');
  assert.ok(m.state.health.reasons.some((r) => r.code === 'projects_unassigned'), 'the demo shows the projects in "Sem empresa"');
  // The page reads the new model with the selector's company and no longer the old events.
  assert.ok(/readOverview\(companyFilter\)/.test(source['screens/Overview.jsx']), 'the Overview reads with the company filter');
  assert.ok(!/state\.events|analysis|readEvents/.test(source['screens/Overview.jsx']), 'nothing of the old model in the Overview');
  assert.ok(js.includes('/api/overview'));
});


let port = null;
let pid = null;
let root = null;

suite.test('the real server on a fake root (the demo in a real maestro.db + a hostile item) delivers what the page reads', async () => {
  root = path.join(TMP, `index-${process.pid}`);
  const build = spawnSync(process.execPath, [path.join(__dirname, 'build-mock-root.js'), path.join(root, 'm'), '--hostile'], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(build.status, 0, build.stderr);
  fs.mkdirSync(path.join(root, 'maestri'), { recursive: true });
  fs.mkdirSync(path.join(root, 'claude'), { recursive: true });
  const mock = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const p = await freePort();
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: path.join(root, 'm'), MAESTRI_DATA_DIR: path.join(root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    PANEL_NOW: mock.generated_at, MAESTRO_NOW: '', PANEL_COLLECTOR: '0', PANEL_PORT: '', PANEL_INDEX: '',
  });
  const child = spawn(process.execPath, [SERVER, '--port', String(p)], { env, windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  const m = await waitFor(() => /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(out), 15000);
  port = Number(m[1]);
  pid = Number(m[2]);
  const get = async (q) => {
    const r = await request(port, q);
    assert.strictEqual(r.status, 200, `${q}: ${r.text}`);
    return r.json;
  };

  const idx = await request(port, '/');
  assert.strictEqual(idx.status, 200);
  assert.strictEqual(idx.text, html, 'serves this index.html');
  assert.ok(/default-src 'none'/.test(idx.headers['content-security-policy'] || ''), 'CSP');
  assert.strictEqual(idx.headers['cache-control'], 'no-store');

  // The shell: the demo's counter plus the hostile critical pending decision; the health by the same rules.
  const st = await get('/api/state');
  const kp = mock.state.kpis.pending_decisions;
  assert.deepStrictEqual(st.kpis.pending_decisions, { total: kp.total + 1, by_severity: { ...kp.by_severity, critical: kp.by_severity.critical + 1 } });
  // This root has no bruto.db: besides the projects in "Sem empresa", the badge says the hook never wrote.
  assert.deepStrictEqual(st.health.reasons.map((r) => r.code).sort(), ['hook_never', 'projects_unassigned']);

  // The lists the screens read: the demo's answers, plus the hostile item.
  const items = (await get('/api/items')).items;
  assert.strictEqual(items.length, mock.items.length + 1);
  for (const it of mock.items) assert.ok(items.some((x) => x.key === it.key && x.stage === it.stage), `item ${it.key}`);
  const ov = await get('/api/overview');
  assert.strictEqual(ov.active.total, mock.overview[''].active.total + 1);
  assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => c.id), mock.companies.map((c) => c.id));
  const pd = (await get('/api/pending-decisions')).pending_decisions;
  assert.strictEqual(pd.length, mock.pending_decisions.pending_decisions.length + 1);
  assert.strictEqual(pd[0].severity, 'critical', 'open ones first, by severity');

  // The hostile texts arrive raw (the page shows them as text) and a javascript: link never becomes a link.
  const hostile = (await get('/api/items/portal/4242')).item;
  assert.ok(hostile.title.includes('<script>'), 'the hostile title arrives raw');
  assert.ok(hostile.reports[0].text.includes('onerror'), 'the hostile report arrives raw');
  assert.strictEqual(hostile.pr.url, null, 'only tracker links are kept');
  assert.ok(pd.some((x) => x.title.includes('onerror')), 'the hostile pending decision is in the list');
  const log = await get('/api/log?per_page=50');
  const last = log.events[0];
  assert.deepStrictEqual([last.item_key, last.type], ['portal/4242', 'pr-changed']);
  const det = await get(`/api/log/${last.id}`);
  assert.strictEqual(det.event.id, last.id);
  const none = await request(port, '/api/log/999999');
  assert.deepStrictEqual([none.status, none.json.error.code], [404, 'event_not_found']);

  // Header button.
  assert.strictEqual((await request(port, '/api/recalculate', { method: 'POST' })).status, 403);
  const rec = await request(port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1' } });
  assert.strictEqual(rec.status, 200);
  assert.ok(rec.json && rec.json.generated_at && rec.json.kpis);
});

(async () => {
  try {
    await suite.run();
  } finally {
    kill(pid);
    if (root && !process.env.KEEP_TMP) remove(root);
  }
})();
