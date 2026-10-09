'use strict';
/**
 * flow-store.js · the new model's database (ADRs 0002 and 0003): maestro.db in MAESTRO_DIR, through the
 * embedded node:sqlite (Node 22.13+), with no npm dependency.
 *
 *   openStore({ dir })          opens (and creates/migrates) <dir>/maestro.db: WAL, busy_timeout, schema version
 *   openStore({ dir, create: false })  returns null when the file does not exist yet (the server only reads)
 *   openStore({ dir, readOnly: true, busyTimeoutMs })  reads without writing anything (the hook: is the cwd's project registered?)
 *   flowDir(env)                MAESTRO_DIR, or ~/.painel-maestro (the new model's default)
 *
 * Tables (schema version in PRAGMA user_version):
 *   companies(id, name, created_at)
 *   projects(id, name, company_id, tracker, stages JSON, done_state, maestri_workspace, created_at)
 *   project_repos(remote, project_id)            normalized remote URL → project (a project may have many repos)
 *   events(id, at, type, project_id, item_number, task_number, agent_role, agent_name, source, payload JSON)
 * Companies and projects are the owner's register (flow company / flow project, bin/flow-admin.js; the panel only
 * moves a project to another company): they may change, unlike the events.
 * The events table is append-only (triggers refuse UPDATE and DELETE) and is the only source of the state of
 * items: nothing derived is stored (the projection is computed by flow-projection.js).
 *
 * Several processes (maestro, workers, the panel) write at the same time: every write is a short
 * BEGIN IMMEDIATE transaction and busy_timeout makes the others wait instead of failing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_FILE = 'maestro.db';
const BUSY_TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 1;
const UNASSIGNED_COMPANY = 'unassigned';
const TRACKERS = ['github', 'azure_devops'];
const STAGES = ['specification', 'implementation', 'final_adjustment', 'pr_ready', 'merge', 'hml_validation', 'done'];

let sqlite = null;
/** Loads node:sqlite without its ExperimentalWarning (nothing of it may reach the CLI output). */
function loadSqlite() {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    const text = String(warning && warning.message ? warning.message : warning);
    if ((type === 'ExperimentalWarning' || (warning && warning.name === 'ExperimentalWarning')) && /sqlite/i.test(text)) return undefined;
    return original.call(process, warning, ...rest);
  };
  try {
    sqlite = require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqlite;
}

/** Data folder of the new model: MAESTRO_DIR or ~/.painel-maestro. */
function flowDir(env = process.env) {
  return path.resolve(env.MAESTRO_DIR || path.join(os.homedir(), '.painel-maestro'));
}

// Each step takes the schema from version n-1 to n; it runs inside the migration transaction.
const MIGRATIONS = [
  null,
  (db) => db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id),
      tracker TEXT NOT NULL CHECK (tracker IN ('github', 'azure_devops')),
      stages TEXT NOT NULL,
      done_state TEXT,
      maestri_workspace TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE project_repos (
      remote TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id)
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      item_number INTEGER NOT NULL,
      task_number INTEGER,
      agent_role TEXT,
      agent_name TEXT,
      source TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX events_item ON events (project_id, item_number, id);
    CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `),
];

const isBusy = (e) => e && (e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY/i.test(String(e.message)));

/** Runs fn again while SQLite answers "busy" outside of busy_timeout's reach (e.g. switching to WAL). */
function retryBusy(fn, ms = BUSY_TIMEOUT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!isBusy(e) || Date.now() > end) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.floor(Math.random() * 30));
    }
  }
}

/** BEGIN IMMEDIATE … COMMIT around fn(db); ROLLBACK on error. */
function transaction(db, fn) {
  retryBusy(() => db.exec('BEGIN IMMEDIATE'));
  try {
    const r = fn(db);
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

function migrate(db) {
  const version = () => db.prepare('PRAGMA user_version').get().user_version;
  if (version() >= SCHEMA_VERSION) return;
  transaction(db, () => {
    for (let v = version() + 1; v <= SCHEMA_VERSION; v++) {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v}`);
    }
  });
}

function projectRow(row) {
  if (!row) return null;
  let stages = [];
  try { stages = JSON.parse(row.stages); } catch (_) { stages = []; }
  return {
    id: row.id, name: row.name, company_id: row.company_id, company_name: row.company_name || null, tracker: row.tracker,
    stages: Array.isArray(stages) ? stages : [], done_state: row.done_state || null, maestri_workspace: row.maestri_workspace || null,
    created_at: row.created_at,
  };
}

