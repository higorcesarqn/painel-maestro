'use strict';
// flow-admin.js · the "company" and "project" subcommands of bin/flow.js (#6): the owner's register of companies and
// projects in maestro.db. Unlike the flow commands they do not need to run inside a repository (project add without
// --repo uses the current folder's remote).
//
//   flow company list
//   flow company add <id> --name "<name>"
//   flow project list [--company <id>]
//   flow project add <id> --company <id> [--name "..."] [--tracker github|azure_devops] [--repo <url>]...
//                    [--stages a,b,...] [--done-state "<state>"] [--workspace "<Maestri workspace>"]
//   flow project edit <id> [--name] [--company] [--tracker] [--repo <url>]... [--remove-repo <url>]... [--stages]
//                    [--done-state] [--workspace]          (an empty --done-state/--workspace clears it)
//   flow project move <id> <company>
//
// A project may have many repositories (an Azure DevOps project usually does): each one is a remote URL, kept
// normalized (flow-repo.js), so the flow commands run in any of them resolve the same project. "Pessoal" is a
// company like the others; "unassigned" (Sem empresa) is where unregistered repositories land.
// Invalid data throws helpers.InvalidData (exit 2); the messages come from the pt-BR dictionary (admin.*).
const lib = require('./lib');
const { t } = require('./i18n');
const { openStore, flowDir, STAGES, TRACKERS } = require('./flow-store');
const { originOf, describeRemote } = require('./flow-repo');

const RE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_NAME = 120;
const MAX_REPOS = 50;

const OPTIONS = {
  'company add': ['name', 'json'],
  'company list': [],
  'project list': ['company'],
  'project add': ['name', 'company', 'tracker', 'repo', 'stages', 'done-state', 'workspace', 'json'],
  'project edit': ['name', 'company', 'tracker', 'repo', 'remove-repo', 'stages', 'done-state', 'workspace', 'json'],
  'project move': ['json'],
};
const POSITIONAL = { 'company add': 1, 'company list': 0, 'project list': 0, 'project add': 1, 'project edit': 1, 'project move': 2 };
const REPEATABLE = ['repo', 'remove-repo'];

const isAdminCommand = (argv) => argv[0] === 'company' || argv[0] === 'project';

