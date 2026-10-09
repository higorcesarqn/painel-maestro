// Acesso à API do servidor.js (só o próprio servidor; POST leva X-Painel: 1). Com ?mock=1, tudo vem do mock.
import { mockApi } from './mock.js';

export const INTERVALO_MS = 20000;
export const POR_PAGINA = 50;
export const INTERVALO_ANALITICO_MS = 60000;
export const INTERVALO_PROSPECCAO_MS = 30000;
export const MOCK = new URLSearchParams(location.search).get('mock') === '1';

/** opcoes: { metodo: 'GET' | 'POST', corpo: objeto enviado como JSON (só no POST) } */
export async function api(caminho, opcoes) {
  const metodo = (opcoes && opcoes.metodo) || 'GET';
  const corpoPedido = opcoes && opcoes.corpo !== undefined ? opcoes.corpo : undefined;
  if (MOCK) return mockApi(caminho, metodo, corpoPedido);
  const cab = metodo === 'POST' ? { 'X-Painel': '1' } : {};
  if (corpoPedido !== undefined) cab['Content-Type'] = 'application/json';
  const r = await fetch(caminho, {
    method: metodo, cache: 'no-store', credentials: 'same-origin', headers: cab,
    body: corpoPedido !== undefined ? JSON.stringify(corpoPedido) : undefined,
  });
  let corpo = null;
  try { corpo = await r.json(); } catch (_) { corpo = null; }
  if (!r.ok) {
    const e = new Error((corpo && corpo.erro) || `O servidor respondeu ${r.status}.`);
    e.status = r.status;
    throw e;
  }
  return corpo;
}

export const lerEstado = () => api('/api/estado');
export const recalcularUso = () => api('/api/recalcular', { metodo: 'POST' });
export const lerEventos = (params) => api(`/api/eventos?${params.toString()}`);
export const lerEvento = (id) => api(`/api/evento/${encodeURIComponent(id)}`);
export const lerProspeccao = () => api('/api/prospeccao/estado');
export const lerLeadProspeccao = (id) => api(`/api/prospeccao/lead/${encodeURIComponent(id)}`);
/** acao: 'assumir' (pausa o agente no lead) ou 'devolver' (o agente volta a cuidar dele). */
export const alterarLeadProspeccao = (acao, id) => api(`/api/prospeccao/${acao === 'assumir' ? 'assumir' : 'devolver'}`, { metodo: 'POST', corpo: { lead_id: id } });

/**
 * Resposta do dono a uma pendência: { opcao: 'A' | null, texto }. O servidor grava (pendencia.js responder) e avisa
 * o Cérebro no terminal dele. Devolve { ok, pendencia, aviso_cerebro: { enviado, para | motivo } }.
 * No ?mock=1 nada sai daqui: a resposta é simulada sobre a própria pendência (p).
 */
export async function responderPendencia(p, { opcao, texto }) {
  if (MOCK) {
    const opcoes = Array.isArray(p.opcoes) ? p.opcoes : [];
    const daOpcao = opcao ? opcoes.find((o) => new RegExp(`^\\s*(?:opç[aã]o\\s+)?${opcao}\\s*[:).\\-–]`, 'i').test(o)) || opcoes[opcao.charCodeAt(0) - 65] : null;
    const resposta = daOpcao ? (texto ? `${daOpcao} · Comentário do dono: ${texto}` : daOpcao) : texto;
    return {
      ok: true,
      pendencia: { ...p, status: 'respondida', resposta, respondida_em: new Date().toISOString() },
      aviso_cerebro: { enviado: false, motivo: 'modo de teste (?mock=1): nada foi gravado nem enviado' },
    };
  }
  return api(`/api/pendencias/${encodeURIComponent(p.id)}/responder`, { metodo: 'POST', corpo: { opcao: opcao || null, texto: texto || '' } });
}
