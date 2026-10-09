// Datas, números e textos (sempre no fuso de São Paulo e no relógio do servidor).

export const TZ = 'America/Sao_Paulo';

const fData = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
export const fDiaMes = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
const fHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const fHM = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fSemana = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'long' });
const fSemanaCurta = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' });
const fISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fHoraNum = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const fNum = new Intl.NumberFormat('pt-BR');
const fPct = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const fCompacto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

// "Agora" é o relógio do servidor (respeita o relógio fixo dos testes e o mock).
let relogio = { gerado: NaN, recebido: 0 };
export function acertarRelogio(geradoEm) {
  relogio = { gerado: Date.parse(geradoEm), recebido: Date.now() };
}
export function agora() {
  return Number.isFinite(relogio.gerado) ? relogio.gerado + (Date.now() - relogio.recebido) : Date.now();
}

export function quando(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}
export const data = (v) => { const d = quando(v); return d ? fData.format(d) : '—'; };
export const hora = (v) => { const d = quando(v); return d ? fHora.format(d) : '—'; };
export const hm = (v) => { const d = quando(v); return d ? fHM.format(d) : '—'; };
export const diaMes = (v) => { const d = quando(v); return d ? fDiaMes.format(d) : '—'; };
export const dataHora = (v) => { const d = quando(v); return d ? `${fData.format(d)} ${fHM.format(d)}` : '—'; };
export const dataHoraSeg = (v) => { const d = quando(v); return d ? `${fData.format(d)} ${fHora.format(d)}` : '—'; };
export const diaSP = (v) => { const d = quando(v); return d ? fISO.format(d) : ''; };
export const horaSP = (v) => { const d = quando(v); return d ? Number(fHoraNum.format(d)) % 24 : null; };
export function semana(v) {
  const d = quando(v);
  if (!d) return '';
  const w = fSemana.format(d).replace(/-feira$/, '');
  return w.charAt(0).toUpperCase() + w.slice(1);
}
export function semanaCurta(v) {
  const d = quando(v);
  if (!d) return '';
  const w = fSemanaCurta.format(d).replace(/\.$/, '');
  return w.charAt(0).toUpperCase() + w.slice(1);
}
export const cabecalhoDia = (v) => `${semana(v)}, ${data(v)}`;

export function textoMin(min) {
  if (min === null || min === undefined || !Number.isFinite(Number(min))) return '—';
  const m = Math.max(0, Math.round(Number(min)));
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  if (m < 48 * 60) { const hh = Math.floor(m / 60); const r = m % 60; return r ? `há ${hh} h ${r} min` : `há ${hh} h`; }
  return `há ${Math.floor(m / 1440)} d`;
}
export function idade(v) {
  const d = quando(v);
  if (!d) return '—';
  return textoMin((agora() - d.getTime()) / 60000);
}
/** "às 13:00" no mesmo dia; senão "em 13/10/2026 às 09:00". */
export function quandoReset(v) {
  const d = quando(v);
  if (!d) return null;
  return diaSP(d) === diaSP(agora()) ? `às ${fHM.format(d)}` : `em ${fData.format(d)} às ${fHM.format(d)}`;
}
export function duracao(s) {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return null;
  const n = Math.round(Number(s));
  if (n < 60) return `${n} s`;
  if (n < 3600) { const r = n % 60; return r ? `${Math.floor(n / 60)} min ${r} s` : `${Math.floor(n / 60)} min`; }
  const hh = Math.floor(n / 3600); const mm = Math.floor((n % 3600) / 60);
  return `${hh} h ${String(mm).padStart(2, '0')} min`;
}
export const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? fNum.format(v) : '—');
export const compacto = (v) => (typeof v === 'number' && Number.isFinite(v) ? fCompacto.format(v) : '—');
export const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${fPct.format(v)}%` : '—');

export const arr = (v) => (Array.isArray(v) ? v : []);
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
/** Só os itens que são objetos (um null no meio de um array do estado não derruba a seção). */
export const objs = (v) => arr(v).filter((x) => obj(x));
export const txt = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? textoDeObjeto(v) : String(v));
function textoDeObjeto(o) {
  if (Array.isArray(o)) return o.map(txt).join(', ');
  return Object.keys(o).map((k) => `${k}: ${txt(o[k])}`).join(' · ');
}
export function truncar(s, n) {
  const t = txt(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
export function normalizar(s) {
  return txt(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
export const tempo = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
export const plural = (n, um, varios) => `${numero(n)} ${n === 1 ? um : varios}`;
