'use strict';
// Tests for the Overview and the health badge of the new model (#14) through the agreed seam only: the flow CLI and the
// hook run as processes (temporary git repositories with fictitious remotes) → temporary maestro.db and bruto.db
// (MAESTRO_DIR) → GET /api/overview and the health of GET /api/state. No test reads the databases.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request } = require('./util');

const FLOW = path.join(REPO, 'bin', 'flow.js');
const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('Overview and health of the new model: flow CLI and hook → maestro.db and bruto.db → API');
const roots = [];
const sp = (hms, day = '2026-10-09') => `${day}T${hms}-03:00`;
const NOW = sp('12:00:00');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temporary root with three repositories: widgets and cidax (registered by the tests when needed) and scratch. */
function buildRoot(name) {
  const root = tmpDir(`overview-${name}`);
  roots.push(root);
  const data = path.join(root, 'data');
  const repo = (dir, remote) => {
    const p = path.join(root, dir);
    fs.mkdirSync(p, { recursive: true });
    git(p, 'init', '-q');
    git(p, 'remote', 'add', 'origin', remote);
    return p;
  };
  return {
    root, data,
    widgets: repo('widgets', 'https://github.com/acme/widgets.git'),
    cidax: repo('cidax', 'https://dev.azure.com/contoso/CIDAX/_git/cidax-api'),
    scratch: repo('scratch', 'https://github.com/someone/scratch.git'),
  };
}

function flow(r, cwd, now, ...args) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.data, MAESTRO_NOW: now, NODE_OPTIONS: '', GIT_CEILING_DIRECTORIES: r.root, MAESTRI_TERMINAL_ID: '' });
  const x = spawnSync(process.execPath, [FLOW, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.strictEqual(x.status, 0, `flow ${args.join(' ')}: ${x.stderr}`);
  return x.stdout;
}

/** Runs the hook as Claude Code does (the event JSON on stdin). */
function hook(r, cwd, now, session = 'sess-1') {
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: r.data, MAESTRO_NOW: now, NODE_OPTIONS: '', MAESTRI_WORKSPACE_ID: '', MAESTRI_TERMINAL_ID: '', CLAUDE_PROJECT_DIR: '', GIT_CEILING_DIRECTORIES: r.root,
  });
  const payload = { session_id: session, cwd, transcript_path: path.join(r.root, `${session}.jsonl`), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } };
  const x = spawnSync(process.execPath, [HOOK], { cwd: r.root, input: JSON.stringify(payload), env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.deepStrictEqual([x.status, x.stdout, x.stderr], [0, '', ''], 'the hook exits 0 in silence');
}

/** Contoso with the widgets (GitHub) and cidax (Azure DevOps) projects; scratch lands in "Sem organização" on its first item. */
function registerContoso(r) {
  flow(r, r.root, sp('08:00:00', '2026-10-01'), 'org', 'add', 'contoso', '--name', 'Contoso');
  flow(r, r.widgets, sp('08:00:00', '2026-10-01'), 'project', 'add', 'widgets', '--name', 'Widgets', '--org', 'contoso');
  flow(r, r.cidax, sp('08:00:00', '2026-10-01'), 'project', 'add', 'cidax', '--name', 'CIDAX', '--org', 'contoso', '--tracker', 'azure_devops');
}

async function withServer(r, fn, env = {}) {
  const port = await freePort();
  const s = await srv.start({
    argv: ['--port', String(port)],
    env: { MAESTRO_DIR: r.data, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), PANEL_NOW: NOW, ...env },
  });
  try {
    await fn(async (p) => {
      const x = await request(port, p);
      assert.strictEqual(x.status, 200, `${p}: ${x.text}`);
      return x.json;
    }, (p) => request(port, p));
  } finally {
    await s.stop();
  }
}

