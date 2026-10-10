'use strict';
// Tests for organizations and projects (#6) through the agreed seam only: the bin/flow.js CLI runs as a process (inside
// temporary git repositories with fictitious remotes) → temporary maestro.db (MAESTRO_DIR) → the server's HTTP API.
// No test reads the database or calls internal functions, but for the migration of a schema v1 file (#26).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('organizations and projects: flow CLI → maestro.db → API');
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
  const root = tmpDir(`organizations-${name}`);
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
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'cidax', '--name', 'CIDAX', '--org', 'contoso', '--tracker', 'azure_devops',
    '--repo', CIDAX_API, '--repo', 'https://dev.azure.com/contoso/CIDAX/_git/cidax-web', '--done-state', 'Committed', '--workspace', 'CIDAX']));
  ok(flow(r, ['item', 'start', '3100', '--title', 'Conciliação de boletos'], { cwd: api }));
  ok(flow(r, ['stage', '3100', 'implementation'], { cwd: web }));
  await withServer(r, async ({ get }) => {
    const { projects } = await get('/api/projects');
    assert.strictEqual(projects.length, 1, JSON.stringify(projects));
    const p = projects[0];
    assert.deepStrictEqual([p.id, p.name, p.tracker, p.organization, p.done_state, p.maestri_workspace],
      ['cidax', 'CIDAX', 'azure_devops', { id: 'contoso', name: 'Contoso' }, 'Committed', 'CIDAX']);
    assert.deepStrictEqual(p.repos, ['dev.azure.com/contoso/cidax/_git/cidax-api', 'dev.azure.com/contoso/cidax/_git/cidax-web']);
    const { items } = await get('/api/items');
    assert.deepStrictEqual(items.map((i) => [i.key, i.stage, i.project.organization.id]), [['cidax/3100', 'implementation', 'contoso']]);
  });
});

suite.test('the stages a project declares are the only ones its items may take: another one is refused with exit 2', async () => {
  const r = buildRoot('stages');
  const widgets = repo(r, 'widgets', 'https://github.com/acme/widgets.git');
  ok(flow(r, ['org', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'widgets', '--org', 'personal', '--stages', 'implementation,pr_ready,merge,done,specification'], { cwd: widgets }));
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
    assert.deepStrictEqual(projects[0].organization, { id: 'personal', name: 'Pessoal' });
    const item = (await get('/api/items/widgets/12')).item;
    assert.strictEqual(item.stage, 'hml_validation');
    assert.deepStrictEqual(item.stages.map((s) => s.id), ['specification', 'implementation', 'pr_ready', 'merge', 'hml_validation', 'done']);
    assert.deepStrictEqual(item.timeline.map((e) => e.payload.stage), ['specification', 'pr_ready', 'hml_validation']);
  });
});

suite.test('the items API filters by organization and by project', async () => {
  const r = buildRoot('filters');
  const shop = repo(r, 'shop', 'https://github.com/fabrikam/shop.git');
  const api = repo(r, 'cidax-api', CIDAX_API);
  const mine = repo(r, 'mine', 'git@github.com:higor/painel.git');
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['org', 'add', 'fabrikam', '--name', 'Fabrikam']));
  ok(flow(r, ['org', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'shop', '--name', 'Loja', '--org', 'fabrikam'], { cwd: shop }));
  ok(flow(r, ['project', 'add', 'cidax', '--org', 'contoso', '--repo', CIDAX_API]));
  ok(flow(r, ['project', 'add', 'painel', '--org', 'personal', '--repo', 'https://github.com/higor/painel']));
  ok(flow(r, ['item', 'start', '48', '--title', 'Carrinho'], { cwd: shop }));
  ok(flow(r, ['item', 'start', '52', '--title', 'Cupom', '--stage', 'implementation'], { cwd: shop }));
  ok(flow(r, ['item', 'start', '3100', '--title', 'Boletos'], { cwd: api }));
  ok(flow(r, ['item', 'start', '5', '--title', 'Painel'], { cwd: mine }));
  await withServer(r, async ({ port, get }) => {
    const keys = async (q) => (await get(`/api/items${q}`)).items.map((i) => i.key).sort();
    assert.deepStrictEqual(await keys(''), ['cidax/3100', 'painel/5', 'shop/48', 'shop/52']);
    assert.deepStrictEqual(await keys('?organization=fabrikam'), ['shop/48', 'shop/52']);
    assert.deepStrictEqual(await keys('?organization=personal'), ['painel/5']);
    assert.deepStrictEqual(await keys('?project=cidax'), ['cidax/3100']);
    assert.deepStrictEqual(await keys('?organization=contoso&project=shop'), []);
    assert.deepStrictEqual(await keys('?organization=nobody'), []);
    const bad = await request(port, '/api/items?organization=..%2Fx');
    assert.deepStrictEqual([bad.status, bad.json.error.code, bad.json.error.param], [400, 'invalid_filter', 'organization']);
    // Stage and tracker (#1: "itens com filtros (organização, projeto, etapa, tracker)"), alone or together.
    assert.deepStrictEqual(await keys('?tracker=azure_devops'), ['cidax/3100']);
    assert.deepStrictEqual(await keys('?tracker=github'), ['painel/5', 'shop/48', 'shop/52']);
    assert.deepStrictEqual(await keys('?stage=implementation'), ['shop/52']);
    assert.deepStrictEqual(await keys('?stage=specification&tracker=github&organization=fabrikam'), ['shop/48']);
    assert.deepStrictEqual(await keys('?stage=done'), []);
    for (const [q, param] of [['stage=voando', 'stage'], ['tracker=gitlab', 'tracker'], ['stage=', null]]) {
      const x = await request(port, `/api/items?${q}`);
      if (!param) { assert.strictEqual(x.status, 200, q); continue; }
      assert.deepStrictEqual([x.status, x.json.error.code, x.json.error.param], [400, 'invalid_filter', param], q);
    }
    const { organizations } = await get('/api/organizations');
    assert.deepStrictEqual(organizations.map((c) => [c.id, c.name, c.project_count, c.item_count]),
      [['contoso', 'Contoso', 1, 1], ['fabrikam', 'Fabrikam', 1, 2], ['personal', 'Pessoal', 1, 1]]);
    assert.deepStrictEqual((await get('/api/projects?organization=fabrikam')).projects.map((p) => [p.id, p.name, p.item_count]), [['shop', 'Loja', 2]]);
  });
});

