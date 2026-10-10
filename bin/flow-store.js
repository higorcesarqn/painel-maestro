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
 *   organizations(id, name, created_at)
 *   projects(id, name, organization_id, tracker, stages JSON, done_state, maestri_workspace, created_at)
 *   project_repos(remote, project_id)            normalized remote URL → project (a project may have many repos)
 *   events(id, at, type, project_id, item_number, task_number, agent_role, agent_name, source, payload JSON)
 * Organizations and projects are the owner's register (flow org / flow project, bin/flow-admin.js; the panel creates,
 * renames and removes an organization and moves a project to another organization): they may change, unlike the events. Its rules live here, once: a write that
 * breaks one throws RegisterError with a code ({ code, ...params }), which the CLI turns into a message (exit 2) and
 * the API into an HTTP answer; neither repeats the rule.
 * The events table is append-only (triggers refuse UPDATE and DELETE) and is the only source of the state of
 * items: nothing derived is stored (the projection is computed by flow-projection.js).
 *
 * projectedItems() is the one place that groups the events by item and projects them (the server's routes and the
 * CLI's lookups); on a long-lived connection (the server) it is cached until an event is appended or a project changes
 * (its organization's name included: a rename, #23, by any process).
 *
 * Several processes (maestro, workers, the panel) write at the same time: every write is a short
 * BEGIN IMMEDIATE transaction and busy_timeout makes the others wait instead of failing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectItem } = require('./flow-projection');
const { t } = require('./i18n');

const DB_FILE = 'maestro.db';
const BUSY_TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 2;
const UNASSIGNED_ORGANIZATION = 'unassigned';
// The name "Sem organização" is registered with (the pt-BR dictionary): reserved for it, even before it exists (P-18, #20).
const UNASSIGNED_NAME = t('organizations.unassigned');
// Ids of organizations and projects (lowercase letters, digits and "-", starting with a letter or digit, up to 80).
const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_ORGANIZATION_NAME = 80;
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
  // v2 (#26): the grouping of projects is an organization; the foreign key of projects follows the renamed table and column.
  (db) => db.exec(`
    ALTER TABLE companies RENAME TO organizations;
    ALTER TABLE projects RENAME COLUMN company_id TO organization_id;
  `),
];

/** A rule of the register broken by a write: error is { code, ...params } (ADR 0004), translated by the CLI and the API. */
class RegisterError extends Error {
  constructor(error) {
    super(error.code);
    this.code = error.code;
    this.error = error;
  }
}

/** An organization's name in the register's format: trimmed, 1 to 80 characters on one line (invalid_field, field: name). */
function organizationNameFormat(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s || s.length > MAX_ORGANIZATION_NAME || /[\r\n]/.test(s)) {
    throw new RegisterError({ code: 'invalid_field', field: 'name', value: String(name ?? '').slice(0, 100), max: MAX_ORGANIZATION_NAME });
  }
  return s;
}

/** The key two organization names are compared by: the same letters (Unicode NFC) ignoring case. */
const nameKey = (name) => name.normalize('NFC').toLowerCase();

/** The organization { id, name } that holds a name without a database: "Sem organização", for its own name (P-18, #20); else null. */
const reservedNameOwner = (name) => (nameKey(name) === nameKey(UNASSIGNED_NAME) ? { id: UNASSIGNED_ORGANIZATION, name: UNASSIGNED_NAME } : null);

/**
 * "Sem organização" is reserved, without a database: it is never renamed, removed or the organization of a registered project
 * (organization_reserved, even before a repository lands there). The panel checks a POST with it before maestro.db exists.
 */
function notReserved(organizationId) {
  if (organizationId === UNASSIGNED_ORGANIZATION) throw new RegisterError({ code: 'organization_reserved', organization: organizationId });
  return organizationId;
}

/**
 * The fields of a new organization in the register's format, without a database (#22): the id (invalid_field, field: id;
 * "unassigned" is always taken, organization_exists) and the name (organizationNameFormat; the name of "Sem organização" is always
 * taken, organization_name_taken), trimmed. The panel checks a POST with it before creating maestro.db, so a refused POST
 * never creates it.
 */
