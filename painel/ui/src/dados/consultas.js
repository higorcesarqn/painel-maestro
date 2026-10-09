// Consultas que a página monta: filtros do Log e a análise dos últimos 7 dias.
import { POR_PAGINA } from './api.js';
import { agora, diaSP, horaSP, diaMes, semanaCurta, cabecalhoDia, arr } from './formato.js';
import { RESULTADOS } from './dominio.js';

/** Filtro de vários valores (agente, projeto, resultado): guardado como texto "a,b"; devolve a lista. */
export function listaFiltro(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
  return typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

/** Põe ou tira um valor de um filtro de vários valores; devolve o texto "a,b" ('' quando vazio). */
export function alternarFiltro(v, item) {
  const l = listaFiltro(v);
  return (l.includes(item) ? l.filter((x) => x !== item) : [...l, item]).join(',');
}

export function intervalo(f) {
  const hoje = diaSP(agora());
  const diasAtras = (n) => diaSP(agora() - n * 86400000);
  switch (f.periodo) {
    case 'hoje': return [hoje, hoje];
    case 'ontem': return [diasAtras(1), diasAtras(1)];
    case '24h': return [diasAtras(1), ''];
    case '7d': return [diasAtras(6), ''];
    case '30d': return [diasAtras(29), ''];
    case 'personalizado': return [f.desde || '', f.ate || ''];
    default: return ['', ''];
  }
}

export function parametrosLog(f, pagina) {
  const sp = new URLSearchParams();
  const [d, a] = intervalo(f);
  if (d) sp.set('desde', d);
  if (a) sp.set('ate', a);
  // 24 h: o dia de ontem em diante (vale no servidor antigo) e as últimas 24 h exatas no novo (horas)
  if (f.periodo === '24h') sp.set('horas', '24');
  for (const k of ['agente', 'projeto', 'tipo', 'resultado']) {
    const v = listaFiltro(f[k]).join(',');
    if (v) sp.set(k, v);
  }
  if (f.q.trim()) sp.set('q', f.q.trim());
  if (f.so_dono) sp.set('so_dono', '1');
  if (f.incluir_testes) sp.set('incluir_testes', '1');
  if (f.fluxo) sp.set('fluxo', f.fluxo);
  sp.set('pagina', String(pagina));
  sp.set('por_pagina', String(POR_PAGINA));
  return sp;
}

/** Os 7 dias de São Paulo terminando hoje, do mais antigo para hoje. */
export function ultimosDias(n = 7) {
  const dias = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = agora() - i * 86400000;
    dias.push({ dia: diaSP(t), rotulo: i === 0 ? 'hoje' : `${semanaCurta(t)} ${diaMes(t).slice(0, 2)}`, titulo: cabecalhoDia(t) });
  }
  return dias;
}

/**
 * Análise dos eventos dos últimos 7 dias (vindos de /api/eventos, sem os de teste):
 * por dia e agente, por resultado, por hora de hoje e por agente.
 */
export function analisar(eventos) {
  const dias = ultimosDias(7);
  const porDia = new Map(dias.map((d) => [d.dia, {}]));
  const resultados = {};
  const hoje = diaSP(agora());
  const horasHoje = new Array(24).fill(0);
  const porAgente = {};
  const porAgenteDia = {};
  let precisaDono = 0;
  for (const e of arr(eventos)) {
    if (!e || !e.ts) continue;
    const d = diaSP(e.ts);
    const ag = e.agente || '?';
    if (porDia.has(d)) {
      const linha = porDia.get(d);
      linha[ag] = (linha[ag] || 0) + 1;
      porAgenteDia[ag] = porAgenteDia[ag] || {};
      porAgenteDia[ag][d] = (porAgenteDia[ag][d] || 0) + 1;
    }
    const r = RESULTADOS[e.resultado] ? e.resultado : 'outro';
    resultados[r] = (resultados[r] || 0) + 1;
    porAgente[ag] = (porAgente[ag] || 0) + 1;
    if (d === hoje) { const h = horaSP(e.ts); if (h !== null) horasHoje[h] += 1; }
    if (e.precisa_dono === true) precisaDono += 1;
  }
  return {
    dias: dias.map((d) => ({ ...d, valores: porDia.get(d.dia) || {} })),
    resultados,
    horasHoje,
    porAgente,
    serieAgente: (slug) => dias.map((d) => (porAgenteDia[slug] && porAgenteDia[slug][d.dia]) || 0),
    total: arr(eventos).length,
    precisaDono,
  };
}
