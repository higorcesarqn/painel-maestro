// Access to the server.js API (only the server itself; POST carries X-Panel: 1). With ?mock=1, everything comes
// from the mock. The API answers in English, with codes instead of sentences ({code, ...params}); the screens
// read it as it is and translate the codes with the dictionary (i18n).
import { mockApi } from './mock.js';
import { t, translateCode } from '../i18n/index.js';

export const REFRESH_MS = 20000;
export const PAGE_SIZE = 50;
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

// The shell: health badge, menu counter of open pending decisions and plan usage. Recalculate runs the usage collector.
export const readState = () => api('/api/state');
export const recalculateUsage = () => api('/api/recalculate', { method: 'POST' });
// Items (maestro.db) with their state computed from the events.
export const readItems = (filters) => api(withQuery('/api/items', filters));
export const readItem = (project, number) => api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}`);
// The Log: the events of maestro.db with filters and, for one event, the raw commands of bruto.db linked to it.
export const readLog = (params) => api(withQuery('/api/log', params));
export const readLogEvent = (id) => api(`/api/log/${encodeURIComponent(id)}`);
// Pending decisions, read only: params { company, project, severity, status }.
export const readPendingDecisions = (params) => api(withQuery('/api/pending-decisions', params));
// "Mark as merged" (#11): records the PR merge by hand when the merge check cannot read it. Returns { item }.
export const markItemMerged = (project, number) => api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}/merged`, { method: 'POST' });
// Usage and agents per item (#13). filters: the company selector's companyFilter ({ company }) and/or { project }.
export const readUsage = (filters) => api(withQuery('/api/usage', filters));
export const readAgents = (filters) => api(withQuery('/api/agents', filters));

// Overview (#14): the picture of the day, narrowed by the company of the selector (companyFilter).
export const readOverview = (filters) => api(withQuery('/api/overview', filters));

// Companies and projects (#6). The company selector reaches each list as ?company=<id> (see companyFilter).
export const readCompanies = () => api('/api/companies');
export const readProjects = (filters) => api(withQuery('/api/projects', filters));
// Creates a company (#22): { company }, as GET /api/companies lists it.
export const createCompany = (id, name) => api('/api/companies', { method: 'POST', body: { id, name } });
// Renames a company (#23; the id never changes): { company }, as GET /api/companies lists it.
export const renameCompany = (id, name) => api(`/api/companies/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { name } });
// Removes a company without projects (#24): { removed: <id> }.
export const removeCompany = (id) => api(`/api/companies/${encodeURIComponent(id)}/remove`, { method: 'POST' });
export const moveProject = (project, company) => api(`/api/projects/${encodeURIComponent(project)}/company`, { method: 'POST', body: { company } });

/**
 * path?k=v for the filled values of filters ({ company: 'contoso', project: '' } → path?company=contoso): the only way
 * the page builds a query string. Text and number values count; empty, null and undefined are left out.
 */
export function withQuery(path, filters) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) {
    if ((typeof v === 'string' && v) || (typeof v === 'number' && Number.isFinite(v))) sp.set(k, String(v));
  }
  const q = sp.toString();
  return q ? `${path}?${q}` : path;
}
