// Log (§11.4): cards with the number of each result (a click filters the table), filters in two rows
// (search with the "/" shortcut, period, type, agents and projects), active filters in sight and the table of 50 per
// page (scrolls inside the card). A click or Enter on a row opens the modal; ← → in the modal follow the order of
// this filtered table. The numbers come from "counts" of /api/events; without them (old server), they come from
// the page itself when it has the whole set, and become "—" when there is no way to know.
import '../styles/log.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { usePanel, newFilter } from '../data/context.js';
import { PAGE_SIZE } from '../data/api.js';
import { objs, obj, txt, number, date, time, dayMonth, spDay, dayHeading } from '../data/format.js';
import { EVENT_TYPES, isKnownType, typeName, RESULTS, resultName, FAILURE_RESULTS, OWNER_RESULTS, needsOwner, agentInfo, knownProjects, flowColor } from '../data/domain.js';
import { logParams, filterList, toggleFilter } from '../data/queries.js';
import { t } from '../i18n/index.js';
import { Card, Badge, Dot, Swatch, Empty, Segmented, InfoHint } from '../components/base.jsx';
import { Select, DateField, Toggle } from '../components/fields.jsx';
import { Agent, Project, Result } from '../components/domain.jsx';
import { Icon, X, Search, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, ScrollText } from '../components/Icon.jsx';

const PERIODS = ['today', '24h', '7d', '30d', 'all', 'custom'];
// Cards in order: what moved, what waits and what went wrong. Short label to fit on one line.
const RESULT_ORDER = ['ok', 'em-andamento', 'aguardando-dono', 'parcial', 'bloqueado', 'falhou'];
const shortResultName = (r) => (r === 'aguardando-dono' ? t('log.waitingShort') : resultName(r));
const NONE = { result: null, agent: null, project: null, type: null, needsOwner: null };
const sumOf = (group) => Object.values(group).reduce((a, b) => a + (Number(b) || 0), 0);

/** Numbers of the filtered set: the server's; without them, the page's when it has everything (and the facet has no filter of its own). */
function countsOf(r, events, f) {
  if (!r) return NONE;
  const c = obj(r.counts);
  if (c) {
    return {
      result: obj(c.result) || {}, agent: obj(c.agent) || {}, project: obj(c.project) || {}, type: obj(c.type) || {},
      needsOwner: typeof c.needs_owner === 'number' ? c.needs_owner : null,
    };
  }
  if ((r.total || 0) > events.length) return NONE;
  const g = { result: Object.create(null), agent: Object.create(null), project: Object.create(null), type: Object.create(null) };
  const add = (o, k) => { if (typeof k === 'string' && k) o[k] = (o[k] || 0) + 1; };
  let owner = 0;
  for (const e of events) {
    add(g.result, e.result); add(g.agent, e.agent); add(g.type, e.type);
    add(g.project, e.project === null || e.project === undefined ? '' : String(e.project).toUpperCase());
    if (needsOwner(e)) owner += 1;
  }
  return {
    result: filterList(f.result).length ? null : g.result,
    agent: filterList(f.agent).length ? null : g.agent,
    project: filterList(f.project).length ? null : g.project,
    type: f.type ? null : g.type,
    needsOwner: f.owner_only ? null : owner,
  };
}

