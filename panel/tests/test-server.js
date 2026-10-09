'use strict';
// Tests for panel/server.js: fake root under tests/tmp/, server on a port between 4790 and 4799.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const {
  assert, REPO, createSuite, tmpDir, remove, writeJson, writeJsonl,
  freePort, request, rawRequest, waitFor, kill, pidAlive,
} = require('./util');

const SERVER = path.join(REPO, 'panel', 'server.js');
const srv = require(SERVER);

const NOW = '2026-10-08T15:50:00-03:00';
const sp = (hhmm, day = '2026-10-08') => `${day}T${hhmm}-03:00`;
const F2 = 'F-20261008-0002';
const F3 = 'F-20261008-0003';
const F4 = 'F-20261008-0004';
const INDEX = '<!doctype html><meta charset="utf-8"><title>Painel de teste</title><p>ok</p>';
const POST = { 'X-Panel': '1' };

const suite = createSuite('panel server (panel/server.js)');
const roots = [];

/** Old-model event record, as bin/registrar.js writes it (Portuguese field names, removed in #18). */
function ev(fields) {
  return Object.assign({ origem: 'cerebro', direcao: null, resultado: 'ok', precisa_dono: false, passos: [], comandos: [], alteracoes: [], pendencias: [] }, fields);
}

/** Realistic fake root: registry, events of 3 months, raw log, pending decisions, flows and usage. */
function buildRoot(name) {
  const root = tmpDir(`server-${name}`);
  roots.push(root);
  const m = path.join(root, 'maestro');
  const maestri = path.join(root, 'maestri');
  const claude = path.join(root, 'claude');
  writeJson(path.join(m, 'registro', 'agentes.json'), {
    workspace: { id: 'ws-teste', nome: 'Exemplo', raiz: 'C:/teste/raiz' },
    padrao: { modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh' },
    agentes: [
      { slug: 'cerebro', nome: 'Cérebro Principal', tipo: 'maestro', cor: '#E8C547', responsabilidade: 'Cérebro Principal', terminal_id: 't1', diretorios: [], modelo: 'claude-opus-5-5[1m]', nivel: 'max', conectado_a: ['coordenador'], skills: ['orquestracao'], status: 'ativo', desde: '2026-10-08' },
      { slug: 'coordenador', nome: 'Coordenador', tipo: 'sub-cerebro', cor: '#3B82F6', responsabilidade: 'Coordenador', terminal_id: 't2', diretorios: [], conectado_a: ['cerebro'], skills: ['revisao-codigo'], status: 'ativo', desde: '2026-10-08' },
      { slug: 'auditor', nome: 'Agente Auditor', tipo: 'sub-cerebro', cor: '#10B981', responsabilidade: 'Auditor', status: 'ativo', skills: [], conectado_a: [] },
      { slug: 'futuro', nome: 'Agente Futuro', tipo: 'sub-cerebro', cor: '#999999', status: 'a-criar', skills: [], conectado_a: [] },
    ],
  });
  const ev0 = ev({ id: 'EV-20260815-100000-aaaa', ts: '2026-08-15T10:00:00-03:00', agente: 'cerebro', fluxo_id: 'F-20260815-0001', origem: 'dono-direto', tipo: 'execucao', resumo: 'Evento antigo de agosto', direcao: 'Antigo' });
  writeJsonl(path.join(m, 'logs', 'eventos', '2026-08.jsonl'), [ev0]);
  writeJsonl(path.join(m, 'logs', 'eventos', '2026-09.jsonl'), [
    ev({ id: 'EV-20260920-090000-bbbb', ts: '2026-09-20T09:00:00-03:00', agente: 'coordenador', fluxo_id: 'F-20260920-0001', tipo: 'relatorio', projeto: 'D', resumo: 'RST de setembro gerado' }),
  ]);
  const october = [
    ev({ id: 'EV-20261008-140000-0001', ts: sp('14:00:00'), agente: 'cerebro', fluxo_id: F2, origem: 'dono-direto', tipo: 'pedido-recebido', resumo: 'Pedido do dono: revisar o repositório', sessao: 'sess-c1' }),
    ev({ id: 'EV-20261008-140100-0002', ts: sp('14:01:00'), agente: 'cerebro', fluxo_id: F2, tipo: 'delegacao', resumo: 'Delegada a leitura ao Coordenador', direcao: 'Deleguei porque o repositório é do Coordenador.', resultado: 'em-andamento', sessao: 'sess-c1' }),
    ev({ id: 'EV-20261008-140200-0003', ts: sp('14:02:00'), agente: 'coordenador', fluxo_id: F2, tipo: 'pedido-recebido', resumo: 'Pedido recebido do Cérebro: leitura', sessao: 'sess-t1' }),
    ev({
      id: 'EV-20261008-141000-0004', ts: sp('14:10:00'), agente: 'coordenador', fluxo_id: F2, tipo: 'execucao', projeto: 'A',
      resumo: 'Revisão do repositório concluída e relatório gerado', direcao: 'Li o histórico inteiro antes de testar o fluxo de ponta a ponta, porque traz as mudanças numa leitura só.',
      passos: ['Li', 'Salvei', 'Normalizei'], comandos: ['git log --oneline'], validacao: '13 = 13', proximo_passo: 'Aguardar o dono', pendencias: ['P-0001'], duracao_s: 48, sessao: 'sess-t1',
    }),
    ev({ id: 'EV-20261008-141500-0005', ts: sp('14:15:00'), agente: 'cerebro', fluxo_id: F2, origem: 'agente:coordenador', tipo: 'resposta-recebida', resumo: 'Resposta do Coordenador recebida', sessao: 'sess-c1' }),
    ev({ id: 'EV-20261008-142000-0006', ts: sp('14:20:00'), agente: 'cerebro', fluxo_id: F2, tipo: 'execucao', resumo: 'Evento de teste', direcao: 'x', teste: true }),
    ev({ id: 'EV-20261008-150000-0007', ts: sp('15:00:00'), agente: 'coordenador', fluxo_id: F3, origem: 'rotina', tipo: 'auditoria', projeto: 'B', resumo: 'Auditoria falhou: portal fora do ar', direcao: 'Tentei o portal duas vezes.', resultado: 'falhou', sessao: 'sess-t1' }),
    '{"id": "EV-QUEBRADO", "ts": ',
    ev({ id: 'EV-20261008-152000-0008', ts: sp('15:20:00'), agente: 'cerebro', fluxo_id: F4, origem: 'dono-direto', tipo: 'decisao', resumo: 'Decisão sobre etiquetas pendente', direcao: 'Precisa do dono.', resultado: 'aguardando-dono', precisa_dono: true }),
    ev({ id: 'EV-20261007-230000-0009', ts: '2026-10-08T02:00:00Z', agente: 'cerebro', fluxo_id: 'F-20261007-0001', tipo: 'manutencao', resumo: 'Manutenção noturna com acentuação: ação' }),
  ];
  const octFile = path.join(m, 'logs', 'eventos', '2026-10.jsonl');
  writeJsonl(octFile, october);
  fs.appendFileSync(octFile, '{"id":"EV-20261008-155900-0010","ts":"2026-10-08T15:59:00-03:00","agente":"cerebro"');

  // Raw log (written by bin/hook-log.js)
  const raw = (folder, day, lines) => writeJsonl(path.join(m, 'logs', 'raw', folder, `${day}.jsonl`), lines);
  raw('cerebro', '2026-10-08', [
    { ts: sp('13:59:50'), agent: 'cerebro', terminal: 't1', session: 'sess-c1', flow_id: F2, hook_event: 'UserPromptSubmit', prompt: `Revise o repositório. ${F2}`, cwd: 'C:/x' },
    { ts: sp('14:00:30'), agent: 'cerebro', terminal: 't1', session: 'sess-c1', flow_id: F2, hook_event: 'PostToolUse', tool: 'Bash', input: 'node registrar.js novo-fluxo', ok: true, cwd: 'C:/x' },
    { ts: sp('14:30:00'), agent: 'cerebro', terminal: 't1', session: 'sess-c1', hook_event: 'PostToolUse', tool: 'Read', input: 'C:/x/arquivo.md', ok: true, cwd: 'C:/x' },
    { ts: sp('15:10:00'), agent: 'cerebro', terminal: 't1', session: 'sess-c1', flow_id: F4, hook_event: 'UserPromptSubmit', prompt: 'Decida as etiquetas', cwd: 'C:/x' },
  ]);
  raw('coordenador', '2026-10-07', [
    { ts: sp('22:00:00', '2026-10-07'), agent: 'coordenador', session: 'sess-t0', hook_event: 'SessionStart', cwd: 'C:/y' },
  ]);
  raw('coordenador', '2026-10-08', [
    { ts: sp('14:01:30'), agent: 'coordenador', session: 'sess-t1', hook_event: 'SessionStart', cwd: 'C:/y' },
    { ts: sp('14:02:30'), agent: 'coordenador', session: 'sess-t1', flow_id: F2, hook_event: 'UserPromptSubmit', prompt: `[PEDIDO] ${F2}\nDe: Cérebro Principal → Para: Coordenador\nPedido: ler o quadro`, cwd: 'C:/y' },
    { ts: sp('14:05:00'), agent: 'coordenador', session: 'sess-t1', flow_id: F2, hook_event: 'PostToolUse', tool: 'Bash', input: 'git log --oneline', ok: true, output_summary: 'ok', duration_ms: 900, cwd: 'C:/y' },
    { ts: sp('14:06:00'), agent: 'coordenador', session: 'sess-t1', flow_id: F2, hook_event: 'PostToolUseFailure', tool: 'Bash', input: 'node normalizar.js', ok: false, error: 'exit 1', cwd: 'C:/y' },
    { ts: sp('14:07:00'), agent: 'coordenador', session: 'sess-t1', hook_event: 'PostToolUse', tool: 'Read', input: 'C:/y/quadro.json', ok: true, cwd: 'C:/y' },
    { ts: sp('14:08:00'), agent: 'coordenador', session: 'sess-OUTRA', hook_event: 'PostToolUse', tool: 'Grep', input: 'padrão', ok: true, cwd: 'C:/y' },
    'broken line {',
    { ts: sp('14:12:00'), agent: 'coordenador', session: 'sess-t1', hook_event: 'PostToolUse', tool: 'Bash', input: 'depois do evento', ok: true, cwd: 'C:/y' },
    { ts: sp('14:59:00'), agent: 'coordenador', session: 'sess-t1', flow_id: F3, hook_event: 'UserPromptSubmit', prompt: `[ROTINA] Auditoria do quadro ${F3}`, cwd: 'C:/y' },
    { ts: sp('15:00:30'), agent: 'coordenador', session: 'sess-t1', flow_id: F3, hook_event: 'PostToolUse', tool: 'Bash', input: 'maestri portal text', ok: true, cwd: 'C:/y' },
  ]);
  raw('desconhecido-abc12345', '2026-10-08', [{ ts: sp('11:00:00'), agent: 'desconhecido:abc12345', session: 'sess-x', hook_event: 'Stop', cwd: 'C:/z' }]);
  // Archive folder (starts with "_"): not an agent in the health check.
  raw('_reassigned-desconhecido-zz', '2026-10-08', [{ ts: sp('09:00:00'), agent: 'desconhecido:zz', session: 'sess-z', hook_event: 'SessionStart', cwd: 'C:/z' }]);

  // Pending decisions (old model file, written by bin/pendencia.js)
  const pend = (id, fields) => Object.assign({ id, agente: 'coordenador', fluxo_id: F2, tipo: 'decisao', titulo: `Pendência ${id}`, contexto: 'contexto', opcoes: ['A: sim', 'B: não'], recomendacao: 'A', status: 'aberta', resposta: null, resolvida_em: null }, fields);
  writeJson(path.join(m, 'estado', 'pendencias.json'), {
    proximo: 9,
    pendencias: [
      pend('P-0001', { aberta_em: sp('10:00:00'), severidade: 'alta' }),
      pend('P-0002', { aberta_em: sp('12:00:00'), severidade: 'critica' }),
      pend('P-0003', { aberta_em: sp('09:00:00'), severidade: 'normal' }),
      pend('P-0004', { aberta_em: sp('08:00:00'), severidade: 'alta' }),
      pend('P-0005', { aberta_em: sp('08:00:00', '2026-10-07'), severidade: 'baixa', status: 'respondida', resposta: 'ok', respondida_em: sp('09:00:00') }),
      pend('P-0006', { aberta_em: sp('08:00:00', '2026-10-06'), severidade: 'critica', status: 'resolvida', resolvida_em: sp('10:00:00', '2026-10-07') }),
      pend('P-0007', { aberta_em: sp('09:00:00', '2026-10-06'), severidade: 'normal', status: 'cancelada', resolvida_em: sp('11:00:00'), motivo: 'desistiu' }),
      pend('P-0008', { aberta_em: sp('13:00:00'), severidade: 'critica', teste: true }),
    ],
  });
  writeJson(path.join(m, 'estado', 'contador-fluxos.json'), {
    dias: { 20261008: { ultimo: 4 } },
    fluxos: {
      [F2]: { titulo: 'Revisão do repositório', agente: 'cerebro', criado_em: sp('13:59:00') },
      'F-20261009-0001': { titulo: 'Fluxo só no contador', agente: 'cerebro', criado_em: sp('15:40:00') },
    },
  });

  // Usage: Maestri plan (the tokens per item and per agent come from bruto.db sessions: test-usage-agents.js, #13)
  writeJson(path.join(maestri, 'usage', 'providers', '.status.json'), {
    providers: [{ id: 'claude', enabled: true, state: 'ready', plan: 'max', lastSuccessAt: '2026-10-08T18:47:00Z', meters: [{ id: 'plan', windows: [
      { id: 'five_hour', usedPercent: 37, resetsAt: '2026-10-08T21:00:00Z', durationSeconds: 18000 },
      { id: 'seven_day', usedPercent: 22, resetsAt: '2026-10-13T12:00:00Z', durationSeconds: 604800 },
    ] }] }],
    updatedAt: '2026-10-08T18:47:00Z',
  });

  const index = path.join(root, 'index-test.html');
  fs.writeFileSync(index, INDEX);
  return { root, m, maestri, claude, index };
}

function environment(r, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.m, MAESTRI_DATA_DIR: r.maestri, CLAUDE_CONFIG_DIR: r.claude, PANEL_INDEX: r.index,
    PANEL_NOW: NOW, MAESTRO_NOW: '', PANEL_PORT: '', MAESTRI_TERMINAL_ID: '', PANEL_NOTIFY_BRAIN: '',
  }, extra);
}

