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
  ok(flow(r, ['item', 'start', '52', '--title', 'Cupom'], { cwd: shop }));
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
    [['company', 'remove', 'x'], /subcomando desconhecido: "company remove"/],
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

suite.test('help lists the company and project subcommands', () => {
  const r = buildRoot('help');
  const out = ok(flow(r, ['--help']));
  assert.ok(/company add <id> --name/.test(out) && /project add <id>/.test(out) && /project move <id> <empresa>/.test(out), out);
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
