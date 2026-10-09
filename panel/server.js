#!/usr/bin/env node
'use strict';
// server.js · local panel of the multi-agent workspace (Maestri + Claude Code)
//
// HTTP server with Node's standard library only, bound to 127.0.0.1. Serves index.html and a JSON API
// that aggregates the files under MAESTRO_DIR on every request (registry, logs, state). No AI and no
// tokens: it only reads files. Runs the usage collector (bin/collect-usage.js) on startup and every
// 5 min, in the same process and without blocking requests.
//
// Start:  node panel/server.js [--port 4777]
// Stop:   Ctrl+C in the server terminal, or taskkill /PID <pid from state/panel.pid> /F
//
// Routes: GET /, GET /api/state, GET /api/events, GET /api/event/<id>, GET /api/flow/<id>,
//         POST /api/recalculate, POST /api/brain (future phase: 501). Pending decisions (api-pendencias.js):
//         POST /api/pending-decisions/<P-NNNN>/answer {option, text}. Details in README.md.
//         New model (api-items.js, maestro.db): GET /api/items[?active=1|0], GET /api/items/<project>/<number>.
// The API never returns sentences: reasons, warnings and errors are codes with parameters
// ({code, ...params}) and the page translates them (ADR 0004). Old-model records (events and pending
// decisions written by bin/registrar.js and bin/pendencia.js) go out with English field names
// (legacy-records.js).
// Security: listens only on 127.0.0.1; Host must be 127.0.0.1:<port> or localhost:<port>
//   (otherwise 403); POST only with the header X-Panel: 1 (otherwise 403); no CORS header; only
//   "/" and "/api/*" exist (the rest is 404); JSON always with Cache-Control: no-store.
//
// Variables: PANEL_PORT (default 4777; --port wins), MAESTRO_DIR (default: the folder above panel/ for the old
//   model and ~/.painel-maestro for the new model's maestro.db),
//   MAESTRI_DATA_DIR and CLAUDE_CONFIG_DIR (passed to the collector), PANEL_COLLECTOR=0 (does not run
//   the collector by itself) and, for tests only, PANEL_INDEX (another index.html) and PANEL_NOW
//   (fixed clock; MAESTRO_NOW also works).
//   Brain notice (pending decision answer): PANEL_NOTIFY_BRAIN=0 turns it off and =1 on; without it,
//   on only inside a Maestri terminal (MAESTRI_TERMINAL_ID) and with a real clock. PANEL_MAESTRI_CLI
//   replaces the executable (tests; default MAESTRI_CLI or "maestri").

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const collector = require(path.join(__dirname, '..', 'bin', 'collect-usage.js'));
const pendingApi = require(path.join(__dirname, 'api-pendencias.js'));
const itemsApi = require(path.join(__dirname, 'api-items.js'));
const { eventToApi, pendingDecisionToApi } = require(path.join(__dirname, 'legacy-records.js'));
const { asDate, isoSP, spDay, readJson, readText, withRetries, writeAtomic } = collector.util;

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_PORT = 4777;
const COLLECTOR_INTERVAL_MS = 5 * MIN_MS;
const STATE_EVENT_LIMIT = 200;
const CLOSED_LIMIT = 20;
const COMMAND_LIMIT = 1500;
const FLOW_DAY_LIMIT = 62;                    // the 1st day (and the eve) always enter; the rest are the most recent
const RAW_BYTES_PER_REQUEST = 160 * 1024 * 1024; // ceiling of NEW raw log bytes read in one request
const RAW_MAX_INDEX_LINES = 4e6;              // indexed lines kept (≈ 30 bytes each)
const WINDOW_MAX_MS = 6 * HOUR_MS;            // without flow_id: at most 6 h before the event
const WINDOW_NO_PREVIOUS_MS = 15 * MIN_MS;    // without a previous event nor flow start before: 15 min (like the registrar)
const RAW_STALE_MS = 24 * HOUR_MS;
const OWNER_RESULTS = new Set(['falhou', 'bloqueado', 'aguardando-dono']);
const OPEN_RESULTS = new Set(['em-andamento', 'aguardando-dono', 'bloqueado', 'parcial']);
const SEVERITY_ORDER = new Map([['critica', 0], ['alta', 1], ['normal', 2], ['baixa', 3]]);
const TABLE_FIELDS = ['id', 'ts', 'agente', 'projeto', 'resumo', 'direcao', 'resultado', 'tipo', 'fluxo_id', 'precisa_dono'];
const RE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
// index.html is a single file (embedded CSS and JS); nothing external is loaded.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BODY_LIMIT = 16 * 1024; // body accepted by the POSTs that read JSON (pending decision answer)
const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
// Old-model files, relative to MAESTRO_DIR (bin/registrar.js and bin/pendencia.js; removed in #18).
const LEGACY = {
  agents: 'registro/agentes.json',
  events: 'logs/eventos',
  pendingDecisions: 'estado/pendencias.json',
  flowCounter: 'estado/contador-fluxos.json',
};

class UsageError extends Error {}
class RequestError extends Error {
  constructor(status, error) {
    super(error.code);
    this.status = status;
    this.error = error;
  }
}

// ---------- configuration ----------

function parseConfig(argv = [], env = process.env) {
  let port = env.PANEL_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') port = argv[++i];
    else if (a.startsWith('--port=')) port = a.slice('--port='.length);
    else if (a === '--help' || a === '-h') return { help: true };
    else throw new UsageError(`Opção desconhecida: ${a} (use --help).`);
  }
  const p = port === undefined || port === '' ? DEFAULT_PORT : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new UsageError(`Porta inválida: "${port}" (use um número de 1 a 65535).`);
  const nowText = env.PANEL_NOW || env.MAESTRO_NOW || '';
  const fixedNow = nowText ? asDate(nowText) : null;
  if (nowText && !fixedNow) throw new UsageError(`Relógio fixo inválido: "${nowText}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).`);
  return {
    port: p,
    maestroDir: path.resolve(env.MAESTRO_DIR || path.join(__dirname, '..')),
    indexPath: path.resolve(env.PANEL_INDEX || path.join(__dirname, 'index.html')),
    fixedNow,
    collectorActive: env.PANEL_COLLECTOR !== '0',
    brainNotice: parseBrainNotice(env, fixedNow),
    env,
  };
}

// Brain notice when the owner answers a pending decision through the panel (maestri ask in its terminal).
function parseBrainNotice(env, fixedNow) {
  const cli = env.PANEL_MAESTRI_CLI || env.MAESTRI_CLI || 'maestri';
  if (env.PANEL_NOTIFY_BRAIN === '0') return { active: false, cli, reason: { code: 'brain_notice_off', variable: 'PANEL_NOTIFY_BRAIN' } };
  if (env.PANEL_NOTIFY_BRAIN === '1') return { active: true, cli };
  if (!env.MAESTRI_TERMINAL_ID) return { active: false, cli, reason: { code: 'brain_notice_no_terminal' } };
  if (fixedNow) return { active: false, cli, reason: { code: 'brain_notice_fixed_clock' } };
  return { active: true, cli };
}

