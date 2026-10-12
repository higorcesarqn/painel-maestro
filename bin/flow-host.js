'use strict';
// flow-host.js · the Host (#62): where the flow runs (a plain terminal, the Maestri or the Orca) and the two things the
// flow asks of it: posting the worker's status and telling the owner of a new pending decision. Each one is a function
// per Host; flow.js only records how it went (ADR 0002: the panel is the single record, the Host is only transport).
//
//   detectHost(env)            → { kind: 'orca' | 'maestri' | 'none', terminal, workspace, checks: { orca_terminal, maestri_terminal } }
//       Orca: ORCA_TERMINAL_HANDLE set (terminal; workspace: ORCA_WORKTREE_ID). Maestri: MAESTRI_TERMINAL_ID set
//       (terminal; workspace: MAESTRI_WORKSPACE_ID, else MAESTRI_WORKSPACE_NAME). With both, the Orca wins. A blank
//       variable counts as absent.
//   hostReport(env)            → detectHost + checks.orca_status: "orca status --json" in an Orca terminal
//                                ({ ok, detail }), null elsewhere. Never throws.
//   postStatus(host, cmd, env) → null outside (kind none) | { ok } | { ok: false, detail }
//       Maestri: "maestri floor status <text> --state <state> [--progress n/m]".
//       Orca: "orca worktree set --worktree current --workspace-status <id> --comment <text[ (n/m)]> [--unread] --json"
//             (working, blocked → in-progress, blocked also --unread; review, done → in-review).
//   notifyOwner(host, text, env) → null outside | { ok } | { ok: false, detail }
//       Maestri: "maestri notify <text>". Orca: "orca worktree set --worktree current --unread --json" (the maestro's
//       worktree turns unread in the Orca's sidebar).
//   modeOf(host)               → the dispatch mode of a Host: orca → orca, maestri → maestri, none → subagents.
//
// Executables: FLOW_MAESTRI_CLI, else MAESTRI_CLI, else "maestri"; FLOW_ORCA_CLI, else "orca". A .js path runs with
// node. Both wait at most HOST_TIMEOUT_MS. A call fails when it cannot start, exits with a code other than 0 or, for the
// Orca (always with --json), answers { ok: false }.
const { spawnSync } = require('child_process');
const { t } = require('./i18n');
const { HOST_KINDS, DISPATCH_MODES } = require('./flow-projection');

const HOST_TIMEOUT_MS = 15000;
// The board column of the worktree in the Orca for each state of flow status.
const ORCA_STATUS = { working: 'in-progress', blocked: 'in-progress', review: 'in-review', done: 'in-review' };

const value = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function detectHost(env = process.env) {
  const orca = value(env.ORCA_TERMINAL_HANDLE);
  const maestri = value(env.MAESTRI_TERMINAL_ID);
  const checks = { orca_terminal: !!orca, maestri_terminal: !!maestri };
  if (orca) return { kind: 'orca', terminal: orca, workspace: value(env.ORCA_WORKTREE_ID), checks };
  if (maestri) return { kind: 'maestri', terminal: maestri, workspace: value(env.MAESTRI_WORKSPACE_ID) || value(env.MAESTRI_WORKSPACE_NAME), checks };
  return { kind: 'none', terminal: null, workspace: null, checks };
}

const modeOf = (host) => (host.kind === 'none' ? 'subagents' : host.kind);

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

function runMaestri(args, env = process.env) {
  const r = run(env.FLOW_MAESTRI_CLI || env.MAESTRI_CLI || 'maestri', args, 'errors.maestriNotFound');
  return r.ok ? { ok: true } : r;
}

/** The orca with --json: { ok, json } or { ok: false, detail } (an answer { ok: false } is a failure too). */
function runOrca(args, env = process.env) {
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

/** "orca status --json": { ok, detail } — ok when it answers and its runtime is reachable. */
function orcaStatus(env) {
  const r = runOrca(['status'], env);
  if (!r.ok) return { ok: false, detail: r.detail };
  const runtime = r.json && r.json.result && r.json.result.runtime;
  if (runtime && runtime.reachable === false) return { ok: false, detail: t('host.orcaUnreachable', { state: runtime.state || '-' }) };
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
    return runMaestri(args, env);
  }
  if (host.kind === 'orca') {
    const comment = progress ? `${cmd.text} (${progress})` : cmd.text;
    const args = ['worktree', 'set', '--worktree', 'current', '--workspace-status', ORCA_STATUS[cmd.state], '--comment', comment];
    if (cmd.state === 'blocked') args.push('--unread');
    const r = runOrca(args, env);
    return r.ok ? { ok: true } : r;
  }
  return null;
}

function notifyOwner(host, text, env = process.env) {
  if (host.kind === 'maestri') return runMaestri(['notify', text], env);
  if (host.kind === 'orca') {
    const r = runOrca(['worktree', 'set', '--worktree', 'current', '--unread'], env);
    return r.ok ? { ok: true } : r;
  }
  return null;
}

module.exports = { HOST_KINDS, DISPATCH_MODES, HOST_TIMEOUT_MS, ORCA_STATUS, detectHost, hostReport, modeOf, postStatus, notifyOwner };
