// Overview: what needs the owner, the plan, the week's activity and the agents.
// The card holds the number and the signal; the explanation of each one sits in the (i) icon next to the label.
import '../styles/overview.css';
import { usePanel } from '../data/context.js';
import { obj, objs, arr, number, pct, age, time, hm, spDay, now, dayMonthFormat, toDate, elapsedText, txt, spHour, weekdayShort } from '../data/format.js';
import { SEVERITIES, severityName, severityPlural, SEVERITY_TONE, RESULTS, resultName, FAILURE_RESULTS, needsOwner, agentInfo, typeName } from '../data/domain.js';
import { t } from '../i18n/index.js';
import { Card, Kpi, Badge, Dot, Ring, Empty, Skeleton, InfoHint } from '../components/base.jsx';
import { BarChart, Donut, Sparkline, Legend } from '../components/charts.jsx';
import { Agent, Result } from '../components/domain.jsx';
import { Icon, ArrowRight, Activity, RefreshCw } from '../components/Icon.jsx';

export function Overview() {
  const { state } = usePanel();
  if (!state) return <OverviewSkeleton />;
  return (
    <div class="screen screen-overview">
      <div class="overview-kpis">
        <PendingKpi />
        <PlanKpi kind="5h" />
        <PlanKpi kind="weekly" />
        <EventsTodayKpi />
      </div>
      <div class="overview-charts">
        <WeekActivity />
        <WeekResults />
      </div>
      <div class="overview-bottom">
        <AgentList />
        <RecentActivity />
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  const block = (n) => Array.from({ length: n }, (_, i) => <div class="card" key={i} style={{ padding: '18px' }}><Skeleton width="40%" height={10} /><Skeleton width="55%" height={30} style={{ marginTop: '16px' }} /></div>);
  return (
    <div class="screen screen-overview" aria-busy="true">
      <div class="overview-kpis">{block(4)}</div>
      <div class="overview-charts">{block(2)}</div>
      <div class="overview-bottom">{block(2)}</div>
    </div>
  );
}

// Color of each severity in the dots of the pending decisions card (same colors as the badges).
const TONE_COLOR = { danger: 'var(--danger)', warning: 'var(--warning)', blue: 'var(--blue-text)', neutral: 'var(--muted)' };
const severityCount = (n, s) => t('severity.count', { count: n, name: n === 1 ? severityName(s) : severityPlural(s) });

function PendingKpi() {
  const { state, goTo } = usePanel();
  const kp = (obj(state.kpis) && obj(state.kpis.pending_decisions)) || { total: 0 };
  const bySeverity = obj(kp.by_severity) || {};
  const total = kp.total || 0;
  const parts = SEVERITIES.filter((s) => bySeverity[s]);
  const summary = parts.map((s) => severityCount(bySeverity[s], s)).join(' · ');
  return (
    <button type="button" class={`card kpi clickable kpi-owner${bySeverity.critica ? ' critical' : total ? ' highlight' : ''}`} onClick={() => goTo('pending')}
      aria-label={summary ? t('overview.pendingAriaWithSummary', { total, summary }) : t('overview.pendingAria', { total })}>
      <span class="label-row">
        <span class="label">{t('overview.pending')}</span>
        <InfoHint title={t('overview.pendingTitle')} text={total ? t('overview.pendingInfo', { summary }) : t('overview.pendingNone')} />
      </span>
      <div class="kpi-row">
        <span class="value">{total}</span>
        {parts.length > 0 && (
          <span class="sev-mini" aria-hidden="true">
            {parts.map((s) => (
              <span key={s} title={severityCount(bySeverity[s], s)}><i style={{ background: TONE_COLOR[SEVERITY_TONE[s]] }} />{bySeverity[s]}</span>
            ))}
          </span>
        )}
      </div>
      {total > 0 && <span class="stripe" aria-hidden="true" style={bySeverity.critica ? { background: 'var(--danger)' } : undefined} />}
    </button>
  );
}

/** "07:10" on the same day; otherwise "seg 01:00". */
function shortWhen(v) {
  const d = toDate(v);
  if (!d) return '';
  return spDay(d) === spDay(now()) ? hm(d) : `${weekdayShort(d).toLowerCase()} ${hm(d)}`;
}

function PlanKpi({ kind }) {
  const { state, goTo } = usePanel();
  const ku = (obj(state.kpis) && obj(state.kpis.usage)) || {};
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

function EventsTodayKpi() {
  const { state, analysis: a, goTo } = usePanel();
  const ags = objs(state.agents);
  const today = ags.reduce((s, x) => s + (Number(x.events_today) || 0), 0);
  const flows = ags.reduce((s, x) => s + (Number(x.open_flows) || 0), 0);
  const hourNow = spHour(now()) ?? 23;
  const series = a ? a.hoursToday.slice(0, hourNow + 1) : [];
  return (
    <Kpi label={t('overview.eventsToday')} value={number(today)} onClick={() => goTo('log')}
      info={t('overview.eventsTodayInfo', { flows: t('overview.openFlows', { count: flows }) })}>
      {series.length > 0 && <Sparkline values={series.slice(-14)} width={86} height={30} ariaLabel={t('overview.eventsPerHour')} />}
    </Kpi>
  );
}

/** First name of the agent (short legend); the whole name stays in the chart tooltip. */
const short = (name) => txt(name).split(/\s+/)[0] || txt(name);

function WeekActivity() {
  const { state, analysis: a, analytics } = usePanel();
  const series = objs(state.agents).map((ag) => ({ key: ag.slug, name: ag.name || ag.slug, color: agentInfo(state, ag.slug).color || 'var(--muted)' }));
  if (a) {
    const known = new Set(series.map((s) => s.key));
    const others = Object.keys(a.byAgent).filter((k) => !known.has(k));
    for (const k of others) series.push({ key: k, name: agentInfo(state, k).name, color: 'var(--faint)' });
  }
  const legend = series.filter((s) => !a || a.byAgent[s.key]).map((s) => ({ ...s, name: short(s.name) }));
  let extra = t('common.reading');
  if (a) extra = t('overview.eventCount', { count: a.total });
  else if (analytics.error) extra = t('overview.noRead', { message: analytics.error.message });
  return (
    <Card label={t('overview.activity7d')} info={t('overview.activity7dInfo')} extra={extra}>
      {a ? (
        <>
          <BarChart data={a.days.map((d) => ({ key: d.day, label: d.label, title: d.title, values: d.values }))} series={series}
            ariaLabel={t('overview.activity7dAria')} highlightLast />
          <div class="legend-bottom"><Legend series={legend} /></div>
        </>
      ) : <Skeleton height={200} style={{ marginTop: '8px' }} />}
    </Card>
  );
}

const RESULT_ORDER = ['ok', 'em-andamento', 'parcial', 'aguardando-dono', 'bloqueado', 'falhou'];
function WeekResults() {
  const { analysis: a, goTo, setFilters } = usePanel();
  const info = t('overview.results7dInfo');
  if (!a) return <Card label={t('overview.results7d')} info={info}><Skeleton height={200} style={{ marginTop: '8px' }} /></Card>;
  const slices = RESULT_ORDER.map((r) => ({ key: r, name: resultName(r), value: a.results[r] || 0, color: RESULTS[r].color }));
  const total = slices.reduce((s, f) => s + f.value, 0);
  const seeLog = (r) => { setFilters({ result: r, period: '7d' }); goTo('log'); };
  return (
    <Card label={t('overview.results7d')} info={info} extra={t('overview.askedYou', { count: number(a.needsOwner) })}>
      <div class="results">
        <Donut slices={slices} size={132} thickness={11} center={number(total)} sub={t('overview.events')} ariaLabel={t('overview.results7dAria')} />
        <ul class="legend-list">
          {slices.map((f) => (
            <li key={f.key}>
              <button type="button" class="link neutral" onClick={() => seeLog(f.key)}
                title={t('overview.resultTitle', { name: f.name, value: number(f.value), share: total ? pct(Math.round((f.value / total) * 1000) / 10) : '—' })}>
                <i style={{ background: f.color }} /><span class="truncate">{f.name}</span><b class={f.value ? '' : 'faint'}>{number(f.value)}</b>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function AgentList() {
  const { state, analysis: a, openModal, goTo } = usePanel();
  const ags = objs(state.agents);
  const ids = arr(state.events).map((e) => e && e.id);
  return (
    <Card label={t('overview.agents')} scroll flush
      info={t('overview.agentsInfo')}
      actions={<button type="button" class="link small go-link" onClick={() => goTo('agents')}>{t('overview.seeAll')} <Icon of={ArrowRight} size={13} /></button>}>
      {!ags.length && <Empty>{t('agents.noneRegistered')}</Empty>}
      <div class="agent-rows">
        {ags.map((ag) => {
          const u = obj(ag.last_event);
          const color = agentInfo(state, ag.slug).color;
          const nToday = Number(ag.events_today) || 0;
          return (
            <div class="agent-row" key={ag.slug}>
              <div class="agent-head">
                <Agent slug={ag.slug} size={9} />
                {ag.status && ag.status !== 'ativo' && <Badge>{ag.status}</Badge>}
                <span class="spacer" />
                <span class="muted tiny">{t('overview.eventsTodayCount', { count: nToday })}</span>
                {a && <Sparkline values={a.agentSeries(ag.slug)} width={70} height={20} color={color || 'var(--muted)'} ariaLabel={t('overview.agentSparkAria', { name: ag.name })} />}
              </div>
              {u ? (
                <button type="button" class="link neutral agent-last truncate" disabled={!u.id} title={txt(u.summary)}
                  onClick={() => u.id && openModal(u.id, ids)}>{txt(u.summary) || t('common.noSummary')}</button>
              ) : <span class="muted small">{t('common.noEvents')}</span>}
              {u && (
                <div class="agent-meta">
                  <span title={time(u.ts)}>{age(u.ts)} · {typeName(u.type)}</span>
                  <Result value={u.result} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function RecentActivity() {
  const { state, openModal, goTo } = usePanel();
  const recent = objs(state.events).slice(0, 40);
  const ids = recent.map((e) => e.id);
  const today = spDay(now());
  return (
    <Card label={t('overview.recent')} scroll flush
      info={t('overview.recentInfo')}
      actions={<button type="button" class="link small go-link" onClick={() => goTo('log')}>{t('overview.openLog')} <Icon of={ArrowRight} size={13} /></button>}>
      {!recent.length && <Empty icon={Activity} center>{t('common.noEvents')}</Empty>}
      <div class="list activity">
        {recent.map((e) => {
          const rowClass = FAILURE_RESULTS.has(e.result) ? 'failure' : needsOwner(e) ? 'needs-owner' : '';
          const ag = agentInfo(state, e.agent);
          return (
            <button type="button" key={e.id || e.ts} class={`list-item ${rowClass}`} onClick={() => openModal(e.id, ids)}
              aria-label={`${time(e.ts)} ${ag.name}: ${txt(e.summary)}`}>
              <span class="muted small" title={time(e.ts)}>{spDay(e.ts) === today ? hm(e.ts) : `${dayMonthFormat.format(toDate(e.ts) || new Date(0))} ${hm(e.ts)}`}</span>
              <Dot color={ag.color} title={ag.name} />
              <span class="truncate" title={txt(e.summary)}>{txt(e.summary) || t('common.noSummary')}</span>
              <Result value={e.result} />
            </button>
          );
        })}
      </div>
    </Card>
  );
}
