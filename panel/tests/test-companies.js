'use strict';
// Tests for companies and projects (#6) through the agreed seam only: the bin/flow.js CLI runs as a process (inside
// temporary git repositories with fictitious remotes) → temporary maestro.db (MAESTRO_DIR) → the server's HTTP API.
// No test reads the database or calls internal functions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('companies and projects: flow CLI → maestro.db → API');
const roots = [];

const CIDAX_API = 'https://contoso@dev.azure.com/contoso/CIDAX/_git/cidax-api';
const CIDAX_WEB = 'git@ssh.dev.azure.com:v3/contoso/CIDAX/cidax-web';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder (MAESTRO_DIR), a folder outside any repository and repositories created on demand. */
function buildRoot(name) {
  const root = tmpDir(`companies-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  return { root, data, outside };
}

/** A git repository in <root>/<name> whose origin is remote. */
function repo(r, name, remote) {
  const dir = path.join(r.root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

/** Runs the CLI; by default in a folder outside any repository (the ceiling stops git from climbing to this one). */
function flow(r, args, { cwd = r.outside, input } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', GIT_CEILING_DIRECTORIES: r.root });
  return spawnSync(process.execPath, [FLOW, ...args], { cwd, env, input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function ok(x) {
  assert.strictEqual(x.status, 0, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.strictEqual(x.stderr, '', 'nothing on stderr');
  return x.stdout;
}

function invalid(x, message) {
  assert.strictEqual(x.status, 2, `exit ${x.status}\nstdout: ${x.stdout}\nstderr: ${x.stderr}`);
  assert.ok(x.stderr.startsWith('erro: '), x.stderr);
  if (message) assert.ok(message.test(x.stderr), x.stderr);
}

async function withServer(r, fn) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri') },
  });
  try {
    await fn({
      port,
      get: async (p) => {
        const x = await request(port, p);
        assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
        return x.json;
      },
    });
  } finally {
    await s.stop();
  }
}

suite.test('an Azure DevOps project with two repositories is a single project: the CLI resolves it from either one', async () => {
  const r = buildRoot('azure');
  const api = repo(r, 'cidax-api', CIDAX_API);
  const web = repo(r, 'cidax-web', CIDAX_WEB);
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'cidax', '--name', 'CIDAX', '--company', 'contoso', '--tracker', 'azure_devops',
    '--repo', CIDAX_API, '--repo', 'https://dev.azure.com/contoso/CIDAX/_git/cidax-web', '--done-state', 'Committed', '--workspace', 'CIDAX']));
  ok(flow(r, ['item', 'start', '3100', '--title', 'Conciliação de boletos'], { cwd: api }));
  ok(flow(r, ['stage', '3100', 'implementation'], { cwd: web }));
  await withServer(r, async ({ get }) => {
    const { projects } = await get('/api/projects');
    assert.strictEqual(projects.length, 1, JSON.stringify(projects));
    const p = projects[0];
    assert.deepStrictEqual([p.id, p.name, p.tracker, p.company, p.done_state, p.maestri_workspace],
      ['cidax', 'CIDAX', 'azure_devops', { id: 'contoso', name: 'Contoso' }, 'Committed', 'CIDAX']);
    assert.deepStrictEqual(p.repos, ['dev.azure.com/contoso/cidax/_git/cidax-api', 'dev.azure.com/contoso/cidax/_git/cidax-web']);
    const { items } = await get('/api/items');
    assert.deepStrictEqual(items.map((i) => [i.key, i.stage, i.project.company.id]), [['cidax/3100', 'implementation', 'contoso']]);
  });
});

suite.test('the stages a project declares are the only ones its items may take: another one is refused with exit 2', async () => {
  const r = buildRoot('stages');
  const widgets = repo(r, 'widgets', 'https://github.com/acme/widgets.git');
  ok(flow(r, ['company', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'widgets', '--company', 'personal', '--stages', 'implementation,pr_ready,merge,done,specification'], { cwd: widgets }));
  ok(flow(r, ['item', 'start', '12', '--title', 'Sem HML'], { cwd: widgets }));
  invalid(flow(r, ['stage', '12', 'hml_validation'], { cwd: widgets }), /não usa a etapa "hml_validation"/);
  invalid(flow(r, ['item', 'start', '13', '--title', 'x', '--stage', 'final_adjustment'], { cwd: widgets }), /não usa a etapa/);
  ok(flow(r, ['stage', '12', 'pr_ready'], { cwd: widgets }));
  // The owner starts using HML validation in the project: from then on it is accepted.
  ok(flow(r, ['project', 'edit', 'widgets', '--stages', 'specification,implementation,pr_ready,merge,hml_validation,done']));
  ok(flow(r, ['stage', '12', 'hml_validation'], { cwd: widgets }));
  await withServer(r, async ({ get }) => {
    const { projects } = await get('/api/projects');
    assert.deepStrictEqual(projects[0].stages, ['specification', 'implementation', 'pr_ready', 'merge', 'hml_validation', 'done']);
    assert.deepStrictEqual(projects[0].repos, ['github.com/acme/widgets'], 'project add without --repo takes the current folder\'s remote');
    assert.deepStrictEqual(projects[0].company, { id: 'personal', name: 'Pessoal' });
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'hml_validation');
    assert.deepStrictEqual(item.stages.map((s) => s.id), ['specification', 'implementation', 'pr_ready', 'merge', 'hml_validation', 'done']);
    assert.deepStrictEqual(item.timeline.map((e) => e.payload.stage), ['specification', 'pr_ready', 'hml_validation']);
  });
});

suite.test('the items API filters by company and by project', async () => {
  const r = buildRoot('filters');
  const shop = repo(r, 'shop', 'https://github.com/fabrikam/shop.git');
  const api = repo(r, 'cidax-api', CIDAX_API);
  const mine = repo(r, 'mine', 'git@github.com:higor/painel.git');
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['company', 'add', 'fabrikam', '--name', 'Fabrikam']));
  ok(flow(r, ['company', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'shop', '--name', 'Loja', '--company', 'fabrikam'], { cwd: shop }));
  ok(flow(r, ['project', 'add', 'cidax', '--company', 'contoso', '--repo', CIDAX_API]));
  ok(flow(r, ['project', 'add', 'painel', '--company', 'personal', '--repo', 'https://github.com/higor/painel']));
  ok(flow(r, ['item', 'start', '48', '--title', 'Carrinho'], { cwd: shop }));
  ok(flow(r, ['item', 'start', '52', '--title', 'Cupom', '--stage', 'implementation'], { cwd: shop }));
  ok(flow(r, ['item', 'start', '3100', '--title', 'Boletos'], { cwd: api }));
  ok(flow(r, ['item', 'start', '5', '--title', 'Painel'], { cwd: mine }));
  await withServer(r, async ({ port, get }) => {
    const keys = async (q) => (await get(`/api/items${q}`)).items.map((i) => i.key).sort();
    assert.deepStrictEqual(await keys(''), ['cidax/3100', 'painel/5', 'shop/48', 'shop/52']);
    assert.deepStrictEqual(await keys('?company=fabrikam'), ['shop/48', 'shop/52']);
    assert.deepStrictEqual(await keys('?company=personal'), ['painel/5']);
    assert.deepStrictEqual(await keys('?project=cidax'), ['cidax/3100']);
    assert.deepStrictEqual(await keys('?company=contoso&project=shop'), []);
    assert.deepStrictEqual(await keys('?company=nobody'), []);
    const bad = await request(port, '/api/items?company=..%2Fx');
    assert.deepStrictEqual([bad.status, bad.json.error.code, bad.json.error.param], [400, 'invalid_filter', 'company']);
    // Stage and tracker (#1: "itens com filtros (empresa, projeto, etapa, tracker)"), alone or together.
    assert.deepStrictEqual(await keys('?tracker=azure_devops'), ['cidax/3100']);
    assert.deepStrictEqual(await keys('?tracker=github'), ['painel/5', 'shop/48', 'shop/52']);
    assert.deepStrictEqual(await keys('?stage=implementation'), ['shop/52']);
    assert.deepStrictEqual(await keys('?stage=specification&tracker=github&company=fabrikam'), ['shop/48']);
    assert.deepStrictEqual(await keys('?stage=done'), []);
    for (const [q, param] of [['stage=voando', 'stage'], ['tracker=gitlab', 'tracker'], ['stage=', null]]) {
      const x = await request(port, `/api/items?${q}`);
      if (!param) { assert.strictEqual(x.status, 200, q); continue; }
      assert.deepStrictEqual([x.status, x.json.error.code, x.json.error.param], [400, 'invalid_filter', param], q);
    }
    const { companies } = await get('/api/companies');
    assert.deepStrictEqual(companies.map((c) => [c.id, c.name, c.project_count, c.item_count]),
      [['contoso', 'Contoso', 1, 1], ['fabrikam', 'Fabrikam', 1, 2], ['personal', 'Pessoal', 1, 1]]);
    assert.deepStrictEqual((await get('/api/projects?company=fabrikam')).projects.map((p) => [p.id, p.name, p.item_count]), [['shop', 'Loja', 2]]);
  });
});

suite.test('a repository without register lands in "Sem empresa"; the panel moves it to a company, with the POST rules', async () => {
  const r = buildRoot('move');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  ok(flow(r, ['company', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  await withServer(r, async ({ port, get }) => {
    assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => [c.id, c.name, c.unassigned, c.project_count]),
      [['personal', 'Pessoal', false, 0], ['unassigned', 'Sem empresa', true, 1]]);
    const before = (await get('/api/projects')).projects;
    assert.deepStrictEqual(before.map((p) => [p.id, p.company.id, p.unassigned, p.item_count]), [['scratch', 'unassigned', true, 1]]);
    const move = (headers, body, p = '/api/projects/scratch/company') => request(port, p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const body = JSON.stringify({ company: 'personal' });
    // Security: X-Panel, Origin and Host, exactly as every POST of the server.
    assert.deepStrictEqual([(await move({}, body)).status, (await move({}, body)).json.error.code], [403, 'missing_panel_header']);
    const foreign = await move({ 'X-Panel': '1', Origin: 'http://evil.example' }, body);
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const host = await request(port, '/api/projects/scratch/company', { method: 'POST', host: 'evil.example', headers: { 'X-Panel': '1' }, body });
    assert.strictEqual(host.status, 403);
    assert.strictEqual((await get('/api/projects')).projects[0].company.id, 'unassigned', 'nothing moved by a refused POST');
    // Invalid requests.
    const get405 = await request(port, '/api/projects/scratch/company');
    assert.deepStrictEqual([get405.status, get405.json.error.code], [405, 'method_not_allowed']);
    for (const [b, code] of [['{', 'json_object_required'], ['[1]', 'json_object_required'], ['{"company":"A B"}', 'invalid_field'], ['{"company":"nobody"}', 'company_not_found']]) {
      const x = await move({ 'X-Panel': '1' }, b);
      assert.deepStrictEqual([b, x.status, x.json.error.code], [b, 400, code]);
    }
    const missing = await move({ 'X-Panel': '1' }, body, '/api/projects/nothing/company');
    assert.deepStrictEqual([missing.status, missing.json.error.code], [404, 'project_not_found']);
    // The move itself, from the page's origin.
    const moved = await move({ 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` }, body);
    assert.strictEqual(moved.status, 200, moved.text);
    assert.deepStrictEqual([moved.json.project.id, moved.json.project.company, moved.json.project.unassigned], ['scratch', { id: 'personal', name: 'Pessoal' }, false]);
    assert.deepStrictEqual((await get('/api/items?company=personal')).items.map((i) => i.key), ['scratch/3']);
    assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => [c.id, c.project_count]), [['personal', 1], ['unassigned', 0]]);
  });
  // The CLI keeps resolving the project from the repository, now in its company.
  ok(flow(r, ['stage', '3', 'implementation'], { cwd: scratch }));
  assert.ok(/scratch\s+scratch · Pessoal · GitHub/.test(ok(flow(r, ['project', 'list']))));
});

