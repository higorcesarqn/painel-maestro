'use strict';
/**
 * lib.js · shared functions of the bin/ commands (Node 18+, standard library only, CommonJS).
 *
 * Sections: paths · dates (America/Sao_Paulo) · lock and state JSON · JSONL · standard input ·
 * secret redaction and truncation · agents and identification · semantic log events ·
 * sessions and flows · correlation with the raw log · arguments and exit codes.
 *
 * Environment variables:
 *   MAESTRO_DIR            data root (default: the folder above bin/). Tests point it to a temporary folder.
 *   MAESTRO_LOCK           exlock|wx forces the lock strategy (every process must use the same one).
 *   MAESTRO_LOCK_WAIT_MS   longest wait for the lock in the commands (default 10000).
 *   MAESTRO_NOW            fixed date/time in ISO 8601. Tests only.
 *
 * Data layout under MAESTRO_DIR:
 *   logs/raw/<agent>/YYYY-MM-DD.jsonl   old raw log (the hook writes bruto.db since #12; see bin/raw-store.js)
 *   state/sessions/<session_id>.json    Claude Code session state (hook), read by the usage collector until #13
 *   state/usage.json, state/usage-cache.json, state/panel.pid
 *   Old model, kept as is until #18 removes it (written by bin/registrar.js and bin/pendencia.js):
 *   registro/agentes.json, logs/eventos/YYYY-MM.jsonl, estado/pendencias.json, estado/contador-fluxos.json
 *
 * Writing rules (validated with 8 concurrent processes on Windows/NTFS):
 *   - JSONL logs: appendJsonl = ONE fs.appendFileSync call per line, without a lock (atomic on NTFS).
 *     Never write a line in two calls: in the test that corrupted 969 of 2400 lines.
 *   - State JSON: updateJson = lock + read + atomic write (temporary + rename with retries on
 *     EPERM/EBUSY). Never overwrites a corrupt JSON.
 *   - The hook never waits for a lock longer than ~300 ms (passes timeoutMs) and gives up silently.
 *   - Dates always with isoSP() (São Paulo offset). Never toISOString() in the data.
 * Messages for people (validation problems, CLI errors) stay in Portuguese (ADR 0004).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Loaded only when needed: the hook runs on every tool call and every millisecond counts.
let cryptoModule = null;
let zlibModule = null;
const crypto = () => cryptoModule || (cryptoModule = require('crypto'));
const zlib = () => zlibModule || (zlibModule = require('zlib'));

/** Random hexadecimal suffix for temporary names and ids (no cryptographic strength needed). */
function randomHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
}

// =============================================================================================
// Paths
// =============================================================================================

/** Data root: the MAESTRO_DIR variable or the folder above bin/. */
function maestroDir() {
  return path.resolve(process.env.MAESTRO_DIR || path.join(__dirname, '..'));
}

/** Workspace root inferred without reading any file: the folder that contains the data root. */
function defaultRoot() {
  return path.dirname(maestroDir());
}

/** Data paths, recomputed on every call (they honor MAESTRO_DIR). */
function paths() {
  const base = maestroDir();
  const logs = path.join(base, 'logs');
  const state = path.join(base, 'state');
  const legacyState = path.join(base, 'estado');
  return {
    base,
    logs,
    state,
    raw: path.join(logs, 'raw'),
    sessions: path.join(state, 'sessions'),
    sessionsLock: path.join(state, 'sessions.lock'), // a single lock for every session file
    // Old model (bin/registrar.js and bin/pendencia.js), removed in #18.
    legacyState,
    agents: path.join(base, 'registro', 'agentes.json'),
    events: path.join(logs, 'eventos'),
    preRegistry: path.join(logs, 'pre-registro.md'),
    flowCounter: path.join(legacyState, 'contador-fluxos.json'),
    pendingDecisions: path.join(legacyState, 'pendencias.json'),
  };
}

/** Path with forward slashes (to show and to store). */
function slashes(p) {
  return String(p).replace(/\\/g, '/');
}

/** Removes accents (NFD without combining marks), keeping upper and lower case. */
function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Safe folder name for a slug ("desconhecido:x" becomes "desconhecido-x"). */
function folderForSlug(slug) {
  const s = stripAccents(String(slug || '')).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  return s || 'desconhecido';
}

/** Semantic log file of the date's month: logs/eventos/YYYY-MM.jsonl (old model). */
function eventsFile(date = now()) {
  return path.join(paths().events, `${spStamps(date).yyyymm}.jsonl`);
}

/** Raw log file of the agent on the date's day: logs/raw/<slug>/YYYY-MM-DD.jsonl. */
function rawFile(slug, date = now()) {
  return path.join(paths().raw, folderForSlug(slug), `${spStamps(date).yyyymmdd}.jsonl`);
}

/** Sanitizes a session_id to become a file name (only letters, digits, _ and -). */
function safeSessionId(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}

/** Session state file: state/sessions/<session_id>.json. */
function sessionFile(sessionId) {
  const id = safeSessionId(sessionId);
  if (!id) throw new Error('session_id vazio ou inválido');
  return path.join(paths().sessions, `${id}.json`);
}

/** Normalizes a path for comparison: absolute, forward slashes, lower case, no trailing slash (accepts Git Bash /c/...). */
function normalizePath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p.trim().replace(/\\/g, '/');
  const m = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (m) s = `${m[1]}:/${s.slice(3)}`;
  s = path.resolve(s).replace(/\\/g, '/');
  return s.replace(/\/+$/, '').toLowerCase();
}

