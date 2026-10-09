// Vocabulário e peças pequenas da tela Prospecção (etapas, status, ganchos, nota, temperatura, score, datas).
// Os nomes seguem o contrato da prospecção e a página antiga (prospeccao.html).
import { agora, quando, numero, diaMes, hm, semanaCurta } from '../dados/formato.js';

export const ETAPAS_PRINCIPAIS = ['novo', 'pesquisado', 'abordado', 'respondeu', 'qualificando', 'qualificado', 'reuniao_marcada', 'passado_humano'];
export const ETAPAS_SAIDA = ['sem_resposta', 'perdido', 'desqualificado'];
export const NOME_ETAPA = {
  novo: 'Novo', pesquisado: 'Pesquisado', abordado: 'Abordado', respondeu: 'Respondeu', qualificando: 'Qualificando',
  qualificado: 'Qualificado', reuniao_marcada: 'Reunião marcada', passado_humano: 'Com você', sem_resposta: 'Sem resposta',
  perdido: 'Perdido', desqualificado: 'Desqualificado',
};
export const NOME_STATUS = {
  DISCOVERED: 'Descoberto', INVESTIGATING: 'Investigando', READY_FOR_APPROACH: 'Na fila', IN_APPROACH: 'Em abordagem',
  CONTACTED: 'Em conversa', CONVERTED: 'Reunião', QUALIFIED: 'Sem contato', DISCARDED: 'Descartado',
};
export const NOME_GANCHO = { fotos: 'Fotos de produto', conteudo: 'Conteúdo', perfil_google: 'Perfil no Google', loja_online: 'Loja online', sistema: 'Sistema de gestão' };
export const NOME_QUALIDADE = { fraco: 'Fraco', medio: 'Médio', bom: 'Bom', excelente: 'Excelente', nao_avaliado: 'Não avaliado' };
export const NOME_ORIGEM = { captador: 'Captador', importado: 'Importado', teste: 'Teste' };
export const NOME_TEMPERATURA = { frio: 'Frio', morno: 'Morno', quente: 'Quente' };
export const CAMPOS_QUALIFICACAO = [
  ['tempo_atuacao', 'Tempo de loja'], ['qtd_produtos', 'Produtos'], ['canais_venda', 'Canais de venda'],
  ['vendas_semana', 'Vendas por semana'], ['tem_loja_online', 'Loja online'], ['decisor', 'Decisor'],
  ['dor_principal', 'Dor principal'], ['servico_interesse', 'Serviço de interesse'], ['orcamento_sinal', 'Sinal de orçamento'],
];
const STATUS_DO_QUALIFICADOR = ['READY_FOR_APPROACH', 'IN_APPROACH', 'CONTACTED', 'CONVERTED'];

/** Nome legível de um código (— quando vazio; o próprio código quando não conhecido). */
export const nomeDe = (mapa, v) => (v === null || v === undefined || v === '' ? '—' : mapa[v] || String(v));

/** Lead na mão do qualificador (é aí que "Assumir conversa" faz sentido). */
export const doQualificador = (l) => STATUS_DO_QUALIFICADOR.includes(l.status) || (l.status === 'DISCARDED' && ETAPAS_SAIDA.includes(l.etapa));

/** "há 2 h" ou "em 3 h", contra o relógio do servidor. */
export function relativo(v) {
  const d = quando(v);
  if (!d) return '—';
  const min = Math.round((agora() - d.getTime()) / 60000);
  const abs = Math.abs(min);
  if (abs < 1) return 'agora';
  const s = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.floor(abs / 60)} h` : `${Math.floor(abs / 1440)} dias`;
  return min >= 0 ? `há ${s}` : `em ${s}`;
}
/** "10/10 08:00" */
export const curto = (v) => (quando(v) ? `${diaMes(v)} ${hm(v)}` : '—');
/** "Sex 09/10 16:00" */
export const comDia = (v) => (quando(v) ? `${semanaCurta(v)} ${diaMes(v)} ${hm(v)}` : '—');

export function valorCampo(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : null;
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${valorCampo(x) ?? '—'}`).join(' · ');
  return String(v);
}

/** Só links https://meet.google.com viram link; o resto aparece como texto. */
export function linkMeet(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && x.hostname === 'meet.google.com' ? x.href : null;
  } catch (_) {
    return null;
  }
}

export function ecommerce(l) {
  if (l.has_ecommerce === true) return l.ecommerce_platform || 'Tem';
  if (l.has_ecommerce === false) return 'Não tem';
  return '—';
}

export function avaliacoes(l) {
  if (l.google_reviews === null || l.google_reviews === undefined) return '—';
  return `${numero(l.google_reviews)}${l.google_rating ? ` · ${String(l.google_rating).replace('.', ',')}` : ''}`;
}

/** Barra fina da nota da conversa (0 a 100; azul a partir de 70). */
export function NotaBarra({ nota, rotulo = 'Nota' }) {
  const v = typeof nota === 'number' && Number.isFinite(nota) ? Math.max(0, Math.min(100, nota)) : null;
  return (
    <span class="pp-nota" title={v === null ? 'Sem nota ainda' : `Nota da conversa: ${v} de 100`}>
      <span>{rotulo}</span>
      <span class="trilho" aria-hidden="true"><i style={{ width: `${v || 0}%` }} /></span>
      <span class={`num${v !== null && v >= 70 ? ' alta' : ''}`}>{v === null ? '—' : v}</span>
    </span>
  );
}

export function Temperatura({ t }) {
  if (!t) return null;
  return <span class={`pp-temp ${t}`}>{nomeDe(NOME_TEMPERATURA, t)}</span>;
}

/** Score do captador: azul a partir de 70, com ponto a partir de 80. */
export function Score({ v, grande }) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return <span class="mudo">—</span>;
  return (
    <span class={`pp-score${v >= 70 ? ' alto' : ''}${grande ? ' grande' : ''}`}>
      {v >= 80 && <span class="pp-score-ponto" aria-hidden="true" />}{v}
    </span>
  );
}