// ---------- helpers ----------

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function ageMin(value, t) {
  const d = asDate(value);
  return d ? Math.max(0, Math.round((t - d.getTime()) / MIN_MS)) : null;
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

function validDay(day) {
  if (!RE_DAY.test(day)) return false;
  return addDays(day, 0) === day; // refuses 2026-02-31
}

function listDays(start, end, limit) {
  const days = [];
  for (let d = start; d <= end && days.length < limit; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Raw log folder of an agent (same rule as bin/lib.js: "desconhecido:x" → "desconhecido-x"). */
function agentFolder(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  const s = slug.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  return s || null;
}

function folderAgent(folder) {
  return /^desconhecido-/.test(folder) ? `desconhecido:${folder.slice('desconhecido-'.length)}` : folder;
}

function normalizeSearch(s) {
  return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function relative(dir, file) {
  return path.relative(dir, file).replace(/\\/g, '/');
}

// ---------- incremental JSONL reading (tolerant: broken line, incomplete end, EPERM) ----------

let sequence = 0;

class JsonlReader {
  // max: files kept; maxBytes: sum of the bytes read (the oldest leaves first, the last one stays).
  constructor({ max = Infinity, maxBytes = Infinity, onRead = null } = {}) {
    this.max = max;
    this.maxBytes = maxBytes;
    this.onRead = onRead;
    this.map = new Map();
  }

  storedBytes() {
    let total = 0;
    for (const e of this.map.values()) total += e.bytes || 0;
    return total;
  }

  /** Returns {file, exists, lines, invalid, generation}; reads only the new bytes since last time. */
  async read(file) {
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    let ent = this.map.get(key);
    if (ent) this.map.delete(key);
    else ent = { file, exists: false, lines: [], invalid: 0, generation: 0, offset: 0, bytes: 0, ino: null, birth: null, size: -1, mtime: -1, gz: /\.gz$/i.test(file), queue: Promise.resolve() };
    this.map.set(key, ent); // end of the Map = most recently used
    const task = ent.queue.then(() => this.update(ent));
    ent.queue = task.catch(() => {});
    try {
      await task;
      ent.error = null;
    } catch (e) {
      // Momentary failure (file held by another process): returns what was already read.
      ent.error = e && e.code ? e.code : String(e && e.message ? e.message : e);
    }
    if (!ent.exists) this.map.delete(key);
    while (this.map.size > 1 && (this.map.size > this.max || (this.maxBytes !== Infinity && this.storedBytes() > this.maxBytes))) {
      this.map.delete(this.map.keys().next().value);
    }
    return ent;
  }

  reset(ent) {
    ent.lines = [];
    ent.invalid = 0;
    ent.offset = 0;
    ent.bytes = 0;
    ent.generation++;
  }

  parse(text, ent) {
    for (let line of text.split('\n')) {
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      line = line.trim();
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch (_) {
        ent.invalid++;
        continue;
      }
      this.accept(o, ent);
    }
  }

  accept(o, ent) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      ent.invalid++;
      return;
    }
    sequence++;
    if (this.onRead) this.onRead(o, sequence);
    ent.lines.push(o);
  }

  async update(ent) {
    let st;
    try {
      st = await withRetries(() => fsp.stat(ent.file));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        if (ent.exists) this.reset(ent);
        ent.exists = false;
        return;
      }
      throw e;
    }
    ent.exists = true;
    if (ent.gz) {
      if (st.size === ent.size && st.mtimeMs === ent.mtime) return;
      this.reset(ent);
      const buf = await withRetries(() => fsp.readFile(ent.file));
      try {
        const text = zlib.gunzipSync(buf);
        ent.bytes = text.length;
        this.parse(text.toString('utf8'), ent);
      } catch (_) {
        ent.invalid++;
      }
      ent.size = st.size;
      ent.mtime = st.mtimeMs;
      return;
    }
    if (ent.ino !== null && (st.ino !== ent.ino || st.birthtimeMs !== ent.birth || st.size < ent.offset)) this.reset(ent);
    ent.ino = st.ino;
    ent.birth = st.birthtimeMs;
    if (st.size === ent.offset) return;
    const fh = await withRetries(() => fsp.open(ent.file, 'r'));
    try {
      const want = st.size - ent.offset;
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, ent.offset + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      const data = buf.subarray(0, got);
      const nl = data.lastIndexOf(0x0a);
      let consumed = 0;
      if (nl >= 0) {
        this.parse(data.subarray(0, nl).toString('utf8'), ent);
        consumed = nl + 1;
      }
      if (consumed < data.length) {
        // End without \n: only enters if it is already a complete JSON; otherwise it is still being written.
        const rest = data.subarray(consumed).toString('utf8').replace(/^﻿/, '').trim();
        let o = null;
        if (rest) {
          try { o = JSON.parse(rest); } catch (_) { o = null; }
        }
        if (!rest || o !== null) {
          if (o !== null) this.accept(o, ent);
          consumed = data.length;
        }
      }
      ent.offset += consumed;
      ent.bytes = ent.offset;
    } finally {
      await fh.close();
    }
  }
}

// ---------- incremental raw log index ----------
//
// The raw log may have many MB per day and per agent. Instead of keeping the lines, each file becomes a
// compact index (columns in typed arrays): ts, position and size of the line in the file, session and
// marks (has flow_id; is a prompt), plus the flow_id → lines map and the map of flow ids cited in
// prompts. Reading is incremental (only the new bytes) and the chosen lines are re-read from disk by
// position when answering. LRU cache by number of indexed lines.

const MARK_FLOW = 1;   // the line has flow_id
const MARK_PROMPT = 2; // UserPromptSubmit with a text prompt
const RE_CITED_FLOW = /F-\d{8}-\d+/g;

class Columns {
  constructor() {
    this.n = 0;
    this.cap = 0;
    this.t = new Float64Array(0);
    this.off = new Float64Array(0);
    this.len = new Uint32Array(0);
    this.seq = new Uint32Array(0);
    this.ses = new Uint32Array(0);
    this.mark = new Uint8Array(0);
  }

  grow() {
    const cap = Math.max(256, this.cap * 2);
    for (const [k, Type] of [['t', Float64Array], ['off', Float64Array], ['len', Uint32Array], ['seq', Uint32Array], ['ses', Uint32Array], ['mark', Uint8Array]]) {
      const next = new Type(cap);
      next.set(this[k].subarray(0, this.n));
      this[k] = next;
    }
    this.cap = cap;
  }

  push(t, off, len, seq, ses, mark) {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.t[i] = t;
    this.off[i] = off;
    this.len[i] = len;
    this.seq[i] = seq;
    this.ses[i] = ses;
    this.mark[i] = mark;
    return i;
  }
}

class RawIndex {
  constructor({ maxLines = 3e6, maxFiles = 2000 } = {}) {
    this.maxLines = maxLines;
    this.maxFiles = maxFiles;
    this.map = new Map();
  }

  storedLines() {
    let n = 0;
    for (const e of this.map.values()) n += e.col.n;
    return n;
  }

  create(file) {
    return {
      file, exists: false, gz: /\.gz$/i.test(file), ino: null, birth: null, offset: 0, size: -1, mtime: -1,
      col: new Columns(), byFlow: new Map(), cited: new Map(), sessions: [''], sessionId: new Map([['', 0]]),
      gzData: null, invalid: 0, error: null, pending: false, queue: Promise.resolve(),
    };
  }

  reset(ent) {
    Object.assign(ent, { offset: 0, col: new Columns(), byFlow: new Map(), cited: new Map(), sessions: [''], sessionId: new Map([['', 0]]), gzData: null, invalid: 0 });
  }

  /**
   * Updates the file's index. budget: {left, read} in bytes; if the new bytes do not fit and something was
   * already read in this request, the file waits (ent.pending = true).
   */
  async read(file, budget) {
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    let ent = this.map.get(key);
    if (ent) this.map.delete(key);
    else ent = this.create(file);
    this.map.set(key, ent);
    const task = ent.queue.then(() => this.update(ent, budget));
    ent.queue = task.catch(() => {});
    try {
      await task;
      ent.error = null;
    } catch (e) {
      ent.error = e && e.code ? e.code : String(e && e.message ? e.message : e);
    }
    if (!ent.exists) this.map.delete(key);
    while (this.map.size > 1 && (this.map.size > this.maxFiles || this.storedLines() > this.maxLines)) {
      const k = this.map.keys().next().value;
      if (k === key) break;
      this.map.delete(k);
    }
    return ent;
  }

  index(buf, base, ent) {
    let start = 0;
    while (start < buf.length) {
      let end = buf.indexOf(0x0a, start);
      if (end < 0) end = buf.length;
      this.indexLine(buf, start, end, base, ent);
      start = end + 1;
    }
  }

  indexLine(buf, start, end, base, ent) {
    const text = buf.toString('utf8', start, end).replace(/^﻿/, '').trim();
    if (!text) return;
    let o;
    try {
      o = JSON.parse(text);
    } catch (_) {
      ent.invalid++;
      return;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      ent.invalid++;
      return;
    }
    const t = Date.parse(o.ts);
    const flow = typeof o.flow_id === 'string' && o.flow_id ? o.flow_id : null;
    const prompt = o.hook_event === 'UserPromptSubmit' && typeof o.prompt === 'string';
    let ses = 0;
    if (typeof o.session === 'string' && o.session) {
      ses = ent.sessionId.get(o.session);
      if (ses === undefined) {
        ses = ent.sessions.length;
        ent.sessions.push(o.session);
        ent.sessionId.set(o.session, ses);
      }
    }
    sequence++;
    const i = ent.col.push(Number.isFinite(t) ? t : 0, base + start, end - start, sequence, ses, (flow || o.flow_id ? MARK_FLOW : 0) | (prompt ? MARK_PROMPT : 0));
    if (flow) {
      if (!ent.byFlow.has(flow)) ent.byFlow.set(flow, []);
      ent.byFlow.get(flow).push(i);
    }
    if (prompt) {
      for (const id of new Set(o.prompt.match(RE_CITED_FLOW) || [])) {
        if (!ent.cited.has(id)) ent.cited.set(id, []);
        ent.cited.get(id).push(i);
      }
    }
  }

  async update(ent, budget) {
    ent.pending = false;
    let st;
    try {
      st = await withRetries(() => fsp.stat(ent.file));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        if (ent.exists) this.reset(ent);
        ent.exists = false;
        return;
      }
      throw e;
    }
    ent.exists = true;
    const fits = (n) => !budget || budget.read === 0 || n <= budget.left;
    const spend = (n) => {
      if (!budget) return;
      budget.left -= n;
      budget.read += n;
    };
    if (ent.gz) {
      if (st.size === ent.size && st.mtimeMs === ent.mtime) return;
      if (!fits(st.size * 8)) {
        ent.pending = true;
        return;
      }
      this.reset(ent);
      const buf = await withRetries(() => fsp.readFile(ent.file));
      try {
        ent.gzData = zlib.gunzipSync(buf);
        spend(ent.gzData.length);
        this.index(ent.gzData, 0, ent);
      } catch (_) {
        ent.gzData = null;
        ent.invalid++;
      }
      ent.size = st.size;
      ent.mtime = st.mtimeMs;
      return;
    }
    if (ent.ino !== null && (st.ino !== ent.ino || st.birthtimeMs !== ent.birth || st.size < ent.offset)) this.reset(ent);
    ent.ino = st.ino;
    ent.birth = st.birthtimeMs;
    if (st.size === ent.offset) return;
    const want = st.size - ent.offset;
    if (!fits(want)) {
      ent.pending = true;
      return;
    }
    const fh = await withRetries(() => fsp.open(ent.file, 'r'));
    try {
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, ent.offset + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      spend(got);
      const data = buf.subarray(0, got);
      const nl = data.lastIndexOf(0x0a);
      let consumed = 0;
      if (nl >= 0) {
        this.index(data.subarray(0, nl), ent.offset, ent);
        consumed = nl + 1;
      }
      if (consumed < data.length) {
        // End without \n: only enters if it is already a complete JSON; otherwise it is still being written.
        const rest = data.subarray(consumed).toString('utf8').replace(/^﻿/, '').trim();
        let complete = !rest;
        if (rest) {
          try { JSON.parse(rest); complete = true; } catch (_) { complete = false; }
        }
        if (complete) {
          if (rest) this.indexLine(data, consumed, data.length, ent.offset, ent);
          consumed = data.length;
        }
      }
      ent.offset += consumed;
    } finally {
      await fh.close();
    }
  }

  /** Re-reads the requested lines (file indexes) and returns the objects with _t and _seq. */
  async materialize(ent, indexes) {
    const out = new Map();
    if (!indexes.length) return out;
    const col = ent.col;
    const build = (text, i) => {
      let o;
      try { o = JSON.parse(text.replace(/^﻿/, '')); } catch (_) { return; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      Object.defineProperties(o, { _t: { value: col.t[i] }, _seq: { value: col.seq[i] } });
      out.set(i, o);
    };
    if (ent.gz) {
      if (ent.gzData) for (const i of indexes) build(ent.gzData.toString('utf8', col.off[i], col.off[i] + col.len[i]), i);
      return out;
    }
    let fh;
    try {
      fh = await withRetries(() => fsp.open(ent.file, 'r'));
    } catch (_) {
      return out;
    }
    try {
      for (const i of [...indexes].sort((a, b) => col.off[a] - col.off[b])) {
        const buf = Buffer.allocUnsafe(col.len[i]);
        const { bytesRead } = await fh.read(buf, 0, col.len[i], col.off[i]);
        build(buf.toString('utf8', 0, bytesRead), i);
      }
    } finally {
      await fh.close();
    }
    return out;
  }
}

function prepareEvent(ev, seq) {
  const t = Date.parse(ev.ts);
  let day = null;
  if (typeof ev.ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?-03:00$/.test(ev.ts)) day = ev.ts.slice(0, 10);
  else if (Number.isFinite(t)) day = spDay(t);
  Object.defineProperties(ev, {
    _t: { value: Number.isFinite(t) ? t : 0 },
    _day: { value: day },
    _seq: { value: seq },
  });
}

function searchText(ev) {
  if (ev._search === undefined) {
    const parts = [ev.resumo, ev.direcao, ev.fluxo_id].filter((x) => typeof x === 'string');
    Object.defineProperty(ev, '_search', { value: normalizeSearch(parts.join('\n')) });
  }
  return ev._search;
}

// ---------- access to the files under MAESTRO_DIR ----------

class Data {
  constructor(maestroDir) {
    this.dir = maestroDir;
    this.p = {
      agents: path.join(maestroDir, LEGACY.agents),
      events: path.join(maestroDir, LEGACY.events),
      pendingDecisions: path.join(maestroDir, LEGACY.pendingDecisions),
      flowCounter: path.join(maestroDir, LEGACY.flowCounter),
      raw: path.join(maestroDir, 'logs', 'raw'),
      usage: path.join(maestroDir, 'state', 'usage.json'),
      pid: path.join(maestroDir, 'state', 'panel.pid'),
    };
    this.eventReader = new JsonlReader({ onRead: prepareEvent });
    // Raw log: a compact index per file (the lines are re-read from disk only when chosen).
    this.rawIndex = new RawIndex({ maxLines: RAW_MAX_INDEX_LINES });
    this.fileCache = new Map();
    this.listCache = new Map();
    this.tailCache = new Map();
    this.ascCache = new WeakMap();
  }

  /** Reads a file with a cache by (ino, size, mtime). kind "json" → {exists, data, error}; "text" → {exists, text, error}. */
  async file(file, kind) {
    let st;
    try {
      st = await withRetries(() => fsp.stat(file));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        this.fileCache.delete(file);
        return { exists: false, data: null, text: null, error: null };
      }
      return { exists: true, data: null, text: null, error: { code: 'read_failed', detail: e.code || e.message } };
    }
    const key = `${kind}:${st.ino}:${st.size}:${st.mtimeMs}`;
    const c = this.fileCache.get(file);
    if (c && c.key === key) return c.value;
    let value;
    if (kind === 'json') {
      value = await readJson(file);
    } else {
      try {
        const text = await readText(file);
        value = { exists: text !== null, text, error: null };
      } catch (e) {
        value = { exists: true, text: null, error: { code: 'read_failed', detail: e.code || e.message } };
      }
    }
    if (!value.error) this.fileCache.set(file, { key, value });
    return value;
  }

  json(file) {
    return this.file(file, 'json');
  }

  text(file) {
    return this.file(file, 'text');
  }

  async listMonths() {
    let names = [];
    try {
      names = await withRetries(() => fsp.readdir(this.p.events));
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
    }
    const files = [];
    for (const n of names) {
      const m = /^(\d{4}-\d{2})\.jsonl(\.gz)?$/i.exec(n);
      if (m) files.push({ month: m[1], gz: !!m[2], file: path.join(this.p.events, n) });
    }
    return files.sort((a, b) => a.month.localeCompare(b.month) || (a.gz ? -1 : 1));
  }

  /** Events ("recent" = the 2 most recent months; "all"), from the most recent to the oldest. */
  async events(scope) {
    const files = await this.listMonths();
    let target = files;
    if (scope === 'recent') {
      const months = [...new Set(files.map((a) => a.month))].slice(-2);
      target = files.filter((a) => months.includes(a.month));
    }
    const ents = [];
    for (const a of target) ents.push(await this.eventReader.read(a.file));
    const version = ents.map((e) => `${e.file}#${e.generation}#${e.lines.length}#${e.invalid}`).join('|');
    const c = this.listCache.get(scope);
    if (c && c.version === version) return c;
    const seen = new Set();
    const list = [];
    const warnings = [];
    for (const e of ents) {
      // Without a valid id (text in the id format) the event does not open in the modal nor enters the navigation: left out.
      let noId = 0;
      for (const ev of e.lines) {
        if (typeof ev.id !== 'string' || !RE_ID.test(ev.id)) {
          noId++;
          continue;
        }
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        list.push(ev);
      }
      const unreadable = e.invalid + noId;
      if (unreadable) warnings.push({ code: 'event_lines_ignored', file: relative(this.dir, e.file), count: unreadable });
      if (e.error) warnings.push({ code: 'event_file_incomplete', file: relative(this.dir, e.file), error: e.error });
    }
    list.sort((a, b) => b._t - a._t || b._seq - a._seq);
    const r = { version, list, warnings };
    this.listCache.set(scope, r);
    return r;
  }

  /** The same list in ascending order (cached per list). */
  ascending(list) {
    let asc = this.ascCache.get(list);
    if (!asc) {
      asc = list.slice().reverse();
      this.ascCache.set(list, asc);
    }
    return asc;
  }

  async rawFolders() {
    try {
      const items = await withRetries(() => fsp.readdir(this.p.raw, { withFileTypes: true }));
      return items.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
      throw e;
    }
  }

  /** Indexes of the raw log files of a folder on a day (YYYY-MM-DD.jsonl.gz and .jsonl) that exist. */
  async rawIndexes(folder, day, budget) {
    const out = [];
    for (const ext of ['.jsonl.gz', '.jsonl']) {
      const ent = await this.rawIndex.read(path.join(this.p.raw, folder, day + ext), budget);
      if (ent.exists) out.push(ent);
    }
    return out;
  }

  /** ts (ISO -03:00) of the last raw log entry of a folder, reading only the end of the newest file. */
  async lastRaw(folder) {
    const dir = path.join(this.p.raw, folder);
    let names;
    try {
      names = await withRetries(() => fsp.readdir(dir));
    } catch (_) {
      return null;
    }
    const recent = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/i.test(n)).sort().reverse().slice(0, 3);
    for (const n of recent) {
      const ts = await this.lastTs(path.join(dir, n));
      if (ts) return ts;
    }
    return null;
  }

  async lastTs(file) {
    let st;
    try {
      st = await withRetries(() => fsp.stat(file));
    } catch (_) {
      return null;
    }
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const c = this.tailCache.get(file);
    if (c && c.key === key) return c.ts;
    let best = null;
    if (st.size > 0) {
      const size = Math.min(st.size, 256 * 1024);
      const fh = await withRetries(() => fsp.open(file, 'r'));
      try {
        const buf = Buffer.allocUnsafe(size);
        const { bytesRead } = await fh.read(buf, 0, size, st.size - size);
        const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
        // Async hooks may write out of order: the biggest ts among the last valid lines wins.
        let seen = 0;
        for (let i = lines.length - 1; i >= 0 && seen < 50; i--) {
          const l = lines[i].trim();
          if (!l) continue;
          let o;
          try { o = JSON.parse(l); } catch (_) { continue; }
          const t = Date.parse(o && o.ts);
          if (!Number.isFinite(t)) continue;
          seen++;
          if (best === null || t > best) best = t;
        }
      } finally {
        await fh.close();
      }
    }
    const ts = best === null ? null : isoSP(best);
    this.tailCache.set(file, { key, ts });
    return ts;
  }
}

