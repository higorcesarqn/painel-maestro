#!/usr/bin/env node
'use strict';
// hook-log.js · Claude Code hook → raw log in <MAESTRO_DIR>/logs/raw/<agent>/YYYY-MM-DD.jsonl.
// Installed in ~/.claude/settings.json in exec form, without a shell:
//   {"type":"command","command":"node","args":["bin/hook-log.js"]}
// Rules: never writes to stdout nor stderr (on SessionStart and UserPromptSubmit stdout becomes model
// context); always exits with 0; gives up on everything in ~1.5 s; never waits for a lock longer than
// ~300 ms; when the session is not from the workspace, exits in a few ms (without reading any file, if
// possible); truncates input (600) and output (300) and redacts secrets with «redigido».
//
// Raw line: {ts, agent, terminal, session, agent_id?, agent_type?, flow_id?, hook_event, tool?, input?,
//   ok?, output_summary?, error?, duration_ms?, prompt?, detail?, cwd, version?}.
// Session state (state/sessions/<session_id>.json): {session_id, agent, terminal, cwd, transcript_path,
//   started_at, seen_at, flow_id, flow_since}; the usage collector attributes tokens with it.

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
const LOCK_WAIT_MS = 300;
const SESSION_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];

/** Quick filter (without the lib): is the path inside the root? */
function quickInside(child, parent) {
  if (typeof child !== 'string' || !child.trim()) return false;
  const path = require('path');
  const n = (s) => path.resolve(s.trim().replace(/\\/g, '/').replace(/^\/([a-zA-Z])(\/|$)/, '$1:/'))
    .replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = n(child);
  const r = n(parent);
  return c === r || c.startsWith(`${r}/`);
}

/** Sleeps without burning CPU (synchronous). */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let pendingCacheWrite = null;

