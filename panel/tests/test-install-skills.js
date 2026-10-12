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

suite.test('the manifest declares /specify; every declared source exists and the repository has no other skills', () => {
  const sources = MANIFEST.links.map((l) => l.source);
  assert.ok(sources.includes('skills/specify'), sources.join(', '));
  for (const s of sources) assert.ok(fs.existsSync(path.join(REPO, s)), `${s} is declared but missing`);
  const folders = fs.readdirSync(path.join(REPO, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `skills/${d.name}`);
  assert.deepStrictEqual(folders.filter((f) => f !== 'skills/docs' && !sources.includes(f)), [], 'a skill folder outside the manifest');
});

suite.test('the manifest declares the subagent skills and the folder of the document they follow (#17)', () => {
  const byTarget = new Map(MANIFEST.links.map((l) => [l.target, l.source]));
  assert.strictEqual(byTarget.get('skills/implement-issue'), 'skills/implement-issue');
  assert.strictEqual(byTarget.get('skills/implement-pbi'), 'skills/implement-pbi');
  assert.strictEqual(byTarget.get('docs/orchestration-subagents'), 'skills/docs/orchestration-subagents');
  for (const skill of ['implement-issue', 'implement-pbi']) {
    const text = fs.readFileSync(path.join(REPO, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.ok(text.includes(`name: ${skill}`), skill);
    assert.ok(text.includes('~/.claude/docs/orchestration-subagents/README.md'), `${skill} points to the installed document`);
    // One skill per tracker, whatever the Host (#64): it also points to the Maestri flow.
    assert.ok(text.includes('~/.claude/docs/orchestration-maestri/README.md'), `${skill} points to the Maestri flow`);
    // ... and to the Orca flow (#65).
    assert.ok(text.includes('~/.claude/docs/orchestration-orca/README.md'), `${skill} points to the Orca flow`);
  }
  assert.ok(fs.existsSync(path.join(REPO, 'skills', 'docs', 'orchestration-subagents', 'README.md')));
});

suite.test('install links every declared skill into an empty Claude folder', () => {
  const r = buildRoot('fresh');
  ok(install(r));
  for (const l of MANIFEST.links) {
    const target = path.join(r.claude, l.target);
    assert.ok(isLink(target), `${l.target} is not a link`);
    assert.ok(same(target, path.join(REPO, l.source)), `${l.target} points elsewhere`);
  }
  assert.ok(fs.readFileSync(path.join(r.claude, 'skills', 'specify', 'SKILL.md'), 'utf8').includes('name: specify'));
  assert.ok(fs.existsSync(path.join(r.claude, 'docs', 'orchestration-subagents', 'README.md')), 'the document is reachable where the skills point');
});

suite.test('the worker skill and the Maestri orchestration folder are declared, the folder where the skills look for it', () => {
  const pairs = MANIFEST.links.map((l) => `${l.source} → ${l.target}`);
  assert.ok(pairs.includes('skills/maestro-worker → skills/maestro-worker'), pairs.join(', '));
  assert.ok(pairs.includes('skills/docs/orchestration-maestri → docs/orchestration-maestri'), pairs.join(', '));
  assert.ok(pairs.includes('skills/docs/orchestration-orca → docs/orchestration-orca'), pairs.join(', '));
});

// The names this repository no longer installs: target in the Claude folder → the folder of this repository it
// pointed to, which no longer exists (a link to it is left dangling once the repository is updated). The Portuguese
// names the skills had before #61, and the -maestri variants that #64 folded into the skill of each tracker.
const OLD = {
  'skills/especificar': 'skills/especificar',
  'skills/implementar-issue': 'skills/implementar-issue',
  'skills/implementar-pbi': 'skills/implementar-pbi',
  'skills/implementar-issue-maestri': 'skills/implementar-issue-maestri',
  'skills/implementar-pbi-maestri': 'skills/implementar-pbi-maestri',
  'skills/trabalhador-floor': 'skills/trabalhador-floor',
  'docs/orquestracao-subagentes': 'skills/docs/orquestracao-subagentes',
  'docs/orquestracao-maestri': 'skills/docs/orquestracao-maestri',
  'skills/implement-issue-maestri': 'skills/implement-issue-maestri',
  'skills/implement-pbi-maestri': 'skills/implement-pbi-maestri',
};

/** A link at <claude>/<target> to `to`, the way install-skills makes it (the destination may not exist). */
function plantLink(claude, target, to) {
  const at = path.join(claude, target);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');
  return at;
}

suite.test('the old folders are gone from the repository and the manifest retires their names (#61, #64)', () => {
  for (const source of Object.values(OLD)) assert.ok(!exists(path.join(REPO, source)), `${source} still in the repository`);
  const retired = Object.fromEntries((MANIFEST.retired || []).map((l) => [l.target, l.source]));
  assert.deepStrictEqual(retired, OLD);
});

suite.test('install removes the links of the old names that point to this repository, and links the new ones (#61, #64)', () => {
  const r = buildRoot('retired');
  for (const [target, source] of Object.entries(OLD)) plantLink(r.claude, target, path.join(REPO, source));
  ok(install(r));
  for (const target of Object.keys(OLD)) assert.ok(!exists(path.join(r.claude, target)), `${target} is still there`);
  for (const l of MANIFEST.links) assert.ok(same(path.join(r.claude, l.target), path.join(REPO, l.source)), `${l.target} not linked`);
  assert.ok(!exists(path.join(r.claude, 'backups')), 'an old link is removed, not backed up');
  ok(install(r));
});

suite.test('an old name that is not our link stays untouched by install and by undo (#61)', () => {
  const r = buildRoot('retired-foreign');
  const own = path.join(r.claude, 'skills', 'trabalhador-floor');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'skill do dono com o nome antigo');
  const elsewhere = path.join(r.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'outra pasta');
  const foreignLink = plantLink(r.claude, 'skills/especificar', elsewhere);

  const res = install(r);
  ok(res);
  assert.ok(res.stdout.includes('skills/trabalhador-floor: nome antigo, mas não é um link deste repositório; ficou como está.'), res.stdout);
  assert.strictEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'skill do dono com o nome antigo');
  assert.ok(isLink(foreignLink) && same(foreignLink, elsewhere), 'a link elsewhere is not ours');
  assert.ok(!exists(path.join(r.claude, 'backups')), 'an old name is never backed up');

  ok(install(r, ['--undo']));
  assert.strictEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'skill do dono com o nome antigo');
  assert.ok(isLink(foreignLink) && same(foreignLink, elsewhere));
  for (const l of MANIFEST.links) assert.ok(!exists(path.join(r.claude, l.target)), `${l.target} still there`);
});

