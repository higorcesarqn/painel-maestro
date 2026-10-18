#!/usr/bin/env node
'use strict';
// server.js · local panel of the item flows (Maestri + Claude Code)
//
// HTTP server with Node's standard library only, bound to 127.0.0.1. Serves index.html and a JSON API over the
// data of the new model in MAESTRO_DIR (default ~/.painel-maestro): maestro.db (organizations, projects and the events
// the flow CLI writes; ADRs 0002 and 0003), bruto.db (the hook's raw log) and state/usage.json (the usage
// collector). No AI and no tokens: it only reads. Runs the usage collector (bin/collect-usage.js) on startup and
// every 5 min, and the merge check (merge-check.js) of the items with a ready PR, in the same process.
//
// Start:  node panel/server.js [--port 4777]
// Stop:   Ctrl+C in the server terminal, or taskkill /PID <pid from <MAESTRO_DIR>/state/panel.pid> /F
//
// Routes (details in panel/README.md):
//   GET  /                                    the page (index.html, a single file)
//   GET  /api/state                           health badge, menu counter and list of open pending decisions, plan usage, collector,
//                                             the panel's version (semver, the commit the server started on and the
//                                             id of the current index.html)
//   POST /api/recalculate                     runs the usage collector now and returns /api/state
//   GET  /api/overview[?organization=]        Overview (api-overview.js)
//   GET  /api/items[?active=&organization=&project=], GET /api/items/<project>/<number>   items (api-items.js)
//   POST /api/items/<project>/<number>/merged "mark as merged" (merge-check.js)
//   POST /api/items/<project>/<number>/done   "Concluir": the owner concludes the item (api-items.js, #68)
//   POST /api/items/<project>/<number>/interrupt   "Interromper": the owner interrupts the item, { reason } (api-items.js, #70)
//   GET  /api/pending-decisions               pending decisions (api-pending-decisions.js)
//   POST /api/pending-decisions/<id>/answer   the owner's answer to an open pending decision (#32)
//   GET  /api/log, GET /api/log/<id>, GET /api/raw   the Log and the raw log (api-log.js)
//   GET  /api/organizations, POST /api/organizations, POST /api/organizations/<id>/rename, POST /api/organizations/<id>/remove,
//   POST /api/organizations/<id>/hide, POST /api/organizations/<id>/unhide, GET /api/projects, POST /api/projects/<id>/organization
//                                             organizations and projects (api-projects.js)
//   GET  /api/usage, GET /api/agents          usage and agents per item (api-usage.js)
// The raw log older than 90 days is deleted on startup and once a day.
// The API never returns sentences: reasons, warnings and errors are codes with parameters ({code, ...params})
// and the page translates them (ADR 0004).
// Security: listens only on 127.0.0.1; Host must be 127.0.0.1:<port> or localhost:<port> (otherwise 403); POST
//   only with the header X-Panel: 1 and, when there is an Origin, the panel's own (otherwise 403); no CORS header;
//   only "/" and "/api/*" exist (the rest is 404); JSON always with Cache-Control: no-store; the page with a CSP.
//
// Variables: PANEL_PORT (default 4777; --port wins), MAESTRO_DIR (default ~/.painel-maestro),
//   MAESTRI_DATA_DIR and CLAUDE_CONFIG_DIR (passed to the collector), PANEL_COLLECTOR=0 (does not run
//   the collector by itself), PANEL_STALE_HOURS (default 48: hours on the same stage that make an active item
//   "stale" in the Overview) and, for tests only, PANEL_INDEX (another index.html), PANEL_NOW
//   (fixed clock; MAESTRO_NOW also works), PANEL_REPO_DIR (the repository whose version and commits the server
//   reads, #38; default: the folder of the code) and PANEL_OUTDATED_CACHE_MS (the cache of the server_outdated check,
//   in ms: an integer from 10 up; any other value → the default, 5000).
//   Merge check (merge-check.js): PANEL_MERGE_CHECK=0|1, PANEL_MERGE_CHECK_SECONDS, PANEL_GH_CLI, PANEL_AZ_CLI,
//   PANEL_AZURE_DEVOPS_URL.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const collector = require(path.join(__dirname, '..', 'bin', 'collect-usage.js'));
const { flowDir, SchemaTooNew } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { t } = require(path.join(__dirname, '..', 'bin', 'i18n'));
const { HOOK_FAILURE_FILE, hookFailureOf } = require(path.join(__dirname, '..', 'bin', 'hook-failure.js'));
const itemsApi = require(path.join(__dirname, 'api-items.js'));
const pendingApi = require(path.join(__dirname, 'api-pending-decisions.js'));
const logApi = require(path.join(__dirname, 'api-log.js'));
const projectsApi = require(path.join(__dirname, 'api-projects.js'));
const mergeCheck = require(path.join(__dirname, 'merge-check.js'));
const usageApi = require(path.join(__dirname, 'api-usage.js'));
const overviewApi = require(path.join(__dirname, 'api-overview.js'));
const { evaluateHealth } = require(path.join(__dirname, 'health.js'));
const { asDate, isoSP, InvalidData, parseOptions } = require(path.join(__dirname, '..', 'bin', 'lib.js'));
const { readVersion } = require(path.join(__dirname, '..', 'bin', 'version.js'));
const { createServerOutdatedCheck, CACHE_MS: OUTDATED_CACHE_MS } = require(path.join(__dirname, 'server-outdated.js'));
const { readJson, readText, withRetries, writeAtomic } = collector.util;

