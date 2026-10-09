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
export const readItems = (filters) => api(withQuery('/api/items', filters));
export const readItem = (project, number) => api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}`);
// New model Log: the events of maestro.db with filters and, for one event, the raw commands of bruto.db linked to it.
export const readLog = (params) => api(`/api/log?${new URLSearchParams(params).toString()}`);
export const readLogEvent = (id) => api(`/api/log/${encodeURIComponent(id)}`);
// Pending decisions of the new model, read only: params { company, project, severity, status }.
export const readPendingDecisions = (params) => api(`/api/pending-decisions?${new URLSearchParams(params).toString()}`);
// "Mark as merged" (#11): records the PR merge by hand when the merge check cannot read it. Returns { item }.
export const markItemMerged = (project, number) => api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}/merged`, { method: 'POST' });

// Companies and projects (#6). The company selector reaches each list as ?company=<id> (see companyFilter).
export const readCompanies = () => api('/api/companies');
export const readProjects = (filters) => api(withQuery('/api/projects', filters));
export const moveProject = (project, company) => api(`/api/projects/${encodeURIComponent(project)}/company`, { method: 'POST', body: { company } });

/** path?k=v for the filled values of filters ({ company: 'contoso', project: '' } → path?company=contoso). */
export function withQuery(path, filters) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) if (typeof v === 'string' && v) sp.set(k, v);
  const q = sp.toString();
  return q ? `${path}?${q}` : path;
}