suite.test('"Sem empresa" is never a destination of a move: the API answers 400 company_reserved and the CLI exits 2', async () => {
  const r = buildRoot('reserved');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  const reserved = /"Sem empresa" é reservada: .*não é destino de mover/;
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['company', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'shop', '--company', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  // Refused before "Sem empresa" exists in the register and after a repository lands there.
  invalid(flow(r, ['project', 'move', 'shop', 'unassigned']), reserved);
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  invalid(flow(r, ['project', 'move', 'shop', 'unassigned']), reserved);
  invalid(flow(r, ['project', 'move', '--json', '-'], { input: JSON.stringify({ id: 'shop', company: 'unassigned' }) }), reserved);
  invalid(flow(r, ['project', 'edit', 'shop', '--company', 'unassigned']), reserved);
  invalid(flow(r, ['project', 'move', 'scratch', 'unassigned']), reserved);
  invalid(flow(r, ['project', 'move', 'shop', 'nobody']), /a empresa "nobody" não existe \(empresas: contoso, personal, unassigned\)/);
  await withServer(r, async ({ port, get }) => {
    const move = (id, company) => request(port, `/api/projects/${id}/company`, {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ company }),
    });
    const where = async () => (await get('/api/projects')).projects.map((p) => [p.id, p.company.id]);
    for (const id of ['shop', 'scratch']) {
      const x = await move(id, 'unassigned');
      assert.deepStrictEqual([id, x.status, x.json.error], [id, 400, { code: 'company_reserved', company: 'unassigned' }]);
    }
    assert.deepStrictEqual(await where(), [['scratch', 'unassigned'], ['shop', 'contoso']], 'nothing moved by a refused move');
    // Moving between companies keeps working, by the panel and by the CLI.
    const moved = await move('shop', 'personal');
    assert.deepStrictEqual([moved.status, moved.json.project.company], [200, { id: 'personal', name: 'Pessoal' }], moved.text);
    assert.ok(/Projeto "scratch" movido de "Sem empresa" para "Contoso"/.test(ok(flow(r, ['project', 'move', 'scratch', 'contoso']))));
    assert.deepStrictEqual(await where(), [['scratch', 'contoso'], ['shop', 'personal']]);
    assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => [c.id, c.project_count, c.item_count]),
      [['contoso', 1, 1], ['personal', 1, 0], ['unassigned', 0, 0]]);
  });
});

