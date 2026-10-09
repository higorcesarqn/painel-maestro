'use strict';
/**
 * raw-store.js · the raw log of the new model (ADR 0003): bruto.db in MAESTRO_DIR (next to maestro.db), through the
 * embedded node:sqlite. Written by the Claude Code hook (bin/hook-log.js), read and cleaned by the panel server; its
 * sessions are read by the usage collector (bin/collect-usage.js) to split the tokens by item and by agent (#13).
 *
 *   openRawStore({ dir })                 opens (and creates/migrates) <dir>/bruto.db: WAL, busy_timeout, schema version
 *   openRawStore({ dir, create: false })  null while the file does not exist (the server never creates it)
 *   busyTimeoutMs                         shortens the wait for a busy database (the hook gives up in ~1.5 s)
 *
 * Tables (schema version in PRAGMA user_version):
 *   sessions(session_id, project_id, item_number, task_number, branch, cwd, transcript_path, started_at, seen_at, seen_t)
 *   entries(id, at, t, session_id, project_id, item_number, task_number, branch, hook_event, tool, input, ok,
 *           output_summary, error, duration_ms, prompt, detail, agent_id, agent_type, cwd, version)
 *   meta(key, value)                      e.g. last_purge
 * "at" is ISO with the São Paulo offset (as everywhere); "t" is the same moment in ms, for windows and retention.
 * Only sessions inside a registered project are written, linked to the item and the task by the branch: the
 * hook already wrote what it could (texts redacted and truncated). Entries older than RETENTION_DAYS are deleted
 * by purge(), which the server runs once a day.
 */
const fs = require('fs');
const path = require('path');
const { loadSqlite } = require('./flow-store');

