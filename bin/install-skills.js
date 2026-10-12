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
// Its optional "retired" list (same shape) holds names this repository no longer installs (the Portuguese names
// of #61, the -maestri variants of #64): install removes such a target only when it is our link (it still leads to that
// source, here or in another checkout of this repository: another clone or worktree) and then gives the name back to
// its owner, restoring the backup it had (#60); anything else there stays as it is. --undo also removes it and
// restores its backup. A link is ours by its real path (the repository's real path; on Windows, without regard to
// case or separator), so another spelling of the same folder counts. Each link is a directory junction on
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

const { InvalidData } = lib;

// ---------- arguments ----------

function parseArgs(argv) {
  const { opts, positional } = lib.parseOptions(argv, { undo: 'flag', 'claude-dir': 'value' },
    { unknown: 'installSkills.errors.unknownArgument', missing: 'installSkills.errors.missingValue' });
  if (positional.length) throw new InvalidData('installSkills.errors.unknownArgument', { value: positional[0] });
  return { undo: !!opts.undo, claudeDir: opts['claude-dir'] };
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

/**
 * The entries to install ("links") followed by the retired ones ("retired", optional: names this repository no longer
 * installs, whose source folder is gone, #61 and #64). A retired entry has `retired: true`.
 */
function readManifest(file = MANIFEST) {
  let manifest;
  try {
    manifest = JSON.parse(lib.decodeText(fs.readFileSync(file)));
  } catch (e) {
    throw new InvalidData('installSkills.errors.manifestUnreadable', { file: lib.slashes(file), detail: e.message });
  }
  if (!manifest || !Array.isArray(manifest.links) || (manifest.retired !== undefined && !Array.isArray(manifest.retired))) {
    throw new InvalidData('installSkills.errors.manifestShape', { file: lib.slashes(file) });
  }
  const seen = new Set();
  const entry = (l, retired) => {
    const source = safeRelative(l && l.source);
    const target = safeRelative(l && l.target);
    if (!source || !target) throw new InvalidData('installSkills.errors.manifestEntry', { entry: JSON.stringify(l) });
    const key = target.toLowerCase();
    if (seen.has(key)) throw new InvalidData('installSkills.errors.manifestRepeated', { target: lib.slashes(target) });
    seen.add(key);
    const abs = path.join(REPO, source);
    if (retired) return { source: abs, relative: source, target, label: lib.slashes(target), retired: true };
    let st = null;
    try { st = fs.statSync(abs); } catch { /* checked below */ }
    if (!st || !st.isDirectory()) throw new InvalidData('installSkills.errors.sourceMissing', { source: lib.slashes(source) });
    return { source: abs, target, label: lib.slashes(target) };
  };
  return [...manifest.links.map((l) => entry(l, false)), ...(manifest.retired || []).map((l) => entry(l, true))];
}

// ---------- file system ----------

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
/** A path as the file system compares it: on Windows without regard to case (path.resolve already unified the separator). */
const comparable = (p) => (WIN ? p.toLowerCase() : p);
const samePath = (a, b) => comparable(a) === comparable(b);

/**
 * The real path of p (without the \\?\ or \??\ prefix of a junction); for a path that does not exist (a retired
 * source), the real path of its nearest existing folder followed by the rest.
 */
function realPath(p) {
  const full = path.resolve(p.replace(/^\\\\\?\\|^\\\?\?\\/, ''));
  const rest = [];
  for (let dir = full; ;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch { /* go up */ }
    const up = path.dirname(dir);
    if (up === dir) return full;
    rest.unshift(path.basename(dir));
    dir = up;
  }
}

function packageName(dir) {
  try {
    return JSON.parse(lib.decodeText(fs.readFileSync(path.join(dir, 'package.json')))).name || null;
  } catch {
    return null;
  }
}

/** Whether dir is another checkout of this repository (a clone or a worktree): the same package, with skills/links.json. */
function isCheckout(dir) {
  const ours = packageName(REPO);
  return !!ours && packageName(dir) === ours && exists(path.join(dir, 'skills', 'links.json'));
}

/**
 * 'missing', 'ours' or 'foreign' (anything else, including a link elsewhere or broken) for the entry e. A link is ours
 * when its real destination is the entry's source; a retired entry's link also when it leads to the same folder of
 * another checkout of this repository (the source is gone here, but the link is the one we made).
 */
function stateOf(target, e) {
  let st;
  try { st = fs.lstatSync(target); } catch { return 'missing'; }
  if (!st.isSymbolicLink()) return 'foreign';
  let to;
  try { to = realPath(path.resolve(path.dirname(target), fs.readlinkSync(target))); } catch { return 'foreign'; }
  if (samePath(to, realPath(e.source))) return 'ours';
  if (!e.retired) return 'foreign';
  const tail = path.sep + path.normalize(e.relative);
  if (!comparable(to).endsWith(comparable(tail))) return 'foreign';
  return isCheckout(to.slice(0, -tail.length)) ? 'ours' : 'foreign';
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
  const steps = entries.filter((e) => !e.retired).map((e) => {
    const target = path.join(claude, e.target);
    const backup = path.join(claude, BACKUP_DIR, e.target);
    const state = stateOf(target, e);
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
  // A retired name loses only our link, and goes back to its owner: the backup taken from it returns (#60). Anything
  // else there is not ours and stays (and so does its backup, for --undo).
  for (const e of entries.filter((x) => x.retired)) {
    const target = path.join(claude, e.target);
    const backup = path.join(claude, BACKUP_DIR, e.target);
    const state = stateOf(target, e);
    if (state === 'foreign') {
      lines.push(t('installSkills.done.retiredNotOurs', { target: e.label }));
      continue;
    }
    if (state === 'ours') {
      unlink(target);
      lines.push(t('installSkills.done.retiredUnlinked', { target: e.label }));
    }
    if (exists(backup)) {
      move(backup, target);
      pruneEmpty(path.dirname(backup), claude);
      lines.push(t('installSkills.done.restored', { target: e.label }));
    }
  }
  return lines;
}

function planUndo(entries, claude) {
  const conflicts = [];
  const steps = entries.map((e) => {
    const target = path.join(claude, e.target);
    const backup = path.join(claude, BACKUP_DIR, e.target);
    const state = stateOf(target, e);
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
    } else if (s.state === 'missing' && !s.retired) {
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