suite.test('the CLI lists companies and projects, moves a project and edits its register', async () => {
  const r = buildRoot('cli');
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['company', 'add', '--json', '-'], { input: JSON.stringify({ id: 'personal', name: 'Pessoal' }) }));
  ok(flow(r, ['project', 'add', '--json', '-'], { input: JSON.stringify({ id: 'cidax', name: 'CIDAX', company: 'personal', repos: [CIDAX_API], done_state: 'Committed' }) }));
  assert.ok(/Projeto "cidax" movido de "Pessoal" para "Contoso"/.test(ok(flow(r, ['project', 'move', 'cidax', 'contoso']))));
  ok(flow(r, ['project', 'edit', 'cidax', '--repo', CIDAX_WEB, '--workspace', 'CIDAX', '--name', 'CIDAX Portal']));
  ok(flow(r, ['project', 'edit', 'cidax', '--remove-repo', 'https://dev.azure.com/contoso/CIDAX/_git/cidax-api', '--done-state', '']));
  const companies = ok(flow(r, ['company', 'list']));
  assert.ok(/contoso\s+Contoso · 1 projeto\b/.test(companies) && /personal\s+Pessoal · 0 projetos/.test(companies), companies);
  const projects = ok(flow(r, ['project', 'list', '--company', 'contoso']));
  assert.ok(/cidax\s+CIDAX Portal · Contoso · Azure DevOps · etapas: specification, /.test(projects), projects);
  assert.ok(/workspace do Maestri: CIDAX/.test(projects) && !/concluído no tracker/.test(projects), projects);
  assert.ok(/repositório: dev\.azure\.com\/contoso\/cidax\/_git\/cidax-web/.test(projects) && !/cidax-api/.test(projects), projects);
  await withServer(r, async ({ get }) => {
    const [p] = (await get('/api/projects')).projects;
    assert.deepStrictEqual([p.name, p.company.id, p.repos, p.done_state, p.maestri_workspace],
      ['CIDAX Portal', 'contoso', ['dev.azure.com/contoso/cidax/_git/cidax-web'], null, 'CIDAX']);
  });
});