export function Log() {
  const { state, filters: f, setFilters, page, setPage, log, openModal, modal } = usePanel();
  // search with a 300 ms wait (the field answers right away); "/" focuses the search and Esc clears it
  const [q, setQ] = useState(f.q);
  const wait = useRef(null);
  const searchRef = useRef(null);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  useEffect(() => { setQ(f.q); }, [f.q]);
  useEffect(() => () => clearTimeout(wait.current), []);
  const onSearchInput = (v) => { setQ(v); clearTimeout(wait.current); wait.current = setTimeout(() => setFilters({ q: v }), 300); };
  const clearSearch = () => { clearTimeout(wait.current); setQ(''); setFilters({ q: '' }); };
  useEffect(() => {
    const key = (ev) => {
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || modalRef.current) return;
      const target = ev.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      ev.preventDefault();
      if (searchRef.current) { searchRef.current.focus(); searchRef.current.select(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const r = log.answer;
  const events = objs(r && r.events);
  const pages = r ? r.pages || Math.max(1, Math.ceil((r.total || 0) / (r.per_page || PAGE_SIZE))) : 1;
  const ids = events.map((e) => e.id);
  const tableContext = () => {
    const sp = logParams(f, page);
    sp.delete('page');
    return { params: sp.toString(), page: (r && r.page) || page, pages, filtered: [...sp.keys()].some((k) => k !== 'per_page') };
  };
  const filtering = JSON.stringify({ ...f, q }) !== JSON.stringify(newFilter());
  const counts = countsOf(r, events, f);

  // Result: cards (one at a time; a click on the active one removes the filter)
  const selResults = filterList(f.result);
  const grandTotal = counts.result ? sumOf(counts.result) : !selResults.length && r ? r.total || 0 : null;
  const resultValue = (k) => (counts.result ? counts.result[k] || 0 : selResults.length === 1 && selResults[0] === k && r ? r.total || 0 : null);
  const clickResult = (k) => setFilters({ result: selResults.length === 1 && selResults[0] === k ? '' : k });

  // Agents: the registered ones, then the ones that show up in the log; short name when the first word already tells them apart
  const selAgents = filterList(f.agent);
  const agents = [];
  const seen = new Set();
  const addAgent = (slug) => { if (slug && !seen.has(slug)) { seen.add(slug); agents.push(agentInfo(state, slug)); } };
  for (const a of objs(state && state.agents)) addAgent(a.slug);
  if (counts.agent) for (const k of Object.keys(counts.agent)) addAgent(k);
  for (const s of selAgents) addAgent(s);
  const firstNames = agents.map((a) => String(a.name).split(/\s+/)[0]);
  const shortNames = new Set(firstNames).size === firstNames.length;

  // Projects: the sample registry ones, plus the ones that show up in the log
  const selProjects = filterList(f.project).map((x) => x.toUpperCase());
  const projects = new Map(knownProjects());
  const addProject = (k) => { if (k && !projects.has(k)) projects.set(k, { prefix: k, name: k, color: null }); };
  if (counts.project) for (const k of Object.keys(counts.project)) addProject(k);
  for (const s of selProjects) addProject(s);

  // Type: one at a time, with the count of each
  const types = EVENT_TYPES.map((k) => [k, typeName(k)]);
  const extras = new Set([...(counts.type ? Object.keys(counts.type) : []), ...(f.type ? [f.type] : [])]);
  for (const k of extras) if (!isKnownType(k)) types.push([k, k]);
  const typeOptions = [['', t('log.allTypes')], ...types.map(([k, n]) => [k, counts.type ? `${n} · ${number(counts.type[k] || 0)}` : n])];

  // Filters with no fixed place on screen (flow, search, type, result): in sight, each with an x to remove it
  const active = [];
  if (f.flow) {
    active.push(
      <ActiveFilter key="flow" removeLabel={t('log.removeFlow', { flow: f.flow })} onRemove={() => setFilters({ flow: '' })}>
        <Dot color={flowColor(f.flow)} /><span class="t mono">{t('log.flowChip', { flow: f.flow })}</span>
      </ActiveFilter>,
    );
  }
  for (const k of selResults) {
    const name = resultName(k);
    active.push(
      <ActiveFilter key={`res-${k}`} removeLabel={t('log.removeResult', { name })} onRemove={() => setFilters({ result: toggleFilter(f.result, k) })}>
        <span class="t">{t('log.resultChip', { name })}</span>
      </ActiveFilter>,
    );
  }
  if (f.type) {
    active.push(
      <ActiveFilter key="type" removeLabel={t('log.removeType')} onRemove={() => setFilters({ type: '' })}>
        <span class="t">{t('log.typeChip', { name: isKnownType(f.type) ? typeName(f.type) : f.type })}</span>
      </ActiveFilter>,
    );
  }
  if (f.q.trim()) {
    active.push(
      <ActiveFilter key="q" removeLabel={t('log.clearSearch')} onRemove={clearSearch}>
        <span class="t">{t('log.searchChip', { q: f.q.trim() })}</span>
      </ActiveFilter>,
    );
  }

  const rows = [];
  let previousDay = null;
  for (const e of events) {
    const day = spDay(e.ts);
    if (day !== previousDay) {
      rows.push(<tr class="day" key={`day-${day}`}><td colSpan={7}>{e.ts ? dayHeading(e.ts) : t('common.noDate')}</td></tr>);
      previousDay = day;
    }
    rows.push(<LogRow key={e.id || e.ts} e={e} open={() => e.id && openModal(e.id, ids, tableContext())} />);
  }

  let countText = '';
  if (log.loading && !r) countText = t('header.loading');
  else if (r) countText = t('log.eventCount', { count: r.total || 0 });
  else if (log.error) countText = t('log.loadError');

  return (
    <div class="screen screen-log">
      <div class={`log-kpis${selResults.length ? ' filtering' : ''}`} role="group" aria-label={t('log.kpisLabel')}>
        <StatusCard label={t('log.events')} value={grandTotal} active={!selResults.length} onClick={() => setFilters({ result: '' })}
          title={t('log.showAllResults')}
          info={t('log.eventsInfo')}
          bar={<Distribution group={counts.result} total={grandTotal} />} />
        {RESULT_ORDER.map((k) => (
          <StatusCard key={k} label={shortResultName(k)} title={t('log.filterResult', { name: resultName(k) })} color={RESULTS[k].color}
            value={resultValue(k)} total={grandTotal} active={selResults.includes(k)} onClick={() => clickResult(k)} />
        ))}
      </div>

      <div class="card log-filters">
        <div class="log-row">
          <span class={`search log-search${q ? ' filled' : ''}`}>
            <Icon of={Search} size={15} />
            <input ref={searchRef} type="search" value={q} placeholder={t('log.searchPlaceholder')}
              aria-label={t('log.searchLabel')}
              onInput={(e) => onSearchInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                if (q) { e.preventDefault(); clearSearch(); } else e.currentTarget.blur();
              }} />
            <kbd class="shortcut" aria-hidden="true" title={t('log.shortcut')}>/</kbd>
          </span>
          <Segmented options={PERIODS.map((id) => ({ id, name: t(`log.period.${id}`) }))} value={f.period} label={t('log.periodLabel')} onChange={(v) => setFilters({ period: v })} />
          {f.period === 'custom' && (
            <span class="log-dates">
              <DateField value={f.since} ariaLabel={t('log.since')} onChange={(v) => setFilters({ since: v })} />
              <span class="until">{t('log.untilWord')}</span>
              <DateField value={f.until} ariaLabel={t('log.until')} onChange={(v) => setFilters({ until: v })} />
            </span>
          )}
          <Select value={f.type} options={typeOptions} ariaLabel={t('log.typeLabel')} onChange={(v) => setFilters({ type: v })} width={196} />
        </div>
        <div class="log-row">
          <div class="log-group agents">
            <span class="label">{t('log.agents')}</span>
            <div class="chips" role="group" aria-label={t('log.agentsLabel')}>
              {agents.map((a, i) => (
                <Chip key={a.slug} pressed={selAgents.includes(a.slug)} n={counts.agent ? counts.agent[a.slug] || 0 : null} title={a.name}
                  onClick={() => setFilters({ agent: toggleFilter(f.agent, a.slug) })}>
                  <Dot color={a.color} /><span>{shortNames ? firstNames[i] : a.name}</span>
                </Chip>
              ))}
            </div>
          </div>
          <span class="log-sep" aria-hidden="true" />
          <div class="log-group">
            <span class="label">{t('log.projects')}</span>
            <div class="chips" role="group" aria-label={t('log.projectsLabel')}>
              {[...projects.entries()].map(([k, p]) => (
                <Chip key={k} className="project-chip" pressed={selProjects.includes(k)} n={counts.project ? counts.project[k] || 0 : null}
                  title={p.name && p.name !== k ? `${p.prefix} · ${p.name}` : String(p.prefix)}
                  onClick={() => setFilters({ project: toggleFilter(selProjects.join(','), k) })}>
                  <Swatch color={p.color} /><span>{p.prefix}</span>
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div class="log-info">
        <span class="count" aria-live="polite">
          {countText}
          {log.error && r ? t('log.lastUpdateFailed', { message: log.error.message }) : ''}
        </span>
        {active.length > 0 && <span class="active-filters">{active}</span>}
        <span class="spacer" />
        <Toggle checked={f.owner_only} onChange={(v) => setFilters({ owner_only: v })}>
          {t('log.ownerOnly')}{typeof counts.needsOwner === 'number' && <span class="n">{number(counts.needsOwner)}</span>}
        </Toggle>
        <Toggle checked={f.include_tests} onChange={(v) => setFilters({ include_tests: v })}>{t('log.showTests')}</Toggle>
        <button type="button" class="button small" disabled={!filtering} onClick={() => { clearTimeout(wait.current); setQ(''); setFilters(() => newFilter()); }}>{t('log.clearFilters')}</button>
      </div>

      <Card flush bodyClass="log-body">
        <div class="table-box">
          <table class="table log">
            <colgroup>
              <col style={{ width: '66px' }} /><col style={{ width: '86px' }} /><col style={{ width: '15%' }} /><col style={{ width: '94px' }} />
              <col style={{ width: '36%' }} /><col /><col style={{ width: '150px' }} />
            </colgroup>
            <thead><tr>
              <th scope="col">{t('log.col.date')}</th><th scope="col">{t('log.col.time')}</th><th scope="col">{t('log.col.agent')}</th><th scope="col">{t('log.col.project')}</th>
              <th scope="col">{t('log.col.action')}</th><th scope="col">{t('log.col.direction')}</th><th scope="col">{t('log.col.result')}</th>
            </tr></thead>
            <tbody>
              {log.error && !r && <tr><td colSpan={7}><Empty>{t('log.couldNotLoad', { message: log.error.message })}</Empty></td></tr>}
              {r && !events.length && <tr><td colSpan={7}><Empty icon={ScrollText} center>{t('log.noEvents')}</Empty></td></tr>}
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
    </div>
  );
}

/** Card of a status: number, share of the total and a bar in the result color; a click filters (aria-pressed). */
function StatusCard({ label, title, color, value, total, active, onClick, info, bar }) {
  const known = typeof value === 'number';
  const share = known && total ? Math.round((value / total) * 100) : null;
  return (
    <button type="button" class={`card kpi clickable log-kpi${active ? ' highlight' : ''}`} aria-pressed={active ? 'true' : 'false'}
      title={title} onClick={onClick}>
      <span class="label-row">
        {color && <span class="result-dot" style={{ background: color }} aria-hidden="true" />}
        <span class="label">{label}</span>
        {info && <InfoHint text={info} />}
      </span>
      <span class="kpi-row">
        <span class="value medium">{known ? number(value) : '—'}</span>
        {share !== null && <span class="share">{share}%</span>}
      </span>
      {bar || (
        <span class="track" aria-hidden="true"><span style={{ width: `${share || 0}%`, background: color || 'var(--blue)' }} /></span>
      )}
    </button>
  );
}

/** Thin bar with the split of the total among the results (on the "Events" card). */
function Distribution({ group, total }) {
  if (!group || !total) return <span class="track" aria-hidden="true" />;
  return (
    <span class="stacked-bar" aria-hidden="true">
      {RESULT_ORDER.map((k) => (group[k] ? <span key={k} style={{ width: `${(group[k] / total) * 100}%`, background: RESULTS[k].color }} /> : null))}
    </span>
  );
}

/** Filter chip (many at the same time). n: how many events show up with the other filters. */
function Chip({ pressed, onClick, title, n, className, children }) {
  const zero = n === 0 && !pressed;
  return (
    <button type="button" class={`chip${zero ? ' zero' : ''}${className ? ` ${className}` : ''}`} aria-pressed={pressed ? 'true' : 'false'}
      title={title} onClick={onClick}>
      {children}
      {typeof n === 'number' && <span class="n">{number(n)}</span>}
    </button>
  );
}

function ActiveFilter({ removeLabel, onRemove, children }) {
  return (
    <span class="active-filter">
      {children}
      <button type="button" aria-label={removeLabel} title={removeLabel} onClick={onRemove}><Icon of={X} size={13} /></button>
    </span>
  );
}

function LogRow({ e, open }) {
  const { state } = usePanel();
  const classes = ['clickable'];
  if (FAILURE_RESULTS.has(e.result)) classes.push('failure');
  else if (needsOwner(e)) classes.push('needs-owner');
  if (e.test === true) classes.push('test');
  const agentName = agentInfo(state, e.agent).name;
  const ariaLabel = t('log.rowAria', {
    date: date(e.ts), time: time(e.ts), agent: agentName, summary: txt(e.summary), result: resultName(e.result),
    owner: needsOwner(e) ? t('log.rowNeedsYou') : '',
  });
  return (
    <tr class={classes.join(' ')} tabindex="0" data-id={e.id || ''} onClick={open}
      onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } }}
      aria-label={ariaLabel}>
      <td class="numeric" style={e.flow_id ? { boxShadow: `inset 3px 0 0 ${flowColor(e.flow_id)}` } : undefined}
        title={e.flow_id ? t('log.dateWithFlow', { date: date(e.ts), flow: e.flow_id }) : date(e.ts)}>{dayMonth(e.ts)}</td>
      <td class="numeric">{time(e.ts)}</td>
      <td><Agent slug={e.agent} /></td>
      <td><Project prefix={e.project} /></td>
      <td class="wrap"><span class="two-lines" title={txt(e.summary)}>{txt(e.summary) || '—'}{e.test === true && <> <Badge tone="test">{t('common.test')}</Badge></>}</span></td>
      <td class="wrap text-2" title={txt(e.direction)}>{e.direction ? <span class="two-lines">{txt(e.direction)}</span> : <span class="muted">—</span>}</td>
      <td><Result value={e.result} />{e.needs_owner === true && !OWNER_RESULTS.has(e.result) && <> <Badge tone="blue">{t('log.you')}</Badge></>}</td>
    </tr>
  );
}
