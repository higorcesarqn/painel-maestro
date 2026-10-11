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

const crypto = require('crypto');
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

/**
 * The open pending decisions the demo's /api/state counts: those of the mock file but the hidden organizations' (#52). The
 * file keeps them all (the mock leaves the hidden ones out of its listings at read time).
 */
function openVisible(m) {
  const hidden = new Set(m.organizations.filter((c) => c.hidden).map((c) => c.id));
  return m.pending_decisions.pending_decisions.filter((p) => p.status === 'open' && !hidden.has(p.item.project.organization.id));
}

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
    "api(`/api/pending-decisions/${encodeURIComponent(id)}/answer`, { method: 'POST', body: { option, text } })",
    'api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}`)', "api(withQuery('/api/log', params))", 'api(`/api/log/${encodeURIComponent(id)}`)',
    "api(withQuery('/api/organizations', filters))", "api(withQuery('/api/projects', filters))",
    "api(`/api/organizations/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { name } })",
    "api(`/api/organizations/${encodeURIComponent(id)}/remove`, { method: 'POST' })",
    "api(`/api/organizations/${encodeURIComponent(id)}/hide`, { method: 'POST' })",
    "api(`/api/organizations/${encodeURIComponent(id)}/unhide`, { method: 'POST' })",
    "api(`/api/projects/${encodeURIComponent(project)}/organization`, { method: 'POST', body: { organization } })",
    "api(withQuery('/api/usage', filters))", "api(withQuery('/api/agents', filters))", "api(withQuery('/api/overview', filters))"]) {
    assert.ok(api.includes(route), `the page calls ${route}`);
  }
  for (const route of ['/api/state', '/api/recalculate', '/api/pending-decisions', '/api/items', '/api/log', '/api/log/',
    '/api/organizations', '/api/projects', '/api/usage', '/api/agents', '/api/overview']) {
    assert.ok(js.includes(route), `the build calls ${route}`);
  }
  // Nothing of the old model: no events/flows routes, no Brain.
  for (const old of ['/api/events', '/api/event/', '/api/flow/', '/api/brain']) assert.ok(!js.includes(old), `the build still calls ${old}`);
  const allowed = /^\/api\/(state|recalculate|pending-decisions|pending-decisions\/|items|items\/|log|log\/|organizations|organizations\/|projects|projects\/|usage|agents|overview)$/;
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
  assert.deepStrictEqual(Object.keys(e).sort(), ['collector', 'generated_at', 'health', 'kpis', 'version', 'warnings']);
  assert.deepStrictEqual(Object.keys(e.health).sort(), ['last_event_at', 'last_raw_at', 'level', 'reasons', 'usage_age_min']);
  assert.deepStrictEqual(Object.keys(e.kpis).sort(), ['pending_decisions', 'usage']);
  const open = openVisible(m);
  assert.ok(open.length < m.pending_decisions.pending_decisions.filter((p) => p.status === 'open').length, 'the demo has an open one of a hidden organization');
  assert.strictEqual(e.kpis.pending_decisions.total, open.length, 'the menu counter counts the open pending decisions of the demo, without the hidden organization\'s (#52)');
  assert.ok(e.kpis.pending_decisions.by_severity.critical > 0, 'a critical one turns the counter strong');
  assert.deepStrictEqual([e.kpis.usage.window_5h_pct, e.kpis.usage.weekly_pct, e.generated_at], [37, 22, m.generated_at]);
  // The menu footer's version (#36): fixed and fictitious in the demo; the footer reads it from /api/state.
  // The page id (#37) is null in the demo: the demo never compares it.
  assert.deepStrictEqual(e.version, { product: '1.1.0', commit: 'a5c2e21', page: null });
  assert.ok(/state\.version/.test(source['app/Sidebar.jsx']) && /sidebar\.versionNoCommit/.test(source['app/Sidebar.jsx']), 'the footer shows the version');
  // No sentence from the server: reasons and sources are codes.
  assert.ok(e.health.reasons.every((r) => typeof r.code === 'string'));
  assert.strictEqual(e.kpis.usage.source.code, 'maestri_claude_provider');
  for (const old of ['mock-state.json', 'mock-details.json', 'generate-mock.js']) assert.ok(!fs.existsSync(path.join(__dirname, old)), `${old} still exists`);
  assert.ok(!/mock-state|mock-details/.test(js), 'the page reads only mock-items.json');
});

