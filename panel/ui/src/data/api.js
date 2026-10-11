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
// Pending decisions: params { organization, project, severity, status }.
export const readPendingDecisions = (params) => api(withQuery('/api/pending-decisions', params));
// The owner's answer to an open pending decision (#32): option, a letter or null; text, the comment. Returns the pending
// decision as readPendingDecisions lists it (resolved, with the decision); 409 when it was closed meanwhile.
export const answerPendingDecision = (id, option, text) => api(`/api/pending-decisions/${encodeURIComponent(id)}/answer`, { method: 'POST', body: { option, text } });
// "Mark as merged" (#11): records the PR merge by hand when the merge check cannot read it. Returns { item }.
export const markItemMerged = (project, number) => api(`/api/items/${encodeURIComponent(project)}/${encodeURIComponent(number)}/merged`, { method: 'POST' });
// Usage and agents per item (#13). filters: the organization selector's organizationFilter ({ organization }) and/or { project }.
export const readUsage = (filters) => api(withQuery('/api/usage', filters));
export const readAgents = (filters) => api(withQuery('/api/agents', filters));

// Overview (#14): the picture of the day, narrowed by the organization of the selector (organizationFilter).
export const readOverview = (filters) => api(withQuery('/api/overview', filters));

// Organizations and projects (#6). The organization selector reaches each list as ?organization=<id> (see organizationFilter).
// Both leave the hidden organizations out; only Settings reads them with { hidden: 'include' } (#50).
export const readOrganizations = (filters) => api(withQuery('/api/organizations', filters));
export const readProjects = (filters) => api(withQuery('/api/projects', filters));
// Creates an organization (#22): { organization }, as GET /api/organizations lists it.
export const createOrganization = (id, name) => api('/api/organizations', { method: 'POST', body: { id, name } });
// Renames an organization (#23; the id never changes): { organization }, as GET /api/organizations lists it.
export const renameOrganization = (id, name) => api(`/api/organizations/${encodeURIComponent(id)}/rename`, { method: 'POST', body: { name } });
// Removes an organization without projects (#24): { removed: <id> }.
export const removeOrganization = (id) => api(`/api/organizations/${encodeURIComponent(id)}/remove`, { method: 'POST' });
// Hides or shows an organization (#50; repeating is not an error): { organization }, as GET /api/organizations?hidden=include lists it.
export const hideOrganization = (id) => api(`/api/organizations/${encodeURIComponent(id)}/hide`, { method: 'POST' });
export const unhideOrganization = (id) => api(`/api/organizations/${encodeURIComponent(id)}/unhide`, { method: 'POST' });
export const moveProject = (project, organization) => api(`/api/projects/${encodeURIComponent(project)}/organization`, { method: 'POST', body: { organization } });

/**
 * path?k=v for the filled values of filters ({ organization: 'contoso', project: '' } → path?organization=contoso): the only way
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