suite.test('invalid company and project data end with a clear message and exit 2, changing nothing', async () => {
  const r = buildRoot('invalid');
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'cidax', '--company', 'contoso', '--repo', CIDAX_API]));
  ok(flow(r, ['project', 'add', 'shop', '--company', 'contoso', '--repo', 'https://github.com/fabrikam/shop']));
  const cases = [
    [['company'], /falta o subcomando/],
    [['company', 'delete', 'x'], /subcomando desconhecido: "company delete"/],
    [['company', 'add', 'contoso', '--name', 'Outra'], /a empresa "contoso" já existe/],
    [['company', 'add', 'Bad Id', '--name', 'x'], /id de empresa inválido: "Bad Id"/],
    [['company', 'add', 'fabrikam'], /falta o nome da empresa/],
    [['project', 'add', 'loja', '--repo', 'https://github.com/x/loja'], /falta a empresa do projeto/],
    [['project', 'add', 'loja', '--company', 'nobody', '--repo', 'https://github.com/x/loja'], /a empresa "nobody" não existe/],
    [['project', 'add', 'cidax', '--company', 'contoso', '--repo', 'https://github.com/x/y'], /o projeto "cidax" já existe/],
    [['project', 'add', 'loja', '--company', 'contoso'], /falta o repositório do projeto/],
    [['project', 'add', 'loja', '--company', 'contoso', '--repo', CIDAX_WEB, '--tracker', 'github'], /é do Azure DevOps, mas o projeto usa o GitHub/],
    [['project', 'add', 'loja', '--company', 'contoso', '--repo', 'https://github.com/fabrikam/shop.git'], /já é do projeto "shop"/],
    [['project', 'add', 'loja', '--company', 'contoso', '--repo', 'https://github.com/x/loja', '--tracker', 'gitlab'], /tracker inválido: "gitlab"/],
    [['project', 'add', 'loja', '--company', 'contoso', '--repo', 'https://github.com/x/loja', '--stages', 'implementation,review'], /etapa desconhecida: "review"/],
    [['project', 'add', 'loja', '--company', 'contoso', '--repo', 'https://github.com/x/loja', '--stages', ','], /ao menos uma etapa/],
    [['project', 'edit', 'nothing', '--name', 'x'], /o projeto "nothing" não existe/],
    [['project', 'edit', 'cidax'], /nada para mudar/],
    [['project', 'edit', 'cidax', '--remove-repo', CIDAX_API], /precisa de ao menos um repositório/],
    [['project', 'edit', 'cidax', '--remove-repo', CIDAX_WEB], /não é do projeto "cidax"/],
    [['project', 'edit', 'shop', '--tracker', 'azure_devops'], /é do GitHub, mas o projeto usa o Azure DevOps/],
    [['project', 'move', 'cidax'], /falta o id da empresa/],
    [['project', 'move', 'cidax', 'nobody'], /a empresa "nobody" não existe/],
    [['project', 'list', '--company', 'nobody'], /a empresa "nobody" não existe/],
  ];
  for (const [args, message] of cases) invalid(flow(r, args, { input: '' }), message);
  await withServer(r, async ({ get }) => {
    const { projects } = await get('/api/projects');
    assert.deepStrictEqual(projects.map((p) => [p.id, p.tracker, p.company.id, p.repos]), [
      ['cidax', 'azure_devops', 'contoso', ['dev.azure.com/contoso/cidax/_git/cidax-api']],
      ['shop', 'github', 'contoso', ['github.com/fabrikam/shop']],
    ]);
    assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => c.id), ['contoso']);
  });
});

