// Workspace domain pieces: agent, project, result, severity and flow.
import { usePanel } from '../data/context.js';
import { t } from '../i18n/index.js';
import { RESULTS, resultName, agentInfo, knownProjects, flowColor, severityName, SEVERITY_TONE } from '../data/domain.js';
import { Dot, Swatch, Badge } from './base.jsx';
import { Icon, Check, X, Square, Pause, LoaderCircle, CircleDashed } from './Icon.jsx';

export function Agent({ slug, size = 8 }) {
  const { state } = usePanel();
  const a = agentInfo(state, slug);
  return <span class="agent" title={a.name}><Dot color={a.color} size={size} /><span>{a.name}</span></span>;
}

export function Project({ prefix }) {
  if (prefix === null || prefix === undefined || prefix === '') return <span class="muted">—</span>;
  const p = knownProjects().get(String(prefix).toUpperCase());
  return <span class="project" title={p ? `${p.prefix} · ${p.name}` : String(prefix)}><Swatch color={p && p.color} />{String(prefix)}</span>;
}

const RESULT_ICON = { ok: Check, parcial: CircleDashed, falhou: X, bloqueado: Square, 'aguardando-dono': Pause, 'em-andamento': LoaderCircle };
export function Result({ value }) {
  const info = RESULTS[value];
  if (!info) return <span class="result muted">{value ? String(value) : '—'}</span>;
  return <span class="result" style={{ color: info.color }}><Icon of={RESULT_ICON[value]} size={14} />{resultName(value)}</span>;
}

export function SeverityBadge({ sev, filled }) {
  return <Badge tone={SEVERITY_TONE[sev] || 'neutral'} filled={filled}>{severityName(sev)}</Badge>;
}

/** Flow id with its color; a click filters the Log by that flow. */
export function Flow({ id, title }) {
  const { filterByFlow } = usePanel();
  if (!id) return <span class="muted">{t('flow.none')}</span>;
  return (
    <button type="button" class="link neutral mono" title={title || t('flow.filterLog')} onClick={(e) => { e.stopPropagation(); filterByFlow(id); }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <Dot color={flowColor(id)} />{id}
    </button>
  );
}