/** true if "child" is "parent" itself or lies inside it (after normalizing). */
function isInside(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

// =============================================================================================
// Dates in the America/Sao_Paulo time zone (Intl/ICU: if daylight saving returns, the offset follows)
// =============================================================================================

const TIME_ZONE = 'America/Sao_Paulo';
// Created on first use: loading the ICU time zone data costs ~20-40 ms per process.
let spFormatter = null;
let longFormatter = null;
const formatterSP = () => spFormatter || (spFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23', // midnight comes out as "00", never "24"
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  timeZoneName: 'longOffset', // "GMT-03:00" ("GMT" when the offset is zero)
}));
const formatterLong = () => longFormatter || (longFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
}));
const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Current date/time (or MAESTRO_NOW, tests only). */
function now() {
  const fixed = process.env.MAESTRO_NOW;
  if (fixed) {
    const d = new Date(fixed);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Date parts in São Paulo: {year, month, day, hour, minute, second, offset:'-03:00'}. */
function spParts(date = now()) {
  const p = {};
  for (const { type, value } of formatterSP().formatToParts(date)) p[type] = value;
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.slice(3);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, offset };
}

/** ISO 8601 with the São Paulo offset, without milliseconds: 2026-10-08T15:41:02-03:00. */
function isoSP(date = now()) {
  const p = spParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

/** Interface format: 08/10/2026 15:41. */
function dateTimeBR(date = now()) {
  const p = spParts(date);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Date only: 08/10/2026. */
function dateBR(date = now()) {
  const p = spParts(date);
  return `${p.day}/${p.month}/${p.year}`;
}

/** Time only, with seconds: 15:41:02. */
function timeBR(date = now()) {
  const p = spParts(date);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** Stamps for files and ids: {yyyymm:'2026-10', yyyymmdd:'2026-10-08', compact:'20261008', hhmmss:'154102'}. */
function spStamps(date = now()) {
  const p = spParts(date);
  return {
    yyyymm: `${p.year}-${p.month}`,
    yyyymmdd: `${p.year}-${p.month}-${p.day}`,
    compact: `${p.year}${p.month}${p.day}`,
    hhmmss: `${p.hour}${p.minute}${p.second}`,
  };
}

/** Turns ISO 8601 text with a zone (or a Date) into a Date; returns null if invalid. */
function parseDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !RE_ISO.test(v.trim())) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Long day in Portuguese: "quinta-feira, 08/10/2026". */
function longDay(date = now()) {
  return formatterLong().format(date);
}

/** Readable age of a date (Portuguese, for the CLI): "agora", "há 5 min", "há 3 h", "há 2 d". */
function readableAge(date, reference = now()) {
  const d = parseDate(date);
  if (!d) return '?';
  const s = Math.round((reference.getTime() - d.getTime()) / 1000);
  if (s < 0) return 'no futuro';
  if (s < 60) return 'agora';
  const min = Math.floor(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

// =============================================================================================
// Inter-process lock and safe writing (800/800 in the 8x100 counter test)
//  - Windows ('exlock', default): opens "<target>.lock" with exclusive sharing (libuv flag
//    UV_FS_O_EXLOCK = 0x10000000). Another process gets EBUSY. If the owner dies, Windows closes the
//    handle and the lock disappears by itself. The .lock stays on disk, empty, and is reused.
//  - Other systems ('wx'): creates "<target>.lock" with O_CREAT|O_EXCL and deletes it on release;
//    detects stale locks (dead PID, age) but never breaks a lock younger than minAgeMs.
//  - Waiting: in the first 50 ms, busy wait of ~0.1 ms (the shortest real sleep on Windows is 11-16 ms).
//  - No lock until timeoutMs: Error with code 'ELOCK_TIMEOUT'.
// =============================================================================================

const HOST = os.hostname();
const UV_FS_O_EXLOCK = 0x10000000; // libuv (uv/win.h); Node does not export the constant
const EXLOCK_FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | UV_FS_O_EXLOCK;
const BUSY_CODES = new Set(['EEXIST', 'EBUSY', 'EPERM', 'EACCES']);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const openLocks = new Set();

const LOCK_DEFAULTS = {
  strategy: process.env.MAESTRO_LOCK || (process.platform === 'win32' ? 'exlock' : 'wx'),
  timeoutMs: Number(process.env.MAESTRO_LOCK_WAIT_MS) > 0 ? Number(process.env.MAESTRO_LOCK_WAIT_MS) : 10000, // longest wait for the lock
  fastPhaseMs: 50, // initial time with short busy waits
  minAgeMs: 2000, // 'wx': never breaks a lock younger than this
  staleAgeMs: 30000, // 'wx': a lock older than this is abandoned
  emptyAgeMs: 5000, // 'wx': an empty .lock older than this is abandoned
  staleCheckMs: 100, // 'wx': interval between reads of the .lock
};

/** Sleeps without burning CPU (on Windows, in practice, at least ~11-16 ms). */
function sleep(ms) {
  Atomics.wait(waitCell, 0, 0, Math.max(1, Math.round(ms)));
}

/** Very short busy wait (burns CPU, but answers in tenths of a millisecond). */
function busyWait(ms) {
  const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  while (process.hrtime.bigint() < end) { /* spin */ }
}

/** Waits a little before trying again: busy at first, sleeping afterwards. */
function waitTurn(start, fastPhaseMs) {
  if (Date.now() - start < fastPhaseMs) busyWait(0.05 + Math.random() * 0.15);
  else sleep(1 + Math.random() * 4);
}

/** true if the PID exists on this computer (EPERM = exists, but belongs to another user). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readWxLock(lockFile) {
  let st;
  try { st = fs.statSync(lockFile, { bigint: true }); } catch (e) {
    return e.code === 'ENOENT' ? null : { ino: null };
  }
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* empty or being deleted */ }
  return { ino: st.ino, mtimeMs: Number(st.mtimeMs), owner };
}

function wxLockIsStale(info, op) {
  if (!info || info.ino === null) return false;
  const o = info.owner;
  const hasOwner = o && typeof o.since === 'number';
  const age = Date.now() - (hasOwner ? o.since : info.mtimeMs);
  if (age < op.minAgeMs) return false;
  if (hasOwner) return (o.host === HOST && !pidAlive(o.pid)) || age > op.staleAgeMs;
  return age > op.emptyAgeMs;
}

function breakWxLock(lockFile, staleInfo) {
  // Checks again right before: if the .lock is already another file, the stale lock was replaced.
  try { if (fs.statSync(lockFile, { bigint: true }).ino !== staleInfo.ino) return false; } catch { return false; }
  const temporary = `${lockFile}.stale-${process.pid}-${randomHex(4)}`;
  try { fs.renameSync(lockFile, temporary); } catch { return false; } // someone else already broke it
  let ino = null;
  try { ino = fs.statSync(temporary, { bigint: true }).ino; } catch { /* ignore */ }
  if (ino !== null && ino !== staleInfo.ino) {
    // Took another process's NEW lock by mistake: gives it back (link fails if the name exists).
    try { fs.linkSync(temporary, lockFile); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(temporary); } catch { /* ignore */ }
  return true;
}

// 'exlock' self-test (once per process): requires EBUSY on the second open; otherwise uses 'wx'.
let exlockChecked = null;
/** true = exclusive; false = NOT exclusive (opened twice); null = inconclusive (e.g. folder missing). */
function exlockIsExclusive(folder, flags = EXLOCK_FLAGS) {
  const test = path.join(folder, `.exlock-selftest-${process.pid}-${randomHex(3)}`);
  let fd1;
  let fd2;
  try { fd1 = fs.openSync(test, flags); } catch { return null; }
  try {
    try { fd2 = fs.openSync(test, flags); return false; } catch (e) { return e.code === 'EBUSY' ? true : null; }
  } finally {
    for (const fd of [fd2, fd1]) if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(test); } catch { /* ignore */ }
  }
}

function effectiveStrategy(op, lockFile) {
  if (op.strategy !== 'exlock') return op.strategy;
  if (exlockChecked === null) {
    const r = exlockIsExclusive(path.dirname(lockFile));
    if (r === null) return 'exlock'; // inconclusive: goes on; the real open shows the real error
    exlockChecked = r;
    if (!r) process.stderr.write(`[trava] AVISO: UV_FS_O_EXLOCK não é exclusiva no Node ${process.version}; usando 'wx'.\n`);
  }
  return exlockChecked ? 'exlock' : 'wx';
}

/** Acquires the lock of "target" (file "<target>.lock" or options.lockFile); returns the lock object. */
function acquireLock(target, options = {}) {
  const op = { ...LOCK_DEFAULTS, ...options };
  const lockFile = op.lockFile || `${target}.lock`;
  op.strategy = effectiveStrategy(op, lockFile);
  const start = Date.now();
  let attempts = 0;
  let lastCheck = -Infinity; // the first failure already checks whether the lock is stale
  for (;;) {
    attempts++;
    try {
      if (op.strategy === 'exlock') {
        const fd = fs.openSync(lockFile, EXLOCK_FLAGS); // EBUSY if another process holds it
        const lock = { strategy: 'exlock', lockFile, fd, attempts };
        openLocks.add(lock);
        return lock;
      }
      const fd = fs.openSync(lockFile, 'wx'); // EEXIST if it already exists
      const token = randomHex(8);
      let ino;
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: HOST, since: Date.now(), token }));
        ino = fs.fstatSync(fd, { bigint: true }).ino;
      } finally {
        fs.closeSync(fd);
      }
      const lock = { strategy: 'wx', lockFile, ino, token, attempts };
      openLocks.add(lock);
      return lock;
    } catch (e) {
      if (!BUSY_CODES.has(e.code)) throw e; // ENOENT (folder missing) etc.: a real error
      if (op.strategy === 'wx' && Date.now() - lastCheck >= op.staleCheckMs) {
        lastCheck = Date.now();
        const info = readWxLock(lockFile);
        if (info && wxLockIsStale(info, op) && breakWxLock(lockFile, info)) continue;
      }
      if (Date.now() - start >= op.timeoutMs) {
        const error = new Error(`Tempo esgotado (${op.timeoutMs} ms) esperando a trava ${slashes(lockFile)}`);
        error.code = 'ELOCK_TIMEOUT';
        throw error;
      }
      waitTurn(start, op.fastPhaseMs);
    }
  }
}

