// Owner's pending decisions of the new model (#10): numbers on top (open ones by severity, resolved, canceled), the list
// on the left with the status filter, the pending decision in the middle (item, task, context, options, recommendation
// and, once closed, the decision) and, on the right, the answer (#32): for an open one, the form (options that only
// select, the recommended one highlighted, a comment and "Enviar resposta", POST /api/pending-decisions/<id>/answer), a
// note on when the maestro learns of it and, below, the workspace and the terminal of the maestro in the Maestri, the
// other way to answer; for a closed one, the dates and who closed it. A discreet line under the title says when the
// Maestri's notification failed as it opened (#44, notification 'failed'; nothing for the others or the older ones). Reads GET /api/pending-decisions every 20 s; each
// column scrolls inside. The organization comes from the selector at the top of the panel (#6, organizationFilter), like
// in the other screens of the new model.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { REFRESH_MS, readPendingDecisions, answerPendingDecision } from '../data/api.js';
import { objs, obj, arr, txt, age, dateTime, number } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Kpi, Badge, Segmented, Empty, InfoHint } from '../components/base.jsx';
import { Icon, Inbox, Send, X } from '../components/Icon.jsx';
import { pendingTitle, SEVERITIES, SEVERITY_TONE, MAX_DECISION, optionLetters, recommendedLetter, decisionText } from '../data/domain.js';
import { TrackerLink } from './ItemDelivery.jsx';
import '../styles/pending-decisions.css';

const STATUSES = ['open', 'resolved', 'canceled'];
// Resolved without the owner's decision: by the task's integration, an approved HML, the item's conclusion or the
// maestro's own HML pending decision (bin/flow-projection.js).
const AUTO_RESOLUTIONS = ['task_integrated', 'hml_approved', 'item_done', 'replaced'];
const STATUS_TONE = { open: 'blue', resolved: 'ok', canceled: 'neutral' };
const ref = (p) => t('pending.ref', { id: p.id });
const domId = (p) => `pending-${p.id}`;
const severityName = (s) => t(`pending.severities.${SEVERITIES.includes(s) ? s : 'normal'}`);
const kindName = (k) => t(`pending.kinds.${k}`);
const statusName = (s) => t(`pending.statuses.${s}`);
/** "Portal Contoso · Contoso": the project and its organization. */
const projectName = (it) => {
  const p = obj(it.project) || {};
  const organization = obj(p.organization) || {};
  return [txt(p.name || p.id), txt(organization.name)].filter(Boolean).join(' · ');
};

/** The filters and the organization of the selector → query parameters of /api/pending-decisions (only the ones chosen). */
function params(f, organizationFilter) {
  const sp = {};
  if (organizationFilter && organizationFilter.organization) sp.organization = organizationFilter.organization;
  if (f.status !== 'all') sp.status = f.status;
  if (f.severity) sp.severity = f.severity;
  return sp;
}