suite.test('install gives an old name back to the owner: our link goes and the backup it hid returns (#60)', () => {
  const r = buildRoot('retired-restore');
  // Installed before #61 over the owner's own skill: our old link in place, the owner's folder in the backup.
  const backup = path.join(r.claude, 'backups', 'painel-maestro', 'skills', 'implementar-issue-maestri');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'SKILL.md'), 'a versão antiga do dono');
  plantLink(r.claude, 'skills/implementar-issue-maestri', path.join(REPO, 'skills', 'implementar-issue-maestri'));
  // An installer before #60 already removed our link and left the backup hidden: it comes back too.
  const hidden = path.join(r.claude, 'backups', 'painel-maestro', 'docs', 'orquestracao-maestri');
  fs.mkdirSync(hidden, { recursive: true });
  fs.writeFileSync(path.join(hidden, 'README.md'), 'doc do dono');

  const res = install(r);
  ok(res);
  const own = path.join(r.claude, 'skills', 'implementar-issue-maestri');
  assert.ok(!isLink(own));
  assert.strictEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'a versão antiga do dono');
  assert.strictEqual(fs.readFileSync(path.join(r.claude, 'docs', 'orquestracao-maestri', 'README.md'), 'utf8'), 'doc do dono');
  assert.ok(res.stdout.includes('skills/implementar-issue-maestri: nome antigo; link removido.'), res.stdout);
  assert.ok(res.stdout.includes('skills/implementar-issue-maestri: backup restaurado.'), res.stdout);
  assert.ok(!exists(path.join(r.claude, 'backups')), 'empty backup folders are removed');

  // The owner's folder is not ours: undo leaves it.
  ok(install(r, ['--undo']));
  assert.strictEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'a versão antiga do dono');
});

suite.test('undo restores the backup an old name had and removes an old link install never reached (#61)', () => {
  const r = buildRoot('retired-undo');
  ok(install(r));
  const backup = path.join(r.claude, 'backups', 'painel-maestro', 'skills', 'implementar-issue-maestri');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'SKILL.md'), 'a versão antiga do dono');
  plantLink(r.claude, 'skills/implementar-issue-maestri', path.join(REPO, 'skills', 'implementar-issue-maestri'));
  plantLink(r.claude, 'docs/orquestracao-maestri', path.join(REPO, 'skills', 'docs', 'orquestracao-maestri'));

  ok(install(r, ['--undo']));
  const own = path.join(r.claude, 'skills', 'implementar-issue-maestri');
  assert.ok(!isLink(own));
  assert.strictEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'a versão antiga do dono');
  assert.ok(!exists(path.join(r.claude, 'docs', 'orquestracao-maestri')), 'an old link of ours is removed by undo too');
  assert.ok(!exists(path.join(r.claude, 'backups')), 'empty backup folders are removed');
});

