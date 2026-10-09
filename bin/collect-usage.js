#!/usr/bin/env node
'use strict';
// collect-usage.js · Claude usage metrics (Maestri plan and tokens per agent)
//
// Two measures, always separate and with the source stated:
//  1. Plan (whole account): % of the 5 h window and of the weekly one, reset time and data age.
//     Source: <MAESTRI_DATA_DIR>/usage/providers/.status.json, the same file as the Maestri rings.
//     Without the file, without the Claude provider or without the windows, the plan is
//     "unavailable" with a reason code; no number is made up.
//  2. Share of each agent: tokens from the Claude Code transcripts. Each transcript is attributed by
//     the file state/sessions/<session_id>.json (agent + transcript_path, written by the hook),
//     together with the subagents of the folder <session_id>/subagents next to it (any depth,
//     agent-<id>.jsonl files). A session without owner is left out. Each message.id counts once,
//     with the usage of the LAST line of that id (in subagents the first line carries partial usage).
//
// relative consumption = input + 5 × output + 1.25 × cache write + 0.1 × cache read
// consumption %        = relative consumption of the agent ÷ sum of all in the period
// estimated plan %     = consumption % × plan % in the matching window
//                        (window_5h → 5 h window; 7d → weekly; "today" has no window of its own)
// Periods: window_5h (from reset_5h − 5 h until now; without a valid reset, the last 5 h),
//          today (since 00:00 in São Paulo) and 7d (last 7 days).
//
// Incremental reading: state/usage-cache.json keeps, per transcript, the offset already read and the
// last usage of each message.id. Each round reads only the new bytes; an incomplete last line waits
// for the next round; a transcript that does not exist yet is ignored without error.
//
// usage.json never carries sentences: reasons, warnings, notes and bases are codes with parameters
// ({code, ...params}); the page translates them (ADR 0004). Only the CLI summary is in Portuguese.
//
// Usage:  node collect-usage.js [--json] [--no-write] [--now <ISO>]
//   --json       prints usage.json to stdout (without the flag, prints a readable summary)
//   --no-write   does not write state/usage.json nor state/usage-cache.json
//   --now        pins "now" (tests; the MAESTRO_NOW variable also works)
// Variables: MAESTRO_DIR (default: the folder above this script), MAESTRI_DATA_DIR
//   (default ~/.maestri) and CLAUDE_CONFIG_DIR (default ~/.claude; only for sessions without transcript_path).
// Exit: 0 ok (even with the plan unavailable) · 2 invalid usage · 1 unexpected error.
// Exports collect() for the panel server (panel/server.js).

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TIME_ZONE = 'America/Sao_Paulo';
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const WEIGHTS = Object.freeze({ input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 });
const NOTE = Object.freeze({ code: 'usage_note' });
const FORMULA = Object.freeze({ code: 'usage_formula' });
const SOURCE = Object.freeze({ code: 'usage_source' });
const PLAN_SOURCE = Object.freeze({ code: 'maestri_claude_provider' });
const PERIODS = ['window_5h', 'today', '7d'];
const CACHE_VERSION = 2;
const RETENTION_MS = 8 * DAY_MS;      // older messages leave the cache (the longest period is 7 d)
const BLOCK = 4 * 1024 * 1024;        // incremental reading in 4 MB blocks
const MAX_SUBAGENTS = 5000;           // files per session (protection against a huge folder)
const FAILED_STATES = new Set(['failed', 'fileError', 'executableNotFound', 'needsNewerMaestri']);
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

class UsageError extends Error {}

// ---------- dates in the São Paulo time zone (Intl; never toISOString in the data) ----------

const FMT_SP = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Valid Date from a Date, a number (ms) or ISO text; null if invalid. */
function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date parts on the São Paulo clock (year, month, day, hour, minute, second). */
function spParts(date) {
  const p = {};
  for (const x of FMT_SP.formatToParts(date)) p[x.type] = x.value;
  return p;
}

