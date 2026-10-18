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
 *     tasks: [TaskState]                        the item's tasks, in the order of the task graph
 *     pending_decisions: [PendingDecisionState] in the order they were opened (see the end of this file)
 *   }
 *
 *   TaskState = {
 *     number, title,
 *     self,                    true when the item has no task graph: the item is its own single task
 *     state,                   waiting | working | review | blocked | integrated | out  (TASK_STATES)
 *     blocked_by: [number],    tasks that must be integrated before this one (from the graph)
 *     worker, floor, branch,   from the last task-dispatched (worker falls back to the name of whoever posted status)
 *     mode,                    the dispatch mode of the last task-dispatched (#62): subagents | maestri | orca, or null
 *                              (dispatched before #62)
 *     sha, sha_before,         from task-integrated (the integrating branch after and before the integration)
 *     status_text, progress,   the last task-status: its line of text and { done, total } or null
 *     dispatched_at, integrated_at, updated_at
 *   }
 *
 *   trackerRef(tracker, number) → "#12" (GitHub) | "PBI 3100" (Azure DevOps): the number as the tracker shows it.
 *
 * Event types (others are ignored, so newer events never break an older panel):
 *   item-started     payload { title, stage }  (stage: where the item enters; earlier stages count as done)
 *   stage-changed    payload { stage }
 *   task-graph       payload { tasks: [{ number, title, blocked_by: [number], out: boolean }] }
 *                    the whole graph: the last one replaces the previous ones. A task with out=true is "out".
 *   task-dispatched  task_number, payload { floor, worker, branch, mode }      → working
 *   task-status      task_number, payload { state: working|blocked|review|done, text, progress: {done, total} | null,
 *                    host: { kind: 'orca' | 'maestri' | 'none', result: 'posted' | 'failed' | 'outside' | 'recorded' } }
 *                    (before #62: maestri: 'posted' | 'failed' | 'outside'; 'recorded': the maestro's status, never
 *                    posted, #60). How it went in the Host stays in the timeline only.
 *                    → working | blocked | review (a worker's "done" means ready for the maestro: review)
 *   task-integrated  task_number, payload { sha, sha_before }                  → integrated
 *   PR, final adjustment, HML and conclusion (#9): see the "delivery" block below.
 * Once integrated (or out) a task only leaves that state through a new task-dispatched (rework).
 * Events of a task the graph does not list still show that task, after the graph's ones.
 */

const EVENT_TYPES = {
  itemStarted: 'item-started',
  stageChanged: 'stage-changed',
  taskGraph: 'task-graph',
  taskDispatched: 'task-dispatched',
  taskStatus: 'task-status',
  taskIntegrated: 'task-integrated',
  // pending decisions (#10)
  pendingDecisionOpened: 'pending-decision-opened',
  pendingDecisionResolved: 'pending-decision-resolved',
  pendingDecisionCanceled: 'pending-decision-canceled',
};
const TASK_STATES = ['waiting', 'working', 'review', 'blocked', 'integrated', 'out'];
/** What a worker posts (the states of "maestri floor status") → the state of the task. */
const WORKER_STATES = { working: 'working', blocked: 'blocked', review: 'review', done: 'review' };
/** Where the flow runs (#62, bin/flow-host.js) and the dispatch modes. */
const HOST_KINDS = ['orca', 'maestri', 'none'];
const DISPATCH_MODES = ['subagents', 'maestri', 'orca'];

function trackerRef(tracker, number) {
  return tracker === 'azure_devops' ? `PBI ${number}` : `#${number}`;
}

const payloadOf = (e) => ((e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)) ? e.payload : {});
const textOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);
const isNumber = (v) => Number.isInteger(v) && v > 0;
const objectOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/**
 * Where the owner answers a pending decision: payload.host { kind, workspace, terminal } (#62), or the payload.maestri
 * { workspace, terminal } of an older event read as kind 'maestri'.
 */
function hostOfPending(p) {
  const h = objectOf(p.host);
  if (h && HOST_KINDS.includes(h.kind)) return { kind: h.kind, workspace: textOrNull(h.workspace), terminal: textOrNull(h.terminal) };
  const m = objectOf(p.maestri) || {};
  return { kind: 'maestri', workspace: textOrNull(m.workspace), terminal: textOrNull(m.terminal) };
}

function newTask(number, title, extra = {}) {
  return {
    number, title, self: false, state: 'waiting', blocked_by: [], worker: null, floor: null, branch: null, mode: null, sha: null, sha_before: null,
    status_text: null, progress: null, dispatched_at: null, integrated_at: null, updated_at: null, ...extra,
  };
}

/** The tasks of an item from its events (see TaskState). */
function projectTasks(list, itemNumber, itemTitle) {
  const graphs = list.filter((e) => e.type === EVENT_TYPES.taskGraph && Array.isArray(payloadOf(e).tasks));
  const graph = graphs.length ? graphs[graphs.length - 1] : null;
  const tasks = new Map();
  if (graph) {
    for (const g of payloadOf(graph).tasks) {
      if (!g || !isNumber(g.number) || tasks.has(g.number)) continue;
      tasks.set(g.number, newTask(g.number, textOrNull(g.title), {
        blocked_by: Array.isArray(g.blocked_by) ? g.blocked_by.filter(isNumber) : [],
        state: g.out === true ? 'out' : 'waiting',
        updated_at: graph.at,
      }));
    }
  } else {
    tasks.set(itemNumber, newTask(itemNumber, itemTitle, { self: true }));
  }
  const taskOf = (n) => {
    if (!tasks.has(n)) tasks.set(n, newTask(n, null));
    return tasks.get(n);
  };
  for (const e of list) {
    if (!isNumber(e.task_number)) continue;
    const p = payloadOf(e);
    if (e.type === EVENT_TYPES.taskDispatched) {
      Object.assign(taskOf(e.task_number), {
        state: 'working', floor: textOrNull(p.floor), worker: textOrNull(p.worker), branch: textOrNull(p.branch),
        mode: DISPATCH_MODES.includes(p.mode) ? p.mode : null, status_text: null, progress: null, dispatched_at: e.at, updated_at: e.at,
      });
    } else if (e.type === EVENT_TYPES.taskStatus && WORKER_STATES[p.state]) {
      const t = taskOf(e.task_number);
      if (t.state !== 'integrated' && t.state !== 'out') t.state = WORKER_STATES[p.state];
      t.status_text = textOrNull(p.text);
      const pr = p.progress;
      t.progress = pr && isNumber(pr.total) && Number.isInteger(pr.done) ? { done: pr.done, total: pr.total } : null;
      if (!t.worker && e.agent && textOrNull(e.agent.name)) t.worker = e.agent.name;
      t.updated_at = e.at;
    } else if (e.type === EVENT_TYPES.taskIntegrated) {
      Object.assign(taskOf(e.task_number), {
        state: 'integrated', sha: textOrNull(p.sha), sha_before: textOrNull(p.sha_before), integrated_at: e.at, updated_at: e.at,
      });
    }
  }
  return [...tasks.values()];
}

function projectItem(events, project) {
  const list = Array.isArray(events) ? events : [];
  const start = list.find((e) => e && e.type === EVENT_TYPES.itemStarted);
  if (!start) return null;
  const flow = Array.isArray(project && project.stages) ? project.stages.slice() : [];
  const known = new Set(Object.values(EVENT_TYPES));
  const entered = new Map();
  let title = null;
  let stage = null;
  let stageSince = null;
  let updatedAt = start.at;
  const own = list.slice(list.indexOf(start)).filter(Boolean);
  const delivery = deliveryState();
  for (const e of own) {
    const p = payloadOf(e);
    if (e === start) {
      title = typeof p.title === 'string' ? p.title : null;
      stage = typeof p.stage === 'string' ? p.stage : flow[0] || null;
    } else if (e.type === EVENT_TYPES.stageChanged && typeof p.stage === 'string') {
      delivery.reopen(p.stage);
      if (p.stage === stage) { updatedAt = e.at; continue; }
      stage = p.stage;
    } else if (DELIVERY_TYPES.has(e.type)) {
      const target = delivery.apply(e, p, stage, flow);
      if (target) delivery.reopen(target);
      if (!target || target === stage) { updatedAt = e.at; continue; }
      stage = target;
    } else {
      if (known.has(e.type)) updatedAt = e.at;
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
    ...reviewState(own, projectTasks(own, start.item_number, title)),
    ...delivery.result(stage, stageSince),
    pending_decisions: projectPendingDecisions(own, project),
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
//                                 (in a project without Done the stage stays, but the item leaves the active list too)
//   item-interrupted            payload { reason }                                (the stage stays, #69: the item stopped
//                                 there and will not go on; it leaves the active list)
// After item-done or item-interrupted, any flow event that sets a stage (stage-changed, even to the stage the item is on,
// or a delivery event with a stage of its own) brings it back to the active list, on that event's stage, and clears
// interrupted.
//
// Fields added to ItemState:
//   active            false while the item is in Done, after item-done in a project without Done, or while it is
//                     interrupted (it leaves the active list but can still be read)
//   completed_at      when the item entered Done, or null
//   concluded_at      when the last item-done was recorded (#67, also in a project without Done), or null: never
//                     concluded, interrupted after it, or brought back by a flow event since
//   interrupted       { reason, at, by: { role, name } } of the last item-interrupted, or null (also once a flow event
//                     brought the item back)
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
  itemInterrupted: 'item-interrupted',
});
const DELIVERY_TYPES = new Set(['pr-changed', 'final-adjustment-opened', 'final-adjustment-finished', 'hml-recorded', 'item-done', 'item-interrupted']);
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
  let closed = false; // item-done or item-interrupted recorded and no flow event moved the item since
  let interrupted = null;
  let concludedAt = null;
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
    if (e.type === EVENT_TYPES.itemDone) {
      closed = true;
      concludedAt = e.at;
      return uses('done');
    }
    if (e.type === EVENT_TYPES.itemInterrupted) {
      closed = true;
      concludedAt = null;
      interrupted = { reason: text(p.reason), at: e.at, by: agentOf(e) };
      return null;
    }
    return null;
  }
  /**
   * A flow event moved the item to target: it is no longer interrupted, and it is active again (no longer concluded)
   * unless that is Done.
   */
  function reopen(target) {
    interrupted = null;
    if (target === 'done') return;
    closed = false;
    concludedAt = null;
  }
  function result(stage, stageSince) {
    return {
      active: stage !== 'done' && !closed,
      completed_at: stage === 'done' ? stageSince : null,
      concluded_at: concludedAt,
      interrupted: interrupted && { ...interrupted, by: { ...interrupted.by } },
      pr: pr && { ...pr },
      final_adjustment: adjustment && { ...adjustment },
      hml: hml && { ...hml },
    };
  }
  return { apply, reopen, result };
}

// ---------- pending decisions (#10) ----------
//
//   PendingDecisionState = {
//     id,                       the id of its pending-decision-opened event (unique in maestro.db)
//     kind,                     PENDING_DECISION_KINDS
//     severity,                 PENDING_DECISION_SEVERITIES (unknown → normal)
//     status,                   open | resolved | canceled
//     title, context, options: [text], recommendation,
//     task_number,              the task it is about, or null (the item as a whole)
//     host: { kind, workspace, terminal },   where the owner answers (#62): the maestro's terminal in its Host — in
//                               the Orca the worktree (workspace) and the terminal; in the Maestri the workspace and the
//                               terminal; 'none' a plain terminal. An event before #62 (payload.maestri) reads as 'maestri'.
//     notification,             how the owner was told when it opened (#44): 'sent' (maestri notify, or the worktree
//                               marked unread in the Orca) | 'failed' | 'outside' (a plain terminal) | null (derived, or
//                               opened before #44)
//     opened_at, opened_by: { role, name },
//     closed_at, closed_by: { role, name } | null,
//     resolution,               'decision' (resolved with the owner's decision) | 'task_integrated' | 'hml_approved' |
//                               'item_done' | 'replaced' | null
//     decision,                 what the owner decided (pending-decision-resolved), or null
//     reason,                   why it was canceled (pending-decision-canceled), or null
//   }
//
// Events:
//   pending-decision-opened    task_number?, payload { kind, severity, title, context, options, recommendation,
//                              host: { kind, workspace, terminal }, notification: 'sent' | 'failed' | 'outside' }
//                              (before #62: maestri: { workspace, terminal } in place of host)
//   pending-decision-resolved  payload { pending_decision: id, decision }
//   pending-decision-canceled  payload { pending_decision: id, reason }
//   task-integrated            also resolves the open task_review of that task (the review and the OK to integrate are
//                              the same pending decision): resolution 'task_integrated', no extra event is written.
//   hml-recorded               with failed or blocked scenarios, opens an "hml" pending decision by itself (#1, story
//                              51), derived, with no event of its own: id = the hml-recorded event's id, severity high,
//                              title null and derived_from { type: 'hml-recorded', passed, failed, blocked, card_url }
//                              (the page writes the sentence); where to answer: the environment of the item's last
//                              task-dispatched before it (#60, its mode): maestri → kind 'maestri' with the project's
//                              Maestri workspace; orca → kind 'orca', no worktree known; subagents, or no dispatch
//                              (nor a mode, before #62) → kind 'none'. Rule against duplicates: none is derived
//                              while the item has an open "hml" pending decision (the maestro's own or the derived
//                              one, which then takes the latest numbers). It is resolved by a later hml-recorded with everything passed (resolution 'hml_approved'), by
//                              item-done ('item_done'), by the maestro opening an "hml" one ('replaced') or, like any
//                              other, by pending-decision-resolved/-canceled with its id.
// Only an open pending decision changes; a second resolution or a cancel after it is ignored.
// Every pending decision carries derived_from (null when it was opened by a pending-decision-opened event).

const PENDING_DECISION_KINDS = ['task_review', 'worker_blocked', 'decision', 'finding', 'parallelize', 'hml'];
const PENDING_DECISION_SEVERITIES = ['critical', 'high', 'normal', 'low'];
const PENDING_DECISION_STATUSES = ['open', 'resolved', 'canceled'];
const PENDING_DECISION_NOTIFICATIONS = ['sent', 'failed', 'outside'];
// The longest decision (and cancel reason, and interruption reason, #69), in characters: flow pending resolve, the
// panel's answer (#32) and flow item interrupt.
const MAX_PENDING_DECISION = 2000;

/** Where the owner answers the derived HML pending decision: the environment of the item's last dispatch mode (#60). */
function hostOfMode(mode, project) {
  if (mode === 'maestri') {
    const workspace = project && typeof project.maestri_workspace === 'string' ? textOrNull(project.maestri_workspace) : null;
    return { kind: 'maestri', workspace, terminal: null };
  }
  return { kind: mode === 'orca' ? 'orca' : 'none', workspace: null, terminal: null };
}

/** derived_from of the HML pending decision: the numbers of the last failing result. */
const hmlOrigin = (p, passed, failed, blocked) => ({ type: EVENT_TYPES.hmlRecorded, passed, failed, blocked, card_url: trackerUrl(p.card_url) });

function projectPendingDecisions(list, project) {
  const byId = new Map();
  const agentOf = (e) => ({ role: (e.agent && e.agent.role) || null, name: (e.agent && e.agent.name) || null });
  const close = (p, e, fields) => Object.assign(p, { closed_at: e.at, closed_by: agentOf(e) }, fields);
  let mode = null; // of the item's last task-dispatched so far
  for (const e of list) {
    const p = payloadOf(e);
    if (e.type === EVENT_TYPES.taskDispatched) {
      mode = DISPATCH_MODES.includes(p.mode) ? p.mode : null;
    } else if (e.type === EVENT_TYPES.pendingDecisionOpened) {
      // The maestro's own "hml" pending decision takes the place of the derived one.
      if (p.kind === 'hml') for (const pd of byId.values()) if (pd.status === 'open' && pd.derived_from) close(pd, e, { status: 'resolved', resolution: 'replaced' });
      byId.set(e.id, {
        id: e.id,
        kind: textOrNull(p.kind),
        severity: PENDING_DECISION_SEVERITIES.includes(p.severity) ? p.severity : 'normal',
        status: 'open',
        title: textOrNull(p.title),
        context: textOrNull(p.context),
        options: Array.isArray(p.options) ? p.options.filter((o) => typeof o === 'string' && o.trim()) : [],
        recommendation: textOrNull(p.recommendation),
        task_number: isNumber(e.task_number) ? e.task_number : null,
        host: hostOfPending(p),
        notification: PENDING_DECISION_NOTIFICATIONS.includes(p.notification) ? p.notification : null,
        opened_at: e.at,
        opened_by: agentOf(e),
        closed_at: null,
        closed_by: null,
        resolution: null,
        decision: null,
        reason: null,
        derived_from: null,
      });
    } else if (e.type === EVENT_TYPES.pendingDecisionResolved || e.type === EVENT_TYPES.pendingDecisionCanceled) {
      const pd = byId.get(p.pending_decision);
      if (!pd || pd.status !== 'open') continue;
      if (e.type === EVENT_TYPES.pendingDecisionResolved) close(pd, e, { status: 'resolved', resolution: 'decision', decision: textOrNull(p.decision) });
      else close(pd, e, { status: 'canceled', reason: textOrNull(p.reason) });
    } else if (e.type === EVENT_TYPES.hmlRecorded) {
      const passed = count(p.passed);
      const failed = count(p.failed);
      const blocked = count(p.blocked);
      const openHml = [...byId.values()].filter((pd) => pd.status === 'open' && pd.kind === 'hml');
      const derived = openHml.find((pd) => pd.derived_from);
      if (!failed && !blocked) {
        if (derived) close(derived, e, { status: 'resolved', resolution: 'hml_approved' });
      } else if (derived) {
        Object.assign(derived, { derived_from: hmlOrigin(p, passed, failed, blocked) });
      } else if (!openHml.length) {
        byId.set(e.id, {
          id: e.id, kind: 'hml', severity: 'high', status: 'open', title: null, context: null, options: [], recommendation: null,
          task_number: null, host: hostOfMode(mode, project), notification: null, opened_at: e.at, opened_by: agentOf(e), closed_at: null, closed_by: null,
          resolution: null, decision: null, reason: null, derived_from: hmlOrigin(p, passed, failed, blocked),
        });
      }
    } else if (e.type === EVENT_TYPES.itemDone) {
      for (const pd of byId.values()) if (pd.status === 'open' && pd.derived_from) close(pd, e, { status: 'resolved', resolution: 'item_done' });
    } else if (e.type === EVENT_TYPES.taskIntegrated && isNumber(e.task_number)) {
      for (const pd of byId.values()) {
        if (pd.status === 'open' && pd.kind === 'task_review' && pd.task_number === e.task_number) {
          close(pd, e, { status: 'resolved', resolution: 'task_integrated' });
        }
      }
    }
  }
  return [...byId.values()];
}

// ---------- reports and findings (#8): the worker's report of a task and the maestro's findings ----------
//
// Event types (none of them moves the item's stage):
//   task-report        task_number, payload { status: 'ok' | 'blocked', blocked_reason, branch, sha, tests, changes,
//                      decisions: [text], risks, shared_files: [text], text, diff? }   (texts may have many lines;
//                      diff: the diff summary flow report computed, TaskDiff of bin/flow-diff.js, absent without one)
//   finding-recorded   task_number = the origin task (or null), payload { finding, title, description,
//                      classification: 'defect' | 'owner_decision' | 'discarded', origin_task,
//                      new_task: { number, title } | null }
//   finding-linked     payload { finding, new_task: { number, title } }   a finding that later became a task
//
// Fields added to ItemState:
//   reports    [{ id, at, task_number, agent, status, blocked_reason, branch, sha, tests, changes, decisions,
//                 risks, shared_files, text, diff }]   every report, oldest first (a task may have several); diff
//                 as recorded, or null, with also_in: [task numbers] on each file (#56, computed on read)
//   findings   [{ number, title, description, classification, origin_task, new_task, agent, recorded_at,
//                 linked_at }]   in the order they were recorded
// and to each TaskState: finding (the number of the finding the task came from, or null). The new task of a
// finding is a task of the item in state "out" (for triage) until the graph or a dispatch brings it in.

Object.assign(EVENT_TYPES, {
  taskReport: 'task-report',
  findingRecorded: 'finding-recorded',
  findingLinked: 'finding-linked',
});
const REPORT_STATUSES = ['ok', 'blocked'];
const FINDING_CLASSIFICATIONS = ['defect', 'owner_decision', 'discarded'];

const texts = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const rawText = (v) => (typeof v === 'string' ? v : null);
const agentOf = (e) => ({ role: e.agent && e.agent.role ? e.agent.role : null, name: e.agent && e.agent.name ? e.agent.name : null });

/** The diff summary as recorded (an object), or null. */
const diffOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function newTaskOf(v) {
  return v && isNumber(v.number) ? { number: v.number, title: textOrNull(v.title) } : null;
}

/** { tasks, reports, findings }: the tasks gain the link to their finding; the findings' new tasks join as "out". */
function reviewState(list, tasks) {
  const reports = [];
  const findings = new Map();
  for (const e of list) {
    const p = payloadOf(e);
    if (e.type === EVENT_TYPES.taskReport && isNumber(e.task_number) && REPORT_STATUSES.includes(p.status)) {
      reports.push({
        id: e.id, at: e.at, task_number: e.task_number, agent: agentOf(e), status: p.status, blocked_reason: rawText(p.blocked_reason),
        branch: textOrNull(p.branch), sha: textOrNull(p.sha), tests: rawText(p.tests), changes: rawText(p.changes), decisions: texts(p.decisions),
        risks: rawText(p.risks), shared_files: texts(p.shared_files), text: rawText(p.text), diff: diffOf(p.diff),
      });
    } else if (e.type === EVENT_TYPES.findingRecorded && isNumber(p.finding) && !findings.has(p.finding) && textOrNull(p.title)
      && FINDING_CLASSIFICATIONS.includes(p.classification)) {
      const newTask = newTaskOf(p.new_task);
      findings.set(p.finding, {
        number: p.finding, title: p.title, description: rawText(p.description), classification: p.classification,
        origin_task: isNumber(p.origin_task) ? p.origin_task : null, new_task: newTask, agent: agentOf(e), recorded_at: e.at, linked_at: null,
      });
    } else if (e.type === EVENT_TYPES.findingLinked && findings.has(p.finding) && newTaskOf(p.new_task)) {
      Object.assign(findings.get(p.finding), { new_task: newTaskOf(p.new_task), linked_at: e.at });
    }
  }
  const all = tasks.map((x) => ({ ...x, finding: null }));
  for (const f of findings.values()) {
    if (!f.new_task) continue;
    let task = all.find((x) => x.number === f.new_task.number);
    if (!task) {
      task = newTask(f.new_task.number, f.new_task.title || f.title, { state: 'out', updated_at: f.linked_at || f.recorded_at, finding: f.number });
      all.push(task);
    }
    if (task.finding === null) task.finding = f.number;
    if (!task.title) task.title = f.new_task.title || f.title;
  }
  return { tasks: all, reports: withAlsoIn(reports), findings: [...findings.values()] };
}

/** The paths a file of a diff summary names: its path and, when renamed, the old one (from). */
const pathsOf = (f) => [f.path, f.from].filter((x) => typeof x === 'string');
const filesOf = (diff) => (diff && Array.isArray(diff.files) ? diff.files.filter((f) => f && typeof f === 'object') : []);

/**
 * "também na task #N" (#56): each file of a report's diff gains also_in, the other tasks of the item (ascending, in
 * any state) whose last report with a summary changed the same path (path or from). Computed on read, never recorded.
 */
function withAlsoIn(reports) {
  const lastPathsByTask = new Map();
  for (const r of reports) if (r.diff) lastPathsByTask.set(r.task_number, new Set(filesOf(r.diff).flatMap(pathsOf)));
  const tasksWithSummary = [...lastPathsByTask.keys()].sort((x, y) => x - y);
  // Files as recorded, entries that are not objects included: only the objects gain also_in.
  return reports.map((r) => (!r.diff || !Array.isArray(r.diff.files) ? r : {
    ...r,
    diff: {
      ...r.diff,
      files: r.diff.files.map((f) => (!f || typeof f !== 'object' ? f : {
        ...f,
        also_in: tasksWithSummary.filter((n) => n !== r.task_number && pathsOf(f).some((p) => lastPathsByTask.get(n).has(p))),
      })),
    },
  }));
}

module.exports = {
  projectItem, trackerRef, EVENT_TYPES, TASK_STATES, WORKER_STATES, trackerUrl, PR_STATES, FINAL_ADJUSTMENT_OUTCOMES,
  PENDING_DECISION_KINDS, PENDING_DECISION_SEVERITIES, PENDING_DECISION_STATUSES, MAX_PENDING_DECISION,
  REPORT_STATUSES, FINDING_CLASSIFICATIONS, HOST_KINDS, DISPATCH_MODES,
};
