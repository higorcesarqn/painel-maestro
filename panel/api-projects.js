'use strict';
// api-projects.js · companies and projects of the new model (#6), from maestro.db (bin/flow-store.js):
//   GET  /api/companies                    → { companies: [{ id, name, unassigned, project_count, item_count }] }
//   POST /api/companies {id, name}         → 201 { company } (creates a company, #22; one element of GET /api/companies)
//   POST /api/companies/<id>/rename {name} → { company } (renames a company, #23; the id never changes)
//   POST /api/companies/<id>/remove        → { removed: <id> } (removes a company without projects, #24)
//   GET  /api/projects[?company=<id>]      → { projects: [{ id, name, tracker, company: {id, name}, unassigned, repos,
//                                                           stages, done_state, maestri_workspace, created_at, item_count }] }
//   POST /api/projects/<id>/company {company} → { project } (moves the project to another company, never to "Sem empresa")
// The panel writes the register of companies (create, #22; rename, #23; remove, #24) and moves a project, which is how a repository
// that landed in "Sem empresa" gets its company; registering and editing projects stays with the CLI (flow project).
// The rules are the store's (RegisterError, bin/flow-store.js): this file only gives each code its HTTP status, per
// route (a code without one is a 500). No sentences: errors are codes (ADR 0004).
const path = require('path');

const { UNASSIGNED_COMPANY, STAGES, TRACKERS, RE_ID, RegisterError, companyFields, notReserved } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { listItems, projectInfo } = require(path.join(__dirname, 'api-items.js'));

class ProjectsError extends Error {
  constructor(status, error) {
    super(error.code);
    this.status = status;
    this.error = error;
  }
}

// HTTP status of each code of the store's register rules, per route. In a move the company comes in the body (400).
const MOVE_STATUS = { project_not_found: 404, company_not_found: 400, company_reserved: 400 };
const CREATE_STATUS = { invalid_field: 400, company_exists: 409, company_name_taken: 409 };
const RENAME_STATUS = { invalid_field: 400, company_reserved: 400, company_not_found: 404, company_name_taken: 409 };
const REMOVE_STATUS = { company_reserved: 400, company_not_found: 404, company_not_empty: 409 };

/** fn() under the store's rules: a RegisterError with a status in statuses becomes that HTTP answer (else a 500). */
function underRules(statuses, fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RegisterError && statuses[e.code]) throw new ProjectsError(statuses[e.code], e.error);
    throw e;
  }
}

/** The raw JSON body of a POST as an object; 400 json_object_required otherwise. */
function jsonObject(body) {
  let input;
  try {
    input = JSON.parse(String(body || ''));
  } catch (_) {
    throw new ProjectsError(400, { code: 'json_object_required' });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectsError(400, { code: 'json_object_required' });
  return input;
}

/** Number of items per project id. */
function itemCounts(source) {
  const counts = new Map();
  for (const it of listItems(source).items) counts.set(it.project.id, (counts.get(it.project.id) || 0) + 1);
  return counts;
}

function projectDetail(store, p, counts) {
  return {
    ...projectInfo(p),
    unassigned: p.company_id === UNASSIGNED_COMPANY, repos: store.projectRepos(p.id), stages: p.stages,
    done_state: p.done_state, maestri_workspace: p.maestri_workspace, created_at: p.created_at, item_count: counts.get(p.id) || 0,
  };
}

/** A filter value of the query (company, project): null when absent; throws 400 when it is not an id. */
function idParam(query, name) {
  const v = query && query.get(name);
  if (v === null || v === undefined || v === '') return null;
  if (!RE_ID.test(v)) throw new ProjectsError(400, { code: 'invalid_filter', param: name, value: String(v).slice(0, 100) });
  return v;
}

/** A company as GET /api/companies lists it (and POST /api/companies and .../rename answer it). */
function companySummary(c, projects, counts) {
  const own = projects.filter((p) => p.company_id === c.id);
  return {
    id: c.id, name: c.name, unassigned: c.id === UNASSIGNED_COMPANY,
    project_count: own.length, item_count: own.reduce((n, p) => n + (counts.get(p.id) || 0), 0),
  };
}

/** { companies }: every company (the empty "Sem empresa" too, when it exists), alphabetical with "Sem empresa" last. */
function listCompanies(source) {
  const store = source.store();
  if (!store) return { companies: [] };
  const projects = store.projects();
  const counts = itemCounts(source);
  const companies = store.companies().map((c) => companySummary(c, projects, counts));
  companies.sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || a.name.localeCompare(b.name, 'pt-BR'));
  return { companies };
}