/** Releases the lock (with 'wx', only deletes the .lock if it is still the file we created). */
function releaseLock(lock) {
  if (!lock || !openLocks.has(lock)) return false;
  openLocks.delete(lock);
  try {
    if (lock.strategy === 'exlock') { fs.closeSync(lock.fd); return true; }
    if (fs.statSync(lock.lockFile, { bigint: true }).ino !== lock.ino) return false; // it was broken
    fs.unlinkSync(lock.lockFile);
    return true;
  } catch {
    return false;
  }
}

/** Runs fn() holding the lock of "target" and always releases it; returns what fn returns. */
function withLock(target, fn, options) {
  const lock = acquireLock(target, options);
  try { return fn(lock); } finally { releaseLock(lock); }
}

process.on('exit', () => { for (const l of [...openLocks]) releaseLock(l); });

/**
 * Writes text atomically (temporary in the same folder + rename, retrying on EPERM/EBUSY).
 * sync (default true): fsync of the temporary before the rename, so a power loss does not leave the
 * new file empty or full of zeros. backup: copies the current file to <file>.bak before replacing it.
 */
function writeAtomic(file, content, { timeoutMs = 3000, sync = true, backup = false } = {}) {
  const temporary = `${file}.tmp-${process.pid}-${randomHex(4)}`;
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeSync(fd, content);
    if (sync) fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
    throw e;
  }
  fs.closeSync(fd);
  if (backup) { try { fs.copyFileSync(file, `${file}.bak`); } catch { /* first use: nothing to copy */ } }
  const start = Date.now();
  for (;;) {
    try { fs.renameSync(temporary, file); return; } catch (e) {
      if (!BUSY_CODES.has(e.code) || Date.now() - start >= timeoutMs) {
        try { fs.unlinkSync(temporary); } catch { /* ignore */ }
        throw e;
      }
      waitTurn(start, 50);
    }
  }
}

/** Writes a value as indented JSON, atomically (creates the folder if missing). */
function writeJsonAtomic(file, value, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Reads a JSON (accepts BOM); returns a copy of "fallback" if missing; retries on EPERM/EBUSY; invalid JSON throws code 'EJSON'. */
function readJson(file, fallback = null, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  for (;;) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      if (e.code === 'ENOENT') return structuredClone(fallback);
      if (!BUSY_CODES.has(e.code) || Date.now() - start >= timeoutMs) throw e;
      waitTurn(start, 50);
      continue;
    }
    try {
      return JSON.parse(decodeText(buf));
    } catch (e) {
      const bak = `${file}.bak`;
      const hint = fs.existsSync(bak)
        ? ` Para recuperar: confira ${slashes(bak)} (a cópia da gravação anterior) e copie-o por cima de ${path.basename(file)}, ou conserte o JSON à mão.`
        : ' Para recuperar: conserte o JSON à mão (ou restaure de um backup).';
      const error = new Error(`${slashes(file)} não é um JSON válido (${e.message}); nada foi alterado.${hint} Não apague o arquivo: contadores e ids recomeçariam do zero.`);
      error.code = 'EJSON';
      throw error;
    }
  }
}

/** Deletes orphan temporaries (<name>.tmp-<pid>-xxxx) older than "ageMs" in the folder (leftovers of a dead process). */
function cleanOrphanTemps(folder, { ageMs = 10 * 60e3 } = {}) {
  let names;
  try { names = fs.readdirSync(folder); } catch { return 0; }
  let n = 0;
  const limit = Date.now() - ageMs;
  for (const name of names) {
    if (!/\.tmp-\d+-[0-9a-f]+$/.test(name)) continue;
    const p = path.join(folder, name);
    try {
      if (fs.statSync(p).mtimeMs < limit) { fs.unlinkSync(p); n++; }
    } catch { /* another process already deleted or is using it */ }
  }
  return n;
}

/**
 * Read-modify-write of a JSON under a lock. Accepts (file, change, options) or (file, initial, change, options).
 * "change" receives the current object (or a copy of options.initial if the file does not exist) and
 * returns the new one; if it returns undefined, nothing is written. options: timeoutMs (lock, read and
 * write), lockFile, sync (fsync, default true), backup (<file>.bak, default false), cleanTemps (default
 * true), restartIfCorrupt (default false: invalid JSON becomes an EJSON error; true: renames it to
 * <file>.corrupt-YYYYMMDD-HHMMSS and restarts from "initial"; only for derived state, such as sessions).
 */
function updateJson(file, a, b, c) {
  let initial = null;
  let change;
  let options;
  if (typeof a === 'function') {
    change = a;
    options = { ...(b || {}) };
    if (options.initial !== undefined) initial = options.initial;
  } else {
    initial = a;
    change = b;
    options = { ...(c || {}) };
  }
  const { sync = true, backup = false, cleanTemps = true, restartIfCorrupt = false } = options;
  for (const k of ['initial', 'sync', 'backup', 'cleanTemps', 'restartIfCorrupt']) delete options[k];
  const limit = options.timeoutMs !== undefined ? options.timeoutMs : LOCK_DEFAULTS.timeoutMs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (options.lockFile) fs.mkdirSync(path.dirname(options.lockFile), { recursive: true });
  return withLock(file, () => {
    if (cleanTemps) cleanOrphanTemps(path.dirname(file));
    let current;
    try {
      current = readJson(file, initial, { timeoutMs: Math.min(2000, limit) });
    } catch (e) {
      if (!(restartIfCorrupt && e.code === 'EJSON')) throw e;
      const s = spStamps();
      try { fs.renameSync(file, `${file}.corrupt-${s.compact}-${s.hhmmss}`); } catch { /* goes on anyway */ }
      current = structuredClone(initial);
    }
    const next = change(current);
    if (next === undefined) return current;
    writeJsonAtomic(file, next, { timeoutMs: Math.min(3000, limit), sync, backup });
    return next;
  }, options);
}

// =============================================================================================
// JSONL
// =============================================================================================

/** Appends a value as one JSONL line (a single write call, no lock; creates the folder). */
function appendJsonl(file, value) {
  const line = `${JSON.stringify(value)}\n`; // JSON.stringify never produces a raw line break
  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(path.dirname(file), { recursive: true }); // first line of the day/month
    fs.appendFileSync(file, line, 'utf8');
  }
}

/** Reads a .jsonl (or .jsonl.gz) and returns the objects; invalid lines (e.g. a half last one) are ignored. */
function readJsonl(file) {
  let buf;
  const start = Date.now();
  for (;;) {
    try { buf = fs.readFileSync(file); break; } catch (e) {
      if (e.code === 'ENOENT') return [];
      if (!BUSY_CODES.has(e.code) || Date.now() - start >= 2000) throw e;
      waitTurn(start, 50);
    }
  }
  if (file.endsWith('.gz')) buf = zlib().gunzipSync(buf);
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o);
    } catch { /* half or corrupt line: ignored */ }
  }
  return out;
}

