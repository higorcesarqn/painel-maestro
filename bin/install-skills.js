#!/usr/bin/env node
'use strict';
// install-skills · links the owner's skills of this repository into the Claude folder (~/.claude), so they are
// versioned here and used from there (#15).
//
//   node bin/install-skills.js [--claude-dir <dir>]           links every entry of skills/links.json
//   node bin/install-skills.js --undo [--claude-dir <dir>]    removes those links and restores the backups
//
// skills/links.json declares what is installed: {"links": [{"source": "skills/x", "target": "skills/x"}]}, the
// source relative to the repository and the target relative to the Claude folder. Only those entries are touched.
// Each link is a directory junction on
// Windows (no admin needed) and a directory symlink elsewhere. Whatever already exists at a target and is not
// our link is moved to <claude>/backups/painel-maestro/<target> first; --undo puts it back.
// The Claude folder is --claude-dir, then CLAUDE_CONFIG_DIR, then ~/.claude. Every change is planned before
// anything is done: a conflict stops the command with nothing changed.
// Exit codes: 0 ok · 2 invalid data or conflict (clear message on stderr) · 1 anything else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { t } = require('./i18n');

const REPO = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO, 'skills', 'links.json');
const BACKUP_DIR = path.join('backups', 'painel-maestro');
const WIN = process.platform === 'win32';

class InvalidData extends Error {
  constructor(key, params = {}) {
    super(t(key, params));
    this.key = key;
  }
}

// ---------- arguments ----------

function parseArgs(argv) {
  const opts = { undo: false, claudeDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--undo') opts.undo = true;
    else if (a === '--claude-dir' || a.startsWith('--claude-dir=')) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('--')) throw new InvalidData('installSkills.errors.missingValue', { option: 'claude-dir' });
      opts.claudeDir = value;
    } else throw new InvalidData('installSkills.errors.unknownArgument', { value: a });
  }
  return opts;
}