// ---------- health ----------

/**
 * level: green | yellow | red. Rules: an active agent without raw log for more than 24 h (or ever)
 * → yellow; unreadable state files → yellow. Each reason is a code with parameters.
 */
function computeHealth({ hooks, problems = [] }) {
  let level = 0;
  const reasons = [];
  const raise = (n, reason) => {
    level = Math.max(level, n);
    reasons.push(reason);
  };
  for (const p of problems) raise(1, p);
  for (const h of hooks) {
    if (!h.active) continue;
    if (!h.last_raw) raise(1, { code: 'hook_never', agent: h.agent, name: h.name });
    else if (h.age_min !== null && h.age_min * MIN_MS > RAW_STALE_MS) raise(1, { code: 'hook_stale', agent: h.agent, name: h.name, minutes: h.age_min });
  }
  return { level: ['green', 'yellow', 'red'][level], reasons };
}

// ---------- building the answers ----------

/** Event as shown in the table: the table fields, with English names. */
function tableFields(ev) {
  const r = {};
  for (const k of TABLE_FIELDS) r[k] = ev[k] === undefined ? null : ev[k];
  r.precisa_dono = ev.precisa_dono === true;
  r.origem = ev.origem === undefined ? null : ev.origem;
  if (ev.teste === true) r.teste = true;
  return eventToApi(r);
}

