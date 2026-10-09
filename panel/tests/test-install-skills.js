'use strict';
// Tests for the skills installer (#15) through its only seam: bin/install-skills.js runs as a process against a
// temporary Claude folder (--claude-dir), and the result is checked on that folder's files. The real ~/.claude is
// never touched: HOME, USERPROFILE and CLAUDE_CONFIG_DIR also point to the temporary root.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove } = require('./util');

const INSTALL = path.join(REPO, 'bin', 'install-skills.js');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, 'skills', 'links.json'), 'utf8'));
const suite = createSuite('skills installer: repository skills → ~/.claude (temporary)');
const roots = [];

function buildRoot(name) {
  const root = tmpDir(`install-skills-${name}`);
  roots.push(root);
  const claude = path.join(root, 'claude');
  fs.mkdirSync(claude, { recursive: true });
  return { root, claude };
}

function install(r, args = []) {
  const env = Object.assign({}, process.env, { HOME: r.root, USERPROFILE: r.root, CLAUDE_CONFIG_DIR: path.join(r.root, 'not-used') });
  return spawnSync(process.execPath, [INSTALL, '--claude-dir', r.claude, ...args], { cwd: r.root, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

const ok = (res) => assert.strictEqual(res.status, 0, `exit ${res.status}\n${res.stdout}\n${res.stderr}`);
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const same = (a, b) => fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase();

suite.test('the manifest declares /especificar and none of the old Cérebro skills', () => {
  const sources = MANIFEST.links.map((l) => l.source);
  assert.ok(sources.includes('skills/especificar'), sources.join(', '));
  assert.ok(sources.every((s) => !/^skills\/(cerebro|compartilhadas)(\/|$)/.test(s)), sources.join(', '));
});

suite.test('install links every declared skill into an empty Claude folder', () => {
  const r = buildRoot('fresh');
  ok(install(r));
  for (const l of MANIFEST.links) {
    const target = path.join(r.claude, l.target);
    assert.ok(isLink(target), `${l.target} is not a link`);
    assert.ok(same(target, path.join(REPO, l.source)), `${l.target} points elsewhere`);
  }
  assert.ok(fs.readFileSync(path.join(r.claude, 'skills', 'especificar', 'SKILL.md'), 'utf8').includes('name: especificar'));
  assert.ok(!exists(path.join(r.claude, 'skills', 'cerebro')));
  assert.ok(!exists(path.join(r.claude, 'skills', 'compartilhadas')));
});

/** Every entry of a Claude folder: { 'skills/especificar': 'link' | 'dir' | 'file' }, links not followed. */
function snapshot(dir, base = dir, acc = {}) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    const rel = path.relative(base, p).replace(/\\/g, '/');
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) acc[rel] = 'link';
    else if (st.isDirectory()) { acc[rel] = 'dir'; snapshot(p, base, acc); } else acc[rel] = `file:${fs.readFileSync(p, 'utf8')}`;
  }
  return acc;
}

suite.test('reinstalling is idempotent: same links, no backup', () => {
  const r = buildRoot('again');
  ok(install(r));
  const before = snapshot(r.claude);
  ok(install(r));
  assert.deepStrictEqual(snapshot(r.claude), before);
  assert.ok(!exists(path.join(r.claude, 'backups')));
});

suite.test('an existing skill folder is backed up, and undo puts it back', () => {
  const r = buildRoot('backup');
  const own = path.join(r.claude, 'skills', 'especificar');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'a versão antiga do dono');
  const other = path.join(r.claude, 'skills', 'outra');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'SKILL.md'), 'skill que não é do repositório');

  ok(install(r));
  assert.ok(isLink(own) && same(own, path.join(REPO, 'skills', 'especificar')));
  const backup = path.join(r.claude, 'backups', 'painel-maestro', 'skills', 'especificar', 'SKILL.md');
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'a versão antiga do dono');

  ok(install(r, ['--undo']));
  assert.ok(!isLink(own));
  assert.strictEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'a versão antiga do dono');
  assert.strictEqual(fs.readFileSync(path.join(other, 'SKILL.md'), 'utf8'), 'skill que não é do repositório');
  assert.ok(!exists(path.join(r.claude, 'backups')), 'empty backup folders are removed');
  assert.ok(fs.existsSync(path.join(REPO, 'skills', 'especificar', 'SKILL.md')), 'undo never touches the repository');
});

suite.test('undo after a fresh install removes the links and leaves the repository intact', () => {
  const r = buildRoot('undo');
  ok(install(r));
  ok(install(r, ['--undo']));
  for (const l of MANIFEST.links) {
    assert.ok(!exists(path.join(r.claude, l.target)), `${l.target} still there`);
    assert.ok(fs.readdirSync(path.join(REPO, l.source)).length > 0, `${l.source} was emptied`);
  }
  ok(install(r, ['--undo']));
});

suite.test('a taken backup slot is a conflict: exit 2 and nothing changes', () => {
  const r = buildRoot('conflict');
  const own = path.join(r.claude, 'skills', 'especificar');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'atual');
  const slot = path.join(r.claude, 'backups', 'painel-maestro', 'skills', 'especificar');
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, 'SKILL.md'), 'backup anterior');
  const before = snapshot(r.claude);

  const res = install(r);
  assert.strictEqual(res.status, 2, res.stderr);
  assert.ok(res.stderr.startsWith('erro: '), res.stderr);
  assert.deepStrictEqual(snapshot(r.claude), before);
});

suite.test('without --claude-dir the folder comes from CLAUDE_CONFIG_DIR', () => {
  const r = buildRoot('env');
  const env = Object.assign({}, process.env, { HOME: r.root, USERPROFILE: r.root, CLAUDE_CONFIG_DIR: r.claude });
  ok(spawnSync(process.execPath, [INSTALL], { cwd: r.root, env, encoding: 'utf8', windowsHide: true, timeout: 30000 }));
  assert.ok(isLink(path.join(r.claude, 'skills', 'especificar')));
  assert.ok(!exists(path.join(r.root, '.claude')));
});

suite.test('an unknown argument is invalid data: exit 2', () => {
  const r = buildRoot('args');
  const res = install(r, ['--desfazer']);
  assert.strictEqual(res.status, 2, res.stderr);
  assert.deepStrictEqual(snapshot(r.claude), {});
});

/** Removes the links before deleting the temporary roots, so no cleanup can ever reach the repository. */
function detachLinks(root) {
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of entries) {
      const p = path.join(dir, n.name);
      if (isLink(p)) {
        try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
      } else if (n.isDirectory()) walk(p);
    }
  };
  walk(root);
}

suite.run().then(() => {
  roots.forEach(detachLinks);
  if (!process.env.KEEP_TMP) roots.forEach(remove);
});