suite.test('the panel creates a company (POST /api/companies) under the name rule of the store, which the CLI shares', async () => {
  const r = buildRoot('create');
  // The server starts before maestro.db exists: the first company creates it.
  await withServer(r, async ({ port, get }) => {
    assert.deepStrictEqual((await get('/api/companies')).companies, []);
    const create = (body, headers = { 'X-Panel': '1' }) => request(port, '/api/companies', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const ids = async () => (await get('/api/companies')).companies.map((c) => [c.id, c.name]);
    // Security: X-Panel and Origin, exactly as every POST of the server.
    const without = await create({ id: 'contoso', name: 'Contoso' }, {});
    assert.deepStrictEqual([without.status, without.json], [403, { error: { code: 'missing_panel_header', header: 'X-Panel' } }]);
    const foreign = await create({ id: 'contoso', name: 'Contoso' }, { 'X-Panel': '1', Origin: 'http://evil.example' });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const tooLarge = await create(JSON.stringify({ id: 'contoso', name: 'x'.repeat(17 * 1024) }));
    assert.deepStrictEqual([tooLarge.status, tooLarge.json.error.code], [413, 'body_too_large']);
    for (const body of ['[1]', { id: 'Bad Id', name: 'Contoso' }, { id: 'contoso', name: ' ' }]) {
      assert.strictEqual((await create(body)).status, 400, JSON.stringify(body));
    }
    assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'an invalid POST does not create maestro.db');
    assert.deepStrictEqual(await ids(), [], 'nothing created by a refused POST');
    // The creation, from the page's origin: 201 with the company as GET /api/companies lists it; the name is trimmed.
    const created = await create({ id: 'contoso', name: '  Contoso  ' }, { 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` });
    assert.strictEqual(created.status, 201, created.text);
    const listed = (await get('/api/companies')).companies;
    assert.deepStrictEqual(created.json, { company: { id: 'contoso', name: 'Contoso', unassigned: false, project_count: 0, item_count: 0 } });
    assert.deepStrictEqual(listed, [created.json.company]);
    // Invalid bodies, ids and names: 400 with the field; an id in use or a name in use (ignoring case): 409.
    const cases = [
      ['{', 400, { code: 'json_object_required' }],
      ['[1]', 400, { code: 'json_object_required' }],
      ['"contoso"', 400, { code: 'json_object_required' }],
      [{ name: 'Fabrikam' }, 400, { code: 'invalid_field', field: 'id', value: '' }],
      [{ id: 'Fabrikam Ltda', name: 'Fabrikam' }, 400, { code: 'invalid_field', field: 'id', value: 'Fabrikam Ltda' }],
      [{ id: `f${'a'.repeat(80)}`, name: 'Fabrikam' }, 400, { code: 'invalid_field', field: 'id', value: `f${'a'.repeat(80)}` }],
      [{ id: 'fabrikam' }, 400, { code: 'invalid_field', field: 'name', value: '', max: 80 }],
      [{ id: 'fabrikam', name: '' }, 400, { code: 'invalid_field', field: 'name', value: '', max: 80 }],
      [{ id: 'fabrikam', name: '   ' }, 400, { code: 'invalid_field', field: 'name', value: '   ', max: 80 }],
      [{ id: 'fabrikam', name: 42 }, 400, { code: 'invalid_field', field: 'name', value: '42', max: 80 }],
      [{ id: 'fabrikam', name: 'Fabrikam\nLtda' }, 400, { code: 'invalid_field', field: 'name', value: 'Fabrikam\nLtda', max: 80 }],
      [{ id: 'fabrikam', name: 'F'.repeat(81) }, 400, { code: 'invalid_field', field: 'name', value: 'F'.repeat(81), max: 80 }],
      [{ id: 'contoso', name: 'Outra' }, 409, { code: 'company_exists', company: 'contoso', name: 'Contoso' }],
      // "Sem empresa" is not registered yet, but its id is reserved.
      [{ id: 'unassigned', name: 'Outra' }, 409, { code: 'company_exists', company: 'unassigned' }],
      [{ id: 'contoso-br', name: ' CONTOSO ' }, 409, { code: 'company_name_taken', name: 'CONTOSO', company: 'contoso', company_name: 'Contoso' }],
    ];
    for (const [body, status, error] of cases) {
      const x = await create(body);
      assert.deepStrictEqual([body, x.status, x.json], [body, status, { error }]);
    }
    assert.deepStrictEqual(await ids(), [['contoso', 'Contoso']], 'nothing created by an invalid body');
    // 80 characters is the limit; ids of 80 characters too.
    const longest = await create({ id: `f${'a'.repeat(79)}`, name: 'F'.repeat(80) });
    assert.strictEqual(longest.status, 201, longest.text);
    // The route keeps answering GET and refuses other methods.
    const put = await request(port, '/api/companies', { method: 'PUT', headers: { 'X-Panel': '1' } });
    assert.deepStrictEqual([put.status, put.json.error.code, put.json.error.allowed], [405, 'method_not_allowed', ['GET', 'HEAD', 'POST']]);
  });
  // The CLI applies the same rule: a name in use ignoring case, empty or too long exits 2 with a Portuguese message.
  invalid(flow(r, ['company', 'add', 'contoso-br', '--name', 'contoso']), /o nome "contoso" já é da empresa "contoso" \(Contoso\)/);
  invalid(flow(r, ['company', 'add', '--json', '-'], { input: JSON.stringify({ id: 'contoso-br', name: 'CONTOSO' }) }), /o nome "CONTOSO" já é da empresa "contoso"/);
  invalid(flow(r, ['company', 'add', 'fabrikam', '--name', 'F'.repeat(81)]), /o nome da empresa precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['company', 'add', 'fabrikam', '--name', '   ']), /o nome da empresa precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['company', 'add', 'unassigned', '--name', 'Outra']), /a empresa "unassigned" já existe \(reservada para "Sem empresa"\)/);
  assert.ok(/Empresa "fabrikam" \(Fabrikam\) cadastrada/.test(ok(flow(r, ['company', 'add', 'fabrikam', '--name', '  Fabrikam ']))));
  // The company the panel created is a company like the others for the CLI.
  ok(flow(r, ['project', 'add', 'shop', '--company', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => [c.id, c.name, c.project_count]),
      [['contoso', 'Contoso', 1], ['fabrikam', 'Fabrikam', 0], [`f${'a'.repeat(79)}`, 'F'.repeat(80), 0]]);
  });
});

suite.test('the panel and the CLI remove an empty company only (POST /api/companies/<id>/remove, flow company remove)', async () => {
  const r = buildRoot('remove');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  // Before maestro.db exists there is no company to remove (and the POST does not create the database).
  await withServer(r, async ({ port }) => {
    const x = await request(port, '/api/companies/contoso/remove', { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.deepStrictEqual([x.status, x.json], [404, { error: { code: 'company_not_found', company: 'contoso' } }]);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'a refused removal does not create maestro.db');
  for (const [id, name] of [['contoso', 'Contoso'], ['fabrikam', 'Fabrikam'], ['personal', 'Pessoal'], ['northwind', 'Northwind']]) {
    ok(flow(r, ['company', 'add', id, '--name', name]));
  }
  ok(flow(r, ['project', 'add', 'shop', '--company', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  ok(flow(r, ['project', 'add', 'site', '--company', 'contoso', '--repo', 'https://github.com/contoso/site']));
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  await withServer(r, async ({ port, get }) => {
    const remove = (id, headers = { 'X-Panel': '1' }, method = 'POST') => request(port, `/api/companies/${id}/remove`, { method, headers });
    const ids = async () => (await get('/api/companies')).companies.map((c) => c.id);
    const all = ['contoso', 'fabrikam', 'northwind', 'personal', 'unassigned'];
    assert.deepStrictEqual(await ids(), all);
    // Security: X-Panel and Origin, exactly as every POST of the server; only POST.
    const without = await remove('fabrikam', {});
    assert.deepStrictEqual([without.status, without.json], [403, { error: { code: 'missing_panel_header', header: 'X-Panel' } }]);
    const foreign = await remove('fabrikam', { 'X-Panel': '1', Origin: 'http://evil.example' });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const get405 = await remove('fabrikam', {}, 'GET');
    assert.deepStrictEqual([get405.status, get405.json.error.code, get405.json.error.allowed], [405, 'method_not_allowed', ['POST']]);
    // The rules of the store: with projects (409 with the count), "Sem empresa" (400), unknown (404); an id outside the
    // format is no route at all.
    const cases = [
      ['contoso', 409, { code: 'company_not_empty', company: 'contoso', name: 'Contoso', project_count: 2 }],
      ['unassigned', 400, { code: 'company_reserved', company: 'unassigned' }],
      ['nobody', 404, { code: 'company_not_found', company: 'nobody' }],
    ];
    for (const [id, status, error] of cases) {
      const x = await remove(id);
      assert.deepStrictEqual([id, x.status, x.json], [id, status, { error }]);
    }
    assert.strictEqual((await remove('Bad%20Id')).status, 404);
    assert.deepStrictEqual(await ids(), all, 'nothing removed by a refused POST');
    // The removal, from the page's origin: 200 { removed }, and the company leaves the lists.
    const removed = await remove('fabrikam', { 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` });
    assert.deepStrictEqual([removed.status, removed.json], [200, { removed: 'fabrikam' }], removed.text);
    assert.deepStrictEqual(await ids(), ['contoso', 'northwind', 'personal', 'unassigned']);
    const again = await remove('fabrikam');
    assert.deepStrictEqual([again.status, again.json.error.code], [404, 'company_not_found']);
    // A screen out of date: a project moved to "Pessoal" by the CLI while the page still shows it empty is refused.
    ok(flow(r, ['project', 'move', 'site', 'personal']));
    const stale = await remove('personal');
    assert.deepStrictEqual([stale.status, stale.json.error], [409, { code: 'company_not_empty', company: 'personal', name: 'Pessoal', project_count: 1 }]);
    // A removed company frees its id and its name.
    const created = await request(port, '/api/companies', {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'fabrikam', name: 'Fabrikam' }),
    });
    assert.strictEqual(created.status, 201, created.text);
  });
  // The CLI applies the same rules: exit 2 with a Portuguese message (with the count of projects when not empty).
  invalid(flow(r, ['company', 'remove', 'contoso']), /a empresa "contoso" \(Contoso\) tem 1 projeto: mova-o antes/);
  invalid(flow(r, ['company', 'remove', 'personal']), /a empresa "personal" \(Pessoal\) tem 1 projeto/);
  ok(flow(r, ['project', 'move', 'site', 'contoso']));
  invalid(flow(r, ['company', 'remove', 'contoso']), /a empresa "contoso" \(Contoso\) tem 2 projetos: mova-os antes/);
  invalid(flow(r, ['company', 'remove', '--json', '-'], { input: JSON.stringify({ id: 'contoso' }) }), /tem 2 projetos/);
  invalid(flow(r, ['company', 'remove', 'unassigned']), /"Sem empresa" é reservada: .*não se exclui/);
  invalid(flow(r, ['company', 'remove', 'nobody']), /a empresa "nobody" não existe \(empresas: contoso, fabrikam, northwind, personal, unassigned\)\.\s*$/);
  invalid(flow(r, ['company', 'remove', 'Bad Id']), /id de empresa inválido: "Bad Id"/);
  invalid(flow(r, ['company', 'remove'], { input: '' }), /falta o id da empresa/);
  assert.ok(/Empresa "personal" \(Pessoal\) excluída\./.test(ok(flow(r, ['company', 'remove', 'personal']))));
  assert.ok(/Empresa "northwind" \(Northwind\) excluída\./.test(ok(flow(r, ['company', 'remove', '--json', '-'], { input: JSON.stringify({ id: 'northwind' }) }))));
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => [c.id, c.project_count]), [['contoso', 2], ['fabrikam', 0], ['unassigned', 1]]);
    assert.deepStrictEqual((await get('/api/projects')).projects.map((p) => [p.id, p.company.id]), [['scratch', 'unassigned'], ['shop', 'contoso'], ['site', 'contoso']]);
  });
});

