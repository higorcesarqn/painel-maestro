// Agents: on the left, a summary card per agent (registro/agentes.json + events, raw log and consumption);
// a click opens the details in a modal (← → move between agents). On the right, the 7-day results of each
// agent and the last write of the raw log (health of the hooks).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { obj, objs, arr, txt, number, pct, age, hm, dateTime, date, spDay, now, dayMonthFormat, toDate, timeMs } from '../data/format.js';
import { safeColor, typeName, agentInfo, RESULTS, resultName } from '../data/domain.js';
import { lastDays } from '../data/queries.js';
import { t } from '../i18n/index.js';
import { Card, Badge, Dot, Empty, Skeleton } from '../components/base.jsx';
import { Sparkline, BarChart, StackedBar, Legend } from '../components/charts.jsx';
import { Agent, Result } from '../components/domain.jsx';
import { Modal } from '../components/Modal.jsx';
import { Icon, Bot, ChevronRight, ArrowLeft, ArrowRight, X } from '../components/Icon.jsx';
import '../styles/agents.css';

// Order and colors of the results in the bars (the same as the rest of the panel).
const RESULT_ORDER = ['ok', 'em-andamento', 'aguardando-dono', 'parcial', 'bloqueado', 'falhou'];
const resultSeries = () => RESULT_ORDER.map((r) => ({ key: r, name: resultName(r), color: RESULTS[r].color }));
// An active agent without raw log for more than 24 h turns the health yellow (same rule as server.js).
const RAW_LATE_MIN = 24 * 60;
const MAX_MODAL_EVENTS = 30;
// Agent status of the old model (stored value).
const ACTIVE = 'ativo';

const nameOf = (a) => txt(a.name || a.slug);
const minutesSince = (v) => { const d = toDate(v); return d ? (now() - d.getTime()) / 60000 : null; };