/** Starts the server as a separate process and returns {port, pid, child, output}. */
async function start(r, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { env: environment(r, extra), windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const line = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}: ${err}`);
    const m = /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(out);
    return m ? m : null;
  }, 15000);
  return { port: Number(line[1]), pid: Number(line[2]), child, output: () => out, errors: () => err };
}

let R;
let S;

suite.test('starts on the requested port, prints the PID and writes state/panel.pid; the collector runs on startup', async () => {
  R = buildRoot('main');
  S = await start(R);
  assert.ok(S.port >= 4790 && S.port <= 4799);
  assert.strictEqual(S.pid, S.child.pid, 'the printed PID must be the node process');
  const pidFile = fs.readFileSync(path.join(R.m, 'state', 'panel.pid'), 'utf8').trim();
  assert.strictEqual(Number(pidFile), S.pid);
  await waitFor(() => fs.existsSync(path.join(R.m, 'state', 'usage.json')), 10000);
});

suite.test('GET / returns index.html with no-store, CSP and no CORS; HEAD without body', async () => {
  const r = await request(S.port, '/', { headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, INDEX);
  assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.ok(String(r.headers['content-security-policy']).includes("default-src 'none'"));
  // Anti-clickjacking: no outside page can embed the panel in an iframe.
  assert.ok(String(r.headers['content-security-policy']).includes("frame-ancestors 'none'"));
  assert.strictEqual(r.headers['x-frame-options'], 'DENY');
  for (const p of ['/api/state', '/does-not-exist']) assert.strictEqual((await request(S.port, p)).headers['x-frame-options'], 'DENY', p);
  assert.strictEqual((await request(S.port, '/', { host: 'evil.example' })).headers['x-frame-options'], 'DENY');
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')), 'no CORS header');
  const h = await request(S.port, '/', { method: 'HEAD' });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.buf.length, 0);
});

suite.test('GET /api/state: contract shape, KPIs, health codes, agents, pending decisions, usage and events', async () => {
  const r = await request(S.port, '/api/state');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')));
  const e = r.json;
  assert.deepStrictEqual(Object.keys(e).sort(), ['agents', 'answers', 'collector', 'events', 'generated_at', 'health', 'kpis', 'pending_decisions', 'usage', 'warnings', 'workspace']);
  assert.deepStrictEqual(Object.keys(e.kpis).sort(), ['pending_decisions', 'usage']);
  assert.deepStrictEqual(Object.keys(e.health).sort(), ['hooks', 'last_event_age_min', 'level', 'reasons', 'usage_age_min', 'wire']);
  assert.strictEqual(e.generated_at, NOW);
  assert.deepStrictEqual({ name: e.workspace.name, root: e.workspace.root }, { name: 'Exemplo', root: 'C:/teste/raiz' });
  // Health: Auditor active without raw log (yellow), Futuro "a-criar" does not count.
  assert.strictEqual(e.health.level, 'yellow');
  assert.deepStrictEqual(e.health.reasons, [{ code: 'hook_never', agent: 'auditor', name: 'Agente Auditor' }]);
  assert.strictEqual(e.health.last_event_age_min, 30);
  assert.strictEqual(e.health.usage_age_min, 3);
  assert.strictEqual(e.health.wire, false);
  const hook = (a) => e.health.hooks.find((h) => h.agent === a);
  assert.strictEqual(hook('cerebro').last_raw, sp('15:10:00'));
  assert.strictEqual(hook('cerebro').age_min, 40);
  assert.strictEqual(hook('coordenador').last_raw, sp('15:00:30'));
  assert.strictEqual(hook('auditor').last_raw, null);
  assert.strictEqual(hook('desconhecido:abc12345').last_raw, sp('11:00:00'));
  assert.ok(!e.health.hooks.some((h) => String(h.agent).startsWith('_')), 'a "_..." folder is not an agent');
  // KPIs
  assert.deepStrictEqual(e.kpis.pending_decisions, { total: 4, by_severity: { critica: 1, alta: 2, normal: 1, baixa: 0 } });
  const u = e.kpis.usage;
  assert.deepStrictEqual(
    [u.available, u.window_5h_pct, u.reset_5h, u.weekly_pct, u.weekly_reset, u.age_min],
    [true, 37, '2026-10-08T18:00:00-03:00', 22, '2026-10-13T09:00:00-03:00', 3],
  );
  assert.deepStrictEqual(u.source, { code: 'maestri_claude_provider' });
  // Agents
  assert.deepStrictEqual(e.agents.map((a) => a.slug), ['cerebro', 'coordenador', 'auditor', 'futuro']);
  const c = e.agents[0];
  const t = e.agents[1];
  assert.strictEqual(c.effort, 'max');
  assert.deepStrictEqual([t.model, t.effort], ['claude-opus-5-5[1m]', 'xhigh'], 'without its own model/effort the default applies');
  assert.deepStrictEqual(c.last_event && [c.last_event.ts, c.last_event.type, c.last_event.result], [sp('15:20:00'), 'decisao', 'aguardando-dono']);
  assert.strictEqual(t.last_event.summary, 'Auditoria falhou: portal fora do ar');
  assert.strictEqual(c.events_today, 4);
  assert.strictEqual(t.events_today, 3);
  assert.strictEqual(c.open_flows, 1);
  assert.strictEqual(t.open_flows, 0);
  assert.strictEqual(c.last_raw, sp('15:10:00'));
  assert.deepStrictEqual(c.skills, ['orquestracao']);
  assert.deepStrictEqual(c.connected_to, ['coordenador']);
  assert.ok(!('usage' in c), 'the usage per agent of the old registry is gone (GET /api/usage, #13)');
  // Pending decisions: open ones by severity and age, then answered, then the most recent closed ones; tests out.
  assert.deepStrictEqual(e.pending_decisions.map((p) => p.id), ['P-0002', 'P-0004', 'P-0001', 'P-0003', 'P-0005', 'P-0007', 'P-0006']);
  assert.strictEqual(e.pending_decisions[0].age_min, 230);
  assert.deepStrictEqual(Object.keys(e.pending_decisions[0]).sort(), ['age_min', 'agent', 'answer', 'context', 'flow_id', 'id', 'opened_at', 'options', 'recommendation', 'resolved_at', 'severity', 'status', 'title', 'type']);
  assert.strictEqual(e.pending_decisions.find((p) => p.id === 'P-0007').reason, 'desistiu');
  assert.deepStrictEqual(e.usage.note, { code: 'usage_note' });
  // Events: 2 most recent months, no tests, most recent first, only the table fields.
  assert.deepStrictEqual(e.events.map((x) => x.id), [
    'EV-20261008-152000-0008', 'EV-20261008-150000-0007', 'EV-20261008-141500-0005', 'EV-20261008-141000-0004',
    'EV-20261008-140200-0003', 'EV-20261008-140100-0002', 'EV-20261008-140000-0001', 'EV-20261007-230000-0009', 'EV-20260920-090000-bbbb',
  ]);
  const ex = e.events[3];
  // Only the table fields (no steps nor other blocks of the full event).
  assert.deepStrictEqual(Object.keys(ex).sort(), ['agent', 'direction', 'flow_id', 'id', 'needs_owner', 'origin', 'project', 'result', 'summary', 'ts', 'type']);
  assert.deepStrictEqual(e.warnings, [{ code: 'event_lines_ignored', file: 'logs/eventos/2026-10.jsonl', count: 1 }]);
  assert.deepStrictEqual(e.answers, { brain_notice: false, reason: { code: 'brain_notice_no_terminal' } });
});

suite.test('no response carries a Portuguese sentence: every reason, warning and error is a code', async () => {
  const bodies = [
    (await request(S.port, '/api/state')).json,
    (await request(S.port, '/api/events?since=lixo')).json,
    (await request(S.port, '/api/event/EV-NAO-EXISTE')).json,
    (await request(S.port, '/api/recalculate', { method: 'POST' })).json,
    (await request(S.port, '/api/nope')).json,
  ];
  const walk = (v, where) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/^(reason|reasons|warnings|error|note|formula|source|basis)$/.test(k) && typeof x === 'string') {
          // Free text stored by people (a pending decision's cancel reason) is data, not a server sentence.
          if (!(k === 'reason' && /pending_decisions\[\d+\]$/.test(where))) assert.fail(`${where}.${k} is a sentence: ${x}`);
        }
        walk(x, `${where}.${k}`);
      }
    }
  };
  bodies.forEach((b, i) => walk(b, `body${i}`));
});

suite.test('Trello and Prospecção no longer exist: their routes give 404', async () => {
  for (const c of ['/prospeccao', '/prospeccao/antiga', '/api/prospeccao/estado', '/api/prospeccao/lead/L-0001', '/api/trello']) {
    const r = await request(S.port, c);
    assert.strictEqual(r.status, 404, `${c} should be 404 (got ${r.status})`);
  }
  for (const c of ['/api/prospeccao/assumir', '/api/prospeccao/devolver']) {
    const r = await request(S.port, c, { method: 'POST', headers: POST, body: '{"lead_id":"L-0001"}' });
    assert.strictEqual(r.status, 404, `POST ${c} should be 404 (got ${r.status})`);
  }
});

suite.test('the old Portuguese routes are gone: /api/estado, /api/eventos, /api/evento, /api/fluxo, /api/recalcular', async () => {
  for (const c of ['/api/estado', '/api/eventos', '/api/evento/EV-20261008-141000-0004', `/api/fluxo/${F2}`]) {
    assert.strictEqual((await request(S.port, c)).status, 404, c);
  }
  assert.strictEqual((await request(S.port, '/api/recalcular', { method: 'POST', headers: POST })).status, 404);
  assert.strictEqual((await request(S.port, '/api/cerebro', { method: 'POST', headers: POST })).status, 404);
});

suite.test('GET /api/events: filters, accent-free search, owner only, tests, period and paging', async () => {
  const get = async (q) => {
    const r = await request(S.port, `/api/events${q}`);
    assert.strictEqual(r.status, 200, r.text);
    return r.json;
  };
  let r = await get('');
  assert.deepStrictEqual([r.total, r.page, r.per_page, r.events.length], [10, 1, 50, 10]);
  assert.strictEqual(r.events[9].id, 'EV-20260815-100000-aaaa', 'every month enters the filters');
  assert.strictEqual((await get('?include_tests=1')).total, 11);
  assert.strictEqual((await get('?agent=coordenador')).total, 4);
  assert.strictEqual((await get('?agent=cerebro,coordenador')).total, 10);
  r = await get('?q=concluida');
  assert.deepStrictEqual(r.events.map((x) => x.id), ['EV-20261008-141000-0004']);
  assert.strictEqual((await get(`?q=${encodeURIComponent('CONCLUÍDA')}`)).total, 1);
  assert.strictEqual((await get(`?q=${F2}`)).total, 5);
  assert.strictEqual((await get('?q=testar%20ponta')).total, 1, 'search in the direction');
  assert.strictEqual((await get('?q=ponta%20%20TESTAR')).total, 1, 'every word, in any order');
  assert.strictEqual((await get('?q=ponta%20inexistente')).total, 0, 'every word must show up');
  assert.strictEqual((await get('?q=acao')).total, 1, 'search without the accent of "ação"');
  r = await get('?owner_only=1');
  assert.deepStrictEqual(r.events.map((x) => x.id), ['EV-20261008-152000-0008', 'EV-20261008-150000-0007']);
  assert.strictEqual((await get('?since=2026-10-08&until=2026-10-08')).total, 7);
  r = await get('?since=2026-10-07&until=2026-10-07');
  assert.deepStrictEqual(r.events.map((x) => x.id), ['EV-20261007-230000-0009'], 'a UTC ts falls on the São Paulo day');
  assert.strictEqual((await get('?project=a')).total, 1);
  assert.strictEqual((await get('?type=execucao')).total, 2);
  assert.strictEqual((await get('?result=falhou')).total, 1);
  assert.strictEqual((await get(`?flow=${F3}`)).total, 1);
  r = await get('?per_page=3&page=2');
  assert.deepStrictEqual([r.total, r.page, r.per_page, r.pages], [10, 2, 3, 4]);
  assert.deepStrictEqual(r.events.map((x) => x.id), ['EV-20261008-141000-0004', 'EV-20261008-140200-0003', 'EV-20261008-140100-0002']);
  assert.deepStrictEqual((await get('?page=99')).events, []);
  assert.strictEqual((await get('?per_page=9999')).per_page, 500);
  for (const [bad, error] of [
    ['?since=lixo', { code: 'invalid_param', param: 'since', value: 'lixo', expected: 'date' }],
    ['?until=2026-02-31', { code: 'invalid_param', param: 'until', value: '2026-02-31', expected: 'date' }],
    ['?since=2026-13-01', { code: 'invalid_param', param: 'since', value: '2026-13-01', expected: 'date' }],
    ['?page=0', { code: 'invalid_param', param: 'page', value: '0', expected: 'positive_integer' }],
    ['?per_page=abc', { code: 'invalid_param', param: 'per_page', value: 'abc', expected: 'positive_integer' }],
  ]) {
    const x = await request(S.port, `/api/events${bad}`);
    assert.strictEqual(x.status, 400, `${bad} should be 400`);
    assert.deepStrictEqual(x.json, { error });
  }
});

suite.test('GET /api/events: counts of the filtered set (each facet ignores its own filter), hours and many values', async () => {
  const get = async (q) => {
    const r = await request(S.port, `/api/events${q}`);
    assert.strictEqual(r.status, 200, r.text);
    return r.json;
  };
  // No filter: the 10 events besides the test ones, counted per facet (the counts do not depend on the page).
  let r = await get('?per_page=3');
  assert.deepStrictEqual(r.counts.result, { ok: 7, 'em-andamento': 1, falhou: 1, 'aguardando-dono': 1 });
  assert.deepStrictEqual(r.counts.agent, { cerebro: 6, coordenador: 4 });
  assert.deepStrictEqual(r.counts.project, { D: 1, A: 1, B: 1 });
  assert.strictEqual(Object.values(r.counts.type).reduce((a, b) => a + b, 0), 10);
  assert.deepStrictEqual([r.counts.type.execucao, r.counts.type['pedido-recebido'], r.counts.type.decisao], [2, 2, 1]);
  assert.strictEqual(r.counts.needs_owner, 2);
  // Result filter: the table shrinks, the result facet stays whole and the others honor the filter.
  r = await get('?result=ok');
  assert.strictEqual(r.total, 7);
  assert.deepStrictEqual(r.counts.result, { ok: 7, 'em-andamento': 1, falhou: 1, 'aguardando-dono': 1 });
  assert.deepStrictEqual(r.counts.agent, { cerebro: 4, coordenador: 3 });
  assert.strictEqual(r.counts.needs_owner, 0);
  // Many comma-separated values in agent and result.
  r = await get('?agent=coordenador&result=ok,falhou');
  assert.strictEqual(r.total, 4);
  assert.deepStrictEqual(r.counts.agent, { cerebro: 4, coordenador: 4 });
  assert.deepStrictEqual(r.counts.result, { ok: 3, falhou: 1 });
  assert.strictEqual((await get('?project=A,b')).total, 2, 'case-insensitive project, many values');
  // Owner only: needs_owner ignores its own filter (it is the toggle's number).
  r = await get('?owner_only=1');
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.counts.needs_owner, 2);
  assert.deepStrictEqual(r.counts.result, { falhou: 1, 'aguardando-dono': 1 });
  // hours=N: only the last N hours (fixed clock at 15:50); tests stay out.
  r = await get('?hours=1');
  assert.deepStrictEqual(r.events.map((x) => x.id), ['EV-20261008-152000-0008', 'EV-20261008-150000-0007']);
  assert.strictEqual((await get('?hours=2')).total, 7);
  assert.strictEqual((await get('?hours=2&since=2026-10-08')).total, 7, 'hours and since together');
  assert.strictEqual((await get('?hours=2&include_tests=1')).total, 8);
  for (const bad of ['?hours=0', '?hours=abc', '?hours=-3']) {
    const x = await request(S.port, `/api/events${bad}`);
    assert.strictEqual(x.status, 400, `${bad} should be 400`);
    assert.strictEqual(x.json.error.code, 'invalid_param');
  }
  // A search without results: empty counts, no error.
  r = await get('?q=nada-disso-existe');
  assert.deepStrictEqual(r.counts, { result: {}, agent: {}, project: {}, type: {}, needs_owner: 0 });
});

suite.test('GET /api/event/<id>: flow sequence, commands by flow and by window, initial request, neighbors', async () => {
  const r = await request(S.port, '/api/event/EV-20261008-141000-0004');
  assert.strictEqual(r.status, 200, r.text);
  const d = r.json;
  assert.strictEqual(d.event.id, 'EV-20261008-141000-0004');
  assert.deepStrictEqual(d.event.steps, ['Li', 'Salvei', 'Normalizei']);
  assert.deepStrictEqual([d.event.validation, d.event.next_step, d.event.pending_decisions, d.event.duration_s, d.event.session], ['13 = 13', 'Aguardar o dono', ['P-0001'], 48, 'sess-t1']);
  assert.deepStrictEqual(d.flow, { id: F2, title: 'Revisão do repositório', created_at: sp('13:59:00'), agent: 'cerebro' });
  assert.deepStrictEqual(d.sequence.map((x) => x.id), ['EV-20261008-140000-0001', 'EV-20261008-140100-0002', 'EV-20261008-140200-0003', 'EV-20261008-141000-0004', 'EV-20261008-141500-0005']);
  assert.deepStrictEqual(d.initial_request && [d.initial_request.text, d.initial_request.origin, d.initial_request.source], [`Revise o repositório. ${F2}`, 'dono-direto', 'event_prompt']);
  // With flow_id: those of the 2 agents; without flow_id: only the Coordinator's, session sess-t1, between 14:02 and 14:10.
  assert.deepStrictEqual(d.raw_commands.map((c) => [c.ts.slice(11, 19), c.correlation]), [
    ['13:59:50', 'flow_id'], ['14:00:30', 'flow_id'], ['14:02:30', 'flow_id'], ['14:05:00', 'flow_id'], ['14:06:00', 'flow_id'], ['14:07:00', 'window'],
  ]);
  assert.deepStrictEqual(d.window_without_flow, { start: sp('14:02:00'), end: sp('14:10:00'), session: 'sess-t1' });
  const failure = d.raw_commands[4];
  assert.deepStrictEqual([failure.agent, failure.hook_event, failure.tool, failure.input, failure.ok, failure.session, failure.error], ['coordenador', 'PostToolUseFailure', 'Bash', 'node normalizar.js', false, 'sess-t1', 'exit 1']);
  assert.strictEqual(d.raw_commands[0].agent, 'cerebro');
  assert.deepStrictEqual([d.previous_id, d.next_id], ['EV-20261008-140200-0003', 'EV-20261008-141500-0005']);
  assert.strictEqual(d.raw_commands_warnings, null);
  // A flow without a pedido-recebido event: the initial request comes from the raw prompt that brought the id.
  const f3 = (await request(S.port, '/api/event/EV-20261008-150000-0007')).json;
  assert.deepStrictEqual([f3.initial_request.origin, f3.initial_request.source, f3.initial_request.origin_inferred], ['rotina', 'prompt', true]);
  assert.ok(f3.initial_request.text.includes(F3));
  assert.strictEqual(f3.flow.title, null);
  assert.deepStrictEqual(f3.raw_commands.map((c) => c.ts.slice(11, 19)), ['14:12:00', '14:59:00', '15:00:30']);
  // The oldest has no previous; a missing event is 404.
  const oldest = (await request(S.port, '/api/event/EV-20260815-100000-aaaa')).json;
  assert.strictEqual(oldest.previous_id, null);
  const none = await request(S.port, '/api/event/EV-NAO-EXISTE');
  assert.strictEqual(none.status, 404);
  assert.deepStrictEqual(none.json, { error: { code: 'event_not_found', id: 'EV-NAO-EXISTE' } });
});

suite.test('GET /api/flow/<id>: events in order, flow commands, tests only on request, 404', async () => {
  const r = await request(S.port, `/api/flow/${F2}`);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.flow.title, 'Revisão do repositório');
  assert.strictEqual(r.json.events.length, 5);
  assert.strictEqual(r.json.events[0].summary, 'Pedido do dono: revisar o repositório');
  // Like "registrar fluxo": with flow_id + each event's window (the 14:01:30 SessionStart falls in the window
  // of the Coordinator's pedido-recebido, which starts at the flow's created_at, 13:59).
  assert.deepStrictEqual(r.json.raw_commands.map((c) => [c.ts.slice(11, 19), c.correlation]), [
    ['13:59:50', 'flow_id'], ['14:00:30', 'flow_id'], ['14:01:30', 'window'], ['14:02:30', 'flow_id'], ['14:05:00', 'flow_id'], ['14:06:00', 'flow_id'], ['14:07:00', 'window'],
  ]);
  assert.deepStrictEqual([r.json.initial_request.source, r.json.initial_request.text], ['event_prompt', `Revise o repositório. ${F2}`]);
  assert.strictEqual((await request(S.port, `/api/flow/${F2}?include_tests=1`)).json.events.length, 6);
  const only = await request(S.port, '/api/flow/F-20261009-0001');
  assert.strictEqual(only.status, 200);
  assert.deepStrictEqual([only.json.flow.title, only.json.events.length], ['Fluxo só no contador', 0]);
  const missing = await request(S.port, '/api/flow/F-99999999-9999');
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(missing.json, { error: { code: 'flow_not_found', id: 'F-99999999-9999' } });
});

suite.test('POST /api/recalculate requires X-Panel; with it, runs the collector and returns the state', async () => {
  const without = await request(S.port, '/api/recalculate', { method: 'POST' });
  assert.strictEqual(without.status, 403);
  assert.deepStrictEqual(without.json, { error: { code: 'missing_panel_header', header: 'X-Panel' } });
  const wrong = await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '0' } });
  assert.strictEqual(wrong.status, 403);
  const old = await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Painel': '1' } });
  assert.strictEqual(old.status, 403, 'the old Portuguese header no longer works');
  const outside = await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1', Origin: 'http://evil.example' } });
  assert.strictEqual(outside.status, 403);
  assert.deepStrictEqual(outside.json, { error: { code: 'origin_not_allowed' } });
  const ok = await request(S.port, '/api/recalculate', { method: 'POST', headers: { 'X-Panel': '1', Origin: `http://127.0.0.1:${S.port}` }, body: '{}' });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.json.recalculation.ok, true);
  assert.strictEqual(ok.json.generated_at, NOW);
  assert.ok(ok.json.kpis && ok.json.agents && ok.json.events);
  assert.strictEqual(ok.json.usage.collection.bytes_read, 0, 'recalculating again reads only what changed');
  assert.strictEqual(ok.json.collector.last.trigger, 'recalculate');
});

