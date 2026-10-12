'use strict';
// flow-host.js · the Host (#62): where the flow runs (a plain terminal, the Maestri or the Orca) and the three things the
// flow asks of it: posting the worker's status, telling the owner of a new pending decision and saying where the owner
// answers it. Each one is a function per Host; flow.js only records how it went (ADR 0002: the panel is the single
// record, the Host is only transport). Only detectHost reads the Host's variables.
//
//   detectHost(env)            → { kind: 'orca' | 'maestri' | 'none', mode, terminal, workspace, checks: { orca_terminal, maestri_terminal } }
//       Orca: ORCA_TERMINAL_HANDLE set (terminal; workspace: ORCA_WORKTREE_ID). Maestri: MAESTRI_TERMINAL_ID set
//       (terminal: MAESTRI_TERMINAL_NAME, else MAESTRI_TERMINAL_ID; workspace: MAESTRI_WORKSPACE_ID, else
//       MAESTRI_WORKSPACE_NAME). With both, the Orca wins. A blank variable counts as absent. mode: the dispatch mode
//       of the Host (orca → orca, maestri → maestri, none → subagents).
//   hostReport(env)            → detectHost + checks.orca_status: "orca status --json" in an Orca terminal
//                                ({ ok, detail }: ok only with the runtime "ready"), null elsewhere. Never throws.
//   postStatus(host, cmd, env) → null outside (kind none) | { ok } | { ok: false, detail }
//       Maestri: "maestri floor status <text> --state <state> [--progress n/m]".
//       Orca: "orca worktree set --worktree current --workspace-status <id> --comment <text[ (n/m)]> [--unread] --json"
//             (working, blocked → in-progress, blocked also --unread; review, done → in-review).
//   notifyOwner(host, notice, env) → null outside | { ok } | { ok: false, detail }
//       notice: { severity, kind, key, ref, task, title } of the new pending decision.
//       Maestri: "maestri notify <text>" (the text from the notice, cut to MAX_NOTIFICATION; built only here).
//       Orca: "orca worktree set --worktree current --unread --json" (the maestro's worktree turns unread in the
//       Orca's sidebar).
//   answerIn(host, given, projectWorkspace) → { kind, workspace, terminal }: where the owner answers a pending decision.
//       given ({ workspace, terminal }, the arguments) wins, then the Host's terminal and workspace; the project's Maestri
//       workspace fills the workspace in the Maestri and in a plain terminal (never in the Orca: a Maestri workspace is
//       no worktree of it). The values are not checked here (flow.js does).
//
// Executables: FLOW_MAESTRI_CLI, else MAESTRI_CLI, else "maestri"; FLOW_ORCA_CLI, else "orca". A .js path runs with
// node. Both wait at most HOST_TIMEOUT_MS. A call fails when it cannot start, exits with a code other than 0 or, for the
// Orca (always with --json), answers { ok: false }.
const { spawnSync } = require('child_process');
const { t } = require('./i18n');

const HOST_TIMEOUT_MS = 15000;
const MAX_NOTIFICATION = 500; // the longest text of "maestri notify" (#44)
// The board column of the worktree in the Orca for each state of flow status.
const ORCA_STATUS = { working: 'in-progress', blocked: 'in-progress', review: 'in-review', done: 'in-review' };
const MODE_OF = { orca: 'orca', maestri: 'maestri', none: 'subagents' };

const value = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const first = (...values) => values.find((v) => v !== undefined && v !== null && v !== '') || null;

function detectHost(env = process.env) {
  const orca = value(env.ORCA_TERMINAL_HANDLE);
  const maestri = value(env.MAESTRI_TERMINAL_ID);
  const checks = { orca_terminal: !!orca, maestri_terminal: !!maestri };
  const host = (kind, terminal, workspace) => ({ kind, mode: MODE_OF[kind], terminal, workspace, checks });
  if (orca) return host('orca', orca, value(env.ORCA_WORKTREE_ID));
  if (maestri) return host('maestri', value(env.MAESTRI_TERMINAL_NAME) || maestri, value(env.MAESTRI_WORKSPACE_ID) || value(env.MAESTRI_WORKSPACE_NAME));
  return host('none', null, null);
}

