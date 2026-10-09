// Items (new model, maestro.db): the list of items and, at #items/<project>/<number>, the page of one item with its
// current stage and the stages of its flow. That address is fixed: the Maestri portal opens it straight.
// The state of each item comes computed from its events by the server (GET /api/items and /api/items/<p>/<n>);
// the page only shows it. Reads again every 20 s while the screen is open.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { REFRESH_MS, readItems, readItem } from '../data/api.js';
import { arr, obj, objs, txt, number, age, dateTime } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Badge, Empty, Skeleton } from '../components/base.jsx';
import { Icon, Workflow, ArrowLeft, Check, CircleDashed } from '../components/Icon.jsx';
import { ItemTasks } from './ItemTasks.jsx';
import { ItemDelivery, deliveryEventText, useDoneFilter } from './ItemDelivery.jsx';
import '../styles/items.css';

const RE_ITEM = /^([a-z0-9][a-z0-9-]*)\/([1-9]\d*)$/;
const stageName = (id) => t(`items.stages.${id}`);
const companyName = (it) => txt(obj(it.project) && obj(it.project.company) ? it.project.company.name : '');
const projectName = (it) => txt(obj(it.project) ? it.project.name || it.project.id : '');

/** Reads with fn() now and every 20 s; keeps the last good answer when a read fails. */
function usePolling(fn, deps) {
  const [read, setRead] = useState({ answer: null, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const answer = await fn();
      if (mine === seq.current) setRead({ answer, error: null });
    } catch (error) {
      if (mine === seq.current) setRead((r) => ({ answer: error.status === 404 ? null : r.answer, error }));
    }
  }, deps);
  useEffect(() => {
    setRead({ answer: null, error: null });
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  return read;
}

export function Items() {
  const { subroute } = usePanel();
  const m = RE_ITEM.exec(subroute || '');
  return m ? <ItemPage project={m[1]} number={Number(m[2])} /> : <ItemList />;
}

function ItemList() {
  const { goTo } = usePanel();
  const { answer, error } = usePolling(() => readItems(), []);
  const all = objs(answer && answer.items);
  const { shown: items, control: doneFilter, which } = useDoneFilter(all);
  const open = (it) => goTo('items', it.key);
  return (
    <div class="screen screen-items">
      <Card label={t('items.title')} extra={answer ? t('items.count', { count: items.length }) : null} info={t('items.listInfo')} actions={answer && all.length ? doneFilter : null} scroll flush>
        {error && <p class="items-error" role="alert">{t('items.readFailed', { message: error.message })}</p>}
        {!answer && !error && <div class="items-loading"><Skeleton /><Skeleton /><Skeleton /></div>}
        {answer && !all.length && <Empty icon={Workflow} center>{t('items.none')}</Empty>}
        {answer && all.length > 0 && !items.length && <Empty icon={Workflow} center>{t(`delivery.listFilter.none.${which}`)}</Empty>}
        {items.length > 0 && (
          <div class="table-box">
            <table class="table items">
              <thead>
                <tr>
                  <th class="col-ref">{t('items.columns.item')}</th>
                  <th>{t('items.columns.title')}</th>
                  <th class="col-stage">{t('items.columns.stage')}</th>
                  <th class="col-project">{t('items.columns.project')}</th>
                  <th class="col-updated">{t('items.columns.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.key} class="clickable" tabindex="0" onClick={() => open(it)}
                    onKeyDown={(e) => { if (e.key === 'Enter') open(it); }}>
                    <td class="col-ref mono">{txt(it.tracker_ref)}</td>
                    <td title={txt(it.title)}>{txt(it.title)}</td>
                    <td class="col-stage"><StageBadge stage={it.stage} /></td>
                    <td class="col-project" title={companyName(it)}>{projectName(it)}<span class="muted"> · {companyName(it)}</span></td>
                    <td class="col-updated" title={dateTime(it.updated_at)}>{age(it.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function StageBadge({ stage }) {
  return <Badge tone={stage === 'done' ? 'ok' : 'blue'}>{stageName(stage)}</Badge>;
}

function ItemPage({ project, number: itemNumber }) {
  const { goTo } = usePanel();
  const { answer, error } = usePolling(() => readItem(project, itemNumber), [project, itemNumber]);
  const item = answer && obj(answer.item);
  const back = (
    <button type="button" class="button" onClick={() => goTo('items')}><Icon of={ArrowLeft} size={15} />{t('items.back')}</button>
  );
  if (!item) {
    return (
      <div class="screen screen-item">
        <Card label={t('items.itemLabel', { key: `${project}/${itemNumber}` })} actions={back}>
          {error ? <p class="items-error" role="alert">{error.message}</p> : <div class="items-loading"><Skeleton /><Skeleton /></div>}
        </Card>
      </div>
    );
  }
  const stages = objs(item.stages);
  const timeline = objs(item.timeline);
  return (
    <div class="screen screen-item">
      <Card label={t('items.itemLabel', { key: item.key })} actions={back}>
        <div class="item-head">
          <div class="item-ref">
            <span class="item-number mono">{txt(item.tracker_ref)}</span>
            <span class="muted">{t('items.projectOf', { project: projectName(item), company: companyName(item) })}</span>
            <Badge>{t(`items.trackers.${item.tracker}`)}</Badge>
          </div>
          <h2 class="item-title">{txt(item.title)}</h2>
          <div class="item-current">
            <span class="label">{t('items.currentStage')}</span>
            <StageBadge stage={item.stage} />
            <span class="muted small">{t('items.since', { when: dateTime(item.stage_since), age: age(item.stage_since) })}</span>
          </div>
        </div>
      </Card>
      <ItemDelivery item={item} />
      <ItemTasks item={item} />
      <div class="item-grid">
        <Card label={t('items.flowTitle')} info={t('items.flowInfo')}>
          <ol class="stage-list">
            {stages.map((s) => (
              <li key={s.id} class={`stage ${s.status}`} aria-current={s.status === 'current' ? 'step' : undefined}>
                <span class="stage-mark" aria-hidden="true">
                  {s.status === 'done' ? <Icon of={Check} size={14} /> : s.status === 'current' ? <span class="stage-dot" /> : <Icon of={CircleDashed} size={14} />}
                </span>
                <span class="stage-name">{stageName(s.id)}</span>
                <span class="stage-status muted small">{t(`items.stageStatus.${s.status}`)}</span>
                <span class="stage-when muted small">{s.entered_at ? dateTime(s.entered_at) : ''}</span>
              </li>
            ))}
          </ol>
        </Card>
        <Card label={t('items.timelineTitle')} extra={t('items.eventCount', { count: timeline.length })} scroll>
          <ol class="item-timeline">
            {timeline.slice().reverse().map((e) => (
              <li key={e.id}>
                <span class="muted small mono">{dateTime(e.at)}</span>
                <span>{eventText(e)}</span>
                <span class="muted small">{agentText(e.agent)}</span>
              </li>
            ))}
          </ol>
          <p class="tiny faint item-dates">{t('items.dates', { started: dateTime(item.started_at), updated: dateTime(item.updated_at), events: number(timeline.length) })}</p>
        </Card>
      </div>
    </div>
  );
}

function eventText(e) {
  const p = obj(e.payload) || {};
  if (e.type === 'item-started') return t('items.events.itemStarted', { stage: stageName(p.stage) });
  if (e.type === 'stage-changed') return t('items.events.stageChanged', { stage: stageName(p.stage) });
  if (e.type === 'task-graph') return t('items.events.taskGraph', { count: arr(p.tasks).length });
  if (e.type === 'task-dispatched') return t('items.events.taskDispatched', { task: e.task_number, worker: txt(p.worker) || '—', floor: txt(p.floor) || '—' });
  if (e.type === 'task-status') return t('items.events.taskStatus', { task: e.task_number, state: t(`items.tasks.workerStates.${p.state}`), text: txt(p.text) });
  if (e.type === 'task-integrated') return t('items.events.taskIntegrated', { task: e.task_number, sha: txt(p.sha).slice(0, 7) });
  const delivery = deliveryEventText(e);
  if (delivery) return delivery;
  // pending decisions (#10): the owner's decision stays in the timeline
  if (e.type === 'pending-decision-opened') return t('items.events.pendingOpened', { id: e.id, kind: t(`pending.kinds.${p.kind}`), title: txt(p.title) });
  if (e.type === 'pending-decision-resolved') return t('items.events.pendingResolved', { id: p.pending_decision, decision: txt(p.decision) });
  if (e.type === 'pending-decision-canceled') {
    return p.reason ? t('items.events.pendingCanceledWhy', { id: p.pending_decision, reason: txt(p.reason) }) : t('items.events.pendingCanceled', { id: p.pending_decision });
  }
  return txt(e.type);
}

function agentText(agent) {
  const a = obj(agent) || {};
  const role = a.role ? t(`items.roles.${a.role}`) : '';
  return arr([role, txt(a.name)]).filter(Boolean).join(' · ');
}