suite.test('POST /api/brain: 501 for a future phase (and 403 without X-Panel)', async () => {
  const r = await request(S.port, '/api/brain', { method: 'POST', headers: POST });
  assert.strictEqual(r.status, 501);
  assert.deepStrictEqual(r.json, { error: { code: 'not_implemented', feature: 'brain' } });
  assert.strictEqual((await request(S.port, '/api/brain', { method: 'POST' })).status, 403);
});

suite.test('forged Host → 403 (including variations); localhost and upper case accepted', async () => {
  const p = S.port;
  for (const host of ['evil.example', `evil.example:${p}`, `127.0.0.1:${p}.`, `127.0.0.1.:${p}`, '127.0.0.1', 'localhost', `127.0.0.1:4777`, `[::1]:${p}`, `0.0.0.0:${p}`, `127.0.0.2:${p}`, `localhost.:${p}`, `127.0.0.1:${p}@evil`, ` 127.0.0.1:${p}x`]) {
    const r = await request(p, '/api/state', { host });
    assert.strictEqual(r.status, 403, `Host "${host}" should be 403`);
    assert.ok(!r.text.includes('"agents"'));
  }
  assert.deepStrictEqual((await request(p, '/api/state', { host: 'evil.example' })).json, { error: { code: 'host_not_allowed', port: p } });
  // Empty, missing (HTTP/1.0 and 1.1) or duplicated Host: refused (Node's 400 or the panel's 403), never 200.
  for (const raw of [
    'GET /api/state HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n',
    'GET /api/state HTTP/1.1\r\nConnection: close\r\n\r\n',
    'GET /api/state HTTP/1.0\r\n\r\n',
    `GET /api/state HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    `GET http://evil.example/api/state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
  ]) {
    const r = await rawRequest(p, raw);
    assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(raw)} → ${r.status}`);
    assert.ok(!r.text.includes('"agents"'));
  }
  const absolute = await rawRequest(p, `GET http://127.0.0.1:${p}/api/state HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`);
  assert.strictEqual(absolute.status, 404, 'an absolute URL is not a route');
  assert.strictEqual((await request(p, '/', { host: 'evil.example' })).status, 403);
  assert.strictEqual((await request(p, '/api/recalculate', { method: 'POST', host: 'evil.example', headers: POST })).status, 403);
  assert.strictEqual((await request(p, '/api/state', { host: `localhost:${p}` })).status, 200);
  assert.strictEqual((await request(p, '/api/state', { host: `LOCALHOST:${p}` })).status, 200);
});

