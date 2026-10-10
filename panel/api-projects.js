'use strict';
// api-projects.js · organizations and projects of the new model (#6), from maestro.db (bin/flow-store.js):
//   GET  /api/organizations                    → { organizations: [{ id, name, unassigned, project_count, item_count }] }
//   POST /api/organizations {id, name}         → 201 { organization } (creates an organization, #22; one element of GET /api/organizations)
//   POST /api/organizations/<id>/rename {name} → { organization } (renames an organization, #23; the id never changes)
//   POST /api/organizations/<id>/remove        → { removed: <id> } (removes an organization without projects, #24)
//   GET  /api/projects[?organization=<id>]     → { projects: [{ id, name, tracker, organization: {id, name}, unassigned, repos,
//                                                          stages, done_state, maestri_workspace, created_at, item_count }] }
//   POST /api/projects/<id>/organization {organization} → { project } (moves the project to another organization, never to "Sem organização")
// The panel writes the register of organizations (create, #22; rename, #23; remove, #24) and moves a project, which is how a repository
// that landed in "Sem organização" gets its organization; registering and editing projects stays with the CLI (flow project).
// The rules are the store's (RegisterError, bin/flow-store.js): this file only gives each code its HTTP status, per
// route (a code without one is a 500). No sentences: errors are codes (ADR 0004).
const path = require('path');

const { UNASSIGNED_ORGANIZATION, STAGES, TRACKERS, RE_ID, RegisterError, organizationFields, notReserved } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { listItems, projectInfo } = require(path.join(__dirname, 'api-items.js'));

class ProjectsError extends Error {
  constructor(status, error) {
    super(error.code);
    this.status = status;
    this.error = error;
  }
}

// HTTP status of each code of the store's register rules, per route. In a move the organization comes in the body (400).
const MOVE_STATUS = { project_not_found: 404, organization_not_found: 400, organization_reserved: 400 };
const CREATE_STATUS = { invalid_field: 400, organization_exists: 409, organization_name_taken: 409 };
const RENAME_STATUS = { invalid_field: 400, organization_reserved: 400, organization_not_found: 404, organization_name_taken: 409 };
const REMOVE_STATUS = { organization_reserved: 400, organization_not_found: 404, organization_not_empty: 409 };

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
    unassigned: p.organization_id === UNASSIGNED_ORGANIZATION, repos: store.projectRepos(p.id), stages: p.stages,
    done_state: p.done_state, maestri_workspace: p.maestri_workspace, created_at: p.created_at, item_count: counts.get(p.id) || 0,
  };
}

/** A filter value of the query (organization, project): null when absent; throws 400 when it is not an id. */
function idParam(query, name) {
  const v = query && query.get(name);
  if (v === null || v === undefined || v === '') return null;
  if (!RE_ID.test(v)) throw new ProjectsError(400, { code: 'invalid_filter', param: name, value: String(v).slice(0, 100) });
  return v;
}

/** An organization as GET /api/organizations lists it (and POST /api/organizations and .../rename answer it). */
function organizationSummary(c, projects, counts) {
  const own = projects.filter((p) => p.organization_id === c.id);
  return {
    id: c.id, name: c.name, unassigned: c.id === UNASSIGNED_ORGANIZATION,
    project_count: own.length, item_count: own.reduce((n, p) => n + (counts.get(p.id) || 0), 0),
  };
}

/** { organizations }: every organization (the empty "Sem organização" too, when it exists), alphabetical with "Sem organização" last. */
function listOrganizations(source) {
  const store = source.store();
  if (!store) return { organizations: [] };
  const projects = store.projects();
  const counts = itemCounts(source);
  const organizations = store.organizations().map((c) => organizationSummary(c, projects, counts));
  organizations.sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || a.name.localeCompare(b.name, 'pt-BR'));
  return { organizations };
}