export function Agents() {
  const { state, analysis, analytics } = usePanel();
  const [open, setOpen] = useState(null); // slug of the agent in the details modal
  const events7d = analytics && analytics.events;
  // events of the last 7 days of each agent, most recent first
  const byAgent = useMemo(() => {
    const m = new Map();
    for (const e of arr(events7d)) {
      if (!e || !e.agent) continue;
      if (!m.has(e.agent)) m.set(e.agent, []);
      m.get(e.agent).push(e);
    }
    for (const l of m.values()) l.sort((a, b) => timeMs(b.ts) - timeMs(a.ts));
    return m;
  }, [events7d]);
  if (!state) return null;

  const ags = objs(state.agents);
  const active = ags.filter((a) => a.status === ACTIVE).length;
  const hooks = objs(state.health && state.health.hooks);
  const extras = hooks.filter((x) => !ags.some((a) => a.slug === x.agent));
  const loading = !events7d;
  const openAgent = open && ags.find((a) => a.slug === open);
  return (
    <div class="screen screen-agents">
      <Card label={t('agents.title')} extra={t('agents.registeredActive', { registered: number(ags.length), active: number(active) })} scroll flush class="agent-list-card"
        info={t('agents.listInfo', { count: ags.length })}>
        {!ags.length && <Empty icon={Bot} center>{t('agents.noneRegistered')}</Empty>}
        {ags.length > 0 && (
          <div class="agent-list">
            {ags.map((a) => <AgentItem key={a.slug} a={a} series={analysis ? analysis.agentSeries(a.slug) : null} onOpen={() => setOpen(a.slug)} />)}
          </div>
        )}
      </Card>
      <div class="agent-side">
        <ResultsByAgent ags={ags} byAgent={byAgent} loading={loading} />
        <RawLog ags={ags} hooks={hooks} extras={extras} />
      </div>
      {openAgent && (
        <AgentModal ags={ags} a={openAgent} byAgent={byAgent} loading={loading}
          onSwitch={setOpen} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/** Share of the agent in the consumption of a period (window_5h, today, 7d), or "—". */
function usagePct(a, k) {
  const u = obj(a.usage) && obj(a.usage[k]);
  return u && typeof u.consumption_pct === 'number' ? pct(u.consumption_pct) : '—';
}

function Num({ value, label, title }) {
  return <span class="agent-num" title={title}><b>{value}</b><span class="label">{label}</span></span>;
}

/** Summary card: name, status, model, the last event on one line, four numbers and the 7 days. */
function AgentItem({ a, series, onOpen }) {
  const color = safeColor(a.color);
  const ue = obj(a.last_event);
  return (
    <button type="button" class="agent-item" onClick={onOpen} style={color ? { '--agent-color': color } : undefined}
      aria-label={t('agents.openDetails', { name: nameOf(a) })}>
      <span class="agent-upper">
        <span class="agent-top">
          <Dot color={color} size={10} />
          <span class="agent-name">{nameOf(a)}</span>
          {a.status && <Badge tone={a.status === ACTIVE ? 'ok' : 'neutral'}>{txt(a.status)}</Badge>}
          <span class="spacer" />
          <span class="mono muted tiny agent-model" title={t('agents.modelAndEffort')}>{txt(a.model) || '—'}{a.effort ? ` · ${txt(a.effort)}` : ''}</span>
        </span>
        {ue ? (
          <span class="agent-event">
            <span class="agent-ev-meta">{t('agents.lastEventMeta', { time: hm(ue.ts), age: age(ue.ts), type: typeName(ue.type) })}<Result value={ue.result} /></span>
            <span class="agent-ev-summary two-lines" title={txt(ue.summary)}>{txt(ue.summary) || t('common.noSummary')}</span>
          </span>
        ) : <span class="agent-event muted">{t('common.noEvents')}</span>}
      </span>
      <span class="agent-numbers">
        <Num value={number(a.events_today)} label={t('agents.eventsToday')} />
        <Num value={number(a.open_flows)} label={t('agents.openFlows')} />
        <Num value={usagePct(a, 'window_5h')} label={t('agents.usage5h')} title={t('agents.usage5hTitle')} />
        <Num value={usagePct(a, '7d')} label={t('agents.usage7d')} title={t('agents.usage7dTitle')} />
        <span class="agent-num agent-spark">
          {series
            ? <Sparkline values={series} width={112} height={28} color={color || 'var(--muted)'} ariaLabel={t('agents.sparkAria', { values: series.join(', ') })} />
            : <Skeleton width={112} height={28} />}
          <span class="label">{t('agents.sevenDays')}</span>
        </span>
        <span class="agent-details" aria-hidden="true">{t('agents.details')}<Icon of={ChevronRight} size={14} /></span>
      </span>
    </button>
  );
}

/** Counts the results of a list of events. */
function countResults(evs) {
  const c = {};
  for (const e of evs) { const r = RESULTS[e.result] ? e.result : 'other'; c[r] = (c[r] || 0) + 1; }
  return c;
}

/** One bar per agent, split by the results of the 7 days; the length follows the volume. */
function ResultsByAgent({ ags, byAgent, loading }) {
  const rows = ags.map((a) => {
    const evs = byAgent.get(a.slug) || [];
    return { a, total: evs.length, c: countResults(evs) };
  });
  const max = Math.max(1, ...rows.map((l) => l.total));
  return (
    <Card label={t('agents.results7d')} scroll class="agent-results"
      info={t('agents.results7dInfo')}>
      {loading ? (
        <div class="agent-res-list">{ags.map((a) => <Skeleton key={a.slug} height={30} />)}</div>
      ) : (
        <>
          <div class="agent-res-list">
            {rows.map((l) => (
              <div class="agent-res" key={l.a.slug}>
                <span class="agent-res-head"><Agent slug={l.a.slug} /><b>{l.total ? number(l.total) : <span class="muted">{t('agents.noEvents')}</span>}</b></span>
                <span class="agent-res-track">
                  <span style={{ width: `${(l.total / max) * 100}%` }}>
                    <StackedBar parts={RESULT_ORDER.map((r) => ({ key: r, value: l.c[r] || 0, color: RESULTS[r].color, name: resultName(r) }))}
                      ariaLabel={`${nameOf(l.a)}: ${RESULT_ORDER.filter((r) => l.c[r]).map((r) => `${l.c[r]} ${resultName(r)}`).join(', ') || t('agents.noEvent')}`} />
                  </span>
                </span>
                {l.total > 0 && (
                  <span class="agent-res-sub">
                    {RESULT_ORDER.filter((r) => l.c[r]).map((r) => (
                      <span key={r}><i style={{ background: RESULTS[r].color }} />{number(l.c[r])} {resultName(r)}</span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div class="agent-res-legend"><Legend series={resultSeries()} /></div>
        </>
      )}
    </Card>
  );
}

/** Last write of each agent's hooks and the terminals that write without a registered agent. */
function RawLog({ ags, hooks, extras }) {
  const bySlug = new Map(hooks.map((h) => [h.agent, h]));
  return (
    <Card label={t('agents.rawLog')} scroll class="agent-raw"
      info={t('agents.rawLogInfo')}>
      <ul class="agent-raw-list">
        {ags.map((a) => {
          const h = bySlug.get(a.slug);
          const last = (h && h.last_raw) || a.last_raw || null;
          const min = minutesSince(last);
          const late = a.status === ACTIVE && (!last || (min !== null && min > RAW_LATE_MIN));
          return (
            <li key={a.slug}>
              <Agent slug={a.slug} />
              <span class="muted small">{last ? dateTime(last) : t('agents.noRecord')}</span>
              <span class="agent-raw-age" style={late ? { color: 'var(--warning)' } : undefined}>
                <Dot color={late ? 'var(--warning)' : 'var(--ok)'} size={7} />{last ? age(last) : t('common.never')}
              </span>
            </li>
          );
        })}
      </ul>
      {extras.length > 0 && (
        <>
          <span class="label agent-raw-sub">{t('agents.noRegisteredAgent')}</span>
          <ul class="agent-raw-list">
            {extras.map((x) => (
              <li key={x.agent}>
                <span class="mono small truncate" title={txt(x.agent)}>{txt(x.agent)}</span>
                <span class="muted small">{x.last_raw ? dateTime(x.last_raw) : t('common.never')}</span>
                <span class="agent-raw-age muted"><Dot color="var(--faint)" size={7} />{x.last_raw ? age(x.last_raw) : '—'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// Connections of the old registry: "portal:painel" becomes the badge "portal · painel".
const CONNECTION = /^(portal|nota|agente|terminal):(.+)$/;

/** A connection: kind and target, or an agent slug, which becomes the name with its color. */
function Connection({ c }) {
  const { state } = usePanel();
  const s = txt(c);
  const m = CONNECTION.exec(s);
  if (m) return <Badge><span class="faint">{m[1]}</span>{m[2]}</Badge>;
  const ag = objs(state && state.agents).find((x) => x.slug === s);
  if (ag) { const i = agentInfo(state, s); return <Badge><Dot color={i.color} size={7} />{i.name}</Badge>; }
  return <Badge>{s}</Badge>;
}

/** Consumption of the agent in a period: share of the consumption and, when there is one, the estimated slice of the plan. */
function usageLine(a, k, name) {
  const u = obj(a.usage) && obj(a.usage[k]);
  if (!u || typeof u.consumption_pct !== 'number') return null;
  const values = { name, pct: pct(u.consumption_pct), plan: typeof u.estimated_plan_pct === 'number' ? pct(u.estimated_plan_pct) : '' };
  return <span key={k}>{values.plan ? t('agents.usageLineWithPlan', values) : t('agents.usageLine', values)}</span>;
}

/** Full sheet of the agent: last event, latest events, 7 days by result, sheet, connections and skills. */
function AgentModal({ ags, a, byAgent, loading, onSwitch, onClose }) {
  const { state, openModal } = usePanel();
  const i = ags.findIndex((x) => x.slug === a.slug);
  const previous = i > 0 ? ags[i - 1] : null;
  const following = i >= 0 && i < ags.length - 1 ? ags[i + 1] : null;
  const neighbors = useRef({ previous, following });
  neighbors.current = { previous, following };
  useEffect(() => {
    const key = (ev) => {
      const el = ev.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const target = ev.key === 'ArrowLeft' ? neighbors.current.previous : ev.key === 'ArrowRight' ? neighbors.current.following : null;
      if (!target) return;
      onSwitch(target.slug);
      ev.preventDefault();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const color = safeColor(a.color);
  const ue = obj(a.last_event);
  // Without the 7-day analysis yet, it uses the recent events of /api/state.
  const evs = loading ? objs(state.events).filter((e) => e.agent === a.slug) : (byAgent.get(a.slug) || []);
  const list = evs.slice(0, MAX_MODAL_EVENTS);
  const ids = list.map((e) => e.id).filter((x) => typeof x === 'string' && x);
  const openEvent = (id) => {
    if (!id) return;
    onClose();
    openModal(id, ids.includes(id) ? ids : arr(state.events).map((e) => e && e.id));
  };
  const days = useMemo(() => {
    const ds = lastDays(7).map((d) => ({ key: d.day, label: d.label, title: d.title, values: {} }));
    const pos = new Map(ds.map((d, j) => [d.key, j]));
    for (const e of evs) {
      const j = pos.get(spDay(e.ts));
      if (j === undefined) continue;
      const r = RESULTS[e.result] ? e.result : 'other';
      ds[j].values[r] = (ds[j].values[r] || 0) + 1;
    }
    return ds;
  }, [evs]);
  const today = spDay(now());
  const connections = arr(a.connected_to);
  const skills = arr(a.skills);
  const usage = [usageLine(a, 'window_5h', t('agents.usage.window_5h')), usageLine(a, 'today', t('agents.usage.today')), usageLine(a, '7d', t('agents.usage.7d'))].filter(Boolean);
  const terminal = txt(a.terminal_id || a.terminal);

  return (
    <Modal onClose={onClose} labelId="agent-modal-title" width={1080}>
      <div class="modal-head agent-modal-head" style={color ? { '--agent-color': color } : undefined}>
        <div class="info">
          <Dot color={color} size={11} />
          <span id="agent-modal-title" class="when">{nameOf(a)}</span>
          {a.status && <Badge tone={a.status === ACTIVE ? 'ok' : 'neutral'}>{txt(a.status)}</Badge>}
          <span class="mono muted tiny">{txt(a.model) || '—'}{a.effort ? ` · ${txt(a.effort)}` : ''}</span>
          <span class="faint tiny">{t('agents.position', { n: i + 1, total: ags.length })}</span>
        </div>
        <div class="modal-nav">
          <button type="button" class="button icon-only" aria-label={previous ? t('agents.previousAria', { name: nameOf(previous) }) : t('agents.previous')}
            title={previous ? t('agents.previousTitle', { name: nameOf(previous) }) : t('agents.first')} disabled={!previous} onClick={() => previous && onSwitch(previous.slug)}><Icon of={ArrowLeft} /></button>
          <button type="button" class="button icon-only" aria-label={following ? t('agents.nextAria', { name: nameOf(following) }) : t('agents.next')}
            title={following ? t('agents.nextTitle', { name: nameOf(following) }) : t('agents.last')} disabled={!following} onClick={() => following && onSwitch(following.slug)}><Icon of={ArrowRight} /></button>
          <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} onClick={onClose}><Icon of={X} /></button>
        </div>
      </div>
      <div class="modal-body">
        <div class="agent-modal-grid">
          <div class="modal-col">
            <section class="modal-section">
              <h3 class="label">{t('agents.lastEvent')}</h3>
              {ue ? (
                <>
                  <span class="agent-ev-meta">{t('agents.lastEventFull', { when: dateTime(ue.ts), age: age(ue.ts), type: typeName(ue.type) })} <Result value={ue.result} /></span>
                  {ue.id
                    ? <button type="button" class="link neutral agent-modal-summary" onClick={() => openEvent(ue.id)}>{txt(ue.summary) || t('common.noSummary')}</button>
                    : <span class="agent-modal-summary">{txt(ue.summary) || t('common.noSummary')}</span>}
                </>
              ) : <span class="muted small">{t('common.noEvents')}</span>}
            </section>
            <section class="modal-section">
              <h3 class="label">{t('agents.eventsPerDay')}</h3>
              <div class="agent-modal-chart">
                {loading
                  ? <Skeleton height={150} />
                  : <BarChart data={days} series={resultSeries()} highlightLast ariaLabel={t('agents.eventsPerDayAria', { name: nameOf(a) })} />}
              </div>
            </section>
            <section class="modal-section">
              <h3 class="label">{evs.length > list.length ? t('agents.latestEventsOf', { shown: list.length, total: evs.length }) : t('agents.latestEvents')}</h3>
              {!list.length && <span class="muted small">{loading ? t('agents.loadingEvents') : t('agents.noEvents7d')}</span>}
              {list.length > 0 && (
                <ul class="agent-modal-events">
                  {list.map((e) => (
                    <li key={e.id || e.ts}>
                      <button type="button" disabled={!e.id} onClick={() => openEvent(e.id)} title={txt(e.summary)}>
                        <span class="muted">{spDay(e.ts) === today ? hm(e.ts) : `${dayMonthFormat.format(toDate(e.ts) || new Date(0))} ${hm(e.ts)}`}</span>
                        <span class="truncate">{txt(e.summary) || t('common.noSummary')}</span>
                        <Result value={e.result} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <div class="modal-col">
            <section class="modal-section">
              <h3 class="label">{t('agents.sheet')}</h3>
              <dl class="agent-modal-dl">
                <dt>{t('agents.responsibility')}</dt><dd>{txt(a.responsibility) || '—'}</dd>
                <dt>{t('agents.type')}</dt><dd>{txt(a.type) || '—'}</dd>
                {a.since && <><dt>{t('agents.since')}</dt><dd>{date(`${a.since}T12:00:00-03:00`)}</dd></>}
                {terminal && <><dt>{t('agents.terminal')}</dt><dd class="mono">{terminal}</dd></>}
                <dt>{t('agents.rawLog')}</dt>
                <dd>{a.last_raw ? `${dateTime(a.last_raw)} (${age(a.last_raw)})` : <span style={{ color: 'var(--warning)' }}>{t('agents.noRecordYet')}</span>}</dd>
                <dt>{t('agents.today')}</dt><dd>{t('agents.todayCounts', { events: number(a.events_today), flows: number(a.open_flows) })}</dd>
                <dt>{t('agents.consumption')}</dt><dd>{usage.length ? <span class="agent-modal-usage">{usage}</span> : '—'}</dd>
              </dl>
            </section>
            <section class="modal-section">
              <h3 class="label">{t('agents.connectedTo', { count: connections.length })}</h3>
              {connections.length ? <div class="badges">{connections.map((c) => <Connection key={txt(c)} c={c} />)}</div> : <span class="muted small">{t('agents.noConnections')}</span>}
            </section>
            <section class="modal-section">
              <h3 class="label">{t('agents.skills', { count: skills.length })}</h3>
              {skills.length ? <div class="badges">{skills.map((s) => <Badge key={txt(s)} mono>{txt(s)}</Badge>)}</div> : <span class="muted small">{t('agents.noSkills')}</span>}
            </section>
            {a.remark && (
              <section class="modal-section">
                <h3 class="label">{t('agents.remark')}</h3>
                <p class="text-2 agent-modal-remark">{txt(a.remark)}</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