suite.test('a repository without register lands in "Sem organização"; the panel moves it to an organization, with the POST rules', async () => {
  const r = buildRoot('move');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  ok(flow(r, ['org', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  await withServer(r, async ({ port, get }) => {
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => [c.id, c.name, c.unassigned, c.project_count]),
      [['personal', 'Pessoal', false, 0], ['unassigned', 'Sem organização', true, 1]]);
    const before = (await get('/api/projects')).projects;
    assert.deepStrictEqual(before.map((p) => [p.id, p.organization.id, p.unassigned, p.item_count]), [['scratch', 'unassigned', true, 1]]);
    const move = (headers, body, p = '/api/projects/scratch/organization') => request(port, p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const body = JSON.stringify({ organization: 'personal' });
    // Security: X-Panel, Origin and Host, exactly as every POST of the server.
    assert.deepStrictEqual([(await move({}, body)).status, (await move({}, body)).json.error.code], [403, 'missing_panel_header']);
    const foreign = await move({ 'X-Panel': '1', Origin: 'http://evil.example' }, body);
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const host = await request(port, '/api/projects/scratch/organization', { method: 'POST', host: 'evil.example', headers: { 'X-Panel': '1' }, body });
    assert.strictEqual(host.status, 403);
    assert.strictEqual((await get('/api/projects')).projects[0].organization.id, 'unassigned', 'nothing moved by a refused POST');
    // Invalid requests.
    const get405 = await request(port, '/api/projects/scratch/organization');
    assert.deepStrictEqual([get405.status, get405.json.error.code], [405, 'method_not_allowed']);
    for (const [b, code] of [['{', 'json_object_required'], ['[1]', 'json_object_required'], ['{"organization":"A B"}', 'invalid_field'], ['{"organization":"nobody"}', 'organization_not_found']]) {
      const x = await move({ 'X-Panel': '1' }, b);
      assert.deepStrictEqual([b, x.status, x.json.error.code], [b, 400, code]);
    }
    const missing = await move({ 'X-Panel': '1' }, body, '/api/projects/nothing/organization');
    assert.deepStrictEqual([missing.status, missing.json.error.code], [404, 'project_not_found']);
    // The move itself, from the page's origin.
    const moved = await move({ 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` }, body);
    assert.strictEqual(moved.status, 200, moved.text);
    assert.deepStrictEqual([moved.json.project.id, moved.json.project.organization, moved.json.project.unassigned], ['scratch', { id: 'personal', name: 'Pessoal' }, false]);
    assert.deepStrictEqual((await get('/api/items?organization=personal')).items.map((i) => i.key), ['scratch/3']);
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => [c.id, c.project_count]), [['personal', 1], ['unassigned', 0]]);
  });
  // The CLI keeps resolving the project from the repository, now in its organization.
  ok(flow(r, ['stage', '3', 'implementation'], { cwd: scratch }));
  assert.ok(/scratch\s+scratch · Pessoal · GitHub/.test(ok(flow(r, ['project', 'list']))));
});

suite.test('"Sem organização" is never a destination of a move: the API answers 400 organization_reserved and the CLI exits 2', async () => {
  const r = buildRoot('reserved');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  const reserved = /"Sem organização" é reservada: .*não é destino de mover/;
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['org', 'add', 'personal', '--name', 'Pessoal']));
  ok(flow(r, ['project', 'add', 'shop', '--org', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  // Refused before "Sem organização" exists in the register and after a repository lands there.
  invalid(flow(r, ['project', 'move', 'shop', 'unassigned']), reserved);
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  invalid(flow(r, ['project', 'move', 'shop', 'unassigned']), reserved);
  invalid(flow(r, ['project', 'move', '--json', '-'], { input: JSON.stringify({ id: 'shop', organization: 'unassigned' }) }), reserved);
  invalid(flow(r, ['project', 'edit', 'shop', '--org', 'unassigned']), reserved);
  invalid(flow(r, ['project', 'move', 'scratch', 'unassigned']), reserved);
  invalid(flow(r, ['project', 'move', 'shop', 'nobody']), /a organização "nobody" não existe \(organizações: contoso, personal, unassigned\)/);
  await withServer(r, async ({ port, get }) => {
    const move = (id, organization) => request(port, `/api/projects/${id}/organization`, {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ organization }),
    });
    const where = async () => (await get('/api/projects')).projects.map((p) => [p.id, p.organization.id]);
    for (const id of ['shop', 'scratch']) {
      const x = await move(id, 'unassigned');
      assert.deepStrictEqual([id, x.status, x.json.error], [id, 400, { code: 'organization_reserved', organization: 'unassigned' }]);
    }
    assert.deepStrictEqual(await where(), [['scratch', 'unassigned'], ['shop', 'contoso']], 'nothing moved by a refused move');
    // Moving between organizations keeps working, by the panel and by the CLI.
    const moved = await move('shop', 'personal');
    assert.deepStrictEqual([moved.status, moved.json.project.organization], [200, { id: 'personal', name: 'Pessoal' }], moved.text);
    assert.ok(/Projeto "scratch" movido de "Sem organização" para "Contoso"/.test(ok(flow(r, ['project', 'move', 'scratch', 'contoso']))));
    assert.deepStrictEqual(await where(), [['scratch', 'contoso'], ['shop', 'personal']]);
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => [c.id, c.project_count, c.item_count]),
      [['contoso', 1, 1], ['personal', 1, 0], ['unassigned', 0, 0]]);
  });
});

suite.test('the CLI lists organizations and projects, moves a project and edits its register', async () => {
  const r = buildRoot('cli');
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['org', 'add', '--json', '-'], { input: JSON.stringify({ id: 'personal', name: 'Pessoal' }) }));
  ok(flow(r, ['project', 'add', '--json', '-'], { input: JSON.stringify({ id: 'cidax', name: 'CIDAX', organization: 'personal', repos: [CIDAX_API], done_state: 'Committed' }) }));
  assert.ok(/Projeto "cidax" movido de "Pessoal" para "Contoso"/.test(ok(flow(r, ['project', 'move', 'cidax', 'contoso']))));
  ok(flow(r, ['project', 'edit', 'cidax', '--repo', CIDAX_WEB, '--workspace', 'CIDAX', '--name', 'CIDAX Portal']));
  ok(flow(r, ['project', 'edit', 'cidax', '--remove-repo', 'https://dev.azure.com/contoso/CIDAX/_git/cidax-api', '--done-state', '']));
  const organizations = ok(flow(r, ['org', 'list']));
  assert.ok(/contoso\s+Contoso · 1 projeto\b/.test(organizations) && /personal\s+Pessoal · 0 projetos/.test(organizations), organizations);
  const projects = ok(flow(r, ['project', 'list', '--org', 'contoso']));
  assert.ok(/cidax\s+CIDAX Portal · Contoso · Azure DevOps · etapas: specification, /.test(projects), projects);
  assert.ok(/workspace do Maestri: CIDAX/.test(projects) && !/concluído no tracker/.test(projects), projects);
  assert.ok(/repositório: dev\.azure\.com\/contoso\/cidax\/_git\/cidax-web/.test(projects) && !/cidax-api/.test(projects), projects);
  await withServer(r, async ({ get }) => {
    const [p] = (await get('/api/projects')).projects;
    assert.deepStrictEqual([p.name, p.organization.id, p.repos, p.done_state, p.maestri_workspace],
      ['CIDAX Portal', 'contoso', ['dev.azure.com/contoso/cidax/_git/cidax-web'], null, 'CIDAX']);
  });
});

suite.test('invalid organization and project data end with a clear message and exit 2, changing nothing', async () => {
  const r = buildRoot('invalid');
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'cidax', '--org', 'contoso', '--repo', CIDAX_API]));
  ok(flow(r, ['project', 'add', 'shop', '--org', 'contoso', '--repo', 'https://github.com/fabrikam/shop']));
  const cases = [
    [['org'], /falta o subcomando/],
    [['org', 'delete', 'x'], /subcomando desconhecido: "org delete"/],
    [['org', 'add', 'contoso', '--name', 'Outra'], /a organização "contoso" já existe/],
    [['org', 'add', 'Bad Id', '--name', 'x'], /id de organização inválido: "Bad Id"/],
    [['org', 'add', 'fabrikam'], /falta o nome da organização/],
    [['project', 'add', 'loja', '--repo', 'https://github.com/x/loja'], /falta a organização do projeto/],
    [['project', 'add', 'loja', '--org', 'nobody', '--repo', 'https://github.com/x/loja'], /a organização "nobody" não existe/],
    [['project', 'add', 'cidax', '--org', 'contoso', '--repo', 'https://github.com/x/y'], /o projeto "cidax" já existe/],
    [['project', 'add', 'loja', '--org', 'contoso'], /falta o repositório do projeto/],
    [['project', 'add', 'loja', '--org', 'contoso', '--repo', CIDAX_WEB, '--tracker', 'github'], /é do Azure DevOps, mas o projeto usa o GitHub/],
    [['project', 'add', 'loja', '--org', 'contoso', '--repo', 'https://github.com/fabrikam/shop.git'], /já é do projeto "shop"/],
    [['project', 'add', 'loja', '--org', 'contoso', '--repo', 'https://github.com/x/loja', '--tracker', 'gitlab'], /tracker inválido: "gitlab"/],
    [['project', 'add', 'loja', '--org', 'contoso', '--repo', 'https://github.com/x/loja', '--stages', 'implementation,review'], /etapa desconhecida: "review"/],
    [['project', 'add', 'loja', '--org', 'contoso', '--repo', 'https://github.com/x/loja', '--stages', ','], /ao menos uma etapa/],
    [['project', 'edit', 'nothing', '--name', 'x'], /o projeto "nothing" não existe/],
    [['project', 'edit', 'cidax'], /nada para mudar/],
    [['project', 'edit', 'cidax', '--remove-repo', CIDAX_API], /precisa de ao menos um repositório/],
    [['project', 'edit', 'cidax', '--remove-repo', CIDAX_WEB], /não é do projeto "cidax"/],
    [['project', 'edit', 'shop', '--tracker', 'azure_devops'], /é do GitHub, mas o projeto usa o Azure DevOps/],
    [['project', 'move', 'cidax'], /falta o id da organização/],
    [['project', 'move', 'cidax', 'nobody'], /a organização "nobody" não existe/],
    [['project', 'list', '--org', 'nobody'], /a organização "nobody" não existe/],
  ];
  for (const [args, message] of cases) invalid(flow(r, args, { input: '' }), message);
  await withServer(r, async ({ get }) => {
    const { projects } = await get('/api/projects');
    assert.deepStrictEqual(projects.map((p) => [p.id, p.tracker, p.organization.id, p.repos]), [
      ['cidax', 'azure_devops', 'contoso', ['dev.azure.com/contoso/cidax/_git/cidax-api']],
      ['shop', 'github', 'contoso', ['github.com/fabrikam/shop']],
    ]);
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => c.id), ['contoso']);
  });
});

suite.test('the panel creates an organization (POST /api/organizations) under the name rule of the store, which the CLI shares', async () => {
  const r = buildRoot('create');
  // The server starts before maestro.db exists: the first organization creates it.
  await withServer(r, async ({ port, get }) => {
    assert.deepStrictEqual((await get('/api/organizations')).organizations, []);
    const create = (body, headers = { 'X-Panel': '1' }) => request(port, '/api/organizations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const ids = async () => (await get('/api/organizations')).organizations.map((c) => [c.id, c.name]);
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
    // "Sem organização"'s id and name are taken before maestro.db exists too: refused without creating it.
    const reservedId = await create({ id: 'unassigned', name: 'Outra' });
    assert.deepStrictEqual([reservedId.status, reservedId.json], [409, { error: { code: 'organization_exists', organization: 'unassigned' } }]);
    const reservedName = await create({ id: 'fabrikam', name: 'SEM ORGANIZAÇÃO' });
    assert.deepStrictEqual([reservedName.status, reservedName.json],
      [409, { error: { code: 'organization_name_taken', name: 'SEM ORGANIZAÇÃO', organization: 'unassigned', organization_name: 'Sem organização' } }]);
    assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'an invalid POST does not create maestro.db');
    assert.deepStrictEqual(await ids(), [], 'nothing created by a refused POST');
    // The creation, from the page's origin: 201 with the organization as GET /api/organizations lists it; the name is trimmed.
    const created = await create({ id: 'contoso', name: '  Contoso  ' }, { 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` });
    assert.strictEqual(created.status, 201, created.text);
    const listed = (await get('/api/organizations')).organizations;
    assert.deepStrictEqual(created.json, { organization: { id: 'contoso', name: 'Contoso', unassigned: false, project_count: 0, item_count: 0 } });
    assert.deepStrictEqual(listed, [created.json.organization]);
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
      [{ id: 'contoso', name: 'Outra' }, 409, { code: 'organization_exists', organization: 'contoso', name: 'Contoso' }],
      // "Sem organização" is not registered yet, but its id is reserved.
      [{ id: 'unassigned', name: 'Outra' }, 409, { code: 'organization_exists', organization: 'unassigned' }],
      [{ id: 'contoso-br', name: ' CONTOSO ' }, 409, { code: 'organization_name_taken', name: 'CONTOSO', organization: 'contoso', organization_name: 'Contoso' }],
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
    const put = await request(port, '/api/organizations', { method: 'PUT', headers: { 'X-Panel': '1' } });
    assert.deepStrictEqual([put.status, put.json.error.code, put.json.error.allowed], [405, 'method_not_allowed', ['GET', 'HEAD', 'POST']]);
  });
  // The CLI applies the same rule: a name in use ignoring case, empty or too long exits 2 with a Portuguese message.
  invalid(flow(r, ['org', 'add', 'contoso-br', '--name', 'contoso']), /o nome "contoso" já é da organização "contoso" \(Contoso\)/);
  invalid(flow(r, ['org', 'add', '--json', '-'], { input: JSON.stringify({ id: 'contoso-br', name: 'CONTOSO' }) }), /o nome "CONTOSO" já é da organização "contoso"/);
  invalid(flow(r, ['org', 'add', 'fabrikam', '--name', 'F'.repeat(81)]), /o nome da organização precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['org', 'add', 'fabrikam', '--name', '   ']), /o nome da organização precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['org', 'add', 'unassigned', '--name', 'Outra']), /a organização "unassigned" já existe \(reservada para "Sem organização"\)/);
  assert.ok(/Organização "fabrikam" \(Fabrikam\) cadastrada/.test(ok(flow(r, ['org', 'add', 'fabrikam', '--name', '  Fabrikam ']))));
  // The same letters in another Unicode form (a combining accent, NFD) are the same name.
  ok(flow(r, ['org', 'add', 'cafe', '--name', 'Caf\u00e9']));
  invalid(flow(r, ['org', 'add', 'cafe-2', '--name', 'CAFE\u0301']), /já é da organização "cafe"/);
  invalid(flow(r, ['org', 'rename', 'fabrikam', '--name', 'cafe\u0301']), /já é da organização "cafe"/);
  ok(flow(r, ['org', 'remove', 'cafe']));
  // The organization the panel created is an organization like the others for the CLI.
  ok(flow(r, ['project', 'add', 'shop', '--org', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => [c.id, c.name, c.project_count]),
      [['contoso', 'Contoso', 1], ['fabrikam', 'Fabrikam', 0], [`f${'a'.repeat(79)}`, 'F'.repeat(80), 0]]);
  });
});