/** Plan of usage.json checked against the current clock (age and windows that already reset). */
function planNow(plan, t) {
  const p = Object.assign({}, plan);
  p.age_min = ageMin(p.updated_at, t);
  for (const [pct, reset, reason, window] of [['window_5h_pct', 'reset_5h', 'window_5h_reason', '5h'], ['weekly_pct', 'weekly_reset', 'weekly_reason', 'weekly']]) {
    const r = Date.parse(p[reset]);
    if (typeof p[pct] === 'number' && Number.isFinite(r) && r <= t) {
      p[pct] = null;
      p[reason] = { code: 'window_reset_since_read', window, reset_at: isoSP(r) };
    }
  }
  if (p.available && typeof p.window_5h_pct !== 'number' && typeof p.weekly_pct !== 'number') {
    p.available = false;
    p.reason = p.reason || ((p.window_5h_reason || p.weekly_reason)
      ? { code: 'plan_windows_unavailable', window_5h_reason: p.window_5h_reason || null, weekly_reason: p.weekly_reason || null }
      : { code: 'plan_no_pct' });
  }
  return p;
}

/** Copy of usage.json without items that are not objects in by_agent.<period>. */
function cleanUsage(usage) {
  if (!usage || !obj(usage.by_agent)) return usage;
  const ba = {};
  for (const [k, v] of Object.entries(usage.by_agent)) ba[k] = Array.isArray(v) ? v.filter((x) => obj(x)) : v;
  return Object.assign({}, usage, { by_agent: ba });
}

function usageLine(usage, slug, period) {
  const list = usage && obj(usage.by_agent) && Array.isArray(usage.by_agent[period]) ? usage.by_agent[period] : [];
  const l = list.find((x) => x && x.agent === slug);
  if (!l) return { consumption_pct: 0, relative_consumption: 0, estimated_plan_pct: null, input: 0, output: 0, cache_write: 0, cache_read: 0, messages: 0 };
  const r = Object.assign({}, l);
  delete r.agent;
  delete r.registered;
  return r;
}

function flowRecord(data, id) {
  const d = obj(data);
  if (!d) return null;
  const norm = (x) => (typeof x === 'string' ? { titulo: x } : obj(x) ? x : null);
  if (Array.isArray(d.fluxos)) return norm(d.fluxos.find((x) => x && (x.id === id || x.fluxo_id === id)));
  if (obj(d.fluxos) && d.fluxos[id] !== undefined) return norm(d.fluxos[id]);
  if (d[id] !== undefined) return norm(d[id]);
  return null;
}

function flowInfo(counter, id, flowEvents) {
  const rec = flowRecord(counter, id);
  if (!rec && !flowEvents.length) return null;
  const first = flowEvents[0] || null;
  return {
    id,
    title: rec && typeof rec.titulo === 'string' ? rec.titulo : null,
    created_at: (rec && rec.criado_em) || (first ? first.ts : null),
    agent: (rec && rec.agente) || (first ? first.agente : null),
  };
}

/** Origin of a raw prompt by the delegation envelopes ([PEDIDO], [AVISO], [ROTINA]...). */
function promptOrigin(text, byName) {
  const t = String(text || '');
  if (/^\s*\[ROTINA\]/i.test(t)) return 'rotina';
  if (/^\s*\[(PEDIDO|AVISO|RESPOSTA|COBRAN[CÇ]A)\]/i.test(t)) {
    const from = /De:\s*([^\n→]+?)\s*(?:→|->|\n|$)/.exec(t);
    if (from) {
      const name = from[1].trim();
      const slug = byName.get(normalizeSearch(name)) || name;
      return slug === 'cerebro' ? 'cerebro' : `agente:${slug}`;
    }
  }
  return 'dono-direto';
}

function neighbors(asc, ev) {
  // Only events with a valid text id (those that open at /api/event/<id>) are neighbors.
  const valid = (e) => typeof e.id === 'string' && RE_ID.test(e.id);
  const visible = asc.filter((e) => e === ev || (valid(e) && (ev.teste === true || e.teste !== true)));
  const i = visible.indexOf(ev);
  return {
    previous_id: i > 0 ? visible[i - 1].id : null,
    next_id: i >= 0 && i < visible.length - 1 ? visible[i + 1].id : null,
  };
}

function formatCommand(l, folder, correlation) {
  const r = {
    ts: l.ts === undefined ? null : l.ts,
    agent: typeof l.agent === 'string' && l.agent ? l.agent : folderAgent(folder),
    hook_event: l.hook_event === undefined ? null : l.hook_event,
    tool: l.tool === undefined ? null : l.tool,
    input: l.input === undefined ? null : l.input,
    ok: typeof l.ok === 'boolean' ? l.ok : null,
    session: l.session === undefined ? null : l.session,
    flow_id: l.flow_id === undefined ? null : l.flow_id,
    correlation,
  };
  if (l.error !== undefined) r.error = l.error;
  if (l.duration_ms !== undefined) r.duration_ms = l.duration_ms;
  if (l.agent_type !== undefined) r.agent_type = l.agent_type;
  if (typeof l.prompt === 'string') r.prompt = truncate(l.prompt, 2000);
  return r;
}

// ---------- context (data + collector) ----------

function createContext(cfg) {
  const ctx = {
    cfg,
    data: new Data(cfg.maestroDir),
    items: itemsApi.createItemsSource(cfg.env),
    port: cfg.port,
    allowedHosts: new Set(),
    allowedOrigins: new Set(),
    currentRun: null,
    lastRun: null,
    now: () => (cfg.fixedNow ? new Date(cfg.fixedNow.getTime()) : new Date()),
    // Server terminal messages are for people: Portuguese (ADR 0004).
    log: (msg) => {
      try {
        const h = isoSP(new Date()).slice(11, 19);
        process.stdout.write(`[${h}] ${msg}\n`);
      } catch (_) { /* terminal closed */ }
    },
    logError: (msg) => {
      try {
        const h = isoSP(new Date()).slice(11, 19);
        process.stderr.write(`[${h}] ${msg}\n`);
      } catch (_) { /* terminal closed */ }
    },
  };
  ctx.setPort = (port) => {
    ctx.port = port;
    ctx.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    ctx.allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  };
  ctx.setPort(cfg.port);
  /** Runs the usage collector; calls during a collection wait for the same collection. */
  ctx.runCollector = (trigger) => {
    if (ctx.currentRun) return ctx.currentRun;
    const p = (async () => {
      await null;
      const startedAt = Date.now();
      try {
        const usage = await collector.collect({
          maestroDir: cfg.maestroDir,
          maestriDataDir: cfg.env.MAESTRI_DATA_DIR,
          claudeDir: cfg.env.CLAUDE_CONFIG_DIR,
          env: cfg.env,
          now: ctx.now(),
          write: true,
        });
        ctx.lastRun = { at: isoSP(new Date()), trigger, ok: true, duration_ms: Date.now() - startedAt, error: null };
        if (trigger !== 'periodic') {
          const pl = usage.plan;
          const plan = pl.available ? `plano 5 h ${pl.window_5h_pct ?? '—'}% · semanal ${pl.weekly_pct ?? '—'}%` : 'plano indisponível';
          ctx.log(`Uso coletado (${trigger}): ${plan} · ${usage.collection.sessions} sessão(ões) com dono · ${ctx.lastRun.duration_ms} ms`);
        }
      } catch (e) {
        ctx.lastRun = { at: isoSP(new Date()), trigger, ok: false, duration_ms: Date.now() - startedAt, error: e && e.message ? e.message : String(e) };
        ctx.logError(`Falha no coletor de uso (${trigger}): ${e && e.stack ? e.stack : e}`);
      } finally {
        ctx.currentRun = null;
      }
      return ctx.lastRun;
    })();
    ctx.currentRun = p;
    return p;
  };
  return ctx;
}

// ---------- GET /api/state ----------

