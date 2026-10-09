#!/usr/bin/env node
'use strict';
// hook-log.js · Claude Code hook → raw log in bruto.db (MAESTRO_DIR or ~/.painel-maestro; ADR 0003, #12).
// Installed in ~/.claude/settings.json in exec form, without a shell:
//   {"type":"command","command":"node","args":["<repo>/bin/hook-log.js"]}
// Rules: never writes to stdout nor stderr (on SessionStart and UserPromptSubmit stdout becomes model
// context); always exits with 0; gives up on everything in ~1.5 s (SQLite waits at most ~300-500 ms for a busy
// database); truncates input (600) and output (300) and redacts secrets with «redigido».
//
// Only sessions whose cwd belongs to a registered project are written: the git remote origin of the cwd (also
// inside a floor's worktree), normalized like the flow CLI does, must be in maestro.db. Anything else exits in a
// few ms, writing nothing. The session is linked to the item and the task by the current branch:
//   task/<id>-… (or task/<id>)            the task <id> (its item comes from maestro.db when known)
//   feature/pbi-<id> or feature/issue-<n>  the maestro of the item
// Entry in bruto.db (bin/raw-store.js): {at, t, session_id, project_id, item_number, task_number, branch,
//   hook_event, tool?, input?, ok?, output_summary?, error?, duration_ms?, prompt?, detail?, agent_id?,
//   agent_type?, cwd, version?}.
// The session row (sessions table: link, cwd, transcript_path, last seen) is what the usage collector
// (bin/collect-usage.js) reads to split the tokens by item and by agent (#13).

// ---- total silence and guaranteed exit with code 0
process.stdout.write = () => true;
process.stderr.write = () => true;
process.noDeprecation = true;
process.removeAllListeners('warning');
process.on('warning', () => {});
let leaving = false;
function leave() {
  if (leaving) return;
  leaving = true;
  try { process.exit(0); } catch (_) { /* nothing to do */ }
}
process.on('uncaughtException', leave);
process.on('unhandledRejection', leave);
setTimeout(leave, 1500); // total time limit: never holds Claude Code

const INPUT_LIMIT = 600;
const OUTPUT_LIMIT = 300;
const PROMPT_LIMIT = 1000;
const READ_WAIT_MS = 300;  // maestro.db busy: gives up after this
const WRITE_WAIT_MS = 500; // bruto.db busy: gives up after this

const RE_TASK_BRANCH = /^task\/(\d{1,9})(?:[-_/.].*)?$/i;
const RE_ITEM_BRANCH = /^feature\/(?:pbi|issue)-(\d{1,9})(?:[-_/.].*)?$/i;

/** { item, task } of a branch name (null when the branch says nothing). */
function branchLink(branch) {
  const task = RE_TASK_BRANCH.exec(branch || '');
  if (task) return { item: null, task: Number(task[1]) };
  const item = RE_ITEM_BRANCH.exec(branch || '');
  return { item: item ? Number(item[1]) : null, task: null };
}

/** "input" of the line: command (Bash/PowerShell), file + size (Read/Write/Edit) or truncated JSON. */
function inputSummary(lib, tool, input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return lib.summarize(String(input), INPUT_LIMIT);
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
    return lib.summarize(input.command, INPUT_LIMIT);
  }
  const file = typeof input.file_path === 'string' ? input.file_path : (typeof input.notebook_path === 'string' ? input.notebook_path : null);
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && file) {
    // The details are read by people in the page: Portuguese (ADR 0004).
    let size = '';
    if (tool === 'Write' && typeof input.content === 'string') size = ` (${input.content.length} caracteres)`;
    else if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      size = ` (${input.old_string.length} → ${input.new_string.length} caracteres${input.replace_all ? ', todas as ocorrências' : ''})`;
    } else if (tool === 'MultiEdit' && Array.isArray(input.edits)) size = ` (${input.edits.length} edições)`;
    else if (tool === 'Read' && (input.offset || input.limit)) size = ` (linhas ${input.offset || 1}${input.limit ? ` +${input.limit}` : ''})`;
    else if (tool === 'Read' && input.pages) size = ` (páginas ${input.pages})`;
    return lib.summarize(file + size, INPUT_LIMIT);
  }
  // Redacts the object before serializing: JSON inside text shows up raw and the key=value rules apply.
  return lib.summarize(JSON.stringify(lib.redactValue(input)), INPUT_LIMIT);
}