suite.test('the active items are counted by organization, project and stage; done items stay out', async () => {
  const r = buildRoot('active');
  registerContoso(r);
  flow(r, r.widgets, sp('09:00:00', '2026-10-08'), 'item', 'start', '12', '--title', 'Exportar PDF');
  flow(r, r.widgets, sp('10:00:00', '2026-10-08'), 'stage', '12', 'implementation');
  flow(r, r.widgets, sp('11:00:00', '2026-10-08'), 'item', 'start', '13', '--title', 'Outro', '--stage', 'implementation');
  flow(r, r.widgets, sp('11:30:00', '2026-10-08'), 'item', 'start', '14', '--title', 'Entregue', '--stage', 'implementation');
  flow(r, r.widgets, sp('11:40:00', '2026-10-08'), 'item', 'done', '14');
  flow(r, r.cidax, sp('09:00:00'), 'item', 'start', '3100', '--title', 'Conciliação');
  flow(r, r.scratch, sp('09:30:00'), 'item', 'start', '3', '--title', 'Rascunho');
  await withServer(r, async (get) => {
    const o = await get('/api/overview');
    assert.strictEqual(o.generated_at, NOW);
    assert.strictEqual(o.organization, null);
    assert.strictEqual(o.active.total, 4);
    assert.deepStrictEqual(o.active.by_stage, { implementation: 2, specification: 2 });
    assert.deepStrictEqual(o.active.organizations.map((c) => [c.id, c.name, c.unassigned, c.total]), [['contoso', 'Contoso', false, 3], ['unassigned', 'Sem organização', true, 1]]);
    const contoso = o.active.organizations[0];
    assert.deepStrictEqual(contoso.projects.map((p) => [p.id, p.name, p.tracker, p.total, p.by_stage]), [
      ['cidax', 'CIDAX', 'azure_devops', 1, { specification: 1 }],
      ['widgets', 'Widgets', 'github', 2, { implementation: 2 }],
    ]);
    assert.ok(Array.isArray(contoso.projects[0].stages) && contoso.projects[0].stages.includes('hml_validation'), 'the stages of the project travel with it');
  });
});

