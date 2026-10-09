// Event of the Log (new model, #12): what the event recorded and the raw commands of the Claude Code sessions linked
// to it (GET /api/log/<id>). The link is by the branch of each session: an event of a task shows the commands of
// the sessions on that task's branch; an event of the item itself, those of the item's maestro; in both cases
// from the previous event of the same item and task until a minute after this one. ← → follow the Log page.
import { useEffect, useRef, useState } from 'preact/hooks';
import { readLogEvent } from '../data/api.js';
import { arr, obj, txt, time, hm, spDay, weekday, dateTimeSec, dayMonthFormat, toDate, truncate, number } from '../data/format.js';
import { t, has } from '../i18n/index.js';
import { Modal } from '../components/Modal.jsx';
import { Badge, Collapsible } from '../components/base.jsx';
import { Icon, ArrowLeft, ArrowRight, X, Check } from '../components/Icon.jsx';

/** Name of an event type; a type newer than this page shows up as itself. */
export const eventTypeName = (type) => (has(`log.types.${type}`) ? t(`log.types.${type}`) : txt(type));

/** One line about what the event recorded. */
export function eventDetail(e) {
  const p = obj(e && e.payload) || {};
  const stage = (s) => (has(`items.stages.${s}`) ? t(`items.stages.${s}`) : txt(s));
  if (e.type === 'item-started') return t('log.detail.itemStarted', { stage: stage(p.stage) });
  if (e.type === 'stage-changed') return stage(p.stage);
  return '';
}

/** "Maestro · <name>" from {role, name}. */
export function agentText(agent) {
  const a = obj(agent) || {};
  const role = a.role && has(`items.roles.${a.role}`) ? t(`items.roles.${a.role}`) : txt(a.role);
  return [role, txt(a.name)].filter(Boolean).join(' · ');
}

