// Overview (new model, #14): the picture of the day from maestro.db (GET /api/overview): active items by organization,
// project and stage, the owner's open pending decisions, items parked on the same stage for too long and the recent
// activity. The organization of the selector at the top (organizationFilter) narrows all of it. Reads again every 20 s.
// The plan cards read the usage collector (/api/state), as before.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import '../styles/overview.css';
import { usePanel } from '../data/context.js';
import { REFRESH_MS, readOverview } from '../data/api.js';
import { obj, objs, arr, number, pct, age, hm, spDay, now, dayMonthFormat, toDate, elapsedText, dateTime, txt, weekdayShort } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Kpi, Badge, Ring, Empty, Skeleton, InfoHint } from '../components/base.jsx';
import { Icon, ArrowRight, Activity, RefreshCw, Workflow, Inbox, Clock } from '../components/Icon.jsx';
import { pendingTitle, ACTIVE_STAGES, SEVERITIES, SEVERITY_COLOR } from '../data/domain.js';
import { LogEventModal, eventTypeName, eventDetail, agentText } from './LogEventModal.jsx';

const stageName = (id) => t(`items.stages.${id}`);

export function Overview() {
  const { organizationFilter } = usePanel();
  const [read, setRead] = useState({ answer: null, error: null });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const answer = await readOverview(organizationFilter);
      if (mine === seq.current) setRead({ answer, error: null });
    } catch (error) {
      if (mine === seq.current) setRead((r) => ({ answer: r.answer, error }));
    }
  }, [organizationFilter]);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const o = read.answer;
  if (!o) return <OverviewSkeleton error={read.error} />;
  return (
    <div class="screen screen-overview">
      <div class="overview-kpis">
        <ActiveKpi o={o} />
        <PendingKpi o={o} />
        <StaleKpi o={o} />
        <TodayKpi o={o} />
        <PlanKpi kind="5h" />
        <PlanKpi kind="weekly" />
      </div>
      <div class="overview-middle">
        <ActiveItems o={o} error={read.error} />
        <OpenPendingDecisions o={o} />
      </div>
      <div class="overview-bottom">
        <StaleItems o={o} />
        <RecentActivity o={o} />
      </div>
    </div>
  );
}

function OverviewSkeleton({ error }) {
  const block = (n) => Array.from({ length: n }, (_, i) => <div class="card" key={i} style={{ padding: '18px' }}><Skeleton width="40%" height={10} /><Skeleton width="55%" height={30} style={{ marginTop: '16px' }} /></div>);
  return (
    <div class="screen screen-overview" aria-busy="true">
      <div class="overview-kpis">{block(6)}</div>
      <div class="overview-middle">
        {error ? <div class="card"><p class="overview-error" role="alert">{t('overview.readFailed', { message: error.message })}</p></div> : block(1)}
        {block(1)}
      </div>
      <div class="overview-bottom">{block(2)}</div>
    </div>
  );
}

// ---------- numbers on top ----------

function ActiveKpi({ o }) {
  const { goTo } = usePanel();
  const a = obj(o.active) || {};
  const organizations = objs(a.organizations);
  const projects = organizations.reduce((n, c) => n + objs(c.projects).length, 0);
  return (
    <Kpi label={t('overview.activeItems')} value={number(a.total || 0)} onClick={() => goTo('items')}
      detail={t('overview.activeDetail', { projects: t('overview.projectCount', { count: projects }), organizations: t('overview.organizationCount', { count: organizations.length }) })}
      info={t('overview.activeInfo')} />
  );
}

