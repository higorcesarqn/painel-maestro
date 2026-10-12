// Tasks of an item (#7): the task graph with its blockers, drawn in our own SVG (the CSP forbids a CDN), and the
// table with state, worker, dispatch mode (#62: subagents, Maestri or Orca; none before #62), floor, branch and SHA of
// each task. The tasks come computed by the server's projection
// (GET /api/items/<project>/<number> → item.tasks); an item without a task graph has one task, itself.
import { arr, obj, objs, txt, truncate, dateTime, age } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Badge } from '../components/base.jsx';
import '../styles/item-tasks.css';

const STATE_TONE = { waiting: 'neutral', working: 'blue', review: 'warning', blocked: 'danger', integrated: 'ok', out: 'neutral' };
const STATES = Object.keys(STATE_TONE);
const NODE_W = 184;
const NODE_H = 54;
const GAP_X = 64;
const GAP_Y = 18;
const PAD = 8;

const stateName = (state) => (STATE_TONE[state] ? t(`items.tasks.states.${state}`) : txt(state));
const MODES = ['subagents', 'maestri', 'orca'];
/** The dispatch mode of a task as the page names it, or null (dispatched before #62, or never). */
const modeName = (mode) => (MODES.includes(mode) ? t(`items.tasks.modes.${mode}`) : null);
/** The task number as the tracker shows it: "#13" on GitHub, the card id on Azure DevOps. */
const taskRef = (tracker, n) => (tracker === 'azure_devops' ? String(n) : `#${n}`);

export function TaskStateBadge({ state }) {
  return <Badge tone={STATE_TONE[state] || 'neutral'} class={`task-state ${state}`}>{stateName(state)}</Badge>;
}

/**
 * Columns by depth: a task without blockers is in column 0, any other one column after its deepest blocker.
 * Returns { nodes: [{ task, x, y }], edges: [{ from, to, done }], width, height }.
 */
export function layoutGraph(tasks) {
  const byNumber = new Map(tasks.map((x) => [x.number, x]));
  const depth = new Map();
  const depthOf = (n, seen = new Set()) => {
    if (depth.has(n)) return depth.get(n);
    if (seen.has(n)) return 0;
    seen.add(n);
    const blockers = arr(byNumber.get(n).blocked_by).filter((b) => byNumber.has(b));
    const d = blockers.length ? 1 + Math.max(...blockers.map((b) => depthOf(b, seen))) : 0;
    depth.set(n, d);
    return d;
  };
  const columns = [];
  for (const x of tasks) {
    const d = depthOf(x.number);
    (columns[d] = columns[d] || []).push(x);
  }
  const position = new Map();
  const nodes = [];
  columns.forEach((col, c) => (col || []).forEach((task, r) => {
    const node = { task, x: PAD + c * (NODE_W + GAP_X), y: PAD + r * (NODE_H + GAP_Y) };
    position.set(task.number, node);
    nodes.push(node);
  }));
  const edges = [];
  for (const x of tasks) {
    for (const b of arr(x.blocked_by)) {
      if (position.has(b)) edges.push({ from: position.get(b), to: position.get(x.number), done: byNumber.get(b).state === 'integrated' });
    }
  }
  const rows = Math.max(1, ...columns.map((col) => (col ? col.length : 0)));
  return {
    nodes,
    edges,
    width: PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * GAP_X,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
  };
}