function createAdmin({ InvalidData, parseArgs, readJson, pick }) {
  const fail = (key, params) => new InvalidData(`admin.errors.${key}`, params);

  function id(value, kind) {
    if (value === undefined || value === null || String(value).trim() === '') throw fail(kind === 'company' ? 'missingCompanyId' : 'missingProjectId');
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

  function tracker(value) {
    if (value === undefined || value === null) return undefined;
    const s = String(value).trim().toLowerCase().replace(/-/g, '_');
    if (!TRACKERS.includes(s)) throw fail('invalidTracker', { value, allowed: TRACKERS.join(', ') });
    return s;
  }

  /** "a,b" or ["a","b"] → the stages in the canonical order; undefined when absent. */
  function stages(value) {
    if (value === undefined || value === null) return undefined;
    const list = Array.isArray(value) ? value : String(value).split(',');
    const ids = list.map((s) => String(s).trim().toLowerCase().replace(/-/g, '_')).filter(Boolean);
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
    if (name === 'company list') return cmd;
    if (name === 'project list') return { ...cmd, company: opts.company === undefined ? null : id(opts.company, 'company') };
    if (name === 'company add') {
      const companyName = text(pick(opts.name, json.name), 'name');
      if (!companyName) throw fail('missingCompanyName');
      return { ...cmd, id: id(pick(pos[0], json.id), 'company'), companyName };
    }
    if (name === 'project move') return { ...cmd, id: id(pick(pos[0], json.id), 'project'), company: id(pick(pos[1], json.company), 'company') };
    const fields = {
      ...cmd,
      id: id(pick(pos[0], json.id), 'project'),
      projectName: text(pick(opts.name, json.name), 'name'),
      company: pick(opts.company, json.company) === undefined ? undefined : id(pick(opts.company, json.company), 'company'),
      tracker: tracker(pick(opts.tracker, json.tracker)),
      repos: repos(listOf(opts.repo, json.repos)),
      stages: stages(pick(opts.stages, json.stages)),
      doneState: text(pick(opts['done-state'], json.done_state), 'done-state', { clearable: true }),
      workspace: text(pick(opts.workspace, json.maestri_workspace), 'workspace', { clearable: true }),
    };
    if (name === 'project edit') fields.removeRepos = repos(listOf(opts['remove-repo'], json.remove_repos)).map((r) => r.remote);
    return fields;
  }

  // ---------- commands ----------

  function needCompany(store, companyId) {
    const c = store.company(companyId);
    if (!c) throw fail('unknownCompany', { company: companyId, known: store.companies().map((x) => x.id).join(', ') || '-' });
    return c;
  }

  function needProject(store, projectId) {
    const p = store.project(projectId);
    if (!p) throw fail('unknownProject', { project: projectId, known: store.projects().map((x) => x.id).join(', ') || '-' });
    return p;
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
        id: p.id, name: p.name, company: p.company_name, tracker: t(`admin.trackers.${p.tracker}`),
        stages: p.stages.join(', '), doneState: p.done_state, workspace: p.maestri_workspace,
      }),
      ...store.projectRepos(p.id).map((remote) => t('admin.done.repoLine', { remote })),
    ];
  }

  function companyAdd(store, cmd, at) {
    if (store.company(cmd.id)) throw fail('companyExists', { company: cmd.id, name: store.company(cmd.id).name });
    store.addCompany({ id: cmd.id, name: cmd.companyName, at });
    return [t('admin.done.companyAdded', { company: cmd.id, name: cmd.companyName })];
  }

  function projectAdd(store, cmd, at, cwd) {
    if (store.project(cmd.id)) throw fail('projectExists', { project: cmd.id });
    if (cmd.company === undefined) throw fail('missingCompany');
    needCompany(store, cmd.company);
    let list = cmd.repos;
    if (!list.length) {
      const origin = originOf(cwd);
      if (!origin) throw fail('missingRepo');
      list = repos([origin]);
    }
    const projectTracker = cmd.tracker || list[0].tracker;
    checkRepos(store, cmd.id, projectTracker, list);
    store.addProject({
      id: cmd.id, name: cmd.projectName || cmd.id, companyId: cmd.company, tracker: projectTracker, stages: cmd.stages || STAGES,
      doneState: cmd.doneState || null, maestriWorkspace: cmd.workspace || null, at,
    });
    for (const r of list) store.addRepo(cmd.id, r.remote);
    return [t('admin.done.projectAdded', { project: cmd.id }), ...describeProject(store, store.project(cmd.id))];
  }

  function projectEdit(store, cmd) {
    const p = needProject(store, cmd.id);
    if (cmd.company !== undefined) needCompany(store, cmd.company);
    const projectTracker = cmd.tracker || p.tracker;
    const current = store.projectRepos(p.id);
    const remaining = current.filter((r) => !cmd.removeRepos.includes(r));
    for (const remote of cmd.removeRepos) if (!current.includes(remote)) throw fail('repoNotInProject', { remote, project: p.id });
    // Changing the tracker checks every repository that stays.
    checkRepos(store, p.id, projectTracker, [...remaining.map((remote) => ({ remote, tracker: describeRemote(remote).tracker })), ...cmd.repos]);
    if (!remaining.length && !cmd.repos.length) throw fail('lastRepo', { project: p.id });
    const change = { name: cmd.projectName, companyId: cmd.company, tracker: cmd.tracker, stages: cmd.stages, doneState: cmd.doneState, maestriWorkspace: cmd.workspace };
    if (Object.values(change).every((v) => v === undefined) && !cmd.repos.length && !cmd.removeRepos.length) throw fail('nothingToChange');
    store.updateProject(p.id, change);
    for (const remote of cmd.removeRepos) store.removeRepo(p.id, remote);
    for (const r of cmd.repos) store.addRepo(p.id, r.remote);
    return [t('admin.done.projectEdited', { project: p.id }), ...describeProject(store, store.project(p.id))];
  }

  function projectMove(store, cmd) {
    const p = needProject(store, cmd.id);
    const c = needCompany(store, cmd.company);
    store.updateProject(p.id, { companyId: c.id });
    return [t('admin.done.projectMoved', { project: p.id, from: p.company_name, to: c.name })];
  }

  function listCompanies(store) {
    const companies = store.companies();
    if (!companies.length) return [t('admin.done.noCompanies')];
    const projects = store.projects();
    return companies.map((c) => t('admin.done.companyLine', { id: c.id, name: c.name, count: projects.filter((p) => p.company_id === c.id).length }));
  }

  function listProjects(store, cmd) {
    if (cmd.company) needCompany(store, cmd.company);
    const projects = store.projects().filter((p) => !cmd.company || p.company_id === cmd.company);
    if (!projects.length) return [t('admin.done.noProjects')];
    return projects.flatMap((p) => describeProject(store, p));
  }

  /** Runs a company/project subcommand; prints its lines. */
  function run(argv, cwd) {
    const cmd = parse(argv);
    const at = lib.isoSP(lib.now());
    const store = openStore({ dir: flowDir() });
    try {
      const lines = store.transaction(() => {
        if (cmd.name === 'company list') return listCompanies(store);
        if (cmd.name === 'project list') return listProjects(store, cmd);
        if (cmd.name === 'company add') return companyAdd(store, cmd, at);
        if (cmd.name === 'project add') return projectAdd(store, cmd, at, cwd);
        if (cmd.name === 'project edit') return projectEdit(store, cmd);
        return projectMove(store, cmd);
      });
      for (const l of lines) lib.print(l);
    } finally {
      store.close();
    }
  }

  return { run };
}

module.exports = { createAdmin, isAdminCommand };
