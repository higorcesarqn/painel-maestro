'use strict';
// Tests for the page id (#37) through the agreed seam only: the server runs as a process with PANEL_INDEX pointing at a
// fake index.html and is read through GET /api/state. The build writes the id into index.html (a hash of the bundle,
// in <meta name="page-id">); the server reads it from the current file, with the cached read that also serves the page, and
// answers it as version.page, so an open tab knows the page changed on disk.
// Fake roots under tests/tmp/, servers on a port between 4790 and 4799.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, freePort, request, waitFor, kill } = require('./util');

const SERVER = path.join(REPO, 'panel', 'server.js');
const suite = createSuite('page id (version.page in GET /api/state)');
const roots = [];

const page = (id) => `<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n${id ? `<meta name="page-id" content="${id}">\n` : ''}<title>Painel de teste</title>\n</head>\n<body><p>ok</p></body>\n</html>\n`;

function buildRoot(name, html) {
  const root = tmpDir(`page-id-${name}`);
  roots.push(root);
  const index = path.join(root, 'index-test.html');
  fs.writeFileSync(index, html);
  return { root, index };
}

async function start(r) {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: path.join(r.root, 'maestro'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'),
    PANEL_INDEX: r.index, PANEL_COLLECTOR: '0', PANEL_MERGE_CHECK: '0', PANEL_PORT: '', MAESTRO_NOW: '', NODE_OPTIONS: '',
  });
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const m = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${err}`);
    return /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(out);
  }, 15000);
  return { port: Number(m[1]), pid: Number(m[2]) };
}

async function pageOf(s) {
  const st = await request(s.port, '/api/state');
  assert.strictEqual(st.status, 200);
  return st.json.version.page;
}

suite.test('version.page is the id of the current index.html, and a new file changes it without a restart', async () => {
  const r = buildRoot('swap', page('0123456789abcdef'));
  const s = await start(r);
  try {
    const v = (await request(s.port, '/api/state')).json.version;
    assert.deepStrictEqual(Object.keys(v).sort(), ['commit', 'page', 'product']);
    assert.strictEqual(v.page, '0123456789abcdef');
    // The page is still served as it is, id and all.
    assert.strictEqual((await request(s.port, '/')).text, page('0123456789abcdef'));
    // A new build replaces the file (another inode, size or mtime): the next read brings the new id.
    fs.writeFileSync(r.index, page('fedcba9876543210'));
    assert.strictEqual(await pageOf(s), 'fedcba9876543210');
    fs.writeFileSync(r.index, page('0123456789abcdef'));
    assert.strictEqual(await pageOf(s), '0123456789abcdef');
  } finally {
    kill(s.pid);
  }
});

suite.test('without an id in the file (or with a malformed one), and without the file, version.page is null', async () => {
  const r = buildRoot('none', page(null));
  const s = await start(r);
  try {
    assert.strictEqual(await pageOf(s), null);
    fs.writeFileSync(r.index, page('not a hash <script>'));
    assert.strictEqual(await pageOf(s), null);
    fs.writeFileSync(r.index, page('abcdef0123456789'));
    assert.strictEqual(await pageOf(s), 'abcdef0123456789');
    fs.rmSync(r.index);
    assert.strictEqual(await pageOf(s), null);
    assert.strictEqual((await request(s.port, '/')).status, 503, 'no page to serve');
  } finally {
    kill(s.pid);
  }
});

suite.test('restarting the server with the same page answers the same id', async () => {
  const r = buildRoot('restart', page('0011223344556677'));
  const first = await start(r);
  const before = await pageOf(first);
  kill(first.pid);
  const second = await start(r);
  try {
    assert.strictEqual(await pageOf(second), before);
  } finally {
    kill(second.pid);
  }
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