suite.test('items parked on the same stage for longer than PANEL_STALE_HOURS (default 48 h) are listed, the oldest first', async () => {
  const r = buildRoot('stale');
  registerContoso(r);
  flow(r, r.widgets, sp('09:00:00', '2026-10-01'), 'item', 'start', '12', '--title', 'Parado na especificação');
  flow(r, r.widgets, sp('10:00:00', '2026-10-02'), 'item', 'start', '13', '--title', 'Mexeu ontem', '--stage', 'implementation');
  flow(r, r.widgets, sp('10:00:00', '2026-10-08'), 'stage', '13', 'pr_ready');
  flow(r, r.cidax, sp('11:00:00', '2026-10-06'), 'item', 'start', '3100', '--title', 'Três dias em implementação', '--stage', 'implementation');
  // A status of a task is activity, but not a change of stage: the item is still parked.
  flow(r, r.cidax, sp('11:30:00', '2026-10-06'), 'task', 'graph', '3100', '--task', '3101|Importar');
  flow(r, r.widgets, sp('09:00:00', '2026-10-02'), 'item', 'start', '14', '--title', 'Concluído há tempo', '--stage', 'implementation');
  flow(r, r.widgets, sp('09:10:00', '2026-10-02'), 'item', 'done', '14');
  await withServer(r, async (get) => {
    const o = await get('/api/overview');
    assert.strictEqual(o.stale_hours, 48);
    assert.deepStrictEqual(o.stale_items.map((it) => [it.key, it.tracker_ref, it.title, it.stage, it.stage_since, it.hours, it.project.organization.id]), [
      ['widgets/12', '#12', 'Parado na especificação', 'specification', sp('09:00:00', '2026-10-01'), 195, 'contoso'],
      ['cidax/3100', 'PBI 3100', 'Três dias em implementação', 'implementation', sp('11:00:00', '2026-10-06'), 73, 'contoso'],
    ]);
  });
  await withServer(r, async (get) => {
    const o = await get('/api/overview');
    assert.strictEqual(o.stale_hours, 200);
    assert.deepStrictEqual(o.stale_items, []);
  }, { PANEL_STALE_HOURS: '200' });
  const bad = spawnSync(process.execPath, [path.join(REPO, 'panel', 'server.js'), '--port', '4799'], {
    env: Object.assign({}, process.env, { MAESTRO_DIR: r.data, PANEL_STALE_HOURS: 'muito', PANEL_PORT: '' }), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.strictEqual(bad.status, 2, bad.stderr);
  assert.ok(bad.stderr.includes('PANEL_STALE_HOURS'), bad.stderr);
});

suite.test('the organization of the selector narrows the whole Overview; another value is refused with a code', async () => {
  const r = buildRoot('organization');
  registerContoso(r);
  flow(r, r.widgets, sp('09:00:00', '2026-10-01'), 'item', 'start', '12', '--title', 'Da Contoso');
  flow(r, r.scratch, sp('09:00:00', '2026-10-01'), 'item', 'start', '3', '--title', 'Sem organização');
  flow(r, r.scratch, sp('09:10:00', '2026-10-01'), 'pending', 'open', '3', '--kind', 'decision', '--title', 'Qual layout?');
  await withServer(r, async (get, raw) => {
    const o = await get('/api/overview?organization=contoso');
    assert.strictEqual(o.organization, 'contoso');
    assert.deepStrictEqual([o.active.total, o.active.organizations.map((c) => c.id)], [1, ['contoso']]);
    assert.deepStrictEqual(o.stale_items.map((it) => it.key), ['widgets/12']);
    assert.deepStrictEqual([o.pending_decisions.total, o.pending_decisions.open], [0, []]);
    assert.deepStrictEqual(o.recent_events.map((e) => e.item_key), ['widgets/12']);
    const u = await get('/api/overview?organization=unassigned');
    assert.deepStrictEqual([u.active.total, u.pending_decisions.total, u.recent_events.length], [1, 1, 2]);
    const x = await raw('/api/overview?organization=Contoso!');
    assert.deepStrictEqual([x.status, x.json.error.code, x.json.error.param], [400, 'invalid_filter', 'organization']);
  });
});

suite.test('open pending decisions (the most urgent first, counted by severity) and the recent activity of the new model', async () => {
  const r = buildRoot('pending');
  registerContoso(r);
  flow(r, r.widgets, sp('09:00:00', '2026-10-08'), 'item', 'start', '12', '--title', 'Exportar PDF');
  flow(r, r.widgets, sp('09:10:00', '2026-10-08'), 'pending', 'open', '12', '--kind', 'decision', '--title', 'Normal antiga');
  const critical = flow(r, r.widgets, sp('08:00:00'), 'pending', 'open', '12', '--kind', 'worker_blocked', '--severity', 'critical', '--title', 'Sem certificado').match(/P-\d+/)[0];
  const done = flow(r, r.widgets, sp('09:00:00'), 'pending', 'open', '12', '--kind', 'decision', '--severity', 'high', '--title', 'Já decidida').match(/P-\d+/)[0];
  flow(r, r.widgets, sp('09:30:00'), 'pending', 'resolve', done, '--decision', 'A');
  flow(r, r.widgets, sp('10:00:00'), 'stage', '12', 'implementation', '--role', 'worker', '--agent', 'Ária');
  await withServer(r, async (get) => {
    const o = await get('/api/overview');
    assert.deepStrictEqual(o.pending_decisions.by_severity, { critical: 1, high: 0, normal: 1, low: 0 });
    assert.strictEqual(o.pending_decisions.total, 2);
    assert.deepStrictEqual(o.pending_decisions.open.map((p) => [`P-${p.id}`, p.severity, p.kind, p.title, p.item.key, p.item.tracker_ref]), [
      [critical, 'critical', 'worker_blocked', 'Sem certificado', 'widgets/12', '#12'],
      [o.pending_decisions.open[1] && `P-${o.pending_decisions.open[1].id}`, 'normal', 'decision', 'Normal antiga', 'widgets/12', '#12'],
    ]);
    // Recent activity: the events of maestro.db, newest first, in the shape of the Log (they open in its modal).
    assert.deepStrictEqual(o.recent_events.map((e) => [e.at, e.type, e.item_key]), [
      [sp('10:00:00'), 'stage-changed', 'widgets/12'],
      [sp('09:30:00'), 'pending-decision-resolved', 'widgets/12'],
      [sp('09:00:00'), 'pending-decision-opened', 'widgets/12'],
      [sp('08:00:00'), 'pending-decision-opened', 'widgets/12'],
      [sp('09:10:00', '2026-10-08'), 'pending-decision-opened', 'widgets/12'],
      [sp('09:00:00', '2026-10-08'), 'item-started', 'widgets/12'],
    ]);
    const last = o.recent_events[0];
    assert.deepStrictEqual([last.agent, last.item_title, last.project.organization.id, last.payload.stage], [{ role: 'worker', name: 'Ária' }, 'Exportar PDF', 'contoso', 'implementation']);
    assert.strictEqual(o.events_today, 4);
  });
});

suite.test('without maestro.db the Overview is empty (and the database is not created)', async () => {
  const r = buildRoot('empty');
  await withServer(r, async (get) => {
    const o = await get('/api/overview');
    assert.deepStrictEqual([o.active, o.pending_decisions.total, o.pending_decisions.open, o.stale_items, o.events_today, o.recent_events],
      [{ total: 0, by_stage: {}, organizations: [] }, 0, [], [], 0, []]);
  });
  assert.ok(!fs.existsSync(path.join(r.data, 'maestro.db')));
});

// ---------- health badge (GET /api/state → health) ----------

const health = async (r, env) => {
  let h = null;
  await withServer(r, async (get) => { h = (await get('/api/state')).health; }, env);
  return h;
};

suite.test('health: green when the hook recorded the agents\' work', async () => {
  const r = buildRoot('green');
  registerContoso(r);
  flow(r, r.widgets, sp('09:00:00'), 'item', 'start', '12', '--title', 'Exportar PDF');
  hook(r, r.widgets, sp('09:00:05'));
  flow(r, r.widgets, sp('11:00:00'), 'stage', '12', 'implementation');
  hook(r, r.widgets, sp('11:00:04'));
  const h = await health(r);
  assert.deepStrictEqual([h.level, h.reasons], ['green', []], JSON.stringify(h));
  assert.deepStrictEqual([h.last_event_at, h.last_raw_at], [sp('11:00:00'), sp('11:00:04')]);
});

suite.test('health: the hook is stopped when the agents recorded work after its last entry; without active items nothing is expected', async () => {
  const r = buildRoot('hook');
  registerContoso(r);
  flow(r, r.widgets, sp('08:00:00'), 'item', 'start', '12', '--title', 'Exportar PDF');
  // Never recorded anything: bruto.db does not even exist.
  assert.deepStrictEqual((await health(r)).reasons, [{ code: 'hook_never', last_event_at: sp('08:00:00') }]);
  hook(r, r.widgets, sp('08:00:03'));
  flow(r, r.widgets, sp('10:30:00'), 'stage', '12', 'implementation', '--role', 'worker');
  const h = await health(r);
  assert.strictEqual(h.level, 'yellow');
  assert.deepStrictEqual(h.reasons, [{ code: 'hook_stale', last_raw_at: sp('08:00:03'), last_event_at: sp('10:30:00'), minutes: 239 }]);
  // The owner's own records (e.g. the HML result typed in a terminal) do not expect the hook.
  const owner = buildRoot('owner');
  registerContoso(owner);
  flow(owner, owner.widgets, sp('08:00:00'), 'item', 'start', '12', '--title', 'x', '--role', 'owner');
  assert.deepStrictEqual((await health(owner)).reasons, []);
  // Every item done: no activity is expected, the old raw entry is no problem.
  flow(r, r.widgets, sp('10:40:00'), 'item', 'done', '12');
  assert.deepStrictEqual((await health(r)).reasons, []);
});

suite.test('health: projects in "Sem organização" turn it yellow until they get an organization', async () => {
  const r = buildRoot('unassigned');
  flow(r, r.scratch, sp('09:00:00'), 'item', 'start', '3', '--title', 'Rascunho', '--role', 'owner');
  flow(r, r.widgets, sp('09:05:00'), 'item', 'start', '12', '--title', 'Outro', '--role', 'owner');
  const h = await health(r);
  assert.strictEqual(h.level, 'yellow');
  assert.deepStrictEqual(h.reasons, [{ code: 'projects_unassigned', count: 2, projects: ['scratch', 'widgets'] }]);
  flow(r, r.root, sp('09:10:00'), 'org', 'add', 'acme', '--name', 'Acme');
  flow(r, r.root, sp('09:10:00'), 'project', 'edit', 'scratch', '--org', 'acme');
  flow(r, r.root, sp('09:10:00'), 'project', 'edit', 'widgets', '--org', 'acme');
  assert.deepStrictEqual((await health(r)).reasons, []);
});

suite.test('health: an unreadable maestro.db is red and an unreadable bruto.db is yellow, by code', async () => {
  const r = buildRoot('unreadable');
  fs.mkdirSync(r.data, { recursive: true });
  fs.writeFileSync(path.join(r.data, 'maestro.db'), 'isto não é um banco SQLite '.repeat(100));
  fs.writeFileSync(path.join(r.data, 'bruto.db'), 'nem isto '.repeat(100));
  await withServer(r, async (get, raw) => {
    const state = await get('/api/state');
    const h = state.health;
    assert.strictEqual(h.level, 'red');
    assert.strictEqual(state.kpis.pending_decisions.total, 0, 'the menu counter counts nothing, the badge says why');
    assert.deepStrictEqual(h.reasons.map((x) => [x.code, x.file, typeof x.detail]), [['database_unreadable', 'maestro.db', 'string'], ['database_unreadable', 'bruto.db', 'string']]);
    const o = await raw('/api/overview');
    assert.deepStrictEqual([o.status, o.json.error.code, o.json.error.file], [503, 'database_unreadable', 'maestro.db']);
  });
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
