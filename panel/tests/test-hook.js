'use strict';
// Tests for bin/hook-log.js through its public seams: the hook runs as a process fed by stdin (as Claude Code
// does) and the result is checked only through the server API.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assert, REPO, createSuite, tmpDir, remove, writeJson, writeJsonl, freePort, request } = require('./util');

const HOOK = path.join(REPO, 'bin', 'hook-log.js');
const srv = require(path.join(REPO, 'panel', 'server.js'));
const suite = createSuite('raw log hook (bin/hook-log.js)');
const roots = [];
const F = 'F-20261008-0002';
const sp = (hms) => `2026-10-08T${hms}-03:00`;

/** Workspace root with the data folder inside it (the hook only records sessions under the root). */
function buildRoot() {
  const root = tmpDir('hook');
  roots.push(root);
  const ws = path.join(root, 'ws');
  const m = path.join(ws, '_maestro');
  const coord = path.join(ws, 'coord');
  fs.mkdirSync(coord, { recursive: true });
  writeJson(path.join(m, 'registro', 'agentes.json'), {
    workspace: { nome: 'Exemplo' },
    agentes: [{ slug: 'coordenador', nome: 'Coordenador', status: 'ativo', diretorios: [coord] }],
  });
  writeJsonl(path.join(m, 'logs', 'eventos', '2026-10.jsonl'), [{
    id: 'EV-20261008-101000-0001', ts: sp('10:10:00'), agente: 'coordenador', fluxo_id: F, origem: 'cerebro', tipo: 'execucao',
    resumo: 'Executado', direcao: 'x', resultado: 'ok', sessao: 's-1',
  }]);
  return { root, ws, m, coord, outside: path.join(root, 'elsewhere') };
}

function runHook(r, payload, now) {
  const env = Object.assign({}, process.env, { MAESTRO_DIR: r.m, MAESTRO_NOW: now, MAESTRI_WORKSPACE_ID: '', MAESTRI_TERMINAL_ID: '', CLAUDE_PROJECT_DIR: '', API_KEY: '' });
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
}

suite.test('records prompts and tools of a workspace session, links the flow and redacts secrets; the API shows them', async () => {
  const r = buildRoot();
  const runs = [
    runHook(r, { hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: r.coord, prompt: `Faça a leitura ${F}`, transcript_path: path.join(r.root, 't.jsonl') }, sp('10:00:00')),
    runHook(r, { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: r.coord, tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abcDEF123456789xyz" https://x' }, tool_response: { stdout: 'feito', stderr: '' } }, sp('10:05:00')),
    runHook(r, { hook_event_name: 'PostToolUseFailure', session_id: 's-1', cwd: r.coord, tool_name: 'Bash', tool_input: { command: 'node falha.js' }, error: 'exit 1' }, sp('10:06:00')),
    // A session outside the workspace root: nothing is recorded.
    runHook(r, { hook_event_name: 'UserPromptSubmit', session_id: 's-9', cwd: r.outside, prompt: 'outra coisa' }, sp('10:07:00')),
    // Garbage on stdin: still exits 0 in silence.
    { ...spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', windowsHide: true, timeout: 10000 }) },
  ];
  for (const x of runs) {
    assert.strictEqual(x.status, 0);
    assert.strictEqual(x.stdout, '');
    assert.strictEqual(x.stderr, '');
  }
  const port = await freePort();
  const s = await srv.start({ argv: ['--port', String(port)], env: { MAESTRO_DIR: r.m, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'), CLAUDE_CONFIG_DIR: path.join(r.root, 'claude'), PANEL_NOW: sp('10:20:00') } });
  try {
    const state = (await request(port, '/api/state')).json;
    const hook = state.health.hooks.find((h) => h.agent === 'coordenador');
    assert.strictEqual(hook.last_raw, sp('10:06:00'));
    assert.deepStrictEqual(state.health.reasons, []);
    const d = (await request(port, '/api/event/EV-20261008-101000-0001')).json;
    assert.deepStrictEqual(d.raw_commands.map((c) => [c.ts, c.hook_event, c.tool, c.correlation, c.session, c.flow_id]), [
      [sp('10:00:00'), 'UserPromptSubmit', null, 'flow_id', 's-1', F],
      [sp('10:05:00'), 'PostToolUse', 'Bash', 'flow_id', 's-1', F],
      [sp('10:06:00'), 'PostToolUseFailure', 'Bash', 'flow_id', 's-1', F],
    ]);
    assert.strictEqual(d.raw_commands[0].prompt, `Faça a leitura ${F}`);
    assert.ok(d.raw_commands[1].input.includes('«redigido»') && !d.raw_commands[1].input.includes('abcDEF123456789xyz'), d.raw_commands[1].input);
    assert.deepStrictEqual([d.raw_commands[2].ok, d.raw_commands[2].error], [false, 'exit 1']);
    assert.ok(d.raw_commands.every((c) => c.agent === 'coordenador'));
    // The session belongs to the agent: the usage collector counts it.
    const rc = (await request(port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1' } })).json;
    assert.strictEqual(rc.usage.collection.sessions, 1);
  } finally {
    await s.stop();
  }
});

suite.run().then(() => {
  if (!process.env.KEEP_TMP) for (const r of roots) remove(r);
});