suite.test('the panel and the CLI remove an empty organization only (POST /api/organizations/<id>/remove, flow org remove)', async () => {
  const r = buildRoot('remove');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  // Before maestro.db exists there is no organization to remove (and the POST does not create the database).
  await withServer(r, async ({ port }) => {
    const x = await request(port, '/api/organizations/contoso/remove', { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.deepStrictEqual([x.status, x.json], [404, { error: { code: 'organization_not_found', organization: 'contoso' } }]);
    // "Sem organização" is reserved even before the database exists (as the CLI, which creates it, says).
    const reserved = await request(port, '/api/organizations/unassigned/remove', { method: 'POST', headers: { 'X-Panel': '1' } });
    assert.deepStrictEqual([reserved.status, reserved.json], [400, { error: { code: 'organization_reserved', organization: 'unassigned' } }]);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'a refused removal does not create maestro.db');
  for (const [id, name] of [['contoso', 'Contoso'], ['fabrikam', 'Fabrikam'], ['personal', 'Pessoal'], ['northwind', 'Northwind']]) {
    ok(flow(r, ['org', 'add', id, '--name', name]));
  }
  ok(flow(r, ['project', 'add', 'shop', '--org', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  ok(flow(r, ['project', 'add', 'site', '--org', 'contoso', '--repo', 'https://github.com/contoso/site']));
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  await withServer(r, async ({ port, get }) => {
    const remove = (id, headers = { 'X-Panel': '1' }, method = 'POST') => request(port, `/api/organizations/${id}/remove`, { method, headers });
    const ids = async () => (await get('/api/organizations')).organizations.map((c) => c.id);
    const all = ['contoso', 'fabrikam', 'northwind', 'personal', 'unassigned'];
    assert.deepStrictEqual(await ids(), all);
    // Security: X-Panel and Origin, exactly as every POST of the server; only POST.
    const without = await remove('fabrikam', {});
    assert.deepStrictEqual([without.status, without.json], [403, { error: { code: 'missing_panel_header', header: 'X-Panel' } }]);
    const foreign = await remove('fabrikam', { 'X-Panel': '1', Origin: 'http://evil.example' });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const get405 = await remove('fabrikam', {}, 'GET');
    assert.deepStrictEqual([get405.status, get405.json.error.code, get405.json.error.allowed], [405, 'method_not_allowed', ['POST']]);
    // The rules of the store: with projects (409 with the count), "Sem organização" (400), unknown (404); an id outside the
    // format is no route at all.
    const cases = [
      ['contoso', 409, { code: 'organization_not_empty', organization: 'contoso', name: 'Contoso', project_count: 2 }],
      ['unassigned', 400, { code: 'organization_reserved', organization: 'unassigned' }],
      ['nobody', 404, { code: 'organization_not_found', organization: 'nobody' }],
    ];
    for (const [id, status, error] of cases) {
      const x = await remove(id);
      assert.deepStrictEqual([id, x.status, x.json], [id, status, { error }]);
    }
    assert.strictEqual((await remove('Bad%20Id')).status, 404);
    assert.deepStrictEqual(await ids(), all, 'nothing removed by a refused POST');
    // The removal, from the page's origin: 200 { removed }, and the organization leaves the lists.
    const removed = await remove('fabrikam', { 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` });
    assert.deepStrictEqual([removed.status, removed.json], [200, { removed: 'fabrikam' }], removed.text);
    assert.deepStrictEqual(await ids(), ['contoso', 'northwind', 'personal', 'unassigned']);
    const again = await remove('fabrikam');
    assert.deepStrictEqual([again.status, again.json.error.code], [404, 'organization_not_found']);
    // A screen out of date: a project moved to "Pessoal" by the CLI while the page still shows it empty is refused.
    ok(flow(r, ['project', 'move', 'site', 'personal']));
    const stale = await remove('personal');
    assert.deepStrictEqual([stale.status, stale.json.error], [409, { code: 'organization_not_empty', organization: 'personal', name: 'Pessoal', project_count: 1 }]);
    // A removed organization frees its id and its name.
    const created = await request(port, '/api/organizations', {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'fabrikam', name: 'Fabrikam' }),
    });
    assert.strictEqual(created.status, 201, created.text);
  });
  // The CLI applies the same rules: exit 2 with a Portuguese message (with the count of projects when not empty).
  invalid(flow(r, ['org', 'remove', 'contoso']), /a organização "contoso" \(Contoso\) tem 1 projeto: mova-o antes/);
  invalid(flow(r, ['org', 'remove', 'personal']), /a organização "personal" \(Pessoal\) tem 1 projeto/);
  ok(flow(r, ['project', 'move', 'site', 'contoso']));
  invalid(flow(r, ['org', 'remove', 'contoso']), /a organização "contoso" \(Contoso\) tem 2 projetos: mova-os antes/);
  invalid(flow(r, ['org', 'remove', '--json', '-'], { input: JSON.stringify({ id: 'contoso' }) }), /tem 2 projetos/);
  invalid(flow(r, ['org', 'remove', 'unassigned']), /"Sem organização" é reservada: .*não se exclui/);
  invalid(flow(r, ['org', 'remove', 'nobody']), /a organização "nobody" não existe \(organizações: contoso, fabrikam, northwind, personal, unassigned\)\.\s*$/);
  invalid(flow(r, ['org', 'remove', 'Bad Id']), /id de organização inválido: "Bad Id"/);
  invalid(flow(r, ['org', 'remove'], { input: '' }), /falta o id da organização/);
  assert.ok(/Organização "personal" \(Pessoal\) excluída\./.test(ok(flow(r, ['org', 'remove', 'personal']))));
  assert.ok(/Organização "northwind" \(Northwind\) excluída\./.test(ok(flow(r, ['org', 'remove', '--json', '-'], { input: JSON.stringify({ id: 'northwind' }) }))));
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => [c.id, c.project_count]), [['contoso', 2], ['fabrikam', 0], ['unassigned', 1]]);
    assert.deepStrictEqual((await get('/api/projects')).projects.map((p) => [p.id, p.organization.id]), [['scratch', 'unassigned'], ['shop', 'contoso'], ['site', 'contoso']]);
  });
});

suite.test('the panel and the CLI rename an organization (POST /api/organizations/<id>/rename, flow org rename); the items show the new name', async () => {
  const r = buildRoot('rename');
  const shopRepo = repo(r, 'shop', 'https://github.com/contoso/shop.git');
  // Before maestro.db exists there is no organization to rename (and the POST does not create the database).
  await withServer(r, async ({ port }) => {
    const x = await request(port, '/api/organizations/contoso/rename', {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Contoso' }),
    });
    assert.deepStrictEqual([x.status, x.json], [404, { error: { code: 'organization_not_found', organization: 'contoso' } }]);
    // "Sem organização" is reserved even before the database exists (as the CLI, which creates it, says).
    const reserved = await request(port, '/api/organizations/unassigned/rename', {
      method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Outra' }),
    });
    assert.deepStrictEqual([reserved.status, reserved.json], [400, { error: { code: 'organization_reserved', organization: 'unassigned' } }]);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'a refused rename does not create maestro.db');
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['org', 'add', 'fabrikam', '--name', 'Fabrikam']));
  ok(flow(r, ['project', 'add', 'shop', '--org', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  ok(flow(r, ['item', 'start', '7', '--title', 'Carrinho'], { cwd: shopRepo }));
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: repo(r, 'scratch', 'https://github.com/higor/scratch.git') }));
  // One server for the whole test: its connection keeps the projected items cached between reads, and a rename (by the
  // panel or by the CLI, another process) must reach every answer that carries the organization's name.
  await withServer(r, async ({ port, get }) => {
    const rename = (id, body, headers = { 'X-Panel': '1' }, method = 'POST') => request(port, `/api/organizations/${id}/rename`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const names = async () => (await get('/api/organizations')).organizations.map((c) => [c.id, c.name]);
    /** The organization's name as every read of the panel shows it. */
    const shown = async () => {
      const item = (await get('/api/items')).items.find((it) => it.key === 'shop/7');
      const overview = await get('/api/overview');
      return {
        organizations: (await get('/api/organizations')).organizations.find((c) => c.id === 'contoso').name,
        projects: (await get('/api/projects')).projects.find((p) => p.id === 'shop').organization.name,
        items: item.project.organization.name,
        item: (await get('/api/items/shop/7')).item.project.organization.name,
        overview: overview.active.organizations.find((c) => c.id === 'contoso').name,
        overviewEvents: [...new Set(overview.recent_events.filter((e) => e.project.id === 'shop').map((e) => e.project.organization.name))],
        log: [...new Set((await get('/api/log?project=shop')).events.map((e) => e.project.organization.name))],
        filtered: (await get('/api/items?organization=contoso')).items.map((it) => [it.key, it.project.organization.name]),
      };
    };
    const everywhere = (name) => ({
      organizations: name, projects: name, items: name, item: name, overview: name, overviewEvents: [name], log: [name], filtered: [['shop/7', name]],
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
    // The rules of the store: body, name format, "Sem organização", unknown organization and a name in use ignoring case.
    const cases = [
      ['contoso', '{', 400, { code: 'json_object_required' }],
      ['contoso', '[1]', 400, { code: 'json_object_required' }],
      ['contoso', {}, 400, { code: 'invalid_field', field: 'name', value: '', max: 80 }],
      ['contoso', { name: '   ' }, 400, { code: 'invalid_field', field: 'name', value: '   ', max: 80 }],
      ['contoso', { name: 'Contoso\nBrasil' }, 400, { code: 'invalid_field', field: 'name', value: 'Contoso\nBrasil', max: 80 }],
      ['contoso', { name: 'C'.repeat(81) }, 400, { code: 'invalid_field', field: 'name', value: 'C'.repeat(81), max: 80 }],
      ['unassigned', { name: 'Outra' }, 400, { code: 'organization_reserved', organization: 'unassigned' }],
      ['nobody', { name: 'Outra' }, 404, { code: 'organization_not_found', organization: 'nobody' }],
      ['contoso', { name: ' FABRIKAM ' }, 409, { code: 'organization_name_taken', name: 'FABRIKAM', organization: 'fabrikam', organization_name: 'Fabrikam' }],
    ];
    for (const [id, body, status, error] of cases) {
      const x = await rename(id, body);
      assert.deepStrictEqual([id, body, x.status, x.json], [id, body, status, { error }]);
    }
    assert.strictEqual((await rename('Bad%20Id', { name: 'Outra' })).status, 404, 'an id outside the format is no route');
    assert.deepStrictEqual(await names(), [['contoso', 'Contoso'], ['fabrikam', 'Fabrikam'], ['unassigned', 'Sem organização']], 'nothing renamed by a refused POST');
    // The rename, from the page's origin: 200 { organization } as GET /api/organizations lists it, the name trimmed, the id kept.
    const renamed = await rename('contoso', { name: '  Contoso Brasil ' }, { 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` });
    assert.strictEqual(renamed.status, 200, renamed.text);
    assert.deepStrictEqual(renamed.json, { organization: { id: 'contoso', name: 'Contoso Brasil', unassigned: false, project_count: 1, item_count: 1 } });
    assert.deepStrictEqual((await get('/api/organizations')).organizations.find((c) => c.id === 'contoso'), renamed.json.organization);
    assert.deepStrictEqual(await shown(), everywhere('Contoso Brasil'), 'every read shows the new name right away');
    // Its own name, even only changing the case, is accepted; the alphabetical order follows the new name.
    const sameName = await rename('contoso', { name: 'CONTOSO BRASIL' });
    assert.deepStrictEqual([sameName.status, sameName.json.organization.name], [200, 'CONTOSO BRASIL'], sameName.text);
    const zeta = await rename('contoso', { name: 'Zeta' });
    assert.strictEqual(zeta.status, 200, zeta.text);
    assert.deepStrictEqual(await names(), [['fabrikam', 'Fabrikam'], ['contoso', 'Zeta'], ['unassigned', 'Sem organização']]);
    // The CLI, another process, renames while the server runs: the server's next reads show it.
    assert.ok(/Organização "contoso" renomeada de "Zeta" para "Contoso SA"\./.test(ok(flow(r, ['org', 'rename', 'contoso', '--name', 'Contoso SA']))));
    assert.deepStrictEqual(await shown(), everywhere('Contoso SA'), 'a rename by the CLI reaches the server too');
  });
  // The CLI applies the same rules: exit 2 with a Portuguese message.
  invalid(flow(r, ['org', 'rename', 'contoso', '--name', 'fabrikam']), /o nome "fabrikam" já é da organização "fabrikam" \(Fabrikam\)/);
  invalid(flow(r, ['org', 'rename', '--json', '-'], { input: JSON.stringify({ id: 'contoso', name: 'FABRIKAM' }) }), /o nome "FABRIKAM" já é da organização "fabrikam"/);
  invalid(flow(r, ['org', 'rename', 'contoso', '--name', 'C'.repeat(81)]), /o nome da organização precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['org', 'rename', 'contoso', '--name', '  ']), /o nome da organização precisa ter de 1 a 80 caracteres/);
  invalid(flow(r, ['org', 'rename', 'contoso']), /falta o nome da organização/);
  invalid(flow(r, ['org', 'rename', 'unassigned', '--name', 'Outra']), /"Sem organização" é reservada: .*não se renomeia/);
  invalid(flow(r, ['org', 'rename', 'nobody', '--name', 'Outra']), /a organização "nobody" não existe \(organizações: contoso, fabrikam, unassigned\)\.\s*$/);
  invalid(flow(r, ['org', 'rename', 'Bad Id', '--name', 'Outra']), /id de organização inválido: "Bad Id"/);
  invalid(flow(r, ['org', 'rename'], { input: '' }), /falta o id da organização/);
  assert.ok(/Organização "contoso" renomeada de "Contoso SA" para "contoso sa"\./.test(ok(flow(r, ['org', 'rename', 'contoso', '--name', 'contoso sa']))));
  assert.ok(/Organização "fabrikam" renomeada de "Fabrikam" para "Fabrikam Ltda"\./.test(ok(flow(r, ['org', 'rename', '--json', '-'], { input: JSON.stringify({ id: 'fabrikam', name: ' Fabrikam Ltda ' }) }))));
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((c) => [c.id, c.name, c.project_count]),
      [['contoso', 'contoso sa', 1], ['fabrikam', 'Fabrikam Ltda', 0], ['unassigned', 'Sem organização', 1]]);
    assert.deepStrictEqual((await get('/api/items?organization=contoso')).items.map((it) => [it.key, it.project.organization]), [['shop/7', { id: 'contoso', name: 'contoso sa' }]]);
  });
});

suite.test('"Sem organização" is never the organization of a new project: flow project add --org unassigned exits 2', async () => {
  const r = buildRoot('add-reserved');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  const reserved = /"Sem organização" é reservada: ela só recebe os repositórios sem cadastro/;
  // Refused before "Sem organização" exists in the register and after a repository lands there.
  invalid(flow(r, ['project', 'add', 'shop', '--org', 'unassigned', '--repo', 'https://github.com/contoso/shop']), reserved);
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  invalid(flow(r, ['project', 'add', 'shop', '--org', 'unassigned', '--repo', 'https://github.com/contoso/shop']), reserved);
  invalid(flow(r, ['project', 'add', '--json', '-'], { input: JSON.stringify({ id: 'shop', organization: 'unassigned', repos: ['https://github.com/contoso/shop'] }) }), reserved);
  invalid(flow(r, ['project', 'add', 'shop', '--org', 'nobody', '--repo', 'https://github.com/contoso/shop']), /a organização "nobody" não existe .*Cadastre com: flow org add nobody/);
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'shop', '--org', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  // project edit checks the new organization first, as project add does, before the repositories.
  invalid(flow(r, ['project', 'edit', 'shop', '--org', 'nobody', '--repo', 'https://github.com/higor/scratch']), /a organização "nobody" não existe/);
  invalid(flow(r, ['project', 'edit', 'shop', '--org', 'unassigned', '--repo', 'https://github.com/higor/scratch']), reserved);
  // A filter of project list by an unknown organization only lists the organizations (no "Cadastre com").
  invalid(flow(r, ['project', 'list', '--org', 'nobody']), /a organização "nobody" não existe \(organizações: contoso, unassigned\)\.\s*$/);
  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/projects')).projects.map((p) => [p.id, p.organization.id, p.repos]),
      [['scratch', 'unassigned', ['github.com/higor/scratch']], ['shop', 'contoso', ['github.com/contoso/shop']]]);
  });
});