const MIN_MS = 60 * 1000;

const DAY_MS = 24 * 60 * MIN_MS;
const DEFAULT_PORT = 4777;
const COLLECTOR_INTERVAL_MS = 5 * MIN_MS;
const DEFAULT_STALE_HOURS = 48;               // Overview (#14): PANEL_STALE_HOURS
const RAW_PURGE_INTERVAL_MS = DAY_MS;          // bruto.db: entries older than 90 days leave once a day
// index.html is a single file (embedded CSS and JS); nothing external is loaded.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BODY_LIMIT = 16 * 1024; // body accepted by the POSTs that read JSON (POST /api/organizations, .../<id>/rename, POST /api/projects/<id>/organization, POST /api/pending-decisions/<id>/answer, POST /api/items/<project>/<number>/interrupt)
const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
const USAGE_FILE = 'state/usage.json';         // written by the usage collector, relative to MAESTRO_DIR


// ---------- configuration ----------

function parseConfig(argv = [], env = process.env) {
  const { opts, positional } = parseOptions(argv, { port: 'value', help: 'flag' }, { unknown: 'server.errors.unknownOption', missing: 'server.errors.invalidPort' });
  if (opts.help) return { help: true };
  if (positional.length) throw new InvalidData('server.errors.unknownOption', { option: positional[0] });
  const port = opts.port !== undefined ? opts.port : env.PANEL_PORT;
  const p = port === undefined || port === '' ? DEFAULT_PORT : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new InvalidData('server.errors.invalidPort', { value: port });
  const nowText = env.PANEL_NOW || env.MAESTRO_NOW || '';
  const fixedNow = nowText ? asDate(nowText) : null;
  if (nowText && !fixedNow) throw new InvalidData('server.errors.invalidNow', { value: nowText });
  // Overview (#14): an active item on the same stage for longer than this is "stale".
  const staleText = env.PANEL_STALE_HOURS;
  const staleHours = staleText === undefined || staleText === '' ? DEFAULT_STALE_HOURS : Number(staleText);
  if (!(Number.isFinite(staleHours) && staleHours > 0)) throw new InvalidData('server.errors.invalidStaleHours', { value: staleText });
  const mergeCheckConfig = mergeCheck.parseConfig(env, { collectorActive: env.PANEL_COLLECTOR !== '0', fixedNow });
  const outdatedMs = Number(env.PANEL_OUTDATED_CACHE_MS);
  return {
    mergeCheck: mergeCheckConfig,
    staleHours,
    port: p,
    dataDir: flowDir(env),
    indexPath: path.resolve(env.PANEL_INDEX || path.join(__dirname, 'index.html')),
    repoDir: path.resolve(env.PANEL_REPO_DIR || path.join(__dirname, '..')),
    outdatedCacheMs: Number.isInteger(outdatedMs) && outdatedMs >= 10 ? outdatedMs : OUTDATED_CACHE_MS,
    fixedNow,
    collectorActive: env.PANEL_COLLECTOR !== '0',
    env,
  };
}

