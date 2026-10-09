// Workspace vocabulary: event types, results, severities, projects and colors. The keys are the values the
// old model stores (Portuguese data, until #18); the names shown come from the dictionary.
import { t, has } from '../i18n/index.js';
import { txt, arr } from './format.js';

// Event types of the old model, in the order of the Log filter.
export const EVENT_TYPES = [
  'pedido-recebido', 'delegacao', 'resposta-recebida', 'aviso', 'consulta', 'execucao', 'auditoria', 'relatorio', 'decisao',
  'pendencia-aberta', 'pendencia-resolvida', 'bloqueio', 'erro', 'manutencao', 'bootstrap',
];
export const isKnownType = (type) => EVENT_TYPES.includes(type);

// tone: semantic color of the result (ok, warning, danger, blue = owner, neutral)
export const RESULTS = {
  ok: { tone: 'ok', color: 'var(--ok)' },
  parcial: { tone: 'warning', color: 'var(--warning)' },
  falhou: { tone: 'danger', color: 'var(--danger)' },
  bloqueado: { tone: 'danger', color: 'var(--danger-dark)' },
  'aguardando-dono': { tone: 'blue', color: 'var(--blue-text)' },
  'em-andamento': { tone: 'neutral', color: 'var(--muted)' },
};
export const resultName = (r) => (RESULTS[r] ? t(`results.${r}`) : txt(r));
export const OWNER_RESULTS = new Set(['falhou', 'bloqueado', 'aguardando-dono']);
export const FAILURE_RESULTS = new Set(['falhou', 'bloqueado']);
export const needsOwner = (e) => !!(e && (e.needs_owner === true || OWNER_RESULTS.has(e.result)));

export const SEVERITIES = ['critica', 'alta', 'normal', 'baixa'];
export const severityName = (s) => (SEVERITIES.includes(s) ? t(`severity.name.${s}`) : txt(s));
export const severityPlural = (s) => t(`severity.plural.${s}`);
export const SEVERITY_TONE = { critica: 'danger', alta: 'warning', normal: 'blue', baixa: 'neutral' };
export const SEVERITY_ORDER = { critica: 0, alta: 1, normal: 2, baixa: 3 };
export const severityOf = (p) => (SEVERITY_ORDER[p && p.severity] !== undefined ? p.severity : 'normal');
export const pendingTypeName = (type) => (has(`pendingType.${type}`) ? t(`pendingType.${type}`) : txt(type));

export const USAGE_PERIODS = [
  { id: 'window_5h', plan: 'window_5h_pct' },
  { id: 'today', plan: null },
  { id: '7d', plan: 'weekly_pct' },
];
export const usagePeriodName = (id) => t(`usage.period.${id}.name`);
export const usagePeriodShort = (id) => t(`usage.period.${id}.short`);

// Colors by name (agents and projects may use the name or a #hex).
export const COLORS = {
  green: '#4BCE97', green_dark: '#1F845A', green_light: '#BAF3DB',
  yellow: '#F5CD47', yellow_dark: '#946F00', yellow_light: '#F8E6A0',
  orange: '#FEA362', orange_dark: '#C25100', orange_light: '#FEDEC8',
  red: '#F87168', red_dark: '#C9372C', red_light: '#FFD5D2',
  purple: '#9F8FEF', purple_dark: '#6E5DC6', purple_light: '#DFD8FD',
  blue: '#579DFF', blue_dark: '#0C66E4', blue_light: '#CCE0FF',
  sky: '#6CC3E0', sky_dark: '#227D9B', sky_light: '#C6EDFB',
  lime: '#94C748', lime_dark: '#5B7F24', lime_light: '#D3F1A7',
  pink: '#E774BB', pink_dark: '#AE4787', pink_light: '#FDD0EC',
  black: '#8590A2', black_dark: '#626F86', black_light: '#DCDFE4',
};
// Sample project registry (prefix, name and color). Replace with the prefixes and colors of your projects.
export const SAMPLE_PROJECTS = {
  A: { name: 'Atlas', color: 'green' }, B: { name: 'Boreal', color: 'blue' }, C: { name: 'Cometa', color: 'purple' },
  D: { name: 'Delta', color: 'red' }, E: { name: 'Eco', color: 'yellow' }, F: { name: 'Faro', color: 'black_dark' },
};

export function safeColor(c) {
  if (typeof c !== 'string') return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
  return COLORS[c] || null;
}

// Raw log folders of terminals without a registered agent (written by the hook as "desconhecido-<id>").
const UNKNOWN_AGENT = /^desconhecido[:-](.+)$/;

export function agentInfo(state, slug) {
  const s = txt(slug);
  const a = state ? arr(state.agents).find((x) => x && x.slug === s) : null;
  if (a) return { slug: s, name: a.name || s, color: safeColor(a.color) };
  const m = UNKNOWN_AGENT.exec(s);
  return { slug: s, name: m ? t('agents.unknown', { id: m[1] }) : s || '—', color: null };
}

export function knownProjects() {
  const map = new Map();
  for (const k of Object.keys(SAMPLE_PROJECTS)) map.set(k, { prefix: k, name: SAMPLE_PROJECTS[k].name, color: safeColor(SAMPLE_PROJECTS[k].color) });
  return map;
}

/**
 * Color of each flow. Consecutive flows (F-...-0004, F-...-0005) get very different colors: in the format
 * F-YYYYMMDD-NNNN, the number walks the golden angle (137.5°) and the day shifts the starting point.
 */
export function flowColor(id) {
  const s = txt(id);
  const f = /^F-(\d{8})-(\d+)$/.exec(s);
  if (f) return `hsl(${Math.round((Number(f[2]) * 137.508 + (Number(f[1]) % 997) * 47) % 360)} 70% 62%)`;
  // other formats: FNV-1a + final mix
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0; x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0; x ^= x >>> 16;
  return `hsl(${(x >>> 0) % 360} 70% 62%)`;
}

export const typeName = (type) => (isKnownType(type) ? t(`eventTypes.${type}`) : type ? String(type) : '—');

// Origins of the old model's events.
const ORIGINS = { 'dono-direto': 'ownerDirect', cerebro: 'brain', rotina: 'routine', sistema: 'system' };
export function originName(state, o) {
  const s = txt(o);
  if (!s) return t('origins.unknown');
  if (ORIGINS[s]) return t(`origins.${ORIGINS[s]}`);
  if (s.startsWith('agente:')) return t('origins.agent', { name: agentInfo(state, s.slice(7)).name });
  return s;
}