suite.test('the name of "Sem organização" is reserved: creating or renaming an organization with it (ignoring case) is organization_name_taken', async () => {
  const r = buildRoot('reserved-name');
  const taken = (name) => ({ code: 'organization_name_taken', name, organization: 'unassigned', organization_name: 'Sem organização' });
  const cli = (name) => new RegExp(`o nome "${name}" já é da organização "unassigned" \\(Sem organização\\)`);
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  // Before "Sem organização" exists in the register, by the CLI and by the panel.
  invalid(flow(r, ['org', 'add', 'fabrikam', '--name', 'Sem organização']), cli('Sem organização'));
  invalid(flow(r, ['org', 'add', '--json', '-'], { input: JSON.stringify({ id: 'fabrikam', name: ' SEM ORGANIZAÇÃO ' }) }), cli('SEM ORGANIZAÇÃO'));
  invalid(flow(r, ['org', 'rename', 'contoso', '--name', 'sem organização']), cli('sem organização'));
  const post = (port, p, body) => request(port, p, { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const check = async ({ port, get }, when) => {
    const created = await post(port, '/api/organizations', { id: 'fabrikam', name: 'sem ORGANIZAÇÃO' });
    assert.deepStrictEqual([when, created.status, created.json], [when, 409, { error: taken('sem ORGANIZAÇÃO') }]);
    const renamed = await post(port, '/api/organizations/contoso/rename', { name: '  Sem Organização ' });
    assert.deepStrictEqual([when, renamed.status, renamed.json], [when, 409, { error: taken('Sem Organização') }]);
    assert.deepStrictEqual([when, (await get('/api/organizations')).organizations.filter((c) => !c.unassigned).map((c) => [c.id, c.name])], [when, [['contoso', 'Contoso']]]);
  };
  await withServer(r, (s) => check(s, 'before "Sem organização" exists'));
  // After a repository lands there, the same.
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: repo(r, 'scratch', 'https://github.com/higor/scratch.git') }));
  invalid(flow(r, ['org', 'add', 'fabrikam', '--name', 'sem organização']), cli('sem organização'));
  invalid(flow(r, ['org', 'rename', 'contoso', '--name', 'SEM ORGANIZAÇÃO']), cli('SEM ORGANIZAÇÃO'));
  await withServer(r, (s) => check(s, 'after "Sem organização" exists'));
  // A name that only contains it is a name like the others.
  ok(flow(r, ['org', 'add', 'fabrikam', '--name', 'Sem organização Ltda']));
  ok(flow(r, ['org', 'rename', 'contoso', '--name', 'Contoso sem organização']));
});

