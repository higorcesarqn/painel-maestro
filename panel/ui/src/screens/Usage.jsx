// Claude usage (#13): the account plan (5 h and weekly, from Maestri), the consumption of each item in each period and
// the tokens of each agent (the item's maestro, a task's worker). Everything comes from GET /api/usage; the company
// chosen at the top of the panel (companyFilter) reaches it as ?company= and only chooses the lines: the shares are
// always of the whole account. The explanations (formula, where each number comes from) sit in the (i) icons.
import '../styles/usage.css';
import { useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { readUsage } from '../data/api.js';
import { usePolling } from '../data/polling.js';
import { obj, objs, arr, txt, number, compact, pct, time, hm, age, dateTime, elapsedText, spDay, dayMonth, toDate, now, weekdayShort } from '../data/format.js';
import { USAGE_PERIODS, usagePeriodName, usagePeriodShort } from '../data/domain.js';
import { t } from '../i18n/index.js';
import { Card, Ring, Segmented, Empty, Badge } from '../components/base.jsx';
import { BarList, StackedBar, Legend } from '../components/charts.jsx';
import { Icon, Info, RefreshCw } from '../components/Icon.jsx';

// Parts of the relative consumption (input + 5 × output + 1.25 × cache write + 0.1 × cache read).
const PARTS = [
  { key: 'input', weight: 1, color: '#F5F5F5' },
  { key: 'output', weight: 5, color: 'var(--blue-text)' },
  { key: 'cache_write', weight: 1.25, color: 'var(--text-2)' },
  { key: 'cache_read', weight: 0.1, color: 'var(--faint)' },
];
const ROLE_COLOR = { maestro: 'var(--blue)', worker: '#4BCE97', none: 'var(--muted)' };
const ROLE_TONE = { maestro: 'blue', worker: 'ok' };
const partName = (key) => t(`usage.parts.${key}`);
const byConsumption = (list) => objs(list).sort((a, b) => (b.relative_consumption || 0) - (a.relative_consumption || 0));

/** "#12 <title>", or the "no item" name of the project for the sessions of a project outside any item. */
function itemName(line) {
  const it = obj(line.item);
  const project = obj(line.project) || {};
  if (!it) return t('usage.noItem', { project: txt(project.name || project.id) });
  return it.title ? t('usage.itemName', { ref: txt(it.tracker_ref), title: txt(it.title) }) : txt(it.tracker_ref);
}

function agentName(line) {
  const role = line.role === 'maestro' || line.role === 'worker' ? line.role : 'none';
  return txt(line.name) || t(`usage.roles.${role}`);
}

export function Usage() {
  const { recalculate, recalculating, companyFilter } = usePanel();
  const { answer, error, reload } = usePolling(() => readUsage(companyFilter), [companyFilter]);
  const [tokensPeriod, setTokensPeriod] = useState('window_5h');
  const usage = obj(answer);
  const ku = (usage && obj(usage.plan)) || {};
  const periods = (usage && obj(usage.periods)) || {};
  const byItem = (usage && obj(usage.by_item)) || {};
  const byAgent = (usage && obj(usage.by_agent)) || {};
  const col = usage && obj(usage.collector);
  const last = col && obj(col.last);
  const collection = usage && obj(usage.collection);
  const collected = !!(usage && usage.collected_at);
  const note = (() => {
    const n = txt(usage && usage.note).trim() || t('usage.noteDefault');
    return `${n.charAt(0).toUpperCase()}${n.slice(1)}${/[.!?]$/.test(n) ? '' : '.'}`;
  })();
  const warnings = arr(usage && usage.warnings);
  const recalc = async () => { await recalculate(); reload(); };

  let collector = t('usage.noInfo');
  if (col) collector = col.active === false ? t('usage.collectorOff') : t('usage.collectorAuto', { minutes: col.interval_min || 5 });
  if (col && col.running) collector += t('usage.runningNow');

  return (
    <div class="screen screen-usage">
      {error && <div class="note-banner" role="alert"><Icon of={Info} size={15} />{t('usage.readFailed', { message: error.message })}</div>}
      <div class="usage-top">
        <PlanCard title={t('usage.plan5h')} weekly={false} value={ku.window_5h_pct} reset={ku.reset_5h} reason={ku.window_5h_reason} ku={ku} />
        <PlanCard title={t('usage.planWeekly')} weekly value={ku.weekly_pct} reset={ku.weekly_reset} reason={ku.weekly_reason} ku={ku} />
        <Card label={t('usage.sourceAndCollector')}
          info={t('usage.sourceInfo')}
          actions={<button type="button" class="button small" disabled={recalculating} onClick={recalc}><Icon of={RefreshCw} size={13} />{recalculating ? t('common.recalculating') : t('common.recalculate')}</button>}>
          <dl class="usage-dl">
            <dt>{t('usage.planSource')}</dt><dd>{txt(ku.source) || t('codes.maestri_claude_provider')}</dd>
            <dt>{t('usage.planData')}</dt><dd>{ku.age_min !== null && ku.age_min !== undefined ? elapsedText(ku.age_min) : t('usage.noAge')}{ku.updated_at ? ` (${dateTime(ku.updated_at)})` : ''}</dd>
            <dt>{t('usage.perItem')}</dt><dd>{collected ? t('usage.collectedAt', { time: time(usage.collected_at), age: age(usage.collected_at) }) : txt(usage && usage.reason) || t('usage.collectorNotRun')}</dd>
            <dt>{t('usage.collector')}</dt><dd>{collector}</dd>
            {last && <><dt>{t('usage.lastRun')}</dt><dd>{t('usage.lastRunText', {
              time: time(last.at),
              result: last.ok ? t('eventModal.ok') : t('usage.failed', { error: txt(last.error) }),
              duration: typeof last.duration_ms === 'number' ? t('usage.durationMs', { ms: number(last.duration_ms) }) : '',
            })}</dd></>}
            {collection && <><dt>{t('usage.sessions')}</dt><dd>{t('usage.sessionsText', {
              sessions: number(collection.sessions), transcripts: number(collection.transcripts),
            })}</dd></>}
          </dl>
        </Card>
      </div>
      {usage && collected && !ku.available && (
        <div class="note-banner"><Icon of={Info} size={15} />{t('usage.planUnavailable', { reason: (txt(ku.reason) || t('overview.noMaestriData')).trim().replace(/[.\s]+$/, '') })}</div>
      )}
      <div class="usage-periods">
        {USAGE_PERIODS.map((p) => (
          <ItemsCard key={p.id} period={p} list={byConsumption(byItem[p.id])} info={obj(periods[p.id])} ku={ku} collected={collected} />
        ))}
      </div>
      <TokensTable period={tokensPeriod} setPeriod={setTokensPeriod} list={byConsumption(byAgent[tokensPeriod])} note={note} warnings={warnings} />
    </div>
  );
}

/** Consumption of each item in one period: a bar per item (share of the account) and ≈ % of the plan. */
function ItemsCard({ period: p, list, info, ku, collected }) {
  const planPct = p.plan ? ku[p.plan] : null;
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
  if (!collected) body = <Empty>{t('usage.noUsageFile')}</Empty>;
  else if (!list.some((l) => (l.relative_consumption || 0) > 0)) body = <Empty>{t('usage.noConsumption')}</Empty>;
  else {
    body = <BarList items={list.map((l) => ({
      key: l.key, name: <span title={itemName(l)}>{itemName(l)}</span>, value: l.consumption_pct || 0, color: l.item ? 'var(--blue)' : 'var(--muted)',
      valueLabel: pct(l.consumption_pct), ariaLabel: t('usage.barAria', { name: itemName(l), pct: pct(l.consumption_pct) }),
      sub: typeof l.estimated_plan_pct === 'number' ? t('usage.ofPlan', { pct: pct(l.estimated_plan_pct) }) : null,
    }))} />;
  }
  return (
    <Card label={t('usage.byItem', { period: usagePeriodName(p.id) })} info={explain} extra={info && info.start ? range(info.start, info.end) : ''} scroll>
      {body}
    </Card>
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

/** Tokens of each agent in the chosen period; the last row sums the lines shown (the chosen company's). */
function TokensTable({ period, setPeriod, list, note, warnings }) {
  const sum = (k) => list.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  const tot = list.length ? { input: sum('input'), output: sum('output'), cache_write: sum('cache_write'), cache_read: sum('cache_read'), messages: sum('messages'), relative_consumption: sum('relative_consumption') } : null;
  const share = Math.round(sum('consumption_pct') * 10) / 10;
  const hasPlan = list.some((l) => typeof l.estimated_plan_pct === 'number');
  const planSum = Math.round(sum('estimated_plan_pct') * 10) / 10;
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
                <col style={{ width: '180px' }} /><col /><col style={{ width: '150px' }} /><col style={{ width: '80px' }} /><col style={{ width: '130px' }} />
                <col style={{ width: '76px' }} /><col style={{ width: '76px' }} /><col style={{ width: '92px' }} /><col style={{ width: '92px' }} /><col style={{ width: '92px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{t('usage.col.agent')}</th><th scope="col">{t('usage.col.item')}</th><th scope="col">{t('usage.col.share')}</th><th scope="col" class="num">{t('usage.col.planPct')}</th><th scope="col">{t('usage.col.composition')}</th>
                  <th scope="col" class="num">{t('usage.col.input')}</th><th scope="col" class="num">{t('usage.col.output')}</th><th scope="col" class="num">{t('usage.col.cacheWrite')}</th><th scope="col" class="num">{t('usage.col.cacheRead')}</th><th scope="col" class="num">{t('usage.col.messages')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((l) => {
                  const role = l.role === 'maestro' || l.role === 'worker' ? l.role : 'none';
                  const task = obj(l.task);
                  return (
                    <tr key={l.key}>
                      <td title={agentName(l)}><Badge tone={ROLE_TONE[role] || 'neutral'}>{t(`usage.roles.${role}`)}</Badge> {txt(l.name)}</td>
                      <td title={itemName(l)}>{itemName(l)}{task ? <span class="muted">{t('usage.taskSuffix', { number: task.number, title: txt(task.title) })}</span> : null}</td>
                      <td><span class="share-cell"><span class="mini-bar"><span style={{ width: `${Math.max(0, Math.min(100, l.consumption_pct || 0))}%`, background: ROLE_COLOR[role] }} /></span><span>{pct(l.consumption_pct)}</span></span></td>
                      <td class="num">{typeof l.estimated_plan_pct === 'number' ? `≈ ${pct(l.estimated_plan_pct)}` : '—'}</td>
                      <td><div class="composition" title={consumption(l.relative_consumption)}><StackedBar parts={parts(l)} format={(v) => compact(Math.round(v))} ariaLabel={t('usage.compositionOf', { name: agentName(l) })} /></div></td>
                      <td class="num" title={number(l.input)}>{compact(l.input)}</td><td class="num" title={number(l.output)}>{compact(l.output)}</td>
                      <td class="num" title={number(l.cache_write)}>{compact(l.cache_write)}</td><td class="num" title={number(l.cache_read)}>{compact(l.cache_read)}</td>
                      <td class="num">{typeof l.messages === 'number' ? number(l.messages) : '—'}</td>
                    </tr>
                  );
                })}
                {tot && (
                  <tr class="total">
                    <td colSpan={2}>{t('usage.totalShown')}</td>
                    <td><span class="share-cell"><span class="mini-bar"><span style={{ width: `${Math.min(100, share)}%`, background: 'var(--border-strong)' }} /></span><span>{pct(share)}</span></span></td>
                    <td class="num">{hasPlan ? `≈ ${pct(planSum)}` : '—'}</td>
                    <td><div class="composition" title={consumption(tot.relative_consumption)}><StackedBar parts={parts(tot)} format={(v) => compact(Math.round(v))} ariaLabel={t('usage.compositionTotal')} /></div></td>
                    <td class="num" title={number(tot.input)}>{compact(tot.input)}</td><td class="num" title={number(tot.output)}>{compact(tot.output)}</td>
                    <td class="num" title={number(tot.cache_write)}>{compact(tot.cache_write)}</td><td class="num" title={number(tot.cache_read)}>{compact(tot.cache_read)}</td>
                    <td class="num">{number(tot.messages)}</td>
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
