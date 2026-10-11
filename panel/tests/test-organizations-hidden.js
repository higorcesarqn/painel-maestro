'use strict';
// Tests for the hidden organization (#49) through the agreed seam only: the bin/flow.js CLI runs as a process (inside
// temporary git repositories with fictitious remotes) → temporary maestro.db (MAESTRO_DIR) → the server's HTTP API.
// No test reads the database or calls internal functions, but for the migration of a schema v2 file.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('hidden organization: flow CLI → maestro.db → API');
const roots = [];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root: data folder (MAESTRO_DIR), a folder outside any repository and repositories created on demand. */
function buildRoot(name) {
  const root = tmpDir(`organizations-hidden-${name}`);
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

/** Runs the CLI outside of Maestri; by default in a folder outside any repository. */
function flow(r, args, { cwd = r.outside, input } = {}) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: '', NODE_OPTIONS: '', GIT_CEILING_DIRECTORIES: r.root });
  for (const k of ['MAESTRI_TERMINAL_ID', 'MAESTRI_TERMINAL_NAME', 'MAESTRI_WORKSPACE_ID', 'MAESTRI_WORKSPACE_NAME']) delete env[k];
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
      post: (p, { headers = { 'X-Panel': '1' }, host, body } = {}) => request(port, p, { method: 'POST', host, headers, body }),
    });
  } finally {
    await s.stop();
  }
}

/** Contoso (visible, the control) and Fabrikam, each with a project and an item; Fabrikam's item has an open pending decision. */
function twoOrganizations(name) {
  const r = buildRoot(name);
  const widgets = repo(r, 'widgets', 'https://github.com/contoso/widgets.git');
  const shop = repo(r, 'shop', 'https://github.com/fabrikam/shop.git');
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['org', 'add', 'fabrikam', '--name', 'Fabrikam']));
  ok(flow(r, ['project', 'add', 'widgets', '--org', 'contoso'], { cwd: widgets }));
  ok(flow(r, ['project', 'add', 'shop', '--name', 'Loja', '--org', 'fabrikam'], { cwd: shop }));
  ok(flow(r, ['item', 'start', '12', '--title', 'Relatório'], { cwd: widgets }));
  ok(flow(r, ['item', 'start', '48', '--title', 'Carrinho'], { cwd: shop }));
  return { r, widgets, shop };
}

const ids = (list) => list.map((x) => x.id);

suite.test('flow org hide / unhide hide and show an organization; repeating is not an error; org list marks the hidden ones', () => {
  const { r } = twoOrganizations('cli');
  assert.ok(/Organização "fabrikam" \(Fabrikam\) oculta/.test(ok(flow(r, ['org', 'hide', 'fabrikam']))));
  assert.ok(/Organização "fabrikam" \(Fabrikam\) já estava oculta/.test(ok(flow(r, ['org', 'hide', 'fabrikam']))));
  const list = ok(flow(r, ['org', 'list']));
  assert.ok(/^fabrikam\s+Fabrikam · 1 projeto · oculta$/m.test(list), list);
  assert.ok(/^contoso\s+Contoso · 1 projeto$/m.test(list), list);
  assert.ok(/Organização "fabrikam" \(Fabrikam\) mostrada/.test(ok(flow(r, ['org', 'unhide', 'fabrikam']))));
  assert.ok(/Organização "fabrikam" \(Fabrikam\) já estava visível/.test(ok(flow(r, ['org', 'unhide', 'fabrikam']))));
  assert.ok(/^fabrikam\s+Fabrikam · 1 projeto$/m.test(ok(flow(r, ['org', 'list']))));
  // By JSON, like the other org subcommands.
  assert.ok(/oculta/.test(ok(flow(r, ['org', 'hide', '--json', '-'], { input: JSON.stringify({ id: 'contoso' }) }))));
  assert.ok(/^contoso\s+Contoso · 1 projeto · oculta$/m.test(ok(flow(r, ['org', 'list']))));
  ok(flow(r, ['org', 'unhide', '--json', '-'], { input: JSON.stringify({ id: 'contoso' }) }));
  // Invalid: unknown, missing or invalid id, extra options.
  invalid(flow(r, ['org', 'hide', 'nobody']), /a organização "nobody" não existe \(organizações: contoso, fabrikam\)\.$/m);
  invalid(flow(r, ['org', 'unhide', 'nobody']), /a organização "nobody" não existe \(organizações: contoso, fabrikam\)\.$/m);
  invalid(flow(r, ['org', 'hide']), /falta o id da organização/);
  invalid(flow(r, ['org', 'hide', 'A B']), /id de organização inválido/);
  invalid(flow(r, ['org', 'hide', 'contoso', '--name', 'x']), /opção desconhecida: --name/);
  assert.ok(!/oculta/.test(ok(flow(r, ['org', 'list']))), 'nothing hidden by a refused command');
});