const DB_FILE = 'bruto.db';
const BUSY_TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 1;
const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const MIGRATIONS = [
  null,
  (db) => db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      item_number INTEGER,
      task_number INTEGER,
      branch TEXT,
      cwd TEXT,
      transcript_path TEXT,
      started_at TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      seen_t INTEGER NOT NULL
    );
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      t INTEGER NOT NULL,
      session_id TEXT,
      project_id TEXT NOT NULL,
      item_number INTEGER,
      task_number INTEGER,
      branch TEXT,
      hook_event TEXT NOT NULL,
      tool TEXT,
      input TEXT,
      ok INTEGER,
      output_summary TEXT,
      error TEXT,
      duration_ms REAL,
      prompt TEXT,
      detail TEXT,
      agent_id TEXT,
      agent_type TEXT,
      cwd TEXT,
      version TEXT
    );
    CREATE INDEX entries_t ON entries (t);
    CREATE INDEX entries_session ON entries (session_id, t);
    CREATE INDEX entries_item ON entries (project_id, item_number, t);
    CREATE INDEX entries_task ON entries (project_id, task_number, t);
    CREATE INDEX sessions_seen ON sessions (seen_t);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `),
];

const ENTRY_FIELDS = ['at', 't', 'session_id', 'project_id', 'item_number', 'task_number', 'branch', 'hook_event', 'tool', 'input', 'ok',
  'output_summary', 'error', 'duration_ms', 'prompt', 'detail', 'agent_id', 'agent_type', 'cwd', 'version'];

const isBusy = (e) => e && (e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY/i.test(String(e.message)));

/** Runs fn again while SQLite answers "busy" outside of busy_timeout's reach (e.g. switching to WAL). */
function retryBusy(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!isBusy(e) || Date.now() > end) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 20));
    }
  }
}

function transaction(db, fn, ms) {
  retryBusy(() => db.exec('BEGIN IMMEDIATE'), ms);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

function entryRow(row) {
  return {
    id: row.id, at: row.at, session: row.session_id || null, project_id: row.project_id,
    item_number: row.item_number === null ? null : row.item_number, task_number: row.task_number === null ? null : row.task_number,
    branch: row.branch || null, hook_event: row.hook_event, tool: row.tool || null, input: row.input === null ? null : row.input,
    ok: row.ok === null ? null : row.ok === 1, output_summary: row.output_summary === null ? null : row.output_summary,
    error: row.error === null ? null : row.error, duration_ms: row.duration_ms === null ? null : row.duration_ms,
    prompt: row.prompt === null ? null : row.prompt, detail: row.detail || null, agent_id: row.agent_id || null,
    agent_type: row.agent_type || null, version: row.version || null,
  };
}

/** WHERE of the raw entry filters: { project, item, task, session, start, end (ms; start exclusive, end inclusive) }. */
function entryWhere(f) {
  const where = [];
  const params = [];
  const eq = (column, value) => {
    if (value === undefined) return;
    if (value === null) where.push(`${column} IS NULL`);
    else { where.push(`${column} = ?`); params.push(value); }
  };
  eq('project_id', f.project);
  eq('item_number', f.item);
  eq('task_number', f.task);
  eq('session_id', f.session);
  if (Number.isFinite(f.start)) { where.push('t > ?'); params.push(f.start); }
  if (Number.isFinite(f.end)) { where.push('t <= ?'); params.push(f.end); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function openRawStore({ dir, create = true, busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const file = path.join(dir, DB_FILE);
  if (!create && !fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // Up to 32 MB of page cache (allocated only as used): the indexes of a big log stay in memory on cleanups.
  db.exec('PRAGMA cache_size = -32768');
  retryBusy(() => db.exec('PRAGMA journal_mode = WAL'), busyTimeoutMs);
  db.exec('PRAGMA synchronous = NORMAL'); // WAL + NORMAL: no corruption on a crash, at most the last commits lost
  const version = () => db.prepare('PRAGMA user_version').get().user_version;
  if (version() < SCHEMA_VERSION) {
    transaction(db, () => {
      for (let v = version() + 1; v <= SCHEMA_VERSION; v++) {
        MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${v}`);
      }
    }, busyTimeoutMs);
  }
  const insert = db.prepare(`INSERT INTO entries (${ENTRY_FIELDS.join(', ')}) VALUES (${ENTRY_FIELDS.map(() => '?').join(', ')})`);
  const values = (e) => ENTRY_FIELDS.map((k) => {
    const v = e[k];
    if (v === undefined || v === null) return null;
    if (k === 'ok') return v ? 1 : 0;
    return v;
  });

  const store = {
    file,
    close: () => db.close(),

    /**
     * Writes one hook entry and keeps its session (link to the item and task by the branch, last seen).
     * entry: { at, t, session_id, project_id, item_number, task_number, branch, hook_event, tool, input, ok, ... }
     * session (optional): { transcript_path, cwd }.
     */
    record(entry, session = {}) {
      transaction(db, () => {
        insert.run(...values(entry));
        if (entry.session_id) {
          db.prepare(`INSERT INTO sessions (session_id, project_id, item_number, task_number, branch, cwd, transcript_path, started_at, seen_at, seen_t)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (session_id) DO UPDATE SET project_id = excluded.project_id, item_number = excluded.item_number,
              task_number = excluded.task_number, branch = excluded.branch, cwd = excluded.cwd,
              transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
              seen_at = CASE WHEN excluded.seen_t > sessions.seen_t THEN excluded.seen_at ELSE sessions.seen_at END,
              seen_t = MAX(sessions.seen_t, excluded.seen_t)`)
            .run(entry.session_id, entry.project_id, entry.item_number ?? null, entry.task_number ?? null, entry.branch ?? null,
              session.cwd ?? entry.cwd ?? null, session.transcript_path ?? null, entry.at, entry.at, entry.t);
        }
      }, busyTimeoutMs);
    },

    /** Many entries in one transaction (volume tests and imports). */
    recordMany(entries) {
      transaction(db, () => { for (const e of entries) insert.run(...values(e)); }, busyTimeoutMs);
    },

    /** Entries of the filters, oldest first; with more than "limit", the most recent ones. { total, entries } */
    entries(f = {}, { limit = 1500 } = {}) {
      const w = entryWhere(f);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM entries ${w.sql}`).get(...w.params).n;
      const rows = db.prepare(`SELECT * FROM entries ${w.sql} ORDER BY t DESC, id DESC LIMIT ?`).all(...w.params, limit);
      return { total, entries: rows.reverse().map(entryRow) };
    },

    /**
     * The sessions seen after sinceMs (every one without it), most recently seen first (#13: the usage collector
     * attributes each transcript by them; the Agents screen shows each agent's last activity).
     * [{ session_id, project_id, item_number, task_number, branch, cwd, transcript_path, started_at, seen_at }]
     */
    sessions({ sinceMs } = {}) {
      const rows = Number.isFinite(sinceMs)
        ? db.prepare('SELECT * FROM sessions WHERE seen_t >= ? ORDER BY seen_t DESC, session_id').all(sinceMs)
        : db.prepare('SELECT * FROM sessions ORDER BY seen_t DESC, session_id').all();
      return rows.map((r) => ({
        session_id: r.session_id, project_id: r.project_id, item_number: r.item_number === null ? null : r.item_number,
        task_number: r.task_number === null ? null : r.task_number, branch: r.branch || null, cwd: r.cwd || null,
        transcript_path: r.transcript_path || null, started_at: r.started_at, seen_at: r.seen_at,
      }));
    },

    /** The most recent entry's moment (ISO), or null. */
    lastAt() {
      const row = db.prepare('SELECT at FROM entries ORDER BY t DESC, id DESC LIMIT 1').get();
      return row ? row.at : null;
    },

    /**
     * Deletes up to "limit" entries older than the retention (90 days before nowMs) and, on the last round, the
     * sessions not seen since then. Short transactions, so the hook never waits long: call again while !done.
     * { entries, sessions, done }
     */
    purge(nowMs, { days = RETENTION_DAYS, limit = 5000 } = {}) {
      const cut = nowMs - days * DAY_MS;
      return transaction(db, () => {
        const entries = Number(db.prepare('DELETE FROM entries WHERE id IN (SELECT id FROM entries WHERE t < ? ORDER BY t LIMIT ?)').run(cut, limit).changes);
        const done = entries < limit;
        let sessions = 0;
        if (done) {
          sessions = Number(db.prepare('DELETE FROM sessions WHERE seen_t < ?').run(cut).changes);
          db.prepare("INSERT INTO meta (key, value) VALUES ('last_purge', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(nowMs));
        }
        return { entries, sessions, done };
      }, busyTimeoutMs);
    },
  };
  return store;
}

module.exports = { openRawStore, DB_FILE, RETENTION_DAYS };