/** { projects }, optionally of one company; "Sem empresa" first (they wait for the owner), then by company and name. */
function listProjects(source, query) {
  const company = idParam(query, 'company');
  const store = source.store();
  if (!store) return { projects: [] };
  const counts = itemCounts(source);
  const projects = store.projects().filter((p) => !company || p.company_id === company).map((p) => projectDetail(store, p, counts));
  projects.sort((a, b) => Number(b.unassigned) - Number(a.unassigned) || a.company.name.localeCompare(b.company.name, 'pt-BR')
    || a.name.localeCompare(b.name, 'pt-BR'));
  return { projects };
}

/** A filter value that must be one of allowed (stage, tracker): null when absent; throws 400 otherwise. */
function oneOfParam(query, name, allowed) {
  const v = query && query.get(name);
  if (v === null || v === undefined || v === '') return null;
  if (!allowed.includes(v)) throw new ProjectsError(400, { code: 'invalid_filter', param: name, value: String(v).slice(0, 100) });
  return v;
}

/**
 * The answer of GET /api/items narrowed by ?company=<id> (the company selector of the page), ?project=<id>,
 * ?stage=<stage> (the item's current stage) and ?tracker=github|azure_devops; an invalid value is 400 invalid_filter.
 */
function filterItems(answer, query) {
  const company = idParam(query, 'company');
  const project = idParam(query, 'project');
  const stage = oneOfParam(query, 'stage', STAGES);
  const tracker = oneOfParam(query, 'tracker', TRACKERS);
  if (!company && !project && !stage && !tracker) return answer;
  return {
    ...answer,
    items: answer.items.filter((it) => (!company || it.project.company.id === company) && (!project || it.project.id === project)
      && (!stage || it.stage === stage) && (!tracker || it.tracker === tracker)),
  };
}

/**
 * Creates a company. body: the raw JSON body ({ id, name }); the store checks both (the name's rule is companyName).
 * at: the creation time (isoSP). The first valid company creates maestro.db, which the panel otherwise never creates:
 * the format of the fields is checked before (companyFields), so an invalid body creates nothing.
 */
function createCompany(source, body, at) {
  const input = jsonObject(body);
  underRules(CREATE_STATUS, () => companyFields(input));
  const store = source.store({ create: true });
  const c = underRules(CREATE_STATUS, () => store.transaction(() => store.addCompany({ id: input.id, name: input.name, at })));
  return { company: companySummary(c, store.projects(), itemCounts(source)) };
}

/**
 * Renames a company (#23; the rules are the store's renameCompany, with companyName's rule for the name). body: the
 * raw JSON body ({ name }). Returns { company } as GET /api/companies lists it and from, the name it had (for the
 * server's log); without maestro.db there is none (404 company_not_found, and nothing is created), but "Sem empresa"
 * is reserved all the same (400 company_reserved).
 */
function renameCompany(source, companyId, body) {
  const input = jsonObject(body);
  const store = source.store();
  if (!store) {
    underRules(RENAME_STATUS, () => notReserved(companyId));
    throw new ProjectsError(RENAME_STATUS.company_not_found, { code: 'company_not_found', company: companyId });
  }
  const c = underRules(RENAME_STATUS, () => store.transaction(() => store.renameCompany(companyId, input.name)));
  return { company: companySummary(c, store.projects(), itemCounts(source)), from: c.from };
}

/**
 * Removes a company without projects (#24; the rules are the store's removeCompany). Returns the removed company
 * ({ id, name, created_at }); without maestro.db there is none (404 company_not_found, and nothing is created), but
 * "Sem empresa" is reserved all the same (400 company_reserved).
 */
function removeCompany(source, companyId) {
  const store = source.store();
  if (!store) {
    underRules(REMOVE_STATUS, () => notReserved(companyId));
    throw new ProjectsError(REMOVE_STATUS.company_not_found, { code: 'company_not_found', company: companyId });
  }
  return underRules(REMOVE_STATUS, () => store.transaction(() => store.removeCompany(companyId)));
}

/** Moves a project to a company. body: the raw JSON body ({ company }). */
function moveProject(source, projectId, body) {
  const input = jsonObject(body);
  const company = typeof input.company === 'string' ? input.company.trim() : '';
  if (!RE_ID.test(company)) throw new ProjectsError(400, { code: 'invalid_field', field: 'company', value: String(input.company ?? '').slice(0, 100) });
  const store = source.store();
  if (!store || !store.project(projectId)) throw new ProjectsError(404, { code: 'project_not_found', project: projectId });
  return underRules(MOVE_STATUS, () => store.transaction(() => ({ project: projectDetail(store, store.moveProject(projectId, company), itemCounts(source)) })));
}

/** Id in the route of a project or a company (both share the register's format, RE_ID): the decoded id, or null. */
function parseRegisterId(text) {
  let id;
  try {
    id = decodeURIComponent(text);
  } catch (_) {
    return null;
  }
  return RE_ID.test(id) ? id : null;
}

module.exports = { listCompanies, listProjects, filterItems, createCompany, renameCompany, removeCompany, moveProject, parseRegisterId, ProjectsError };