function eventRow(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch (_) { payload = {}; }
  return {
    id: row.id, at: row.at, type: row.type, project_id: row.project_id, item_number: row.item_number,
    task_number: row.task_number === null ? null : row.task_number,
    agent: { role: row.agent_role || null, name: row.agent_name || null }, source: row.source, payload,
  };
}

/** WHERE of the Log's event filters; "skip" leaves one facet out (the counts of a facet ignore its own filter). */
function logWhere(f, skip) {
  const where = [];
  const params = [];
  const many = (column, values) => {
    where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  };
  if (f.companies && skip !== 'company') many('p.company_id', f.companies);
  if (f.projects && skip !== 'project') many('e.project_id', f.projects);
  if (f.types && skip !== 'type') many('e.type', f.types);
  if (f.item) {
    where.push('e.project_id = ? AND e.item_number = ?');
    params.push(f.item.project, f.item.number);
  }
  if (f.since) { where.push('e.at >= ?'); params.push(f.since); }
  if (f.until) { where.push('e.at < ?'); params.push(f.until); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Opens maestro.db in dir. options.create=false: null if the file does not exist (does not create it).
 * options.readOnly: opens without writing anything (no WAL switch, no migration) and returns null when the file
 * does not exist or has no schema yet; busyTimeoutMs shortens the wait for a busy database (the hook's 1.5 s).
 * Returns the store: an object with the read and write operations of the new model.
 */
function openStore({ dir, create = true, readOnly = false, busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const file = path.join(dir, DB_FILE);
  if ((!create || readOnly) && !fs.existsSync(file)) return null;
  const { DatabaseSync } = loadSqlite();
  let db;
  if (readOnly) {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (db.prepare('PRAGMA user_version').get().user_version < 1) {
      db.close();
      return null;
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(file);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    retryBusy(() => db.exec('PRAGMA journal_mode = WAL'), busyTimeoutMs);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  }

  const store = {
    file,
    close: () => db.close(),
    transaction: (fn) => transaction(db, () => fn(store)),

    projectByRemote(remote) {
      const row = db.prepare(`SELECT p.*, c.name AS company_name FROM project_repos r JOIN projects p ON p.id = r.project_id
        JOIN companies c ON c.id = p.company_id WHERE r.remote = ?`).get(remote);
      return projectRow(row);
    },
    project(id) {
      return projectRow(db.prepare('SELECT p.*, c.name AS company_name FROM projects p JOIN companies c ON c.id = p.company_id WHERE p.id = ?').get(id));
    },
    projects() {
      return db.prepare('SELECT p.*, c.name AS company_name FROM projects p JOIN companies c ON c.id = p.company_id ORDER BY p.id').all().map(projectRow);
    },
    ensureCompany(id, name, at) {
      db.prepare('INSERT OR IGNORE INTO companies (id, name, created_at) VALUES (?, ?, ?)').run(id, name, at);
    },
    /** New project with its first repository. The id must be free (see freeProjectId). */
    addProject({ id, name, companyId, tracker, stages = STAGES, remote, at, doneState = null, maestriWorkspace = null }) {
      db.prepare('INSERT INTO projects (id, name, company_id, tracker, stages, done_state, maestri_workspace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, companyId, tracker, JSON.stringify(stages), doneState, maestriWorkspace, at);
      if (remote) db.prepare('INSERT INTO project_repos (remote, project_id) VALUES (?, ?)').run(remote, id);
      return store.project(id);
    },
    /** base, or base-2, base-3… when a project already uses it. */
    freeProjectId(base) {
      const taken = (id) => !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
      if (!taken(base)) return base;
      for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
    },

    // ---- companies and projects (#6) ----
    company(id) {
      return db.prepare('SELECT id, name, created_at FROM companies WHERE id = ?').get(id) || null;
    },
    companies() {
      return db.prepare('SELECT id, name, created_at FROM companies ORDER BY id').all().map((c) => ({ id: c.id, name: c.name, created_at: c.created_at }));
    },
    addCompany({ id, name, at }) {
      db.prepare('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)').run(id, name, at);
      return store.company(id);
    },
    /** Normalized remotes of a project, in alphabetical order. */
    projectRepos(projectId) {
      return db.prepare('SELECT remote FROM project_repos WHERE project_id = ? ORDER BY remote').all(projectId).map((r) => r.remote);
    },
    /** The project a remote belongs to (id), or null. */
    repoOwner(remote) {
      const row = db.prepare('SELECT project_id FROM project_repos WHERE remote = ?').get(remote);
      return row ? row.project_id : null;
    },
    addRepo(projectId, remote) {
      db.prepare('INSERT OR IGNORE INTO project_repos (remote, project_id) VALUES (?, ?)').run(remote, projectId);
    },
    removeRepo(projectId, remote) {
      db.prepare('DELETE FROM project_repos WHERE remote = ? AND project_id = ?').run(remote, projectId);
    },
    /** Changes the given fields of a project (name, companyId, tracker, stages, doneState, maestriWorkspace). */
    updateProject(id, change) {
      const columns = { name: 'name', companyId: 'company_id', tracker: 'tracker', stages: 'stages', doneState: 'done_state', maestriWorkspace: 'maestri_workspace' };
      for (const [key, column] of Object.entries(columns)) {
        if (change[key] === undefined) continue;
        const value = key === 'stages' ? JSON.stringify(change[key]) : change[key];
        db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(value, id);
      }
      return store.project(id);
    },

    appendEvent({ at, type, projectId, itemNumber, taskNumber = null, agentRole = null, agentName = null, source, payload = {} }) {
      const r = db.prepare(`INSERT INTO events (at, type, project_id, item_number, task_number, agent_role, agent_name, source, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(at, type, projectId, itemNumber, taskNumber, agentRole, agentName, source, JSON.stringify(payload));
      return Number(r.lastInsertRowid);
    },
    itemEvents(projectId, itemNumber) {
      return db.prepare('SELECT * FROM events WHERE project_id = ? AND item_number = ? ORDER BY id').all(projectId, itemNumber).map(eventRow);
    },
    /** Every event of a project, oldest first (the status command looks for the task of the current branch). */
    projectEvents(projectId) {
      return db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id').all(projectId).map(eventRow);
    },
    /** Every event, oldest first (the server groups them by item). */
    allEvents() {
      return db.prepare('SELECT * FROM events ORDER BY id').all().map(eventRow);
    },

    // ---- the Log (#12) ----
    event(id) {
      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
      return row ? eventRow(row) : null;
    },
    /** The event written before e for the same item and the same task (null task: the item's own events). */
    previousEvent(e) {
      const row = db.prepare(`SELECT * FROM events WHERE project_id = ? AND item_number = ? AND task_number IS ? AND id < ?
        ORDER BY id DESC LIMIT 1`).get(e.project_id, e.item_number, e.task_number, e.id);
      return row ? eventRow(row) : null;
    },
    /**
     * Filtered page of events, newest first. f: { companies, projects, types (lists), item: {project, number},
     * since, until (ISO texts with the São Paulo offset; since inclusive, until exclusive) }.
     */
    logEvents(f, { limit = 50, offset = 0 } = {}) {
      const w = logWhere(f);
      const from = 'FROM events e JOIN projects p ON p.id = e.project_id';
      const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${w.sql}`).get(...w.params).n;
      const rows = db.prepare(`SELECT e.* ${from} ${w.sql} ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(...w.params, limit, offset);
      return { total, events: rows.map(eventRow) };
    },
    /** How many events of each company, project and type match the filters (each facet ignores its own). */
    logCounts(f) {
      const count = (facet, column) => {
        const w = logWhere(f, facet);
        const rows = db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM events e JOIN projects p ON p.id = e.project_id ${w.sql} GROUP BY ${column}`).all(...w.params);
        return Object.fromEntries(rows.map((r) => [r.k, r.n]));
      };
      return { company: count('company', 'p.company_id'), project: count('project', 'e.project_id'), type: count('type', 'e.type') };
    },
    /** Item of a task: the item of the events that mention it or, for an item that is its own only task, the item itself. */
    itemOfTask(projectId, taskNumber) {
      const row = db.prepare('SELECT item_number FROM events WHERE project_id = ? AND task_number = ? ORDER BY id DESC LIMIT 1').get(projectId, taskNumber);
      if (row) return row.item_number;
      return db.prepare('SELECT 1 FROM events WHERE project_id = ? AND item_number = ? LIMIT 1').get(projectId, taskNumber) ? taskNumber : null;
    },
  };
  return store;
}

module.exports = { openStore, flowDir, DB_FILE, SCHEMA_VERSION, UNASSIGNED_COMPANY, TRACKERS, STAGES, loadSqlite };
