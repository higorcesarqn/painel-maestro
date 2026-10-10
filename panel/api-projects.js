'use strict';
// api-projects.js · companies and projects of the new model (#6), from maestro.db (bin/flow-store.js):
//   GET  /api/companies                    → { companies: [{ id, name, unassigned, project_count, item_count }] }
//   GET  /api/projects[?company=<id>]      → { projects: [{ id, name, tracker, company: {id, name}, unassigned, repos,
//                                                           stages, done_state, maestri_workspace, created_at, item_count }] }
//   POST /api/projects/<id>/company {company} → { project } (moves the project to another company, never to "Sem empresa")
// The register itself is written by the CLI (flow company / flow project); the panel only moves a project, which is
// how a repository that landed in "Sem empresa" gets its company. The rules are the store's (RegisterError,
// bin/flow-store.js): this file only gives each code its HTTP status. No sentences: errors are codes (ADR 0004).
const path = require('path');

const { UNASSIGNED_COMPANY, STAGES, TRACKERS, RegisterError } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { listItems, projectInfo } = require(path.join(__dirname, 'api-items.js'));

const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

class ProjectsError extends Error {
  constructor(status, error) {
    super(error.code);
    this.status = status;
    this.error = error;
  }
}

// HTTP status of each code of the store's register rules, in a move (the company comes in the body: 400).
const MOVE_STATUS = { project_not_found: 404, company_not_found: 400, company_reserved: 400 };

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

/** { companies }: every company (the empty "Sem empresa" too, when it exists), alphabetical with "Sem empresa" last. */
function listCompanies(source) {
  const store = source.store();
  if (!store) return { companies: [] };
  const projects = store.projects();
  const counts = itemCounts(source);
  const companies = store.companies().map((c) => {
    const own = projects.filter((p) => p.company_id === c.id);
    return {
      id: c.id, name: c.name, unassigned: c.id === UNASSIGNED_COMPANY,
      project_count: own.length, item_count: own.reduce((n, p) => n + (counts.get(p.id) || 0), 0),
    };
  });
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

/** Moves a project to a company. body: the raw JSON body ({ company }). */
function moveProject(source, projectId, body) {
  let input;
  try {
    input = JSON.parse(String(body || ''));
  } catch (_) {
    throw new ProjectsError(400, { code: 'json_object_required' });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectsError(400, { code: 'json_object_required' });
  const company = typeof input.company === 'string' ? input.company.trim() : '';
  if (!RE_ID.test(company)) throw new ProjectsError(400, { code: 'invalid_field', field: 'company', value: String(input.company ?? '').slice(0, 100) });
  const store = source.store();
  if (!store || !store.project(projectId)) throw new ProjectsError(404, { code: 'project_not_found', project: projectId });
  try {
    return store.transaction(() => ({ project: projectDetail(store, store.moveProject(projectId, company), itemCounts(source)) }));
  } catch (e) {
    if (e instanceof RegisterError && MOVE_STATUS[e.code]) throw new ProjectsError(MOVE_STATUS[e.code], e.error);
    throw e;
  }
}

/** Route of a project: the decoded id, or null. */
function parseProjectId(text) {
  let id;
  try {
    id = decodeURIComponent(text);
  } catch (_) {
    return null;
  }
  return RE_ID.test(id) ? id : null;
}

module.exports = { listCompanies, listProjects, filterItems, moveProject, parseProjectId, ProjectsError };
