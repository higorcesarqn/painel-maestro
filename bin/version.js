'use strict';
// The painel-maestro's version (#36): the semver of the root package.json (the product's only version; the database
// schema version, #28, is another thing) and the short commit the code is on. Read once, when the server or the
// flow CLI starts. Outside a clone (the code copied to a folder without git) or without git on the PATH, the commit
// is null. The convention for raising the version is in docs/agents/versao.md.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The short commit of HEAD when dir is the top of a clone; otherwise (or without git) null. */
function commitOf(dir) {
  // A non-empty prefix means dir is inside someone else's clone (the code copied into another repository).
  if (git(dir, ['rev-parse', '--show-prefix']) !== '') return null;
  const commit = git(dir, ['rev-parse', '--short', 'HEAD']);
  return commit && /^[0-9a-f]{4,}$/.test(commit) ? commit : null;
}

/** { product: '<semver of package.json>' | null, commit: '<short commit>' | null }, read from dir (default: the code's folder). */
function readVersion(dir = ROOT) {
  let product = null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    product = typeof v === 'string' && v ? v : null;
  } catch (_) { /* no package.json: no semver */ }
  return { product, commit: commitOf(dir) };
}

module.exports = { readVersion };
