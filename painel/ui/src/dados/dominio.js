// Vocabulário do workspace: tipos de evento, resultados, severidades, projetos, cores e links seguros.
import { txt, normalizar, objs, obj, arr } from './formato.js';

export const TIPOS = {
  'pedido-recebido': 'Pedido recebido', delegacao: 'Delegação', 'resposta-recebida': 'Resposta recebida', aviso: 'Aviso',
  consulta: 'Consulta', execucao: 'Execução', auditoria: 'Auditoria', relatorio: 'Relatório', decisao: 'Decisão',
  'pendencia-aberta': 'Pendência aberta', 'pendencia-resolvida': 'Pendência resolvida', bloqueio: 'Bloqueio', erro: 'Erro',
  manutencao: 'Manutenção', bootstrap: 'Bootstrap',
};

// tom: cor semântica do resultado (ok, atencao, perigo, azul = dono, neutro)
export const RESULTADOS = {
  ok: { rotulo: 'ok', tom: 'ok', cor: 'var(--ok)' },
  parcial: { rotulo: 'parcial', tom: 'atencao', cor: 'var(--atencao)' },
  falhou: { rotulo: 'falhou', tom: 'perigo', cor: 'var(--perigo)' },
  bloqueado: { rotulo: 'bloqueado', tom: 'perigo', cor: 'var(--perigo-escuro)' },
  'aguardando-dono': { rotulo: 'aguardando o dono', tom: 'azul', cor: 'var(--azul-texto)' },
  'em-andamento': { rotulo: 'em andamento', tom: 'neutro', cor: 'var(--mudo)' },
};
export const RESULTADOS_DONO = new Set(['falhou', 'bloqueado', 'aguardando-dono']);
export const RESULTADOS_FALHA = new Set(['falhou', 'bloqueado']);
export const precisaDono = (e) => !!(e && (e.precisa_dono === true || RESULTADOS_DONO.has(e.resultado)));

export const SEVERIDADES = ['critica', 'alta', 'normal', 'baixa'];
export const NOME_SEV = { critica: 'crítica', alta: 'alta', normal: 'normal', baixa: 'baixa' };
export const PLURAL_SEV = { critica: 'críticas', alta: 'altas', normal: 'normais', baixa: 'baixas' };
export const TOM_SEV = { critica: 'perigo', alta: 'atencao', normal: 'azul', baixa: 'neutro' };
export const ORD_SEV = { critica: 0, alta: 1, normal: 2, baixa: 3 };
export const sevDe = (p) => (ORD_SEV[p && p.severidade] !== undefined ? p.severidade : 'normal');
export const TIPO_PEND = { aprovacao: 'aprovação', decisao: 'decisão', 'informacao-faltando': 'informação faltando', revisao: 'revisão' };

export const PERIODOS_USO = [
  { id: 'janela_5h', nome: 'Janela de 5 h atual', curto: '5 h', plano: 'janela_5h_pct' },
  { id: 'hoje', nome: 'Hoje', curto: 'hoje', plano: null },
  { id: '7d', nome: '7 dias', curto: '7 dias', plano: 'semanal_pct' },
];

// Cores das etiquetas do Trello (paleta atual do Trello).
export const CORES_TRELLO = {
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
// Registro de projetos de exemplo, usado só quando o resumo do Trello ainda não existe.
// Troque pelos prefixos e cores do seu quadro.
export const PROJETOS_MANUAL = {
  A: { nome: 'Atlas', cor: 'green' }, B: { nome: 'Boreal', cor: 'blue' }, C: { nome: 'Cometa', cor: 'purple' },
  D: { nome: 'Delta', cor: 'red' }, E: { nome: 'Eco', cor: 'yellow' }, F: { nome: 'Faro', cor: 'black_dark' },
};

// Status do Trello: o tom do manual (A Fazer vermelho, Em andamento laranja, Concluído verde).
export const STATUS_TRELLO = {
  afazer: { nome: 'A fazer', cor: CORES_TRELLO.red },
  andamento: { nome: 'Em andamento', cor: CORES_TRELLO.orange },
  concluido: { nome: 'Concluído', cor: CORES_TRELLO.green },
};
export function classeStatus(status) {
  const s = normalizar(status);
  if (s.startsWith('a fazer') || s === 'a_fazer') return 'afazer';
  if (s.startsWith('em andamento') || s === 'em_andamento') return 'andamento';
  if (s.startsWith('conclu') || s === 'feito') return 'concluido';
  return null;
}

export function corSegura(c) {
  if (typeof c !== 'string') return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
  return CORES_TRELLO[c] || null;
}

export function infoAgente(estado, slug) {
  const s = txt(slug);
  const a = estado ? arr(estado.agentes).find((x) => x && x.slug === s) : null;
  if (a) return { slug: s, nome: a.nome || s, cor: corSegura(a.cor) };
  const m = /^desconhecido[:-](.+)$/.exec(s);
  return { slug: s, nome: m ? `desconhecido (${m[1]})` : s || '—', cor: null };
}

export function projetosConhecidos(estado) {
  const mapa = new Map();
  for (const k of Object.keys(PROJETOS_MANUAL)) mapa.set(k, { prefixo: k, nome: PROJETOS_MANUAL[k].nome, cor: corSegura(PROJETOS_MANUAL[k].cor) });
  const tr = estado && obj(estado.trello);
  if (tr) for (const p of objs(tr.projetos)) if (p.prefixo) mapa.set(String(p.prefixo).toUpperCase(), { prefixo: String(p.prefixo), nome: p.nome || p.prefixo, cor: corSegura(p.cor) });
  return mapa;
}

/**
 * Cor de cada fluxo. Fluxos seguidos (F-...-0004, F-...-0005) caem em cores bem diferentes: no formato
 * F-AAAAMMDD-NNNN, o número anda pelo ângulo de ouro (137,5°) e o dia desloca o ponto de partida.
 */
export function corDoFluxo(id) {
  const s = txt(id);
  const f = /^F-(\d{8})-(\d+)$/.exec(s);
  if (f) return `hsl(${Math.round((Number(f[2]) * 137.508 + (Number(f[1]) % 997) * 47) % 360)} 70% 62%)`;
  // outros formatos: FNV-1a + mistura final
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0; x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0; x ^= x >>> 16;
  return `hsl(${(x >>> 0) % 360} 70% 62%)`;
}

/** Só links https://trello.com/... viram link; o resto vira texto. */
export function urlTrello(u) {
  if (typeof u !== 'string') return null;
  try {
    const x = new URL(u);
    if (x.protocol === 'https:' && x.hostname === 'trello.com' && !x.username && !x.password) return x.href;
  } catch (_) { /* não é URL */ }
  return null;
}
export const urlDoCartao = (tr) => (tr ? tr.url || (tr.shortLink ? `https://trello.com/c/${tr.shortLink}` : null) : null);

export const nomeTipo = (t) => TIPOS[t] || (t ? String(t) : '—');
export function nomeOrigem(estado, o) {
  const s = txt(o);
  if (!s) return 'origem não informada';
  if (s === 'dono-direto') return 'Dono (direto)';
  if (s === 'cerebro') return 'Cérebro Principal';
  if (s === 'rotina') return 'Rotina agendada';
  if (s === 'sistema') return 'Sistema';
  if (s.startsWith('agente:')) return `Agente ${infoAgente(estado, s.slice(7)).nome}`;
  return s;
}
