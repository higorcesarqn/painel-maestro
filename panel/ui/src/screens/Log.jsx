// Log (new model, #12): the events of every item (maestro.db), newest first, with filters by period, project, item
// and event type (the organization comes from the selector at the top of the panel, #6, like in the other screens), 50 per page (the table scrolls inside the card). A click or Enter on a row opens
// the event with the raw commands of the Claude Code sessions linked to it (bruto.db, written by the hook).
// The numbers of each option come from "counts" of /api/log (each filter ignores its own choice).
import '../styles/log.css';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { usePanel, newFilter } from '../data/context.js';
import { PAGE_SIZE, readItems } from '../data/api.js';
import { objs, obj, txt, number, date, time, dayMonth, spDay, dayHeading } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Card, Badge, Empty, Segmented, InfoHint } from '../components/base.jsx';
import { Select, DateField } from '../components/fields.jsx';
import { Icon, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, ScrollText } from '../components/Icon.jsx';
import { LogEventModal, eventTypeName, eventDetail, agentText } from './LogEventModal.jsx';

const PERIODS = ['today', '24h', '7d', '30d', 'all', 'custom'];
const KNOWN_TYPES = ['item-started', 'stage-changed', 'task-graph', 'task-dispatched', 'task-status', 'task-integrated',
  'pr-changed', 'final-adjustment-opened', 'final-adjustment-finished', 'hml-recorded', 'item-done', 'item-interrupted',
  'pending-decision-opened', 'pending-decision-resolved', 'pending-decision-canceled', 'task-report', 'finding-recorded', 'finding-linked'];
const withCount = (name, counts, key) => (counts ? `${name} · ${number(counts[key] || 0)}` : name);