/** Lists the .jsonl and .jsonl.gz files of a folder, by name; a missing folder returns []. */
function listJsonl(folder) {
  try {
    return fs.readdirSync(folder).filter((n) => /\.jsonl(\.gz)?$/.test(n)).sort().map((n) => path.join(folder, n));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** Sorts objects by the ts field (ISO date), keeping the original order on ties. */
function sortByTs(list) {
  return list
    .map((o, i) => [o, Date.parse(o && o.ts), i])
    .sort((x, y) => ((Number.isNaN(x[1]) ? 0 : x[1]) - (Number.isNaN(y[1]) ? 0 : y[1])) || (x[2] - y[2]))
    .map((x) => x[0]);
}

// =============================================================================================
// Standard input and text decoding
// =============================================================================================

/** Decodes text bytes: UTF-8 (with or without BOM) or UTF-16 with BOM (PowerShell 5 files). */
function decodeText(buf) {
  if (typeof buf === 'string') return buf.replace(/^\uFEFF/, '');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const c = Buffer.from(buf.subarray(2, 2 + Math.floor((buf.length - 2) / 2) * 2));
    c.swap16();
    return c.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/** true if the standard input is an interactive terminal (no pipe nor redirection). */
function stdinIsInteractive() {
  try { return require('tty').isatty(0); } catch { return false; }
}

/** Reads the whole standard input synchronously and returns a Buffer (empty if there is nothing). */
function readStdinSync() {
  const parts = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') { sleep(5); continue; }
      if (e.code === 'EOF') break; // Windows: pipe closed
      throw e;
    }
    if (n === 0) break;
    parts.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(parts);
}

// =============================================================================================
// Secret redaction and truncation
// =============================================================================================

const REDACTED_MARK = '«redigido»';
const SECRET_WORDS = String.raw`(?:password|passwd|passphrase|senha|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|token|secret|segredo)`;
// Quotes may come escaped (\" or \\\") when the text is JSON inside JSON or a command with echo "{\"...\"}".
const SECRET_KEY = String.raw`(\b[\w.-]*?` + SECRET_WORDS + String.raw`\b(?:\\*["'])?\s*[:=]\s*)`;
const AUTH_KEY = String.raw`(\bauthorization\b(?:\\*["'])?\s*[:=]\s*)`;
const ESCAPED_VALUE = String.raw`(\\+)"[^"\r\n]*?\\+"`; // \"value\" (escaped quotes)
const RE_AUTH_ESCAPED = new RegExp(AUTH_KEY + ESCAPED_VALUE, 'gi');
const RE_AUTH_DOUBLE = new RegExp(AUTH_KEY + String.raw`"(?:\\.|[^"\\\r\n])*"`, 'gi');
const RE_AUTH_SINGLE = new RegExp(AUTH_KEY + String.raw`'(?:\\.|[^'\\\r\n])*'`, 'gi');
const RE_AUTH_BARE = new RegExp(AUTH_KEY + String.raw`(?!\\*["'«])[^\r\n"'\\]+`, 'gi');
const RE_BEARER = /\b(Bearer)\s+(?!«)[A-Za-z0-9._~+/=-]+/gi;
const RE_KV_ESCAPED = new RegExp(SECRET_KEY + ESCAPED_VALUE, 'gi');
const RE_KV_DOUBLE = new RegExp(SECRET_KEY + String.raw`"(?:\\.|[^"\\\r\n])*"`, 'gi');
const RE_KV_SINGLE = new RegExp(SECRET_KEY + String.raw`'(?:\\.|[^'\\\r\n])*'`, 'gi');
const RE_KV_BARE = new RegExp(SECRET_KEY + String.raw`(?!\\*["'«])[^\s"'&,;)}\]\\]+`, 'gi');
const RE_SECRET_FLAG = new RegExp(String.raw`(--?[\w-]*?` + SECRET_WORDS + String.raw`)(\s+)("[^"\r\n]*"|'[^'\r\n]*'|(?![-<>|«])\S+)`, 'gi');
// Credential embedded in a URL: scheme://user:password@host.
const RE_URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'\\]+:)[^\s@/"'\\]+@/gi;
// Password glued to the short flag of the MySQL/MariaDB client: mysql -u root -pS3cret (capital -P is the port).
const RE_MYSQL_P = /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\r\n|;&]*?\s-p)(?=[^\s-])\S+/g;
const RE_LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const RE_LONG_BASE64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
// "Readable" piece of a path, slug or identifier: short, a word (lower case, Capitalized, CamelCase,
// ACRONYM), a number or hex. A random base64 piece with 9+ characters almost never matches this.
const RE_READABLE_PIECE = /^(?:[A-Za-z0-9]{0,8}|\d+|[0-9a-f]+|[0-9A-F]+|(?:[A-Z]+|[A-Z]?[a-z]+)(?:[A-Z][a-z]+)*[A-Z]*\d*)$/;
const RE_SECRET_VAR_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|SENHA|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const RE_NON_SECRET_VAR_NAME = /(_PATH|_FILE|_DIR|_URL|_SOCKET|_HOST|_PORT)$/i;

/** Values of environment variables with a secret-like name (includes CLAUDE_CODE_MESSAGING_TOKEN), longest first. */
function envSecrets(env = process.env) {
  const values = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value !== 'string' || value.length < 8) continue;
    if (name === 'CLAUDE_CODE_MESSAGING_TOKEN' || (RE_SECRET_VAR_NAME.test(name) && !RE_NON_SECRET_VAR_NAME.test(name))) values.push(value);
  }
  return values.sort((x, y) => y.length - x.length);
}

/**
 * Heuristic for a base64/base64url run of 40+ characters, judged WHOLE: it is a secret if it mixes at
 * least 2 classes (lower, upper, digit) and some piece between - _ / + is not readable (path, slug,
 * CamelCase, uuid). With '+' and the 3 classes, it is always a secret (paths almost never have '+').
 */
function looksSecret(run) {
  const s = run.replace(/=+$/, '');
  const classes = Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) + Number(/\d/.test(s));
  if (classes < 2) return false;
  if (classes === 3 && s.includes('+')) return true;
  return s.split(/[-_/+]/).some((p) => !RE_READABLE_PIECE.test(p));
}

/** Replaces secrets with «redigido»: Authorization, Bearer, key=value (token, password, senha, api key...; also with escaped quotes), secret --flag, user:password@ in a URL, mysql -pSECRET, hex >= 32, base64 >= 40 and environment values. */
function redact(text, { env = process.env } = {}) {
  if (text === undefined || text === null) return text;
  let s = String(text);
  for (const v of envSecrets(env)) if (s.includes(v)) s = s.split(v).join(REDACTED_MARK);
  return s
    .replace(RE_URL_CREDENTIAL, `$1${REDACTED_MARK}@`)
    .replace(RE_MYSQL_P, `$1${REDACTED_MARK}`)
    .replace(RE_AUTH_ESCAPED, `$1$2"${REDACTED_MARK}$2"`)
    .replace(RE_AUTH_DOUBLE, `$1"${REDACTED_MARK}"`)
    .replace(RE_AUTH_SINGLE, `$1'${REDACTED_MARK}'`)
    .replace(RE_AUTH_BARE, `$1${REDACTED_MARK}`)
    .replace(RE_BEARER, `$1 ${REDACTED_MARK}`)
    .replace(RE_KV_ESCAPED, `$1$2"${REDACTED_MARK}$2"`)
    .replace(RE_KV_DOUBLE, `$1"${REDACTED_MARK}"`)
    .replace(RE_KV_SINGLE, `$1'${REDACTED_MARK}'`)
    .replace(RE_KV_BARE, `$1${REDACTED_MARK}`)
    .replace(RE_SECRET_FLAG, `$1$2${REDACTED_MARK}`)
    .replace(RE_LONG_HEX, REDACTED_MARK)
    .replace(RE_LONG_BASE64, (m) => (looksSecret(m) ? REDACTED_MARK : m));
}

// Object key whose value is a secret (access_token, apiKey, password, Authorization...), but not max_tokens.
const RE_SECRET_OBJECT_KEY = new RegExp(String.raw`^[\w.-]*?(?:` + SECRET_WORDS.slice(3, -1) + String.raw`|authorization|cookie|credentials?)$`, 'i');

/**
 * Redacts any JSON value BEFORE serializing: replaces with «redigido» the value of secret keys and
 * applies redact() to every text (so JSON embedded in a text shows up raw, with normal quotes).
 * To save time, cuts each text at "maxText" and stops descending after "budget" characters.
 */
