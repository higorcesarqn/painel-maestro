'use strict';
/**
 * flow-projection.js · the state of an item computed from its events (ADR 0002). Pure: no I/O, no clock,
 * nothing is stored. The API and the screens consume only this projection.
 *
 *   projectItem(events, project) → ItemState | null
 *     events   the item's events, oldest first: { id, at, type, task_number, agent: {role, name}, source, payload }
 *     project  { id, tracker: 'github' | 'azure_devops', stages: ['specification', ...] } (the stages it uses)
 *     null when there is no item-started event (the item does not exist yet).
 *
 *   ItemState = {
 *     number, title, stage,                     current stage (a Stage id)
 *     stages: [{ id, status: 'done' | 'current' | 'pending', entered_at }],   the project's flow, in order
 *     started_at, updated_at, stage_since       moments taken from the events
 *   }
 *
 *   trackerRef(tracker, number) → "#12" (GitHub) | "PBI 3100" (Azure DevOps): the number as the tracker shows it.
 *
 * Event types read in this slice (others are ignored, so newer events never break an older panel):
 *   item-started   payload { title, stage }  (stage: where the item enters; earlier stages count as done)
 *   stage-changed  payload { stage }
 *   PR, final adjustment, HML and conclusion (#9): see the "delivery" block below.
 */

const EVENT_TYPES = { itemStarted: 'item-started', stageChanged: 'stage-changed' };

function trackerRef(tracker, number) {
  return tracker === 'azure_devops' ? `PBI ${number}` : `#${number}`;
}

function projectItem(events, project) {
  const list = Array.isArray(events) ? events : [];
  const start = list.find((e) => e && e.type === EVENT_TYPES.itemStarted);
  if (!start) return null;
  const flow = Array.isArray(project && project.stages) ? project.stages.slice() : [];
  const entered = new Map();
  let title = null;
  let stage = null;
  let stageSince = null;
  let updatedAt = start.at;
  const delivery = deliveryState();
  for (const e of list.slice(list.indexOf(start))) {
    if (!e) continue;
    const p = (e.payload && typeof e.payload === 'object') ? e.payload : {};
    if (e === start) {
      title = typeof p.title === 'string' ? p.title : null;
      stage = typeof p.stage === 'string' ? p.stage : flow[0] || null;
    } else if (e.type === EVENT_TYPES.stageChanged && typeof p.stage === 'string') {
      if (p.stage === stage) { updatedAt = e.at; continue; }
      stage = p.stage;
    } else if (DELIVERY_TYPES.has(e.type)) {
      const target = delivery.apply(e, p, stage, flow);
      if (!target || target === stage) { updatedAt = e.at; continue; }
      stage = target;
    } else {
      continue;
    }
    entered.set(stage, e.at);
    stageSince = e.at;
    updatedAt = e.at;
  }
  // A stage the project no longer declares still shows, at the end, so the item never loses its place.
  if (stage && !flow.includes(stage)) flow.push(stage);
  const current = flow.indexOf(stage);
  return {
    number: start.item_number,
    title,
    stage,
    stages: flow.map((id, i) => ({
      id,
      status: i < current ? 'done' : i === current ? 'current' : 'pending',
      entered_at: i <= current ? entered.get(id) || null : null,
    })),
    started_at: start.at,
    updated_at: updatedAt,
    stage_since: stageSince,
    ...delivery.result(stage, stageSince),
  };
}

// ---------- delivery (#9): integration branch and PR, final adjustment, HML validation and conclusion ----------
//
// Event types (each one moves the item to its stage, when the project uses it; otherwise the stage stays):
//   pr-changed                  payload { state: 'draft' | 'ready' | 'merged', url?, pr_number?, branch? }
//                                 draft → Implementation (only forward: a draft never takes the item back)
//                                 ready → PR ready · merged → Merge. url, pr_number and branch are kept from
//                                 earlier events when a later one does not bring them.
//   final-adjustment-opened     payload {}                                        → Final adjustment
//   final-adjustment-finished   payload { outcome: 'passed' | 'failed', summary? } (the stage stays)
//   hml-recorded                payload { passed, failed, blocked, card_url?, summary? } → HML validation
//   item-done                   payload {}                                        → Done
//
// Fields added to ItemState:
//   active            false while the item is in Done (it leaves the active list but can still be read)
//   completed_at      when the item entered Done, or null
//   pr                { state, url, number, branch, opened_at, ready_at, merged_at } | null
//   final_adjustment  { status: 'open' | 'passed' | 'failed', opened_at, finished_at, summary } | null
//   hml               { outcome: 'approved' | 'failed' | 'blocked', passed, failed, blocked, card_url, summary,
//                       recorded_at } | null
// Links (pr.url, hml.card_url) are only kept for the trackers' domains (trackerUrl); anything else becomes null.