// ---------- helpers ----------

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function ageMin(value, t) {
  const d = asDate(value);
  return d ? Math.max(0, Math.round((t - d.getTime()) / MIN_MS)) : null;
}

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Reads files with a cache by (ino, size, mtime): usage.json and index.html are read on every request. */
class FileCache {
  constructor() {
    this.cache = new Map();
  }

  /** kind "json" → {exists, data, error}; "text" → {exists, text, error}. */
  async read(file, kind) {
    let st;
    try {
      st = await withRetries(() => fsp.stat(file));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        this.cache.delete(file);
        return { exists: false, data: null, text: null, error: null };
      }
      return { exists: true, data: null, text: null, error: { code: 'read_failed', detail: e.code || e.message } };
    }
    const key = `${kind}:${st.ino}:${st.size}:${st.mtimeMs}`;
    const c = this.cache.get(file);
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
    if (!value.error) this.cache.set(file, { key, value });
    return value;
  }

  json(file) {
    return this.read(file, 'json');
  }

  text(file) {
    return this.read(file, 'text');
  }
}

// ---------- building the answers ----------

// The page id (#37): the build (ui/scripts/publish.js) writes a hash of the bundle into index.html; a tab compares
// its own id with the one of the current file to know the page changed on disk.
const PAGE_ID = /<meta name="page-id" content="([0-9a-f]{16})">/;

