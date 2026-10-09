'use strict';
/**
 * flow-store.js · the new model's database (ADRs 0002 and 0003): maestro.db in MAESTRO_DIR, through the
 * embedded node:sqlite (Node 22.13+), with no npm dependency.
 *
 *   openStore({ dir })          opens (and creates/migrates) <dir>/maestro.db: WAL, busy_timeout, schema version
 *   openStore({ dir, create: false })  returns null when the file does not exist yet (the server only reads)
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

/**
 * Opens maestro.db in dir. options.create=false: null if the file does not exist (does not create it).
 * Returns the store: an object with the read and write operations of the new model.
 */
function openStore({ dir, create = true } = {}) {
  const file = path.join(dir, DB_FILE);
  if (!create && !fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  retryBusy(() => db.exec('PRAGMA journal_mode = WAL'));
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

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
  };
  return store;
}

module.exports = { openStore, flowDir, DB_FILE, SCHEMA_VERSION, UNASSIGNED_COMPANY, TRACKERS, STAGES, loadSqlite };