// The schema v1 as it was released (before #26), frozen here: the migration must take a database like this one to v2.
const SCHEMA_V1 = `
  CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, company_id TEXT NOT NULL REFERENCES companies(id),
    tracker TEXT NOT NULL CHECK (tracker IN ('github', 'azure_devops')), stages TEXT NOT NULL, done_state TEXT,
    maestri_workspace TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE project_repos (remote TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
    item_number INTEGER NOT NULL, task_number INTEGER, agent_role TEXT, agent_name TEXT, source TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_item ON events (project_id, item_number, id);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  PRAGMA user_version = 1;
`;

suite.test('a maestro.db in schema v1 migrates to v2 on its first writer: same register, events untouched (#26)', async () => {
  const { loadSqlite, openStore } = require(path.join(REPO, 'bin', 'flow-store.js'));
  const { DatabaseSync } = loadSqlite();
  const r = buildRoot('migration');
  fs.mkdirSync(r.data, { recursive: true });
  const file = path.join(r.data, 'maestro.db');
  const v1 = new DatabaseSync(file);
  v1.exec(SCHEMA_V1);
  v1.exec(`
    INSERT INTO companies VALUES ('meu', 'Meu', '2026-09-01T10:00:00-03:00'), ('pessoal', 'Pessoal', '2026-09-01T10:00:00-03:00'),
      ('unassigned', 'Sem empresa', '2026-09-01T11:00:00-03:00');
    INSERT INTO projects VALUES ('painel-maestro', 'Painel Maestro', 'pessoal', 'github', '["specification","implementation","pr_ready","merge","done"]', NULL, 'Painel', '2026-09-01T10:01:00-03:00'),
      ('scratch', 'scratch', 'unassigned', 'github', '["specification","implementation","pr_ready","merge","done"]', NULL, NULL, '2026-09-01T11:00:00-03:00');
    INSERT INTO project_repos VALUES ('github.com/higorcesarqn/painel-maestro', 'painel-maestro'), ('github.com/higorcesarqn/scratch', 'scratch');
    INSERT INTO events (at, type, project_id, item_number, task_number, agent_role, agent_name, source, payload) VALUES
      ('2026-09-02T09:00:00-03:00', 'item-started', 'painel-maestro', 26, NULL, 'maestro', 'Shell', 'cli', '{"title":"Renomear","stage":"specification"}'),
      ('2026-09-02T09:30:00-03:00', 'stage-changed', 'painel-maestro', 26, NULL, 'maestro', 'Shell', 'cli', '{"stage":"implementation"}');
  `);
  const eventsBefore = v1.prepare('SELECT * FROM events ORDER BY id').all();
  v1.close();

  // A reader never migrates: until a writer opens it, a v1 database reads as none, and stays v1.
  assert.strictEqual(openStore({ dir: r.data, readOnly: true }), null);
  const userVersion = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); }
  };
  assert.strictEqual(userVersion(), 1);

  const list = ok(flow(r, ['org', 'list']));
  assert.ok(/^meu\s+Meu · 0 projetos$/m.test(list) && /^pessoal\s+Pessoal · 1 projeto$/m.test(list), list);
  // The reserved row keeps its id and takes the name of the dictionary (the v1 name was the old one).
  assert.ok(/^unassigned\s+Sem organização · 1 projeto$/m.test(list), list);

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 2);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((x) => x.name);
    assert.deepStrictEqual(tables, ['events', 'organizations', 'project_repos', 'projects']);
    assert.deepStrictEqual(db.prepare('SELECT * FROM organizations ORDER BY id').all().map((x) => ({ ...x })), [
      { id: 'meu', name: 'Meu', created_at: '2026-09-01T10:00:00-03:00' },
      { id: 'pessoal', name: 'Pessoal', created_at: '2026-09-01T10:00:00-03:00' },
      { id: 'unassigned', name: 'Sem organização', created_at: '2026-09-01T11:00:00-03:00' },
    ]);
    assert.deepStrictEqual(db.prepare('SELECT id, organization_id FROM projects ORDER BY id').all().map((x) => ({ ...x })),
      [{ id: 'painel-maestro', organization_id: 'pessoal' }, { id: 'scratch', organization_id: 'unassigned' }]);
    const fk = db.prepare('PRAGMA foreign_key_list(projects)').all().map((x) => [x.table, x.from, x.to]);
    assert.deepStrictEqual(fk, [['organizations', 'organization_id', 'id']]);
    assert.deepStrictEqual(db.prepare('SELECT * FROM events ORDER BY id').all(), eventsBefore);
  } finally {
    db.close();
  }

  // The flow commands of the repository and the panel read the migrated database as before.
  const painel = repo(r, 'painel-maestro', 'https://github.com/higorcesarqn/painel-maestro.git');
  ok(flow(r, ['stage', '26', 'pr_ready'], { cwd: painel }));
  invalid(flow(r, ['org', 'remove', 'pessoal']), /a organização "pessoal" \(Pessoal\) tem 1 projeto/);
  await withServer(r, async ({ get }) => {
    const { organizations } = await get('/api/organizations');
    assert.deepStrictEqual(organizations.map((o) => [o.id, o.name]), [['meu', 'Meu'], ['pessoal', 'Pessoal'], ['unassigned', 'Sem organização']]);
    const { projects } = await get('/api/projects');
    assert.deepStrictEqual(projects.map((p) => [p.id, p.organization, p.repos]), [
      ['scratch', { id: 'unassigned', name: 'Sem organização' }, ['github.com/higorcesarqn/scratch']],
      ['painel-maestro', { id: 'pessoal', name: 'Pessoal' }, ['github.com/higorcesarqn/painel-maestro']],
    ]);
    const item = (await get('/api/items/painel-maestro/26')).item;
    assert.deepStrictEqual([item.title, item.stage, item.project.organization.id], ['Renomear', 'pr_ready', 'pessoal']);
    assert.deepStrictEqual(item.timeline.map((e) => e.payload.stage), ['specification', 'implementation', 'pr_ready']);
  });
});

suite.test('the old "company" subcommand and --company option are unknown, without an alias (#26)', () => {
  const r = buildRoot('no-company');
  invalid(flow(r, ['company', 'list']), /subcomando desconhecido: "company"/);
  invalid(flow(r, ['company', 'add', 'contoso', '--name', 'Contoso']), /subcomando desconhecido: "company"/);
  invalid(flow(r, ['project', 'list', '--company', 'contoso']), /opção desconhecida: --company/);
  invalid(flow(r, ['project', 'add', 'shop', '--company', 'contoso', '--repo', 'https://github.com/fabrikam/shop']), /opção desconhecida: --company/);
  invalid(flow(r, ['project', 'edit', 'shop', '--company', 'contoso']), /opção desconhecida: --company/);
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'an unknown command creates no database');
});

suite.test('help lists the org and project subcommands', () => {
  const r = buildRoot('help');
  const out = ok(flow(r, ['--help']));
  assert.ok(/org add <id> --name/.test(out) && /org rename <id> --name/.test(out) && /org remove <id>/.test(out) && /project add <id> --org <id>/.test(out) && /project move <id> <organização>/.test(out), out);
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