function organizationFields({ id, name }) {
  const organizationId = typeof id === 'string' ? id.trim() : '';
  if (!RE_ID.test(organizationId)) throw new RegisterError({ code: 'invalid_field', field: 'id', value: String(id ?? '').slice(0, 100) });
  if (organizationId === UNASSIGNED_ORGANIZATION) throw new RegisterError({ code: 'organization_exists', organization: organizationId });
  const organizationName = organizationNameFormat(name);
  const reserved = reservedNameOwner(organizationName);
  if (reserved) throw new RegisterError({ code: 'organization_name_taken', name: organizationName, organization: reserved.id, organization_name: reserved.name });
  return { id: organizationId, name: organizationName };
}

const isBusy = (e) => e && (e.errcode === 5 || e.errcode === 6 || /database is locked|SQLITE_BUSY/i.test(String(e.message)));

/**
 * Runs fn again while SQLite answers "busy" outside of busy_timeout's reach (e.g. switching to WAL), for up to ms.
 * Shared with raw-store.js, like transaction().
 */
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

/** BEGIN IMMEDIATE … COMMIT around fn(db); ROLLBACK on error. ms: how long to retry a busy BEGIN. */
function transaction(db, fn, ms = BUSY_TIMEOUT_MS) {
  retryBusy(() => db.exec('BEGIN IMMEDIATE'), ms);
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
    id: row.id, name: row.name, organization_id: row.organization_id, organization_name: row.organization_name || null, tracker: row.tracker,
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
  if (f.organizations && skip !== 'organization') many('p.organization_id', f.organizations);
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
 * The items of a list of events (oldest first), projected (bin/flow-projection.js): Map('<project>/<number>' →
 * { key, project, state, events }) in the order each item first appeared; projects: Map(id → project). Items whose
 * project is gone or that never started are left out. Pure: the store's projectedItems() and the demo's generator use it.
 */
function projectEventsByItem(events, projects) {
  const byItem = new Map();
  for (const e of events) {
    const k = `${e.project_id}/${e.item_number}`;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(e);
  }
  const out = new Map();
  for (const [key, list] of byItem) {
    const p = projects.get(list[0].project_id);
    const state = p ? projectItem(list, p) : null;
    if (state) out.set(key, { key, project: p, state, events: list });
  }
  return out;
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
    // A reader never migrates: a schema not yet at this version (v1 before its first writer, #26) reads as no database.
    if (db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) {
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

  // projectedItems() of every project, kept while MAX(events.id) and the projects stay the same.
  let projectedCache = null;

  /** Inserts a project in organizationId, already checked by its caller, with its first repository. */
  function insertProject({ id, name, organizationId, tracker, stages = STAGES, remote, at, doneState = null, maestriWorkspace = null }) {
    db.prepare('INSERT INTO projects (id, name, organization_id, tracker, stages, done_state, maestri_workspace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, organizationId, tracker, JSON.stringify(stages), doneState, maestriWorkspace, at);
    if (remote) db.prepare('INSERT INTO project_repos (remote, project_id) VALUES (?, ?)').run(remote, id);
    return store.project(id);
  }

  const store = {
    file,
    close: () => db.close(),
    transaction: (fn) => transaction(db, () => fn(store)),

    projectByRemote(remote) {
      const row = db.prepare(`SELECT p.*, o.name AS organization_name FROM project_repos r JOIN projects p ON p.id = r.project_id
        JOIN organizations o ON o.id = p.organization_id WHERE r.remote = ?`).get(remote);
      return projectRow(row);
    },
    project(id) {
      return projectRow(db.prepare('SELECT p.*, o.name AS organization_name FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = ?').get(id));
    },
    projects() {
      return db.prepare('SELECT p.*, o.name AS organization_name FROM projects p JOIN organizations o ON o.id = p.organization_id ORDER BY p.id').all().map(projectRow);
    },
    ensureOrganization(id, name, at) {
      db.prepare('INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(id, name, at);
    },
    /**
     * New project with its first repository, in an organization of projectOrganization's rule ("Sem organização" only receives the
     * unregistered repositories: addUnregisteredProject). The id must be free (see freeProjectId).
     */
    addProject({ organizationId, ...fields }) {
      return insertProject({ ...fields, organizationId: store.projectOrganization(organizationId).id });
    },
    /** The project of an unregistered repository, in "Sem organização" (registered with its name when needed). */
    addUnregisteredProject({ at, ...fields }) {
      store.ensureOrganization(UNASSIGNED_ORGANIZATION, UNASSIGNED_NAME, at);
      return insertProject({ ...fields, at, organizationId: UNASSIGNED_ORGANIZATION });
    },
    /** base, or base-2, base-3… when a project already uses it. */
    freeProjectId(base) {
      const taken = (id) => !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
      if (!taken(base)) return base;
      for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
    },

    // ---- organizations and projects (#6) ----
    organization(id) {
      return db.prepare('SELECT id, name, created_at FROM organizations WHERE id = ?').get(id) || null;
    },
    organizations() {
      return db.prepare('SELECT id, name, created_at FROM organizations ORDER BY id').all().map((o) => ({ id: o.id, name: o.name, created_at: o.created_at }));
    },
    /**
     * The rule of an organization's name (#22; renaming reuses it with exceptId, the organization being renamed): required,
     * trimmed, 1 to 80 characters on one line (invalid_field, field: name) and unique ignoring case (nameKey) among
     * the other organizations, the name of "Sem organização" included (organization_name_taken, with the organization that uses it).
     * There is no unique index: a database that already has repeated names keeps working, and the rule holds for the
     * next writes. Returns the trimmed name.
     */
    organizationName(name, exceptId = null) {
      const s = organizationNameFormat(name);
      const key = nameKey(s);
      // The name of "Sem organização" is taken even before a repository lands there.
      const other = store.organizations().find((o) => o.id !== exceptId && nameKey(o.name) === key) || reservedNameOwner(s);
      if (other) throw new RegisterError({ code: 'organization_name_taken', name: s, organization: other.id, organization_name: other.name });
      return s;
    },
    /**
     * New organization: both fields in the register's format (organizationFields, with "Sem organização"'s id and name always taken),
     * the id free (organization_exists) and the name under organizationName's rule.
     * The id never changes afterwards.
     */
    addOrganization({ id, name, at }) {
      const { id: organizationId } = organizationFields({ id, name });
      const existing = store.organization(organizationId);
      if (existing) throw new RegisterError({ code: 'organization_exists', organization: organizationId, name: existing.name });
      const organizationName = store.organizationName(name);
      db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(organizationId, organizationName, at);
      return store.organization(organizationId);
    },
    /**
     * Renames an organization (#23) and returns it renamed, with from: the name it had; the id never changes. "Sem organização" is never renamed
     * (organization_reserved, even before a repository lands there); an unknown organization is organization_not_found; the name
     * follows organizationName's rule without counting the organization itself, so its own name (even with another case) is
     * accepted. The projects read the name from here (no copy), so every answer shows the new one.
     */
    renameOrganization(id, name) {
      notReserved(id);
      const before = store.organization(id);
      if (!before) throw new RegisterError({ code: 'organization_not_found', organization: id });
      const organizationName = store.organizationName(name, id);
      db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(organizationName, id);
      return { ...store.organization(id), from: before.name };
    },
    /**
     * Removes an organization without projects (#24) and returns it as it was. "Sem organização" is never removed
     * (organization_reserved, even before a repository lands there); an unknown organization is organization_not_found; an organization
     * with projects is organization_not_empty (with project_count), checked here on the register as it is now, so a screen
     * out of date never leaves a project without its organization.
     */
    removeOrganization(id) {
      notReserved(id);
      const o = store.organization(id);
      if (!o) throw new RegisterError({ code: 'organization_not_found', organization: id });
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE organization_id = ?').get(id);
      if (n > 0) throw new RegisterError({ code: 'organization_not_empty', organization: id, name: o.name, project_count: Number(n) });
      db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
      return o;
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
    /**
     * Changes the given fields of a project (name, organizationId, tracker, stages, doneState, maestriWorkspace). A new
     * organizationId follows projectOrganization's rule.
     */
    updateProject(id, change) {
      if (change.organizationId !== undefined) store.projectOrganization(change.organizationId);
      const columns = { name: 'name', organizationId: 'organization_id', tracker: 'tracker', stages: 'stages', doneState: 'done_state', maestriWorkspace: 'maestri_workspace' };
      for (const [key, column] of Object.entries(columns)) {
        if (change[key] === undefined) continue;
        const value = key === 'stages' ? JSON.stringify(change[key]) : change[key];
        db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(value, id);
      }
      return store.project(id);
    },
    /**
     * The organization a project may be added to or moved to: a registered organization other than "Sem organização", which only
     * receives the unregistered repositories (organization_reserved, even before it exists; an unknown one is
     * organization_not_found).
     */
    projectOrganization(organizationId) {
      notReserved(organizationId);
      const o = store.organization(organizationId);
      if (!o) throw new RegisterError({ code: 'organization_not_found', organization: organizationId });
      return o;
    },
    /** Moves a project to another organization (the rules of updateProject); an unknown project is project_not_found. */
    moveProject(id, organizationId) {
      if (!store.project(id)) throw new RegisterError({ code: 'project_not_found', project: id });
      return store.updateProject(id, { organizationId });
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
    /** Every event, oldest first. */
    allEvents() {
      return db.prepare('SELECT * FROM events ORDER BY id').all().map(eventRow);
    },
    /**
     * Every item projected from its events (bin/flow-projection.js), in the order each one first appeared:
     * Map('<project>/<number>' → { key, project, state, events }). Items whose project is gone or that never
     * started are left out. Without projectId the answer is kept on this connection and reused while no event was
     * appended (MAX(id) is exact: the table is append-only) and no project changed (its stages and organization, with the
     * organization's name, shape the answer): the server's routes read it many times per poll. It is shared: never change what it returns.
     * With projectId, only that project's items, computed now (the CLI looks up a task or a pending decision).
     */
    projectedItems({ projectId } = {}) {
      const projects = store.projects();
      const byId = new Map(projects.map((p) => [p.id, p]));
      if (projectId !== undefined) return projectEventsByItem(store.projectEvents(projectId), byId);
      const version = db.prepare('SELECT MAX(id) AS id FROM events').get().id || 0;
      const signature = JSON.stringify(projects);
      if (projectedCache && projectedCache.version === version && projectedCache.signature === signature) return projectedCache.items;
      const items = projectEventsByItem(store.allEvents(), byId);
      projectedCache = { version, signature, items };
      return items;
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
     * Filtered page of events, newest first. f: { organizations, projects, types (lists), item: {project, number},
     * since, until (ISO texts with the São Paulo offset; since inclusive, until exclusive) }.
     */
    logEvents(f, { limit = 50, offset = 0 } = {}) {
      const w = logWhere(f);
      const from = 'FROM events e JOIN projects p ON p.id = e.project_id';
      const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${w.sql}`).get(...w.params).n;
      const rows = db.prepare(`SELECT e.* ${from} ${w.sql} ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(...w.params, limit, offset);
      return { total, events: rows.map(eventRow) };
    },
    /** How many events of each organization, project and type match the filters (each facet ignores its own). */
    logCounts(f) {
      const count = (facet, column) => {
        const w = logWhere(f, facet);
        const rows = db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM events e JOIN projects p ON p.id = e.project_id ${w.sql} GROUP BY ${column}`).all(...w.params);
        return Object.fromEntries(rows.map((r) => [r.k, r.n]));
      };
      return { organization: count('organization', 'p.organization_id'), project: count('project', 'e.project_id'), type: count('type', 'e.type') };
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

module.exports = {
  openStore, projectEventsByItem, flowDir, RegisterError, RE_ID, organizationFields, notReserved, DB_FILE, SCHEMA_VERSION, UNASSIGNED_ORGANIZATION, TRACKERS, STAGES, loadSqlite, retryBusy, transaction,
};
