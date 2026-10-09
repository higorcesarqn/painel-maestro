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
//   task/<item>-ajuste-final               the item (the final adjustment floor is not a task: counts as its maestro)
//   feature/pbi-<id> or feature/issue-<n>  the maestro of the item
// (the convention lives in parseBranch of bin/flow-repo.js)
// Entry in bruto.db (bin/raw-store.js): {at, t, session_id, project_id, item_number, task_number, branch,
//   hook_event, tool?, input?, ok?, output_summary?, error?, info?, duration_ms?, prompt?, detail?, agent_id?,
//   agent_type?, cwd, version?}. Nothing it writes is a sentence (ADR 0004): what the file tools did, their sizes and an
//   interruption go in info as codes with parameters ({input: {code: 'raw_edit', from, to, all}, output: {code:
//   'raw_lines_read', lines, total}, interrupted: true}), which the page translates.
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

/** { item, task } of a branch name (bin/flow-repo.js parseBranch): the final adjustment floor is the item's, not a task. */
function branchLink(parseBranch, branch) {
  const b = parseBranch(branch);
  if (b.kind === 'task') return { item: null, task: b.task };
  if (b.kind === 'maestro' || b.kind === 'final_adjustment') return { item: b.item, task: null };
  return { item: null, task: null };
}

/**
 * "input" of the line: command (Bash/PowerShell), file (Read/Write/Edit) or truncated JSON; and, for the file tools,
 * the size as a code with parameters (info.input) that the page translates (ADR 0004: no sentence in the data).
 * Returns { text, info }.
 */
function inputSummary(lib, tool, input) {
  if (input === undefined || input === null) return { text: undefined, info: null };
  if (typeof input !== 'object') return { text: lib.summarize(String(input), INPUT_LIMIT), info: null };
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') {
    return { text: lib.summarize(input.command, INPUT_LIMIT), info: null };
  }
  const file = typeof input.file_path === 'string' ? input.file_path : (typeof input.notebook_path === 'string' ? input.notebook_path : null);
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && file) {
    let info = null;
    if (tool === 'Write' && typeof input.content === 'string') info = { code: 'raw_write', chars: input.content.length };
    else if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      info = { code: 'raw_edit', from: input.old_string.length, to: input.new_string.length, all: !!input.replace_all };
    } else if (tool === 'MultiEdit' && Array.isArray(input.edits)) info = { code: 'raw_multi_edit', edits: input.edits.length };
    else if (tool === 'Read' && (input.offset || input.limit)) info = { code: 'raw_read_lines', offset: Number(input.offset) || 1, limit: Number(input.limit) || null };
    else if (tool === 'Read' && input.pages) info = { code: 'raw_read_pages', pages: String(input.pages).slice(0, 40) };
    return { text: lib.summarize(file, INPUT_LIMIT), info };
  }
  // Redacts the object before serializing: JSON inside text shows up raw and the key=value rules apply.
  return { text: lib.summarize(JSON.stringify(lib.redactValue(input)), INPUT_LIMIT), info: null };
}

const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** What Write/Edit/MultiEdit/NotebookEdit did and how many lines, as a code (never the text of the file). */
function fileInfo(tool, r) {
  if (!r || typeof r !== 'object') return { code: 'raw_file_written', kind: null, lines: null };
  if (tool === 'Write') {
    const kind = r.type === 'create' || r.type === 'update' ? r.type : null;
    return { code: 'raw_file_written', kind, lines: typeof r.content === 'string' ? r.content.split('\n').length : null };
  }
  if (tool === 'NotebookEdit') return { code: 'raw_notebook_edited', mode: typeof r.edit_mode === 'string' ? r.edit_mode.slice(0, 20) : null };
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
  const counted = Array.isArray(r.structuredPatch);
  return { code: 'raw_file_edited', added: counted ? added : null, removed: counted ? removed : null, all: !!r.replaceAll };
}

/**
 * "output_summary": stdout/stderr (Bash/PowerShell) or redacted and truncated JSON; for the file tools and Read, a code
 * instead (info.output: lines read, file created...). { text, info, interrupted }.
 */
function outputSummary(lib, tool, r) {
  const none = { text: undefined, info: null, interrupted: false };
  if (r === undefined || r === null) return none;
  if (FILE_TOOLS.includes(tool)) return { ...none, info: fileInfo(tool, r) };
  if (typeof r === 'string') return { ...none, text: lib.summarize(r, OUTPUT_LIMIT) };
  if (typeof r !== 'object') return { ...none, text: lib.summarize(String(r), OUTPUT_LIMIT) };
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    let s = typeof r.stdout === 'string' ? r.stdout : '';
    if (r.stderr) s += `${s ? '\n' : ''}[stderr] ${r.stderr}`;
    return { ...none, text: lib.summarize(s, OUTPUT_LIMIT), interrupted: !!r.interrupted };
  }
  if (tool === 'Read') {
    if (r.file && typeof r.file === 'object' && typeof r.file.numLines === 'number') {
      return { ...none, info: { code: 'raw_lines_read', lines: r.file.numLines, total: typeof r.file.totalLines === 'number' ? r.file.totalLines : null } };
    }
    return { ...none, info: { code: 'raw_read', kind: typeof r.type === 'string' ? r.type.slice(0, 20) : null } }; // image, PDF, notebook: never the content
  }
  return { ...none, text: lib.summarize(JSON.stringify(lib.redactValue(r)), OUTPUT_LIMIT) };
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
  const { repoInfo, normalizeRemote, parseBranch } = require('./flow-repo');
  const info = repoInfo(cwd, env);
  if (!info || !info.origin) return null;
  const { openStore, flowDir } = require('./flow-store');
  const dir = flowDir(env);
  const store = openStore({ dir, readOnly: true, busyTimeoutMs: READ_WAIT_MS });
  if (!store) return null;
  try {
    const project = store.projectByRemote(normalizeRemote(info.origin));
    if (!project) return null;
    const { item, task } = branchLink(parseBranch, info.branch);
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
  const info = {};
  if (typeof p.tool_name === 'string') {
    entry.tool = p.tool_name.slice(0, 120);
    const i = inputSummary(lib, p.tool_name, p.tool_input);
    if (i.text !== undefined && i.text !== '') entry.input = i.text;
    if (i.info) info.input = i.info;
  }
  if (hookEvent === 'PostToolUse') {
    entry.ok = true;
    const o = outputSummary(lib, p.tool_name, p.tool_response);
    if (o.text) entry.output_summary = o.text;
    if (o.info) info.output = o.info;
    if (o.interrupted) info.interrupted = true;
  } else if (hookEvent === 'PostToolUseFailure') {
    entry.ok = false;
    const raw = typeof p.error === 'string' ? p.error : (p.error === undefined || p.error === null ? '' : JSON.stringify(p.error));
    if (raw) entry.error = lib.summarize(raw, OUTPUT_LIMIT);
    if (p.is_interrupt) info.interrupted = true;
  } else if ((hookEvent === 'Stop' || hookEvent === 'SubagentStop') && typeof p.last_assistant_message === 'string' && p.last_assistant_message) {
    entry.output_summary = lib.summarize(p.last_assistant_message, OUTPUT_LIMIT);
  }
  if (Object.keys(info).length) entry.info = info;
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