const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** Summary without content for Write/Edit/MultiEdit/NotebookEdit: what was done and how many lines (never the text). */
function fileSummary(tool, r) {
  if (!r || typeof r !== 'object') return `${tool} ok`;
  if (tool === 'Write') {
    const lines = typeof r.content === 'string' ? ` (${r.content.split('\n').length} linhas)` : '';
    return `${r.type === 'create' ? 'criado' : (r.type === 'update' ? 'atualizado' : 'gravado')}${lines}`;
  }
  if (tool === 'NotebookEdit') return `notebook editado${typeof r.edit_mode === 'string' ? ` (${r.edit_mode.slice(0, 20)})` : ''}`;
  let added = 0;
  let removed = 0;
  if (Array.isArray(r.structuredPatch)) {
    for (const h of r.structuredPatch) {
      if (!h || !Array.isArray(h.lines)) continue;
      for (const l of h.lines) {
        if (typeof l !== 'string') continue;
        if (l.startsWith('+')) added++;
        else if (l.startsWith('-')) removed++;
      }
    }
  }
  const patch = Array.isArray(r.structuredPatch) ? ` (+${added} −${removed} linhas)` : '';
  return `editado${patch}${r.replaceAll ? ', todas as ocorrências' : ''}`;
}

/** "output_summary": stdout/stderr (Bash/PowerShell), lines read (Read), summary without content (Write/Edit) or redacted and truncated JSON. */
function outputSummary(lib, tool, r) {
  if (r === undefined || r === null) return undefined;
  if (FILE_TOOLS.includes(tool)) return fileSummary(tool, r);
  if (typeof r === 'string') return lib.summarize(r, OUTPUT_LIMIT);
  if (typeof r !== 'object') return lib.summarize(String(r), OUTPUT_LIMIT);
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    let s = typeof r.stdout === 'string' ? r.stdout : '';
    if (r.stderr) s += `${s ? '\n' : ''}[stderr] ${r.stderr}`;
    if (r.interrupted) s = `(interrompido) ${s}`;
    return lib.summarize(s, OUTPUT_LIMIT);
  }
  if (tool === 'Read') {
    if (r.file && typeof r.file === 'object' && typeof r.file.numLines === 'number') {
      return `${r.file.numLines} linhas lidas${typeof r.file.totalLines === 'number' ? ` de ${r.file.totalLines}` : ''}`;
    }
    return `lido (${typeof r.type === 'string' ? r.type.slice(0, 20) : 'arquivo'})`; // image, PDF, notebook: never the content
  }
  return lib.summarize(JSON.stringify(lib.redactValue(r)), OUTPUT_LIMIT);
}

/** Claude Code version: stdin.version or AI_AGENT ("claude-code_2-1-292_agent" becomes "claude-code 2.1.292"). */
function versionOf(p, env) {
  if (typeof p.version === 'string' && p.version.trim()) return p.version.trim().slice(0, 40);
  const a = typeof env.AI_AGENT === 'string' ? env.AI_AGENT.trim() : '';
  if (!a) return undefined;
  const m = /^([A-Za-z][\w.-]*?)_(\d+(?:-\d+)+)(?:_|$)/.exec(a);
  return m ? `${m[1]} ${m[2].replace(/-/g, '.')}` : a.slice(0, 60);
}