/** Runs an executable (a .js path with node): { ok, stdout } or { ok: false, detail }. */
function run(cli, args, notFoundKey) {
  const js = /\.[cm]?js$/i.test(cli);
  const r = spawnSync(js ? process.execPath : cli, js ? [cli, ...args] : args, {
    encoding: 'utf8', windowsHide: true, timeout: HOST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { ok: false, detail: r.error.code === 'ENOENT' ? t(notFoundKey, { cli }) : r.error.message };
  if (r.status !== 0) return { ok: false, detail: String(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] || `exit ${r.status}` };
  return { ok: true, stdout: String(r.stdout || '') };
}

const runMaestri = (args, env) => run(env.FLOW_MAESTRI_CLI || env.MAESTRI_CLI || 'maestri', args, 'errors.maestriNotFound');

/** The orca with --json: { ok, json } or { ok: false, detail } (an answer { ok: false } is a failure too). */
function runOrca(args, env) {
  const r = run(env.FLOW_ORCA_CLI || 'orca', [...args, '--json'], 'errors.orcaNotFound');
  if (!r.ok) return r;
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (_) { /* not JSON: exit 0 is enough */ }
  if (json && json.ok === false) {
    const error = json.error;
    const detail = (error && typeof error === 'object' ? error.message || error.code : error) || 'ok: false';
    return { ok: false, detail: String(detail).split(/\r?\n/)[0] };
  }
  return { ok: true, json };
}

/** What postStatus and notifyOwner answer: null outside, { ok } or { ok: false, detail }. */
const outcome = (r) => (!r ? null : r.ok ? { ok: true } : { ok: false, detail: r.detail });

/** "orca status --json": { ok, detail } — ok only when it answers with the runtime "ready". */
function orcaStatus(env) {
  const r = runOrca(['status'], env);
  if (!r.ok) return { ok: false, detail: r.detail };
  const runtime = r.json && r.json.result && r.json.result.runtime;
  if (!runtime || runtime.state !== 'ready') return { ok: false, detail: t('host.orcaNotReady', { state: (runtime && runtime.state) || '-' }) };
  return { ok: true, detail: null };
}

function hostReport(env = process.env) {
  const host = detectHost(env);
  return { ...host, checks: { ...host.checks, orca_status: host.checks.orca_terminal ? orcaStatus(env) : null } };
}

function postStatus(host, cmd, env = process.env) {
  const progress = cmd.progress ? `${cmd.progress.done}/${cmd.progress.total}` : null;
  if (host.kind === 'maestri') {
    const args = ['floor', 'status', cmd.text, '--state', cmd.state];
    if (progress) args.push('--progress', progress);
    return outcome(runMaestri(args, env));
  }
  if (host.kind === 'orca') {
    const comment = progress ? `${cmd.text} (${progress})` : cmd.text;
    const args = ['worktree', 'set', '--worktree', 'current', '--workspace-status', ORCA_STATUS[cmd.state], '--comment', comment];
    if (cmd.state === 'blocked') args.push('--unread');
    return outcome(runOrca(args, env));
  }
  return null;
}

/** The text of "maestri notify": the severity, kind, item, task and title of the pending decision, cut to MAX_NOTIFICATION. */
function notificationText(notice) {
  const text = t('pending.notify.message', notice);
  if (text.length <= MAX_NOTIFICATION) return text;
  return `${text.slice(0, MAX_NOTIFICATION - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

function notifyOwner(host, notice, env = process.env) {
  if (host.kind === 'maestri') return outcome(runMaestri(['notify', notificationText(notice)], env));
  if (host.kind === 'orca') return outcome(runOrca(['worktree', 'set', '--worktree', 'current', '--unread'], env));
  return null;
}

function answerIn(host, given, projectWorkspace) {
  const kind = host.kind;
  const own = kind === 'none' ? {} : host;
  return {
    kind,
    workspace: first(given.workspace, own.workspace, kind === 'orca' ? null : projectWorkspace),
    terminal: first(given.terminal, own.terminal),
  };
}

module.exports = { HOST_TIMEOUT_MS, MAX_NOTIFICATION, ORCA_STATUS, detectHost, hostReport, postStatus, notifyOwner, answerIn };