function claudeDir(opts, env = process.env) {
  return path.resolve(opts.claudeDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

// ---------- manifest ----------

/** A relative path that stays inside its base folder. */
function safeRelative(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const norm = path.normalize(value.trim());
  if (path.isAbsolute(norm) || norm === '.' || norm.split(/[\\/]/).includes('..')) return null;
  return norm;
}

function readManifest(file = MANIFEST) {
  let manifest;
  try {
    manifest = JSON.parse(lib.decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new InvalidData('installSkills.errors.manifestUnreadable', { file: lib.slashes(file), detail: e.message });
  }
  if (!manifest || !Array.isArray(manifest.links)) throw new InvalidData('installSkills.errors.manifestShape', { file: lib.slashes(file) });
  const seen = new Set();
  return manifest.links.map((l) => {
    const source = safeRelative(l && l.source);
    const target = safeRelative(l && l.target);
    if (!source || !target) throw new InvalidData('installSkills.errors.manifestEntry', { entry: JSON.stringify(l) });
    const key = target.toLowerCase();
    if (seen.has(key)) throw new InvalidData('installSkills.errors.manifestRepeated', { target: lib.slashes(target) });
    seen.add(key);
    const abs = path.join(REPO, source);
    let st = null;
    try { st = fs.statSync(abs); } catch { /* checked below */ }
    if (!st || !st.isDirectory()) throw new InvalidData('installSkills.errors.sourceMissing', { source: lib.slashes(source) });
    return { source: abs, target, label: lib.slashes(target) };
  });
}

// ---------- file system ----------

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const samePath = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

/** 'missing', 'ours' (a link to the source) or 'foreign' (anything else, including a link elsewhere or broken). */
function stateOf(target, source) {
  let st;
  try { st = fs.lstatSync(target); } catch { return 'missing'; }
  if (!st.isSymbolicLink()) return 'foreign';
  try {
    return samePath(fs.realpathSync(target), fs.realpathSync(source)) ? 'ours' : 'foreign';
  } catch {
    return 'foreign';
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename with a few retries (Windows: an antivirus or a watcher may hold the folder for a moment). */
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(100 * (i + 1));
    }
  }
}

function link(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, WIN ? 'junction' : 'dir');
}

/** Removes only the link itself, never what it points to. */
function unlink(target) {
  try {
    fs.unlinkSync(target);
  } catch (e) {
    if (!['EPERM', 'EISDIR'].includes(e.code)) throw e;
    fs.rmdirSync(target); // a junction: rmdir without recursion removes the junction, not its contents
  }
}

/** Removes the empty folders of the backup tree, from `dir` up to (not including) the Claude folder. */
function pruneEmpty(dir, stop) {
  for (let d = dir; ; d = path.dirname(d)) {
    const rel = path.relative(stop, d);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
  }
}

// ---------- commands ----------

function planInstall(entries, claude) {
  const conflicts = [];
  const steps = entries.map((e) => {
    const target = path.join(claude, e.target);
    const backup = path.join(claude, BACKUP_DIR, e.target);
    const state = stateOf(target, e.source);
    if (state === 'foreign' && exists(backup)) conflicts.push(t('installSkills.errors.backupTaken', { target: e.label, backup: lib.slashes(backup) }));
    return { ...e, abs: target, backup, state };
  });
  if (conflicts.length) throw new InvalidData('installSkills.errors.conflicts', { list: conflicts });
  return steps;
}

function install(entries, claude) {
  const lines = [];
  for (const s of planInstall(entries, claude)) {
    if (s.state === 'ours') {
      lines.push(t('installSkills.done.alreadyLinked', { target: s.label }));
      continue;
    }
    if (s.state === 'foreign') {
      move(s.abs, s.backup);
      lines.push(t('installSkills.done.backedUp', { target: s.label, backup: lib.slashes(s.backup) }));
    }
    link(s.source, s.abs);
    lines.push(t('installSkills.done.linked', { target: s.label, source: lib.slashes(s.source) }));
  }
  return lines;
}

function planUndo(entries, claude) {
  const conflicts = [];
  const steps = entries.map((e) => {
    const target = path.join(claude, e.target);
    const backup = path.join(claude, BACKUP_DIR, e.target);
    const state = stateOf(target, e.source);
    const hasBackup = exists(backup);
    if (state === 'foreign' && hasBackup) conflicts.push(t('installSkills.errors.targetReplaced', { target: e.label, backup: lib.slashes(backup) }));
    return { ...e, abs: target, backup, state, hasBackup };
  });
  if (conflicts.length) throw new InvalidData('installSkills.errors.conflicts', { list: conflicts });
  return steps;
}

function undo(entries, claude) {
  const lines = [];
  for (const s of planUndo(entries, claude)) {
    if (s.state === 'ours') {
      unlink(s.abs);
      lines.push(t('installSkills.done.unlinked', { target: s.label }));
    } else if (s.state === 'foreign') {
      lines.push(t('installSkills.done.notOurs', { target: s.label }));
    }
    if (s.hasBackup) {
      move(s.backup, s.abs);
      pruneEmpty(path.dirname(s.backup), claude);
      lines.push(t('installSkills.done.restored', { target: s.label }));
    } else if (s.state === 'missing') {
      lines.push(t('installSkills.done.nothingToUndo', { target: s.label }));
    }
  }
  return lines;
}

function run(argv, env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    lib.print(t('installSkills.help', { manifest: lib.slashes(MANIFEST) }));
    return;
  }
  const opts = parseArgs(argv);
  const claude = claudeDir(opts, env);
  const entries = readManifest();
  lib.print(t('installSkills.done.claudeDir', { dir: lib.slashes(claude) }));
  for (const l of (opts.undo ? undo : install)(entries, claude)) lib.print(l);
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (e) {
    const invalid = e instanceof InvalidData;
    process.stderr.write(`${t('errors.prefix', { message: invalid ? e.message : t('errors.unexpected', { detail: e && e.message ? e.message : String(e) }) })}\n`);
    process.exitCode = invalid ? 2 : 1;
  }
}

module.exports = { run };