function redactValue(value, { env = process.env, maxText = 1600, budget = 4000, depth = 8 } = {}) {
  const count = { left: budget };
  const walk = (v, level) => {
    if (count.left <= 0) return '…';
    if (typeof v === 'string') {
      const cut = v.length > maxText ? v.slice(0, maxText) : v;
      count.left -= cut.length;
      return redact(cut, { env });
    }
    if (v === null || typeof v !== 'object') { count.left -= 8; return v; }
    if (level >= depth) return '…';
    if (Array.isArray(v)) {
      const r = [];
      for (const x of v) {
        if (count.left <= 0) { r.push('…'); break; }
        r.push(walk(x, level + 1));
      }
      return r;
    }
    const r = {};
    for (const [k, x] of Object.entries(v)) {
      if (count.left <= 0) { r['…'] = '…'; break; }
      count.left -= k.length;
      r[k] = (RE_SECRET_OBJECT_KEY.test(k) && (typeof x === 'string' || typeof x === 'number') && x !== '') ? REDACTED_MARK : walk(x, level + 1);
    }
    return r;
  };
  return walk(value, 0);
}

/** Cuts the text to at most "max" characters, ending in "…[+N]" when cut (without splitting an emoji). */
function truncate(text, max, { total } = {}) {
  if (text === undefined || text === null) return text;
  const s = String(text);
  const size = total !== undefined ? total : s.length;
  if (!(max > 0) || (s.length <= max && size <= s.length)) return s;
  let cut = Math.min(s.length, max - `…[+${size}]`.length);
  if (cut <= 0) return s.slice(0, max);
  const cc = s.charCodeAt(cut - 1);
  if (cc >= 0xd800 && cc <= 0xdbff) cut--; // does not leave half a surrogate pair (emoji)
  return `${s.slice(0, cut)}…[+${size - cut}]`;
}

/** Redacts and truncates (redacts before cutting, so half a secret never slips through); huge texts are pre-cut. */
function summarize(text, max, options) {
  if (text === undefined || text === null) return text;
  const s = String(text);
  const preLimit = max * 4 + 400;
  const preCut = s.length > preLimit;
  const r = redact(preCut ? s.slice(0, preLimit) : s, options);
  if (!preCut) return truncate(r, max);
  return truncate(r, max, { total: r.length + (s.length - preLimit) });
}

// =============================================================================================
// Agents and identification (old model registry registro/agentes.json, removed in #18)
// =============================================================================================

/** Reads registro/agentes.json ({workspace, padrao, agentes}); throws if missing or invalid. */
function loadAgents({ timeoutMs = 2000 } = {}) {
  const c = readJson(paths().agents, null, { timeoutMs });
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    const e = new Error(`registro/agentes.json não encontrado em ${slashes(maestroDir())}`);
    e.code = 'ENOENT';
    throw e;
  }
  if (!Array.isArray(c.agentes)) c.agentes = [];
  return c;
}

/** Like loadAgents, but returns null instead of throwing. */
function loadAgentsSafe(options) {
  try { return loadAgents(options); } catch { return null; }
}

/** Name of the last folder of a path (for "desconhecido:<folder>"). */
function folderName(p) {
  const n = normalizePath(p) ? path.basename(String(p).replace(/[\\/]+$/, '')) : '';
  return (n && n.replace(/\s+/g, ' ').trim()) || 'sem-pasta';
}

/** Agent whose directory contains the path (the most specific directory wins), or null. */
function agentByDirectory(agents, target) {
  let best = null;
  let size = -1;
  for (const a of agents) {
    if (!a || typeof a.slug !== 'string' || !Array.isArray(a.diretorios)) continue;
    for (const d of a.diretorios) {
      if (typeof d !== 'string' || !d.trim() || !isInside(target, d)) continue;
      const n = normalizePath(d).length;
      if (n > size) { best = a; size = n; }
    }
  }
  return best;
}

/**
 * Identifies the agent. Returns {ours, reason, agent, terminal, workspace, known}.
 * ours=false: MAESTRI_WORKSPACE_ID of another workspace, or no MAESTRI_WORKSPACE_ID and outside the root.
 * agent: terminal_id === MAESTRI_TERMINAL_ID; otherwise by directory (cwd, then CLAUDE_PROJECT_DIR);
 * otherwise "desconhecido:" + the first 8 of the terminal (or the cwd folder name).
 */
function identifyAgent({ env = process.env, cwd = process.cwd(), registry } = {}) {
  if (registry === undefined) registry = loadAgentsSafe();
  const workspace = env.MAESTRI_WORKSPACE_ID || null;
  const terminal = env.MAESTRI_TERMINAL_ID || null;
  const candidates = [cwd, env.CLAUDE_PROJECT_DIR].filter((x) => typeof x === 'string' && x.trim());
  const ws = registry && registry.workspace ? registry.workspace : {};
  const root = (typeof ws.raiz === 'string' && ws.raiz.trim()) ? ws.raiz : defaultRoot();
  const inRoot = candidates.some((d) => isInside(d, root));
  let ours = true;
  let reason = null;
  if (workspace) {
    if (ws.id) {
      if (workspace !== ws.id) { ours = false; reason = 'other-workspace'; }
    } else if (!inRoot) { ours = false; reason = 'workspace-not-confirmed'; }
  } else if (!inRoot) { ours = false; reason = 'outside-root'; }
  const list = registry && Array.isArray(registry.agentes) ? registry.agentes : [];
  let found = terminal ? list.find((a) => a && a.terminal_id && a.terminal_id === terminal) : null;
  for (const c of candidates) { if (!found) found = agentByDirectory(list, c); }
  const agent = found ? found.slug : `desconhecido:${terminal ? terminal.slice(0, 8) : folderName(cwd)}`;
  return { ours, reason, agent, terminal, workspace, known: !!found };
}

// =============================================================================================
// Semantic log events (old model: the stored field names stay as written by bin/registrar.js)
// =============================================================================================

const FIXED_ORIGINS = ['dono-direto', 'cerebro', 'rotina', 'sistema'];
const EVENT_TYPES = ['pedido-recebido', 'delegacao', 'resposta-recebida', 'aviso', 'consulta', 'execucao', 'auditoria',
  'relatorio', 'decisao', 'pendencia-aberta', 'pendencia-resolvida', 'bloqueio', 'erro', 'manutencao', 'bootstrap'];
const RESULTS = ['ok', 'parcial', 'falhou', 'bloqueado', 'aguardando-dono', 'em-andamento'];
const TYPES_REQUIRING_DIRECTION = ['decisao', 'execucao', 'delegacao', 'auditoria'];
const REQUIRED_EVENT_FIELDS = ['agente', 'fluxo_id', 'origem', 'tipo', 'resumo', 'resultado'];
const EVENT_FIELDS = ['id', 'ts', 'agente', 'fluxo_id', 'origem', 'tipo', 'projeto', 'resumo', 'direcao', 'passos',
  'comandos', 'alteracoes', 'resultado', 'validacao', 'proximo_passo', 'precisa_dono', 'pendencias', 'duracao_s', 'sessao',
  'teste', 'tipo_original', 'importado_de'];
const FREE_TEXT_FIELDS = ['resumo', 'direcao', 'validacao', 'proximo_passo'];
const FREE_LIST_FIELDS = ['passos', 'comandos', 'alteracoes'];
const MAX_SUMMARY = 100;
const RE_FLOW = /^F-\d{8}-\d{4}$/;
const RE_FLOW_IN_TEXT = /(?<![\w-])F-\d{8}-\d{4}(?!\d)/g;
const RE_PENDING_DECISION = /^P-\d{4,}$/;
const RE_EVENT_ID = /^EV-\d{8}-\d{6}-[0-9a-f]{4}$/;
const RE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const RE_UNKNOWN_AGENT = /^desconhecido:\S.*$/;

/** Normalizes a closed-list value: no accents, lower case, trimmed ("Execução" becomes "execucao"). */
function normalizeEnum(v) {
  return typeof v === 'string' ? stripAccents(v).trim().toLowerCase() : v;
}

