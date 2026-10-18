'use strict';
// merge-check.js · the merge check (#11): the only exception of ADR 0001. The PR merge usually happens in the
// tracker with no agent around, so from time to time the server reads the PR of the items whose PR is ready and
// not merged (pr.state = 'ready'), read only:
//   GitHub        gh pr view <url> --json state,mergedAt               (merged: state MERGED or mergedAt)
//   Azure DevOps  GET <base>/<org>/<project>/_apis/git/repositories/<repo>/pullrequests/<id>?api-version=7.1
//                 with the token of `az account get-access-token --resource 499b84ac-…` (merged: status completed)
// A confirmed merge is recorded as pr-changed { state: 'merged' } with source "panel" (the projection moves the
// item to Merge). A failure never stops the server: it becomes a code on the item page (merge_check.error) and in
// the health badge (merge_check_failed). The "mark as merged" button (POST /api/items/<project>/<number>/merged)
// records the same event by hand, as the owner.
//
// Variables:
//   PANEL_MERGE_CHECK=0|1          off / on. Without it: on when the usage collector is on (PANEL_COLLECTOR≠0) and
//                                  the clock is real (no PANEL_NOW), so test and demo servers never call gh or az.
//   PANEL_MERGE_CHECK_SECONDS      interval between checks (default 600; the first one runs at startup)
//   PANEL_GH_CLI, PANEL_AZ_CLI     executables of gh and az (default "gh" and "az"; a .js path runs with node)
//   PANEL_AZURE_DEVOPS_URL         base of the Azure DevOps REST API (default https://dev.azure.com; tests point
//                                  it to a local fake server)
const path = require('path');
const { spawn } = require('child_process');

const { isoSP, InvalidData } = require(path.join(__dirname, '..', 'bin', 'lib.js'));
const { t } = require(path.join(__dirname, '..', 'bin', 'i18n'));
const { projectItem, trackerRef, EVENT_TYPES } = require(path.join(__dirname, '..', 'bin', 'flow-projection.js'));
const { SchemaTooNew } = require(path.join(__dirname, '..', 'bin', 'flow-store.js'));
const { hiddenOrganizations } = require(path.join(__dirname, 'api-items.js'));