/** ISO 8601 with the real São Paulo offset (today -03:00); null if the date is invalid. */
function isoSP(value) {
  const d = asDate(value);
  if (!d) return null;
  const p = spParts(d);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / MIN_MS);
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset < 0 ? '-' : '+'}${hh}:${mm}`;
}

/** São Paulo local day: YYYY-MM-DD. */
function spDay(value) {
  const d = asDate(value);
  if (!d) return null;
  const p = spParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Instant (ms) at which the São Paulo clock shows year-month-day hour:minute. */
function spInstant(year, month, day, hour = 0, minute = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let t = target + 3 * HOUR_MS; // guess: -03:00
  for (let i = 0; i < 4; i++) {
    const p = spParts(new Date(t));
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    if (seen === target) break;
    t += target - seen;
  }
  return t;
}

/** Instant (ms) of 00:00 in São Paulo on the day of the date. */
function spStartOfDay(value) {
  const p = spParts(asDate(value));
  return spInstant(+p.year, +p.month, +p.day, 0, 0);
}

/** Interface format: DD/MM/YYYY HH:MM. */
function dateTimeBR(value) {
  const d = asDate(value);
  if (!d) return '?';
  const p = spParts(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** HH:MM on the same day as the reference; otherwise DD/MM HH:MM. */
function shortTime(value, reference) {
  const d = asDate(value);
  if (!d) return '?';
  const p = spParts(d);
  const r = asDate(reference);
  const sameDay = r && spDay(r) === spDay(d);
  return sameDay ? `${p.hour}:${p.minute}` : `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

// ---------- files: tolerant reading and atomic writing ----------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries the operation on EPERM/EBUSY/EACCES (antivirus, concurrent rename on Windows). */
async function withRetries(fn, attempts = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!e || !RETRYABLE.has(e.code) || i >= attempts) throw e;
      await wait(Math.min(20 * i * i, 500));
    }
  }
}

