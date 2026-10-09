'use strict';
// health.js · the health badge of the panel (#14), from the new model: maestro.db (items, events, projects) and
// bruto.db (the hook's raw log). Each reason is a code with parameters; the page translates it (ADR 0004).
//
//   evaluateHealth({ items, raw, nowMs, problems }) → { level: green|yellow|red, reasons, last_event_at, last_raw_at }
//
// Rules:
//   database_unreadable {file, detail}   maestro.db (red: the panel shows nothing) or bruto.db (yellow) cannot be read
//   hook_never {last_event_at}           agents recorded work on an active item and the hook never wrote anything
//   hook_stale {last_raw_at, last_event_at, minutes}
//                                        agents recorded work on an active item after the hook's last entry, and that
//                                        entry is older than HOOK_STALE_MS. Only the work of agents (maestro, worker)
//                                        expects the hook: the owner's own records may come from any terminal; and
//                                        without active items nothing is expected (an old raw entry is no problem).
//   projects_unassigned {count, projects} repositories that landed in "Sem empresa" and wait for a company (#6)
//   problems                             codes other parts of the server add (yellow), kept in the order given
// last_event_at is the agents' last record on an active item; last_raw_at, the hook's last entry.
const path = require('path');

const { UNASSIGNED_COMPANY } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));

const MIN_MS = 60 * 1000;
const HOOK_STALE_MS = 60 * MIN_MS;
const LEVELS = ['green', 'yellow', 'red'];

const detailOf = (e) => String((e && (e.errstr || e.code || e.message)) || e).slice(0, 200);

/** Reads fn(); { value } or { error } when the database cannot be read. */
function attempt(fn) {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: detailOf(e) };
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

function evaluateHealth({ items, raw, nowMs, problems = [] }) {
  let level = 0;
  const reasons = [];
  const raise = (n, reason) => {
    level = Math.max(level, n);
    reasons.push(reason);
  };

  const flow = attempt(() => {
    const store = items.store();
    if (!store) return { event: null, unassigned: [] };
    return { event: lastAgentEvent(store), unassigned: store.projects().filter((p) => p.company_id === UNASSIGNED_COMPANY).map((p) => p.id) };
  });
  if (flow.error) raise(2, { code: 'database_unreadable', file: 'maestro.db', detail: flow.error });
  const rawRead = attempt(() => {
    const store = raw.store();
    return store ? store.lastAt() : null;
  });
  if (rawRead.error) raise(1, { code: 'database_unreadable', file: 'bruto.db', detail: rawRead.error });

  const event = flow.value ? flow.value.event : null;
  const lastRaw = rawRead.value || null;
  if (event && !rawRead.error) {
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