/** true for text with some visible character. */
function isFilled(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** Problems of an agent slug (format and, with a registry, presence in agentes.json). */
function agentProblems(slug, registry, label = 'agente') {
  if (RE_UNKNOWN_AGENT.test(slug)) return [];
  if (!RE_SLUG.test(slug)) return [`${label} "${slug}" inválido: use o slug do agente (minúsculas, números e hífen), ex.: cerebro`];
  const list = registry && Array.isArray(registry.agentes) ? registry.agentes.filter((a) => a && a.slug) : [];
  if (list.length && !list.some((a) => a.slug === slug)) {
    return [`${label} "${slug}" não está em registro/agentes.json (conhecidos: ${list.map((a) => a.slug).join(', ')})`];
  }
  return [];
}

/** Problems of the origin: dono-direto, cerebro, rotina, sistema or agente:<slug>. */
function originProblems(origin, registry) {
  if (FIXED_ORIGINS.includes(origin)) return [];
  const m = /^agente:(.+)$/.exec(origin);
  if (m) return agentProblems(m[1], registry, 'origem: agente');
  return [`origem "${origin}" não é permitida (use: ${FIXED_ORIGINS.join(', ')} ou agente:<slug>)`];
}

/** Validates an event; returns the list of problems in Portuguese (empty = valid). */
function validateEvent(ev, { registry } = {}) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return ['o evento precisa ser um objeto JSON'];
  const p = [];
  for (const k of Object.keys(ev)) {
    if (!EVENT_FIELDS.includes(k)) p.push(`campo desconhecido "${k}" (aceitos: ${EVENT_FIELDS.join(', ')})`);
  }
  for (const k of REQUIRED_EVENT_FIELDS) if (!isFilled(ev[k])) p.push(`falta o campo obrigatório "${k}"`);
  if (isFilled(ev.agente)) p.push(...agentProblems(ev.agente, registry));
  if (isFilled(ev.fluxo_id) && !RE_FLOW.test(ev.fluxo_id)) p.push(`fluxo_id "${ev.fluxo_id}" inválido: use o formato F-AAAAMMDD-NNNN`);
  if (isFilled(ev.origem)) p.push(...originProblems(ev.origem, registry));
  if (isFilled(ev.tipo) && !EVENT_TYPES.includes(ev.tipo)) p.push(`tipo "${ev.tipo}" não é permitido (use: ${EVENT_TYPES.join(', ')})`);
  if (isFilled(ev.resultado) && !RESULTS.includes(ev.resultado)) p.push(`resultado "${ev.resultado}" não é permitido (use: ${RESULTS.join(', ')})`);
  if (typeof ev.resumo === 'string') {
    const n = [...ev.resumo].length;
    if (n > MAX_SUMMARY) p.push(`"resumo" tem ${n} caracteres; o máximo é ${MAX_SUMMARY}`);
    if (/[\r\n]/.test(ev.resumo)) p.push('"resumo" deve ter uma linha só');
  }
  if (TYPES_REQUIRING_DIRECTION.includes(ev.tipo) && !isFilled(ev.direcao)) {
    p.push(`"direcao" é obrigatória quando o tipo é ${ev.tipo} (diga o caminho escolhido e o porquê)`);
  }
  for (const k of ['agente', 'fluxo_id', 'origem', 'tipo', 'resumo', 'resultado', 'projeto', 'direcao', 'validacao',
    'proximo_passo', 'sessao', 'tipo_original', 'importado_de']) {
    if (ev[k] !== undefined && typeof ev[k] !== 'string') p.push(`"${k}" deve ser texto`);
  }
  for (const k of [...FREE_LIST_FIELDS, 'pendencias']) {
    if (ev[k] !== undefined && (!Array.isArray(ev[k]) || ev[k].some((x) => typeof x !== 'string'))) p.push(`"${k}" deve ser uma lista de textos`);
  }
  if (Array.isArray(ev.pendencias)) {
    for (const x of ev.pendencias) if (typeof x === 'string' && !RE_PENDING_DECISION.test(x)) p.push(`pendência "${x}" inválida: use o formato P-NNNN`);
  }
  if (ev.precisa_dono !== undefined && typeof ev.precisa_dono !== 'boolean') p.push('"precisa_dono" deve ser true ou false');
  if (ev.teste !== undefined && typeof ev.teste !== 'boolean') p.push('"teste" deve ser true ou false');
  if (ev.duracao_s !== undefined && !(typeof ev.duracao_s === 'number' && Number.isFinite(ev.duracao_s) && ev.duracao_s >= 0)) {
    p.push('"duracao_s" deve ser um número de segundos maior ou igual a zero');
  }
  if (ev.ts !== undefined && !parseDate(ev.ts)) p.push(`ts "${ev.ts}" inválido: use ISO 8601 com fuso, ex.: 2026-10-08T15:42:10-03:00`);
  if (ev.id !== undefined && !(typeof ev.id === 'string' && RE_EVENT_ID.test(ev.id))) p.push(`id "${ev.id}" inválido: use EV-AAAAMMDD-HHMMSS-xxxx`);
  return p;
}

/** Builds the id EV-YYYYMMDD-HHMMSS-xxxx (xxxx from a hash of pid, fine clock and chance; with "seed", derived only from it, for idempotent imports). */
function newEventId(date = now(), seed) {
  const s = spStamps(date);
  const base = seed === undefined
    ? `${process.pid}|${process.hrtime.bigint()}|${Math.random()}|${randomHex(8)}`
    : String(seed);
  const suffix = crypto().createHash('sha1').update(base).digest('hex').slice(0, 4);
  return `EV-${s.compact}-${s.hhmmss}-${suffix}`;
}

/** true if the id already shows up at the end (last ~64 KB) of the events file (suffix collision in the same second). */
function idAlreadyUsed(file, id) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8').includes(`"id":"${id}"`);
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Puts the event fields in schema order and drops the empty ones (undefined). */
function orderFields(ev) {
  const r = {};
  for (const k of EVENT_FIELDS) if (ev[k] !== undefined) r[k] = ev[k];
  for (const k of Object.keys(ev)) if (!(k in r) && ev[k] !== undefined) r[k] = ev[k];
  return r;
}

/**
 * Prepares an event: normalizes enums, fills ts/sessao/precisa_dono, redacts free texts and validates.
 * options: now, env (for sessao and redaction), registry (agentes.json), seed (deterministic id).
 * Returns {event, problems}; event is null when there are problems.
 */
function buildEvent(data, { now: when, env = process.env, registry, seed } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { event: null, problems: ['o evento precisa ser um objeto JSON'] };
  if (registry === undefined) registry = loadAgentsSafe();
  const ev = { ...data };
  const problems = [];
  if (ev.id !== undefined) { problems.push('o campo "id" é gerado pelo registrar; tire-o do evento'); delete ev.id; }
  for (const k of ['origem', 'tipo', 'resultado', 'tipo_original']) if (typeof ev[k] === 'string') ev[k] = normalizeEnum(ev[k]);
  for (const k of ['agente', 'fluxo_id', 'projeto']) if (typeof ev[k] === 'string') ev[k] = ev[k].trim();
  if (typeof ev.fluxo_id === 'string') ev.fluxo_id = ev.fluxo_id.toUpperCase();
  let date;
  if (ev.ts !== undefined) {
    date = parseDate(ev.ts);
    if (date) ev.ts = isoSP(date);
  } else {
    date = when || now();
    ev.ts = isoSP(date);
  }
  if (ev.sessao === undefined && env && env.CLAUDE_CODE_SESSION_ID) ev.sessao = String(env.CLAUDE_CODE_SESSION_ID);
  if (ev.precisa_dono === undefined) ev.precisa_dono = false;
  // Redaction: never store a secret, not even by accident.
  const red = (v) => (typeof v === 'string' ? redact(v, { env }) : v);
  for (const k of FREE_TEXT_FIELDS) ev[k] = red(ev[k]);
  for (const k of FREE_LIST_FIELDS) if (Array.isArray(ev[k])) ev[k] = ev[k].map(red);
  problems.push(...validateEvent(ev, { registry }));
  if (problems.length) return { event: null, problems };
  const event = orderFields({ ...ev, id: newEventId(date, seed) });
  return { event, problems: [] };
}