suite.test('page id (#37): the build writes a hash of the page in <meta name="page-id">, and the tab compares it with version.page', () => {
  const ids = [...html.matchAll(/<meta name="page-id" content="([0-9a-f]{16})">/g)];
  assert.strictEqual(ids.length, 1, 'one page id in index.html');
  const id = ids[0][1];
  assert.ok(/<head>\r?\n<meta name="page-id" content="[0-9a-f]{16}">/.test(html), 'the id opens the <head>');
  // A hash of the content: without the meta line, the page (line endings as LF, whatever the checkout did) hashes back
  // to the id (so an identical build keeps it and any change to the bundle changes it).
  const hashed = html.replace(/\r?\n<meta name="page-id" content="[0-9a-f]{16}">/, '').replace(/\r*\n/g, '\n');
  assert.strictEqual(crypto.createHash('sha256').update(hashed).digest('hex').slice(0, 16), id);
  assert.ok(/createHash\('sha256'\)/.test(fs.readFileSync(path.join(PANEL, 'ui', 'scripts', 'publish.js'), 'utf8')), 'the build computes it');
  // The tab reads its own id from the loaded document and compares it with version.page; never in the demo, and only
  // when both ids are known.
  const page = source['data/page.js'];
  assert.ok(/document\.querySelector\('meta\[name="page-id"\]'\)/.test(page), 'the tab reads its id from the document');
  assert.ok(/if \(MOCK \|\| !PAGE_ID\) return false;/.test(page), 'no comparison in the demo nor without an id');
  assert.ok(/\.page/.test(page) && /page !== '' && page !== PAGE_ID/.test(page), 'compares with version.page, which must be known');
  // The strip: fixed at the top, with "Recarregar", which reloads only on the click; it never closes nor reloads by itself.
  const app = source['app/App.jsx'];
  assert.ok(/pageOutdated\(state\) && \(/.test(app) && /t\('app\.pageOutdated'\)/.test(app), 'the shell shows the strip from each state read');
  assert.ok(/onClick=\{\(\) => location\.reload\(\)\}>\{t\('app\.reload'\)\}/.test(app), 'the button reloads the page');
  assert.strictEqual((allSource.match(/location\.reload\(/g) || []).length, 1, 'the only reload is the button');
  assert.ok(/\.banners:has\(> \.banner\.update\) \{ position: sticky; top: 0;/.test(fs.readFileSync(path.join(SOURCE, 'styles', 'base.css'), 'utf8')), 'fixed at the top');
});

suite.test('mock-items.json: items in different stages, both trackers, several organizations; the item page has a fixed address', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const stages = require('../../bin/flow-store.js').STAGES;
  assert.deepStrictEqual([...new Set(m.items.map((i) => i.stage))].sort(), stages.slice().sort(), 'every stage has an item');
  assert.deepStrictEqual([...new Set(m.items.map((i) => i.tracker))].sort(), ['azure_devops', 'github']);
  assert.ok(new Set(m.items.map((i) => i.project.organization.id)).size >= 3, 'several organizations');
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

suite.test('Configurações (#48): #organizations, #settings and #settings/organizations open Configurações → Organizações; the arrows skip it', async () => {
  const { SCREENS, ARROW_SCREENS, parseHash, screenAt } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'screens.js')).href);
  const organizations = { id: 'settings', sub: 'organizations' };
  for (const h of ['#organizations', '#settings', '#settings/organizations', '#settings/nao-existe', '#organizations/x']) {
    assert.deepStrictEqual(parseHash(h), organizations, h);
  }
  // goTo goes through the same rule: the default sub-tab, and an unknown screen opens the Overview.
  assert.deepStrictEqual(screenAt('settings', ''), organizations);
  assert.deepStrictEqual(screenAt('items', 'widgets/12'), { id: 'items', sub: 'widgets/12' });
  assert.deepStrictEqual(screenAt('nao-existe', 'x'), { id: 'overview', sub: '' });
  assert.ok(!SCREENS.some((s) => s.id === 'organizations'), 'Organizations is no longer a screen of its own');
  assert.deepStrictEqual(ARROW_SCREENS, ['overview', 'items', 'pending', 'log', 'agents', 'usage'], 'the arrows only go through the work screens');
  // The menu: the arrows follow ARROW_SCREENS; the gear on the footer opens Configurações, named and marked when it is open.
  const sidebar = source['app/Sidebar.jsx'];
  assert.ok(/ARROW_SCREENS/.test(sidebar) && !/GROUPS\.flatMap/.test(sidebar), 'the arrows read ARROW_SCREENS');
  const foot = sidebar.slice(sidebar.indexOf('class="sidebar-foot"'));
  assert.ok(/<Icon of=\{Gear\}/.test(foot) && /onClick=\{\(\) => goTo\('settings'\)\}/.test(foot), 'the gear is on the footer');
  assert.ok(/aria-label=\{t\('nav\.settings'\)\}/.test(foot) && /aria-current=\{screen === 'settings' \? 'page' : undefined\}/.test(foot), 'named and marked');
  // The shell resolves every address and goTo with screenAt, and writes the canonical address back (#organizations → #settings/organizations).
  const app = source['app/App.jsx'];
  assert.ok(/settings: Settings/.test(app) && !/organizations: Organizations/.test(app), 'Settings in SCREEN_COMPONENTS');
  assert.ok(/screenAt\(id, sub\)/.test(app), 'goTo goes through screenAt');
  // The screen: one tab per sub-tab, from the dictionary; Organizations is the screen of before.
  const settings = source['screens/Settings.jsx'];
  assert.ok(/role="tablist"/.test(settings) && /role="tab"/.test(settings) && /t\(`settings\.tabs\.\$\{/.test(settings), 'the sub-tabs are tabs');
  assert.ok(/organizations: Organizations/.test(settings), 'Organizations is a sub-tab');
  // The dictionary through i18n/index.js, which pt-BR.js imports back (importing pt-BR.js first breaks the cycle).
  const { t } = await import(require('url').pathToFileURL(path.join(SOURCE, 'i18n', 'index.js')).href);
  assert.deepStrictEqual([t('nav.settings'), t('screens.settings'), t('settings.tabs.organizations')], ['Configurações', 'Configurações', 'Organizações']);
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

suite.test('organizations (#6): the demo has two organizations and "Pessoal" with GitHub and Azure DevOps projects; the selector is remembered', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const named = m.organizations.filter((c) => !c.unassigned);
  assert.ok(named.length >= 3 && named.some((c) => c.name === 'Pessoal'), 'two organizations and Pessoal');
  assert.deepStrictEqual([...new Set(m.projects.map((p) => p.tracker))].sort(), ['azure_devops', 'github']);
  assert.ok(m.projects.some((p) => p.tracker === 'azure_devops' && p.repos.length > 1), 'an Azure DevOps project with several repositories');
  assert.ok(m.projects.some((p) => p.unassigned), 'a project in "Sem organização" to move');
  for (const c of m.organizations) assert.strictEqual(c.project_count, m.projects.filter((p) => p.organization.id === c.id).length, c.id);
  // The choice lives in localStorage, always behind try/catch (blocked storage must not break the page).
  const organizations = source['data/organizations.js'];
  assert.ok(/localStorage\.getItem/.test(organizations) && /localStorage\.setItem/.test(organizations), 'remembered in the browser');
  assert.strictEqual((organizations.match(/try \{/g) || []).length >= 2, true, 'reads and writes behind try/catch');
  assert.ok(/readItems\(\{ \.\.\.organizationFilter/.test(source['screens/Items.jsx']), 'the Items list reads with the organization filter');
  assert.ok(js.includes('painel-maestro.organization'));
});

suite.test('Organizations screen (#21): a sub-tab of Configurações (#48), sharing the project line with "Sem organização"; the mock refuses "Sem organização" as a destination, renames and removes only an empty organization', async () => {
  const { SCREENS } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'screens.js')).href);
  assert.ok(SCREENS.some((s) => s.id === 'settings' && s.subs[0] === 'organizations'));
  for (const f of ['screens/Organizations.jsx', 'screens/UnassignedProjects.jsx']) assert.ok(/import \{ ProjectRow \} from '\.\/ProjectRow\.jsx'/.test(source[f]), f);
  // Exception to the seam rule (panel/README.md, Testes): the mock lives only in the page (?mock=1), with no server or
  // process to drive, so its refusal of "Sem organização" is checked by calling mockApi() with the page's address and its
  // one file (tests/mock-items.json), without a browser.
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const saved = { location: globalThis.location, fetch: globalThis.fetch };
  globalThis.location = new URL('http://127.0.0.1:4795/?mock=1');
  globalThis.fetch = async () => ({ ok: true, json: async () => m });
  try {
    const { mockApi } = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'mock.js')).href);
    const p = m.projects.find((x) => !x.unassigned);
    await assert.rejects(mockApi(`/api/projects/${p.id}/organization`, 'POST', { organization: 'unassigned' }),
      (e) => e.status === 400 && e.error.code === 'organization_reserved' && e.error.organization === 'unassigned');
    const target = m.organizations.find((c) => !c.unassigned && c.id !== p.organization.id);
    const count = async (id) => (await mockApi('/api/organizations', 'GET')).organizations.find((c) => c.id === id).project_count;
    const origin = p.organization.id;
    const before = [await count(origin), await count(target.id)];
    const moved = await mockApi(`/api/projects/${p.id}/organization`, 'POST', { organization: target.id });
    assert.deepStrictEqual(moved.project.organization, { id: target.id, name: target.name });
    assert.deepStrictEqual([await count(origin), await count(target.id)], [before[0] - 1, before[1] + 1], 'the counts follow the move');
    // Removing an organization (#24) under the store's rules: "Sem organização" (400), with projects (409 with the count),
    // unknown (404); an empty one leaves the list.
    const remove = (id) => mockApi(`/api/organizations/${id}/remove`, 'POST');
    await assert.rejects(remove('unassigned'), (e) => e.status === 400 && e.error.code === 'organization_reserved');
    await assert.rejects(remove(target.id), (e) => e.status === 409 && e.error.code === 'organization_not_empty' && e.error.project_count === before[1] + 1);
    await assert.rejects(remove('nobody'), (e) => e.status === 404 && e.error.code === 'organization_not_found');
    const created = await mockApi('/api/organizations', 'POST', { id: 'tmp-empty', name: 'Vazia de teste' });
    assert.strictEqual(created.organization.project_count, 0);
    assert.deepStrictEqual(await remove('tmp-empty'), { removed: 'tmp-empty' });
    assert.ok(!(await mockApi('/api/organizations', 'GET')).organizations.some((c) => c.id === 'tmp-empty'), 'the removed organization leaves the list');
    // Renaming an organization (#23) under the store's rules: "Sem organização" (400), unknown (404), another organization's name
    // ignoring case (409), an invalid name (400); its own name with another case is accepted, the id is kept, and every
    // answer of the mock that carries the organization shows the new name, as the server's do.
    const rename = (id, name) => mockApi(`/api/organizations/${id}/rename`, 'POST', { name });
    const other = m.organizations.find((c) => !c.unassigned && c.id !== target.id);
    await assert.rejects(rename('unassigned', 'Outra'), (e) => e.status === 400 && e.error.code === 'organization_reserved');
    await assert.rejects(rename('nobody', 'Outra'), (e) => e.status === 404 && e.error.code === 'organization_not_found');
    await assert.rejects(rename(target.id, ` ${other.name.toUpperCase()} `), (e) => e.status === 409 && e.error.code === 'organization_name_taken' && e.error.organization === other.id);
    await assert.rejects(rename(target.id, '  '), (e) => e.status === 400 && e.error.code === 'invalid_field' && e.error.field === 'name');
    // The name of "Sem organização" is reserved, by a rename and by a creation (P-18, #20).
    const reservedName = (e) => e.status === 409 && e.error.code === 'organization_name_taken' && e.error.organization === 'unassigned';
    await assert.rejects(rename(target.id, 'SEM ORGANIZAÇÃO'), reservedName);
    await assert.rejects(mockApi('/api/organizations', 'POST', { id: 'tmp-reserved', name: ' sem organização ' }), reservedName);
    assert.strictEqual((await rename(target.id, target.name.toLowerCase())).organization.name, target.name.toLowerCase());
    const renamed = await rename(target.id, '  Renomeada de Teste ');
    assert.deepStrictEqual([renamed.organization.id, renamed.organization.name, renamed.organization.project_count], [target.id, 'Renomeada de Teste', before[1] + 1]);
    const names = new Set();
    const collect = (x) => {
      if (Array.isArray(x)) return x.forEach(collect);
      if (!x || typeof x !== 'object') return undefined;
      for (const [k, v] of Object.entries(x)) {
        if (k === 'organization' && v && v.id === target.id && 'name' in v) names.add(v.name);
        if (k === 'organizations' && Array.isArray(v)) for (const c of v) if (c && c.id === target.id) names.add(c.name);
        collect(v);
      }
      return undefined;
    };
    const item = (await mockApi(`/api/items?organization=${target.id}`, 'GET')).items[0];
    for (const route of ['/api/organizations', '/api/projects', `/api/items?organization=${target.id}`, '/api/pending-decisions', '/api/overview',
      `/api/overview?organization=${target.id}`, '/api/usage', '/api/agents', '/api/log', `/api/items/${item.project.id}/${item.number}`]) {
      collect(await mockApi(route, 'GET'));
    }
    assert.deepStrictEqual([...names], ['Renomeada de Teste'], 'every answer of the mock shows the new name');
  } finally {
    globalThis.location = saved.location;
    globalThis.fetch = saved.fetch;
  }
});

suite.test('hidden organization (#50): the demo has a hidden organization with a project, items and an open pending decision; the mock answers ?hidden=include, hide and unhide like the server', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  // The generator writes the whole register (?hidden=include): every organization carries hidden and open_pending_count.
  for (const c of m.organizations) assert.ok(typeof c.hidden === 'boolean' && Number.isInteger(c.open_pending_count), c.id);
  const hidden = m.organizations.find((c) => c.hidden && !c.unassigned);
  assert.ok(hidden, 'a hidden organization in the demo');
  assert.ok(m.projects.some((p) => p.organization.id === hidden.id), 'with a project');
  assert.ok(m.items.filter((i) => i.project.organization.id === hidden.id).length >= 2, 'with items');
  const openOfHidden = m.pending_decisions.pending_decisions.filter((p) => p.status === 'open' && p.item.project.organization.id === hidden.id);
  assert.ok(openOfHidden.length >= 1 && hidden.open_pending_count === openOfHidden.length, 'with an open pending decision, counted on its card');
  // Exception to the seam rule, as above: the mock lives only in the page (?mock=1).
  const saved = { location: globalThis.location, fetch: globalThis.fetch };
  globalThis.location = new URL('http://127.0.0.1:4795/?mock=1');
  globalThis.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(m)) });
  try {
    const { mockApi } = await import(`${require('url').pathToFileURL(path.join(SOURCE, 'data', 'mock.js')).href}?hidden`);
    const ids = async (route) => (await mockApi(route, 'GET')).organizations.map((c) => c.id);
    const projectIds = async (route) => (await mockApi(route, 'GET')).projects.map((p) => p.id);
    // Without ?hidden=include the hidden ones (and their projects) stay out, as on the server; with it, everything comes.
    assert.deepStrictEqual(await ids('/api/organizations'), m.organizations.filter((c) => !c.hidden).map((c) => c.id));
    assert.deepStrictEqual(await ids('/api/organizations?hidden=include'), m.organizations.map((c) => c.id));
    assert.deepStrictEqual(await projectIds('/api/projects'), m.projects.filter((p) => p.organization.id !== hidden.id).map((p) => p.id));
    assert.deepStrictEqual(await projectIds('/api/projects?hidden=include'), m.projects.map((p) => p.id));
    assert.deepStrictEqual(await projectIds(`/api/projects?organization=${hidden.id}`), [], 'a hidden organization\'s projects only with ?hidden=include');
    for (const route of ['/api/organizations?hidden=all', '/api/projects?hidden=1']) {
      await assert.rejects(mockApi(route, 'GET'), (e) => e.status === 400 && e.error.code === 'invalid_filter' && e.error.param === 'hidden', route);
    }
    // The demo's listings leave the hidden organization out, as the server does since #51; its item page still answers by the
    // key, and one of its events by the id.
    const mentions = (answer, id) => JSON.stringify(answer).includes(`"id":"${id}"`);
    const listings = ['/api/items', '/api/pending-decisions', '/api/log?per_page=500', '/api/usage', '/api/agents', '/api/overview'];
    for (const route of listings) assert.ok(!mentions(await mockApi(route, 'GET'), hidden.id), `${route} without the hidden organization`);
    const hiddenItem = m.items.find((i) => i.project.organization.id === hidden.id);
    assert.strictEqual((await mockApi(`/api/items/${hiddenItem.project.id}/${hiddenItem.number}`, 'GET')).item.key, hiddenItem.key);
    const hiddenEvent = m.details[hiddenItem.key].timeline[0];
    assert.strictEqual((await mockApi(`/api/log/${hiddenEvent.id}`, 'GET')).event.id, hiddenEvent.id);
    const listed = (await mockApi('/api/organizations?hidden=include', 'GET')).organizations.find((c) => c.id === hidden.id);
    assert.deepStrictEqual([listed.hidden, listed.open_pending_count], [true, openOfHidden.length]);
    // Hide and show (POST .../hide and .../unhide) answer { organization } as the list does; repeating is not an error;
    // an unknown organization is 404; "Sem organização" may be hidden too.
    const post = (id, what) => mockApi(`/api/organizations/${id}/${what}`, 'POST');
    const visible = m.organizations.find((c) => !c.hidden && !c.unassigned);
    const h = await post(visible.id, 'hide');
    assert.deepStrictEqual([h.organization.id, h.organization.hidden, h.organization.project_count], [visible.id, true, visible.project_count]);
    assert.ok(!(await ids('/api/organizations')).includes(visible.id), 'the hidden one leaves the list');
    for (const route of listings.slice(0, 5)) assert.ok(!mentions(await mockApi(route, 'GET'), visible.id), `${route} without the organization just hidden`);
    assert.strictEqual((await post(visible.id, 'hide')).organization.hidden, true, 'hiding again is not an error');
    assert.strictEqual((await post(visible.id, 'unhide')).organization.hidden, false);
    assert.ok((await ids('/api/organizations')).includes(visible.id), 'shown again');
    assert.ok(mentions(await mockApi('/api/items', 'GET'), visible.id), 'its items back in the list');
    await post(hidden.id, 'unhide');
    for (const route of listings.slice(0, 5)) assert.ok(mentions(await mockApi(route, 'GET'), hidden.id), `${route} with the organization shown again`);
    await post(hidden.id, 'hide');
    await assert.rejects(post('nobody', 'hide'), (e) => e.status === 404 && e.error.code === 'organization_not_found');
    await assert.rejects(mockApi(`/api/organizations/${visible.id}/hide`, 'GET'), (e) => e.status === 405);
    assert.strictEqual((await post('unassigned', 'hide')).organization.hidden, true);
    assert.ok(!(await ids('/api/organizations')).includes('unassigned'));
    assert.ok(!(await projectIds('/api/projects')).some((id) => m.projects.find((p) => p.id === id).unassigned), 'its projects leave the list too');
    await post('unassigned', 'unhide');
    // A move in Configurações may take a project to a hidden organization; its open pending decisions go along.
    const p = m.projects.find((x) => x.organization.id === visible.id);
    const moved = await mockApi(`/api/projects/${p.id}/organization`, 'POST', { organization: hidden.id });
    assert.strictEqual(moved.project.organization.id, hidden.id);
    const openOfProject = m.pending_decisions.pending_decisions.filter((x) => x.status === 'open' && x.item.project.id === p.id).length;
    const after = (await mockApi('/api/organizations?hidden=include', 'GET')).organizations.find((c) => c.id === hidden.id);
    assert.deepStrictEqual([after.project_count, after.open_pending_count], [hidden.project_count + 1, openOfHidden.length + openOfProject]);
  } finally {
    globalThis.location = saved.location;
    globalThis.fetch = saved.fetch;
  }
});

suite.test('hidden organization (#50): Configurações → Organizações reads the whole register and hides or shows from the card, without a modal', async () => {
  const screen = source['screens/Organizations.jsx'];
  assert.ok(/const (\w+) = \{ hidden: 'include' \};[\s\S]*readOrganizations\(\1\), readProjects\(\1\)/.test(screen), 'the sub-tab reads with ?hidden=include');
  assert.ok(/readOrganizations\(\)/.test(source['data/organizations.js']), 'the selector reads without the hidden ones');
  assert.ok(/!o\.unassigned \|\| o\.hidden \|\| projectsOf\(o\)\.length > 0/.test(screen), '"Sem organização" shows when it has projects or is hidden');
  const hideButton = /function HideButton[\s\S]*?\r?\n\}\r?\n/.exec(screen);
  assert.ok(hideButton && /call: hideOrganization/.test(hideButton[0]) && /call: unhideOrganization/.test(hideButton[0]) && !/Modal/.test(hideButton[0]),
    'Ocultar / Mostrar call the API from the card, without a modal');
  assert.ok(/actions=\{\(\s*<>\s*<HideButton\b/.test(screen), 'every card has the button (outside any condition), "Sem organização" too');
  // The texts come from the pt-BR dictionary.
  const { t } = await import(require('url').pathToFileURL(path.join(SOURCE, 'i18n', 'index.js')).href);
  assert.deepStrictEqual([t('organizations.hide.button'), t('organizations.hide.showButton'), t('organizations.hidden')], ['Ocultar', 'Mostrar', 'Oculta']);
  assert.match(t('organizations.screenNote'), /ocultas/);
  assert.strictEqual(t('organizations.openPending', { count: 2 }), '2 pendências abertas');
  for (const key of ['hide.label', 'hide.showLabel', 'hide.hidden', 'hide.shown', 'hide.failed', 'hiddenOption']) {
    assert.ok(t(`organizations.${key}`, { name: 'X', message: 'm' }) !== `organizations.${key}`, `organizations.${key} in pt-BR`);
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
  assert.ok(new Set(u.by_item['7d'].map((l) => l.project.organization && l.project.organization.id)).size >= 3, 'items of several organizations');
  assert.ok(u.by_item['7d'].some((l) => l.item === null), 'a session outside any item');
  assert.deepStrictEqual([...new Set(u.by_agent['7d'].map((l) => l.role))].sort(), ['maestro', 'other', 'worker']);
  const agents = m.agents.agents;
  assert.ok(agents.some((a) => a.role === 'maestro') && agents.some((a) => a.role === 'worker' && a.task && a.task.state === 'blocked'), 'maestros and workers');
  assert.ok(agents.some((a) => a.last_activity_at && a.usage) && agents.some((a) => !a.last_activity_at), 'with and without sessions');
  assert.ok(js.includes('/api/usage') && js.includes('/api/agents'), 'the screens read the usage and agents API');
});

suite.test('Overview (#14): the demo has stale items and open pending decisions per organization, and the health of the new model', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const all = m.overview[''];
  assert.ok(all && all.active.total > 0 && all.active.organizations.length >= 3, 'active items by organization');
  assert.ok(all.stale_items.length >= 2, 'items parked on the same stage');
  assert.ok(all.pending_decisions.total >= 3 && all.pending_decisions.open.length > 0, 'open pending decisions');
  assert.ok(all.recent_events.length > 0 && all.events_today > 0, 'recent activity');
  for (const c of m.organizations) assert.strictEqual(m.overview[c.id].organization, c.id, `the Overview of ${c.id}`);
  assert.ok(m.overview.contoso.active.total < all.active.total, 'the organization narrows it');
  assert.ok(m.state.health && typeof m.state.health.level === 'string' && m.state.health.reasons.every((r) => typeof r.code === 'string'), 'health of the new model, by codes');
  assert.ok(m.state.health.reasons.some((r) => r.code === 'projects_unassigned'), 'the demo shows the projects in "Sem organização"');
  // The page reads the new model with the selector's organization and no longer the old events.
  assert.ok(/readOverview\(organizationFilter\)/.test(source['screens/Overview.jsx']), 'the Overview reads with the organization filter');
  assert.ok(!/state\.events|analysis|readEvents/.test(source['screens/Overview.jsx']), 'nothing of the old model in the Overview');
  assert.ok(js.includes('/api/overview'));
});

suite.test('Pendências (#32): the page\'s copy of the answer rules (option letters, decision limit) agrees with the server\'s', async () => {
  const domain = await import(require('url').pathToFileURL(path.join(SOURCE, 'data', 'domain.js')).href);
  // Parity between the page's copy and the server's rules (contract constants): same exception as the stages above.
  const server = require('../api-pending-decisions.js');
  assert.strictEqual(domain.MAX_DECISION, require('../../bin/flow-projection.js').MAX_PENDING_DECISION);
  for (const options of [[], ['A: Integrar', 'B: Pedir ajuste'], ['b) Um', 'a) Dois'], ['Corrigir', 'Task nova'],
    ['A: Integrar', 'Pedir ajuste', 'B: Descartar'], ['A: Um', 'A: Outro'], ['<b>A</b>', 'B: javascript:alert(1)']]) {
    assert.deepStrictEqual(domain.optionLetters(options), server.optionLetters(options), JSON.stringify(options));
  }
  assert.deepStrictEqual(server.optionLetters(['A: Integrar', 'Pedir ajuste', 'B: Descartar']), ['A', 'B', 'C'], 'no two options share a letter');
  assert.deepStrictEqual(server.optionLetters(['b) Um', 'a) Dois']), ['B', 'A'], 'their own letters when all have one');
  assert.deepStrictEqual(['A: segue o contrato.', 'B, e abrir um achado', 'A opção B', 'C: não existe'].map((r) => domain.recommendedLetter(r, ['A', 'B'])), ['A', 'B', null, null]);
  assert.strictEqual(domain.decisionText('B: Pedir ajuste', 'mantenha o nome'), 'B: Pedir ajuste — mantenha o nome');
});

suite.test('Pendências (#32): the demo has open pending decisions to answer, with and without options and of different kinds; the screen answers through the API', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const open = m.pending_decisions.pending_decisions.filter((p) => p.status === 'open');
  assert.ok(open.some((p) => p.options.length > 0) && open.some((p) => p.options.length === 0), 'open ones with and without options');
  assert.ok(new Set(open.map((p) => p.kind)).size >= 4, 'open ones of different kinds');
  const screen = source['screens/PendingDecisions.jsx'];
  assert.ok(/answerPendingDecision\(p\.id, letter, comment\)/.test(screen), 'the form sends the option and the comment');
  assert.ok(/e\.status === 409/.test(screen), 'a 409 reads the pending decision again');
  assert.ok(!/readOnlyNote/.test(screen), 'the "read only" note is gone');
  assert.ok(js.includes('/api/pending-decisions/'), 'the build calls the answer route');
});

suite.test('browser tab (#43): the title counts the open pending decisions of every organization but the hidden ones and the favicon is a data: SVG with a dot in the menu counter\'s tone', async () => {
  const href = (rel) => require('url').pathToFileURL(path.join(SOURCE, ...rel.split('/'))).href;
  const tab = await import(href('data/tab.js'));
  const dictionary = (await import(href('i18n/pt-BR.js'))).default;
  assert.strictEqual(dictionary.app.documentTitlePending, '({count}) {screen} · {panel}', 'the new key is in the pt-BR dictionary');
  // The count is kpis.pending_decisions.total of /api/state (every organization but the hidden ones, #52, like the menu
  // counter); a critical one turns the tone strong. The demo has a critical one open, so the strong dot shows there.
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const open = openVisible(m);
  assert.ok(open.some((p) => p.severity === 'critical'), 'the demo has a critical pending decision open');
  assert.deepStrictEqual(tab.openPending(m.state), { total: open.length, tone: 'strong' });
  const state = (pd) => ({ kpis: { pending_decisions: pd } });
  assert.deepStrictEqual(tab.openPending(state({ total: 2, by_severity: { normal: 1, low: 1 } })), { total: 2, tone: 'blue' });
  for (const s of [null, {}, state({ total: 0, by_severity: {} }), state(null), { kpis: 'x' }]) assert.strictEqual(tab.openPending(s), null);
  // Title: "(n) {screen} · {panel}" with n > 0, today's format with none.
  assert.strictEqual(tab.documentTitle('pending', tab.openPending(state({ total: 3, by_severity: { high: 3 } })).total), '(3) Pendências · Painel maestro');
  assert.strictEqual(tab.documentTitle('overview', 0), 'Visão geral · Painel maestro');
  // Favicon: a data: SVG, nothing external, in three variants (no dot, blue dot, strong dot).
  const icons = [null, 'blue', 'strong'].map((tone) => tab.faviconHref(tone));
  assert.strictEqual(new Set(icons).size, 3, 'three variants');
  for (const i of icons) {
    assert.ok(i.startsWith('data:image/svg+xml,'), `the favicon is data: (${i.slice(0, 30)})`);
    const svg = decodeURIComponent(i.slice('data:image/svg+xml,'.length));
    assert.ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>[\s\S]*<\/svg>$/.test(svg), 'a whole SVG');
    assert.ok(!/\b(href|src)=|url\(|<(image|script|foreignObject)\b/i.test(svg), 'nothing loaded from the SVG');
  }
  const decoded = icons.map((i) => decodeURIComponent(i));
  assert.ok(!/<circle/.test(decoded[0]), 'no dot without pending decisions');
  assert.ok(decoded[1].includes('#4F6BFF') && !decoded[1].includes('#F2555A'), 'blue dot');
  assert.ok(decoded[2].includes('#F2555A'), 'strong dot');
  // The shell (App) is the only one touching the title and the favicon, from each state read, on any screen; the
  // menu counter reads the same count.
  const app = source['app/App.jsx'];
  assert.ok(/const pending = openPending\(state\);/.test(app), 'the shell counts from the state it read');
  assert.ok(/document\.title = documentTitle\(screen, pendingTotal\)/.test(app), 'the title follows the screen and the count');
  assert.ok(/document\.querySelector\('link\[rel="icon"\]'\)/.test(app) && /\.href = faviconHref\(/.test(app), 'the shell swaps the favicon');
  assert.ok(/openPending\(state\)/.test(source['app/Sidebar.jsx']), 'the menu counter uses the same count');
  assert.strictEqual(Object.entries(source).filter(([, text]) => /document\.title =|querySelector\('link\[rel="icon"\]'\)/.test(text)).map(([f]) => f).join(), 'app/App.jsx');
  assert.ok(/<link rel="icon" href="data:,">/.test(html), 'the build keeps the empty icon until the script swaps it (no /favicon.ico request)');
});

suite.test('Pendências (#44): the demo has an open pending decision whose Maestri notification failed; the screen shows the line only for an open one with failed', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const pd = m.pending_decisions.pending_decisions;
  assert.ok(pd.some((p) => p.status === 'open' && p.notification === 'failed'), 'an open one with notification failed');
  assert.ok(pd.some((p) => p.notification === null), 'older ones, without the field, still in the demo');
  const screen = source['screens/PendingDecisions.jsx'];
  assert.ok(/p\.status === 'open' && p\.notification === 'failed' && <p\b[^>]*>\{t\('pending\.notificationFailed'\)\}<\/p>/.test(screen), 'the line only for an open one with failed; nothing once closed');
  assert.strictEqual(screen.match(/notificationFailed/g).length, 1, 'and nowhere else');
});

suite.test('browser notification (#45): the notice rule, imported from the page\'s source, notifies only the new pending decisions with the tab hidden', async () => {
  const href = (rel) => require('url').pathToFileURL(path.join(SOURCE, ...rel.split('/'))).href;
  const { pendingNotice } = await import(href('data/notification.js'));
  const p = (id, severity = 'normal') => ({ id, kind: 'decision', severity, title: `Pendência ${id}`, derived_from: null, opened_at: '2026-10-09T10:00:00-03:00', item: { key: 'widgets/12' }, task: null });
  const open = [p(1, 'high'), p(2)];
  // The first read never notifies: what was open when the page loaded is not news.
  assert.strictEqual(pendingNotice(null, open, false), null, 'first read');
  assert.strictEqual(pendingNotice(undefined, [p(9)], false), null, 'first read');
  // A visible tab never notifies: the counter and the list already show it.
  assert.strictEqual(pendingNotice([1], open, true), null, 'visible tab');
  // One new: that one; several new in the same read: a group with the count.
  assert.deepStrictEqual(pendingNotice([1], open, false), { pending: open[1] });
  assert.deepStrictEqual(pendingNotice([], [p(5, 'critical'), p(6), p(7, 'low')], false), { count: 3 });
  // One closed and another opened in the same read: only the new one counts.
  assert.deepStrictEqual(pendingNotice([1, 2], [p(1), p(3, 'low')], false), { pending: p(3, 'low') });
  // No change, fewer open ones, or none at all: nothing.
  assert.strictEqual(pendingNotice([1, 2], open, false), null, 'no change');
  assert.strictEqual(pendingNotice([1, 2], [p(2)], false), null, 'one closed');
  assert.strictEqual(pendingNotice([1, 2], [], false), null, 'all closed');
  // Every severity and kind warns, the HML one derived from flow hml included.
  const hml = { ...p(8, 'high'), kind: 'hml', title: null, derived_from: { type: 'hml-recorded', passed: 7, failed: 1, blocked: 0 } };
  assert.deepStrictEqual(pendingNotice([1], [p(1), hml], false), { pending: hml });
  assert.deepStrictEqual(pendingNotice([], [p(4, 'low')], false), { pending: p(4, 'low') });
  // A read without the list (an older server) says nothing; the ids come in any iterable.
  assert.strictEqual(pendingNotice([1], undefined, false), null);
  assert.strictEqual(pendingNotice([1], 'x', false), null);
  assert.deepStrictEqual(pendingNotice(new Set([1]), open, false), { pending: open[1] });
});

suite.test('browser notification (#45): the bell\'s states, the notification\'s texts and tag, the click; the shell is the only one touching the Notification API', async () => {
  const href = (rel) => require('url').pathToFileURL(path.join(SOURCE, ...rel.split('/'))).href;
  const n = await import(href('data/notification.js'));
  const dictionary = (await import(href('i18n/pt-BR.js'))).default;
  // The bell: not shown without the Notification API; disabled in the demo, whatever the browser says; blocked when the
  // browser denied it; on only when the owner chose it and the browser granted it.
  const bell = (o) => n.bellState({ supported: true, mock: false, permission: 'default', wanted: false, ...o });
  assert.strictEqual(bell({ supported: false, mock: true }), null);
  assert.strictEqual(bell({ mock: true, permission: 'granted', wanted: true }), 'demo');
  assert.strictEqual(bell({ permission: 'denied', wanted: true }), 'blocked');
  assert.strictEqual(bell({ permission: 'granted', wanted: true }), 'on');
  assert.strictEqual(bell({ permission: 'granted', wanted: false }), 'off');
  assert.strictEqual(bell({ permission: 'default', wanted: true }), 'off', 'the permission was reset in the browser');
  for (const state of ['off', 'on', 'blocked', 'demo']) {
    assert.ok(typeof dictionary.notification.bell[state] === 'string' && dictionary.notification.bell[state], `notification.bell.${state} in pt-BR`);
  }
  assert.ok(/indisponível na demonstração/i.test(dictionary.notification.bell.demo));
  // The notification: one pending decision shows its title, severity and item, tagged with its id; the group, the
  // count with a fixed tag. The texts come from the pt-BR dictionary.
  const item = { key: 'widgets/12', tracker_ref: '#12', title: 'Exportar relatório', project: { id: 'widgets', name: 'Widgets' } };
  const one = n.noticeContent({ pending: { id: 7, kind: 'decision', severity: 'critical', title: 'Qual formato?', derived_from: null, item, task: null } });
  assert.deepStrictEqual(one, { title: 'Qual formato?', body: 'Severidade crítica · Widgets #12 · Exportar relatório', tag: 'P-7', target: 'P-7' });
  const hml = n.noticeContent({ pending: { id: 8, kind: 'hml', severity: 'high', title: null, derived_from: { type: 'hml-recorded', passed: 7, failed: 1, blocked: 2 }, item, task: null } });
  assert.strictEqual(hml.tag, 'P-8');
  assert.ok(hml.title && hml.title !== 'null' && !/^pending\./.test(hml.title), 'the derived HML title, as the screen shows it');
  assert.deepStrictEqual(n.noticeContent({ count: 3 }), { title: '3 pendências novas', body: dictionary.notification.groupBody, tag: n.GROUP_TAG, target: null });
  assert.ok(n.GROUP_TAG && !/^P-\d/.test(n.GROUP_TAG), 'the group\'s tag never collides with a pending decision\'s');
  // The shell (App) is the only one touching the Notification API; the choice is remembered in localStorage (with try/catch).
  const touching = Object.entries(source).filter(([, text]) => /\bnew Notification\(|Notification\.requestPermission|Notification\.permission/.test(text)).map(([f]) => f);
  assert.deepStrictEqual(touching, ['app/App.jsx']);
  const app = source['app/App.jsx'];
  assert.ok(/pendingNotice\(/.test(app) && /document\.visibilityState === 'visible'/.test(app), 'the shell asks the rule at each read, with the tab\'s visibility');
  assert.ok(/tag: content\.tag/.test(app), 'the tag goes to the notification');
  assert.ok(/window\.focus\(\)/.test(app) && /goToPendingDecision\(content\.target\)/.test(app) && /goTo\('pending'\)/.test(app), 'the click focuses the tab and opens the pending decision (or the list)');
  // The Pendências screen looks for the linked one only in a read started after the link: the screen may have just
  // opened (no list yet), or its list may be older than the pending decision the notification announces.
  const pendingScreen = source['screens/PendingDecisions.jsx'];
  assert.ok(/setRead\(\{ answer, error: null, seq: mine \}\)/.test(pendingScreen), 'each read keeps its number');
  assert.ok(/if \(!pendingTarget\) return;\s+load\(\);\s+targetRead\.current = \{ target: pendingTarget, seq: seq\.current \};/.test(pendingScreen), 'the link reads the list again');
  assert.ok(/read\.seq >= wait\.seq/.test(pendingScreen) && /\}, \[read\]\);/.test(pendingScreen), 'the lookup waits for that read');
  // Out of the list (the selector's organization or the screen's filters, P-440): read without them, every status, and
  // shown anyway, kept like one closed meanwhile; "not in the list" only when it does not exist. The link never touches
  // the selector nor the filters.
  assert.ok(/readPendingDecisions\(params\(\{ status: 'all', severity: null \}, null\)\)/.test(pendingScreen), 'the read without the selector nor the filters');
  const link = /useEffect\(\(\) => \{\s+const wait = targetRead\.current;[\s\S]*?\}, \[read\]\);/.exec(pendingScreen);
  assert.ok(link, 'the link\'s lookup');
  assert.ok(/readAnywhere\(id\)\.then\(\(p\) => \{[\s\S]*if \(!p\) \{ setActionStatus\(t\('pending\.notInList'/.test(link[0]) && /setKept\(p\);\s+show\(p, false\);/.test(link[0]),
    'out of the list it is read without filters and kept; not in the list only when it does not exist');
  assert.ok(!/setFilters|setOrganization|organizationFilter|change\(/.test(link[0]), 'the link changes neither the selector nor the filters');
  assert.ok(/if \(!now && open\.outside\) onOutside\.current\(open\.id\);/.test(pendingScreen), 'an open one outside the list is read again by itself, never taken for closed');
  assert.ok(/const now = await readAnywhere\(id\);\s+if \(now\) \{ setKept\(now\); setChosen\(id\); \}/.test(pendingScreen), 'closed meanwhile is read without filters too');
  assert.ok(/Notification\.requestPermission/.test(app) && /onClick=\{toggleBell\}/.test(source['app/Header.jsx']), 'the permission comes only from the bell\'s click');
  const storage = source['data/notification.js'];
  assert.ok(/localStorage\.getItem/.test(storage) && /localStorage\.setItem/.test(storage) && (storage.match(/try \{/g) || []).length >= 2, 'the choice is remembered, in a try/catch');
  assert.ok(/mock: MOCK/.test(app), 'the demo state comes from MOCK');
  // The bell sits in the header, beside the health badge, and is not drawn without the Notification API.
  const header = source['app/Header.jsx'];
  assert.ok(/BellRing/.test(header) && /BellOff/.test(header), 'the bell icons');
  assert.ok(/bell &&/.test(header), 'no bell without the Notification API');
  assert.ok(/disabled=\{bell === 'demo'\}/.test(header), 'disabled in the demo');
  // The demo has the open list on /api/state, with a critical one, by the generator (the server's function); the hidden
  // organization's open one is not there, so it never notifies (#52).
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-items.json'), 'utf8'));
  const kp = m.state.kpis.pending_decisions;
  const open = openVisible(m);
  assert.deepStrictEqual(kp.open.map((p) => p.id), open.map((p) => p.id), 'every open pending decision of the demo but the hidden organization\'s, in the server\'s order');
  assert.deepStrictEqual(Object.keys(kp.open[0]), ['id', 'kind', 'severity', 'title', 'derived_from', 'opened_at', 'item', 'task']);
  assert.ok(kp.open.some((p) => p.severity === 'critical'));
  // Answering in the demo takes the pending decision out of the list too.
  assert.ok(/counter\.open = arr\(counter\.open\)\.filter/.test(source['data/mock.js']), 'the demo\'s answer drops it from open');
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
  const { open: stOpen, ...counter } = st.kpis.pending_decisions;
  assert.deepStrictEqual(counter, { total: kp.total + 1, by_severity: { ...kp.by_severity, critical: kp.by_severity.critical + 1 } });
  assert.strictEqual(stOpen.length, kp.total + 1, 'the open list (#45) has the hostile one too');
  assert.ok(stOpen[0].title.includes('onerror'), 'the hostile critical one arrives raw, first (the notification shows it as text)');
  assert.ok(stOpen.every((x) => !mock.organizations.find((c) => c.id === x.item.project.organization.id).hidden), 'none of the hidden organization (#52)');
  // This root has no bruto.db: besides the projects in "Sem organização", the badge says the hook never wrote.
  assert.deepStrictEqual(st.health.reasons.map((r) => r.code).sort(), ['hook_never', 'projects_unassigned']);

  // The lists the screens read: the demo's answers, plus the hostile item. The file has the hidden organization's items and
  // pending decisions too (the mock leaves them out); the server leaves them out of its lists (#51).
  const hiddenIds = new Set(mock.organizations.filter((c) => c.hidden).map((c) => c.id));
  const visible = (list, project) => list.filter((x) => !hiddenIds.has(project(x).organization.id));
  const items = (await get('/api/items')).items;
  assert.strictEqual(items.length, visible(mock.items, (x) => x.project).length + 1);
  for (const it of visible(mock.items, (x) => x.project)) assert.ok(items.some((x) => x.key === it.key && x.stage === it.stage), `item ${it.key}`);
  assert.ok(!items.some((x) => hiddenIds.has(x.project.organization.id)), 'no item of the hidden organization');
  const hiddenItem = mock.items.find((x) => hiddenIds.has(x.project.organization.id));
  assert.strictEqual((await get(`/api/items/${hiddenItem.project.id}/${hiddenItem.number}`)).item.key, hiddenItem.key, 'its page answers by the key');
  const ov = await get('/api/overview');
  assert.strictEqual(ov.active.total, mock.overview[''].active.total + 1);
  // The register: the mock has every organization (?hidden=include); the plain list leaves the hidden one out (#50).
  const register = (await get('/api/organizations?hidden=include')).organizations;
  // The hostile item (portal, of Contoso) adds one open pending decision there.
  const hostileOrganization = mock.projects.find((x) => x.id === 'portal').organization.id;
  assert.deepStrictEqual(register.map((c) => [c.id, c.hidden, c.project_count, c.open_pending_count]),
    mock.organizations.map((c) => [c.id, c.hidden, c.project_count, c.open_pending_count + (c.id === hostileOrganization ? 1 : 0)]));
  assert.ok(register.some((c) => c.hidden && c.open_pending_count > 0), 'a hidden organization with an open pending decision');
  assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => c.id), mock.organizations.filter((c) => !c.hidden).map((c) => c.id));
  assert.deepStrictEqual((await get('/api/projects?hidden=include')).projects.map((x) => x.id), mock.projects.map((x) => x.id));
  const pd = (await get('/api/pending-decisions')).pending_decisions;
  assert.strictEqual(pd.length, visible(mock.pending_decisions.pending_decisions, (x) => x.item.project).length + 1);
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

  // The demo's open pending decisions can be answered with the real server (#32): with an option, and only with a comment.
  const post = (id, body) => request(port, `/api/pending-decisions/P-${id}/answer`, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const withOptions = pd.find((x) => x.status === 'open' && x.options.length && !x.title.includes('onerror'));
  const withoutOptions = pd.find((x) => x.status === 'open' && !x.options.length);
  const a = await post(withOptions.id, { option: 'A', text: 'ok' });
  assert.deepStrictEqual([a.status, a.json.status, a.json.decision, a.json.closed_by], [200, 'resolved', `${withOptions.options[0]} — ok`, { role: 'owner', name: null }]);
  const b = await post(withoutOptions.id, { text: 'Meu carrinho' });
  assert.deepStrictEqual([b.status, b.json.decision], [200, 'Meu carrinho']);
  assert.strictEqual((await post(withOptions.id, { option: 'B' })).status, 409);

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
