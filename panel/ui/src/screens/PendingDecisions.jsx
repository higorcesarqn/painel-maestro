// Owner's pending decisions: numbers on top (open ones by severity, answered, closed, the oldest), the list on the
// left, the pending decision in the middle and, on the right, the answer: pick the option, comment and send. The
// server writes the answer into the pending decision (pendencia.js responder) and sends it to the Brain's terminal,
// which hands the decision back to the agent of origin. Fits the screen without scrolling the page: each column
// scrolls inside.
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { objs, arr, txt, age, dateTime, timeMs, number, now } from '../data/format.js';
import { SEVERITIES, severityPlural, pendingTypeName, SEVERITY_ORDER, severityOf } from '../data/domain.js';
import { answerPendingDecision, OPTION_LETTER } from '../data/api.js';
import { t } from '../i18n/index.js';
import { Card, Kpi, Badge, Segmented, Empty, InfoHint } from '../components/base.jsx';
import { Agent, Flow, SeverityBadge } from '../components/domain.jsx';
import { Icon, Inbox, Send, CircleCheck, TriangleAlert, X, LoaderCircle } from '../components/Icon.jsx';
import '../styles/pending-decisions.css';

const SEVERITY_COLOR = { critica: 'var(--danger)', alta: 'var(--warning)', normal: 'var(--blue-text)', baixa: 'var(--faint)' };
const domId = (id) => `pending-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;
// Pending decision status of the old model (stored values).
const OPEN = 'aberta';
const ANSWERED = 'respondida';
const isOpen = (p) => !p.status || p.status === OPEN;

// Answers given on this screen that /api/state has not brought yet (it is read every 20 s).
const answeredHere = new Map();

function groups(state) {
  const all = objs(state && state.pending_decisions).map((p) => {
    const local = answeredHere.get(p.id);
    if (!local) return p;
    if (p.status && p.status !== OPEN) { answeredHere.delete(p.id); return p; }
    return local;
  });
  const bySeverity = (a, b) => SEVERITY_ORDER[severityOf(a)] - SEVERITY_ORDER[severityOf(b)] || timeMs(a.opened_at) - timeMs(b.opened_at);
  return {
    open: all.filter(isOpen).sort(bySeverity),
    answered: all.filter((p) => p.status === ANSWERED).sort(bySeverity),
    closed: all.filter((p) => !isOpen(p) && p.status !== ANSWERED)
      .sort((a, b) => timeMs(b.resolved_at || b.updated_at || b.opened_at) - timeMs(a.resolved_at || a.updated_at || a.opened_at)),
  };
}

/** "21 h", "3 d", "40 min": the age without "ago", to fit the big number. */
function shortAge(v) {
  const ms = now() - timeMs(v);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return t('time.short.minutes', { minutes });
  if (minutes < 48 * 60) return t('time.short.hours', { hours: Math.floor(minutes / 60) });
  return t('time.short.days', { days: Math.floor(minutes / 1440) });
}

/** Letter and text of each option ("A: Approve..." becomes { letter: 'A', text: 'Approve...' }). */
function optionsOf(p) {
  return arr(p.options).map(txt).filter(Boolean).map((o, i) => {
    const m = OPTION_LETTER.exec(o);
    return m ? { letter: m[1].toUpperCase(), text: o.slice(m[0].length) || o } : { letter: String.fromCharCode(65 + i), text: o };
  });
}

/** Recommended letter, when the recommendation starts with it ("A, because...", "Option B: ..."). */
function recommendedLetter(p, options) {
  const m = /^\s*(?:op[\u00e7c][a\u00e3]o\s+)?([A-Z])\b/i.exec(txt(p.recommendation));
  const l = m ? m[1].toUpperCase() : null;
  return l && options.some((o) => o.letter === l) ? l : null;
}

export function PendingDecisions() {
  const { state, pendingTarget, setActionStatus } = usePanel();
  const [, force] = useState(0);
  const g = groups(state);
  const [segment, setSegment] = useState('open');
  const [severityFilter, setSeverityFilter] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [notice, setNotice] = useState(null); // { id, tone, text }
  const detail = useRef(null);

  // Coming from a P-NNNN link (modal or audit): opens the right group and shows the pending decision.
  useEffect(() => {
    if (!pendingTarget) return;
    const group = Object.keys(g).find((k) => g[k].some((p) => p.id === pendingTarget.id));
    if (!group) { setActionStatus(t('pending.notInList', { id: pendingTarget.id })); return; }
    setSegment(group);
    setSeverityFilter(null);
    setChosen(pendingTarget.id);
    requestAnimationFrame(() => {
      const el = document.getElementById(domId(pendingTarget.id));
      if (el) el.scrollIntoView({ block: 'nearest' });
      if (detail.current) detail.current.focus({ preventScroll: true });
    });
  }, [pendingTarget]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 9000);
    return () => clearTimeout(timer);
  }, [notice]);

  const change = (seg, sev = null) => { setSegment(seg); setSeverityFilter(sev); setChosen(null); };
  const list = segment === 'open' && severityFilter ? g.open.filter((p) => severityOf(p) === severityFilter) : g[segment];
  const current = list.find((p) => p.id === chosen) || list[0] || null;
  const countBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, g.open.filter((p) => severityOf(p) === s).length]));
  const oldest = g.open.reduce((m, p) => (!m || timeMs(p.opened_at) < timeMs(m.opened_at) ? p : m), null);

  // After answering: the next open one (in list order) gets chosen, to answer one after the other.
  const answered = (r, before) => {
    answeredHere.set(before.id, r.pending_decision);
    const i = list.findIndex((p) => p.id === before.id);
    const rest = list.filter((p) => p.id !== before.id);
    const next = rest[Math.min(Math.max(i, 0), rest.length - 1)] || null;
    setChosen(next ? next.id : null);
    const a = r.brain_notice || {};
    setNotice(a.sent
      ? { id: before.id, tone: 'ok', text: t('pending.sentTo', { id: before.id, to: a.to || t('pending.brain') }) }
      : { id: before.id, tone: 'warning', text: t('pending.notSent', { id: before.id, reason: txt(a.reason) || t('pending.unknownReason') }) });
    force((n) => n + 1);
  };

  const severityFilterName = severityFilter ? severityPlural(severityFilter) : '';
  let emptyText = t('pending.emptyClosed');
  if (segment === 'open') emptyText = severityFilter ? t('pending.emptyOpenSeverity', { severity: severityFilterName }) : t('pending.emptyOpen');
  else if (segment === 'answered') emptyText = t('pending.emptyAnswered');

  return (
    <div class="screen screen-pending">
      <div class="pending-kpis">
        <Kpi label={t('pending.open')} value={number(g.open.length)} highlight={segment === 'open' && !severityFilter}
          onClick={() => change('open')} info={t('pending.openInfo')} />
        {SEVERITIES.map((s) => (
          <Kpi key={s} label={severityPlural(s)} value={number(countBySeverity[s])} class={`pending-kpi-sev sev-${s}${countBySeverity[s] ? '' : ' zero'}`}
            highlight={segment === 'open' && severityFilter === s} info={t('pending.severityInfo', { about: t(`pending.severityAbout.${s}`) })}
            onClick={() => change('open', severityFilter === s ? null : s)} />
        ))}
        <Kpi label={t('pending.answered')} value={number(g.answered.length)} highlight={segment === 'answered'}
          onClick={() => change('answered')} info={t('pending.answeredInfo')} />
        <Kpi label={t('pending.closed')} value={number(g.closed.length)} highlight={segment === 'closed'}
          onClick={() => change('closed')} info={t('pending.closedInfo')} />
        <Kpi label={t('pending.oldest')} value={oldest ? shortAge(oldest.opened_at) : '—'}
          info={oldest ? t('pending.oldestInfo', { id: oldest.id, title: txt(oldest.title), opened: dateTime(oldest.opened_at) }) : t('pending.noneOpen')}
          onClick={oldest ? () => { change('open'); setChosen(oldest.id); } : undefined} />
      </div>

      <Card scroll flush class="pending-list-col" aria-label={t('pending.listLabel')}
        actions={<Segmented label={t('pending.groupLabel')} value={segment} onChange={(v) => change(v)}
          options={[{ id: 'open', name: t('pending.open'), n: g.open.length }, { id: 'answered', name: t('pending.answered'), n: g.answered.length }, { id: 'closed', name: t('pending.closed'), n: g.closed.length }]} />}>
        {segment === 'open' && severityFilter && (
          <div class="pending-filter">
            <button type="button" class="chip-filter" onClick={() => setSeverityFilter(null)} aria-label={t('pending.removeFilter', { severity: severityFilterName })}>
              {t('pending.onlySeverity', { severity: severityFilterName })} <Icon of={X} size={12} />
            </button>
          </div>
        )}
        {!list.length && <Empty icon={Inbox} center>{emptyText}</Empty>}
        <div class="list pending-list" role="listbox" aria-label={t('pending.listboxLabel')}>
          {list.map((p) => {
            const sev = severityOf(p);
            return (
              <button type="button" key={p.id} id={domId(p.id)} role="option"
                aria-selected={current && current.id === p.id ? 'true' : 'false'} class="pending-item" onClick={() => setChosen(p.id)}>
                <span class="pending-bar" style={{ background: SEVERITY_COLOR[sev] }} aria-hidden="true" />
                <span class="pending-top">
                  <span class="mono">{txt(p.id)}</span>
                  <span class="muted tiny">{pendingTypeName(p.type)}</span>
                  <span class="spacer" />
                  <span class="muted tiny" title={dateTime(p.opened_at)}>{age(p.opened_at)}</span>
                </span>
                <span class="pending-title two-lines">{txt(p.title) || t('pending.noTitle')}</span>
                <span class="pending-foot"><Agent slug={p.agent} size={7} /></span>
              </button>
            );
          })}
        </div>
      </Card>

      <section class="card pending-detail" tabindex="-1" ref={detail} aria-live="polite">
        {current ? <PendingDetail p={current} /> : <Empty icon={Inbox} center>{t('pending.choose')}</Empty>}
      </section>

      <section class="card pending-panel" aria-label={t('pending.answer')}>
        {current
          ? (isOpen(current)
            ? <AnswerForm key={current.id} p={current} onAnswer={answered} />
            : <GivenAnswer p={current} />)
          : <Empty center>{t('pending.answerHere')}</Empty>}
      </section>

      {notice && (
        <div class={`pending-notice ${notice.tone}`} role="status">
          <Icon of={notice.tone === 'ok' ? CircleCheck : TriangleAlert} size={16} />
          <span>{notice.text}</span>
          <button type="button" class="button small icon-only" onClick={() => setNotice(null)} aria-label={t('pending.closeNotice')}><Icon of={X} size={14} /></button>
        </div>
      )}
    </div>
  );
}

function PendingDetail({ p }) {
  const sev = severityOf(p);
  const status = p.status || OPEN;
  return (
    <div class="pending-content">
      <div class="pending-head">
        <span class="mono pending-id">{txt(p.id)}</span>
        <SeverityBadge sev={sev} filled={sev === 'critica'} />
        {p.type && <Badge>{pendingTypeName(p.type)}</Badge>}
        {status !== OPEN && <Badge tone={status === 'resolvida' ? 'ok' : status === ANSWERED ? 'blue' : 'neutral'}>{status}</Badge>}
        <Agent slug={p.agent} />
        <span class="muted" title={dateTime(p.opened_at)}>{t('pending.openedAgo', { age: age(p.opened_at) })}</span>
        {p.flow_id && <Flow id={p.flow_id} />}
      </div>
      <h2 class="pending-heading">{txt(p.title) || t('pending.noTitle')}</h2>
      {p.context && <p class="pending-context pre">{txt(p.context)}</p>}
    </div>
  );
}

/** Answer form: option (when there are options) + comment. Ctrl+Enter sends. */
function AnswerForm({ p, onAnswer }) {
  const { state } = usePanel();
  const options = optionsOf(p);
  const recommended = recommendedLetter(p, options);
  const [option, setOption] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const answers = (state && state.answers) || null;
  const noticeOn = !!(answers && answers.brain_notice);
  const ready = !sending && (!!option || !!text.trim());

  const send = async () => {
    if (!ready) return;
    setSending(true);
    setError(null);
    try {
      const r = await answerPendingDecision(p, { option, text: text.trim() });
      onAnswer(r, p);
    } catch (e) {
      setError(e.message || String(e));
      setSending(false);
    }
  };
  const key = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } };
  // ↑ ↓ change the option with the focus on the group (radio pattern)
  const arrows = (e) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d || !options.length) return;
    e.preventDefault();
    const i = Math.max(0, options.findIndex((o) => o.letter === option));
    const j = option ? (i + d + options.length) % options.length : 0;
    setOption(options[j].letter);
    const b = document.getElementById(`option-${p.id}-${options[j].letter}`);
    if (b) b.focus();
  };

  let sendHint = t('pending.hintNothing');
  if (option) sendHint = text.trim() ? t('pending.hintOptionComment', { option }) : t('pending.hintOption', { option });
  else if (text.trim()) sendHint = t('pending.hintComment');
  let sendLabel = t('pending.answerButton');
  if (sending) sendLabel = t('pending.sending');
  else if (noticeOn) sendLabel = t('pending.answerAndSend');

  return (
    <div class="pending-form" onKeyDown={key}>
      <div class="pending-form-head">
        <h2 class="label">{t('pending.yourAnswer')}</h2>
        <InfoHint title={t('pending.whereItGoes')}>
          {noticeOn
            ? t('pending.whereOn')
            : t('pending.whereOff', { reason: answers && answers.reason ? t('pending.whereOffReason', { reason: txt(answers.reason) }) : '' })}
        </InfoHint>
      </div>

      {p.recommendation && (
        <div class="pending-recommendation"><span class="label blue">{t('pending.recommendation')}</span><p>{txt(p.recommendation)}</p></div>
      )}

      {options.length > 0 && (
        <div class="pending-options" role="radiogroup" aria-label={t('pending.options')} onKeyDown={arrows}>
          {options.map((o, i) => {
            const checked = option === o.letter;
            return (
              <button type="button" key={o.letter} id={`option-${p.id}-${o.letter}`} role="radio" aria-checked={checked ? 'true' : 'false'}
                tabindex={checked || (!option && i === 0) ? 0 : -1} class="pending-option" onClick={() => setOption(checked ? null : o.letter)}>
                <span class="pending-letter" aria-hidden="true">{o.letter}</span>
                <span class="pending-option-text">{o.text}</span>
                {recommended === o.letter && <Badge tone="blue" class="pending-reco">{t('pending.recommended')}</Badge>}
              </button>
            );
          })}
        </div>
      )}

      <label class="pending-comment">
        <span class="label">{options.length ? t('pending.commentOptional') : t('pending.answer')}</span>
        <textarea rows={options.length ? 3 : 6} maxLength={2000} value={text} onInput={(e) => setText(e.currentTarget.value)}
          placeholder={options.length ? t('pending.commentPlaceholder') : t('pending.answerPlaceholder')} />
      </label>

      {error && <p class="pending-error" role="alert"><Icon of={TriangleAlert} size={14} />{error}</p>}

      <div class="pending-send">
        <span class="muted tiny">{t('pending.sendHint', { hint: sendHint })}</span>
        <button type="button" class="button primary" disabled={!ready} onClick={send}>
          <Icon of={sending ? LoaderCircle : Send} size={15} class={sending ? 'spin' : undefined} />
          {sendLabel}
        </button>
      </div>
    </div>
  );
}

/** Pending decision already answered or closed: the answer given and the dates. */
function GivenAnswer({ p }) {
  const status = p.status || OPEN;
  return (
    <div class="pending-form">
      <div class="pending-form-head"><h2 class="label">{t('pending.answer')}</h2></div>
      {p.answer
        ? <div class="pending-answer"><span class="label">{p.answered_at ? t('pending.ownerAnswerAt', { when: dateTime(p.answered_at) }) : t('pending.ownerAnswer')}</span><p>{txt(p.answer)}</p></div>
        : <p class="muted">{t('pending.noAnswer')}</p>}
      {p.note && <div class="pending-answer"><span class="label">{t('pending.closerNote')}</span><p>{txt(p.note)}</p></div>}
      {p.reason && <div class="pending-answer"><span class="label">{t('pending.cancelReason')}</span><p>{txt(p.reason)}</p></div>}
      <dl class="pending-dates">
        <dt>{t('pending.openedLabel')}</dt><dd>{dateTime(p.opened_at)}</dd>
        {p.answered_at && <><dt>{t('pending.answeredLabel')}</dt><dd>{dateTime(p.answered_at)}</dd></>}
        {p.resolved_at && <><dt>{status === 'cancelada' ? t('pending.canceledLabel') : t('pending.resolvedLabel')}</dt><dd>{dateTime(p.resolved_at)}</dd></>}
      </dl>
      {status === ANSWERED && <p class="muted tiny">{t('pending.runningNote')}</p>}
    </div>
  );
}