/**
 * Writes an already validated event to logs/eventos/YYYY-MM.jsonl (month of ts in São Paulo). If the id
 * already exists at the end of the file (16-bit suffix collision in the same second), changes the suffix.
 */
function writeEvent(event) {
  const date = parseDate(event.ts) || now();
  const file = eventsFile(date);
  for (let i = 1; i <= 20 && event.id && idAlreadyUsed(file, event.id); i++) {
    event.id = newEventId(date, `${event.id}|${i}|${process.pid}|${Math.random()}`);
  }
  appendJsonl(file, event);
  return file;
}

/** Creates a validation error (code 'EVALIDATION') with the list of problems. */
function validationError(problems, title = 'Evento inválido') {
  const e = new Error(`${title} (${problems.length} ${problems.length === 1 ? 'problema' : 'problemas'}):`);
  e.code = 'EVALIDATION';
  e.problems = problems;
  return e;
}

/** Builds, validates and writes an event; returns the written event or throws 'EVALIDATION'. */
function recordEvent(data, options) {
  const { event, problems } = buildEvent(data, options);
  if (problems.length) throw validationError(problems);
  writeEvent(event);
  return event;
}

/** Reads the events of every month (or only of the months between "since" and "until"), ordered by ts. */
function readEvents({ since, until } = {}) {
  const firstMonth = since ? spStamps(since).yyyymm : null;
  const lastMonth = until ? spStamps(until).yyyymm : null;
  const all = [];
  for (const file of listJsonl(paths().events)) {
    const month = path.basename(file).slice(0, 7);
    if (firstMonth && month < firstMonth) continue;
    if (lastMonth && month > lastMonth) continue;
    all.push(...readJsonl(file));
  }
  return sortByTs(all);
}

// =============================================================================================
// Sessions and flows
// =============================================================================================