suite.test('odd paths → 404; wrong methods → 405; no file served', async () => {
  const p = S.port;
  for (const c of ['/index.html', '/server.js', '/README.md', '/tests/mock-state.json', '/../registro/agentes.json', '/%2e%2e/registro/agentes.json',
    '/..%2f..%2fregistro%2fagentes.json', '//etc/passwd', '/api', '/api/', '/api/state/', '/api/state/x', '/api/event/', '/api/event/..%2f..%2fregistro%2fagentes.json',
    '/api/event/%2e%2e', '/api/flow/a/b', '/api/event/%E0%A4%A', '/API/STATE', '/state/panel.pid', '/favicon.ico']) {
    const r = await request(p, c);
    assert.strictEqual(r.status, 404, `${c} should be 404 (got ${r.status})`);
    assert.ok(!r.text.includes('coordenador'), `${c} leaked data`);
  }
  assert.deepStrictEqual((await request(p, '/api')).json, { error: { code: 'route_not_found' } });
  const put = await request(p, '/api/state', { method: 'PUT' });
  assert.strictEqual(put.status, 405);
  assert.strictEqual(put.headers.allow, 'GET, HEAD');
  assert.deepStrictEqual(put.json, { error: { code: 'method_not_allowed', method: 'PUT', allowed: ['GET', 'HEAD'] } });
  const opt = await request(p, '/api/state', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.strictEqual(opt.status, 405);
  assert.ok(!Object.keys(opt.headers).some((h) => h.startsWith('access-control-')));
  assert.strictEqual((await request(p, '/api/recalculate')).status, 405);
  assert.strictEqual((await request(p, '/api/state', { method: 'POST', headers: POST })).status, 405);
});

suite.test('gzip when the client accepts it; the answer is still valid JSON', async () => {
  const r = await request(S.port, '/api/state', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-encoding'], 'gzip');
  const e = JSON.parse(zlib.gunzipSync(r.buf).toString('utf8'));
  assert.strictEqual(e.workspace.name, 'Exemplo');
});

suite.test('tolerant reading: a new event shows up without restarting; unreadable files become a reason, not an error', async () => {
  const octFile = path.join(R.m, 'logs', 'eventos', '2026-10.jsonl');
  // Completes the half line and adds another one.
  fs.appendFileSync(octFile, ',"fluxo_id":"F-20261008-0004","origem":"cerebro","tipo":"aviso","resumo":"Linha completada depois","resultado":"ok"}\n');
  let e = (await request(S.port, '/api/state')).json;
  assert.strictEqual(e.events[0].id, 'EV-20261008-155900-0010');
  fs.writeFileSync(path.join(R.m, 'estado', 'pendencias.json'), '{"pendencias": [');
  e = (await request(S.port, '/api/state')).json;
  assert.deepStrictEqual(e.kpis.pending_decisions, { total: 0, by_severity: { critica: 0, alta: 0, normal: 0, baixa: 0 } });
  const reason = e.health.reasons.find((x) => x.code === 'file_unreadable');
  assert.ok(reason, JSON.stringify(e.health.reasons));
  assert.strictEqual(reason.file, 'estado/pendencias.json');
  assert.strictEqual(reason.error.code, 'invalid_json');
});

suite.test('killing by the printed PID frees the port', async () => {
  kill(S.pid);
  await waitFor(() => !pidAlive(S.pid), 10000);
  await assert.rejects(request(S.port, '/api/state'));
  S = null;
});

suite.test('empty root: everything missing becomes null/zero with clear reason codes; collector unavailable; old Trello variables ignored', async () => {
  const root = tmpDir('server-empty');
  roots.push(root);
  const r = { m: path.join(root, 'maestro'), maestri: path.join(root, 'maestri'), claude: path.join(root, 'claude'), index: path.join(root, 'does-not-exist.html') };
  const s = await start(r, { PANEL_COLLECTOR: '0', PAINEL_TRELLO_JANELA: 'lixo', PAINEL_TRELLO_INTERVALO_MIN: '0' });
  try {
    const idx = await request(s.port, '/');
    assert.strictEqual(idx.status, 503);
    assert.ok(idx.text.includes('não foi encontrado'));
    const e = (await request(s.port, '/api/state')).json;
    assert.deepStrictEqual(e.agents, []);
    assert.deepStrictEqual(e.events, []);
    assert.deepStrictEqual(e.pending_decisions, []);
    assert.strictEqual(e.usage, null);
    assert.strictEqual(e.kpis.usage.available, false);
    assert.deepStrictEqual(e.kpis.usage.reason, { code: 'collector_not_run' });
    assert.strictEqual(e.health.level, 'yellow');
    assert.deepStrictEqual(e.health.reasons, [{ code: 'registry_missing', file: 'registro/agentes.json' }], 'only the missing registry');
    assert.strictEqual(e.health.last_event_age_min, null);
    assert.deepStrictEqual(e.collector, { interval_min: 5, active: false, last: null, running: false });
    assert.strictEqual((await request(s.port, '/api/events')).json.total, 0);
    // Without the Maestri file, recalculating writes a usage.json with the plan unavailable.
    const rc = await request(s.port, '/api/recalculate', { method: 'POST', headers: POST });
    assert.strictEqual(rc.status, 200);
    assert.strictEqual(rc.json.kpis.usage.available, false);
    assert.strictEqual(rc.json.kpis.usage.reason.code, 'plan_file_missing');
    assert.ok(rc.json.kpis.usage.reason.file.endsWith('.status.json'));
  } finally {
    kill(s.pid);
  }
});

suite.test('port in use: clear message and exit 1; invalid port: exit 2', async () => {
  const root = tmpDir('server-port');
  roots.push(root);
  const r = { m: path.join(root, 'maestro'), maestri: path.join(root, 'maestri'), claude: path.join(root, 'claude'), index: path.join(root, 'x.html') };
  const s = await start(r, { PANEL_COLLECTOR: '0' });
  try {
    const { spawnSync } = require('child_process');
    const dup = spawnSync(process.execPath, [SERVER, '--port', String(s.port)], { env: environment(r, { PANEL_COLLECTOR: '0' }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(dup.status, 1);
    assert.ok(dup.stderr.includes('já está em uso'), dup.stderr);
    const bad = spawnSync(process.execPath, [SERVER, '--port', 'abc'], { env: environment(r), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(bad.status, 2);
    assert.ok(bad.stderr.includes('Porta inválida'));
    const envPort = spawnSync(process.execPath, [SERVER], { env: environment(r, { PANEL_PORT: 'xyz' }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(envPort.status, 2, 'PANEL_PORT is read');
  } finally {
    kill(s.pid);
  }
});

suite.test('in process: start() writes the PID and stop() deletes it; Host checked against the real port', async () => {
  const root = tmpDir('server-inproc');
  roots.push(root);
  const m = path.join(root, 'maestro');
  const port = await freePort();
  const env = { MAESTRO_DIR: m, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(root, 'x.html'), MAESTRI_DATA_DIR: path.join(root, 'maestri') };
  const s = await srv.start({ argv: ['--port', String(port)], env });
  const pidFile = path.join(m, 'state', 'panel.pid');
  try {
    assert.strictEqual(Number(fs.readFileSync(pidFile, 'utf8')), process.pid);
    assert.strictEqual((await request(port, '/api/state')).status, 200);
    assert.strictEqual((await request(port, '/api/state', { host: `127.0.0.1:${port + 1}` })).status, 403);
  } finally {
    await s.stop();
  }
  assert.ok(!fs.existsSync(pidFile), 'stop() must delete state/panel.pid');
});

suite.test('health: stopped hooks and unreadable files', () => {
  const v = srv.computeHealth({ hooks: [] });
  assert.deepStrictEqual([v.level, v.reasons], ['green', []]);
  assert.deepStrictEqual(Object.keys(v).sort(), ['level', 'reasons']);
  const h = srv.computeHealth({ hooks: [
    { agent: 'a', name: 'Agente A', active: true, last_raw: null, age_min: null },
    { agent: 'b', name: 'Agente B', active: true, last_raw: 'x', age_min: 25 * 60 },
    { agent: 'c', name: 'Agente C', active: true, last_raw: 'x', age_min: 23 * 60 },
    { agent: 'd', name: 'Agente D', active: false, last_raw: null, age_min: null },
  ] });
  assert.strictEqual(h.level, 'yellow');
  assert.deepStrictEqual(h.reasons, [{ code: 'hook_never', agent: 'a', name: 'Agente A' }, { code: 'hook_stale', agent: 'b', name: 'Agente B', minutes: 25 * 60 }]);
  const problem = { code: 'file_unreadable', file: 'estado/pendencias.json', error: { code: 'invalid_json', detail: 'x' } };
  const p = srv.computeHealth({ hooks: [], problems: [problem] });
  assert.deepStrictEqual([p.level, p.reasons], ['yellow', [problem]]);
});

suite.test('routes and request origin: traversal refused; envelopes recognized', () => {
  for (const c of ['/api/event/..%2Fx', '/api/event/.x', '/api/event/a%00b', '/api/flow/%2e%2e%2f']) assert.strictEqual(srv.findRoute(c), null, c);
  assert.deepStrictEqual(srv.findRoute('/api/event/EV-1'), { name: 'event', methods: ['GET', 'HEAD'], id: 'EV-1' });
  const byName = new Map([['cerebro principal', 'cerebro'], ['coordenador', 'coordenador']]);
  assert.strictEqual(srv.promptOrigin('[ROTINA] Leia o quadro', byName), 'rotina');
  assert.strictEqual(srv.promptOrigin('[PEDIDO] F-1\nDe: Cérebro Principal → Para: Coordenador', byName), 'cerebro');
  assert.strictEqual(srv.promptOrigin('[AVISO] F-1\nDe: Coordenador → Para: Cérebro Principal', byName), 'agente:coordenador');
  assert.strictEqual(srv.promptOrigin('oi, leia o quadro', byName), 'dono-direto');
  assert.strictEqual(srv.agentFolder('desconhecido:abc'), 'desconhecido-abc');
  assert.strictEqual(srv.agentFolder('../x'), 'x');
});

suite.test('JsonlReader: incremental, incomplete last line, replaced file', async () => {
  const root = tmpDir('server-reader');
  roots.push(root);
  const file = path.join(root, 'a.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":');
  const reader = new srv.JsonlReader();
  let e = await reader.read(file);
  assert.deepStrictEqual(e.lines.map((x) => x.a), [1, 2]);
  fs.appendFileSync(file, '3}\njunk\n{"a":4}');
  e = await reader.read(file);
  assert.deepStrictEqual(e.lines.map((x) => x.a), [1, 2, 3, 4]);
  assert.strictEqual(e.invalid, 1);
  fs.appendFileSync(file, '\n{"a":5}\n');
  e = await reader.read(file);
  assert.deepStrictEqual(e.lines.map((x) => x.a), [1, 2, 3, 4, 5]);
  fs.writeFileSync(file, '{"a":9}\n');
  e = await reader.read(file);
  assert.deepStrictEqual(e.lines.map((x) => x.a), [9]);
  fs.rmSync(file);
  e = await reader.read(file);
  assert.deepStrictEqual([e.exists, e.lines.length], [false, 0]);
  // Memory ceiling: with a 100-byte budget only the most recent files are kept.
  const small = new srv.JsonlReader({ maxBytes: 100 });
  for (const n of ['b', 'c', 'd']) {
    fs.writeFileSync(path.join(root, `${n}.jsonl`), `${JSON.stringify({ n, x: 'y'.repeat(40) })}\n`);
    const r = await small.read(path.join(root, `${n}.jsonl`));
    assert.strictEqual(r.lines[0].n, n);
  }
  assert.ok(small.map.size <= 2 && small.storedBytes() <= 100, `kept ${small.map.size} files`);
});

suite.test('initial request: the owner prompt without flow_id before pedido-recebido; neighbors only with a valid id', async () => {
  const root = tmpDir('server-request');
  roots.push(root);
  const m = path.join(root, 'maestro');
  writeJson(path.join(m, 'registro', 'agentes.json'), { workspace: { nome: 'Exemplo' }, agentes: [{ slug: 'cerebro', nome: 'Cérebro Principal', status: 'ativo' }] });
  const F = 'F-20261008-0005';
  const d = (hms) => `2026-10-08T${hms}-03:00`;
  writeJsonl(path.join(m, 'logs', 'eventos', '2026-10.jsonl'), [
    ev({ id: 'EV-20261008-050000-0001', ts: d('05:00:00'), agente: 'cerebro', fluxo_id: 'F-20261008-0004', tipo: 'execucao', resumo: 'Antes', sessao: 's1' }),
    ev({ id: 'EV-20261008-061100-0002', ts: d('06:11:00'), agente: 'cerebro', fluxo_id: F, origem: 'dono-direto', tipo: 'pedido-recebido', resumo: 'Pedido do dono: mover D: Ambiente de testes', sessao: 's1' }),
    { id: 5, ts: 5, agente: 5 },
    ev({ id: 'EV-20261008-061644-0003', ts: d('06:16:44'), agente: 'cerebro', fluxo_id: F, tipo: 'execucao', resumo: 'Movido', sessao: 's1' }),
    { id: 'EV com espaço', ts: d('06:20:00'), agente: 'cerebro', resumo: 'id inválido' },
  ]);
  writeJsonl(path.join(m, 'logs', 'raw', 'cerebro', '2026-10-08.jsonl'), [
    { ts: d('05:30:00'), agent: 'cerebro', session: 's1', hook_event: 'UserPromptSubmit', prompt: 'Prompt antigo, de antes do evento anterior? não: depois dele', cwd: 'C:/x' },
    { ts: d('06:10:44'), agent: 'cerebro', session: 's1', hook_event: 'UserPromptSubmit', prompt: 'Mova o D: Ambiente de testes para Em andamento e confira se o espelho está certo.', cwd: 'C:/x' },
    { ts: d('06:10:50'), agent: 'cerebro', session: 'outra', hook_event: 'UserPromptSubmit', prompt: 'Outra sessão', cwd: 'C:/x' },
    { ts: d('06:12:00'), agent: 'cerebro', session: 's1', flow_id: F, hook_event: 'PostToolUse', tool: 'Bash', input: 'node mover.js', ok: true, cwd: 'C:/x' },
  ]);
  const port = await freePort();
  const env = { MAESTRO_DIR: m, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(root, 'x.html'), MAESTRI_DATA_DIR: path.join(root, 'maestri'), PANEL_NOW: d('07:00:00') };
  const s = await srv.start({ argv: ['--port', String(port)], env });
  try {
    const r = await request(port, '/api/event/EV-20261008-061644-0003');
    assert.strictEqual(r.status, 200, r.text);
    const p = r.json.initial_request;
    assert.deepStrictEqual([p.text, p.origin, p.source, p.ts], ['Mova o D: Ambiente de testes para Em andamento e confira se o espelho está certo.', 'dono-direto', 'event_prompt', d('06:10:44')]);
    assert.strictEqual((await request(port, `/api/flow/${F}`)).json.initial_request.text, p.text);
    // An id that is not text (or out of format) is neither a neighbor nor in the list; it becomes a warning.
    assert.deepStrictEqual([r.json.previous_id, r.json.next_id], ['EV-20261008-061100-0002', null]);
    const st = (await request(port, '/api/state')).json;
    assert.deepStrictEqual(st.events.map((e) => e.id), ['EV-20261008-061644-0003', 'EV-20261008-061100-0002', 'EV-20261008-050000-0001']);
    assert.deepStrictEqual(st.warnings, [{ code: 'event_lines_ignored', file: 'logs/eventos/2026-10.jsonl', count: 2 }]);
    // No prompt found in the window: falls back to the event summary.
    fs.writeFileSync(path.join(m, 'logs', 'raw', 'cerebro', '2026-10-08.jsonl'), '');
    const without = (await request(port, '/api/event/EV-20261008-061644-0003')).json.initial_request;
    assert.deepStrictEqual([without.text, without.source], ['Pedido do dono: mover D: Ambiente de testes', 'event']);
  } finally {
    await s.stop();
  }
});

suite.test('flowDays: a long flow keeps the 1st day and the most recent ones; marks the cut', () => {
  const days = srv.flowDays('F-20260701-0001', [{ _day: '2026-07-01', resultado: 'em-andamento' }, { _day: '2026-10-08', resultado: 'em-andamento' }], '2026-10-08');
  assert.strictEqual(days.length, 62);
  assert.deepStrictEqual([days[0], days[1], days[2], days[days.length - 1]], ['2026-06-30', '2026-07-01', '2026-08-10', '2026-10-08']);
  assert.strictEqual(days.cut, 101 - 62);
  const short = srv.flowDays('F-20261001-0001', [{ _day: '2026-10-01', resultado: 'ok' }], '2026-10-08');
  assert.deepStrictEqual([short[0], short[short.length - 1], short.cut], ['2026-09-30', '2026-10-02', 0]);
});

suite.test('RawIndex: incremental, incomplete last line, replaced file, read ceiling, re-read by position', async () => {
  const root = tmpDir('server-index');
  roots.push(root);
  const file = path.join(root, '2026-10-08.jsonl');
  const l = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(file, l({ ts: sp('10:00:00'), flow_id: 'F-1', hook_event: 'PostToolUse', input: 'á' }) + l({ ts: sp('10:01:00'), session: 's', hook_event: 'UserPromptSubmit', prompt: 'faça F-20261008-0009 agora' }) + '{"ts":');
  const index = new srv.RawIndex();
  let e = await index.read(file);
  assert.deepStrictEqual([e.col.n, [...e.byFlow.keys()], [...e.cited.keys()]], [2, ['F-1'], ['F-20261008-0009']]);
  fs.appendFileSync(file, `"${sp('10:02:00')}","flow_id":"F-1","input":"x"}\njunk\n`);
  e = await index.read(file);
  assert.deepStrictEqual([e.col.n, e.byFlow.get('F-1'), e.invalid], [3, [0, 2], 1]);
  const read = await index.materialize(e, [2, 0]);
  assert.deepStrictEqual([read.get(0).input, read.get(2).input, read.get(2)._t], ['á', 'x', Date.parse(sp('10:02:00'))]);
  // Bytes ceiling per request: the file that does not fit stays pending and enters on the next one.
  const other = path.join(root, 'other.jsonl');
  fs.writeFileSync(other, l({ ts: sp('11:00:00'), flow_id: 'F-2' }).repeat(50));
  const budget = { left: 10, read: 5 };
  const p = await index.read(other, budget);
  assert.deepStrictEqual([p.pending, p.col.n], [true, 0]);
  assert.deepStrictEqual([(await index.read(other, { left: 1e6, read: 0 })).col.n], [50]);
  // File replaced by a smaller one: reindexes from scratch.
  fs.writeFileSync(file, l({ ts: sp('12:00:00'), flow_id: 'F-3' }));
  e = await index.read(file);
  assert.deepStrictEqual([e.col.n, [...e.byFlow.keys()]], [1, ['F-3']]);
  // Ceiling of stored lines: the oldest file leaves the cache.
  const small = new srv.RawIndex({ maxLines: 40 });
  await small.read(file);
  await small.read(other);
  await small.read(path.join(root, 'does-not-exist.jsonl'));
  assert.ok(small.storedLines() === 50 && small.map.size === 1, `kept ${small.map.size}`);
});

suite.test('state: null items in the usage lists are dropped', () => {
  const usage = srv.cleanUsage({ by_agent: { window_5h: [null, 5, { agent: 'a' }], today: [] } });
  assert.deepStrictEqual(usage.by_agent, { window_5h: [{ agent: 'a' }], today: [] });
});

suite.run().then(() => {
  if (S) kill(S.pid);
  if (!process.env.KEEP_TMP) for (const r of roots) remove(r);
});