suite.test('help lists org hide and org unhide', () => {
  const r = buildRoot('help');
  const out = ok(flow(r, ['--help']));
  assert.ok(/org hide <id>/.test(out) && /org unhide <id>/.test(out), out);
  // The Organizations screen moved into Configurações (#48): the help points there, not to a screen that is gone.
  assert.ok(!/tela Organizações/.test(out) && /Configurações → Organizações/.test(out), out);
});

suite.test('POST /api/organizations/<id>/hide and /unhide answer { organization } as GET lists it, under the POST rules; 404 when unknown', async () => {
  const { r } = twoOrganizations('api');
  await withServer(r, async ({ port, get, post }) => {
    const hide = '/api/organizations/fabrikam/hide';
    // Security: X-Panel, Origin and Host, exactly as every POST of the server.
    const without = await post(hide, { headers: {} });
    assert.deepStrictEqual([without.status, without.json.error.code], [403, 'missing_panel_header']);
    const foreign = await post(hide, { headers: { 'X-Panel': '1', Origin: 'http://evil.example' } });
    assert.deepStrictEqual([foreign.status, foreign.json.error.code], [403, 'origin_not_allowed']);
    const host = await post(hide, { host: 'evil.example' });
    assert.strictEqual(host.status, 403);
    const get405 = await request(port, hide);
    assert.deepStrictEqual([get405.status, get405.json.error.code], [405, 'method_not_allowed']);
    assert.deepStrictEqual(ids((await get('/api/organizations')).organizations), ['contoso', 'fabrikam'], 'nothing hidden by a refused POST');

    const hidden = await post(hide, { headers: { 'X-Panel': '1', Origin: `http://127.0.0.1:${port}` } });
    assert.strictEqual(hidden.status, 200, hidden.text);
    const listed = (await get('/api/organizations?hidden=include')).organizations.find((o) => o.id === 'fabrikam');
    assert.deepStrictEqual(hidden.json, { organization: listed });
    assert.deepStrictEqual([listed.name, listed.hidden, listed.project_count, listed.item_count], ['Fabrikam', true, 1, 1]);
    // Repeating is not an error.
    const again = await post(hide);
    assert.deepStrictEqual([again.status, again.json.organization.hidden], [200, true]);

    const shown = await post('/api/organizations/fabrikam/unhide');
    assert.strictEqual(shown.status, 200, shown.text);
    assert.deepStrictEqual(shown.json, { organization: (await get('/api/organizations')).organizations.find((o) => o.id === 'fabrikam') });
    assert.strictEqual(shown.json.organization.hidden, false);
    assert.deepStrictEqual([(await post('/api/organizations/fabrikam/unhide')).status], [200]);

    for (const verb of ['hide', 'unhide']) {
      const missing = await post(`/api/organizations/nobody/${verb}`);
      assert.deepStrictEqual([missing.status, missing.json.error], [404, { code: 'organization_not_found', organization: 'nobody' }]);
      const bad = await post(`/api/organizations/A%20B/${verb}`);
      assert.deepStrictEqual([bad.status, bad.json.error.code], [404, 'route_not_found']);
    }
  });
});

