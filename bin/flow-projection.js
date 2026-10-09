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
 *   task-dispatched  task_number, payload { floor, worker, branch }            → working
 *   task-status      task_number, payload { state: working|blocked|review|done, text, progress: {done, total} | null,
 *                    maestri: 'posted' | 'failed' | 'outside' }
 *                    → working | blocked | review (a worker's "done" means ready for the maestro: review)
 *   task-integrated  task_number, payload { sha, sha_before }                  → integrated
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

function trackerRef(tracker, number) {
  return tracker === 'azure_devops' ? `PBI ${number}` : `#${number}`;
}

const payloadOf = (e) => ((e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)) ? e.payload : {});
const textOrNull = (v) => (typeof v === 'string' && v.trim() ? v : null);
const isNumber = (v) => Number.isInteger(v) && v > 0;

function newTask(number, title, extra = {}) {
  return {
    number, title, self: false, state: 'waiting', blocked_by: [], worker: null, floor: null, branch: null, sha: null, sha_before: null,
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
        status_text: null, progress: null, dispatched_at: e.at, updated_at: e.at,
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
  for (const e of own) {
    const p = payloadOf(e);
    if (e === start) {
      title = typeof p.title === 'string' ? p.title : null;
      stage = typeof p.stage === 'string' ? p.stage : flow[0] || null;
    } else if (e.type === EVENT_TYPES.stageChanged && typeof p.stage === 'string') {
      if (p.stage === stage) { updatedAt = e.at; continue; }
      stage = p.stage;
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
    tasks: projectTasks(own, start.item_number, title),
    pending_decisions: projectPendingDecisions(own),
  };
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
//     maestri: { workspace, terminal },   where the owner answers (the maestro's Maestri terminal)
//     opened_at, opened_by: { role, name },
//     closed_at, closed_by: { role, name } | null,
//     resolution,               'decision' (resolved with the owner's decision) | 'task_integrated' | null
//     decision,                 what the owner decided (pending-decision-resolved), or null
//     reason,                   why it was canceled (pending-decision-canceled), or null
//   }
//
// Events:
//   pending-decision-opened    task_number?, payload { kind, severity, title, context, options, recommendation,
//                              maestri: { workspace, terminal } }
//   pending-decision-resolved  payload { pending_decision: id, decision }
//   pending-decision-canceled  payload { pending_decision: id, reason }
//   task-integrated            also resolves the open task_review of that task (the review and the OK to integrate are
//                              the same pending decision): resolution 'task_integrated', no extra event is written.
// Only an open pending decision changes; a second resolution or a cancel after it is ignored.

const PENDING_DECISION_KINDS = ['task_review', 'worker_blocked', 'decision', 'finding', 'parallelize', 'hml'];
const PENDING_DECISION_SEVERITIES = ['critical', 'high', 'normal', 'low'];
const PENDING_DECISION_STATUSES = ['open', 'resolved', 'canceled'];

function projectPendingDecisions(list) {
  const byId = new Map();
  const agentOf = (e) => ({ role: (e.agent && e.agent.role) || null, name: (e.agent && e.agent.name) || null });
  const close = (p, e, fields) => Object.assign(p, { closed_at: e.at, closed_by: agentOf(e) }, fields);
  for (const e of list) {
    const p = payloadOf(e);
    if (e.type === EVENT_TYPES.pendingDecisionOpened) {
      const maestri = p.maestri && typeof p.maestri === 'object' ? p.maestri : {};
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
        maestri: { workspace: textOrNull(maestri.workspace), terminal: textOrNull(maestri.terminal) },
        opened_at: e.at,
        opened_by: agentOf(e),
        closed_at: null,
        closed_by: null,
        resolution: null,
        decision: null,
        reason: null,
      });
    } else if (e.type === EVENT_TYPES.pendingDecisionResolved || e.type === EVENT_TYPES.pendingDecisionCanceled) {
      const pd = byId.get(p.pending_decision);
      if (!pd || pd.status !== 'open') continue;
      if (e.type === EVENT_TYPES.pendingDecisionResolved) close(pd, e, { status: 'resolved', resolution: 'decision', decision: textOrNull(p.decision) });
      else close(pd, e, { status: 'canceled', reason: textOrNull(p.reason) });
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

module.exports = {
  projectItem, trackerRef, EVENT_TYPES, TASK_STATES, WORKER_STATES,
  PENDING_DECISION_KINDS, PENDING_DECISION_SEVERITIES, PENDING_DECISION_STATUSES,
};
