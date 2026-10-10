'use strict';
// api-overview.js · the Overview of the new model (#14): the picture of the day, from maestro.db, computed on every
// request by the same code as the other screens (api-items.js, api-pending-decisions.js and the Log's api-log.js);
// nothing derived is stored (ADR 0002).
//
//   GET /api/overview[?organization=<id>] → {
//     generated_at, organization (the filter or null), stale_hours (PANEL_STALE_HOURS),
//     active: { total, by_stage: {stage: n}, organizations: [{ id, name, unassigned, total,
//               projects: [{ id, name, tracker, stages, total, by_stage: {stage: n} }] }] },
//                                     active items; "Sem organização" last, the rest alphabetical
//     pending_decisions: { total, by_severity: {critical, high, normal, low}, open: [{ id, kind, severity, title, derived_from,
//                          opened_at, item, task }] }   the open ones, the most urgent first (at most 8 listed)
//     stale_items: [{ key, project, number, tracker_ref, title, stage, stage_since, updated_at, hours }]
//                                     active items on the same stage for at least stale_hours, the longest first
//     events_today: n,                events recorded today (São Paulo)
//     recent_events: [LogEvent]       the last 12 events, newest first, in the shape of GET /api/log
//   }
// The organization filter is the one of the selector at the top of the page. No sentences: errors are codes (ADR 0004):
// 400 invalid_filter for an organization that is not an id; 503 database_unreadable when maestro.db cannot be read
// (503 schema_too_new, from the server, when a newer painel-maestro wrote it, #28).
const path = require('path');

const { UNASSIGNED_ORGANIZATION, SchemaTooNew } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { isoSP } = require(path.join(__dirname, '..', 'bin', 'lib.js'));
const { listItems } = require(path.join(__dirname, 'api-items.js'));
const { ProjectsError } = require(path.join(__dirname, 'api-projects.js'));
const { listPendingDecisions } = require(path.join(__dirname, 'api-pending-decisions.js'));
const { listLog } = require(path.join(__dirname, 'api-log.js'));

const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PENDING_LIMIT = 8;   // open pending decisions listed (the most urgent; the total counts them all)
const RECENT_LIMIT = 12;   // events of the recent activity
const HOUR_MS = 60 * 60 * 1000;

/** ?organization=<id>: null when absent; 400 invalid_filter when it is not an id. */
function organizationParam(query) {
  const v = query && query.get('organization');
  if (v === null || v === undefined || v === '') return null;
  if (!RE_ID.test(v)) throw new ProjectsError(400, { code: 'invalid_filter', param: 'organization', value: String(v).slice(0, 100) });
  return v;
}

const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id);

/** Active items by organization, project and stage ("Sem organização" last, then alphabetical). */
function activeSummary(items, projects) {
  const organizations = new Map();
  const byStage = {};
  for (const it of items) {
    const project = projects.get(it.project.id);
    if (!project) continue;
    const c = it.project.organization;
    if (!organizations.has(c.id)) organizations.set(c.id, { id: c.id, name: c.name, unassigned: c.id === UNASSIGNED_ORGANIZATION, total: 0, projects: new Map() });
    const organization = organizations.get(c.id);
    if (!organization.projects.has(project.id)) {
      organization.projects.set(project.id, { id: project.id, name: project.name, tracker: project.tracker, stages: project.stages, total: 0, by_stage: {} });
    }
    const p = organization.projects.get(project.id);
    organization.total++;
    p.total++;
    bump(p.by_stage, it.stage);
    bump(byStage, it.stage);
  }
  const list = [...organizations.values()].map((c) => ({ ...c, projects: [...c.projects.values()].sort(byName) }));
  list.sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || byName(a, b));
  return { total: items.length, by_stage: byStage, organizations: list };
}

// The Log's reading also asks bruto.db for its last entry; the Overview does not need it.
const NO_RAW = { store: () => null };

/** GET /api/overview. items: the items source (api-items.js), lazily opened maestro.db. */
function overview(items, query, { nowMs, staleHours }) {
  const organization = organizationParam(query);
  try {
    return picture(items, organization, nowMs, staleHours);
  } catch (e) {
    if (e instanceof ProjectsError || e instanceof SchemaTooNew) throw e;
    throw new ProjectsError(503, { code: 'database_unreadable', file: 'maestro.db', detail: String(e && (e.errstr || e.code || e.message)).slice(0, 200) });
  }
}

function picture(items, organization, nowMs, staleHours) {
  const raw = NO_RAW;
  const answer = { generated_at: isoSP(new Date(nowMs)), organization, stale_hours: staleHours };
  const store = items.store();
  const projects = new Map((store ? store.projects() : []).map((p) => [p.id, p]));
  const active = listItems(items, { active: true }).items.filter((it) => !organization || it.project.organization.id === organization);
  const filter = organization ? { organization } : {};
  const pending = listPendingDecisions(items, new URLSearchParams({ ...filter, status: 'open' }));
  const recent = listLog(items, raw, new URLSearchParams({ ...filter, per_page: String(RECENT_LIMIT) }), nowMs);
  const today = listLog(items, raw, new URLSearchParams({ ...filter, since: isoSP(new Date(nowMs)).slice(0, 10), per_page: '1' }), nowMs);
  return {
    ...answer,
    active: activeSummary(active, projects),
    pending_decisions: {
      total: pending.pending_decisions.length,
      by_severity: pending.counts.severity,
      open: pending.pending_decisions.slice(0, PENDING_LIMIT).map(pendingSummary),
    },
    stale_items: staleItems(active, nowMs, staleHours),
    events_today: today.total,
    recent_events: recent.events,
  };
}

/** The open pending decision as the Overview lists it (the whole one is on the Pendências screen). */
function pendingSummary(p) {
  return { id: p.id, kind: p.kind, severity: p.severity, title: p.title, derived_from: p.derived_from, opened_at: p.opened_at, item: p.item, task: p.task };
}

/** Active items on the same stage for at least staleHours, the longest parked first. */
function staleItems(items, nowMs, staleHours) {
  const out = [];
  for (const it of items) {
    const since = Date.parse(it.stage_since);
    if (!Number.isFinite(since)) continue;
    const hours = Math.floor((nowMs - since) / HOUR_MS);
    if (nowMs - since < staleHours * HOUR_MS) continue;
    out.push({
      key: it.key, project: it.project, number: it.number, tracker_ref: it.tracker_ref, title: it.title,
      stage: it.stage, stage_since: it.stage_since, updated_at: it.updated_at, hours,
    });
  }
  return out.sort((a, b) => b.hours - a.hours || a.key.localeCompare(b.key));
}

module.exports = { overview };
