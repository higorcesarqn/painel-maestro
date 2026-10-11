'use strict';
// flow-admin.js · the "org" and "project" subcommands of bin/flow.js (#6): the owner's register of organizations and
// projects in maestro.db. Unlike the flow commands they do not need to run inside a repository (project add without
// --repo uses the current folder's remote).
//
//   flow org list
//   flow org add <id> --name "<name>"
//   flow org rename <id> --name "<name>"      (the id never changes, #23)
//   flow org remove <id>                     (only an organization without projects, #24)
//   flow org hide <id> / flow org unhide <id>  (out of the panel's listings and back, #49; repeating is not an error)
//   flow project list [--org <id>]
//   flow project add <id> --org <id> [--name "..."] [--tracker github|azure_devops] [--repo <url>]...
//                    [--stages a,b,...] [--done-state "<state>"] [--workspace "<Maestri workspace>"]
//   flow project edit <id> [--name] [--org] [--tracker] [--repo <url>]... [--remove-repo <url>]... [--stages]
//                    [--done-state] [--workspace]          (an empty --done-state/--workspace clears it)
//   flow project move <id> <org>
//
// A project may have many repositories (an Azure DevOps project usually does): each one is a remote URL, kept
// normalized (flow-repo.js), so the flow commands run in any of them resolve the same project. "Pessoal" is a
// organization like the others; "unassigned" (Sem organização) is where unregistered repositories land, never a destination,
// never renamed and never removed.
// Invalid data throws helpers.InvalidData (exit 2); the messages come from the pt-BR dictionary (admin.*). The rules of the
// register are the store's (RegisterError, bin/flow-store.js): run() turns its codes into the same kind of message.
const lib = require('./lib');
const { t } = require('./i18n');
const { openStore, flowDir, RegisterError, RE_ID, STAGES, TRACKERS } = require('./flow-store');
const { originOf, describeRemote } = require('./flow-repo');

const MAX_NAME = 120;
const MAX_REPOS = 50;

const OPTIONS = {
  'org add': ['name', 'json'],
  'org list': [],
  'org rename': ['name', 'json'],
  'org remove': ['json'],
  'org hide': ['json'],
  'org unhide': ['json'],
  'project list': ['org'],
  'project add': ['name', 'org', 'tracker', 'repo', 'stages', 'done-state', 'workspace', 'json'],
  'project edit': ['name', 'org', 'tracker', 'repo', 'remove-repo', 'stages', 'done-state', 'workspace', 'json'],
  'project move': ['json'],
};
const POSITIONAL = { 'org add': 1, 'org list': 0, 'org rename': 1, 'org remove': 1, 'org hide': 1, 'org unhide': 1, 'project list': 0, 'project add': 1, 'project edit': 1, 'project move': 2 };
const REPEATABLE = ['repo', 'remove-repo'];

const isAdminCommand = (argv) => argv[0] === 'org' || argv[0] === 'project';