const DEFAULT_SECONDS = 600;
const CONCURRENCY = 4; // PRs read at once in a round (each read may take up to CLI_TIMEOUT_MS)
const CLI_TIMEOUT_MS = 30000;
const HTTP_TIMEOUT_MS = 20000;
const OUTPUT_LIMIT = 1024 * 1024;
const AZURE_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const SOURCE = 'panel';
const RE_GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,8})(?:[/?#]|$)/;
const RE_AZURE = /^https:\/\/dev\.azure\.com\/([^/?#]+)\/(?:([^/?#]+)\/)?_git\/([^/?#]+)\/pullrequest\/([1-9]\d{0,8})(?:[/?#]|$)/i;
const RE_VSTS = /^https:\/\/([a-z0-9][a-z0-9-]{0,61})\.visualstudio\.com\/(?:DefaultCollection\/)?(?:([^/?#]+)\/)?_git\/([^/?#]+)\/pullrequest\/([1-9]\d{0,8})(?:[/?#]|$)/i;
const RE_SEGMENT = /^[A-Za-z0-9._~%-]{1,200}$/;
// Arguments that may go through the Windows shell (az is az.cmd there): no character the shell interprets.
const RE_SAFE_ARG = /^[A-Za-z0-9._:/,=@-]+$/;

/** Configuration of the check from the variables; throws InvalidData (exit 2 with the dictionary's message) when invalid. */
function parseConfig(env, { collectorActive, fixedNow }) {
  const flag = env.PANEL_MERGE_CHECK;
  if (flag !== undefined && flag !== '' && flag !== '0' && flag !== '1') throw new InvalidData('server.errors.invalidMergeCheck', { value: flag });
  const secondsText = env.PANEL_MERGE_CHECK_SECONDS;
  const seconds = secondsText === undefined || secondsText === '' ? DEFAULT_SECONDS : Number(secondsText);
  if (!Number.isInteger(seconds) || seconds < 1) throw new InvalidData('server.errors.invalidMergeCheckSeconds', { value: secondsText });
  let enabled = true;
  let reason = null;
  if (flag === '0') { enabled = false; reason = { code: 'merge_check_off', variable: 'PANEL_MERGE_CHECK' }; }
  else if (flag !== '1' && !collectorActive) { enabled = false; reason = { code: 'merge_check_off', variable: 'PANEL_COLLECTOR' }; }
  else if (flag !== '1' && fixedNow) { enabled = false; reason = { code: 'merge_check_fixed_clock' }; }
  return {
    enabled,
    reason,
    intervalMs: seconds * 1000,
    ghCli: env.PANEL_GH_CLI || 'gh',
    azCli: env.PANEL_AZ_CLI || 'az',
    azureBase: String(env.PANEL_AZURE_DEVOPS_URL || 'https://dev.azure.com').replace(/\/+$/, ''),
  };
}

// ---------- reading the PR ----------

const ABORTED = Object.freeze({ code: 'merge_check_stopped' });

/** Runs an executable: { exit, stdout, stderr } or { error: code }. A .js path runs with node; signal kills it. */
function runCli(tool, cli, args, env, signal) {
  const js = /\.[cm]?js$/i.test(cli);
  const once = (shell) => new Promise((resolve) => {
    let child;
    try {
      child = spawn(js ? process.execPath : cli, js ? [cli, ...args] : args, { env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ spawnError: e });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    const keep = (list) => (c) => { size += c.length; if (size <= OUTPUT_LIMIT) list.push(c); };
    child.stdout.on('data', keep(out));
    child.stderr.on('data', keep(err));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, CLI_TIMEOUT_MS);
    const abort = () => child.kill();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    };
    child.on('error', (e) => { done(); resolve({ spawnError: e }); });
    child.on('close', (code) => {
      done();
      if (signal && signal.aborted) resolve({ error: ABORTED });
      else if (timedOut) resolve({ error: { code: 'merge_check_timeout', tool, seconds: CLI_TIMEOUT_MS / 1000 } });
      else resolve({ exit: code, shell, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
  if (signal && signal.aborted) return Promise.resolve({ error: ABORTED });
  return once(false).then((r) => {
    // On Windows az is az.cmd, which only runs through the shell: retried there when every argument is plain.
    if (r.spawnError && r.spawnError.code === 'ENOENT' && process.platform === 'win32' && !js && [cli, ...args].every((a) => RE_SAFE_ARG.test(a))) return once(true);
    return r;
  }).then((r) => {
    if (r.spawnError) {
      return { error: r.spawnError.code === 'ENOENT' ? { code: 'merge_check_cli_missing', tool, cli } : { code: 'merge_check_cli_failed', tool, exit: null, detail: firstLine(r.spawnError.message) } };
    }
    if (r.error) return r;
    if (r.exit !== 0 && r.shell && /not recognized|não é reconhecido/i.test(r.stderr)) return { error: { code: 'merge_check_cli_missing', tool, cli } };
    if (r.exit !== 0) return { error: { code: 'merge_check_cli_failed', tool, exit: r.exit, detail: firstLine(r.stderr || r.stdout) } };
    return r;
  });
}

const firstLine = (s) => String(s || '').trim().split(/\r?\n/)[0].slice(0, 300) || null;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
}

/** gh pr view <url> --json state,mergedAt → { merged } or { error }. */
async function readGithub(config, env, url, signal) {
  const m = RE_GITHUB.exec(url);
  if (!m) return { error: { code: 'merge_check_bad_url' } };
  const canonical = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
  const r = await runCli('gh', config.ghCli, ['pr', 'view', canonical, '--json', 'state,mergedAt'], env, signal);
  if (r.error) return r;
  const answer = parseJson(r.stdout);
  if (!answer || typeof answer !== 'object' || typeof answer.state !== 'string') return { error: { code: 'merge_check_bad_answer', tool: 'gh' } };
  return { merged: answer.state.toUpperCase() === 'MERGED' || !!answer.mergedAt };
}

/** The parts of an Azure DevOps PR URL: { org, project, repo, id } or null. */
function azurePr(url) {
  const m = RE_AZURE.exec(url) || RE_VSTS.exec(url);
  if (!m) return null;
  const pr = { org: m[1], project: m[2] || m[3], repo: m[3], id: m[4] };
  return [pr.org, pr.project, pr.repo].every((s) => RE_SEGMENT.test(s)) ? pr : null;
}

/** REST of the PR with the az token (read once per round, shared by the reads running at once) → { merged } or { error }. */
async function readAzure(config, env, url, round) {
  const pr = azurePr(url);
  if (!pr) return { error: { code: 'merge_check_bad_url' } };
  if (!round.token) {
    round.token = runCli('az', config.azCli, ['account', 'get-access-token', '--resource', AZURE_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], env, round.signal)
      .then((r) => (r.error ? r : r.stdout.trim() ? { token: r.stdout.trim() } : { error: { code: 'merge_check_bad_answer', tool: 'az' } }));
  }
  const token = await round.token;
  if (token.error) return token;
  const address = `${config.azureBase}/${pr.org}/${pr.project}/_apis/git/repositories/${pr.repo}/pullrequests/${pr.id}?api-version=7.1`;
  let res;
  try {
    res = await fetch(address, { headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' }, signal: AbortSignal.any([round.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]), redirect: 'manual' });
  } catch (e) {
    if (round.signal.aborted) return { error: ABORTED };
    return { error: { code: 'merge_check_request_failed', detail: firstLine(e && e.cause && e.cause.code ? e.cause.code : e && e.name === 'TimeoutError' ? 'timeout' : e && e.message) } };
  }
  if (res.status !== 200) return { error: { code: 'merge_check_http_failed', status: res.status } };
  const answer = parseJson(await res.text());
  if (!answer || typeof answer !== 'object' || typeof answer.status !== 'string') return { error: { code: 'merge_check_bad_answer', tool: 'azure_devops' } };
  return { merged: answer.status === 'completed' };
}

/** round: { signal (stops every read), token (the az token's promise, set by the first Azure read) }. */
function readPr(config, env, url, round) {
  if (typeof url !== 'string' || !url) return Promise.resolve({ error: { code: 'merge_check_no_url' } });
  if (url.startsWith('https://github.com/')) return readGithub(config, env, url, round.signal);
  return readAzure(config, env, url, round);
}

// ---------- the check ----------

// A concluded item (#68) is left alone: a merge recorded afterwards would bring it back to the active list.
const waitsForMerge = (state) => !!(state && state.active && state.pr && state.pr.state === 'ready');

/**
 * The server's merge check. options: { config (parseConfig), env, items (api-items source), now, log, logError }.
 * Returns { start, stop, run, itemStatus, healthReasons, markMerged }.
 */
function createMergeCheck({ config, env, items, now, log = () => {}, logError = () => {} }) {
  const childEnv = Object.assign({}, process.env, env);
  const statuses = new Map(); // "<project>/<number>" → { checked_at, error }
  let timer = null;
  let current = null;
  let stopping = null; // AbortController of the running round: stop() kills its reads

  /** Items waiting for the merge: [{ key, project, state }]. */
  function waiting(store) {
    const list = [];
    for (const { key, project, state } of store.projectedItems().values()) {
      if (waitsForMerge(state)) list.push({ key, project, state });
    }
    return list;
  }

  /** Appends pr-changed merged when the item still waits for it (in a transaction): { recorded, state }. */
  function recordMerge(store, project, number, agentRole) {
    return store.transaction(() => {
      const state = projectItem(store.itemEvents(project.id, number), project);
      if (!waitsForMerge(state)) return { recorded: false, state };
      store.appendEvent({ at: isoSP(now()), type: EVENT_TYPES.prChanged, projectId: project.id, itemNumber: number, agentRole, source: SOURCE, payload: { state: 'merged' } });
      return { recorded: true, state };
    });
  }

  /** Reads one item's PR and keeps the outcome (records the merge when confirmed). */
  async function check(store, { key, project, state }, shared) {
    const r = await readPr(config, childEnv, state.pr.url, shared);
    if (shared.signal.aborted) return; // stopping: the outcome of a killed read is not kept
    const checkedAt = isoSP(now());
    const before = statuses.get(key);
    if (r.error) {
      statuses.set(key, { checked_at: checkedAt, error: r.error });
      if (!before || !before.error || before.error.code !== r.error.code) logError(t('server.log.mergeCheckItemFailed', { key, code: r.error.code, detail: r.error.detail ? ` (${r.error.detail})` : '' }));
      return;
    }
    statuses.set(key, { checked_at: checkedAt, error: null });
    if (r.merged && recordMerge(store, project, state.number, null).recorded) {
      statuses.delete(key);
      log(t('server.log.mergeRecorded', { key }));
    }
  }

  /** One round: the PRs waiting for a merge, CONCURRENCY at a time. */
  async function round(controller) {
    let store;
    try {
      store = items.store();
    } catch (e) {
      // A maestro.db of a newer painel-maestro (#28) is the health badge's own reason: the round waits for the code.
      if (e instanceof SchemaTooNew) return;
      throw e;
    }
    if (!store) return;
    const list = waiting(store);
    const keys = new Set(list.map((x) => x.key));
    for (const k of [...statuses.keys()]) if (!keys.has(k)) statuses.delete(k);
    const shared = { signal: controller.signal, token: null };
    let next = 0;
    const worker = async () => {
      while (!controller.signal.aborted && next < list.length) await check(store, list[next++], shared);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  }

  /** Runs one round; a call during a round waits for the same round. Never rejects. */
  function run() {
    if (current) return current;
    const controller = new AbortController();
    stopping = controller;
    current = round(controller).catch((e) => logError(t('server.log.mergeCheckFailed', { detail: e && e.stack ? e.stack : e }))).finally(() => { current = null; });
    return current;
  }

  return {
    start() {
      if (!config.enabled || timer) return;
      run();
      timer = setInterval(run, config.intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    /** Stops the timer and kills the reads of a running round (never waits for the tracker). */
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (stopping) stopping.abort();
      if (current) await current;
    },
    run,
    /** The merge_check field of an item page: null when the item does not wait for a merge. */
    itemStatus(key, state) {
      if (!waitsForMerge(state)) return null;
      if (!config.enabled) return { enabled: false, reason: config.reason, checked_at: null, error: null };
      const s = statuses.get(key);
      return { enabled: true, reason: null, checked_at: s ? s.checked_at : null, error: s ? s.error : null };
    },
    /**
     * Health reasons: one merge_check_failed per item whose last check failed, but those of a hidden organization (#52):
     * the health popover never names its items. Their PRs are still checked, and their page still shows the failure.
     */
    healthReasons() {
      const reasons = [];
      let store;
      let hidden = new Set();
      for (const [key, s] of statuses) {
        if (!s.error) continue;
        // An unreadable maestro.db is the health's own reason (database_unreadable, #14): never throws from here.
        if (store === undefined) {
          try {
            store = items.store();
            if (store) hidden = hiddenOrganizations(store);
          } catch (_) { store = null; }
        }
        const [projectId, number] = key.split('/');
        const project = store && store.project(projectId);
        if (project && hidden.has(project.organization_id)) continue;
        reasons.push({ code: 'merge_check_failed', item: key, tracker_ref: trackerRef(project ? project.tracker : 'github', Number(number)), error: s.error });
      }
      return reasons;
    },
    /** The "mark as merged" button: { status: 200 } or { status, error }. */
    markMerged(projectId, number) {
      const store = items.store();
      const project = store && store.project(projectId);
      if (!project) return { status: 404, error: { code: 'item_not_found', project: projectId, number } };
      const x = recordMerge(store, project, number, 'owner');
      if (!x.state) return { status: 404, error: { code: 'item_not_found', project: projectId, number } };
      if (!x.recorded && !x.state.active) return { status: 409, error: { code: 'item_not_active', project: projectId, number } };
      if (!x.recorded) return { status: 409, error: { code: 'pr_not_ready', project: projectId, number, state: x.state.pr ? x.state.pr.state : null } };
      statuses.delete(`${projectId}/${number}`);
      log(t('server.log.markedMerged', { key: `${projectId}/${number}` }));
      return { status: 200 };
    },
  };
}

module.exports = { parseConfig, createMergeCheck, azurePr };