/** File text, or null if it does not exist. */
async function readText(file) {
  try {
    return await withRetries(() => fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

/**
 * {exists, data, error}: never throws; invalid JSON is retried (writer in the middle of a write).
 * error is a code: {code: 'read_failed', detail} | {code: 'empty_file'} | {code: 'invalid_json', detail}.
 */
async function readJson(file, { attempts = 3 } = {}) {
  for (let i = 1; ; i++) {
    let text;
    try {
      text = await readText(file);
    } catch (e) {
      return { exists: true, data: null, error: { code: 'read_failed', detail: e.code || e.message } };
    }
    if (text === null) return { exists: false, data: null, error: null };
    const clean = text.replace(/^﻿/, '').trim();
    let error;
    if (!clean) error = { code: 'empty_file' };
    else {
      try {
        return { exists: true, data: JSON.parse(clean), error: null };
      } catch (e) {
        error = { code: 'invalid_json', detail: e.message };
      }
    }
    if (i >= attempts) return { exists: true, data: null, error };
    await wait(40 * i);
  }
}

/** Writes through a temporary + rename, with retries (renaming over an open file gives EPERM). */
async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, content);
  try {
    await withRetries(() => fsp.rename(tmp, file), 12);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

// ---------- paths ----------

function paths(options = {}) {
  const env = options.env || process.env;
  const maestroDir = path.resolve(options.maestroDir || env.MAESTRO_DIR || path.join(__dirname, '..'));
  const maestriDir = path.resolve(options.maestriDataDir || env.MAESTRI_DATA_DIR || path.join(os.homedir(), '.maestri'));
  const claudeDir = path.resolve(options.claudeDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  return {
    maestroDir, maestriDir, claudeDir,
    status: path.join(maestriDir, 'usage', 'providers', '.status.json'),
    // The agent registry belongs to the old model (bin/registrar.js); it goes away in #18.
    agents: path.join(maestroDir, 'registro', 'agentes.json'),
    sessions: path.join(maestroDir, 'state', 'sessions'),
    usage: path.join(maestroDir, 'state', 'usage.json'),
    cache: path.join(maestroDir, 'state', 'usage-cache.json'),
  };
}

// On Windows the same file may show up with different letter cases.
function fileKey(file) {
  const r = path.resolve(file);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// ---------- measure 1: plan ----------

function numberOrNull(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function findWindow(windows, id, duration) {
  return windows.find((w) => w && w.id === id) || windows.find((w) => w && Number(w.durationSeconds) === duration) || null;
}

function applyWindow(plan, which, win, t) {
  const c = which === '5h'
    ? { pct: 'window_5h_pct', reset: 'reset_5h', dur: 'window_5h_duration_s', reason: 'window_5h_reason' }
    : { pct: 'weekly_pct', reset: 'weekly_reset', dur: 'weekly_duration_s', reason: 'weekly_reason' };
  const window = which === '5h' ? '5h' : 'weekly';
  if (!win) {
    plan[c.reason] = { code: 'window_missing', window };
    return;
  }
  const pct = numberOrNull(win.usedPercent);
  const reset = asDate(win.resetsAt);
  plan[c.dur] = numberOrNull(win.durationSeconds);
  plan[c.reset] = reset ? isoSP(reset) : null;
  if (pct === null) {
    plan[c.reason] = { code: 'window_without_pct', window };
    return;
  }
  if (reset && reset.getTime() <= t) {
    // The window already reset after the last reading: the old value would mislead.
    plan[c.reason] = { code: 'window_reset', window, reset_at: isoSP(reset), read_at: plan.updated_at };
    return;
  }
  plan[c.pct] = pct;
}

/** Reads the Maestri .status.json and returns the "plan" block of usage.json. */
async function readPlan(file, now) {
  const t = now.getTime();
  const plan = {
    available: false, source: PLAN_SOURCE, file: file.replace(/\\/g, '/'),
    window_5h_pct: null, reset_5h: null, weekly_pct: null, weekly_reset: null,
    window_5h_duration_s: null, weekly_duration_s: null, window_5h_reason: null, weekly_reason: null,
    updated_at: null, age_min: null, plan: null, state: null, reason: null, warnings: [],
  };
  const r = await readJson(file);
  if (!r.exists) {
    plan.reason = { code: 'plan_file_missing', file: plan.file };
    return plan;
  }
  if (r.error) {
    plan.reason = { code: 'plan_file_unreadable', file: plan.file, error: r.error };
    return plan;
  }
  const providers = r.data && Array.isArray(r.data.providers) ? r.data.providers : [];
  const p = providers.find((x) => x && x.id === 'claude');
  if (!p) {
    plan.reason = { code: 'plan_provider_missing' };
    return plan;
  }
  plan.state = typeof p.state === 'string' ? p.state : null;
  plan.plan = typeof p.plan === 'string' ? p.plan : null;
  const when = asDate(p.lastSuccessAt) || asDate(r.data.updatedAt);
  if (when) {
    plan.updated_at = isoSP(when);
    plan.age_min = Math.max(0, Math.round((t - when.getTime()) / MIN_MS));
  }
  const providerError = typeof p.error === 'string' && p.error.trim() ? p.error.trim() : null;
  if (p.enabled === false || p.state === 'off') {
    plan.reason = { code: 'plan_provider_off' };
    return plan;
  }
  const meters = Array.isArray(p.meters) ? p.meters : [];
  const meter = meters.find((m) => m && m.id === 'plan') || null;
  const windows = meter && Array.isArray(meter.windows) ? meter.windows : [];
  applyWindow(plan, '5h', findWindow(windows, 'five_hour', 18000), t);
  applyWindow(plan, '7d', findWindow(windows, 'seven_day', 604800), t);
  if (plan.window_5h_pct === null && plan.weekly_pct === null) {
    if (!windows.length) {
      plan.reason = plan.state && plan.state !== 'ready'
        ? { code: 'plan_read_failed', state: plan.state, error: providerError }
        : { code: 'plan_windows_missing' };
    } else {
      plan.reason = { code: 'plan_windows_unavailable', window_5h_reason: plan.window_5h_reason, weekly_reason: plan.weekly_reason };
    }
    return plan;
  }
  plan.available = true;
  if (plan.state && FAILED_STATES.has(plan.state)) {
    plan.warnings.push({ code: 'plan_last_read_failed', state: plan.state, error: providerError, read_at: plan.updated_at });
  }
  for (const m of [plan.window_5h_reason, plan.weekly_reason]) if (m) plan.warnings.push(m);
  return plan;
}

// ---------- measure 2: transcripts per session ----------

const RE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Sessions with an owner: [{id, agent, transcript}]. Counts the ownerless and unreadable ones in diag. */
async function readSessions(dir, claudeDir, diag) {
  let names;
  try {
    names = await withRetries(() => fsp.readdir(dir));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
  const sessions = [];
  for (const name of names.sort()) {
    if (!/\.json$/i.test(name)) continue; // ignores .tmp and .lock
    const r = await readJson(path.join(dir, name), { attempts: 2 });
    const s = r.data;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      if (r.exists) diag.unreadable_sessions++;
      continue;
    }
    const agent = typeof s.agent === 'string' ? s.agent.trim() : '';
    if (!agent) {
      diag.sessions_without_owner++;
      continue;
    }
    const id = typeof s.session_id === 'string' && s.session_id ? s.session_id : name.replace(/\.json$/i, '');
    let transcript = typeof s.transcript_path === 'string' && s.transcript_path.trim() ? path.resolve(s.transcript_path.trim()) : null;
    if (!transcript && typeof s.cwd === 'string' && s.cwd && RE_SESSION_ID.test(id)) {
      // Same folder rule as Claude Code: every character outside [A-Za-z0-9] becomes "-".
      transcript = path.join(claudeDir, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
    }
    if (!transcript) {
      diag.sessions_without_transcript++;
      continue;
    }
    sessions.push({ id, agent, transcript });
  }
  return sessions;
}

function subagentsFolder(transcript) {
  const base = path.basename(transcript).replace(/\.jsonl$/i, '');
  return path.join(path.dirname(transcript), base, 'subagents');
}

/** agent-*.jsonl files at any depth (journal.jsonl and .meta.json are left out). */
async function listSubagents(dir) {
  const found = [];
  async function walk(d, level) {
    if (level > 8 || found.length >= MAX_SUBAGENTS) return;
    let items;
    try {
      items = await fsp.readdir(d, { withFileTypes: true });
    } catch (_) {
      return; // folder does not exist yet (session without subagents)
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) await walk(p, level + 1);
      else if (it.isFile() && /^agent-.+\.jsonl$/i.test(it.name)) found.push(p);
    }
  }
  await walk(dir, 0);
  return found.sort();
}

function integer(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Keeps the usage of an "assistant" line: the last line of each message.id replaces the earlier ones. */
function recordObject(o, entry, diag) {
  if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return;
  const u = o.message.usage;
  if (!u || typeof u !== 'object') return;
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return;
  const id = o.message.id ? String(o.message.id)
    : o.requestId ? `req:${o.requestId}`
      : o.uuid ? `uuid:${o.uuid}` : null;
  if (!id) return;
  entry.msgs[id] = [ts, integer(u.input_tokens), integer(u.output_tokens),
    integer(u.cache_creation_input_tokens), integer(u.cache_read_input_tokens)];
  diag.lines_with_usage++;
}

function processText(text, entry, diag) {
  for (let line of text.split('\n')) {
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    // Shortcut: only lines with usage matter (tool lines may have megabytes).
    if (!line || line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      diag.invalid_lines++;
      continue;
    }
    recordObject(o, entry, diag);
  }
}

/** Reads the new bytes of a transcript from the stored offset. */
async function readIncrement(file, entry, size, diag) {
  const fh = await withRetries(() => fsp.open(file, 'r'));
  try {
    let pos = entry.offset;
    let rest = null;
    while (pos < size) {
      const want = Math.min(BLOCK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      diag.bytes_read += bytesRead;
      pos += bytesRead;
      let data = buf.subarray(0, bytesRead);
      if (rest) data = Buffer.concat([rest, data]);
      const nl = data.lastIndexOf(0x0a);
      if (nl < 0) {
        rest = data; // line longer than the block: keeps gathering
        continue;
      }
      // Cutting at \n is safe in UTF-8 (a continuation byte is never 0x0A).
      processText(data.subarray(0, nl).toString('utf8'), entry, diag);
      rest = nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null;
      entry.offset = pos - (rest ? rest.length : 0);
      await new Promise((r) => setImmediate(r)); // lets the server answer between blocks
    }
    if (rest && rest.length) {
      // End of file without \n: only consumed if it is already a complete JSON; otherwise the line
      // is still being written and waits for the next round.
      const text = rest.toString('utf8').replace(/^﻿/, '').trim();
      let o = null;
      if (text) {
        try { o = JSON.parse(text); } catch (_) { o = null; }
      }
      if (!text || (o && typeof o === 'object')) {
        if (o) recordObject(o, entry, diag);
        entry.offset = pos;
      }
    }
  } finally {
    await fh.close();
  }
}

/** Updates the cache entry of a transcript. Returns {entry|null, changed}. */
async function updateFile(file, previous, t, diag, warnings) {
  let st;
  try {
    st = await withRetries(() => fsp.stat(file));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      diag.missing_transcripts++;
      return { entry: null, changed: !!previous };
    }
    warnings.push({ code: 'transcript_unreadable', file: file.replace(/\\/g, '/'), error: e.code || e.message });
    return { entry: previous || null, changed: false };
  }
  if (!st.isFile()) {
    diag.missing_transcripts++;
    return { entry: null, changed: !!previous };
  }
  diag.transcripts++;
  if (st.mtimeMs < t - RETENTION_MS) {
    // Idle for longer than the retention: nothing of it falls into the periods.
    diag.old_transcripts++;
    return { entry: null, changed: !!previous };
  }
  let entry = previous;
  const replaced = entry && (entry.ino !== st.ino || Math.abs((entry.birth || 0) - st.birthtimeMs) > 1 || st.size < entry.offset);
  if (!entry || replaced) {
    if (replaced) diag.restarted_transcripts++;
    entry = { file: file.replace(/\\/g, '/'), offset: 0, ino: st.ino, birth: st.birthtimeMs, msgs: {} };
  }
  if (st.size === entry.offset) return { entry, changed: !previous || replaced };
  try {
    await readIncrement(file, entry, st.size, diag);
  } catch (e) {
    warnings.push({ code: 'transcript_read_interrupted', file: file.replace(/\\/g, '/'), error: e.code || e.message });
  }
  return { entry, changed: true };
}

async function loadCache(file, diag) {
  const empty = () => ({ version: CACHE_VERSION, updated_at: null, files: {} });
  const r = await readJson(file, { attempts: 2 });
  if (!r.exists) {
    diag.cache = 'new';
    return { cache: empty(), fresh: true };
  }
  const d = r.data;
  if (!d || typeof d !== 'object' || d.version !== CACHE_VERSION || !d.files || typeof d.files !== 'object') {
    diag.cache = 'recreated';
    return { cache: empty(), fresh: true };
  }
  for (const [k, e] of Object.entries(d.files)) {
    const ok = e && typeof e === 'object' && Number.isFinite(e.offset) && e.offset >= 0 && e.msgs && typeof e.msgs === 'object';
    if (!ok) delete d.files[k];
  }
  diag.cache = 'reused';
  return { cache: d, fresh: false };
}

// ---------- aggregation ----------

function round(n, places = 1) {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function newTotal() {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0 };
}

function relativeConsumption(s) {
  return s.input * WEIGHTS.input + s.output * WEIGHTS.output + s.cache_write * WEIGHTS.cache_write + s.cache_read * WEIGHTS.cache_read;
}

/** Start of each period (ms) and where it comes from. */
function computePeriods(now, plan) {
  const t = now.getTime();
  let start5 = t - 5 * HOUR_MS;
  let basis5 = { code: 'last_5h_no_reset' };
  const reset = Date.parse(plan.reset_5h);
  if (Number.isFinite(reset) && reset > t) {
    const dur = (plan.window_5h_duration_s || 5 * 3600) * 1000;
    if (reset - dur <= t) {
      start5 = reset - dur;
      basis5 = { code: 'since_5h_window_start' };
    }
  }
  // The plan week (weekly_reset − 7 d until now) is the base of the estimated plan % in the "7d"
  // period: the Maestri weekly_pct applies to it, not to the 7 calendar days of the bars.
  let week = null;
  const resetW = Date.parse(plan.weekly_reset);
  if (Number.isFinite(resetW) && resetW > t) {
    const durW = (plan.weekly_duration_s || 7 * 24 * 3600) * 1000;
    if (resetW - durW <= t) week = { start: resetW - durW, end: t, basis: { code: 'plan_week' } };
  }
  return {
    window_5h: { start: start5, end: t, basis: basis5 },
    today: { start: spStartOfDay(now), end: t, basis: { code: 'since_midnight' } },
    '7d': { start: t - 7 * DAY_MS, end: t, basis: { code: 'last_7_days' }, plan: week },
  };
}

/** Dedups by message.id across all owned transcripts and sums per agent and period. */
function aggregate(cache, owners, periods, plan, registered) {
  const msgs = new Map();
  for (const [key, e] of Object.entries(cache.files)) {
    const owner = owners.get(key);
    if (!owner) continue;
    for (const [id, m] of Object.entries(e.msgs)) {
      if (!Array.isArray(m) || m.length < 5) continue;
      const current = msgs.get(id);
      // The same message copied into another file (forked session) has the same usage: counts once.
      if (!current || m[0] > current.m[0] || (m[0] === current.m[0] && m[2] > current.m[2])) msgs.set(id, { m, agent: owner.agent });
    }
  }
  const sumPeriod = (start, end) => {
    const sums = new Map(registered.map((slug) => [slug, newTotal()]));
    const total = newTotal();
    for (const { m, agent } of msgs.values()) {
      if (m[0] < start || m[0] > end + MIN_MS) continue;
      if (!sums.has(agent)) sums.set(agent, newTotal());
      for (const s of [sums.get(agent), total]) {
        s.input += m[1]; s.output += m[2]; s.cache_write += m[3]; s.cache_read += m[4]; s.messages++;
      }
    }
    return { sums, total };
  };
  const byAgent = {};
  const totals = {};
  for (const name of PERIODS) {
    const { start, end } = periods[name];
    const { sums, total } = sumPeriod(start, end);
    const totalConsumption = relativeConsumption(total);
    const planPct = !plan.available ? null : name === 'window_5h' ? plan.window_5h_pct : name === '7d' ? plan.weekly_pct : null;
    // "7d": the share for the plan % is measured in the plan week (the same base as weekly_pct);
    // the bars stay on the 7 calendar days.
    const planBase = name === '7d' && periods[name].plan ? sumPeriod(periods[name].plan.start, periods[name].plan.end) : null;
    const planConsumption = planBase ? relativeConsumption(planBase.total) : null;
    for (const slug of planBase ? planBase.sums.keys() : []) if (!sums.has(slug)) sums.set(slug, newTotal());
    byAgent[name] = [...sums].map(([agent, s]) => {
      const consumption = relativeConsumption(s);
      const fraction = totalConsumption > 0 ? consumption / totalConsumption : 0;
      let planFraction = fraction;
      const extra = {};
      if (planBase) {
        const sp = planBase.sums.get(agent);
        planFraction = planConsumption > 0 && sp ? relativeConsumption(sp) / planConsumption : 0;
        extra.plan_week_consumption_pct = round(100 * planFraction, 1);
      }
      return Object.assign({
        agent,
        registered: registered.includes(agent),
        input: s.input, output: s.output, cache_write: s.cache_write, cache_read: s.cache_read,
        messages: s.messages,
        relative_consumption: round(consumption, 1),
        consumption_pct: round(100 * fraction, 1),
        estimated_plan_pct: typeof planPct === 'number' ? round(planFraction * planPct, 1) : null,
      }, extra);
    }).sort((a, b) => b.relative_consumption - a.relative_consumption || a.agent.localeCompare(b.agent));
    totals[name] = Object.assign({}, total, { relative_consumption: round(totalConsumption, 1) });
  }
  return { byAgent, totals, messages: msgs.size };
}

// ---------- collection ----------

/**
 * Runs the collection. options: {maestroDir, maestriDataDir, claudeDir, env, now, write (default true)}.
 * Returns the usage.json object (also written to state/usage.json when writing).
 */
async function collect(options = {}) {
  const startedAt = Date.now();
  const env = options.env || process.env;
  const now = asDate(options.now) || asDate(env.MAESTRO_NOW) || new Date();
  const t = now.getTime();
  const p = paths(Object.assign({}, options, { env }));
  const write = options.write !== false;
  const warnings = [];
  const diag = {
    sessions: 0, sessions_without_owner: 0, unreadable_sessions: 0, sessions_without_transcript: 0,
    transcripts: 0, missing_transcripts: 0, old_transcripts: 0, restarted_transcripts: 0,
    bytes_read: 0, lines_with_usage: 0, invalid_lines: 0, messages: 0, cache: null, duration_ms: 0,
  };

  const plan = await readPlan(p.status, now);
  const registry = await readJson(p.agents);
  if (registry.error) warnings.push({ code: 'registry_unreadable', error: registry.error });
  const registered = registry.data && Array.isArray(registry.data.agentes)
    ? registry.data.agentes.filter((a) => a && typeof a.slug === 'string' && a.slug).map((a) => a.slug)
    : [];

  const { cache, fresh } = await loadCache(p.cache, diag);
  let changed = fresh;

  // Owner of each file in this round (the session rules; if the hook fixes the agent, the attribution follows).
  const sessions = await readSessions(p.sessions, p.claudeDir, diag);
  diag.sessions = sessions.length;
  const owners = new Map();
  for (const s of sessions) {
    const files = [s.transcript, ...(await listSubagents(subagentsFolder(s.transcript)))];
    for (const f of files) {
      const k = fileKey(f);
      if (!owners.has(k)) owners.set(k, { agent: s.agent, file: f });
    }
  }
  for (const k of Object.keys(cache.files)) {
    if (!owners.has(k)) {
      delete cache.files[k];
      changed = true;
    }
  }
  for (const [k, o] of owners) {
    const r = await updateFile(o.file, cache.files[k], t, diag, warnings);
    if (r.changed) changed = true;
    if (r.entry) cache.files[k] = r.entry;
    else delete cache.files[k];
  }
  // Pruning: messages outside the retention serve no period.
  const limit = t - RETENTION_MS;
  for (const e of Object.values(cache.files)) {
    for (const [id, m] of Object.entries(e.msgs)) {
      if (!Array.isArray(m) || !(m[0] >= limit)) {
        delete e.msgs[id];
        changed = true;
      }
    }
  }

  const periods = computePeriods(now, plan);
  const ag = aggregate(cache, owners, periods, plan, registered);
  diag.messages = ag.messages;
  diag.duration_ms = Date.now() - startedAt;
  if (diag.sessions_without_owner) warnings.push({ code: 'sessions_without_agent', count: diag.sessions_without_owner });
  if (diag.invalid_lines) warnings.push({ code: 'invalid_transcript_lines', count: diag.invalid_lines });

  const usage = {
    collected_at: isoSP(now),
    source: SOURCE,
    note: NOTE,
    formula: FORMULA,
    plan,
    periods: Object.fromEntries(PERIODS.map((name) => {
      const x = { start: isoSP(periods[name].start), end: isoSP(periods[name].end), basis: periods[name].basis };
      // Only in "7d": where the share used in the estimated plan % comes from (the plan week).
      if (periods[name].plan) x.plan_basis = { start: isoSP(periods[name].plan.start), end: isoSP(periods[name].plan.end), basis: periods[name].plan.basis };
      else if (name === '7d') x.plan_basis = null;
      return [name, x];
    })),
    by_agent: ag.byAgent,
    totals: ag.totals,
    collection: diag,
    warnings,
  };

  if (write) {
    if (changed) {
      cache.updated_at = usage.collected_at;
      await writeAtomic(p.cache, JSON.stringify(cache));
    }
    await writeAtomic(p.usage, JSON.stringify(usage, null, 2) + '\n');
  }
  return usage;
}

// ---------- command line (messages for people in Portuguese, ADR 0004) ----------

const HELP = `Uso: node collect-usage.js [--json] [--no-write] [--now <ISO>]
  Coleta o uso do Claude: o % do plano (Maestri) e a participação de cada agente
  (transcrições do Claude Code), e grava state/usage.json.
  --json       imprime o usage.json no stdout
  --no-write   não grava state/usage.json nem state/usage-cache.json
  --now        fixa o "agora" (testes), ex.: 2026-10-08T15:50:00-03:00
Variáveis: MAESTRO_DIR, MAESTRI_DATA_DIR (padrão ~/.maestri), CLAUDE_CONFIG_DIR (padrão ~/.claude).`;

/** Portuguese text of a reason/warning code, for the CLI summary only. */
function describe(c, ref) {
  if (!c || typeof c !== 'object') return c ? String(c) : '';
  const win = (w) => (w === '5h' ? 'de 5 h' : 'semanal');
  const err = (e) => (e && typeof e === 'object' ? describe(e, ref) : e);
  switch (c.code) {
    case 'plan_file_missing': return `O Maestri ainda não gravou o uso do plano (${c.file} não existe). Ligue o uso dos agentes no Maestri (Configurações → Agentes → Uso) e deixe os anéis visíveis.`;
    case 'plan_file_unreadable': return `Não consegui ler ${c.file}: ${err(c.error)}.`;
    case 'read_failed': return `não consegui ler (${c.detail})`;
    case 'empty_file': return 'arquivo vazio';
    case 'invalid_json': return `JSON inválido (${c.detail})`;
    case 'plan_provider_missing': return 'O arquivo de uso do Maestri não tem o provedor "claude".';
    case 'plan_provider_off': return 'O provedor Claude está desligado no Maestri (Configurações → Agentes → Uso).';
    case 'plan_read_failed': return `O Maestri não conseguiu ler o uso do Claude (estado "${c.state}"${c.error ? `: ${c.error}` : ''}).`;
    case 'plan_windows_missing': return 'O Maestri ainda não trouxe as janelas do plano (5 h e semanal).';
    case 'plan_windows_unavailable': return [describe(c.window_5h_reason, ref), describe(c.weekly_reason, ref)].filter(Boolean).join(' ');
    case 'plan_last_read_failed': return `A última consulta do Maestri falhou (estado "${c.state}"${c.error ? `: ${c.error}` : ''}); os valores são da leitura${c.read_at ? ` de ${shortTime(c.read_at, ref)}` : ''}.`;
    case 'window_missing': return `O Maestri não trouxe a janela ${win(c.window)}.`;
    case 'window_without_pct': return `A janela ${win(c.window)} veio sem o percentual usado.`;
    case 'window_reset': return `A janela ${win(c.window)} reiniciou às ${shortTime(c.reset_at, ref)}, depois da última leitura do Maestri${c.read_at ? ` (${shortTime(c.read_at, ref)})` : ''}; o % novo aparece na próxima leitura.`;
    case 'sessions_without_agent': return `${c.count} sessão(ões) sem agente em state/sessions ficaram de fora.`;
    case 'invalid_transcript_lines': return `${c.count} linha(s) de transcrição ilegível(is) ignorada(s).`;
    case 'transcript_unreadable': return `Não consegui ler ${c.file}: ${c.error}`;
    case 'transcript_read_interrupted': return `Leitura interrompida em ${c.file}: ${c.error}`;
    case 'registry_unreadable': return `registro/agentes.json: ${err(c.error)}`;
    default: return c.code;
  }
}

function parseArgs(argv) {
  const o = { json: false, noWrite: false, now: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-write') o.noWrite = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--now' || a.startsWith('--now=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const d = asDate(v);
      if (!d) throw new UsageError(`--now inválido: "${v === undefined ? '' : v}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).`);
      o.now = d;
    } else throw new UsageError(`Opção desconhecida: ${a} (use --help).`);
  }
  return o;
}

function pct(v) {
  return typeof v === 'number' ? `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—';
}

function readableSummary(usage, wrote) {
  const L = [];
  const p = usage.plan;
  const ref = usage.collected_at;
  L.push(`Uso coletado em ${dateTimeBR(usage.collected_at)}`);
  if (p.available) {
    const r5 = p.reset_5h ? ` (reinicia ${shortTime(p.reset_5h, ref)})` : '';
    const r7 = p.weekly_reset ? ` (reinicia ${shortTime(p.weekly_reset, ref)})` : '';
    const age = p.age_min === null ? '' : ` · dado de ${p.age_min} min`;
    L.push(`Plano: 5 h ${pct(p.window_5h_pct)}${r5} · semanal ${pct(p.weekly_pct)}${r7}${age}`);
  } else {
    L.push(`Plano: indisponível. ${describe(p.reason, ref)}`);
  }
  for (const w of p.warnings || []) L.push(`  Aviso: ${describe(w, ref)}`);
  const slugs = [...new Set(PERIODS.flatMap((x) => usage.by_agent[x].map((l) => l.agent)))];
  L.push('Por agente, % do consumo (janela de 5 h · hoje · 7 dias):');
  if (!slugs.length) L.push('  nenhum agente com sessão registrada');
  for (const s of slugs) {
    const v = PERIODS.map((x) => (usage.by_agent[x].find((l) => l.agent === s) || {}).consumption_pct);
    L.push(`  ${s.padEnd(24)} ${v.map(pct).join(' · ')}`);
  }
  const d = usage.collection;
  const mb = (d.bytes_read / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const cache = { new: 'novo', reused: 'reaproveitado', recreated: 'recriado' }[d.cache] || d.cache;
  L.push(`Sessões: ${d.sessions} com dono, ${d.sessions_without_owner} sem dono · transcrições: ${d.transcripts} (${d.missing_transcripts} ainda sem arquivo) · ${mb} MB lidos · cache ${cache}`);
  for (const w of usage.warnings) L.push(`Aviso: ${describe(w, ref)}`);
  L.push(wrote ? 'Gravado em state/usage.json' : 'Nada gravado (--no-write)');
  return L.join('\n') + '\n';
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  const usage = await collect({ now: args.now || undefined, write: !args.noWrite });
  process.stdout.write(args.json ? JSON.stringify(usage, null, 2) + '\n' : readableSummary(usage, !args.noWrite));
  return 0;
}

module.exports = {
  collect, readPlan, computePeriods, relativeConsumption, paths, WEIGHTS, NOTE, FORMULA, PERIODS,
  util: {
    asDate, spParts, isoSP, spDay, spInstant, spStartOfDay, dateTimeBR, shortTime,
    withRetries, readText, readJson, writeAtomic, wait,
  },
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    if (e instanceof UsageError) {
      process.stderr.write(`Erro: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`Erro inesperado: ${e && e.stack ? e.stack : e}\n`);
      process.exitCode = 1;
    }
  });
}