function createAdmin({ InvalidData, parseArgs, readJson, pick }) {
  const fail = (key, params) => new InvalidData(`admin.errors.${key}`, params);

  function id(value, kind) {
    if (value === undefined || value === null || String(value).trim() === '') throw fail(kind === 'organization' ? 'missingOrganizationId' : 'missingProjectId');
    const s = String(value).trim();
    if (!RE_ID.test(s)) throw fail('invalidId', { kind: t(`admin.kinds.${kind}`), value: s });
    return s;
  }

  /** Optional one-line text: undefined when absent; '' clears (null) when clearable. */
  function text(value, field, { clearable = false } = {}) {
    if (value === undefined || value === null) return undefined;
    const s = String(value).trim();
    if (!s) {
      if (clearable) return null;
      throw fail('emptyText', { field });
    }
    if (s.length > MAX_NAME || /[\r\n]/.test(s)) throw fail('invalidText', { field, max: MAX_NAME });
    return s;
  }

  /** The tracker of a project (github | azure_devops); undefined when absent. */
  function parseTracker(value) {
    if (value === undefined || value === null) return undefined;
    const s = lib.normalizeId(value);
    if (!TRACKERS.includes(s)) throw fail('invalidTracker', { value, allowed: TRACKERS.join(', ') });
    return s;
  }

  /** "a,b" or ["a","b"] → the stages in the canonical order; undefined when absent. */
  function parseStages(value) {
    if (value === undefined || value === null) return undefined;
    const list = Array.isArray(value) ? value : String(value).split(',');
    const ids = list.map(lib.normalizeId).filter(Boolean);
    if (!ids.length) throw fail('missingStages');
    for (const s of ids) if (!STAGES.includes(s)) throw new InvalidData('errors.unknownStage', { stage: s, allowed: STAGES });
    return STAGES.filter((s) => ids.includes(s));
  }

  /** Remote URLs → [{ remote, tracker }], normalized, without repeats. */
  function repos(values) {
    const list = (values || []).map((v) => String(v).trim()).filter(Boolean);
    if (list.length > MAX_REPOS) throw fail('tooManyRepos', { max: MAX_REPOS });
    const out = new Map();
    for (const url of list) {
      const d = describeRemote(url);
      if (!/^[^/]+\/.+/.test(d.remote) || /\s/.test(d.remote)) throw fail('invalidRepo', { value: url });
      out.set(d.remote, { remote: d.remote, tracker: d.tracker });
    }
    return [...out.values()];
  }

  const listOf = (opt, json) => (opt !== undefined ? opt : Array.isArray(json) ? json : json === undefined || json === null ? undefined : [json]);

  function parse(argv) {
    const [noun, verb, ...args] = argv;
    const name = `${noun} ${verb || ''}`.trim();
    if (!OPTIONS[name]) throw new InvalidData(verb === undefined ? 'errors.missingCommand' : 'errors.unknownCommand', { command: name });
    const { opts, pos } = parseArgs(args, OPTIONS[name], POSITIONAL[name], REPEATABLE);
    const json = OPTIONS[name].includes('json') ? readJson(opts) : {};
    const cmd = { name };
    if (name === 'org list') return cmd;
    if (name === 'project list') return { ...cmd, organization: opts.org === undefined ? null : id(opts.org, 'organization') };
    if (name === 'org add') {
      // The name's rule (trimmed, up to 80, unique ignoring case) is the store's (organizationName).
      const organizationName = pick(opts.name, json.name);
      if (organizationName === undefined || organizationName === null) throw fail('missingOrganizationName');
      return { ...cmd, id: id(pick(pos[0], json.id), 'organization'), organizationName };
    }
    if (name === 'org rename') {
      // The name's rule (trimmed, up to 80, unique ignoring case but for the organization itself) is the store's.
      const organizationId = id(pick(pos[0], json.id), 'organization');
      const organizationName = pick(opts.name, json.name);
      if (organizationName === undefined || organizationName === null) throw fail('missingOrganizationName');
      return { ...cmd, id: organizationId, organizationName };
    }
    if (name === 'org remove' || name === 'org hide' || name === 'org unhide') return { ...cmd, id: id(pick(pos[0], json.id), 'organization') };
    if (name === 'project move') return { ...cmd, id: id(pick(pos[0], json.id), 'project'), organization: id(pick(pos[1], json.organization), 'organization') };
    const fields = {
      ...cmd,
      id: id(pick(pos[0], json.id), 'project'),
      projectName: text(pick(opts.name, json.name), 'name'),
      organization: pick(opts.org, json.organization) === undefined ? undefined : id(pick(opts.org, json.organization), 'organization'),
      tracker: parseTracker(pick(opts.tracker, json.tracker)),
      repos: repos(listOf(opts.repo, json.repos)),
      stages: parseStages(pick(opts.stages, json.stages)),
      doneState: text(pick(opts['done-state'], json.done_state), 'done-state', { clearable: true }),
      workspace: text(pick(opts.workspace, json.maestri_workspace), 'workspace', { clearable: true }),
    };
    if (name === 'project edit') fields.removeRepos = repos(listOf(opts['remove-repo'], json.remove_repos)).map((r) => r.remote);
    return fields;
  }

  // ---------- commands ----------

  // key: unknownOrganization suggests registering it; organizationNotFound (an org subcommand: rename, remove, hide, unhide) only lists the organizations.
  const unknownOrganizationError = (store, organizationId, key = 'unknownOrganization') => fail(key, { organization: organizationId, known: store.organizations().map((x) => x.id).join(', ') || '-' });
  const unknownProjectError = (store, projectId) => fail('unknownProject', { project: projectId, known: store.projects().map((x) => x.id).join(', ') || '-' });

  function needOrganization(store, organizationId, key) {
    const o = store.organization(organizationId);
    if (!o) throw unknownOrganizationError(store, organizationId, key);
    return o;
  }

  function needProject(store, projectId) {
    const p = store.project(projectId);
    if (!p) throw unknownProjectError(store, projectId);
    return p;
  }

  /**
   * A rule of the store broken (RegisterError) → the InvalidData of exit 2, with the message of the code. An unknown
   * organization in an org subcommand (rename, remove, hide, unhide) lists the organizations without suggesting to register it.
   */
  function registerFailure(store, e, cmd) {
    const x = e.error;
    if (x.code === 'organization_not_found') return unknownOrganizationError(store, x.organization, cmd.name.startsWith('org ') ? 'organizationNotFound' : undefined);
    if (x.code === 'project_not_found') return unknownProjectError(store, x.project);
    return new InvalidData(`admin.codes.${x.code}`, x);
  }

  /** The new repositories must be free (or already this project's) and of the project's tracker. */
  function checkRepos(store, projectId, projectTracker, list) {
    for (const r of list) {
      const owner = store.repoOwner(r.remote);
      if (owner && owner !== projectId) throw fail('repoTaken', { remote: r.remote, project: owner });
      if (r.tracker !== projectTracker) throw fail('repoTracker', { remote: r.remote, repoTracker: t(`admin.trackers.${r.tracker}`), tracker: t(`admin.trackers.${projectTracker}`) });
    }
  }

  function describeProject(store, p) {
    return [
      t('admin.done.projectLine', {
        id: p.id, name: p.name, organization: p.organization_name, tracker: t(`admin.trackers.${p.tracker}`),
        stages: p.stages.join(', '), doneState: p.done_state, workspace: p.maestri_workspace,
      }),
      ...store.projectRepos(p.id).map((remote) => t('admin.done.repoLine', { remote })),
    ];
  }

  function organizationAdd(store, cmd, at) {
    const o = store.addOrganization({ id: cmd.id, name: cmd.organizationName, at });
    return [t('admin.done.organizationAdded', { organization: o.id, name: o.name })];
  }

  function organizationRename(store, cmd) {
    const o = store.renameOrganization(cmd.id, cmd.organizationName);
    return [t('admin.done.organizationRenamed', { organization: o.id, from: o.from, name: o.name })];
  }

  function organizationRemove(store, cmd) {
    const o = store.removeOrganization(cmd.id);
    return [t('admin.done.organizationRemoved', { organization: o.id, name: o.name })];
  }

  function organizationHide(store, cmd, at) {
    const hidden = cmd.name === 'org hide';
    const o = store.setOrganizationHidden(cmd.id, hidden, at);
    const key = hidden ? (o.changed ? 'organizationHidden' : 'organizationAlreadyHidden') : (o.changed ? 'organizationShown' : 'organizationAlreadyShown');
    return [t(`admin.done.${key}`, { organization: o.id, name: o.name })];
  }

  function projectAdd(store, cmd, at, cwd) {
    if (store.project(cmd.id)) throw fail('projectExists', { project: cmd.id });
    if (cmd.organization === undefined) throw fail('missingOrganization');
    store.projectOrganization(cmd.organization);
    let list = cmd.repos;
    if (!list.length) {
      const origin = originOf(cwd);
      if (!origin) throw fail('missingRepo');
      list = repos([origin]);
    }
    const projectTracker = cmd.tracker || list[0].tracker;
    checkRepos(store, cmd.id, projectTracker, list);
    store.addProject({
      id: cmd.id, name: cmd.projectName || cmd.id, organizationId: cmd.organization, tracker: projectTracker, stages: cmd.stages || STAGES,
      doneState: cmd.doneState || null, maestriWorkspace: cmd.workspace || null, at,
    });
    for (const r of list) store.addRepo(cmd.id, r.remote);
    return [t('admin.done.projectAdded', { project: cmd.id }), ...describeProject(store, store.project(cmd.id))];
  }

  function projectEdit(store, cmd) {
    const p = needProject(store, cmd.id);
    // The new organization first (the store's rule, as in project add), before the repositories.
    if (cmd.organization !== undefined) store.projectOrganization(cmd.organization);
    const projectTracker = cmd.tracker || p.tracker;
    const current = store.projectRepos(p.id);
    const remaining = current.filter((r) => !cmd.removeRepos.includes(r));
    for (const remote of cmd.removeRepos) if (!current.includes(remote)) throw fail('repoNotInProject', { remote, project: p.id });
    // Changing the tracker checks every repository that stays.
    checkRepos(store, p.id, projectTracker, [...remaining.map((remote) => ({ remote, tracker: describeRemote(remote).tracker })), ...cmd.repos]);
    if (!remaining.length && !cmd.repos.length) throw fail('lastRepo', { project: p.id });
    const change = { name: cmd.projectName, organizationId: cmd.organization, tracker: cmd.tracker, stages: cmd.stages, doneState: cmd.doneState, maestriWorkspace: cmd.workspace };
    if (Object.values(change).every((v) => v === undefined) && !cmd.repos.length && !cmd.removeRepos.length) throw fail('nothingToChange');
    store.updateProject(p.id, change);
    for (const remote of cmd.removeRepos) store.removeRepo(p.id, remote);
    for (const r of cmd.repos) store.addRepo(p.id, r.remote);
    return [t('admin.done.projectEdited', { project: p.id }), ...describeProject(store, store.project(p.id))];
  }

  function projectMove(store, cmd) {
    const p = needProject(store, cmd.id);
    const moved = store.moveProject(p.id, cmd.organization);
    return [t('admin.done.projectMoved', { project: p.id, from: p.organization_name, to: moved.organization_name })];
  }

  function listOrganizations(store) {
    const organizations = store.organizations();
    if (!organizations.length) return [t('admin.done.noOrganizations')];
    const projects = store.projects();
    return organizations.map((o) => t('admin.done.organizationLine', { id: o.id, name: o.name, count: projects.filter((p) => p.organization_id === o.id).length, hidden: o.hidden }));
  }

  function listProjects(store, cmd) {
    // A filter, not a register: an unknown organization only lists the organizations (no "Cadastre com", never for "Sem organização").
    if (cmd.organization) needOrganization(store, cmd.organization, 'organizationNotFound');
    const projects = store.projects().filter((p) => !cmd.organization || p.organization_id === cmd.organization);
    if (!projects.length) return [t('admin.done.noProjects')];
    return projects.flatMap((p) => describeProject(store, p));
  }

  /** Runs an org/project subcommand; prints its lines. */
  function run(argv, cwd) {
    const cmd = parse(argv);
    const at = lib.isoSP(lib.now());
    const store = openStore({ dir: flowDir() });
    try {
      const lines = store.transaction(() => {
        if (cmd.name === 'org list') return listOrganizations(store);
        if (cmd.name === 'project list') return listProjects(store, cmd);
        if (cmd.name === 'org add') return organizationAdd(store, cmd, at);
        if (cmd.name === 'org rename') return organizationRename(store, cmd);
        if (cmd.name === 'org remove') return organizationRemove(store, cmd);
        if (cmd.name === 'org hide' || cmd.name === 'org unhide') return organizationHide(store, cmd, at);
        if (cmd.name === 'project add') return projectAdd(store, cmd, at, cwd);
        if (cmd.name === 'project edit') return projectEdit(store, cmd);
        return projectMove(store, cmd);
      });
      for (const l of lines) lib.print(l);
    } catch (e) {
      throw e instanceof RegisterError ? registerFailure(store, e, cmd) : e;
    } finally {
      store.close();
    }
  }

  return { run };
}

module.exports = { createAdmin, isAdminCommand };
