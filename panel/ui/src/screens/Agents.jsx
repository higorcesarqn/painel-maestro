// Agents (#13): the maestros and workers active right now, with no fixed registry. They come from the items
// (GET /api/agents): the maestro of every item not yet Done and the worker of every task being worked on (working,
// review or blocked), each with its item, its task, the last event of the flow and the last time the hook saw one of
// its sessions. The company chosen at the top of the panel (companyFilter) reaches the API as ?company=.
import { useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { readAgents } from '../data/api.js';
import { usePolling } from '../data/polling.js';
import { obj, objs, txt, number, pct, age, dateTime } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Badge, Empty, Skeleton, Segmented } from '../components/base.jsx';
import { Icon, Bot, Layers } from '../components/Icon.jsx';
import { eventText } from './Items.jsx';
import '../styles/agents.css';

const ROLE_TONE = { maestro: 'blue', worker: 'ok' };
const TASK_TONE = { working: 'blue', review: 'warning', blocked: 'danger' };

export function Agents() {
  const { goTo, companyFilter } = usePanel();
  const { answer, error } = usePolling(() => readAgents(companyFilter), [companyFilter]);
  const [role, setRole] = useState('all');
  const all = objs(answer && answer.agents);
  const counts = (answer && obj(answer.counts)) || { maestro: 0, worker: 0 };
  const shown = role === 'all' ? all : all.filter((a) => a.role === role);
  const roles = [
    { id: 'all', name: t('agents.roleFilter.all'), n: all.length },
    { id: 'maestro', name: t('agents.roleFilter.maestro'), n: counts.maestro },
    { id: 'worker', name: t('agents.roleFilter.worker'), n: counts.worker },
  ];
  return (
    <div class="screen screen-agents">
      <Card label={t('agents.title')} info={t('agents.info')} scroll flush
        extra={answer ? t('agents.counts', { maestros: number(counts.maestro), workers: number(counts.worker) }) : null}
        actions={answer && all.length ? <Segmented label={t('agents.roleFilter.label')} value={role} onChange={setRole} options={roles} /> : null}>
        {error && <p class="agents-error" role="alert">{t('agents.readFailed', { message: error.message })}</p>}
        {!answer && !error && <div class="agents-loading"><Skeleton /><Skeleton /><Skeleton /></div>}
        {answer && !all.length && <Empty icon={Bot} center>{t('agents.none')}</Empty>}
        {shown.length > 0 && (
          <div class="table-box">
            <table class="table agents">
              <thead>
                <tr>
                  <th class="col-agent">{t('agents.columns.agent')}</th>
                  <th class="col-item">{t('agents.columns.item')}</th>
                  <th class="col-task">{t('agents.columns.task')}</th>
                  <th>{t('agents.columns.lastEvent')}</th>
                  <th class="col-activity">{t('agents.columns.activity')}</th>
                  <th class="col-usage num" title={t('agents.usageTitle')}>{t('agents.columns.usage')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => <AgentRow key={a.key} a={a} open={() => goTo('items', obj(a.item) ? a.item.key : '')} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AgentRow({ a, open }) {
  const item = obj(a.item) || {};
  const project = obj(a.project) || {};
  const company = obj(project.company);
  const ev = obj(a.last_event);
  const u = obj(a.usage) && obj(a.usage.window_5h);
  return (
    <tr class="clickable" tabindex="0" onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }} title={t('agents.openItem', { item: txt(item.tracker_ref) })}>
      <td class="col-agent">
        <Badge tone={ROLE_TONE[a.role] || 'neutral'}>{t(`agents.roles.${a.role === 'worker' ? 'worker' : 'maestro'}`)}</Badge>
        <span class="agent-name">{txt(a.name) || t('agents.noName')}</span>
      </td>
      <td class="col-item">
        <span class="mono">{txt(item.tracker_ref)}</span> <span title={txt(item.title)}>{txt(item.title)}</span>
        <span class="muted small block">{txt(project.name || project.id)}{company ? ` · ${txt(company.name)}` : ''}</span>
      </td>
      <td class="col-task"><TaskCell a={a} /></td>
      <td>
        {ev ? (
          <>
            <span class="two-lines" title={eventText(ev)}>{eventText(ev)}</span>
            <span class="muted small block" title={dateTime(ev.at)}>{age(ev.at)}</span>
          </>
        ) : <span class="muted">{t('agents.noEvent')}</span>}
      </td>
      <td class="col-activity" title={a.last_activity_at ? dateTime(a.last_activity_at) : t('agents.noSessionTitle')}>
        {a.last_activity_at ? age(a.last_activity_at) : <span class="muted">{t('agents.noSession')}</span>}
      </td>
      <td class="col-usage num" title={u && typeof u.estimated_plan_pct === 'number' ? t('agents.ofPlan', { pct: pct(u.estimated_plan_pct) }) : undefined}>
        {u ? pct(u.consumption_pct) : '—'}
      </td>
    </tr>
  );
}

function TaskCell({ a }) {
  const task = obj(a.task);
  if (a.role !== 'worker' || !task) {
    return <span class="muted"><Icon of={Layers} size={13} /> {t('agents.activeTasks', { count: Number(a.active_tasks) || 0 })}</span>;
  }
  const progress = obj(task.progress);
  return (
    <>
      <span class="mono">{t('agents.taskRef', { number: task.number })}</span> <span title={txt(task.title)}>{txt(task.title) || t('items.tasks.untitled')}</span>
      <span class="block">
        <Badge tone={TASK_TONE[task.state] || 'neutral'}>{t(`items.tasks.states.${task.state}`)}</Badge>
        {task.floor && <span class="muted small"> {t('agents.floor', { floor: txt(task.floor) })}</span>}
        {progress && <span class="muted small"> {t('agents.progress', { done: progress.done, total: progress.total })}</span>}
      </span>
      {task.status_text && <span class="muted small block two-lines" title={txt(task.status_text)}>{txt(task.status_text)}</span>}
    </>
  );
}