/** Keeps the last good copy of the registry in state/agents-cache.json (only when agentes.json changed). */
function saveCache(fs, path, file, cache, text) {
  try {
    let stale = true;
    try { stale = fs.statSync(cache).mtimeMs < fs.statSync(file).mtimeMs; } catch (_) { /* no cache yet */ }
    if (!stale) return;
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const tmp = `${cache}.tmp-${process.pid}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    fs.writeFileSync(tmp, text);
    try { fs.renameSync(tmp, cache); } catch (_) { try { fs.unlinkSync(tmp); } catch (__) { /* ignore */ } }
  } catch (_) { /* the cache is only a safety net */ }
}

/**
 * Reads registro/agentes.json (old model registry) WITHOUT the lib (fast, to decide "is it ours?" before
 * loading it). On EBUSY/EPERM retries for up to ~200 ms; with half a JSON (someone rewriting), retries once
 * after ~30 ms. If it still fails, uses the last good copy (state/agents-cache.json). A missing file returns null.
 */
function readRegistry(base) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(base, 'registro', 'agentes.json');
  const cache = path.join(base, 'state', 'agents-cache.json');
  const normal = (c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    if (!Array.isArray(c.agentes)) c.agentes = [];
    return c;
  };
  const start = Date.now();
  let retriedJson = false;
  for (;;) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      const c = normal(JSON.parse(text));
      // The cache is only written after confirming the session is ours (someone else's session writes nothing).
      if (c) { pendingCacheWrite = () => saveCache(fs, path, file, cache, text); return c; }
      break;
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      if (e instanceof SyntaxError) {
        if (retriedJson) break;
        retriedJson = true;
        sleep(30);
        continue;
      }
      if (!(e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) || Date.now() - start >= 200) break;
      sleep(10);
    }
  }
  try { return normal(JSON.parse(fs.readFileSync(cache, 'utf8'))); } catch (_) { return null; }
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

function handle(text) {
  const path = require('path');
  let p;
  try { p = JSON.parse(String(text).replace(/^﻿/, '')); } catch (_) { return; }
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.hook_event_name !== 'string') return;
  const env = process.env;
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd : process.cwd();

  // 1) Quick filters, before loading the lib:
  //    outside Maestri and outside the workspace root → not ours (without reading any file);
  //    Maestri of ANOTHER workspace → not ours (reads only agentes.json, or its last good copy).
  const base = path.resolve(env.MAESTRO_DIR || path.join(__dirname, '..'));
  if (!env.MAESTRI_WORKSPACE_ID) {
    const root = path.dirname(base);
    if (![cwd, env.CLAUDE_PROJECT_DIR].some((d) => quickInside(d, root))) return;
  }
  const registry = readRegistry(base);
  const wsId = registry && registry.workspace && typeof registry.workspace.id === 'string' ? registry.workspace.id : null;
  if (env.MAESTRI_WORKSPACE_ID && wsId && env.MAESTRI_WORKSPACE_ID !== wsId) return;

  // 2) Workspace and agent.
  const lib = require('./lib');
  const id = lib.identifyAgent({ env, cwd, registry });
  if (!id.ours) return;
  if (pendingCacheWrite) pendingCacheWrite();

  const when = lib.now();
  const iso = lib.isoSP(when);
  const hookEvent = p.hook_event_name;
  const sid = lib.safeSessionId(p.session_id);
  const promptFlow = hookEvent === 'UserPromptSubmit' ? lib.lastFlowInText(p.prompt) : null;

  // 3) Session state and flow correlation. Never waits for a lock longer than ~300 ms.
  let flow = null;
  if (sid && SESSION_EVENTS.includes(hookEvent)) {
    try {
      const s = lib.updateSession(sid, (current) => {
        const a = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
        const changed = !!promptFlow && promptFlow !== a.flow_id;
        return {
          ...a,
          session_id: sid,
          agent: id.agent,
          terminal: id.terminal || null,
          cwd,
          transcript_path: typeof p.transcript_path === 'string' ? p.transcript_path : (a.transcript_path || null),
          started_at: a.started_at || iso,
          seen_at: iso,
          flow_id: promptFlow || a.flow_id || null,
          flow_since: changed ? iso : (a.flow_since || null),
        };
      }, { timeoutMs: LOCK_WAIT_MS, sync: false, cleanTemps: false }); // the session is derived state: no fsync
      flow = s && s.flow_id;
    } catch (_) {
      flow = promptFlow || lib.flowOfSession(sid, { timeoutMs: 100 });
    }
  } else if (sid) {
    flow = lib.flowOfSession(sid, { timeoutMs: 100 });
  }

  // 4) The raw log line.
  const line = { ts: iso, agent: id.agent, terminal: id.terminal || null, session: sid || null };
  if (p.agent_id !== undefined && p.agent_id !== null) line.agent_id = String(p.agent_id);
  if (p.agent_type !== undefined && p.agent_type !== null) line.agent_type = String(p.agent_type);
  if (flow) line.flow_id = flow;
  line.hook_event = hookEvent;
  if (typeof p.tool_name === 'string') {
    line.tool = p.tool_name;
    const i = inputSummary(lib, p.tool_name, p.tool_input);
    if (i !== undefined && i !== '') line.input = i;
  }
  if (hookEvent === 'PostToolUse') {
    line.ok = true;
    const o = outputSummary(lib, p.tool_name, p.tool_response);
    if (o) line.output_summary = o;
  } else if (hookEvent === 'PostToolUseFailure') {
    line.ok = false;
    const raw = typeof p.error === 'string' ? p.error : (p.error === undefined || p.error === null ? '' : JSON.stringify(p.error));
    const error = `${p.is_interrupt ? '(interrompido) ' : ''}${raw}`;
    if (error) line.error = lib.summarize(error, OUTPUT_LIMIT);
  } else if ((hookEvent === 'Stop' || hookEvent === 'SubagentStop') && typeof p.last_assistant_message === 'string' && p.last_assistant_message) {
    line.output_summary = lib.summarize(p.last_assistant_message, OUTPUT_LIMIT);
  }
  if (typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms)) line.duration_ms = p.duration_ms;
  if (hookEvent === 'UserPromptSubmit' && typeof p.prompt === 'string') line.prompt = lib.summarize(p.prompt, PROMPT_LIMIT);
  if (hookEvent === 'SessionStart' && p.source) line.detail = String(p.source).slice(0, 40);
  if (hookEvent === 'SessionEnd' && p.reason) line.detail = String(p.reason).slice(0, 40);
  line.cwd = cwd;
  const version = versionOf(p, env);
  if (version) line.version = version;
  lib.appendJsonl(lib.rawFile(id.agent, when), line);
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