/** { projects }, optionally of one organization; "Sem organização" first (they wait for the owner), then by organization and name. */
function listProjects(source, query) {
  const organization = idParam(query, 'organization');
  const store = source.store();
  if (!store) return { projects: [] };
  const counts = itemCounts(source);
  const projects = store.projects().filter((p) => !organization || p.organization_id === organization).map((p) => projectDetail(store, p, counts));
  projects.sort((a, b) => Number(b.unassigned) - Number(a.unassigned) || a.organization.name.localeCompare(b.organization.name, 'pt-BR')
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
 * The answer of GET /api/items narrowed by ?organization=<id> (the organization selector of the page), ?project=<id>,
 * ?stage=<stage> (the item's current stage) and ?tracker=github|azure_devops; an invalid value is 400 invalid_filter.
 */
function filterItems(answer, query) {
  const organization = idParam(query, 'organization');
  const project = idParam(query, 'project');
  const stage = oneOfParam(query, 'stage', STAGES);
  const tracker = oneOfParam(query, 'tracker', TRACKERS);
  if (!organization && !project && !stage && !tracker) return answer;
  return {
    ...answer,
    items: answer.items.filter((it) => (!organization || it.project.organization.id === organization) && (!project || it.project.id === project)
      && (!stage || it.stage === stage) && (!tracker || it.tracker === tracker)),
  };
}

/**
 * Creates an organization. body: the raw JSON body ({ id, name }); the store checks both (the name's rule is organizationName).
 * at: the creation time (isoSP). The first valid organization creates maestro.db, which the panel otherwise never creates:
 * the format of the fields is checked before (organizationFields), so an invalid body creates nothing.
 */
function createOrganization(source, body, at) {
  const input = jsonObject(body);
  underRules(CREATE_STATUS, () => organizationFields(input));
  const store = source.store({ create: true });
  const c = underRules(CREATE_STATUS, () => store.transaction(() => store.addOrganization({ id: input.id, name: input.name, at })));
  return { organization: organizationSummary(c, store.projects(), itemCounts(source)) };
}

/**
 * Renames an organization (#23; the rules are the store's renameOrganization, with organizationName's rule for the name). body: the
 * raw JSON body ({ name }). Returns { organization } as GET /api/organizations lists it and from, the name it had (for the
 * server's log); without maestro.db there is none (404 organization_not_found, and nothing is created), but "Sem organização"
 * is reserved all the same (400 organization_reserved).
 */
function renameOrganization(source, organizationId, body) {
  const input = jsonObject(body);
  const store = source.store();
  if (!store) {
    underRules(RENAME_STATUS, () => notReserved(organizationId));
    throw new ProjectsError(RENAME_STATUS.organization_not_found, { code: 'organization_not_found', organization: organizationId });
  }
  const c = underRules(RENAME_STATUS, () => store.transaction(() => store.renameOrganization(organizationId, input.name)));
  return { organization: organizationSummary(c, store.projects(), itemCounts(source)), from: c.from };
}

/**
 * Removes an organization without projects (#24; the rules are the store's removeOrganization). Returns the removed organization
 * ({ id, name, created_at }); without maestro.db there is none (404 organization_not_found, and nothing is created), but
 * "Sem organização" is reserved all the same (400 organization_reserved).
 */
function removeOrganization(source, organizationId) {
  const store = source.store();
  if (!store) {
    underRules(REMOVE_STATUS, () => notReserved(organizationId));
    throw new ProjectsError(REMOVE_STATUS.organization_not_found, { code: 'organization_not_found', organization: organizationId });
  }
  return underRules(REMOVE_STATUS, () => store.transaction(() => store.removeOrganization(organizationId)));
}

/** Moves a project to an organization. body: the raw JSON body ({ organization }). */
function moveProject(source, projectId, body) {
  const input = jsonObject(body);
  const organization = typeof input.organization === 'string' ? input.organization.trim() : '';
  if (!RE_ID.test(organization)) throw new ProjectsError(400, { code: 'invalid_field', field: 'organization', value: String(input.organization ?? '').slice(0, 100) });
  const store = source.store();
  if (!store || !store.project(projectId)) throw new ProjectsError(404, { code: 'project_not_found', project: projectId });
  return underRules(MOVE_STATUS, () => store.transaction(() => ({ project: projectDetail(store, store.moveProject(projectId, organization), itemCounts(source)) })));
}

/** Id in the route of a project or an organization (both share the register's format, RE_ID): the decoded id, or null. */
function parseRegisterId(text) {
  let id;
  try {
    id = decodeURIComponent(text);
  } catch (_) {
    return null;
  }
  return RE_ID.test(id) ? id : null;
}

module.exports = { listOrganizations, listProjects, filterItems, createOrganization, renameOrganization, removeOrganization, moveProject, parseRegisterId, ProjectsError };