function PendingKpi({ o }) {
  const { goTo } = usePanel();
  const p = obj(o.pending_decisions) || {};
  const bySeverity = obj(p.by_severity) || {};
  const total = p.total || 0;
  const parts = SEVERITIES.filter((s) => bySeverity[s]);
  const summary = parts.map((s) => t('pending.severityCount', { count: bySeverity[s], name: t(`pending.severityPlural.${s}`).toLowerCase() })).join(' · ');
  return (
    <button type="button" class={`card kpi clickable kpi-owner${bySeverity.critical ? ' critical' : total ? ' highlight' : ''}`} onClick={() => goTo('pending')}
      aria-label={summary ? t('overview.pendingAriaWithSummary', { total, summary }) : t('overview.pendingAria', { total })}>
      <span class="label-row">
        <span class="label">{t('overview.pending')}</span>
        <InfoHint title={t('overview.pendingTitle')} text={total ? t('overview.pendingInfo', { summary }) : t('overview.pendingNone')} />
      </span>
      <div class="kpi-row">
        <span class="value">{total}</span>
        {parts.length > 0 && (
          <span class="sev-mini" aria-hidden="true">
            {parts.map((s) => <span key={s}><i style={{ background: SEVERITY_COLOR[s] }} />{bySeverity[s]}</span>)}
          </span>
        )}
      </div>
      {total > 0 && <span class="stripe" aria-hidden="true" style={bySeverity.critical ? { background: 'var(--danger)' } : undefined} />}
    </button>
  );
}

function StaleKpi({ o }) {
  const n = arr(o.stale_items).length;
  return (
    <Kpi label={t('overview.stale')} value={number(n)} highlight={n > 0}
      detail={t('overview.staleDetail', { limit: limitText(o.stale_hours) })} info={t('overview.staleInfo', { limit: limitText(o.stale_hours) })} />
  );
}

function TodayKpi({ o }) {
  const { goTo } = usePanel();
  return <Kpi label={t('overview.eventsToday')} value={number(o.events_today || 0)} onClick={() => goTo('log')} info={t('overview.eventsTodayInfo')} />;
}

/** "48 h" or "3 dias" for the stale limit. */
function limitText(hours) {
  const h = Number(hours) || 0;
  return h >= 48 && h % 24 === 0 ? t('overview.days', { count: h / 24 }) : t('overview.hours', { count: h });
}

/** "07:10" on the same day; otherwise "seg 01:00". */
function shortWhen(v) {
  const d = toDate(v);
  if (!d) return '';
  return spDay(d) === spDay(now()) ? hm(d) : `${weekdayShort(d).toLowerCase()} ${hm(d)}`;
}

function PlanKpi({ kind }) {
  const { state, goTo } = usePanel();
  const ku = (state && obj(state.kpis) && obj(state.kpis.usage)) || {};
  const value = kind === '5h' ? ku.window_5h_pct : ku.weekly_pct;
  const reset = kind === '5h' ? ku.reset_5h : ku.weekly_reset;
  const reason = kind === '5h' ? ku.window_5h_reason : ku.weekly_reason;
  const has = typeof value === 'number';
  const label = kind === '5h' ? t('overview.plan5h') : t('overview.planWeekly');
  const longName = kind === '5h' ? t('overview.plan5hLong') : t('overview.planWeeklyLong');
  const info = has
    ? t('overview.planInfo', {
      name: longName, pct: pct(value), age: elapsedText(ku.age_min),
      reset: reset ? t('overview.planResets', { when: txt(shortWhen(reset)) }) : '',
    })
    : t('overview.planUnavailableInfo', { name: longName, reason: txt(reason || ku.reason) || t('overview.noMaestriData') });
  return (
    <button type="button" class="card kpi clickable" onClick={() => goTo('usage')} aria-label={t('overview.planAria', { name: longName, value: has ? pct(value) : t('common.unavailable') })}>
      <span class="label-row"><span class="label">{label}</span><InfoHint text={info} /></span>
      <div class="kpi-row" style={{ alignItems: 'center' }}>
        <div class="kpi-plan-text">
          <span class="value medium">{has ? Math.round(value) : '—'}{has && <small>%</small>}</span>
          {has && reset
            ? <span class="detail reset" title={t('overview.resetsAt', { when: shortWhen(reset) })}><Icon of={RefreshCw} size={11} />{shortWhen(reset)}</span>
            : <span class="detail">{has ? t('overview.noReset') : t('common.unavailable')}</span>}
        </div>
        <Ring value={has ? value : null} size={54} thickness={5} label={longName} center="" />
      </div>
    </button>
  );
}