async function buildState(ctx) {
  const { data, cfg } = ctx;
  const now = ctx.now();
  const t = now.getTime();
  const today = spDay(now);
  const warnings = [];
  const problems = [];

  const [reg, evs, pend, counter, usageFile] = await Promise.all([
    data.json(data.p.agents), data.events('recent'), data.json(data.p.pendingDecisions),
    data.json(data.p.flowCounter), data.json(data.p.usage),
  ]);

  // Registry (old model)
  const registry = obj(reg.data) || {};
  if (!reg.exists) problems.push({ code: 'registry_missing', file: LEGACY.agents });
  else if (reg.error) problems.push({ code: 'file_unreadable', file: LEGACY.agents, error: reg.error });
  const defaults = obj(registry.padrao) || {};
  const ws = obj(registry.workspace) || {};
  const agentList = arr(registry.agentes).filter((a) => obj(a) && typeof a.slug === 'string' && a.slug);
  const workspace = { id: ws.id || null, name: ws.nome || 'Workspace', root: ws.raiz || path.dirname(cfg.maestroDir).replace(/\\/g, '/') };

  // Events (tests stay out)
  warnings.push(...evs.warnings);
  const events = evs.list.filter((e) => e.teste !== true);
  const lastByFlow = new Map();
  for (const e of events) if (e.fluxo_id && !lastByFlow.has(e.fluxo_id)) lastByFlow.set(e.fluxo_id, e);
  const open = new Set([...lastByFlow].filter(([, e]) => OPEN_RESULTS.has(e.resultado)).map(([f]) => f));
  const openByAgent = new Map();
  for (const e of events) {
    if (!e.fluxo_id || !open.has(e.fluxo_id)) continue;
    if (!openByAgent.has(e.agente)) openByAgent.set(e.agente, new Set());
    openByAgent.get(e.agente).add(e.fluxo_id);
  }

  // Usage
  const usage = cleanUsage(obj(usageFile.data));
  const usageUnreadable = { code: 'file_unreadable', file: 'state/usage.json', error: usageFile.error || { code: 'unexpected_format' } };
  if (usageFile.exists && !usage) warnings.push(usageUnreadable);
  const plan = usage && obj(usage.plan) ? planNow(usage.plan, t) : null;
  const kUsage = plan
    ? {
      available: !!plan.available, window_5h_pct: typeof plan.window_5h_pct === 'number' ? plan.window_5h_pct : null,
      reset_5h: plan.reset_5h || null, weekly_pct: typeof plan.weekly_pct === 'number' ? plan.weekly_pct : null,
      weekly_reset: plan.weekly_reset || null, age_min: plan.age_min, updated_at: plan.updated_at || null,
      reason: plan.available ? null : plan.reason || null, window_5h_reason: plan.window_5h_reason || null,
      weekly_reason: plan.weekly_reason || null, source: plan.source || null, collected_at: usage.collected_at || null,
    }
    : {
      available: false, window_5h_pct: null, reset_5h: null, weekly_pct: null, weekly_reset: null, age_min: null,
      updated_at: null, window_5h_reason: null, weekly_reason: null, source: null, collected_at: null,
      reason: usageFile.exists ? { ...usageUnreadable, code: 'usage_unreadable' } : { code: 'collector_not_run' },
    };
  const usageAnswer = usage ? Object.assign({}, usage, { plan: plan || usage.plan }) : null;

  // Agents and hooks
  const agents = [];
  const hooks = [];
  for (const a of agentList) {
    const folder = agentFolder(a.slug);
    const lastRaw = folder ? await data.lastRaw(folder) : null;
    hooks.push({ agent: a.slug, name: a.nome || a.slug, active: a.status === 'ativo', last_raw: lastRaw, age_min: ageMin(lastRaw, t) });
    const last = events.find((e) => e.agente === a.slug) || null;
    agents.push({
      slug: a.slug, name: a.nome || a.slug, type: a.tipo || null, color: a.cor || null,
      responsibility: a.responsabilidade || null, status: a.status || null,
      model: a.modelo || defaults.modelo || null, effort: a.nivel || defaults.nivel || null,
      skills: arr(a.skills), connected_to: arr(a.conectado_a), since: a.desde || null, remark: a.observacao || null,
      terminal_id: typeof a.terminal_id === 'string' && a.terminal_id ? a.terminal_id : null,
      last_event: last ? { id: last.id || null, ts: last.ts || null, summary: last.resumo || null, type: last.tipo || null, result: last.resultado || null, flow_id: last.fluxo_id || null } : null,
      events_today: events.reduce((n, e) => n + (e.agente === a.slug && e._day === today ? 1 : 0), 0),
      open_flows: (openByAgent.get(a.slug) || new Set()).size,
      last_raw: lastRaw,
      usage: usage ? { window_5h: usageLine(usage, a.slug, 'window_5h'), today: usageLine(usage, a.slug, 'today'), '7d': usageLine(usage, a.slug, '7d') } : null,
    });
  }
  const known = new Set(agentList.map((a) => agentFolder(a.slug)));
  for (const folder of await data.rawFolders()) {
    // Folders starting with "_" or "." are archives (e.g. _reassigned-desconhecido-x): not agents.
    if (known.has(folder) || /^[._]/.test(folder)) continue;
    const lr = await data.lastRaw(folder);
    hooks.push({ agent: folderAgent(folder), name: folderAgent(folder), active: false, registered: false, last_raw: lr, age_min: ageMin(lr, t) });
  }

  // Pending decisions (old model; tests stay out)
  const pd = pend.data;
  const allPending = Array.isArray(pd) ? pd : obj(pd) && Array.isArray(pd.pendencias) ? pd.pendencias : null;
  if (pend.exists && !allPending) problems.push({ code: 'file_unreadable', file: LEGACY.pendingDecisions, error: pend.error || { code: 'missing_list', list: 'pendencias' } });
  const valid = arr(allPending).filter((p) => obj(p) && p.teste !== true);
  const severityName = (p) => (SEVERITY_ORDER.has(p.severidade) ? p.severidade : 'normal');
  const severity = (p) => SEVERITY_ORDER.get(severityName(p));
  const time = (v) => {
    const x = Date.parse(v);
    return Number.isFinite(x) ? x : 0;
  };
  const group = (p) => (!p.status || p.status === 'aberta' ? 0 : p.status === 'respondida' ? 1 : 2);
  const active = valid.filter((p) => group(p) < 2)
    .sort((a, b) => group(a) - group(b) || severity(a) - severity(b) || time(a.aberta_em) - time(b.aberta_em) || String(a.id).localeCompare(String(b.id)));
  const closed = valid.filter((p) => group(p) === 2)
    .sort((a, b) => time(b.resolvida_em || b.atualizada_em || b.aberta_em) - time(a.resolvida_em || a.atualizada_em || a.aberta_em))
    .slice(0, CLOSED_LIMIT);
  const pendingDecisions = [...active, ...closed].map((p) => Object.assign(pendingDecisionToApi(p), { age_min: ageMin(p.aberta_em, t) }));
  const kPending = { total: 0, by_severity: { critica: 0, alta: 0, normal: 0, baixa: 0 } };
  for (const p of valid) {
    if (group(p) !== 0) continue;
    kPending.total++;
    kPending.by_severity[severityName(p)]++;
  }

  if (counter.exists && counter.error) warnings.push({ code: 'file_unreadable', file: LEGACY.flowCounter, error: counter.error });

  // Health
  const base = computeHealth({ hooks, problems });
  const lastEvent = events[0] || null;
  const health = {
    level: base.level,
    reasons: base.reasons,
    last_event_age_min: lastEvent ? ageMin(lastEvent.ts, t) : null,
    usage_age_min: kUsage.age_min,
    hooks,
    wire: false,
  };

  return {
    generated_at: isoSP(now),
    workspace,
    health,
    kpis: { pending_decisions: kPending, usage: kUsage },
    agents,
    pending_decisions: pendingDecisions,
    usage: usageAnswer,
    events: events.slice(0, STATE_EVENT_LIMIT).map(tableFields),
    collector: { interval_min: COLLECTOR_INTERVAL_MS / MIN_MS, active: cfg.collectorActive, last: ctx.lastRun, running: !!ctx.currentRun },
    // Pending decision answer through the panel: always written; the notice in the Brain's terminal depends on Maestri.
    answers: { brain_notice: !!(cfg.brainNotice && cfg.brainNotice.active), reason: cfg.brainNotice && !cfg.brainNotice.active ? cfg.brainNotice.reason : null },
    warnings,
  };
}

// ---------- GET /api/events ----------

function parseFilters(sp) {
  const day = (name) => {
    const v = (sp.get(name) || '').trim();
    if (!v) return null;
    if (!validDay(v)) throw new RequestError(400, { code: 'invalid_param', param: name, value: truncate(v, 40), expected: 'date' });
    return v;
  };
  const set = (name, lower) => {
    const v = (sp.get(name) || '').trim();
    if (!v) return null;
    return new Set(v.split(',').map((x) => (lower ? x.trim().toLowerCase() : x.trim())).filter(Boolean));
  };
  const integer = (name, fallback, max) => {
    const v = (sp.get(name) || '').trim();
    if (!v) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new RequestError(400, { code: 'invalid_param', param: name, value: truncate(v, 20), expected: 'positive_integer' });
    return Math.min(n, max);
  };
  const yes = (name) => ['1', 'true'].includes((sp.get(name) || '').trim().toLowerCase());
  // Search: every word must show up (in any order), ignoring case and accents.
  const terms = normalizeSearch(sp.get('q') || '').split(/\s+/).filter(Boolean).slice(0, 20);
  return {
    since: day('since'), until: day('until'), hours: integer('hours', null, 24 * 366),
    agent: set('agent', false), project: set('project', true), type: set('type', false),
    result: set('result', false), flow: (sp.get('flow') || '').trim() || null,
    q: terms.length ? terms : null, ownerOnly: yes('owner_only'), includeTests: yes('include_tests'),
    page: integer('page', 1, 1e6), perPage: integer('per_page', 50, 500),
  };
}

/**
 * Filtered and paged events, with the counts of the whole filtered set (no paging).
 * hours=N: only the last N hours (besides since/until). agent, project, type and result accept many
 * comma-separated values. In the counts, each facet ignores its own filter (the chips show what can be
 * chosen) and needs_owner ignores owner_only (it is what "only what needs me" would show).
 */
