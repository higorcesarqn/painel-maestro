// Access to the server.js API (only the server itself; POST carries X-Panel: 1). With ?mock=1, everything comes
// from the mock. The API is in English and answers codes instead of sentences; compat.js turns the answers into
// the shape the screens still read (provisional, until task #4).
import { mockApi } from './mock.js';
import { paraTelas, parametrosDaApi, traduzir } from './compat.js';

export const INTERVALO_MS = 20000;
export const POR_PAGINA = 50;
export const INTERVALO_ANALITICO_MS = 60000;
export const MOCK = new URLSearchParams(location.search).get('mock') === '1';

/** options: { method: 'GET' | 'POST', body: value sent as JSON (POST only) }. Returns the API answer as is. */
export async function api(urlPath, options) {
  const method = (options && options.method) || 'GET';
  const body = options && options.body !== undefined ? options.body : undefined;
  if (MOCK) {
    return mockApi(urlPath, method, body).catch((e) => {
      if (!e.error) throw e;
      const x = new Error(traduzir(e.error));
      x.status = e.status;
      throw x;
    });
  }
  const headers = method === 'POST' ? { 'X-Panel': '1' } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(urlPath, {
    method, cache: 'no-store', credentials: 'same-origin', headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let answer = null;
  try { answer = await r.json(); } catch (_) { answer = null; }
  if (!r.ok) {
    const e = new Error((answer && answer.error && traduzir(answer.error)) || `O servidor respondeu ${r.status}.`);
    e.status = r.status;
    throw e;
  }
  return answer;
}

export const lerEstado = () => api('/api/state').then(paraTelas);
export const recalcularUso = () => api('/api/recalculate', { method: 'POST' }).then(paraTelas);
export const lerEventos = (params) => api(`/api/events?${parametrosDaApi(params).toString()}`).then(paraTelas);
export const lerEvento = (id) => api(`/api/event/${encodeURIComponent(id)}`).then(paraTelas);

/**
 * Owner's answer to a pending decision: { opcao: 'A' | null, texto }. The server writes it (pendencia.js responder)
 * and notifies the Brain in its terminal. Returns { ok, pendencia, aviso_cerebro: { enviado, para | motivo } }.
 * With ?mock=1 nothing leaves the page: the answer is simulated over the pending decision itself (p).
 */
export async function responderPendencia(p, { opcao, texto }) {
  if (MOCK) {
    const opcoes = Array.isArray(p.opcoes) ? p.opcoes : [];
    const daOpcao = opcao ? opcoes.find((o) => new RegExp(`^\\s*(?:opç[aã]o\\s+)?${opcao}\\s*[:).\\-–]`, 'i').test(o)) || opcoes[opcao.charCodeAt(0) - 65] : null;
    const resposta = daOpcao ? (texto ? `${daOpcao} · Comentário do dono: ${texto}` : daOpcao) : texto;
    return {
      ok: true,
      pendencia: { ...p, status: 'respondida', resposta, respondida_em: new Date().toISOString() },
      aviso_cerebro: { enviado: false, motivo: traduzir({ code: 'mock_mode' }) },
    };
  }
  const answer = await api(`/api/pending-decisions/${encodeURIComponent(p.id)}/answer`, { method: 'POST', body: { option: opcao || null, text: texto || '' } });
  return paraTelas(answer);
}