export function Log() {
  const { filters: f, setFilters, page, setPage, log, organization, organizationFilter } = usePanel();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(null);
  // Projects and items to choose from: those of /api/items of the chosen organization, plus those that show up in the counts.
  useEffect(() => {
    let alive = true;
    readItems(organizationFilter).then((r) => { if (alive) setItems(objs(r && r.items)); }).catch(() => {});
    return () => { alive = false; };
  }, [log.answer, organizationFilter]);

  const r = log.answer;
  const events = objs(r && r.events);
  const counts = obj(r && r.counts) || {};
  const pages = r ? r.pages || Math.max(1, Math.ceil((r.total || 0) / (r.per_page || PAGE_SIZE))) : 1;

  const options = useMemo(() => {
    const projects = new Map();
    for (const it of items) {
      const p = obj(it.project) || {};
      const o = obj(p.organization) || {};
      if (p.id) projects.set(p.id, { name: txt(p.name) || p.id, organization: o.id || '' });
    }
    for (const k of Object.keys(obj(counts.project) || {})) if (!projects.has(k)) projects.set(k, { name: k, organization: '' });
    const types = [...new Set([...KNOWN_TYPES, ...Object.keys(obj(counts.type) || {}), ...(f.type ? [f.type] : [])])];
    const itemList = items.filter((it) => !f.project || (it.project && it.project.id === f.project));
    return { projects, types, items: itemList };
  }, [items, r, f.project, f.type]);

  const projectOptions = [['', t('log.allProjects')], ...[...options.projects]
    .filter(([, p]) => !organization || !p.organization || p.organization === organization)
    .map(([id, p]) => [id, withCount(p.name, counts.project, id)])];
  const itemOptions = [['', t('log.allItems')], ...options.items.map((it) => [it.key, t('log.itemOption', { ref: txt(it.tracker_ref), project: txt(it.project && it.project.name), title: txt(it.title) })])];
  if (f.item && !options.items.some((it) => it.key === f.item)) itemOptions.push([f.item, f.item]);
  const typeOptions = [['', t('log.allTypes')], ...options.types.map((k) => [k, withCount(eventTypeName(k), counts.type, k)])];
  const filtering = JSON.stringify(f) !== JSON.stringify(newFilter());

  const rows = [];
  let previousDay = null;
  for (const e of events) {
    const day = spDay(e.at);
    if (day !== previousDay) {
      rows.push(<tr class="day" key={`day-${day}`}><td colSpan={7}>{e.at ? dayHeading(e.at) : t('common.noDate')}</td></tr>);
      previousDay = day;
    }
    rows.push(<LogRow key={e.id} e={e} open={() => setOpen(e.id)} />);
  }

  let countText = '';
  if (log.loading && !r) countText = t('header.loading');
  else if (r) countText = t('log.eventCount', { count: r.total || 0 });
  else if (log.error) countText = t('log.loadError');

  return (
    <div class="screen screen-log">
      <div class="card log-filters">
        <div class="log-row">
          <Segmented options={PERIODS.map((id) => ({ id, name: t(`log.period.${id}`) }))} value={f.period} label={t('log.periodLabel')} onChange={(v) => setFilters({ period: v })} />
          {f.period === 'custom' && (
            <span class="log-dates">
              <DateField value={f.since} ariaLabel={t('log.since')} onChange={(v) => setFilters({ since: v })} />
              <span class="until">{t('log.untilWord')}</span>
              <DateField value={f.until} ariaLabel={t('log.until')} onChange={(v) => setFilters({ until: v })} />
            </span>
          )}
        </div>
        <div class="log-row">
          <Select value={f.project} options={projectOptions} ariaLabel={t('log.projectLabel')} onChange={(v) => setFilters({ project: v, item: '' })} width={190} />
          <Select value={f.item} options={itemOptions} ariaLabel={t('log.itemLabel')} onChange={(v) => setFilters({ item: v })} width={300} />
          <Select value={f.type} options={typeOptions} ariaLabel={t('log.typeLabel')} onChange={(v) => setFilters({ type: v })} width={210} />
        </div>
      </div>

      <div class="log-info">
        <span class="count" aria-live="polite">
          {countText}
          {log.error && r ? t('log.lastUpdateFailed', { message: log.error.message }) : ''}
        </span>
        <span class="spacer" />
        {r && <span class="muted small">{r.raw_last_at ? t('log.rawLastAt', { when: `${date(r.raw_last_at)} ${time(r.raw_last_at)}` }) : t('log.rawNever')}</span>}
        <button type="button" class="button small" disabled={!filtering} onClick={() => setFilters(() => newFilter())}>{t('log.clearFilters')}</button>
      </div>

      <Card flush bodyClass="log-body">
        <div class="table-box">
          <table class="table log">
            <colgroup>
              <col style={{ width: '66px' }} /><col style={{ width: '86px' }} /><col style={{ width: '30%' }} /><col style={{ width: '16%' }} />
              <col /><col style={{ width: '70px' }} /><col style={{ width: '15%' }} />
            </colgroup>
            <thead><tr>
              <th scope="col">{t('log.col.date')}</th><th scope="col">{t('log.col.time')}</th><th scope="col">{t('log.col.item')}</th>
              <th scope="col">{t('log.col.project')}</th><th scope="col">{t('log.col.event')}</th><th scope="col">{t('log.col.task')}</th>
              <th scope="col">{t('log.col.agent')}</th>
            </tr></thead>
            <tbody>
              {log.error && !r && <tr><td colSpan={7}><Empty>{t('log.couldNotLoad', { message: log.error.message })}</Empty></td></tr>}
              {r && !events.length && <tr><td colSpan={7}><Empty icon={ScrollText} center>{filtering ? t('log.noEvents') : t('log.noEventsYet')}</Empty></td></tr>}
              {rows}
            </tbody>
          </table>
        </div>
        <div class="log-footer">
          <InfoHint title={t('log.howToRead')} text={t('log.howToReadText')} />
          <span class="muted small">{t('log.howToRead')}</span>
          <span class="spacer" />
          <div class="pagination">
            <button type="button" class="button small icon-only" aria-label={t('log.firstPage')} disabled={page <= 1} onClick={() => setPage(1)}><Icon of={ChevronsLeft} size={15} /></button>
            <button type="button" class="button small icon-only" aria-label={t('log.previousPage')} disabled={page <= 1} onClick={() => setPage(page - 1)}><Icon of={ChevronLeft} size={15} /></button>
            <span class="small">{t('log.page', { page: (r && r.page) || page, pages })}</span>
            <button type="button" class="button small icon-only" aria-label={t('log.nextPage')} disabled={page >= pages} onClick={() => setPage(page + 1)}><Icon of={ChevronRight} size={15} /></button>
            <button type="button" class="button small icon-only" aria-label={t('log.lastPage')} disabled={page >= pages} onClick={() => setPage(pages)}><Icon of={ChevronsRight} size={15} /></button>
          </div>
        </div>
      </Card>
      {open !== null && <LogEventModal id={open} ids={events.map((e) => e.id)} onOpen={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

function LogRow({ e, open }) {
  const project = obj(e.project) || {};
  const organization = obj(project.organization) || {};
  const ariaLabel = t('log.rowAria', { date: date(e.at), time: time(e.at), ref: txt(e.tracker_ref), event: eventTypeName(e.type), project: txt(project.name) });
  return (
    <tr class="clickable" tabindex="0" data-id={e.id} onClick={open} aria-label={ariaLabel}
      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } }}>
      <td class="numeric" title={date(e.at)}>{dayMonth(e.at)}</td>
      <td class="numeric">{time(e.at)}</td>
      <td class="wrap"><span class="mono">{txt(e.tracker_ref)}</span> <span class="two-lines" title={txt(e.item_title)}>{txt(e.item_title)}</span></td>
      <td title={txt(organization.name)}>{txt(project.name)}<span class="muted"> · {txt(organization.name)}</span></td>
      <td class="wrap"><Badge>{eventTypeName(e.type)}</Badge> <span class="text-2">{eventDetail(e)}</span></td>
      <td class="mono">{e.task_number === null || e.task_number === undefined ? <span class="muted">—</span> : `#${e.task_number}`}</td>
      <td class="text-2">{agentText(e.agent) || <span class="muted">—</span>}</td>
    </tr>
  );
}
