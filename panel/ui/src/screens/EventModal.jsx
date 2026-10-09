// Event modal (§11.5): summary and request, project, direction, flow sequence, steps and
// commands, changes, validation, next step and duration. ← (more recent) and → (older) follow the
// order of the filtered Log table; opened from the Overview or the Agents, they follow the order of time.
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { readEvent, readEvents } from '../data/api.js';
import { arr, obj, txt, time, hm, spDay, weekday, dateTimeSec, dayHeading, dayMonthFormat, toDate, truncate, duration, number } from '../data/format.js';
import { typeName, originName, agentInfo } from '../data/domain.js';
import { t } from '../i18n/index.js';
import { Modal } from '../components/Modal.jsx';
import { Badge, Collapsible } from '../components/base.jsx';
import { Agent, Project, Result, Flow } from '../components/domain.jsx';
import { Icon, ArrowLeft, ArrowRight, X, Check } from '../components/Icon.jsx';

export function EventModal() {
  const { state, modal, setModal, closeModal } = usePanel();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const pageSeq = useRef(0);
  const id = modal && modal.id;

  useEffect(() => {
    if (!id) return;
    const n = ++seq.current;
    setError(null);
    readEvent(id).then((d) => { if (n === seq.current) setData(d); })
      .catch((e) => { if (n === seq.current) { setData(null); setError(e); } });
  }, [id]);

  /** {id} of the neighbor or, at the edge of a Log page, {page, end}; null disables the arrow. */
  const neighbor = (direction) => {
    if (!id) return null;
    const list = modal.list || [];
    const table = modal.table;
    const i = list.indexOf(id);
    if (i >= 0) {
      const j = i + direction;
      if (j >= 0 && j < list.length) return { id: list[j] };
      if (table) {
        if (direction > 0 && table.page < table.pages) return { page: table.page + 1, end: 'first' };
        if (direction < 0 && table.page > 1) return { page: table.page - 1, end: 'last' };
        return null; // start or end of the table
      }
    }
    if (table && table.filtered) return null; // outside the filtered list: does not go to events the table does not show
    if (!data || data.event.id !== id) return null; // the server's neighbors only count for the event already loaded
    const v = direction < 0 ? data.next_id : data.previous_id;
    return typeof v === 'string' && v ? { id: v } : null;
  };
  const navigate = async (direction) => {
    const target = neighbor(direction);
    if (!target) return;
    if (target.id) { setModal((m) => ({ ...m, id: target.id })); return; }
    const table = modal.table;
    const n = ++pageSeq.current;
    try {
      const sp = new URLSearchParams(table.params);
      sp.set('page', String(target.page));
      const r = await readEvents(sp);
      if (n !== pageSeq.current) return;
      const ids = arr(r.events).map((e) => e && e.id).filter((x) => typeof x === 'string' && x);
      if (!ids.length) return;
      setModal((m) => (m ? { id: target.end === 'last' ? ids[ids.length - 1] : ids[0], list: ids, table: { ...table, page: r.page || target.page, pages: r.pages || table.pages } } : m));
    } catch (e) {
      console.error('Could not fetch the neighbor page of the Log:', e);
    }
  };
  const navRef = useRef(navigate);
  navRef.current = navigate;
  useEffect(() => {
    const key = (ev) => {
      const el = ev.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key === 'ArrowLeft') { navRef.current(-1); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { navRef.current(1); ev.preventDefault(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const previous = neighbor(-1);
  const next = neighbor(1);
  const loaded = data && data.event && data.event.id === id ? data : null;
  const close = <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} onClick={closeModal}><Icon of={X} /></button>;
  const nav = (
    <div class="modal-nav">
      <button type="button" class="button icon-only" aria-label={t('eventModal.newerAria')} title={t('eventModal.newerTitle')} disabled={!previous} onClick={() => navigate(-1)}><Icon of={ArrowLeft} /></button>
      <button type="button" class="button icon-only" aria-label={t('eventModal.olderAria')} title={t('eventModal.olderTitle')} disabled={!next} onClick={() => navigate(1)}><Icon of={ArrowRight} /></button>
      {close}
    </div>
  );

  let status = t('eventModal.loading');
  if (error) status = error.status === 404 ? t('eventModal.gone', { id }) : t('eventModal.openFailed', { message: error.message });
  return (
    <Modal onClose={closeModal} labelId="modal-title">
      {!loaded ? (
        <div class="modal-head">
          <div class="info"><span id="modal-title" class="when">{status}</span></div>
          {nav}
        </div>
      ) : <EventBody d={loaded} state={state} nav={nav} />}
    </Modal>
  );
}

function Section({ title, children, class: className }) {
  return <section class={`modal-section${className ? ` ${className}` : ''}`}><h3 class="label">{title}</h3>{children}</section>;
}

function EventBody({ d, state, nav }) {
  const { openModal, goToPendingDecision } = usePanel();
  const ev = d.event;
  const flow = obj(d.flow);
  const req = obj(d.initial_request);
  const seq = arr(d.sequence);
  const listRef = useRef(null);
  useEffect(() => {
    // long sequence: scroll only the list to the current event
    const l = listRef.current;
    const current = l && l.querySelector('li.current');
    if (l && current && l.scrollHeight > l.clientHeight) l.scrollTop = Math.max(0, current.offsetTop - l.clientHeight / 2 + current.offsetHeight / 2);
  }, [ev.id]);

  const steps = arr(ev.steps);
  const commands = arr(ev.commands);
  const raw = arr(d.raw_commands);
  const win = obj(d.window_without_flow);
  const omitted = Number(d.raw_commands_omitted) || (typeof d.raw_commands_truncated === 'number' ? d.raw_commands_truncated : 0);
  const rawWarnings = arr(d.raw_commands_warnings).map(txt).filter(Boolean);
  const rawWarning = rawWarnings.length ? `${rawWarnings.join('; ')}.` : null;
  const changes = arr(ev.changes);
  const pending = arr(ev.pending_decisions);
  const dur = duration(ev.duration_s);

  let seqDay = null;
  const seqItems = [];
  for (const s of seq) {
    const day = spDay(s.ts);
    if (day !== seqDay && seq.length > 1) { seqItems.push(<li class="seq-day" key={`d-${day}`}>{dayHeading(s.ts)}</li>); seqDay = day; }
    const current = s.id === ev.id;
    seqItems.push(
      <li key={s.id || s.ts} class={current ? 'current' : ''} aria-current={current ? 'true' : undefined} tabindex={current ? undefined : '0'} role={current ? undefined : 'button'}
        onClick={() => { if (!current && s.id) openModal(s.id); }}
        onKeyDown={(k) => { if (!current && s.id && (k.key === 'Enter' || k.key === ' ')) { k.preventDefault(); openModal(s.id); } }}>
        <span class="muted">{time(s.ts)}</span>
        <Agent slug={s.agent} />
        <span class="muted truncate">{typeName(s.type)}</span>
        <span class="truncate" title={txt(s.summary)}>{txt(s.summary)}</span>
        <Result value={s.result} />
      </li>,
    );
  }

  const whoAsked = req
    ? [
      t('eventModal.whoAsked', { origin: req.origin ? originName(state, req.origin) : t('origins.unknown') }),
      req.origin_inferred ? t('eventModal.inferred') : '',
      req.ts ? ` · ${dateTimeSec(req.ts)}` : '',
      req.agent ? t('eventModal.receivedBy', { name: agentInfo(state, req.agent).name }) : '',
    ].join('')
    : '';
  const rawSummary = omitted
    ? t('eventModal.rawCommandsOf', { count: number(raw.length), total: number(raw.length + omitted) })
    : t('eventModal.rawCommands', { count: number(raw.length) });

  return (
    <>
      <div class="modal-head">
        <div class="info">
          <span class="when" id="modal-title">{ev.ts ? t('eventModal.when', { weekday: weekday(ev.ts), dateTime: dateTimeSec(ev.ts) }) : t('common.noDate')}</span>
          <Agent slug={ev.agent} />
          <Badge>{typeName(ev.type)}</Badge>
          <Result value={ev.result} />
          <Flow id={ev.flow_id} title={t('eventModal.filterTable')} />
          {flow && flow.title && <span class="text-2">{txt(flow.title)}</span>}
          {ev.test === true && <Badge tone="test">{t('common.test')}</Badge>}
          <span class="mono muted tiny">{txt(ev.id)}</span>
        </div>
        {nav}
      </div>
      <div class="modal-body">
        <div class="modal-grid">
          <div class="modal-col">
            <Section title={t('eventModal.summaryAndRequest')}>
              <p class="summary-large">{txt(ev.summary) || t('common.noSummary')}</p>
              {req && req.text && <p class="muted small">{t('eventModal.eventOrigin', { origin: originName(state, ev.origin) })}</p>}
              {req && req.text ? (
                <div class="request">
                  <div class="who">{whoAsked}</div>
                  <div class="request-text pre">{txt(req.text)}</div>
                </div>
              ) : (
                <div class="request"><div class="who">{t('eventModal.eventOrigin', { origin: originName(state, ev.origin) })}</div><div class="muted">{t('eventModal.requestNotFound')}</div></div>
              )}
            </Section>
            <Section title={t('eventModal.direction')}>
              {ev.direction ? <div class="direction pre">{txt(ev.direction)}</div> : <p class="muted">{t('eventModal.noDirection')}</p>}
            </Section>
            <Section title={seq.length ? t('eventModal.sequenceCount', { count: seq.length }) : t('eventModal.sequence')}>
              {seq.length ? <ol class="sequence" ref={listRef}>{seqItems}</ol> : <p class="muted">{t('eventModal.noSequence')}</p>}
            </Section>
          </div>
          <div class="modal-col">
            <Section title={t('eventModal.project')}>
              {ev.project ? <Project prefix={ev.project} /> : <p class="muted">{t('eventModal.noProject')}</p>}
            </Section>
            <Section title={t('eventModal.validation')}>{ev.validation ? <p>{txt(ev.validation)}</p> : <p class="muted">{t('eventModal.noValidation')}</p>}</Section>
            <Section title={t('eventModal.nextStep')}>
              {ev.next_step ? <p>{txt(ev.next_step)}</p> : <p class="muted">{t('eventModal.noNextStep')}</p>}
              {pending.length > 0 && <p style={{ marginTop: '6px' }}>{t('eventModal.pendingList')}{pending.map((p, i) => <span key={i}>{i ? ', ' : ''}<button type="button" class="link mono" onClick={() => goToPendingDecision(txt(p))}>{txt(p)}</button></span>)}</p>}
              {ev.needs_owner === true && <p style={{ marginTop: '8px' }}><Badge tone="blue" filled>{t('eventModal.needsOwner')}</Badge></p>}
            </Section>
            <Section title={t('eventModal.changes')}>
              {changes.length ? <ul class="plain-list">{changes.map((a, i) => <li key={i}>{txt(a)}</li>)}</ul> : <p class="muted">{t('eventModal.noChanges')}</p>}
            </Section>
            <Section title={t('eventModal.duration')}><p>{dur || <span class="muted">{t('eventModal.noDuration')}</span>}</p></Section>
          </div>
        </div>
        <Section title={t('eventModal.stepsAndCommands')} class="wide">
          <Collapsible storeKey="modal-steps" summary={t('eventModal.steps', { count: steps.length })} open>
            {steps.length ? <ol class="plain-list">{steps.map((p, i) => <li key={i}>{txt(p)}</li>)}</ol> : <p class="muted">{t('eventModal.noSteps')}</p>}
          </Collapsible>
          {commands.length > 0 && (
            <Collapsible storeKey="modal-commands" summary={t('eventModal.citedCommands', { count: commands.length })}>
              <ul class="plain-list mono">{commands.map((c, i) => <li key={i}>{txt(c)}</li>)}</ul>
            </Collapsible>
          )}
          <Collapsible storeKey="modal-raw" summary={rawSummary}>
            {win && <p class="muted small" style={{ marginBottom: '6px' }}>{win.session
              ? t('eventModal.windowWithSession', { start: dateTimeSec(win.start), end: time(win.end), session: truncate(win.session, 12) })
              : t('eventModal.window', { start: dateTimeSec(win.start), end: time(win.end) })}</p>}
            {raw.length ? <RawTable raw={raw} eventDay={spDay(ev.ts)} /> : <p class="muted">{t('eventModal.noRaw')}</p>}
            {omitted > 0 && <p class="muted small" style={{ marginTop: '6px' }}>{t('eventModal.omitted', { count: omitted, flow: txt(ev.flow_id) })}</p>}
            {rawWarning && <p class="muted small" style={{ marginTop: '6px' }}>{t('eventModal.partialRead', { warning: rawWarning })}</p>}
          </Collapsible>
        </Section>
      </div>
    </>
  );
}

function RawTable({ raw, eventDay }) {
  return (
    <div class="raw-box">
      <table class="table cmds">
        <colgroup><col style={{ width: '86px' }} /><col style={{ width: '176px' }} /><col style={{ width: '100px' }} /><col /><col style={{ width: '70px' }} /><col style={{ width: '70px' }} /></colgroup>
        <thead><tr>{['time', 'agent', 'tool', 'command', 'status', 'link'].map((k) => <th scope="col" key={k}>{t(`eventModal.rawCol.${k}`)}</th>)}</tr></thead>
        <tbody>
          {raw.map((c, i) => {
            const text = c.input !== null && c.input !== undefined ? txt(c.input) : typeof c.prompt === 'string' ? t('eventModal.promptText', { prompt: c.prompt }) : txt(c.error) || '';
            const tool = c.tool ? txt(c.tool) : c.hook_event === 'UserPromptSubmit' ? t('eventModal.prompt') : txt(c.hook_event) || '—';
            const failed = c.ok === false || c.hook_event === 'PostToolUseFailure';
            const byWindow = c.correlation === 'window';
            return (
              <tr key={i} class={failed ? 'failure' : ''}>
                <td title={dateTimeSec(c.ts)}>{spDay(c.ts) === eventDay ? time(c.ts) : `${dayMonthFormat.format(toDate(c.ts) || new Date(0))} ${hm(c.ts)}`}</td>
                <td><Agent slug={c.agent} /></td>
                <td title={txt(c.hook_event)}>{tool}</td>
                <td class="mono" title={truncate(text, 2000)}>{truncate(text, 220) || '—'}</td>
                <td>{c.ok === true
                  ? <span class="result" style={{ color: 'var(--ok)' }}><Icon of={Check} size={13} />{t('eventModal.ok')}</span>
                  : failed ? <span class="result" style={{ color: 'var(--danger)' }}><Icon of={X} size={13} />{t('eventModal.failure')}</span> : <span class="muted">—</span>}</td>
                <td class="muted" title={byWindow ? t('eventModal.linkWindowTitle') : t('eventModal.linkFlowTitle')}>{byWindow ? t('eventModal.linkWindow') : t('eventModal.linkFlow')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