async function listEvents(ctx, sp) {
  const f = parseFilters(sp);
  const { list } = await ctx.data.events('all');
  const sinceT = f.hours ? ctx.now().getTime() - f.hours * 3600000 : null;
  const groups = { result: new Map(), agent: new Map(), project: new Map(), type: new Map() };
  const count = (g, key) => { if (typeof key === 'string' && key) g.set(key, (g.get(key) || 0) + 1); };
  let needsOwner = 0;
  const filtered = [];
  for (const e of list) {
    if (!f.includeTests && e.teste === true) continue;
    if (f.since && (!e._day || e._day < f.since)) continue;
    if (f.until && (!e._day || e._day > f.until)) continue;
    if (sinceT !== null && !(e._t >= sinceT)) continue;
    if (f.flow && e.fluxo_id !== f.flow) continue;
    if (f.q) {
      const text = searchText(e);
      if (!f.q.every((term) => text.includes(term))) continue;
    }
    const project = String(e.projeto === undefined || e.projeto === null ? '' : e.projeto);
    const needs = e.precisa_dono === true || OWNER_RESULTS.has(e.resultado);
    const okAg = !f.agent || f.agent.has(e.agente);
    const okPr = !f.project || f.project.has(project.toLowerCase());
    const okTy = !f.type || f.type.has(e.tipo);
    const okRe = !f.result || f.result.has(e.resultado);
    const okOw = !f.ownerOnly || needs;
    if (okAg && okPr && okTy && okRe && okOw) filtered.push(e);
    if (okPr && okTy && okRe && okOw) count(groups.agent, e.agente);
    if (okAg && okTy && okRe && okOw) count(groups.project, project.toUpperCase());
    if (okAg && okPr && okRe && okOw) count(groups.type, e.tipo);
    if (okAg && okPr && okTy && okOw) count(groups.result, e.resultado);
    if (okAg && okPr && okTy && okRe && needs) needsOwner++;
  }
  const start = (f.page - 1) * f.perPage;
  return {
    total: filtered.length,
    page: f.page,
    per_page: f.perPage,
    pages: Math.max(1, Math.ceil(filtered.length / f.perPage)),
    events: filtered.slice(start, start + f.perPage).map(tableFields),
    // Object.fromEntries creates own properties: a "__proto__" key coming from the log does not touch the prototype.
    counts: {
      result: Object.fromEntries(groups.result), agent: Object.fromEntries(groups.agent),
      project: Object.fromEntries(groups.project), type: Object.fromEntries(groups.type), needs_owner: needsOwner,
    },
  };
}

// ---------- correlated raw commands ----------

/** Raw log days that may have the flow's commands: from the id's day (or 1st event) − 1 to the last + 1. */
function flowDays(flowId, flowEvents, today) {
  const m = /^F-(\d{4})(\d{2})(\d{2})-/.exec(flowId);
  let start = m && validDay(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  let end = null;
  for (const e of flowEvents) {
    if (!e._day) continue;
    if (!start || e._day < start) start = e._day;
    if (!end || e._day > end) end = e._day;
  }
  if (!start) return [];
  const last = flowEvents[flowEvents.length - 1];
  // Flow still open (or without events): the commands may go on until today.
  end = !end || (last && OPEN_RESULTS.has(last.resultado)) ? today : addDays(end, 1);
  if (end > today) end = today;
  start = addDays(start, -1);
  if (end < start) end = start;
  // Long flow: the eve and the 1st day (initial request) and the most recent days stay; the middle goes.
  const total = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY_MS) + 1;
  let days;
  if (total <= FLOW_DAY_LIMIT) {
    days = listDays(start, end, FLOW_DAY_LIMIT);
  } else {
    const second = addDays(start, 1);
    const recent = [];
    for (let d = end; recent.length < FLOW_DAY_LIMIT - 2 && d > second; d = addDays(d, -1)) recent.push(d);
    days = [start, second, ...recent.reverse()];
  }
  Object.defineProperty(days, 'cut', { value: Math.max(0, total - days.length) });
  return days;
}

/**
 * Window of an event for the commands without flow_id: from the previous event of the same agent (and of
 * the same session, when the event has one) until the event. Without a previous one, since the flow start
 * (if earlier) or 15 min before, like "registrar fluxo". Never more than 6 h.
 */
function eventWindow(ev, asc, flowStart, position) {
  const folder = agentFolder(ev.agente);
  if (!folder || !(ev._t > 0)) return null;
  const session = typeof ev.sessao === 'string' && ev.sessao ? ev.sessao : null;
  let previous = null;
  const here = position && position.has(ev) ? position.get(ev) : asc.indexOf(ev);
  for (let i = here - 1; i >= 0; i--) {
    const e = asc[i];
    if (e.agente !== ev.agente || e._t >= ev._t) continue;
    if (e.teste === true && ev.teste !== true) continue;
    if (session && e.sessao !== session) continue;
    previous = e;
    break;
  }
  let start;
  if (previous) start = previous._t;
  else if (Number.isFinite(flowStart) && flowStart < ev._t) start = flowStart;
  else start = ev._t - WINDOW_NO_PREVIOUS_MS;
  return { folder, start: Math.max(start, ev._t - WINDOW_MAX_MS), end: ev._t, session };
}

/** Flow start: the earliest between the counter's criado_em and the first event. */
function flowStartOf(info, flowEvents) {
  const candidates = [info && Date.parse(info.created_at), flowEvents.length ? flowEvents[0]._t : NaN].filter((x) => Number.isFinite(x) && x > 0);
  return candidates.length ? Math.min(...candidates) : NaN;
}

/**
 * Window where to look for the prompt that brought the request of a "pedido-recebido" event: from the
 * previous event of the same agent (and the same session, when the event has one) until the event itself;
 * without a previous one, the 6 h before it. Does not use the flow start: the id is born AFTER the request.
 */
function requestWindow(ev, asc) {
  const folder = agentFolder(ev.agente);
  if (!folder || !(ev._t > 0)) return null;
  const session = typeof ev.sessao === 'string' && ev.sessao ? ev.sessao : null;
  let start = ev._t - WINDOW_MAX_MS;
  for (let i = asc.indexOf(ev) - 1; i >= 0; i--) {
    const e = asc[i];
    if (e.agente !== ev.agente || e._t >= ev._t) continue;
    if (e.teste === true && ev.teste !== true) continue;
    if (session && e.sessao !== session) continue;
    start = Math.max(start, e._t);
    break;
  }
  // 1 min of slack after the event: the prompt hook is asynchronous and may write a little later.
  return { folder, start, end: ev._t, session, slack: MIN_MS };
}

/**
 * Raw commands of a flow: those with the same flow_id (or prompts that cite the id), from every agent
 * folder, on the flow's days; and those without flow_id that fall in the window of one of the events (same
 * agent and same session). Each comes back with correlation "flow_id" or "window". Reads through the raw
 * log index, with a ceiling of new bytes per request: the files that do not fit wait for the next time
 * and the answer comes marked as incomplete.
 */
async function collectRaw(ctx, { flowId, days = [], windows = [], requestWin = null, reference }) {
  const data = ctx.data;
  const budget = { left: RAW_BYTES_PER_REQUEST, read: 0 };
  // Reading order (matters when the ceiling is hit): windows, request, the flow's 1st day and the rest
  // by closeness to the reference day.
  const tasks = [];
  const seen = new Set();
  const add = (folder, day) => {
    const k = `${folder}|${day}`;
    if (!seen.has(k)) {
      seen.add(k);
      tasks.push({ folder, day });
    }
  };
  for (const w of [...windows, requestWin].filter(Boolean)) {
    for (const d of listDays(spDay(w.start), spDay(w.end + (w.slack || 0)), 3)) add(w.folder, d);
  }
  if (flowId && days.length) {
    const folders = await data.rawFolders();
    const refDay = Number.isFinite(reference) && reference > 0 ? spDay(reference) : days[days.length - 1];
    const dist = (d) => Math.abs(Date.parse(`${d}T12:00:00Z`) - Date.parse(`${refDay}T12:00:00Z`));
    const order = [...days.slice(0, 2), ...days.slice(2).sort((a, b) => dist(a) - dist(b) || (a < b ? 1 : -1))];
    for (const d of order) for (const p of folders) add(p, d);
  }

  const found = new Map(); // ent → Map(i → correlation)
  const mark = (ent, i, correlation) => {
    if (!found.has(ent)) found.set(ent, new Map());
    const m = found.get(ent);
    if (m.get(i) !== 'flow_id') m.set(i, correlation);
  };
  const prompts = [];
  let requestPrompt = null;
  let pending = 0;
  for (const { folder, day } of tasks) {
    const ents = await data.rawIndexes(folder, day, budget);
    const ofFolder = windows.filter((w) => w.folder === folder);
    for (const ent of ents) {
      if (ent.pending) {
        pending++;
        continue;
      }
      const col = ent.col;
      if (flowId) {
        const own = ent.byFlow.get(flowId) || [];
        const cite = new Set(ent.cited.get(flowId) || []);
        for (const i of own) mark(ent, i, 'flow_id');
        for (const i of cite) mark(ent, i, 'flow_id');
        for (const i of new Set([...own, ...cite])) {
          if (col.mark[i] & MARK_PROMPT) prompts.push({ ent, i, folder, brings: cite.has(i) });
        }
      }
      for (const w of ofFolder) {
        const ses = w.session ? ent.sessionId.get(w.session) : null;
        if (ses === undefined) continue;
        for (let i = 0; i < col.n; i++) {
          if (col.mark[i] & MARK_FLOW) continue;
          const t = col.t[i];
          if (t > w.start && t <= w.end && (ses === null || col.ses[i] === ses)) mark(ent, i, 'window');
        }
      }
      if (requestWin && requestWin.folder === folder) {
        const w = requestWin;
        const ses = w.session ? ent.sessionId.get(w.session) : null;
        if (ses !== undefined) {
          const ofFlow = new Set(flowId ? ent.byFlow.get(flowId) || [] : []);
          for (let i = 0; i < col.n; i++) {
            if (!(col.mark[i] & MARK_PROMPT)) continue;
            const t = col.t[i];
            if (!(t > w.start && t <= w.end + w.slack) || (ses !== null && col.ses[i] !== ses)) continue;
            // Prefers the prompt without flow_id (or of the flow itself) closest before the event.
            const clean = !(col.mark[i] & MARK_FLOW) || ofFlow.has(i);
            const before = t <= w.end;
            const score = (clean ? 2 : 0) + (before ? 1 : 0);
            const better = !requestPrompt || score > requestPrompt.score
              || (score === requestPrompt.score && (before ? t > requestPrompt.t : t < requestPrompt.t));
            if (better) requestPrompt = { ent, i, folder, t, score };
          }
        }
      }
    }
  }

  let list = [];
  for (const [ent, m] of found) for (const [i, correlation] of m) list.push({ ent, i, correlation, t: ent.col.t[i], seq: ent.col.seq[i] });
  list.sort((a, b) => a.t - b.t || a.seq - b.seq);
  let omitted = 0;
  if (list.length > COMMAND_LIMIT) {
    omitted = list.length - COMMAND_LIMIT;
    const ref = Number.isFinite(reference) && reference > 0 ? reference : list[list.length - 1].t;
    list = list.slice().sort((a, b) => Math.abs(a.t - ref) - Math.abs(b.t - ref)).slice(0, COMMAND_LIMIT)
      .sort((a, b) => a.t - b.t || a.seq - b.seq);
  }
  // Initial request by the flow: the first prompt that brought the id in its text; otherwise, the flow's first.
  prompts.sort((a, b) => a.ent.col.t[a.i] - b.ent.col.t[b.i] || a.ent.col.seq[a.i] - b.ent.col.seq[b.i]);
  const flowPrompt = prompts.find((p) => p.brings) || prompts[0] || null;

  // Re-reads from disk only the chosen lines.
  const wanted = new Map();
  const want = (ent, i) => {
    if (!wanted.has(ent)) wanted.set(ent, new Set());
    wanted.get(ent).add(i);
  };
  for (const x of list) want(x.ent, x.i);
  for (const p of [flowPrompt, requestPrompt]) if (p) want(p.ent, p.i);
  const read = new Map();
  for (const [ent, set] of wanted) read.set(ent, await data.rawIndex.materialize(ent, [...set]));
  const line = (ent, i) => (read.get(ent) && read.get(ent).get(i)) || null;
  const asRequest = (p) => {
    const l = p && line(p.ent, p.i);
    return l && typeof l.prompt === 'string' ? { l, folder: p.folder, brings: !!p.brings } : null;
  };

  const commands = [];
  for (const x of list) {
    const l = line(x.ent, x.i);
    if (l) commands.push(formatCommand(l, path.basename(path.dirname(x.ent.file)), x.correlation));
  }
  const warnings = [];
  if (days.cut) warnings.push({ code: 'long_flow_days_cut', days: days.length + days.cut, cut: days.cut });
  if (pending) warnings.push({ code: 'raw_files_pending', count: pending });
  return {
    commands,
    truncated: omitted > 0 || warnings.length > 0,
    omitted,
    warnings: warnings.length ? warnings : null,
    flowRequest: asRequest(flowPrompt),
    windowRequest: asRequest(requestPrompt),
  };
}