suite.test('an old link is ours by its real path: another spelling, an alias of the repository or another checkout of it (#60)', () => {
  const r = buildRoot('retired-spelling');
  // An alias of the repository (a junction or symlink to it), and another checkout: a folder with this package.json.
  const alias = path.join(r.root, 'alias');
  fs.symlinkSync(REPO, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const clone = path.join(r.root, 'clone');
  fs.mkdirSync(path.join(clone, 'skills'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(clone, 'package.json'));
  fs.copyFileSync(path.join(REPO, 'skills', 'links.json'), path.join(clone, 'skills', 'links.json'));
  // A really different repository with the same folder names is not ours.
  const other = path.join(r.root, 'other');
  fs.mkdirSync(path.join(other, 'skills', 'implementar-pbi'), { recursive: true });
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'outro-projeto' }));
  fs.copyFileSync(path.join(REPO, 'skills', 'links.json'), path.join(other, 'skills', 'links.json'));

  const ours = [
    plantLink(r.claude, 'skills/especificar', path.join(alias, 'skills', 'especificar')),
    plantLink(r.claude, 'skills/implementar-issue', path.join(clone, 'skills', 'implementar-issue')),
    plantLink(r.claude, 'docs/orquestracao-subagentes', path.join(clone, 'skills', 'docs', 'orquestracao-subagentes')),
  ];
  if (process.platform === 'win32') {
    ours.push(plantLink(r.claude, 'skills/trabalhador-floor', path.join(REPO.toUpperCase(), 'skills', 'trabalhador-floor')));
    ours.push(plantLink(r.claude, 'docs/orquestracao-maestri', `${REPO.replace(/\\/g, '/')}/skills/docs/orquestracao-maestri`));
  }
  const foreign = plantLink(r.claude, 'skills/implementar-pbi', path.join(other, 'skills', 'implementar-pbi'));

  ok(install(r));
  for (const at of ours) assert.ok(!exists(at), `${at} is still there`);
  assert.ok(isLink(foreign) && same(foreign, path.join(other, 'skills', 'implementar-pbi')), 'a link to another repository is not ours');
});

suite.test('after install, every ~/.claude path the installed skills and documents cite exists', () => {
  const r = buildRoot('refs');
  ok(install(r));
  const cited = new Set();
  const scan = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) scan(p);
      else if (/\.(md|sh)$/.test(n.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/~\/\.claude\/([^\s`"'<>)]+)/g)) {
          if (!m[1].includes('*')) cited.add(m[1].replace(/[.,:;]+$/, '')); // globs are looked up by the agent
        }
      }
    }
  };
  for (const l of MANIFEST.links) scan(path.join(REPO, l.source));
  assert.ok(cited.has('docs/orchestration-maestri/README.md'), [...cited].join(', '));
  assert.ok(cited.has('docs/orchestration-maestri/scripts/integrate.sh'), [...cited].join(', '));
  assert.ok(cited.has('docs/orchestration-orca/README.md'), [...cited].join(', '));
  assert.ok(cited.has('docs/orchestration-orca/scripts/integrate.sh'), [...cited].join(', '));
  for (const rel of cited) assert.ok(exists(path.join(r.claude, rel)), `~/.claude/${rel} is cited but not installed`);
  assert.ok(!exists(path.join(r.claude, 'docs', 'orchestration-maestri', 'scripts', 'fluxo.py')), 'fluxo.py is gone');
});

/** Every entry of a Claude folder: { 'skills/specify': 'link' | 'dir' | 'file' }, links not followed. */
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
  const own = path.join(r.claude, 'skills', 'specify');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'a versão antiga do dono');
  const other = path.join(r.claude, 'skills', 'outra');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'SKILL.md'), 'skill que não é do repositório');

  ok(install(r));
  assert.ok(isLink(own) && same(own, path.join(REPO, 'skills', 'specify')));
  const backup = path.join(r.claude, 'backups', 'painel-maestro', 'skills', 'specify', 'SKILL.md');
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), 'a versão antiga do dono');

  ok(install(r, ['--undo']));
  assert.ok(!isLink(own));
  assert.strictEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'a versão antiga do dono');
  assert.strictEqual(fs.readFileSync(path.join(other, 'SKILL.md'), 'utf8'), 'skill que não é do repositório');
  assert.ok(!exists(path.join(r.claude, 'backups')), 'empty backup folders are removed');
  assert.ok(fs.existsSync(path.join(REPO, 'skills', 'specify', 'SKILL.md')), 'undo never touches the repository');
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
  const own = path.join(r.claude, 'skills', 'specify');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'atual');
  const slot = path.join(r.claude, 'backups', 'painel-maestro', 'skills', 'specify');
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
  assert.ok(isLink(path.join(r.claude, 'skills', 'specify')));
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