/** Session state (state/sessions/<id>.json) or null; never throws. */
function currentSession(sessionId, { timeoutMs = 500 } = {}) {
  if (!safeSessionId(sessionId)) return null;
  try {
    const s = readJson(sessionFile(sessionId), null, { timeoutMs });
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

/** Current flow_id of the session, or null. */
function flowOfSession(sessionId, options) {
  const s = currentSession(sessionId, options);
  return s && typeof s.flow_id === 'string' && RE_FLOW.test(s.flow_id) ? s.flow_id : null;
}

/**
 * Read-modify-write of the session file with the shared lock state/sessions.lock. The session is derived
 * state: if the file is corrupt, it is set aside (.corrupt-...) and starts over.
 */
function updateSession(sessionId, change, options = {}) {
  return updateJson(sessionFile(sessionId), change, {
    initial: null, lockFile: paths().sessionsLock, restartIfCorrupt: true, ...options,
  });
}

/**
 * Diagnosis of the session's flow, for clear error messages:
 * {state: 'no-id'|'no-file'|'unreadable'|'no-flow'|'ok', flow, file}.
 */
function diagnoseSession(sessionId) {
  if (!safeSessionId(sessionId)) return { state: 'no-id', flow: null, file: null };
  const file = sessionFile(sessionId);
  let s;
  const MISSING = '«file-missing»';
  try { s = readJson(file, MISSING, { timeoutMs: 500 }); } catch { return { state: 'unreadable', flow: null, file }; }
  if (s === MISSING) return { state: 'no-file', flow: null, file };
  const flow = s && typeof s.flow_id === 'string' && RE_FLOW.test(s.flow_id) ? s.flow_id : null;
  return { state: flow ? 'ok' : 'no-flow', flow, file };
}

/** "Missing flow" message (Portuguese, CLI) according to the session diagnosis (CLAUDE_CODE_SESSION_ID). */
function missingFlowMessage(sessionId) {
  const d = diagnoseSession(sessionId);
  const base = 'falta o fluxo: passe --fluxo F-AAAAMMDD-NNNN';
  if (d.state === 'no-id') return `${base} (não há CLAUDE_CODE_SESSION_ID: este comando não está rodando numa sessão do Claude Code)`;
  if (d.state === 'no-file') return `${base} (o hook não registrou esta sessão em state/sessions/; confira se os hooks do Claude Code chamam bin/hook-log.js)`;
  if (d.state === 'unreadable') return `${base} (o arquivo da sessão ${slashes(d.file)} está ilegível; o hook o recria no próximo prompt)`;
  return `${base} (a sessão atual não tem fluxo: o prompt não trazia um id F-... e ninguém rodou "registrar novo-fluxo" nela)`;
}

/** Last F-YYYYMMDD-NNNN id that shows up in a text, or null. */
function lastFlowInText(text) {
  if (typeof text !== 'string') return null;
  const found = text.match(RE_FLOW_IN_TEXT);
  return found ? found[found.length - 1] : null;
}

// =============================================================================================
// Correlation with the raw log
// =============================================================================================

/** Reads the raw log entries of every agent, from a YYYY-MM-DD day (optional), ordered by ts. */
function readRaw({ sinceDay } = {}) {
  const base = paths().raw;
  let folders = [];
  try {
    folders = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const all = [];
  for (const f of folders) {
    for (const file of listJsonl(path.join(base, f))) {
      if (sinceDay && path.basename(file).slice(0, 10) < sinceDay) continue;
      all.push(...readJsonl(file));
    }
  }
  return sortByTs(all);
}

/**
 * Raw commands of a flow: those with the flow_id and, without flow_id, those of the same session and the
 * same agent in the window between the previous event of that agent/session and each event of the flow.
 * Events are old-model records (agente, sessao); raw entries are the hook's (agent, session, flow_id).
 * Each entry comes back with "correlation": "flow_id" or "window".
 */
function rawForFlow(flowId, { events = [], allEvents = [], start = null } = {}) {
  const d = flowId.slice(2, 10);
  const midday = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00-03:00`);
  const sinceDay = Number.isNaN(midday.getTime()) ? undefined : spStamps(new Date(midday.getTime() - 86400e3)).yyyymmdd;
  const raw = readRaw({ sinceDay });
  const t = (x) => Date.parse(x && x.ts);
  const flowStart = start ? Date.parse(start) : NaN;
  const windows = [];
  for (const ev of events) {
    if (!ev.sessao) continue;
    const end = t(ev);
    if (Number.isNaN(end)) continue;
    let from = -Infinity;
    for (const o of allEvents) {
      if (o === ev || o.agente !== ev.agente || o.sessao !== ev.sessao) continue;
      const to = t(o);
      if (to < end && to > from) from = to;
    }
    if (from === -Infinity) from = (!Number.isNaN(flowStart) && flowStart < end) ? flowStart : end - 15 * 60e3;
    windows.push({ agent: ev.agente, session: ev.sessao, from, end });
  }
  const out = [];
  for (const r of raw) {
    if (r.flow_id === flowId) out.push({ ...r, correlation: 'flow_id' });
    else if (!r.flow_id && windows.some((w) => w.session === r.session && w.agent === r.agent && t(r) > w.from && t(r) <= w.end)) {
      out.push({ ...r, correlation: 'window' });
    }
  }
  return out;
}

// =============================================================================================
// Command line arguments, errors and exit codes
// =============================================================================================

/** Creates a usage error (wrong argument or value), code 'EARGS' (exits with 2). */
function argsError(message) {
  const e = new Error(message);
  e.code = 'EARGS';
  return e;
}

/**
 * Reads "--name value", "--name=value", repeatable lists and boolean switches.
 * spec = {text:[...], list:[...], bool:[...]}; returns {opts, pos}. A usage error throws 'EARGS'.
 */
function parseArgs(argv, spec = {}, { maxPositional = 0 } = {}) {
  const kinds = new Map();
  for (const n of spec.text || []) kinds.set(n, 'text');
  for (const n of spec.list || []) kinds.set(n, 'list');
  for (const n of spec.bool || []) kinds.set(n, 'bool');
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!(a.startsWith('--') && a.length > 2)) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let value = eq >= 0 ? a.slice(eq + 1) : undefined;
    const kind = kinds.get(name);
    if (!kind) throw argsError(`opção desconhecida: --${name} (veja --help)`);
    if (kind === 'bool') {
      if (value === undefined) opts[name] = true;
      else {
        const v = normalizeEnum(value);
        if (['1', 'true', 'sim', 's', 'yes'].includes(v)) opts[name] = true;
        else if (['0', 'false', 'nao', 'n', 'no'].includes(v)) opts[name] = false;
        else throw argsError(`--${name} não aceita o valor "${value}" (use sim ou nao)`);
      }
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) throw argsError(`falta o valor de --${name}`);
      value = next;
      i++;
    }
    if (kind === 'list') (opts[name] = opts[name] || []).push(value);
    else {
      if (opts[name] !== undefined) throw argsError(`--${name} foi informado mais de uma vez`);
      opts[name] = value;
    }
  }
  if (pos.length > maxPositional) throw argsError(`argumento inesperado: ${pos[maxPositional]} (veja --help)`);
  warnMsysConversion(opts);
  return { opts, pos };
}

const RE_MSYS_PREFIX = /^[A-Za-z]:[\\/]Program Files[\\/]Git[\\/]/i;

/**
 * Git Bash safety net: MSYS turns every argument that starts with "/" into a Windows path
 * ("/compact" becomes "C:/Program Files/Git/compact") before it reaches node. Warns on stderr when seen.
 */
function warnMsysConversion(opts, env = process.env) {
  if (!env.MSYSTEM || env.MSYS_NO_PATHCONV === '1' || env.MSYS2_ARG_CONV_EXCL === '*') return [];
  const suspects = [];
  for (const [name, v] of Object.entries(opts)) {
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && RE_MSYS_PREFIX.test(x)) suspects.push(`--${name} "${x}"`);
  }
  if (suspects.length) {
    warn(`aviso: o Git Bash pode ter trocado um texto que começava com "/" por um caminho do Windows: ${suspects.join(', ')}. `
      + "Confira; para evitar, use o atalho bin/registrar (ou bin/pendencia), rode com MSYS2_ARG_CONV_EXCL='*' na frente, ou mande o JSON por --json -.");
  }
  return suspects;
}

/** Parses JSON text that must be an object; usage error ('EARGS') if it is not. */
function parseJsonObject(text, origin) {
  const t = decodeText(text).trim();
  if (!t) throw argsError(`JSON vazio em ${origin}`);
  let o;
  try { o = JSON.parse(t); } catch (e) { throw argsError(`JSON inválido em ${origin}: ${e.message}`); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw argsError(`o JSON em ${origin} precisa ser um objeto ({...})`);
  return o;
}

/** Reads the JSON of "--json -" (standard input), refusing an interactive terminal. */
function readJsonFromStdin() {
  if (stdinIsInteractive()) throw argsError('--json - espera o JSON pela entrada padrão (pipe ou redirecionamento), ex.: node registrar.js evento --json - < ev.json');
  const buf = readStdinSync();
  const o = parseJsonObject(buf, 'entrada padrão');
  warnAsciiStdin(buf, o);
  return o;
}

/**
 * The Windows PowerShell 5 pipe ($OutputEncoding us-ascii) turns accents and emoji into "?". If the input
 * is 100% ASCII and some text has "??", warns on stderr and suggests --json-arquivo.
 */
function warnAsciiStdin(buf, value) {
  if (!Buffer.isBuffer(buf) || buf.some((b) => b > 0x7f)) return false;
  let suspect = false;
  const walk = (v) => {
    if (suspect) return;
    if (typeof v === 'string') { if (v.includes('??')) suspect = true; return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  if (suspect) {
    warn('aviso: a entrada padrão chegou só com ASCII e algum texto tem "??": o PowerShell 5 provavelmente trocou acentos e emoji por "?". '
      + 'Use --json-arquivo <arquivo> (aceita UTF-8 e UTF-16) ou rode $OutputEncoding = [Text.UTF8Encoding]::new($false) antes do pipe.');
  }
  return suspect;
}

/** Reads the JSON of a file (UTF-8 or UTF-16 with BOM). */
function readJsonFromFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { throw argsError(`não consegui ler ${file}: ${e.code || e.message}`); }
  return parseJsonObject(buf, file);
}

/** Exit code of an error: 2 validation/usage, 3 lock timeout, 1 others. */
function exitCodeFor(e) {
  if (!e) return 0;
  if (e.code === 'EARGS' || e.code === 'EVALIDATION') return 2;
  if (e.code === 'ELOCK_TIMEOUT') return 3;
  return 1;
}

/** Readable error message (lists the validation problems, one per line). */
function errorMessage(e) {
  if (e && e.code === 'EVALIDATION') return `${e.message}\n${e.problems.map((x) => `  - ${x}`).join('\n')}`;
  if (e && e.code === 'ELOCK_TIMEOUT') return `${e.message}. Outro processo está segurando a trava; tente de novo em alguns segundos.`;
  return e && e.message ? e.message : String(e);
}

/** Runs the main function of a command: errors become a message on stderr and an exit code (0, 1, 2 or 3). */
function runCommand(main) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`erro: ${errorMessage(e)}\n`);
    process.exitCode = exitCodeFor(e);
  }
}

/** Writes a line to standard output. */
function print(text = '') {
  process.stdout.write(`${text}\n`);
}

/** Writes a warning to standard error (does not change the exit code). */
function warn(text) {
  process.stderr.write(`${text}\n`);
}

module.exports = {
  // paths
  maestroDir, defaultRoot, paths, slashes, stripAccents, folderForSlug, eventsFile, rawFile,
  safeSessionId, sessionFile, normalizePath, isInside,
  // dates
  TIME_ZONE, now, spParts, isoSP, dateTimeBR, dateBR, timeBR, spStamps, parseDate, longDay, readableAge,
  // lock and state JSON
  LOCK_DEFAULTS, randomHex, sleep, pidAlive, exlockIsExclusive, acquireLock, releaseLock, withLock,
  writeAtomic, writeJsonAtomic, readJson, cleanOrphanTemps, updateJson,
  // JSONL and standard input
  appendJsonl, readJsonl, listJsonl, sortByTs, decodeText, stdinIsInteractive, readStdinSync,
  // redaction and truncation
  REDACTED_MARK, envSecrets, looksSecret, redact, redactValue, truncate, summarize,
  // agents
  loadAgents, loadAgentsSafe, folderName, agentByDirectory, identifyAgent,
  // events
  FIXED_ORIGINS, EVENT_TYPES, RESULTS, TYPES_REQUIRING_DIRECTION, REQUIRED_EVENT_FIELDS, EVENT_FIELDS,
  MAX_SUMMARY, RE_FLOW, RE_PENDING_DECISION, RE_EVENT_ID, RE_SLUG,
  normalizeEnum, isFilled, agentProblems, originProblems, validateEvent, newEventId, idAlreadyUsed,
  orderFields, buildEvent, writeEvent, validationError, recordEvent, readEvents,
  // sessions and flows
  currentSession, flowOfSession, updateSession, diagnoseSession, missingFlowMessage, lastFlowInText,
  // correlation
  readRaw, rawForFlow,
  // command line
  argsError, parseArgs, warnMsysConversion, parseJsonObject, readJsonFromStdin, warnAsciiStdin, readJsonFromFile, exitCodeFor, errorMessage,
  runCommand, print, warn,
};