/** The registered project of the folder and the session's link, or null when the session is not ours. */
function linkOf(cwd, env) {
  const { repoInfo, normalizeRemote } = require('./flow-repo');
  const info = repoInfo(cwd, env);
  if (!info || !info.origin) return null;
  const { openStore, flowDir } = require('./flow-store');
  const dir = flowDir(env);
  const store = openStore({ dir, readOnly: true, busyTimeoutMs: READ_WAIT_MS });
  if (!store) return null;
  try {
    const project = store.projectByRemote(normalizeRemote(info.origin));
    if (!project) return null;
    const { item, task } = branchLink(info.branch);
    return { dir, project: project.id, branch: info.branch, task, item: task !== null ? store.itemOfTask(project.id, task) : item };
  } finally {
    store.close();
  }
}

function handle(text) {
  let p;
  try { p = JSON.parse(String(text).replace(/^﻿/, '')); } catch (_) { return; }
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.hook_event_name !== 'string') return;
  const env = process.env;
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd : process.cwd();

  // 1) Is it ours? Reads only the .git files of the cwd and, for a repository, maestro.db (read only).
  const link = linkOf(cwd, env);
  if (!link) return;

  // 2) The entry, redacted and truncated.
  const lib = require('./lib');
  const when = lib.now();
  const at = lib.isoSP(when);
  const hookEvent = p.hook_event_name;
  const sid = lib.safeSessionId(p.session_id);
  const entry = {
    at, t: when.getTime(), session_id: sid || null, project_id: link.project, item_number: link.item, task_number: link.task,
    branch: link.branch, hook_event: hookEvent, cwd,
  };
  if (p.agent_id !== undefined && p.agent_id !== null) entry.agent_id = String(p.agent_id).slice(0, 120);
  if (p.agent_type !== undefined && p.agent_type !== null) entry.agent_type = String(p.agent_type).slice(0, 120);
  if (typeof p.tool_name === 'string') {
    entry.tool = p.tool_name.slice(0, 120);
    const i = inputSummary(lib, p.tool_name, p.tool_input);
    if (i !== undefined && i !== '') entry.input = i;
  }
  if (hookEvent === 'PostToolUse') {
    entry.ok = true;
    const o = outputSummary(lib, p.tool_name, p.tool_response);
    if (o) entry.output_summary = o;
  } else if (hookEvent === 'PostToolUseFailure') {
    entry.ok = false;
    const raw = typeof p.error === 'string' ? p.error : (p.error === undefined || p.error === null ? '' : JSON.stringify(p.error));
    const error = `${p.is_interrupt ? '(interrompido) ' : ''}${raw}`;
    if (error) entry.error = lib.summarize(error, OUTPUT_LIMIT);
  } else if ((hookEvent === 'Stop' || hookEvent === 'SubagentStop') && typeof p.last_assistant_message === 'string' && p.last_assistant_message) {
    entry.output_summary = lib.summarize(p.last_assistant_message, OUTPUT_LIMIT);
  }
  if (typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms)) entry.duration_ms = p.duration_ms;
  if (hookEvent === 'UserPromptSubmit' && typeof p.prompt === 'string') entry.prompt = lib.summarize(p.prompt, PROMPT_LIMIT);
  if (hookEvent === 'SessionStart' && p.source) entry.detail = String(p.source).slice(0, 40);
  if (hookEvent === 'SessionEnd' && p.reason) entry.detail = String(p.reason).slice(0, 40);
  const version = versionOf(p, env);
  if (version) entry.version = version;
  const transcript = typeof p.transcript_path === 'string' && p.transcript_path ? p.transcript_path : null;

  // 3) bruto.db.
  const { openRawStore } = require('./raw-store');
  const raw = openRawStore({ dir: link.dir, busyTimeoutMs: WRITE_WAIT_MS });
  try {
    raw.record(entry, { cwd, transcript_path: transcript });
  } finally {
    raw.close();
  }
}

// ---- reads the whole stdin (asynchronously, so the time limit works) and handles it once
const chunks = [];
try {
  process.stdin.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
  process.stdin.on('end', () => {
    try { handle(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* never fails the agent */ }
    leave();
  });
  process.stdin.on('error', leave);
  process.stdin.resume();
} catch (_) {
  leave();
}