/**
 * Request that opened the flow. With a "pedido-recebido" event: the text of the raw prompt that brought it
 * (last UserPromptSubmit of the same agent in the window before the event), with the event's origin; without
 * the prompt, the event's pedido/texto field or its summary. Without that event: the raw prompt that brought
 * the flow id (or the flow's first prompt).
 */
function initialRequest(flowEvents, raw, byName) {
  const ev = flowEvents.find((e) => e.tipo === 'pedido-recebido');
  if (ev) {
    const base = { origin: ev.origem || null, agent: ev.agente || null, event_id: ev.id || null };
    const fromEvent = [ev.pedido, ev.texto].find((x) => typeof x === 'string' && x.trim());
    const wr = raw && raw.windowRequest;
    if (!fromEvent && wr && wr.l.prompt.trim()) {
      return Object.assign(base, { text: truncate(wr.l.prompt, 4000), ts: wr.l.ts || ev.ts || null, source: 'event_prompt', session: wr.l.session || null });
    }
    return Object.assign(base, { text: fromEvent || (typeof ev.resumo === 'string' ? ev.resumo : ''), ts: ev.ts || null, source: 'event' });
  }
  const fr = raw && raw.flowRequest;
  if (fr) {
    const l = fr.l;
    return {
      text: truncate(l.prompt, 4000), origin: promptOrigin(l.prompt, byName), ts: l.ts || null,
      agent: typeof l.agent === 'string' && l.agent ? l.agent : folderAgent(fr.folder),
      source: 'prompt', origin_inferred: true,
    };
  }
  return null;
}

async function nameMap(ctx) {
  const reg = await ctx.data.json(ctx.data.p.agents);
  const list = arr(obj(reg.data) && reg.data.agentes).filter((a) => obj(a) && typeof a.slug === 'string');
  return new Map(list.map((a) => [normalizeSearch(a.nome || a.slug), a.slug]));
}

// ---------- GET /api/event/<id> and /api/flow/<id> ----------

async function eventDetail(ctx, id) {
  const { list } = await ctx.data.events('all');
  const ev = list.find((e) => e.id === id);
  if (!ev) return null;
  const asc = ctx.data.ascending(list);
  // Test events only enter the sequence when the event itself is a test.
  const ofFlow = ev.fluxo_id ? asc.filter((e) => e.fluxo_id === ev.fluxo_id && (ev.teste === true || e.teste !== true)) : [ev];
  const today = spDay(ctx.now());
  const counter = await ctx.data.json(ctx.data.p.flowCounter);
  const flow = ev.fluxo_id ? flowInfo(counter.data, ev.fluxo_id, ofFlow) : null;
  // The event's window (commands without flow_id of the same agent and session before it).
  const window = eventWindow(ev, asc, flowStartOf(flow, ofFlow));
  const days = ev.fluxo_id ? flowDays(ev.fluxo_id, ofFlow, today) : [];
  const requestEvent = ofFlow.find((e) => e.tipo === 'pedido-recebido');
  const raw = await collectRaw(ctx, {
    flowId: ev.fluxo_id || null, days, windows: window ? [window] : [],
    requestWin: requestEvent ? requestWindow(requestEvent, asc) : null, reference: ev._t,
  });
  const byName = await nameMap(ctx);
  return Object.assign({
    event: eventToApi(ev),
    flow,
    initial_request: initialRequest(ofFlow, raw, byName),
    sequence: ofFlow.map(eventToApi),
    raw_commands: raw.commands,
    raw_commands_truncated: raw.truncated,
    raw_commands_omitted: raw.omitted,
    raw_commands_warnings: raw.warnings,
    window_without_flow: window ? { start: isoSP(window.start), end: isoSP(window.end), session: window.session } : null,
  }, neighbors(asc, ev));
}

async function flowDetail(ctx, id, sp) {
  const { list } = await ctx.data.events('all');
  const asc = ctx.data.ascending(list);
  const all = asc.filter((e) => e.fluxo_id === id);
  const real = all.filter((e) => e.teste !== true);
  // Tests stay out, unless include_tests=1 or the flow only has test events.
  const includeTests = sp && ['1', 'true'].includes(String(sp.get('include_tests') || '').toLowerCase());
  const events = includeTests || !real.length ? all : real;
  const counter = await ctx.data.json(ctx.data.p.flowCounter);
  const flow = flowInfo(counter.data, id, events);
  if (!flow) return null;
  const today = spDay(ctx.now());
  // Like "registrar fluxo": commands with the flow_id and, without it, those in each event's window.
  const start = flowStartOf(flow, events);
  const position = events.length > 5 ? new Map(asc.map((e, i) => [e, i])) : null;
  const windows = events.map((e) => eventWindow(e, asc, start, position)).filter(Boolean);
  const requestEvent = events.find((e) => e.tipo === 'pedido-recebido');
  const raw = await collectRaw(ctx, {
    flowId: id, days: flowDays(id, events, today), windows,
    requestWin: requestEvent ? requestWindow(requestEvent, asc) : null, reference: null,
  });
  const byName = await nameMap(ctx);
  return {
    flow,
    events: events.map(eventToApi),
    raw_commands: raw.commands,
    raw_commands_truncated: raw.truncated,
    raw_commands_omitted: raw.omitted,
    raw_commands_warnings: raw.warnings,
    initial_request: initialRequest(events, raw, byName),
  };
}

// ---------- HTTP ----------