suite.test('without maestro.db, hide and unhide are 404 organization_not_found and create nothing', async () => {
  const r = buildRoot('no-db');
  await withServer(r, async ({ post }) => {
    for (const p of ['/api/organizations/contoso/hide', '/api/organizations/unassigned/hide', '/api/organizations/contoso/unhide']) {
      const x = await post(p);
      assert.deepStrictEqual([p, x.status, x.json.error.code], [p, 404, 'organization_not_found']);
    }
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')), 'no database created');
});

suite.test('GET /api/organizations and /api/projects leave the hidden ones and their projects out; ?hidden=include brings them with hidden and the open pending decisions', async () => {
  const { r, shop, widgets } = twoOrganizations('lists');
  ok(flow(r, ['pending', 'open', '48', '--kind', 'decision', '--title', 'Qual frete?'], { cwd: shop }));
  ok(flow(r, ['pending', 'open', '48', '--kind', 'decision', '--title', 'Qual cupom?', '--severity', 'high'], { cwd: shop }));
  const closed = /\bP-(\d+)\b/.exec(ok(flow(r, ['pending', 'open', '48', '--kind', 'decision', '--title', 'Qual cor?'], { cwd: shop })))[1];
  ok(flow(r, ['pending', 'resolve', closed, '--decision', 'Azul'], { cwd: shop }));
  ok(flow(r, ['pending', 'open', '12', '--kind', 'decision', '--title', 'Qual nome?'], { cwd: widgets }));
  ok(flow(r, ['org', 'hide', 'fabrikam']));
  await withServer(r, async ({ port, get }) => {
    const { organizations } = await get('/api/organizations');
    assert.deepStrictEqual(organizations.map((o) => [o.id, o.hidden, o.open_pending_count]), [['contoso', false, 1]]);
    assert.deepStrictEqual(ids((await get('/api/projects')).projects), ['widgets']);
    assert.deepStrictEqual(ids((await get('/api/projects?organization=fabrikam')).projects), [], 'a hidden organization filters to nothing');
    assert.deepStrictEqual(ids((await get('/api/projects?organization=contoso')).projects), ['widgets']);

    const all = (await get('/api/organizations?hidden=include')).organizations;
    assert.deepStrictEqual(all.map((o) => [o.id, o.name, o.unassigned, o.hidden, o.project_count, o.item_count, o.open_pending_count]),
      [['contoso', 'Contoso', false, false, 1, 1, 1], ['fabrikam', 'Fabrikam', false, true, 1, 1, 2]]);
    const projects = (await get('/api/projects?hidden=include')).projects;
    assert.deepStrictEqual(projects.map((p) => [p.id, p.organization.id]), [['widgets', 'contoso'], ['shop', 'fabrikam']]);
    assert.deepStrictEqual(ids((await get('/api/projects?hidden=include&organization=fabrikam')).projects), ['shop']);

    // Only "include" is a value of hidden.
    for (const p of ['/api/organizations?hidden=yes', '/api/projects?hidden=1']) {
      const x = await request(port, p);
      assert.deepStrictEqual([p, x.status, x.json.error.code, x.json.error.param], [p, 400, 'invalid_filter', 'hidden']);
    }
    // Shown again, it is back in both lists, on the same server.
    ok(flow(r, ['org', 'unhide', 'fabrikam']));
    assert.deepStrictEqual(ids((await request(port, '/api/organizations')).json.organizations), ['contoso', 'fabrikam']);
    assert.deepStrictEqual(ids((await request(port, '/api/projects')).json.projects), ['widgets', 'shop']);
  });
});

suite.test('a project moves to a hidden organization, by the panel and by the CLI', async () => {
  const { r } = twoOrganizations('move');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  ok(flow(r, ['org', 'hide', 'fabrikam']));
  await withServer(r, async ({ get, post }) => {
    const moved = await post('/api/projects/scratch/organization', { headers: { 'X-Panel': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ organization: 'fabrikam' }) });
    assert.strictEqual(moved.status, 200, moved.text);
    assert.deepStrictEqual(moved.json.project.organization, { id: 'fabrikam', name: 'Fabrikam' });
    assert.deepStrictEqual(ids((await get('/api/projects')).projects), ['widgets'], 'the moved project left the lists with its organization');
    assert.deepStrictEqual((await get('/api/projects?hidden=include&organization=fabrikam')).projects.map((p) => p.id), ['shop', 'scratch']);
  });
  assert.ok(/Projeto "widgets" movido de "Contoso" para "Fabrikam"/.test(ok(flow(r, ['project', 'move', 'widgets', 'fabrikam']))));
});

suite.test('"Sem organização" may be hidden (even before a repository lands there) and stays reserved for rename, remove and moves', async () => {
  const r = buildRoot('unassigned');
  const scratch = repo(r, 'scratch', 'https://github.com/higor/scratch.git');
  const reserved = /"Sem organização" é reservada/;
  ok(flow(r, ['org', 'add', 'contoso', '--name', 'Contoso']));
  ok(flow(r, ['project', 'add', 'shop', '--org', 'contoso', '--repo', 'https://github.com/contoso/shop']));
  assert.ok(/Organização "unassigned" \(Sem organização\) oculta/.test(ok(flow(r, ['org', 'hide', 'unassigned']))));
  // A repository without register lands in it hidden.
  ok(flow(r, ['item', 'start', '3', '--title', 'Rascunho'], { cwd: scratch }));
  assert.ok(/^unassigned\s+Sem organização · 1 projeto · oculta$/m.test(ok(flow(r, ['org', 'list']))));
  invalid(flow(r, ['org', 'rename', 'unassigned', '--name', 'Outra']), reserved);
  invalid(flow(r, ['org', 'remove', 'unassigned']), reserved);
  invalid(flow(r, ['project', 'move', 'shop', 'unassigned']), reserved);
  await withServer(r, async ({ get, post }) => {
    assert.deepStrictEqual(ids((await get('/api/organizations')).organizations), ['contoso']);
    assert.deepStrictEqual(ids((await get('/api/projects')).projects), ['shop']);
    const all = (await get('/api/organizations?hidden=include')).organizations;
    assert.deepStrictEqual(all.map((o) => [o.id, o.unassigned, o.hidden, o.project_count]), [['contoso', false, false, 1], ['unassigned', true, true, 1]]);
    const json = { 'X-Panel': '1', 'Content-Type': 'application/json' };
    const rename = await post('/api/organizations/unassigned/rename', { headers: json, body: JSON.stringify({ name: 'Outra' }) });
    assert.deepStrictEqual([rename.status, rename.json.error.code], [400, 'organization_reserved']);
    const removed = await post('/api/organizations/unassigned/remove');
    assert.deepStrictEqual([removed.status, removed.json.error.code], [400, 'organization_reserved']);
    const move = await post('/api/projects/shop/organization', { headers: json, body: JSON.stringify({ organization: 'unassigned' }) });
    assert.deepStrictEqual([move.status, move.json.error.code], [400, 'organization_reserved']);
    // Shown again by the panel; its project leaves it by a move as always.
    const shown = await post('/api/organizations/unassigned/unhide');
    assert.deepStrictEqual([shown.status, shown.json.organization.id, shown.json.organization.unassigned, shown.json.organization.hidden], [200, 'unassigned', true, false]);
    assert.deepStrictEqual(ids((await get('/api/projects')).projects), ['scratch', 'shop']);
  });
});

suite.test('the flow works as before for a project of a hidden organization, and its item page answers by the key', async () => {
  const { r, shop } = twoOrganizations('flow');
  ok(flow(r, ['org', 'hide', 'fabrikam']));
  ok(flow(r, ['stage', '48', 'implementation'], { cwd: shop }));
  ok(flow(r, ['item', 'start', '49', '--title', 'Frete'], { cwd: shop }));
  ok(flow(r, ['task', 'graph', '49', '--task', '50|Tabela de frete'], { cwd: shop }));
  const id = /\bP-(\d+)\b/.exec(ok(flow(r, ['pending', 'open', '48', '--kind', 'decision', '--title', 'Qual frete?'], { cwd: shop })))[1];
  ok(flow(r, ['pending', 'resolve', id, '--decision', 'Grátis'], { cwd: shop }));
  await withServer(r, async ({ get }) => {
    const item = (await get('/api/items/shop/48')).item;
    assert.deepStrictEqual([item.key, item.stage, item.project.organization.id], ['shop/48', 'implementation', 'fabrikam']);
    const other = (await get('/api/items/shop/49')).item;
    assert.deepStrictEqual(other.tasks.map((t) => [t.number, t.title]), [[50, 'Tabela de frete']]);
  });
});

// The schema v2 as it was released (#26 to #49), frozen here: the migration must take a database like this one to v3.
const SCHEMA_V2 = `
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id),
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
  PRAGMA user_version = 2;
`;

suite.test('a maestro.db in schema v2 migrates to v3 on its first writer, with every organization visible', async () => {
  const { loadSqlite, openStore } = require(path.join(REPO, 'bin', 'flow-store.js'));
  const { DatabaseSync } = loadSqlite();
  const r = buildRoot('migration');
  fs.mkdirSync(r.data, { recursive: true });
  const file = path.join(r.data, 'maestro.db');
  const v2 = new DatabaseSync(file);
  v2.exec(SCHEMA_V2);
  v2.exec(`
    INSERT INTO organizations VALUES ('pessoal', 'Pessoal', '2026-09-01T10:00:00-03:00'), ('unassigned', 'Sem organização', '2026-09-01T11:00:00-03:00');
    INSERT INTO projects VALUES ('painel-maestro', 'Painel Maestro', 'pessoal', 'github', '["specification","implementation","pr_ready","merge","done"]', NULL, 'Painel', '2026-09-01T10:01:00-03:00'),
      ('scratch', 'scratch', 'unassigned', 'github', '["specification","implementation","pr_ready","merge","done"]', NULL, NULL, '2026-09-01T11:00:00-03:00');
    INSERT INTO project_repos VALUES ('github.com/higorcesarqn/painel-maestro', 'painel-maestro'), ('github.com/higorcesarqn/scratch', 'scratch');
    INSERT INTO events (at, type, project_id, item_number, task_number, agent_role, agent_name, source, payload) VALUES
      ('2026-09-02T09:00:00-03:00', 'item-started', 'painel-maestro', 49, NULL, 'maestro', 'Shell', 'cli', '{"title":"Ocultar","stage":"specification"}');
  `);
  const eventsBefore = v2.prepare('SELECT * FROM events ORDER BY id').all();
  v2.close();

  // A reader never migrates: until a writer opens it, a v2 database reads as none, and stays v2.
  assert.strictEqual(openStore({ dir: r.data, readOnly: true }), null);
  const list = ok(flow(r, ['org', 'list']));
  assert.ok(/^pessoal\s+Pessoal · 1 projeto$/m.test(list) && /^unassigned\s+Sem organização · 1 projeto$/m.test(list), list);

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.strictEqual(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepStrictEqual(db.prepare('SELECT id, hidden FROM organizations ORDER BY id').all().map((x) => ({ ...x })),
      [{ id: 'pessoal', hidden: 0 }, { id: 'unassigned', hidden: 0 }]);
    assert.deepStrictEqual(db.prepare('SELECT * FROM events ORDER BY id').all(), eventsBefore);
  } finally {
    db.close();
  }

  await withServer(r, async ({ get }) => {
    assert.deepStrictEqual((await get('/api/organizations')).organizations.map((o) => [o.id, o.hidden]), [['pessoal', false], ['unassigned', false]]);
    assert.deepStrictEqual(ids((await get('/api/projects')).projects), ['scratch', 'painel-maestro']);
  });
  ok(flow(r, ['org', 'hide', 'pessoal']));
  assert.ok(/^pessoal\s+Pessoal · 1 projeto · oculta$/m.test(ok(flow(r, ['org', 'list']))));
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
