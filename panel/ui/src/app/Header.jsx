// Header: screen title, time of the last read, health badge (with details), Recalculate and the phase B button
// (Ask the Brain), which stays disabled and explains why.
import { useState } from 'preact/hooks';
import { usePanel } from '../data/context.js';
import { time, elapsedText, dateTime, age, arr, obj, txt } from '../data/format.js';
import { t } from '../i18n/index.js';
import { Popover } from '../components/Modal.jsx';
import { CompanySelect } from './CompanySelect.jsx';
import { Dot } from '../components/base.jsx';
import { Icon, RefreshCw, Send, Clock, TriangleAlert, CircleCheck, CircleAlert } from '../components/Icon.jsx';

const LEVEL_COLORS = { green: 'var(--ok)', yellow: 'var(--warning)', red: 'var(--danger)', gray: 'var(--faint)' };

export function Header() {
  const { state, connectionError, failingSince, screen, actionStatus, recalculate, recalculating } = usePanel();
  const [pop, setPop] = useState(null);
  const h = (state && obj(state.health)) || {};
  const level = LEVEL_COLORS[h.level] ? h.level : 'gray';
  const levelName = t(`health.level.${level}`);
  const reasons = arr(h.reasons).map(txt);
  const toggle = (which) => setPop((p) => (p === which ? null : which));
  const noProblem = t('health.noProblem');

  let updated = t('header.loading');
  if (connectionError) updated = state ? t('header.noAnswerSince', { since: time(failingSince), data: time(state.generated_at) }) : t('header.noAnswer');
  else if (state) updated = t('header.updatedAt', { time: time(state.generated_at) });

  return (
    <header class="topbar">
      <div class="topbar-title">
        <span class="label">{state && state.workspace && state.workspace.name ? t('header.panelOf', { name: state.workspace.name }) : t('header.panel')}</span>
        <h1>{t(`screens.${screen}`)}</h1>
      </div>
      <CompanySelect />
      <span class="spacer" />
      {actionStatus && <span class="action-status truncate" aria-live="polite" title={actionStatus}>{actionStatus}</span>}
      <span class={`updated${connectionError ? ' error' : ''}`} aria-live="polite"><Icon of={Clock} size={14} />{updated}</span>
      <button type="button" class="button" data-opens-popover aria-expanded={pop === 'health' ? 'true' : 'false'} aria-controls="pop-health"
        title={reasons.length ? reasons.join('\n') : noProblem}
        aria-label={t('health.ariaLabel', { level: levelName, reasons: reasons.length ? reasons.join('. ') : noProblem })}
        onClick={() => toggle('health')}>
        <Dot color={LEVEL_COLORS[level]} />
        {reasons.length && level !== 'green'
          ? t('health.buttonWithCount', { level: levelName.toLowerCase(), count: reasons.length })
          : t('health.button', { level: levelName.toLowerCase() })}
      </button>
      <button type="button" class="button primary" disabled={recalculating} onClick={recalculate}
        title={t('header.recalculateTitle')}>
        <Icon of={RefreshCw} size={15} />{recalculating ? t('common.recalculating') : t('common.recalculate')}
      </button>
      <button type="button" class="button inactive" data-opens-popover aria-disabled="true" aria-expanded={pop === 'brain' ? 'true' : 'false'} aria-controls="pop-brain"
        title={t('header.brainTitle')} onClick={() => toggle('brain')}>
        <Icon of={Send} size={15} />{t('header.brainButton')}
      </button>
      {pop === 'health' && <HealthPopover onClose={() => setPop(null)} />}
      {pop === 'brain' && (
        <Popover onClose={() => setPop(null)} id="pop-brain" role="note" right={24}>
          <h3>{t('header.brainPopoverTitle')}</h3>
          <p class="text-2">{t('header.brainPopoverText')}</p>
        </Popover>
      )}
    </header>
  );
}

function HealthPopover({ onClose }) {
  const { state } = usePanel();
  const h = (state && obj(state.health)) || {};
  const reasons = arr(h.reasons).map(txt);
  const warnings = arr(state && state.warnings);
  // Health of the new model (#14): the agents' last record in maestro.db and the hook's last entry in bruto.db.
  const when = (v) => (v ? t('health.when', { date: dateTime(v), age: age(v) }) : t('common.never'));
  const rows = [
    [t('health.lastEvent'), when(h.last_event_at)],
    [t('health.lastRaw'), when(h.last_raw_at)],
    [t('health.planData'), elapsedText(h.usage_age_min)],
    [t('health.wire'), h.wire ? t('health.wireOn') : t('health.wireOff')],
  ];
  return (
    <Popover onClose={onClose} id="pop-health" right={300}>
      <h3>{t('health.title')}</h3>
      {reasons.length
        ? <ul>{reasons.map((m) => <li key={m}><Icon of={TriangleAlert} size={14} class="blue" />{m}</li>)}</ul>
        : <p class="text-2" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}><Icon of={CircleCheck} size={14} />{t('health.noProblem')}</p>}
      <table><tbody>{rows.map(([a, b]) => <tr key={a}><th scope="row">{a}</th><td>{b}</td></tr>)}</tbody></table>
      {warnings.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <span class="label">{t('health.readWarnings', { count: warnings.length })}</span>
          <ul style={{ marginTop: '6px' }}>{warnings.slice(0, 8).map((a, i) => <li key={i} class="small muted"><Icon of={CircleAlert} size={13} />{txt(a)}</li>)}</ul>
        </div>
      )}
    </Popover>
  );
}