export function PendingDecisions() {
  const { pendingTarget, setActionStatus, goTo, organization, organizationFilter } = usePanel();
  const [filters, setFilters] = useState({ status: 'open', severity: null });
  const [read, setRead] = useState({ answer: null, error: null });
  const [chosen, setChosen] = useState(null);
  // The pending decision just answered (or closed before the answer went out): it stays on screen, closed, even when
  // the status filter takes it out of the list.
  const [kept, setKept] = useState(null);
  const detail = useRef(null);
  const seq = useRef(0);

  // The open pending decision on screen ({ id, query }): when a new reading of the same query no longer has it open,
  // it was closed elsewhere (the maestro, an integration, a cancel) and closedMeanwhile shows how.
  const shownOpen = useRef(null);
  const onClosed = useRef(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const query = params(filters, organizationFilter);
    try {
      const answer = await readPendingDecisions(query);
      if (mine !== seq.current) return;
      setRead({ answer, error: null });
      const open = shownOpen.current;
      if (open && open.query === JSON.stringify(query)) {
        const now = objs(answer && answer.pending_decisions).find((p) => p.id === open.id);
        if (!now || now.status !== 'open') onClosed.current(open.id, { reload: false });
      }
    } catch (error) {
      if (mine === seq.current) setRead((r) => ({ answer: r.answer, error }));
    }
  }, [filters, organizationFilter]);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const answer = read.answer;
  const list = objs(answer && answer.pending_decisions);
  const counts = obj(answer && answer.counts) || {};
  const byStatus = obj(counts.status) || {};
  const bySeverity = obj(counts.severity) || {};
  // The kept one wins over the list: it is already closed (final), while the list may still hold the open copy read
  // before the answer.
  const current = (kept && kept.id === chosen ? kept : null) || list.find((p) => p.id === chosen) || list[0] || null;
  shownOpen.current = current && current.status === 'open' ? { id: current.id, query: JSON.stringify(params(filters, organizationFilter)) } : null;

  /** After the answer: the pending decision as the server recorded it, and the lists read again. */
  const answered = (p) => {
    shownOpen.current = null;
    setKept(p);
    setChosen(p.id);
    setActionStatus(t('pending.answered', { id: p.id }));
    load();
  };
  /**
   * Closed meanwhile (a 409 on the answer, or a reading where it is no longer open): says so and shows it as it is now,
   * read with every status.
   */
  const closedMeanwhile = async (id, { reload = true } = {}) => {
    shownOpen.current = null;
    setActionStatus(t('pending.alreadyClosed', { id }));
    if (reload) load();
    try {
      const all = await readPendingDecisions(params({ status: 'all', severity: null }, organizationFilter));
      const now = objs(all && all.pending_decisions).find((p) => p.id === id);
      if (now) { setKept(now); setChosen(id); }
    } catch (_) { /* the next reading shows it */ }
  };
  onClosed.current = closedMeanwhile;

  // Coming from a link to a pending decision (the Overview): shows it when it is in the list.
  useEffect(() => {
    if (!pendingTarget) return;
    const hit = list.find((p) => ref(p) === pendingTarget.id || String(p.id) === String(pendingTarget.id));
    if (!hit) { setActionStatus(t('pending.notInList', { id: pendingTarget.id })); return; }
    setChosen(hit.id);
    requestAnimationFrame(() => {
      const el = document.getElementById(domId(hit));
      if (el) el.scrollIntoView({ block: 'nearest' });
      if (detail.current) detail.current.focus({ preventScroll: true });
    });
  }, [pendingTarget]);

  const change = (f) => { setFilters((x) => ({ ...x, ...f })); setChosen(null); };
  const statusOptions = [...STATUSES, 'all'].map((s) => ({ id: s, name: s === 'all' ? t('pending.allStatuses') : statusName(s), n: s === 'all' ? undefined : number(byStatus[s] || 0) }));

  return (
    <div class="screen screen-pending">
      <div class="pending-kpis">
        <Kpi label={statusName('open')} value={number(byStatus.open || 0)} highlight={filters.status === 'open' && !filters.severity}
          onClick={() => change({ status: 'open', severity: null })} info={t('pending.openInfo')} />
        {SEVERITIES.map((s) => (
          <Kpi key={s} label={t(`pending.severityPlural.${s}`)} value={number(bySeverity[s] || 0)} class={`pending-kpi-sev sev-${s}${bySeverity[s] ? '' : ' zero'}`}
            highlight={filters.severity === s} info={t('pending.severityInfo', { about: t(`pending.severityAbout.${s}`) })}
            onClick={() => change({ severity: filters.severity === s ? null : s })} />
        ))}
        <Kpi label={statusName('resolved')} value={number(byStatus.resolved || 0)} highlight={filters.status === 'resolved'}
          onClick={() => change({ status: 'resolved' })} info={t('pending.resolvedInfo')} />
        <Kpi label={statusName('canceled')} value={number(byStatus.canceled || 0)} highlight={filters.status === 'canceled'}
          onClick={() => change({ status: 'canceled' })} info={t('pending.canceledInfo')} />
      </div>

      <Card scroll flush class="pending-list-col" aria-label={t('pending.listLabel')}
        actions={<Segmented label={t('pending.statusLabel')} value={filters.status} onChange={(v) => change({ status: v })} options={statusOptions} />}>
        {filters.severity && (
          <div class="pending-filter">
            <button type="button" class="chip-filter" onClick={() => change({ severity: null })} aria-label={t('pending.removeFilter', { severity: t(`pending.severityPlural.${filters.severity}`) })}>
              {t('pending.onlySeverity', { severity: t(`pending.severityPlural.${filters.severity}`) })} <Icon of={X} size={12} />
            </button>
          </div>
        )}
        {read.error && <p class="pending-error" role="alert">{t('pending.readFailed', { message: read.error.message })}</p>}
        {answer && !list.length && <Empty icon={Inbox} center>{filters.status === 'open' && !filters.severity && !organization ? t('pending.emptyOpen') : t('pending.emptyFilter')}</Empty>}
        <div class="list pending-list" role="listbox" aria-label={t('pending.listboxLabel')}>
          {list.map((p) => {
            const it = obj(p.item) || {};
            return (
              <button type="button" key={p.id} id={domId(p)} role="option"
                aria-selected={current && current.id === p.id ? 'true' : 'false'} class="pending-item" onClick={() => setChosen(p.id)}>
                <span class={`pending-bar sev-${p.severity}`} aria-hidden="true" />
                <span class="pending-top">
                  <span class="mono">{ref(p)}</span>
                  <span class="muted tiny">{kindName(p.kind)}</span>
                  <span class="spacer" />
                  <span class="muted tiny" title={dateTime(p.opened_at)}>{age(p.opened_at)}</span>
                </span>
                <span class="pending-title two-lines">{pendingTitle(p)}</span>
                <span class="pending-foot muted tiny">{t('pending.itemLine', { ref: txt(it.tracker_ref), project: projectName(it) })}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <section class="card pending-detail" tabindex="-1" ref={detail} aria-live="polite">
        {current ? <PendingDetail p={current} goTo={goTo} /> : <Empty icon={Inbox} center>{t('pending.choose')}</Empty>}
      </section>

      <section class="card pending-panel" aria-label={t(current && current.status === 'open' ? 'pending.answerTitle' : 'pending.whereTitle')}>
        {!current ? <Empty center>{t('pending.answerEmpty')}</Empty>
          : current.status === 'open' ? <Answer key={current.id} p={current} onAnswered={answered} onClosed={closedMeanwhile} />
            : <WhereToAnswer p={current} />}
      </section>
    </div>
  );
}

function PendingDetail({ p, goTo }) {
  const it = obj(p.item) || {};
  const task = obj(p.task);
  const options = arr(p.options).map(txt).filter(Boolean);
  return (
    <div class="pending-content">
      <div class="pending-head">
        <span class="mono pending-id">{ref(p)}</span>
        <Badge tone={SEVERITY_TONE[p.severity] || 'neutral'} filled={p.severity === 'critical'}>{severityName(p.severity)}</Badge>
        <Badge>{kindName(p.kind)}</Badge>
        <Badge tone={STATUS_TONE[p.status] || 'neutral'}>{t(`pending.status.${p.status}`)}</Badge>
        <span class="muted" title={dateTime(p.opened_at)}>{t('pending.openedAgo', { age: age(p.opened_at) })}</span>
      </div>
      <h2 class="pending-heading">{pendingTitle(p)}</h2>
      {p.notification === 'failed' && <p class="muted small pending-notification">{t('pending.notificationFailed')}</p>}
      <dl class="pending-facts">
        <dt>{t('pending.item')}</dt>
        <dd>
          <button type="button" class="link-button" onClick={() => goTo('items', txt(it.key))} title={t('pending.openItem')}>
            <span class="mono">{txt(it.tracker_ref)}</span> {txt(it.title)}
          </button>
          <span class="muted small"> · {projectName(it)} · {t(`items.stages.${it.stage}`)}</span>
        </dd>
        <dt>{t('pending.task')}</dt>
        <dd>{task
          ? <>{t('pending.taskLine', { task: task.number, title: txt(task.title) || t('items.tasks.untitled') })}{task.state && <Badge class="pending-task-state">{t(`items.tasks.states.${task.state}`)}</Badge>}</>
          : <span class="muted">{t('pending.noTask')}</span>}
        </dd>
      </dl>
      {p.context && <p class="pending-context pre">{txt(p.context)}</p>}
      {obj(p.derived_from) && (
        <p class="pending-context">
          {t('pending.derivedHmlContext', { passed: p.derived_from.passed, failed: p.derived_from.failed, blocked: p.derived_from.blocked })}
          {p.derived_from.card_url && <> <TrackerLink url={p.derived_from.card_url}>{t('pending.derivedHmlCard')}</TrackerLink></>}
        </p>
      )}
      {options.length > 0 && (
        <div class="pending-options-read">
          <span class="label">{t('pending.options')}</span>
          <ul class="pending-options">{options.map((o) => <li key={o}>{o}</li>)}</ul>
        </div>
      )}
      {p.recommendation && (
        <div class="pending-recommendation"><span class="label blue">{t('pending.recommendation')}</span><p class="pre">{txt(p.recommendation)}</p></div>
      )}
      {p.status === 'resolved' && (
        <div class="pending-answer">
          <span class="label">{AUTO_RESOLUTIONS.includes(p.resolution) ? t(`pending.resolvedBy.${p.resolution}`) : t('pending.decision')}</span>
          {AUTO_RESOLUTIONS.includes(p.resolution)
            ? <p>{t(`pending.resolvedText.${p.resolution}`, { task: task ? task.number : '—' })}</p>
            : <p class="pre">{txt(p.decision) || t('pending.noDecision')}</p>}
        </div>
      )}
      {p.status === 'canceled' && (
        <div class="pending-answer"><span class="label">{t('pending.cancelReason')}</span><p class="pre">{txt(p.reason) || t('pending.noReason')}</p></div>
      )}
    </div>
  );
}

/**
 * The owner's answer to an open pending decision (#32): the options only select (the recommended one highlighted), the
 * comment is optional, or required when there are no options, and only "Enviar resposta" records. A failed answer keeps
 * what was written; a 409 (closed meanwhile) goes to onClosed(id), the recorded one to onAnswered(pending decision).
 */
function Answer({ p, onAnswered, onClosed }) {
  const options = arr(p.options).map(txt).filter(Boolean);
  const letters = optionLetters(options);
  const recommended = recommendedLetter(p.recommendation, letters);
  const [letter, setLetter] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosen = letter ? options[letters.indexOf(letter)] : '';
  const length = decisionText(chosen, comment.replace(/\r\n?/g, '\n').trim()).length;
  const tooLong = length > MAX_DECISION;
  const ready = !busy && !tooLong && (!!letter || comment.trim() !== '');
  const send = async (ev) => {
    ev.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      onAnswered(await answerPendingDecision(p.id, letter, comment));
    } catch (e) {
      // 409: the form stays disabled until the screen shows how the pending decision closed.
      if (e.status === 409) onClosed(p.id);
      else {
        setBusy(false);
        setError(t('pending.answerFailed', { message: e.message }));
      }
    }
  };
  return (
    <div class="pending-form">
      <div class="pending-form-head">
        <h2 class="label">{t('pending.answerTitle')}</h2>
        <InfoHint text={t('pending.answerInfo')} />
      </div>
      <form class="pending-answer-form" onSubmit={send}>
        {options.length > 0 && (
          <div class="pending-choices" role="group" aria-label={t('pending.options')}>
            {options.map((o, i) => (
              <button type="button" key={`${letters[i]}-${o}`} class={`pending-choice${letters[i] === recommended ? ' recommended' : ''}`}
                aria-pressed={letter === letters[i] ? 'true' : 'false'} disabled={busy} onClick={() => setLetter(letter === letters[i] ? null : letters[i])}>
                <span class="pending-choice-text">{o}</span>
                {letters[i] === recommended && <Badge tone="blue" class="pending-choice-badge">{t('pending.recommended')}</Badge>}
              </button>
            ))}
          </div>
        )}
        <label class="field">
          <span class="label">{options.length ? t('pending.commentOptional') : t('pending.comment')}</span>
          <textarea class="pending-comment" rows={4} value={comment} disabled={busy} aria-invalid={tooLong ? 'true' : undefined}
            placeholder={options.length ? t('pending.commentHintOptions') : t('pending.commentHintNoOptions')} onInput={(e) => setComment(e.currentTarget.value)} />
        </label>
        {tooLong && <p class="pending-form-error small">{t('pending.answerTooLong', { count: length, max: MAX_DECISION })}</p>}
        {error && <p class="pending-form-error small" role="alert">{error}</p>}
        <button type="submit" class="button primary pending-send" disabled={!ready}>
          <Icon of={Send} size={15} />{busy ? t('pending.sending') : t('pending.send')}
        </button>
      </form>
      <p class="muted tiny">{t('pending.answerNote')}</p>
      <div class="pending-form-head">
        <h3 class="label">{t('pending.otherWayTitle')}</h3>
      </div>
      <MaestroTerminal p={p} />
      <PendingDates p={p} />
    </div>
  );
}

/** Where to answer (the maestro's Maestri terminal) and the dates of a closed pending decision. */
function WhereToAnswer({ p }) {
  return (
    <div class="pending-form">
      <div class="pending-form-head">
        <h2 class="label">{t('pending.whereTitle')}</h2>
        <InfoHint text={t('pending.whereInfo')} />
      </div>
      <MaestroTerminal p={p} />
      <PendingDates p={p} />
    </div>
  );
}

/** The workspace and the terminal of the maestro in the Maestri. */
function MaestroTerminal({ p }) {
  const m = obj(p.maestri) || {};
  if (!m.workspace && !m.terminal) return <p class="muted">{t('pending.whereUnknown')}</p>;
  return (
    <dl class="pending-dates pending-where">
      <dt>{t('pending.workspace')}</dt><dd>{txt(m.workspace) || '—'}</dd>
      <dt>{t('pending.terminal')}</dt><dd>{txt(m.terminal) || '—'}</dd>
    </dl>
  );
}

/** When the pending decision was opened and closed, and by whom. */
function PendingDates({ p }) {
  const who = (a) => {
    const x = obj(a) || {};
    return [x.role ? t(`items.roles.${x.role}`) : '', txt(x.name)].filter(Boolean).join(' · ') || '—';
  };
  return (
    <dl class="pending-dates">
      <dt>{t('pending.openedLabel')}</dt><dd>{dateTime(p.opened_at)} · {who(p.opened_by)}</dd>
      {p.closed_at && <><dt>{t(`pending.closedLabel.${p.status}`)}</dt><dd>{dateTime(p.closed_at)} · {who(p.closed_by)}</dd></>}
    </dl>
  );
}