// ---------- active items by organization, project and stage ----------

function ActiveItems({ o, error }) {
  const { goTo } = usePanel();
  const a = obj(o.active) || {};
  const organizations = objs(a.organizations);
  const used = new Set(organizations.flatMap((c) => objs(c.projects).flatMap((p) => arr(p.stages))));
  const stages = ACTIVE_STAGES.filter((s) => used.has(s)); // only active items are counted: never "done"
  const byStage = obj(a.by_stage) || {};
  const cell = (p, s) => {
    const n = (obj(p.by_stage) || {})[s] || 0;
    if (!arr(p.stages).includes(s)) return <td key={s} class="num off" title={t('overview.stageNotUsed')} />;
    return <td key={s} class={`num${n ? '' : ' faint'}`}>{n ? number(n) : '·'}</td>;
  };
  return (
    <Card label={t('overview.activeTitle')} info={t('overview.activeTableInfo')} extra={t('overview.itemCount', { count: a.total || 0 })} scroll flush
      actions={<button type="button" class="link small go-link" onClick={() => goTo('items')}>{t('overview.openItems')} <Icon of={ArrowRight} size={13} /></button>}>
      {error && <p class="overview-error" role="alert">{t('overview.readFailed', { message: error.message })}</p>}
      {!organizations.length && <Empty icon={Workflow} center>{t('overview.noActive')}</Empty>}
      {organizations.length > 0 && (
        <div class="table-box">
          <table class="table overview-stages">
            <thead>
              <tr>
                <th>{t('overview.columns.project')}</th>
                {stages.map((s) => <th key={s} class="num" title={stageName(s)}>{stageName(s)}</th>)}
                <th class="num">{t('overview.columns.total')}</th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((c) => [
                <tr key={`c-${c.id}`} class={`organization-row${c.unassigned ? ' unassigned' : ''}`}>
                  <th scope="rowgroup" colSpan={stages.length + 1}>{txt(c.name)}</th>
                  <td class="num">{number(c.total || 0)}</td>
                </tr>,
                ...objs(c.projects).map((p) => (
                  <tr key={`p-${c.id}-${p.id}`} class="clickable" tabindex="0" onClick={() => goTo('items')} onKeyDown={(e) => { if (e.key === 'Enter') goTo('items'); }}>
                    <td class="project-cell" title={txt(p.name)}>{txt(p.name)}</td>
                    {stages.map((s) => cell(p, s))}
                    <td class="num strong">{number(p.total || 0)}</td>
                  </tr>
                )),
              ])}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('overview.columns.total')}</th>
                {stages.map((s) => <td key={s} class="num">{number(byStage[s] || 0)}</td>)}
                <td class="num strong">{number(a.total || 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------- open pending decisions ----------

function OpenPendingDecisions({ o }) {
  const { goTo, goToPendingDecision } = usePanel();
  const p = obj(o.pending_decisions) || {};
  const open = objs(p.open);
  const more = (p.total || 0) - open.length;
  return (
    <Card label={t('overview.openPending')} info={t('overview.openPendingInfo')} extra={t('overview.openCount', { count: p.total || 0 })} scroll flush
      actions={<button type="button" class="link small go-link" onClick={() => goTo('pending')}>{t('overview.openPendingScreen')} <Icon of={ArrowRight} size={13} /></button>}>
      {!open.length && <Empty icon={Inbox} center>{t('overview.pendingNone')}</Empty>}
      <div class="list overview-pending">
        {open.map((x) => {
          const it = obj(x.item) || {};
          const project = obj(it.project) || {};
          return (
            <button type="button" key={x.id} class="list-item" onClick={() => goToPendingDecision(`P-${x.id}`)}>
              <span class={`overview-sev is-${x.severity}`} aria-hidden="true" />
              <span class="overview-pending-main">
                <span class="truncate" title={pendingTitle(x)}>{pendingTitle(x)}</span>
                <span class="muted tiny">{t('overview.pendingLine', { id: x.id, kind: t(`pending.kinds.${x.kind}`), ref: txt(it.tracker_ref), project: txt(project.name) })}</span>
              </span>
              <span class="muted tiny" title={dateTime(x.opened_at)}>{age(x.opened_at)}</span>
            </button>
          );
        })}
        {more > 0 && <p class="muted small overview-more">{t('overview.morePending', { count: more })}</p>}
      </div>
    </Card>
  );
}

// ---------- items parked on the same stage ----------

function StaleItems({ o }) {
  const { goTo } = usePanel();
  const list = objs(o.stale_items);
  return (
    <Card label={t('overview.staleTitle', { limit: limitText(o.stale_hours) })} info={t('overview.staleInfo', { limit: limitText(o.stale_hours) })} scroll flush>
      {!list.length && <Empty icon={Clock} center>{t('overview.noStale')}</Empty>}
      <div class="list overview-stale">
        {list.map((it) => {
          const project = obj(it.project) || {};
          const organization = obj(project.organization) || {};
          return (
            <button type="button" key={it.key} class="list-item" onClick={() => goTo('items', it.key)}
              aria-label={t('overview.staleAria', { ref: txt(it.tracker_ref), title: txt(it.title), stage: stageName(it.stage), age: age(it.stage_since) })}>
              <span class="mono">{txt(it.tracker_ref)}</span>
              <span class="overview-pending-main">
                <span class="truncate" title={txt(it.title)}>{txt(it.title)}</span>
                <span class="muted tiny">{[txt(project.name), txt(organization.name)].filter(Boolean).join(' · ')}</span>
              </span>
              <Badge tone="warning">{stageName(it.stage)}</Badge>
              <span class="muted small" title={dateTime(it.stage_since)}>{age(it.stage_since)}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// ---------- recent activity ----------

function RecentActivity({ o }) {
  const { goTo } = usePanel();
  const [open, setOpen] = useState(null);
  const events = objs(o.recent_events);
  const today = spDay(now());
  return (
    <Card label={t('overview.recent')} info={t('overview.recentInfo')} scroll flush
      actions={<button type="button" class="link small go-link" onClick={() => goTo('log')}>{t('overview.openLog')} <Icon of={ArrowRight} size={13} /></button>}>
      {!events.length && <Empty icon={Activity} center>{t('common.noEvents')}</Empty>}
      <div class="list activity">
        {events.map((e) => {
          const project = obj(e.project) || {};
          return (
            <button type="button" key={e.id} class="list-item" onClick={() => setOpen(e.id)}
              aria-label={t('overview.recentAria', { time: dateTime(e.at), ref: txt(e.tracker_ref), event: eventTypeName(e.type) })}>
              <span class="muted small" title={dateTime(e.at)}>{spDay(e.at) === today ? hm(e.at) : `${dayMonthFormat.format(toDate(e.at) || new Date(0))} ${hm(e.at)}`}</span>
              <span class="mono small">{txt(e.tracker_ref)}</span>
              <span class="truncate" title={txt(e.item_title)}>
                <Badge>{eventTypeName(e.type)}</Badge> <span class="text-2">{eventDetail(e) || txt(e.item_title)}</span>
              </span>
              <span class="muted tiny truncate">{agentText(e.agent) || txt(project.name)}</span>
            </button>
          );
        })}
      </div>
      {open !== null && <LogEventModal id={open} ids={events.map((e) => e.id)} onOpen={setOpen} onClose={() => setOpen(null)} />}
    </Card>
  );
}
