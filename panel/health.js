'use strict';
// health.js · the health badge of the panel (#14), from the new model: maestro.db (items, events, projects) and
// bruto.db (the hook's raw log). Each reason is a code with parameters; the page translates it (ADR 0004).
//
//   evaluateHealth({ items, raw, nowMs, problems, hookFailure }) → { level: green|yellow|red, reasons, last_event_at, last_raw_at }
//
// Rules:
//   database_unreadable {file, detail}   maestro.db (red: the panel shows nothing) or bruto.db (yellow) cannot be read
//   schema_too_new {file, db_version, code_version}
//                                        maestro.db was written by a newer painel-maestro (red, #28): update the code
//   hook_failed {at, error}              the hook could not record a session (hookFailure, bin/hook-failure.js: today
//                                        error is schema_too_new) after its last entry in bruto.db; in place of
//                                        hook_never and hook_stale (yellow, #28)
//   hook_never {last_event_at}           agents recorded work on an active item and the hook never wrote anything
//   hook_stale {last_raw_at, last_event_at, minutes}
//                                        agents recorded work on an active item after the hook's last entry, and that
//                                        entry is older than HOOK_STALE_MS. Only the work of agents (maestro, worker)
//                                        expects the hook: the owner's own records may come from any terminal; and
//                                        without active items nothing is expected (an old raw entry is no problem).
//   projects_unassigned {count, projects} repositories that landed in "Sem organização" and wait for an organization (#6);
//                                        none while "Sem organização" is hidden (#52): the popover never names its projects
//   problems                             codes other parts of the server add (yellow), kept in the order given: the
//                                        merge check's (merge-check.js, #11) and server_outdated (server-outdated.js, #38)
// last_event_at is the agents' last record on an active item; last_raw_at, the hook's last entry.
const path = require('path');

const { UNASSIGNED_ORGANIZATION, SchemaTooNew } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { hiddenOrganizations } = require(path.join(__dirname, 'api-items.js'));

const MIN_MS = 60 * 1000;
const HOOK_STALE_MS = 60 * MIN_MS;
const LEVELS = ['green', 'yellow', 'red'];

const detailOf = (e) => String((e && (e.errstr || e.code || e.message)) || e).slice(0, 200);

/** Reads fn(); { value } or { error } when the database cannot be read (and schemaTooNew: its code, when that is why, #28). */
function attempt(fn) {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: detailOf(e), schemaTooNew: e instanceof SchemaTooNew ? e.error : null };
  }
}

/** The agents' last event (not the owner's) on an active item, or null. */
function lastAgentEvent(store) {
  let last = null;
  for (const { state, events } of store.projectedItems().values()) {
    if (!state.active) continue;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.agent.role === 'owner') continue;
      if (!last || e.id > last.id) last = e;
      break;
    }
  }
  return last;
}

function evaluateHealth({ items, raw, nowMs, problems = [], hookFailure = null }) {
  let level = 0;
  const reasons = [];
  const raise = (n, reason) => {
    level = Math.max(level, n);
    reasons.push(reason);
  };

  const flow = attempt(() => {
    const store = items.store();
    if (!store) return { event: null, unassigned: [] };
    const unassigned = hiddenOrganizations(store).has(UNASSIGNED_ORGANIZATION) ? [] : store.projects().filter((p) => p.organization_id === UNASSIGNED_ORGANIZATION).map((p) => p.id);
    return { event: lastAgentEvent(store), unassigned };
  });
  if (flow.schemaTooNew) raise(2, flow.schemaTooNew);
  else if (flow.error) raise(2, { code: 'database_unreadable', file: 'maestro.db', detail: flow.error });
  const rawRead = attempt(() => {
    const store = raw.store();
    return store ? store.lastAt() : null;
  });
  if (rawRead.error) raise(1, { code: 'database_unreadable', file: 'bruto.db', detail: rawRead.error });

  const event = flow.value ? flow.value.event : null;
  const lastRaw = rawRead.value || null;
  // The hook's own failure (#28) says more than hook_never or hook_stale: it replaces them while it is the newest news.
  const hookFailed = hookFailure && !rawRead.error && (!lastRaw || Date.parse(hookFailure.at) > Date.parse(lastRaw));
  if (hookFailed) raise(1, { code: 'hook_failed', at: hookFailure.at, error: hookFailure.error });
  else if (event && !rawRead.error) {
    const rawT = lastRaw ? Date.parse(lastRaw) : NaN;
    if (!lastRaw) raise(1, { code: 'hook_never', last_event_at: event.at });
    else if (Date.parse(event.at) > rawT && nowMs - rawT > HOOK_STALE_MS) {
      raise(1, { code: 'hook_stale', last_raw_at: lastRaw, last_event_at: event.at, minutes: Math.floor((nowMs - rawT) / MIN_MS) });
    }
  }
  const unassigned = flow.value ? flow.value.unassigned : [];
  if (unassigned.length) raise(1, { code: 'projects_unassigned', count: unassigned.length, projects: unassigned });
  for (const p of problems) raise(1, p);
  return { level: LEVELS[level], reasons, last_event_at: event ? event.at : null, last_raw_at: lastRaw };
}

module.exports = { evaluateHealth, HOOK_STALE_MS };