export function LogEventModal({ id, ids, onOpen, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setError(null);
    readLogEvent(id).then((d) => { if (n === seq.current) setData(d); })
      .catch((e) => { if (n === seq.current) { setData(null); setError(e); } });
  }, [id]);

  const i = ids.indexOf(id);
  const newer = i > 0 ? ids[i - 1] : null;
  const older = i >= 0 && i < ids.length - 1 ? ids[i + 1] : null;
  const navRef = useRef(null);
  navRef.current = (direction) => { const target = direction < 0 ? newer : older; if (target !== null) onOpen(target); };
  useEffect(() => {
    const key = (ev) => {
      const el = ev.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key === 'ArrowLeft') { navRef.current(-1); ev.preventDefault(); } else if (ev.key === 'ArrowRight') { navRef.current(1); ev.preventDefault(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const nav = (
    <div class="modal-nav">
      <button type="button" class="button icon-only" aria-label={t('logModal.newerAria')} title={t('logModal.newerTitle')} disabled={newer === null} onClick={() => onOpen(newer)}><Icon of={ArrowLeft} /></button>
      <button type="button" class="button icon-only" aria-label={t('logModal.olderAria')} title={t('logModal.olderTitle')} disabled={older === null} onClick={() => onOpen(older)}><Icon of={ArrowRight} /></button>
      <button type="button" class="button icon-only" aria-label={t('common.closeEsc')} title={t('common.closeEsc')} onClick={onClose}><Icon of={X} /></button>
    </div>
  );
  const loaded = data && data.event && data.event.id === id ? data : null;
  let status = t('logModal.loading');
  if (error) status = error.status === 404 ? t('logModal.gone', { id }) : t('logModal.openFailed', { message: error.message });
  return (
    <Modal onClose={onClose} labelId="log-modal-title">
      {loaded ? <EventBody d={loaded} nav={nav} /> : (
        <div class="modal-head">
          <div class="info"><span id="log-modal-title" class="when">{status}</span></div>
          {nav}
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children, class: className }) {
  return <section class={`modal-section${className ? ` ${className}` : ''}`}><h3 class="label">{title}</h3>{children}</section>;
}

function EventBody({ d, nav }) {
  const ev = d.event;
  const project = obj(ev.project) || {};
  const company = obj(project.company) || {};
  const item = obj(d.item);
  const link = obj(d.raw_link) || {};
  const raw = arr(d.raw_commands);
  const total = Number(d.raw_commands_total) || raw.length;
  const payload = obj(ev.payload) || {};
  const rawSummary = total > raw.length
    ? t('logModal.rawCommandsOf', { count: number(raw.length), total: number(total) })
    : t('logModal.rawCommands', { count: number(raw.length) });
  const linkText = link.by === 'task'
    ? t('logModal.linkTask', { task: link.task_number, start: dateTimeSec(link.start), end: time(link.end) })
    : t('logModal.linkItem', { ref: txt(ev.tracker_ref), start: dateTimeSec(link.start), end: time(link.end) });
  return (
    <>
      <div class="modal-head">
        <div class="info">
          <span class="when" id="log-modal-title">{ev.at ? t('logModal.when', { weekday: weekday(ev.at), dateTime: dateTimeSec(ev.at) }) : t('common.noDate')}</span>
          <Badge>{eventTypeName(ev.type)}</Badge>
          <span class="mono">{txt(ev.tracker_ref)}</span>
          {item && item.title && <span class="text-2">{txt(item.title)}</span>}
          <span class="mono muted tiny">{t('logModal.eventId', { id: ev.id })}</span>
        </div>
        {nav}
      </div>
      <div class="modal-body">
        <div class="modal-grid">
          <div class="modal-col">
            <Section title={t('logModal.what')}>
              <p class="summary-large">{eventTypeName(ev.type)}{eventDetail(ev) ? ` · ${eventDetail(ev)}` : ''}</p>
              <dl class="log-facts">
                <dt>{t('logModal.item')}</dt><dd>{item ? t('logModal.itemValue', { ref: txt(ev.tracker_ref), stage: has(`items.stages.${item.stage}`) ? t(`items.stages.${item.stage}`) : txt(item.stage) }) : txt(ev.item_key)}</dd>
                <dt>{t('logModal.project')}</dt><dd>{t('logModal.projectValue', { project: txt(project.name), company: txt(company.name) })}</dd>
                <dt>{t('logModal.task')}</dt><dd>{ev.task_number === null || ev.task_number === undefined ? t('logModal.noTask') : `#${ev.task_number}`}</dd>
                <dt>{t('logModal.agent')}</dt><dd>{agentText(ev.agent) || t('logModal.noAgent')}</dd>
                <dt>{t('logModal.source')}</dt><dd class="mono">{txt(ev.source)}</dd>
              </dl>
            </Section>
          </div>
          <div class="modal-col">
            <Section title={t('logModal.payload')}>
              {Object.keys(payload).length ? <div class="pre mono small">{JSON.stringify(payload, null, 2)}</div> : <p class="muted">{t('logModal.noPayload')}</p>}
            </Section>
          </div>
        </div>
        <Section title={t('logModal.rawTitle')} class="wide">
          <Collapsible storeKey="log-modal-raw" summary={rawSummary} open>
            <p class="muted small" style={{ marginBottom: '6px' }}>{linkText}</p>
            {raw.length ? <RawTable raw={raw} eventDay={spDay(ev.at)} /> : <p class="muted">{t('logModal.noRaw')}</p>}
            {total > raw.length && <p class="muted small" style={{ marginTop: '6px' }}>{t('logModal.omitted', { count: number(total - raw.length) })}</p>}
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
        <colgroup><col style={{ width: '86px' }} /><col style={{ width: '110px' }} /><col style={{ width: '150px' }} /><col style={{ width: '100px' }} /><col /><col style={{ width: '70px' }} /></colgroup>
        <thead><tr>{['time', 'session', 'branch', 'tool', 'command', 'status'].map((k) => <th scope="col" key={k}>{t(`logModal.rawCol.${k}`)}</th>)}</tr></thead>
        <tbody>
          {raw.map((c) => {
            const text = c.input !== null && c.input !== undefined ? txt(c.input)
              : typeof c.prompt === 'string' ? t('logModal.promptText', { prompt: c.prompt })
                : txt(c.error) || txt(c.output_summary) || txt(c.detail) || '';
            const tool = c.tool ? txt(c.tool) : c.hook_event === 'UserPromptSubmit' ? t('logModal.prompt') : txt(c.hook_event) || '—';
            const failed = c.ok === false || c.hook_event === 'PostToolUseFailure';
            const title = [text, c.output_summary ? t('logModal.output', { output: c.output_summary }) : '', c.error ? t('logModal.error', { error: c.error }) : ''].filter(Boolean).join('\n');
            return (
              <tr key={c.id} class={failed ? 'failure' : ''}>
                <td title={dateTimeSec(c.at)}>{spDay(c.at) === eventDay ? time(c.at) : `${dayMonthFormat.format(toDate(c.at) || new Date(0))} ${hm(c.at)}`}</td>
                <td class="mono" title={txt(c.session)}>{truncate(txt(c.session), 12)}</td>
                <td class="mono" title={txt(c.branch)}>{truncate(txt(c.branch), 22) || '—'}</td>
                <td title={txt(c.hook_event)}>{tool}</td>
                <td class="mono" title={truncate(title, 2000)}>{truncate(text, 220) || '—'}</td>
                <td>{c.ok === true
                  ? <span class="result" style={{ color: 'var(--ok)' }}><Icon of={Check} size={13} />{t('logModal.ok')}</span>
                  : failed ? <span class="result" style={{ color: 'var(--danger)' }}><Icon of={X} size={13} />{t('logModal.failure')}</span> : <span class="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