function respond(req, res, status, body, type, extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const headers = Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Nothing of the panel may be embedded in another site's iframe (clickjacking on Recalculate etc.).
    'X-Frame-Options': 'DENY',
  }, extra);
  if (buf.length > 4096 && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function respondJson(req, res, status, value, extra) {
  respond(req, res, status, JSON.stringify(value), JSON_TYPE, extra);
}

function respondError(req, res, status, error, extra) {
  respondJson(req, res, status, { error }, extra);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FIXED_ROUTES = {
  '/': { name: 'index', methods: ['GET', 'HEAD'] },
  '/api/state': { name: 'state', methods: ['GET', 'HEAD'] },
  '/api/events': { name: 'events', methods: ['GET', 'HEAD'] },
  '/api/recalculate': { name: 'recalculate', methods: ['POST'] },
  '/api/brain': { name: 'brain', methods: ['POST'] },
  '/api/items': { name: 'items', methods: ['GET', 'HEAD'] },
};

function findRoute(urlPath) {
  if (Object.prototype.hasOwnProperty.call(FIXED_ROUTES, urlPath)) return FIXED_ROUTES[urlPath];
  const mi = /^\/api\/items\/([^/]+)\/([^/]+)$/.exec(urlPath);
  if (mi) {
    const it = itemsApi.parseItemPath(mi[1], mi[2]);
    return it ? { name: 'item', methods: ['GET', 'HEAD'], project: it.project, number: it.number } : null;
  }
  const mp = /^\/api\/pending-decisions\/([^/]+)\/answer$/.exec(urlPath);
  if (mp) {
    const pid = pendingApi.normalizeId(mp[1]);
    return pid ? { name: 'pending-decision-answer', methods: ['POST'], id: pid } : null;
  }
  const m = /^\/api\/(event|flow)\/([^/]+)$/.exec(urlPath);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch (_) {
    return null;
  }
  return RE_ID.test(id) ? { name: m[1], methods: ['GET', 'HEAD'], id } : null;
}

async function route(ctx, req, res) {
  // Only the pending decision answer reads the body (up to 16 KB); the rest is discarded, capped at 1 MB.
  let received = 0;
  const parts = [];
  const body = new Promise((resolve) => {
    req.on('data', (c) => {
      received += c.length;
      if (received > 1024 * 1024) req.destroy();
      else if (received <= BODY_LIMIT) parts.push(c);
    });
    req.on('end', () => resolve(received > BODY_LIMIT ? null : Buffer.concat(parts)));
    req.on('close', () => resolve(null));
  });
  req.on('error', () => {});

  const host = String(req.headers.host || '').toLowerCase();
  if (!ctx.allowedHosts.has(host)) return respondError(req, res, 403, { code: 'host_not_allowed', port: ctx.port });
  if (req.method === 'POST') {
    if (req.headers['x-panel'] !== '1') return respondError(req, res, 403, { code: 'missing_panel_header', header: 'X-Panel' });
    const origin = req.headers.origin;
    if (origin !== undefined && !ctx.allowedOrigins.has(String(origin).toLowerCase())) return respondError(req, res, 403, { code: 'origin_not_allowed' });
  }
  const url = String(req.url || '');
  if (!url.startsWith('/') || url.startsWith('//')) return respondError(req, res, 404, { code: 'route_not_found' });
  const q = url.indexOf('?');
  const urlPath = q < 0 ? url : url.slice(0, q);
  const query = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
  const r = findRoute(urlPath);
  if (!r) return respondError(req, res, 404, { code: 'route_not_found' });
  if (!r.methods.includes(req.method)) {
    return respondError(req, res, 405, { code: 'method_not_allowed', method: req.method, allowed: r.methods }, { Allow: r.methods.join(', ') });
  }

  switch (r.name) {
    case 'index': {
      const x = await ctx.data.text(ctx.cfg.indexPath);
      if (!x.exists || typeof x.text !== 'string') {
        // A page for people (Portuguese, ADR 0004): the API JSON never carries sentences.
        const html = `<!doctype html><meta charset="utf-8"><title>Painel</title><p>O arquivo do painel não foi encontrado em ${escapeHtml(ctx.cfg.indexPath.replace(/\\/g, '/'))}.</p>`;
        return respond(req, res, 503, html, HTML_TYPE, { 'Content-Security-Policy': CSP });
      }
      return respond(req, res, 200, x.text, HTML_TYPE, { 'Content-Security-Policy': CSP });
    }
    case 'state':
      return respondJson(req, res, 200, await buildState(ctx));
    case 'events':
      return respondJson(req, res, 200, await listEvents(ctx, query));
    case 'event': {
      const x = await eventDetail(ctx, r.id);
      if (!x) return respondError(req, res, 404, { code: 'event_not_found', id: r.id });
      return respondJson(req, res, 200, x);
    }
    case 'flow': {
      const x = await flowDetail(ctx, r.id, query);
      if (!x) return respondError(req, res, 404, { code: 'flow_not_found', id: r.id });
      return respondJson(req, res, 200, x);
    }
    case 'items': {
      const active = itemsApi.activeFilter(query);
      if (active === undefined) return respondError(req, res, 400, { code: 'invalid_param', param: 'active', value: truncate(query.get('active'), 20), expected: 'flag' });
      return respondJson(req, res, 200, itemsApi.listItems(ctx.items, { active }));
    }
    case 'item': {
      const x = itemsApi.itemDetail(ctx.items, r.project, r.number);
      if (!x) return respondError(req, res, 404, { code: 'item_not_found', project: r.project, number: r.number });
      return respondJson(req, res, 200, x);
    }
    case 'recalculate': {
      const run = await ctx.runCollector('recalculate');
      const state = await buildState(ctx);
      state.recalculation = { ok: !!(run && run.ok), duration_ms: run ? run.duration_ms : null, error: run && !run.ok ? run.error : null };
      return respondJson(req, res, 200, state);
    }
    case 'brain':
      return respondError(req, res, 501, { code: 'not_implemented', feature: 'brain' });
    case 'pending-decision-answer': {
      const buf = await body;
      if (buf === null) return respondError(req, res, 413, { code: 'body_too_large', limit_kb: BODY_LIMIT / 1024 });
      const x = await pendingApi.answerPendingDecision(ctx.cfg, ctx.now(), r.id, buf);
      const n = x.brain_notice;
      ctx.log(`Pendência ${r.id} respondida pelo painel; aviso ao Cérebro: ${n.sent ? `enviado (${n.to})` : `não enviado (${n.reason && n.reason.code})`}`);
      return respondJson(req, res, 200, x);
    }
    default:
      return respondError(req, res, 404, { code: 'route_not_found' });
  }
}

function createHandler(ctx) {
  return (req, res) => {
    route(ctx, req, res).catch((e) => {
      const known = e instanceof RequestError || e instanceof pendingApi.PendingDecisionError;
      const status = known ? e.status : 500;
      if (status === 500) ctx.logError(`Erro em ${req.method} ${String(req.url).slice(0, 200)}: ${e && e.stack ? e.stack : e}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      respondError(req, res, status, known ? e.error : { code: 'internal_error' });
    });
  };
}

// ---------- lifecycle ----------

function readPidSync(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim());
  } catch (_) {
    return null;
  }
}

function removePidSync(file) {
  try {
    if (readPidSync(file) === process.pid) fs.unlinkSync(file);
  } catch (_) { /* already gone */ }
}

/**
 * Starts the server. options: {cfg} or {argv, env}. Returns {server, port, ctx, stop, pidFile}.
 * Registers no signals and does not end the process (that is the command line's job).
 */
async function start(options = {}) {
  const cfg = options.cfg || parseConfig(options.argv || [], options.env || process.env);
  const ctx = createContext(cfg);
  const server = http.createServer({ headersTimeout: 10000, requestTimeout: 30000 }, createHandler(ctx));
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (e) => ctx.logError(`Erro no servidor: ${e && e.message}`));
  ctx.setPort(server.address().port);
  const pidFile = ctx.data.p.pid;
  await writeAtomic(pidFile, `${process.pid}\n`);
  let timer = null;
  if (cfg.collectorActive) {
    ctx.runCollector('startup');
    timer = setInterval(() => ctx.runCollector('periodic'), COLLECTOR_INTERVAL_MS);
  }
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    removePidSync(pidFile);
    ctx.items.close();
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    if (ctx.currentRun) await ctx.currentRun.catch(() => {});
  }
  return { server, port: ctx.port, ctx, stop, pidFile };
}

const HELP = `Uso: node server.js [--port 4777]
  Sobe o painel do workspace em http://127.0.0.1:<porta> (só nesta máquina).
  Parar: Ctrl+C neste terminal, ou taskkill /PID <pid de state/panel.pid> /F
Variáveis: PANEL_PORT, MAESTRO_DIR, MAESTRI_DATA_DIR, CLAUDE_CONFIG_DIR,
  PANEL_COLLECTOR=0 (sem coletor automático).
`;

module.exports = {
  start, parseConfig, computeHealth, buildState, listEvents,
  eventDetail, flowDetail, findRoute, agentFolder, promptOrigin, flowDays, JsonlReader, Data,
  RawIndex, requestWindow, initialRequest, cleanUsage, CSP,
};

if (require.main === module) {
  let cfg;
  try {
    cfg = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`Erro: ${e.message}\n`);
    process.exit(2);
  }
  if (cfg.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  process.on('unhandledRejection', (e) => {
    try { process.stderr.write(`Erro não tratado: ${e && e.stack ? e.stack : e}\n`); } catch (_) { /* nothing */ }
  });
  start({ cfg }).then(({ port, stop, pidFile }) => {
    process.stdout.write(`Painel no ar em http://127.0.0.1:${port} (PID ${process.pid})\n`);
    process.stdout.write(`Dados: ${cfg.maestroDir.replace(/\\/g, '/')} · PID em ${pidFile.replace(/\\/g, '/')}\n`);
    process.stdout.write(`Para parar: Ctrl+C aqui, ou taskkill /PID ${process.pid} /F\n`);
    let leaving = false;
    const leave = (signal) => {
      if (leaving) return;
      leaving = true;
      try { process.stdout.write(`Encerrando o painel (${signal})...\n`); } catch (_) { /* terminal closed */ }
      setTimeout(() => process.exit(0), 3000).unref();
      stop().finally(() => process.exit(0));
    };
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(s, () => leave(s));
    process.on('exit', () => removePidSync(pidFile));
  }).catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
      process.stderr.write(`Erro: a porta ${cfg.port} já está em uso em 127.0.0.1. Outro painel já está rodando? Veja o PID em ${path.join(cfg.maestroDir, 'state', 'panel.pid').replace(/\\/g, '/')} ou suba em outra porta com --port.\n`);
    } else if (e && e.code === 'EACCES') {
      process.stderr.write(`Erro: sem permissão para usar a porta ${cfg.port}.\n`);
    } else {
      process.stderr.write(`Erro ao subir o painel: ${e && e.stack ? e.stack : e}\n`);
    }
    process.exit(1);
  });
}