/** The page id of an index.html read ({exists, text}), or null without one. */
function pageIdOf(read) {
  const m = read && typeof read.text === 'string' ? PAGE_ID.exec(read.text) : null;
  return m ? m[1] : null;
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

/** The plan KPI of the Overview: usage.json's plan now, or why there is none. */
function usageKpi(usageFile, t, warnings) {
  const usage = obj(usageFile.data);
  const unreadable = { code: 'file_unreadable', file: USAGE_FILE, error: usageFile.error || { code: 'unexpected_format' } };
  if (usageFile.exists && !usage) warnings.push(unreadable);
  const plan = usage && obj(usage.plan) ? planNow(usage.plan, t) : null;
  if (!plan) {
    return {
      available: false, window_5h_pct: null, reset_5h: null, weekly_pct: null, weekly_reset: null, age_min: null,
      updated_at: null, window_5h_reason: null, weekly_reason: null, source: null, collected_at: null,
      reason: usageFile.exists ? { ...unreadable, code: 'usage_unreadable' } : { code: 'collector_not_run' },
    };
  }
  return {
    available: !!plan.available, window_5h_pct: typeof plan.window_5h_pct === 'number' ? plan.window_5h_pct : null,
    reset_5h: plan.reset_5h || null, weekly_pct: typeof plan.weekly_pct === 'number' ? plan.weekly_pct : null,
    weekly_reset: plan.weekly_reset || null, age_min: plan.age_min, updated_at: plan.updated_at || null,
    reason: plan.available ? null : plan.reason || null, window_5h_reason: plan.window_5h_reason || null,
    weekly_reason: plan.weekly_reason || null, source: plan.source || null, collected_at: usage.collected_at || null,
  };
}

/**
 * The menu counter: open pending decisions of every organization but the hidden ones (#52), by severity (computed
 * from the events, #10), and the open ones themselves (#45), every one, the most urgent first, in the Overview's
 * summary shape: the page's browser notification compares their ids between reads. Those of a hidden organization
 * reach neither the counter, the tab nor the notification: the owner answers them in the maestro's terminal. An
 * unreadable maestro.db counts nothing: the health badge already says why (database_unreadable); its list is null,
 * unknown: an empty one would read as "all closed", and the page would notify every open one again on the next good read.
 */
function pendingKpi(items) {
  let counts;
  let open;
  try {
    ({ counts, pending_decisions: open } = pendingApi.listPendingDecisions(items, new URLSearchParams({ status: 'open' })));
  } catch (_) {
    counts = { severity: { critical: 0, high: 0, normal: 0, low: 0 } };
    open = null;
  }
  const bySeverity = { ...counts.severity };
  return { total: Object.values(bySeverity).reduce((n, x) => n + x, 0), by_severity: bySeverity, open: open && open.map(overviewApi.pendingSummary) };
}

/**
 * GET /api/state, from its parts (the demo's generator builds it with the same function):
 * { generated_at, health, kpis: { pending_decisions, usage }, collector, warnings, version }.
 * items: the items source (api-items.js); raw: the raw log source (api-log.js); usageFile: the read of
 * state/usage.json ({exists, data, error}); problems: health codes other checks add (the merge check, #11; server_outdated, #38);
 * hookFailure: the hook's last failure (bin/hook-failure.js, #28) or null.
 * version: { product, commit } read when the server started (bin/version.js, #36), commit null without git, and
 * page, the id of the current index.html (#37), null when the file has none.
 */
function stateAnswer({ items, raw, usageFile, nowMs, problems = [], hookFailure = null, collector: collectorInfo, version = { product: null, commit: null } }) {
  const warnings = [];
  const usage = usageKpi(usageFile, nowMs, warnings);
  return {
    generated_at: isoSP(nowMs),
    health: { ...evaluateHealth({ items, raw, nowMs, problems, hookFailure }), usage_age_min: usage.age_min },
    kpis: { pending_decisions: pendingKpi(items), usage },
    collector: collectorInfo,
    warnings,
    version: { product: version.product, commit: version.commit, page: version.page || null },
  };
}

// ---------- context (data + collector) ----------

function createContext(cfg) {
  const ctx = {
    cfg,
    files: new FileCache(),
    // The semver and the commit the server started on (#36): the code only changes on a restart.
    version: readVersion(cfg.repoDir),
    items: itemsApi.createItemsSource(cfg.env),
    raw: logApi.createRawSource(cfg.env),
    usageFile: path.join(cfg.dataDir, ...USAGE_FILE.split('/')),
    pidFile: path.join(cfg.dataDir, 'state', 'panel.pid'),
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
  // server_outdated (#38): the code the server runs changed in git since the commit it started on.
  ctx.serverOutdated = createServerOutdatedCheck({ repoDir: cfg.repoDir, startedCommit: ctx.version.commit, cacheMs: cfg.outdatedCacheMs });
  ctx.mergeCheck = mergeCheck.createMergeCheck({ config: cfg.mergeCheck, env: cfg.env, items: ctx.items, now: ctx.now, log: ctx.log, logError: ctx.logError });
  /** Runs the usage collector; calls during a collection wait for the same collection. */
  ctx.runCollector = (trigger) => {
    if (ctx.currentRun) return ctx.currentRun;
    const p = (async () => {
      await null;
      const startedAt = Date.now();
      try {
        const usage = await collector.collect({
          maestroDir: cfg.dataDir,
          maestriDataDir: cfg.env.MAESTRI_DATA_DIR,
          claudeDir: cfg.env.CLAUDE_CONFIG_DIR,
          env: cfg.env,
          now: ctx.now(),
          write: true,
        });
        ctx.lastRun = { at: isoSP(new Date()), trigger, ok: true, duration_ms: Date.now() - startedAt, error: null };
        if (trigger !== 'periodic') {
          const pl = usage.plan;
          const plan = t('server.log.usagePlan', { available: pl.available, pct5: pl.window_5h_pct ?? '—', pct7: pl.weekly_pct ?? '—' });
          ctx.log(t('server.log.usageCollected', { trigger, plan, sessions: usage.collection.sessions, ms: ctx.lastRun.duration_ms }));
        }
      } catch (e) {
        ctx.lastRun = { at: isoSP(new Date()), trigger, ok: false, duration_ms: Date.now() - startedAt, error: e && e.message ? e.message : String(e) };
        ctx.logError(t('server.log.collectorFailed', { trigger, detail: e && e.stack ? e.stack : e }));
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

function collectorState(ctx) {
  return { interval_min: COLLECTOR_INTERVAL_MS / MIN_MS, active: ctx.cfg.collectorActive, last: ctx.lastRun, running: !!ctx.currentRun };
}

async function buildState(ctx) {
  return stateAnswer({
    items: ctx.items, raw: ctx.raw, usageFile: await ctx.files.json(ctx.usageFile), nowMs: ctx.now().getTime(),
    problems: [...ctx.mergeCheck.healthReasons(), ...await ctx.serverOutdated.healthReasons()], collector: collectorState(ctx),
    version: { ...ctx.version, page: pageIdOf(await ctx.files.text(ctx.cfg.indexPath)) },
    hookFailure: hookFailureOf(await ctx.files.json(path.join(ctx.cfg.dataDir, HOOK_FAILURE_FILE))),
  });
}

// ---------- GET /api/usage and /api/agents (#13) ----------

async function usageAnswer(ctx, query) {
  const t = ctx.now().getTime();
  const file = await ctx.files.json(ctx.usageFile);
  return usageApi.usageAnswer(ctx.items, file, query, { plan: (p) => planNow(p, t), collector: collectorState(ctx) });
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
  '/api/recalculate': { name: 'recalculate', methods: ['POST'] },
  '/api/items': { name: 'items', methods: ['GET', 'HEAD'] },
  '/api/pending-decisions': { name: 'pending-decisions', methods: ['GET', 'HEAD'] },
  '/api/log': { name: 'log', methods: ['GET', 'HEAD'] },
  '/api/raw': { name: 'raw', methods: ['GET', 'HEAD'] },
  '/api/organizations': { name: 'organizations', methods: ['GET', 'HEAD', 'POST'] },
  '/api/projects': { name: 'projects', methods: ['GET', 'HEAD'] },
  '/api/usage': { name: 'usage', methods: ['GET', 'HEAD'] },
  '/api/agents': { name: 'agents', methods: ['GET', 'HEAD'] },
  '/api/overview': { name: 'overview', methods: ['GET', 'HEAD'] },
};

function findRoute(urlPath) {
  if (Object.prototype.hasOwnProperty.call(FIXED_ROUTES, urlPath)) return FIXED_ROUTES[urlPath];
  const rc = /^\/api\/organizations\/([^/]+)\/(rename|remove|hide|unhide)$/.exec(urlPath);
  if (rc) {
    const id = projectsApi.parseRegisterId(rc[1]);
    return id ? { name: `organization-${rc[2]}`, methods: ['POST'], organization: id } : null;
  }
  const mc = /^\/api\/projects\/([^/]+)\/organization$/.exec(urlPath);
  if (mc) {
    const id = projectsApi.parseRegisterId(mc[1]);
    return id ? { name: 'project-organization', methods: ['POST'], project: id } : null;
  }
  const mi = /^\/api\/items\/([^/]+)\/([^/]+)$/.exec(urlPath);
  if (mi) {
    const it = itemsApi.parseItemPath(mi[1], mi[2]);
    return it ? { name: 'item', methods: ['GET', 'HEAD'], project: it.project, number: it.number } : null;
  }
  const mm = /^\/api\/items\/([^/]+)\/([^/]+)\/(merged|done|interrupt)$/.exec(urlPath);
  if (mm) {
    const it = itemsApi.parseItemPath(mm[1], mm[2]);
    return it ? { name: `item-${mm[3]}`, methods: ['POST'], project: it.project, number: it.number } : null;
  }
  const ma = /^\/api\/pending-decisions\/([^/]+)\/answer$/.exec(urlPath);
  if (ma) {
    const id = pendingApi.parsePendingId(ma[1]);
    return id ? { name: 'pending-answer', methods: ['POST'], id } : null;
  }
  const ml = /^\/api\/log\/([^/]+)$/.exec(urlPath);
  if (ml) {
    const id = logApi.parseLogId(ml[1]);
    return id ? { name: 'log-event', methods: ['GET', 'HEAD'], id } : null;
  }
  return null;
}

async function route(ctx, req, res) {
  // Only POST /api/organizations, POST /api/organizations/<id>/rename, POST /api/projects/<id>/organization,
  // POST /api/pending-decisions/<id>/answer and POST /api/items/<project>/<number>/interrupt read the body (a POST that reads JSON gets up to 16 KB); the rest is discarded, capped at 1 MB.
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
      const x = await ctx.files.text(ctx.cfg.indexPath);
      if (!x.exists || typeof x.text !== 'string') {
        // A page for people (Portuguese, ADR 0004): the API JSON never carries sentences.
        const html = `<!doctype html><meta charset="utf-8"><title>Painel</title><p>${escapeHtml(t('server.indexMissing', { file: ctx.cfg.indexPath.replace(/\\/g, '/') }))}</p>`;
        return respond(req, res, 503, html, HTML_TYPE, { 'Content-Security-Policy': CSP });
      }
      return respond(req, res, 200, x.text, HTML_TYPE, { 'Content-Security-Policy': CSP });
    }
    case 'state':
      return respondJson(req, res, 200, await buildState(ctx));
    case 'recalculate': {
      const run = await ctx.runCollector('recalculate');
      const state = await buildState(ctx);
      state.recalculation = { ok: !!(run && run.ok), duration_ms: run ? run.duration_ms : null, error: run && !run.ok ? run.error : null };
      return respondJson(req, res, 200, state);
    }
    case 'items': {
      const active = itemsApi.activeFilter(query);
      if (active === undefined) return respondError(req, res, 400, { code: 'invalid_param', param: 'active', value: truncate(query.get('active'), 20), expected: 'flag' });
      return respondJson(req, res, 200, projectsApi.filterItems(itemsApi.listItems(ctx.items, { active }), query));
    }
    case 'organizations': {
      if (req.method !== 'POST') return respondJson(req, res, 200, projectsApi.listOrganizations(ctx.items, query));
      const buf = await body;
      if (buf === null) return respondError(req, res, 413, { code: 'body_too_large', limit_kb: BODY_LIMIT / 1024 });
      const x = projectsApi.createOrganization(ctx.items, buf, isoSP(ctx.now()));
      ctx.log(t('server.log.organizationCreated', { organization: x.organization.id, name: x.organization.name }));
      return respondJson(req, res, 201, x);
    }
    case 'projects':
      return respondJson(req, res, 200, projectsApi.listProjects(ctx.items, query));
    case 'organization-rename': {
      const buf = await body;
      if (buf === null) return respondError(req, res, 413, { code: 'body_too_large', limit_kb: BODY_LIMIT / 1024 });
      const x = projectsApi.renameOrganization(ctx.items, r.organization, buf);
      ctx.log(t('server.log.organizationRenamed', { organization: x.organization.id, from: x.from, name: x.organization.name }));
      return respondJson(req, res, 200, { organization: x.organization });
    }
    case 'organization-remove': {
      const c = projectsApi.removeOrganization(ctx.items, r.organization);
      ctx.log(t('server.log.organizationRemoved', { organization: c.id, name: c.name }));
      return respondJson(req, res, 200, { removed: c.id });
    }
    case 'organization-hide':
    case 'organization-unhide': {
      const hidden = r.name === 'organization-hide';
      const x = projectsApi.setOrganizationHidden(ctx.items, r.organization, hidden, isoSP(ctx.now()));
      if (x.changed) ctx.log(t(hidden ? 'server.log.organizationHidden' : 'server.log.organizationShown', { organization: x.organization.id, name: x.organization.name }));
      return respondJson(req, res, 200, { organization: x.organization });
    }
    case 'project-organization': {
      const buf = await body;
      if (buf === null) return respondError(req, res, 413, { code: 'body_too_large', limit_kb: BODY_LIMIT / 1024 });
      const x = projectsApi.moveProject(ctx.items, r.project, buf);
      ctx.log(t('server.log.projectMoved', { project: r.project, organization: x.project.organization.id }));
      return respondJson(req, res, 200, x);
    }
    case 'item': {
      const x = itemsApi.itemDetail(ctx.items, r.project, r.number);
      if (!x) return respondError(req, res, 404, { code: 'item_not_found', project: r.project, number: r.number });
      return respondJson(req, res, 200, withMergeCheck(ctx, x));
    }
    case 'item-merged': {
      const marked = ctx.mergeCheck.markMerged(r.project, r.number);
      if (marked.error) return respondError(req, res, marked.status, marked.error);
      return respondJson(req, res, 200, withMergeCheck(ctx, itemsApi.itemDetail(ctx.items, r.project, r.number)));
    }
    case 'item-done': {
      const done = itemsApi.markItemDone(ctx.items, r.project, r.number, isoSP(ctx.now()));
      if (done.error) return respondError(req, res, done.status, done.error);
      ctx.log(t('server.log.itemConcluded', { key: `${r.project}/${r.number}`, canceled: done.canceled.length }));
      return respondJson(req, res, 200, withMergeCheck(ctx, itemsApi.itemDetail(ctx.items, r.project, r.number)));
    }
    case 'item-interrupt': {
      const buf = await body;
      if (buf === null) return respondError(req, res, 413, { code: 'body_too_large', limit_kb: BODY_LIMIT / 1024 });
      const interrupted = itemsApi.markItemInterrupted(ctx.items, r.project, r.number, buf, isoSP(ctx.now()));
      if (interrupted.error) return respondError(req, res, interrupted.status, interrupted.error);
      ctx.log(t('server.log.itemInterrupted', { key: `${r.project}/${r.number}`, canceled: interrupted.canceled.length }));
      return respondJson(req, res, 200, withMergeCheck(ctx, itemsApi.itemDetail(ctx.items, r.project, r.number)));
    }
    case 'pending-decisions':
      return respondJson(req, res, 200, pendingApi.listPendingDecisions(ctx.items, query));
    case 'pending-answer': {
      const buf = await body;
      if (buf === null) return respondError(req, res, 413, { code: 'body_too_large', limit_kb: BODY_LIMIT / 1024 });
      const x = pendingApi.answerPendingDecision(ctx.items, r.id, buf, isoSP(ctx.now()));
      ctx.log(t('server.log.pendingAnswered', { id: x.id, key: x.item.key }));
      return respondJson(req, res, 200, x);
    }
    case 'log':
      return respondJson(req, res, 200, logApi.listLog(ctx.items, ctx.raw, query, ctx.now().getTime()));
    case 'log-event': {
      const x = logApi.logDetail(ctx.items, ctx.raw, r.id);
      if (!x) return respondError(req, res, 404, { code: 'event_not_found', id: r.id });
      return respondJson(req, res, 200, x);
    }
    case 'raw':
      return respondJson(req, res, 200, logApi.listRaw(ctx.raw, query));
    case 'usage':
      return respondJson(req, res, 200, await usageAnswer(ctx, query));
    case 'agents':
      return respondJson(req, res, 200, usageApi.listAgents(ctx.items, ctx.raw, await ctx.files.json(ctx.usageFile), query));
    case 'overview':
      return respondJson(req, res, 200, overviewApi.overview(ctx.items, query, { nowMs: ctx.now().getTime(), staleHours: ctx.cfg.staleHours }));
    default:
      return respondError(req, res, 404, { code: 'route_not_found' });
  }
}

/** The item page with the state of its merge check (merge_check: null when the item does not wait for a merge). */
function withMergeCheck(ctx, detail) {
  const it = detail.item;
  return { item: { ...it, merge_check: ctx.mergeCheck.itemStatus(it.key, it) } };
}

function createHandler(ctx) {
  return (req, res) => {
    route(ctx, req, res).catch((e) => {
      const known = e instanceof pendingApi.PendingError || e instanceof logApi.LogError
        || e instanceof projectsApi.ProjectsError || e instanceof usageApi.UsageApiError || e instanceof SchemaTooNew;
      // A maestro.db written by a newer painel-maestro (#28): nothing is served from it until the code is updated.
      const status = e instanceof SchemaTooNew ? 503 : known ? e.status : 500;
      if (status === 500) ctx.logError(t('server.log.requestFailed', { method: req.method, url: String(req.url).slice(0, 200), detail: e && e.stack ? e.stack : e }));
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
  server.on('error', (e) => ctx.logError(t('server.log.serverError', { detail: e && e.message })));
  ctx.setPort(server.address().port);
  const pidFile = ctx.pidFile;
  await writeAtomic(pidFile, `${process.pid}\n`);
  let timer = null;
  if (cfg.collectorActive) {
    ctx.runCollector('startup');
    timer = setInterval(() => ctx.runCollector('periodic'), COLLECTOR_INTERVAL_MS);
  }
  ctx.mergeCheck.start();
  // Raw log retention (ADR 0003): on startup and then once a day, in short rounds (the server keeps answering).
  let stopped = false;
  let purging = null;
  const purge = () => {
    if (purging) return purging;
    purging = logApi.purgeRaw(ctx.raw, ctx.now().getTime(), { stopped: () => stopped }).then((r) => {
      if (r && (r.entries || r.sessions)) ctx.log(t('server.log.rawPurged', { entries: r.entries, sessions: r.sessions }));
    }).catch((e) => {
      ctx.logError(t('server.log.rawPurgeFailed', { detail: e && e.message ? e.message : e }));
    }).finally(() => { purging = null; });
    return purging;
  };
  await purge();
  const purgeTimer = setInterval(purge, RAW_PURGE_INTERVAL_MS);
  purgeTimer.unref();
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    clearInterval(purgeTimer);
    removePidSync(pidFile);
    if (purging) await purging;
    await ctx.mergeCheck.stop();
    ctx.items.close();
    ctx.raw.close();
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
    if (ctx.currentRun) await ctx.currentRun.catch(() => {});
  }
  return { server, port: ctx.port, ctx, stop, pidFile };
}

module.exports = { start, parseConfig, buildState, stateAnswer, findRoute, CSP };

if (require.main === module) {
  let cfg;
  try {
    cfg = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`${t('server.errors.prefix', { message: e.message })}\n`);
    process.exit(2);
  }
  if (cfg.help) {
    process.stdout.write(t('server.help'));
    process.exit(0);
  }
  process.on('unhandledRejection', (e) => {
    try { process.stderr.write(`${t('server.errors.unhandled', { detail: e && e.stack ? e.stack : e })}\n`); } catch (_) { /* nothing */ }
  });
  start({ cfg }).then(({ port, stop, pidFile }) => {
    // One write: whoever waits for the PID line (a test, a script) already has the other two.
    process.stdout.write([
      t('server.started', { port, pid: process.pid }),
      t('server.data', { dir: cfg.dataDir.replace(/\\/g, '/'), pidFile: pidFile.replace(/\\/g, '/') }),
      t('server.howToStop', { pid: process.pid }),
    ].join('\n') + '\n');
    let leaving = false;
    const leave = (signal) => {
      if (leaving) return;
      leaving = true;
      try { process.stdout.write(`${t('server.stopping', { signal })}\n`); } catch (_) { /* terminal closed */ }
      setTimeout(() => process.exit(0), 3000).unref();
      stop().finally(() => process.exit(0));
    };
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(s, () => leave(s));
    process.on('exit', () => removePidSync(pidFile));
  }).catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
      process.stderr.write(`${t('server.errors.portInUse', { port: cfg.port, pidFile: path.join(cfg.dataDir, 'state', 'panel.pid').replace(/\\/g, '/') })}\n`);
    } else if (e && e.code === 'EACCES') {
      process.stderr.write(`${t('server.errors.portDenied', { port: cfg.port })}\n`);
    } else {
      process.stderr.write(`${t('server.errors.startFailed', { detail: e && e.stack ? e.stack : e })}\n`);
    }
    process.exit(1);
  });
}