Object.assign(EVENT_TYPES, {
  prChanged: 'pr-changed',
  finalAdjustmentOpened: 'final-adjustment-opened',
  finalAdjustmentFinished: 'final-adjustment-finished',
  hmlRecorded: 'hml-recorded',
  itemDone: 'item-done',
});
const DELIVERY_TYPES = new Set(['pr-changed', 'final-adjustment-opened', 'final-adjustment-finished', 'hml-recorded', 'item-done']);
const PR_STATES = ['draft', 'ready', 'merged'];
const FINAL_ADJUSTMENT_OUTCOMES = ['passed', 'failed'];
const PR_TARGET = { ready: 'pr_ready', merged: 'merge' };
const TRACKER_HOST = /^(github\.com|dev\.azure\.com|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.visualstudio\.com)$/;

/** The URL when it is an https link of a tracker (github.com, dev.azure.com, *.visualstudio.com); otherwise null. */
function trackerUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !TRACKER_HOST.test(u.hostname)) return null;
  return u.href;
}

/** The PR number in a GitHub (/pull/34) or Azure DevOps (/pullrequest/123) URL, or null. */
function prNumberOf(url) {
  const m = /\/(?:pull|pullrequest)\/([1-9]\d{0,8})(?:[/?#]|$)/i.exec(url || '');
  return m ? Number(m[1]) : null;
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const text = (v) => (typeof v === 'string' && v.trim() ? v : null);

function deliveryState() {
  let pr = null;
  let adjustment = null;
  let hml = null;
  /** Records the event; returns the stage it moves the item to (null: it does not move). */
  function apply(e, p, stage, flow) {
    const uses = (s) => (flow.includes(s) ? s : null);
    if (e.type === EVENT_TYPES.prChanged) {
      if (!PR_STATES.includes(p.state)) return null;
      const url = trackerUrl(p.url);
      pr = pr || { state: null, url: null, number: null, branch: null, opened_at: e.at, ready_at: null, merged_at: null };
      pr.state = p.state;
      if (url) pr.url = url;
      const number = Number.isInteger(p.pr_number) && p.pr_number > 0 ? p.pr_number : prNumberOf(url);
      if (number) pr.number = number;
      if (text(p.branch)) pr.branch = p.branch.trim();
      if (p.state === 'ready') pr.ready_at = e.at;
      if (p.state === 'merged') pr.merged_at = e.at;
      if (p.state !== 'draft') return uses(PR_TARGET[p.state]);
      const impl = flow.indexOf('implementation');
      return impl >= 0 && flow.includes(stage) && flow.indexOf(stage) < impl ? 'implementation' : null;
    }
    if (e.type === EVENT_TYPES.finalAdjustmentOpened) {
      adjustment = { status: 'open', opened_at: e.at, finished_at: null, summary: null };
      return uses('final_adjustment');
    }
    if (e.type === EVENT_TYPES.finalAdjustmentFinished) {
      if (!FINAL_ADJUSTMENT_OUTCOMES.includes(p.outcome)) return null;
      adjustment = { status: p.outcome, opened_at: adjustment ? adjustment.opened_at : null, finished_at: e.at, summary: text(p.summary) };
      return null;
    }
    if (e.type === EVENT_TYPES.hmlRecorded) {
      const passed = count(p.passed);
      const failed = count(p.failed);
      const blocked = count(p.blocked);
      const outcome = failed ? 'failed' : blocked ? 'blocked' : 'approved';
      hml = { outcome, passed, failed, blocked, card_url: trackerUrl(p.card_url), summary: text(p.summary), recorded_at: e.at };
      return uses('hml_validation');
    }
    if (e.type === EVENT_TYPES.itemDone) return uses('done');
    return null;
  }
  function result(stage, stageSince) {
    return {
      active: stage !== 'done',
      completed_at: stage === 'done' ? stageSince : null,
      pr: pr && { ...pr },
      final_adjustment: adjustment && { ...adjustment },
      hml: hml && { ...hml },
    };
  }
  return { apply, result };
}

module.exports = { projectItem, trackerRef, EVENT_TYPES, trackerUrl, PR_STATES, FINAL_ADJUSTMENT_OUTCOMES };