function TaskGraph({ tasks, tracker }) {
  const { nodes, edges, width, height } = layoutGraph(tasks);
  const summary = t('items.tasks.graphLabel', { count: tasks.length, edges: edges.length });
  return (
    <div class="task-graph-box">
      <svg class="task-graph" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={summary}>
        {edges.map((e) => {
          // The curve leaves and enters horizontally, so the arrowhead (drawn here, no url(#marker)) points right.
          const x1 = e.from.x + NODE_W;
          const y1 = e.from.y + NODE_H / 2;
          const x2 = e.to.x - 2;
          const y2 = e.to.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return (
            <g key={`${e.from.task.number}-${e.to.task.number}`} class={`task-edge${e.done ? ' done' : ''}`}>
              <path class="task-edge-line" d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 6},${y2}`} />
              <path class="task-arrow" d={`M${x2 - 7},${y2 - 4} L${x2},${y2} L${x2 - 7},${y2 + 4} z`} />
            </g>
          );
        })}
        {nodes.map(({ task, x, y }) => (
          <g key={task.number} class={`task-node ${task.state}`} transform={`translate(${x},${y})`}>
            <title>{t('items.tasks.nodeTitle', { ref: taskRef(tracker, task.number), title: txt(task.title), state: stateName(task.state) })}</title>
            <rect width={NODE_W} height={NODE_H} rx="9" />
            <rect class="task-node-stripe" width="3" height={NODE_H - 16} x="0" y="8" rx="1.5" />
            <text x="14" y="21" class="task-node-ref">{taskRef(tracker, task.number)}</text>
            <text x={NODE_W - 12} y="21" class="task-node-state" text-anchor="end">{stateName(task.state)}</text>
            <text x="14" y="41" class="task-node-title">{truncate(task.title || t('items.tasks.untitled'), 25)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function TaskTable({ tasks, tracker }) {
  return (
    <div class="table-box task-table-box">
      <table class="table task-table">
        <thead>
          <tr>
            <th class="col-task">{t('items.tasks.columns.task')}</th>
            <th>{t('items.tasks.columns.title')}</th>
            <th class="col-state">{t('items.tasks.columns.state')}</th>
            <th class="col-blockers">{t('items.tasks.columns.blockedBy')}</th>
            <th class="col-worker">{t('items.tasks.columns.worker')}</th>
            <th class="col-mode">{t('items.tasks.columns.mode')}</th>
            <th class="col-floor">{t('items.tasks.columns.floor')}</th>
            <th class="col-branch">{t('items.tasks.columns.branch')}</th>
            <th class="col-sha">{t('items.tasks.columns.sha')}</th>
            <th class="col-updated">{t('items.tasks.columns.updated')}</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((x) => {
            const progress = obj(x.progress);
            return (
              <tr key={x.number} class={`task-row ${x.state}`}>
                <td class="col-task mono">{taskRef(tracker, x.number)}</td>
                <td class="wrap">
                  <span class="task-title">{txt(x.title) || t('items.tasks.untitled')}</span>
                  {x.self && <span class="muted small">{t('items.tasks.self')}</span>}
                  {x.status_text && (
                    <span class="task-status-text muted small">
                      {progress ? t('items.tasks.statusWithProgress', { text: txt(x.status_text), done: progress.done, total: progress.total }) : txt(x.status_text)}
                    </span>
                  )}
                </td>
                <td class="col-state"><TaskStateBadge state={x.state} /></td>
                <td class="col-blockers mono">{arr(x.blocked_by).map((b) => taskRef(tracker, b)).join(', ') || '—'}</td>
                <td class="col-worker" title={txt(x.worker)}>{txt(x.worker) || '—'}</td>
                <td class="col-mode">{modeName(x.mode) || '—'}</td>
                <td class="col-floor" title={txt(x.floor)}>{txt(x.floor) || '—'}</td>
                <td class="col-branch mono" title={txt(x.branch)}>{txt(x.branch) || '—'}</td>
                <td class="col-sha mono" title={x.sha_before ? t('items.tasks.shaRange', { before: x.sha_before, after: x.sha }) : txt(x.sha)}>{x.sha ? String(x.sha).slice(0, 7) : '—'}</td>
                <td class="col-updated muted" title={dateTime(x.updated_at)}>{x.updated_at ? age(x.updated_at) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The tasks card of the item page: counts per state, the graph and the table. */
export function ItemTasks({ item }) {
  const tasks = objs(item.tasks).filter((x) => Number.isInteger(x.number));
  const counts = STATES.map((s) => [s, tasks.filter((x) => x.state === s).length]).filter(([, n]) => n > 0);
  const extra = counts.map(([s, n]) => t('items.tasks.stateCount', { count: n, state: stateName(s) })).join(' · ');
  return (
    <Card label={t('items.tasks.title')} info={t('items.tasks.info')} extra={extra} class="item-tasks" scroll>
      <TaskGraph tasks={tasks} tracker={item.tracker} />
      <TaskTable tasks={tasks} tracker={item.tracker} />
    </Card>
  );
}
