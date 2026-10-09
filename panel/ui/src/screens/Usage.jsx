// Claude usage (§12): the account plan (5 h and weekly, from Maestri) and the estimated share of each agent.
// The explanations (formula, where each number comes from) sit in the (i) icon of each card.
import '../styles/usage.css';
import { useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { obj, objs, arr, txt, number, compact, pct, time, hm, age, dateTime, elapsedText, spDay, dayMonth, toDate, now, weekdayShort } from '../data/format.js';
import { USAGE_PERIODS, usagePeriodName, usagePeriodShort, agentInfo } from '../data/domain.js';
import { t } from '../i18n/index.js';
import { Card, Ring, Segmented, Empty } from '../components/base.jsx';
import { BarList, StackedBar, Legend } from '../components/charts.jsx';
import { Agent } from '../components/domain.jsx';
import { Icon, Info, RefreshCw } from '../components/Icon.jsx';

// Parts of the relative consumption (input + 5 × output + 1.25 × cache write + 0.1 × cache read).
const PARTS = [
  { key: 'input', weight: 1, color: '#F5F5F5' },
  { key: 'output', weight: 5, color: 'var(--blue-text)' },
  { key: 'cache_write', weight: 1.25, color: 'var(--text-2)' },
  { key: 'cache_read', weight: 0.1, color: 'var(--faint)' },
];
const partName = (key) => t(`usage.parts.${key}`);

export function Usage() {
  const { state, recalculate, recalculating } = usePanel();
  const [tokensPeriod, setTokensPeriod] = useState('window_5h');
  if (!state) return null;
  const ku = (obj(state.kpis) && obj(state.kpis.usage)) || {};
  const usage = obj(state.usage);
  const plan = (usage && obj(usage.plan)) || {};
  const periods = (usage && obj(usage.periods)) || {};
  const byAgent = (usage && obj(usage.by_agent)) || {};
  const col = obj(state.collector);
  const last = col && obj(col.last);
  const collection = usage && obj(usage.collection);
  const note = (() => {
    const n = txt(usage && usage.note).trim() || t('usage.noteDefault');
    return `${n.charAt(0).toUpperCase()}${n.slice(1)}${/[.!?]$/.test(n) ? '' : '.'}`;
  })();
  const warnings = arr(usage && usage.warnings);

  let collector = t('usage.noInfo');
  if (col) collector = col.active === false ? t('usage.collectorOff') : t('usage.collectorAuto', { minutes: col.interval_min || 5 });
  if (col && col.running) collector += t('usage.runningNow');

  return (
    <div class="screen screen-usage">
      <div class="usage-top">
        <PlanCard title={t('usage.plan5h')} weekly={false} value={ku.window_5h_pct} reset={ku.reset_5h} reason={ku.window_5h_reason} ku={ku} />
        <PlanCard title={t('usage.planWeekly')} weekly value={ku.weekly_pct} reset={ku.weekly_reset} reason={ku.weekly_reason} ku={ku} />
        <Card label={t('usage.sourceAndCollector')}
          info={t('usage.sourceInfo')}
          actions={<button type="button" class="button small" disabled={recalculating} onClick={recalculate}><Icon of={RefreshCw} size={13} />{recalculating ? t('common.recalculating') : t('common.recalculate')}</button>}>
          <dl class="usage-dl">
            <dt>{t('usage.planSource')}</dt><dd>{txt(ku.source || plan.source) || t('codes.maestri_claude_provider')}</dd>
            <dt>{t('usage.planData')}</dt><dd>{ku.age_min !== null && ku.age_min !== undefined ? elapsedText(ku.age_min) : t('usage.noAge')}{ku.updated_at ? ` (${dateTime(ku.updated_at)})` : ''}</dd>
            <dt>{t('usage.perAgent')}</dt><dd>{usage ? t('usage.collectedAt', { time: time(usage.collected_at), age: age(usage.collected_at) }) : t('usage.collectorNotRun')}</dd>
            <dt>{t('usage.collector')}</dt><dd>{collector}</dd>
            {last && <><dt>{t('usage.lastRun')}</dt><dd>{t('usage.lastRunText', {
              time: time(last.at),
              result: last.ok ? t('eventModal.ok') : t('usage.failed', { error: txt(last.error) }),
              duration: typeof last.duration_ms === 'number' ? t('usage.durationMs', { ms: number(last.duration_ms) }) : '',
            })}</dd></>}
            {collection && <><dt>{t('usage.sessions')}</dt><dd>{t('usage.sessionsText', {
              sessions: number(collection.sessions), transcripts: number(collection.transcripts),
              without: collection.sessions_without_owner ? t('usage.withoutOwner', { count: number(collection.sessions_without_owner) }) : '',
            })}</dd></>}
          </dl>
        </Card>
      </div>
      {!ku.available && (
        <div class="note-banner"><Icon of={Info} size={15} />{t('usage.planUnavailable', { reason: (txt(ku.reason) || t('overview.noMaestriData')).trim().replace(/[.\s]+$/, '') })}</div>
      )}
      <div class="usage-periods">
        {USAGE_PERIODS.map((p) => {
          const list = objs(byAgent[p.id]).sort((a, b) => (b.relative_consumption || 0) - (a.relative_consumption || 0));
          const info = obj(periods[p.id]);
          const planPct = p.plan ? ku[p.plan] : null;
          const hasConsumption = list.some((l) => (l.relative_consumption || 0) > 0);
          const planBasis = info && obj(info.plan_basis);
          let planText = t('usage.noPlanToday');
          if (p.plan) {
            planText = typeof planPct === 'number'
              ? t('usage.planShare', { pct: pct(planPct), week: planBasis && planBasis.start ? t('usage.planWeekSince', { since: dateTime(planBasis.start) }) : '' })
              : t('usage.noPlanPct');
          }
          const explain = [
            info && info.start ? t('usage.periodRange', { start: dateTime(info.start), end: dateTime(info.end), basis: info.basis ? ` (${txt(info.basis)})` : '' }) : '',
            t('usage.barExplain'),
            planText,
          ].filter(Boolean).join(' ');
          let body;
          if (!usage) body = <Empty>{t('usage.noUsageFile')}</Empty>;
          else if (!hasConsumption) body = <Empty>{t('usage.noConsumption')}</Empty>;
          else {
            body = <BarList items={list.map((l) => {
              const a = agentInfo(state, l.agent);
              return {
                key: l.agent, name: <Agent slug={l.agent} />, value: l.consumption_pct || 0, color: a.color || 'var(--muted)',
                valueLabel: pct(l.consumption_pct), ariaLabel: t('usage.barAria', { name: a.name, pct: pct(l.consumption_pct) }),
                sub: typeof l.estimated_plan_pct === 'number' ? t('usage.ofPlan', { pct: pct(l.estimated_plan_pct) }) : null,
              };
            })} />;
          }
          return (
            <Card key={p.id} label={usagePeriodName(p.id)} info={explain} extra={info && info.start ? range(info.start, info.end) : ''} scroll>
              {body}
            </Card>
          );
        })}
      </div>
      <TokensTable period={tokensPeriod} setPeriod={setTokensPeriod} byAgent={byAgent} totals={(usage && obj(usage.totals)) || {}}
        note={note} warnings={warnings} />
    </div>
  );
}

/** "02:10 – 03:48" on the same day; otherwise "02/10 03:48 – 09/10 03:48". */
function range(start, end) {
  if (spDay(start) === spDay(end)) return `${hm(start)} – ${hm(end)}`;
  return `${dayMonth(start)} ${hm(start)} – ${dayMonth(end)} ${hm(end)}`;
}

/** Time left: "em 3 h 20 min", "em 2 d 21 h". */
function timeLeft(v) {
  const d = toDate(v);
  if (!d) return '';
  const m = Math.max(0, Math.round((d.getTime() - now()) / 60000));
  if (m < 60) return t('time.in.minutes', { minutes: m });
  if (m < 48 * 60) {
    const hours = Math.floor(m / 60); const minutes = m % 60;
    return minutes ? t('time.in.hoursMinutes', { hours, minutes }) : t('time.in.hours', { hours });
  }
  const days = Math.floor(m / 1440); const hours = Math.floor((m % 1440) / 60);
  return hours ? t('time.in.daysHours', { days, hours }) : t('time.in.days', { days });
}

function PlanCard({ title, weekly, value, reset, reason, ku }) {
  const has = typeof value === 'number';
  const d = toDate(reset);
  const whenText = d ? (spDay(d) === spDay(now()) ? hm(d) : `${weekdayShort(d).toLowerCase()} ${hm(d)}`) : null;
  const info = t('usage.planInfo', {
    scope: weekly ? t('usage.scopeWeek') : t('usage.scope5h'),
    read: ku.age_min !== null && ku.age_min !== undefined ? t('usage.planRead', { age: elapsedText(ku.age_min) }) : '',
    reset: d ? t('usage.planResetsOn', { when: dateTime(d) }) : '',
  });
  return (
    <Card label={title} info={info}>
      <div class="plan">
        <Ring value={has ? value : null} size={128} thickness={8} label={t('usage.ringLabel', { title, value: has ? pct(value) : t('common.unavailable') })}
          center={has ? `${Math.round(value)}%` : '—'} sub={t('usage.used')} large />
        <div class="plan-text">
          {has ? (
            <>
              <span class="label">{t('usage.resets')}</span>
              <span class="plan-when">{whenText || '—'}</span>
              {d && <span class="muted small">{timeLeft(d)}</span>}
            </>
          ) : <span class="muted small">{txt(reason) || (ku.available ? t('usage.pctNotGiven') : t('usage.unavailableSeeBelow'))}</span>}
        </div>
      </div>
    </Card>
  );
}

function TokensTable({ period, setPeriod, byAgent, totals, note, warnings }) {
  const { state } = usePanel();
  const list = objs(byAgent[period]).sort((a, b) => (b.relative_consumption || 0) - (a.relative_consumption || 0));
  const tot = obj(totals[period]);
  const planSum = list.reduce((s, l) => (typeof l.estimated_plan_pct === 'number' ? s + l.estimated_plan_pct : s), 0);
  const hasPlan = list.some((l) => typeof l.estimated_plan_pct === 'number');
  const parts = (l) => PARTS.map((p) => ({ key: p.key, name: partName(p.key), color: p.color, value: (Number(l[p.key]) || 0) * p.weight }));
  const info = (
    <>
      <b>{t('usage.estimate')}</b>{' '}{t('usage.tokensInfo', { note })}
      {warnings.length > 0 && t('usage.collectorWarnings', { warnings: warnings.map((a) => txt(a)).join(' · ') })}
    </>
  );
  const consumption = (v) => t('usage.relativeConsumption', { value: number(Math.round(v || 0)) });
  return (
    <div class="usage-bottom">
      <Card label={t('usage.tokensByAgent')} flush info={info}
        extra={<Legend series={PARTS.map((p) => ({ key: p.key, name: partName(p.key), color: p.color }))} />}
        actions={<Segmented label={t('log.periodLabel')} value={period} onChange={setPeriod} options={USAGE_PERIODS.map((p) => ({ id: p.id, name: usagePeriodShort(p.id) }))} />}>
        {list.length ? (
          <div class="table-box">
            <table class="table tokens">
              <colgroup>
                <col /><col style={{ width: '190px' }} /><col style={{ width: '92px' }} /><col style={{ width: '210px' }} />
                <col style={{ width: '100px' }} /><col style={{ width: '100px' }} /><col style={{ width: '120px' }} /><col style={{ width: '120px' }} /><col style={{ width: '112px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{t('usage.col.agent')}</th><th scope="col">{t('usage.col.share')}</th><th scope="col" class="num">{t('usage.col.planPct')}</th><th scope="col">{t('usage.col.composition')}</th>
                  <th scope="col" class="num">{t('usage.col.input')}</th><th scope="col" class="num">{t('usage.col.output')}</th><th scope="col" class="num">{t('usage.col.cacheWrite')}</th><th scope="col" class="num">{t('usage.col.cacheRead')}</th><th scope="col" class="num">{t('usage.col.messages')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((l) => {
                  const a = agentInfo(state, l.agent);
                  return (
                    <tr key={l.agent}>
                      <td><Agent slug={l.agent} /></td>
                      <td><span class="share-cell"><span class="mini-bar"><span style={{ width: `${Math.max(0, Math.min(100, l.consumption_pct || 0))}%`, background: a.color || 'var(--muted)' }} /></span><span>{pct(l.consumption_pct)}</span></span></td>
                      <td class="num">{typeof l.estimated_plan_pct === 'number' ? `≈ ${pct(l.estimated_plan_pct)}` : '—'}</td>
                      <td><div class="composition" title={consumption(l.relative_consumption)}><StackedBar parts={parts(l)} format={(v) => compact(Math.round(v))} ariaLabel={t('usage.compositionOf', { name: a.name })} /></div></td>
                      <td class="num" title={number(l.input)}>{compact(l.input)}</td><td class="num" title={number(l.output)}>{compact(l.output)}</td>
                      <td class="num" title={number(l.cache_write)}>{compact(l.cache_write)}</td><td class="num" title={number(l.cache_read)}>{compact(l.cache_read)}</td>
                      <td class="num">{typeof l.messages === 'number' ? number(l.messages) : '—'}</td>
                    </tr>
                  );
                })}
                {tot && (
                  <tr class="total">
                    <td>{t('charts.total')}</td>
                    <td><span class="share-cell"><span class="mini-bar"><span style={{ width: '100%', background: 'var(--border-strong)' }} /></span><span>100%</span></span></td>
                    <td class="num">{hasPlan ? `≈ ${pct(Math.round(planSum * 10) / 10)}` : '—'}</td>
                    <td><div class="composition" title={consumption(tot.relative_consumption)}><StackedBar parts={parts(tot)} format={(v) => compact(Math.round(v))} ariaLabel={t('usage.compositionTotal')} /></div></td>
                    <td class="num" title={number(tot.input)}>{compact(tot.input)}</td><td class="num" title={number(tot.output)}>{compact(tot.output)}</td>
                    <td class="num" title={number(tot.cache_write)}>{compact(tot.cache_write)}</td><td class="num" title={number(tot.cache_read)}>{compact(tot.cache_read)}</td>
                    <td class="num">{typeof tot.messages === 'number' ? number(tot.messages) : '—'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : <div style={{ padding: '0 18px' }}><Empty>{t('usage.noData')}</Empty></div>}
      </Card>
    </div>
  );
}
