// Access to the server.js API (only the server itself; POST carries X-Panel: 1). With ?mock=1, everything comes
// from the mock. The API answers in English, with codes instead of sentences ({code, ...params}); the screens
// read it as it is and translate the codes with the dictionary (i18n).
import { mockApi } from './mock.js';
import { t, translateCode } from '../i18n/index.js';

export const REFRESH_MS = 20000;
export const PAGE_SIZE = 50;
export const ANALYSIS_REFRESH_MS = 60000;
export const MOCK = new URLSearchParams(location.search).get('mock') === '1';

/** options: { method: 'GET' | 'POST', body: value sent as JSON (POST only) }. Returns the API answer as is. */
export async function api(urlPath, options) {
  const method = (options && options.method) || 'GET';
  const body = options && options.body !== undefined ? options.body : undefined;
  if (MOCK) {
    return mockApi(urlPath, method, body).catch((e) => {
      if (!e.error) throw e;
      const x = new Error(translateCode(e.error));
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
    const e = new Error((answer && answer.error && translateCode(answer.error)) || t('errors.serverStatus', { status: r.status }));
    e.status = r.status;
    throw e;
  }
  return answer;
}

export const readState = () => api('/api/state');
export const recalculateUsage = () => api('/api/recalculate', { method: 'POST' });
export const readEvents = (params) => api(`/api/events?${new URLSearchParams(params).toString()}`);
export const readEvent = (id) => api(`/api/event/${encodeURIComponent(id)}`);
// New model (maestro.db): items with their state computed from the events.
export const readItems = () => api('/api/items');
export const readItem = (project, number) => api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}`);
// New model Log: the events of maestro.db with filters and, for one event, the raw commands of bruto.db linked to it.
export const readLog = (params) => api(`/api/log?${new URLSearchParams(params).toString()}`);
export const readLogEvent = (id) => api(`/api/log/${encodeURIComponent(id)}`);
// Usage and agents per item (#13). filters: the company selector's companyFilter ({ company }) and/or { project }.
export const readUsage = (filters) => api(`/api/usage${filterQuery(filters)}`);
export const readAgents = (filters) => api(`/api/agents${filterQuery(filters)}`);

/** "?company=x&project=y" with the filled company and project of filters ("" without any). */
function filterQuery(filters) {
  const sp = new URLSearchParams();
  for (const k of ['company', 'project']) if (filters && typeof filters[k] === 'string' && filters[k]) sp.set(k, filters[k]);
  const q = sp.toString();
  return q ? `?${q}` : '';
}

// Option letter at the start of an option of the old model ("A: ...", or the Portuguese word for "option" + "B) ...");
// the word is data written by the agents, in Portuguese.
export const OPTION_LETTER = /^\s*(?:op[\u00e7c][a\u00e3]o\s+)?([A-Z])\s*[:).\-\u2013]\s*/i;

/**
 * Owner's answer to a pending decision: { option: 'A' | null, text }. The server writes it (pendencia.js responder)
 * and notifies the Brain in its terminal. Returns { ok, pending_decision, brain_notice: { sent, to | reason } }.
 * With ?mock=1 nothing leaves the page: the answer is simulated over the pending decision itself (p).
 */
export async function answerPendingDecision(p, { option, text }) {
  if (MOCK) {
    const options = Array.isArray(p.options) ? p.options : [];
    const fromOption = option
      ? options.find((o) => { const m = OPTION_LETTER.exec(o); return m && m[1].toUpperCase() === option; }) || options[option.charCodeAt(0) - 65]
      : null;
    const answer = fromOption ? (text ? t('pending.mockAnswer', { option: fromOption, comment: text }) : fromOption) : text;
    return {
      ok: true,
      pending_decision: { ...p, status: 'respondida', answer, answered_at: new Date().toISOString() },
      brain_notice: { sent: false, reason: t('pending.mockNotice') },
    };
  }
  return api(`/api/pending-decisions/${encodeURIComponent(p.id)}/answer`, { method: 'POST', body: { option: option || null, text: text || '' } });
}