suite.test('the panel and the CLI rename a company (POST /api/companies/<id>/rename, flow company rename); the items show the new name', async () => {
  const r = buildRoot('rename');
  const shopRepo = repo(r, 'shop', 'https://github.com/contoso/shop.git');
  // Before maestro.db exists there is no company to rename (and the POST does not create the database).
  await withServer(r, async ({ port }) => {
    const x = await request(port, '/api/companies/contoso/rename', {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Contoso' }),
    });
    assert.deepStrictEqual([x.status, x.json], [404, { error: { code: 'company_not_found', company: 'contoso' } }]);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'a refused rename does not create maestro.db');
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['company', 'add', 'fabrikam', '--name', 'Fabrikam']));
  ok(flow(r, ['project', 'add', 'shop', '--company', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  ok(flow(r, ['item', 'start', '7', '--title', 'Carrinho'], { cwd: shopRepo }));
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: repo(r, 'scratch', 'https://github.com/higor/scratch.git') }));
  // One server for the whole test: its connection keeps the projected items cached between reads, and a rename (by the
  // panel or by the CLI, another process) must reach every answer that carries the company's name.
  await withServer(r, async ({ port, get }) => {
    const rename = (id, body, headers = { 'X-Panel': '1' }, method = 'POST') => request(port, `/api/companies/${id}/rename`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const names = async () => (await get('/api/companies')).companies.map((c) => [c.id, c.name]);
    /** The company's name as every read of the panel shows it. */
    const shown = async () => {
      const item = (await get('/api/items')).items.find((it) => it.key === 'shop/7');
      const overview = await get('/api/overview');
      return {
        companies: (await get('/api/companies')).companies.find((c) => c.id === 'contoso').name,
        projects: (await get('/api/projects')).projects.find((p) => p.id === 'shop').company.name,
        items: item.project.company.name,
        item: (await get('/api/items/shop/7')).item.project.company.name,
        overview: overview.active.companies.find((c) => c.id === 'contoso').name,
        overviewEvents: [...new Set(overview.recent_events.filter((e) => e.project.id === 'shop').map((e) => e.project.company.name))],
        log: [...new Set((await get('/api/log?project=shop')).events.map((e) => e.project.company.name))],
        filtered: (await get('/api/items?company=contoso')).items.map((it) => [it.key, it.project.company.name]),
      };
    };
    const everywhere = (name) => ({
      companies: name, projects: name, items: name, item: name, overview: name, overviewEvents: [name], log: [name], filtered: [['shop/7', name]],
    });
    assert.deepStrictEqual(await shown(), everywhere('Contoso'), 'the reads before the rename (the cache is warm)');
    // Security: X-Panel, Origin and the 16 KB body, exactly as every POST of the server; only POST.
    const without = await rename('contoso', { name: 'Outra' }, {});
    assert.deepStrictEqual([without.status, without.json], [403, { error: { code: 'missing_panel_header', header: 'X-Panel' } }]);
    const foreign = await rename('contoso', { name: 'Outra' }, { 'X-Panel': '1', Origin: 'http://evil.example' });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const tooLarge = await rename('contoso', JSON.stringify({ name: 'x'.repeat(17 * 1024) }));
    assert.deepStrictEqual([tooLarge.status, tooLarge.json.error.code], [413, 'body_too_large']);
    const get405 = await rename('contoso', '', {}, 'GET');
    assert.deepStrictEqual([get405.status, get405.json.error.code, get405.json.error.allowed], [405, 'method_not_allowed', ['POST']]);
    // The rules of the store: body, name format, "Sem empresa", unknown company and a name in use ignoring case.
    const cases = [
      ['contoso', '{', 400, { code: 'json_object_required' }],
      ['contoso', '[1]', 400, { code: 'json_object_required' }],
      ['contoso', {}, 400, { code: 'invalid_field', field: 'name', value: '', max: 80 }],
      ['contoso', { name: '   ' }, 400, { code: 'invalid_field', field: 'name', value: '   ', max: 80 }],
      ['contoso', { name: 'Contoso\nBrasil' }, 400, { code: 'invalid_field', field: 'name', value: 'Contoso\nBrasil', max: 80 }],
      ['contoso', { name: 'C'.repeat(81) }, 400, { code: 'invalid_field', field: 'name', value: 'C'.repeat(81), max: 80 }],
      ['unassigned', { name: 'Outra' }, 400, { code: 'company_reserved', company: 'unassigned' }],
      ['nobody', { name: 'Outra' }, 404, { code: 'company_not_found', company: 'nobody' }],
      ['contoso', { name: ' FABRIKAM ' }, 409, { code: 'company_name_taken', name: 'FABRIKAM', company: 'fabrikam', company_name: 'Fabrikam' }],
    ];
    for (const [id, body, status, error] of cases) {
      const x = await rename(id, body);
      assert.deepStrictEqual([id, body, x.status, x.json], [id, body, status, { error }]);
    }
    assert.strictEqual((await rename('Bad%20Id', { name: 'Outra' })).status, 404, 'an id outside the format is no route');
    assert.deepStrictEqual(await names(), [['contoso', 'Contoso'], ['fabrikam', 'Fabrikam'], ['unassigned', 'Sem empresa']], 'nothing renamed by a refused POST');
    // The rename, from the page's origin: 200 { company } as GET /api/companies lists it, the name trimmed, the id kept.
    const renamed = await rename('contoso', { name: '  Contoso Brasil ' }, { 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` });
    assert.strictEqual(renamed.status, 200, renamed.text);
    assert.deepStrictEqual(renamed.json, { company: { id: 'contoso', name: 'Contoso Brasil', unassigned: false, project_count: 1, item_count: 1 } });
    assert.deepStrictEqual((await get('/api/companies')).companies.find((c) => c.id === 'contoso'), renamed.json.company);
    assert.deepStrictEqual(await shown(), everywhere('Contoso Brasil'), 'every read shows the new name right away');
    // Its own name, even only changing the case, is accepted; the alphabetical order follows the new name.
    const sameName = await rename('contoso', { name: 'CONTOSO BRASIL' });
    assert.deepStrictEqual([sameName.status, sameName.json.company.name], [200, 'CONTOSO BRASIL'], sameName.text);
    const zeta = await rename('contoso', { name: 'Zeta' });
    assert.strictEqual(zeta.status, 200, zeta.text);
    assert.deepStrictEqual(await names(), [['fabrikam', 'Fabrikam'], ['contoso', 'Zeta'], ['unassigned', 'Sem empresa']]);
    // The CLI, another process, renames while the server runs: the server's next reads show it.
    assert.ok(/Empresa "contoso" renomeada de "Zeta" para "Contoso SA"\./.test(ok(flow(r, ['company', 'rename', 'contoso', '--name', 'Contoso SA']))));
    assert.deepStrictEqual(await shown(), everywhere('Contoso SA'), 'a rename by the CLI reaches the server too');
  });
  // The CLI applies the same rules: exit 2 with a Portuguese message.
  invalid(flow(r, ['company', 'rename', 'contoso', '--name', 'fabrikam']), /o nome "fabrikam" já é da empresa "fabrikam" \(Fabrikam\)/);
  invalid(flow(r, ['company', 'rename', '--json', '-'], { input: JSON.stringify({ id: 'contoso', name: 'FABRIKAM' }) }), /o nome "FABRIKAM" já é da empresa "fabrikam"/);
  invalid(flow(r, ['company', 'rename', 'contoso', '--name', 'C'.repeat(81)]), /o nome da empresa precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['company', 'rename', 'contoso', '--name', '  ']), /o nome da empresa precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['company', 'rename', 'contoso']), /falta o nome da empresa/);
  invalid(flow(r, ['company', 'rename', 'unassigned', '--name', 'Outra']), /"Sem empresa" é reservada: .*não se renomeia/);
  invalid(flow(r, ['company', 'rename', 'nobody', '--name', 'Outra']), /a empresa "nobody" não existe \(empresas: contoso, fabrikam, unassigned\)\.\s*$/);
  invalid(flow(r, ['company', 'rename', 'Bad Id', '--name', 'Outra']), /id de empresa inválido: "Bad Id"/);
  invalid(flow(r, ['company', 'rename'], { input: '' }), /falta o id da empresa/);
  assert.ok(/Empresa "contoso" renomeada de "Contoso SA" para "contoso sa"\./.test(ok(flow(r, ['company', 'rename', 'contoso', '--name', 'contoso sa']))));
  assert.ok(/Empresa "fabrikam" renomeada de "Fabrikam" para "Fabrikam Ltda"\./.test(ok(flow(r, ['company', 'rename', '--json', '-'], { input: JSON.stringify({ id: 'fabrikam', name: ' Fabrikam Ltda ' }) }))));
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/companies')).companies.map((c) => [c.id, c.name, c.project_count]),
      [['contoso', 'contoso sa', 1], ['fabrikam', 'Fabrikam Ltda', 0], ['unassigned', 'Sem empresa', 1]]);
    assert.deepStrictEqual((await get('/api/items?company=contoso')).items.map((it) => [it.key, it.project.company]), [['shop/7', { id: 'contoso', name: 'contoso sa' }]]);
  });
});

suite.test('"Sem empresa" is never the company of a new project: flow project add --company unassigned exits 2', async () => {
  const r = buildRoot('add-reserved');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  const reserved = /"Sem empresa" é reservada: ela só recebe os repositórios sem cadastro/;
  // Refused before "Sem empresa" exists in the register and after a repository lands there.
  invalid(flow(r, ['project', 'add', 'shop', '--company', 'unassigned', '--repo', 'https://github.com/contoso/shop']), reserved);
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  invalid(flow(r, ['project', 'add', 'shop', '--company', 'unassigned', '--repo', 'https://github.com/contoso/shop']), reserved);
  invalid(flow(r, ['project', 'add', '--json', '-'], { input: JSON.stringify({ id: 'shop', company: 'unassigned', repos: ['https://github.com/contoso/shop'] }) }), reserved);
  invalid(flow(r, ['project', 'add', 'shop', '--company', 'nobody', '--repo', 'https://github.com/contoso/shop']), /a empresa "nobody" não existe .*Cadastre com: flow company add nobody/);
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'shop', '--company', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/projects')).projects.map((p) => [p.id, p.company.id, p.repos]),
      [['scratch', 'unassigned', ['github.com/higor/scratch']], ['shop', 'contoso', ['github.com/contoso/shop']]]);
  });
});

suite.test('the name of "Sem empresa" is reserved: creating or renaming a company with it (ignoring case) is company_name_taken', async () => {
  const r = buildRoot('reserved-name');
  const taken = (name) => ({ code: 'company_name_taken', name, company: 'unassigned', company_name: 'Sem empresa' });
  const cli = (name) => new RegExp(`o nome "${name}" já é da empresa "unassigned" \\(Sem empresa\\)`);
  ok(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']));
  // Before "Sem empresa" exists in the register, by the CLI and by the panel.
  invalid(flow(r, ['company', 'add', 'fabrikam', '--name', 'Sem empresa']), cli('Sem empresa'));
  invalid(flow(r, ['company', 'add', '--json', '-'], { input: JSON.stringify({ id: 'fabrikam', name: ' SEM EMPRESA ' }) }), cli('SEM EMPRESA'));
  invalid(flow(r, ['company', 'rename', 'contoso', '--name', 'sem empresa']), cli('sem empresa'));
  const post = (port, p, body) => request(port, p, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const check = async ({ port, get }, when) => {
    const created = await post(port, '/api/companies', { id: 'fabrikam', name: 'sem EMPRESA' });
    assert.deepStrictEqual([when, created.status, created.json], [when, 409, { error: taken('sem EMPRESA') }]);
    const renamed = await post(port, '/api/companies/contoso/rename', { name: '  Sem Empresa ' });
    assert.deepStrictEqual([when, renamed.status, renamed.json], [when, 409, { error: taken('Sem Empresa') }]);
    assert.deepStrictEqual([when, (await get('/api/companies')).companies.filter((c) => !c.unassigned).map((c) => [c.id, c.name])], [when, [['contoso', 'Contoso']]]);
  };
  await withServer(r, (s) => check(s, 'before "Sem empresa" exists'));
  // After a repository lands there, the same.
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: repo(r, 'scratch', 'https://github.com/higor/scratch.git') }));
  invalid(flow(r, ['company', 'add', 'fabrikam', '--name', 'sem empresa']), cli('sem empresa'));
  invalid(flow(r, ['company', 'rename', 'contoso', '--name', 'SEM EMPRESA']), cli('SEM EMPRESA'));
  await withServer(r, (s) => check(s, 'after "Sem empresa" exists'));
  // A name that only contains it is a name like the others.
  ok(flow(r, ['company', 'add', 'fabrikam', '--name', 'Sem empresa Ltda']));
  ok(flow(r, ['company', 'rename', 'contoso', '--name', 'Contoso sem empresa']));
});

suite.test('help lists the company and project subcommands', () => {
  const r = buildRoot('help');
  const out = ok(flow(r, ['--help']));
  assert.ok(/company add <id> --name/.test(out) && /company rename <id> --name/.test(out) && /company remove <id>/.test(out) && /project add <id>/.test(out) && /project move <id> <empresa>/.test(out), out);
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
