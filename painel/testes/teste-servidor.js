'use strict';
// Testes do painel/servidor.js: raiz falsa em testes/tmp/, servidor numa porta entre 4790 e 4799.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const {
  assert, MAESTRO, criarSuite, pastaTmp, apagar, escreverJson, escreverJsonl, linhaAssistente,
  portaLivre, pedir, pedirCru, esperarAte, derrubar, pidVivo,
} = require('./util');

const SERVIDOR = path.join(MAESTRO, 'painel', 'servidor.js');
const srv = require(SERVIDOR);

const AGORA = '2026-10-08T15:50:00-03:00';
const T_AGORA = Date.parse(AGORA);
const sp = (hhmm, dia = '2026-10-08') => `${dia}T${hhmm}-03:00`;
const F2 = 'F-20261008-0002';
const F3 = 'F-20261008-0003';
const F4 = 'F-20261008-0004';
const INDEX = '<!doctype html><meta charset="utf-8"><title>Painel de teste</title><p>ok</p>';

const suite = criarSuite('servidor do painel (painel/servidor.js)');
const raizes = [];

function ev(campos) {
  return Object.assign({ origem: 'cerebro', direcao: null, resultado: 'ok', precisa_dono: false, passos: [], comandos: [], alteracoes: [], pendencias: [] }, campos);
}

/** Raiz falsa realista: registro, eventos de 3 meses, log bruto, pendências, fluxos, Trello e uso. */
function montarRaiz(nome) {
  const raiz = pastaTmp(`servidor-${nome}`);
  raizes.push(raiz);
  const m = path.join(raiz, 'maestro');
  const maestri = path.join(raiz, 'maestri');
  const claude = path.join(raiz, 'claude');
  escreverJson(path.join(m, 'registro', 'agentes.json'), {
    workspace: { id: 'ws-teste', nome: 'Exemplo', raiz: 'C:/teste/raiz' },
    padrao: { modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh' },
    agentes: [
      { slug: 'cerebro', nome: 'Cérebro Principal', tipo: 'maestro', cor: '#E8C547', responsabilidade: 'Cérebro Principal', terminal_id: 't1', diretorios: [], modelo: 'claude-opus-5-5[1m]', nivel: 'max', conectado_a: ['coordenador-trello'], skills: ['orquestracao'], status: 'ativo', desde: '2026-10-08' },
      { slug: 'coordenador-trello', nome: 'Coordenador do Trello', tipo: 'sub-cerebro', cor: '#3B82F6', responsabilidade: 'Coordenador do Trello', terminal_id: 't2', diretorios: [], conectado_a: ['cerebro'], skills: ['trello-leitura'], status: 'ativo', desde: '2026-10-08' },
      { slug: 'auditor', nome: 'Agente Auditor', tipo: 'sub-cerebro', cor: '#10B981', responsabilidade: 'Auditor', status: 'ativo', skills: [], conectado_a: [] },
      { slug: 'futuro', nome: 'Agente Futuro', tipo: 'sub-cerebro', cor: '#999999', status: 'a-criar', skills: [], conectado_a: [] },
    ],
  });
  const ev0 = ev({ id: 'EV-20260815-100000-aaaa', ts: '2026-08-15T10:00:00-03:00', agente: 'cerebro', fluxo_id: 'F-20260815-0001', origem: 'dono-direto', tipo: 'execucao', resumo: 'Evento antigo de agosto', direcao: 'Antigo' });
  escreverJsonl(path.join(m, 'logs', 'eventos', '2026-08.jsonl'), [ev0]);
  escreverJsonl(path.join(m, 'logs', 'eventos', '2026-09.jsonl'), [
    ev({ id: 'EV-20260920-090000-bbbb', ts: '2026-09-20T09:00:00-03:00', agente: 'coordenador-trello', fluxo_id: 'F-20260920-0001', tipo: 'relatorio', projeto: 'D', resumo: 'RST de setembro gerado' }),
  ]);
  const outubro = [
    ev({ id: 'EV-20261008-140000-0001', ts: sp('14:00:00'), agente: 'cerebro', fluxo_id: F2, origem: 'dono-direto', tipo: 'pedido-recebido', resumo: 'Pedido do dono: ler o quadro do Trello', sessao: 'sess-c1' }),
    ev({ id: 'EV-20261008-140100-0002', ts: sp('14:01:00'), agente: 'cerebro', fluxo_id: F2, tipo: 'delegacao', resumo: 'Delegada a leitura ao Coordenador', direcao: 'Deleguei porque o Trello é do Coordenador.', resultado: 'em-andamento', sessao: 'sess-c1' }),
    ev({ id: 'EV-20261008-140200-0003', ts: sp('14:02:00'), agente: 'coordenador-trello', fluxo_id: F2, tipo: 'pedido-recebido', resumo: 'Pedido recebido do Cérebro: leitura', sessao: 'sess-t1' }),
    ev({
      id: 'EV-20261008-141000-0004', ts: sp('14:10:00'), agente: 'coordenador-trello', fluxo_id: F2, tipo: 'execucao', projeto: 'A',
      trello: { shortLink: 'abc1', titulo: 'A: 05/10 - Testar o fluxo de ponta a ponta', url: 'https://trello.com/c/abc1', status_antes: 'Em andamento', status_depois: 'Em andamento' },
      resumo: 'Leitura do quadro concluída e RST gerado', direcao: 'Usei o JSON do quadro em vez da interface porque traz espelhos e checklists numa leitura só.',
      passos: ['Naveguei', 'Salvei', 'Normalizei'], comandos: ['maestri portal navigate'], validacao: '13 = 13', proximo_passo: 'Aguardar o dono', pendencias: ['P-0001'], duracao_s: 48, sessao: 'sess-t1',
    }),
    ev({ id: 'EV-20261008-141500-0005', ts: sp('14:15:00'), agente: 'cerebro', fluxo_id: F2, origem: 'agente:coordenador-trello', tipo: 'resposta-recebida', resumo: 'Resposta do Coordenador recebida', sessao: 'sess-c1' }),
    ev({ id: 'EV-20261008-142000-0006', ts: sp('14:20:00'), agente: 'cerebro', fluxo_id: F2, tipo: 'execucao', resumo: 'Evento de teste', direcao: 'x', teste: true }),
    ev({ id: 'EV-20261008-150000-0007', ts: sp('15:00:00'), agente: 'coordenador-trello', fluxo_id: F3, origem: 'rotina', tipo: 'auditoria', projeto: 'B', resumo: 'Auditoria falhou: portal fora do ar', direcao: 'Tentei o portal duas vezes.', resultado: 'falhou', sessao: 'sess-t1' }),
    '{"id": "EV-QUEBRADO", "ts": ',
    ev({ id: 'EV-20261008-152000-0008', ts: sp('15:20:00'), agente: 'cerebro', fluxo_id: F4, origem: 'dono-direto', tipo: 'decisao', resumo: 'Decisão sobre etiquetas pendente', direcao: 'Precisa do dono.', resultado: 'aguardando-dono', precisa_dono: true }),
    ev({ id: 'EV-20261007-230000-0009', ts: '2026-10-08T02:00:00Z', agente: 'cerebro', fluxo_id: 'F-20261007-0001', tipo: 'manutencao', resumo: 'Manutenção noturna com acentuação: ação' }),
  ];
  const arqOut = path.join(m, 'logs', 'eventos', '2026-10.jsonl');
  escreverJsonl(arqOut, outubro);
  fs.appendFileSync(arqOut, '{"id":"EV-20261008-155900-0010","ts":"2026-10-08T15:59:00-03:00","agente":"cerebro"');

  // Log bruto
  const bruto = (pasta, dia, linhas) => escreverJsonl(path.join(m, 'logs', 'bruto', pasta, `${dia}.jsonl`), linhas);
  bruto('cerebro', '2026-10-08', [
    { ts: sp('13:59:50'), agente: 'cerebro', terminal: 't1', sessao: 'sess-c1', fluxo_id: F2, evento: 'UserPromptSubmit', prompt: `Leia o quadro do Trello. ${F2}`, cwd: 'C:/x' },
    { ts: sp('14:00:30'), agente: 'cerebro', terminal: 't1', sessao: 'sess-c1', fluxo_id: F2, evento: 'PostToolUse', ferramenta: 'Bash', entrada: 'node registrar.js novo-fluxo', ok: true, cwd: 'C:/x' },
    { ts: sp('14:30:00'), agente: 'cerebro', terminal: 't1', sessao: 'sess-c1', evento: 'PostToolUse', ferramenta: 'Read', entrada: 'C:/x/arquivo.md', ok: true, cwd: 'C:/x' },
    { ts: sp('15:10:00'), agente: 'cerebro', terminal: 't1', sessao: 'sess-c1', fluxo_id: F4, evento: 'UserPromptSubmit', prompt: 'Decida as etiquetas', cwd: 'C:/x' },
  ]);
  bruto('coordenador-trello', '2026-10-07', [
    { ts: sp('22:00:00', '2026-10-07'), agente: 'coordenador-trello', sessao: 'sess-t0', evento: 'SessionStart', cwd: 'C:/y' },
  ]);
  bruto('coordenador-trello', '2026-10-08', [
    { ts: sp('14:01:30'), agente: 'coordenador-trello', sessao: 'sess-t1', evento: 'SessionStart', cwd: 'C:/y' },
    { ts: sp('14:02:30'), agente: 'coordenador-trello', sessao: 'sess-t1', fluxo_id: F2, evento: 'UserPromptSubmit', prompt: `[PEDIDO] ${F2}\nDe: Cérebro Principal → Para: Coordenador do Trello\nPedido: ler o quadro`, cwd: 'C:/y' },
    { ts: sp('14:05:00'), agente: 'coordenador-trello', sessao: 'sess-t1', fluxo_id: F2, evento: 'PostToolUse', ferramenta: 'Bash', entrada: 'maestri portal navigate "trello.com"', ok: true, saida_resumo: 'ok', duracao_ms: 900, cwd: 'C:/y' },
    { ts: sp('14:06:00'), agente: 'coordenador-trello', sessao: 'sess-t1', fluxo_id: F2, evento: 'PostToolUseFailure', ferramenta: 'Bash', entrada: 'node normalizar.js', ok: false, erro: 'exit 1', cwd: 'C:/y' },
    { ts: sp('14:07:00'), agente: 'coordenador-trello', sessao: 'sess-t1', evento: 'PostToolUse', ferramenta: 'Read', entrada: 'C:/y/quadro.json', ok: true, cwd: 'C:/y' },
    { ts: sp('14:08:00'), agente: 'coordenador-trello', sessao: 'sess-OUTRA', evento: 'PostToolUse', ferramenta: 'Grep', entrada: 'padrão', ok: true, cwd: 'C:/y' },
    'linha quebrada {',
    { ts: sp('14:12:00'), agente: 'coordenador-trello', sessao: 'sess-t1', evento: 'PostToolUse', ferramenta: 'Bash', entrada: 'depois do evento', ok: true, cwd: 'C:/y' },
    { ts: sp('14:59:00'), agente: 'coordenador-trello', sessao: 'sess-t1', fluxo_id: F3, evento: 'UserPromptSubmit', prompt: `[ROTINA] Auditoria do quadro ${F3}`, cwd: 'C:/y' },
    { ts: sp('15:00:30'), agente: 'coordenador-trello', sessao: 'sess-t1', fluxo_id: F3, evento: 'PostToolUse', ferramenta: 'Bash', entrada: 'maestri portal text', ok: true, cwd: 'C:/y' },
  ]);
  bruto('desconhecido-abc12345', '2026-10-08', [{ ts: sp('11:00:00'), agente: 'desconhecido:abc12345', sessao: 'sess-x', evento: 'Stop', cwd: 'C:/z' }]);
  // Pasta de arquivo morto (começa com "_"): não vira agente na saúde.
  bruto('_reatribuido-desconhecido-zz', '2026-10-08', [{ ts: sp('09:00:00'), agente: 'desconhecido:zz', sessao: 'sess-z', evento: 'SessionStart', cwd: 'C:/z' }]);

  // Pendências
  const pend = (id, campos) => Object.assign({ id, agente: 'coordenador-trello', fluxo_id: F2, tipo: 'decisao', titulo: `Pendência ${id}`, contexto: 'contexto', opcoes: ['A: sim', 'B: não'], recomendacao: 'A', trello: null, status: 'aberta', resposta: null, resolvida_em: null }, campos);
  escreverJson(path.join(m, 'estado', 'pendencias.json'), {
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
  escreverJson(path.join(m, 'estado', 'contador-fluxos.json'), {
    dias: { 20261008: { ultimo: 4 } },
    fluxos: {
      [F2]: { titulo: 'Leitura do Trello', agente: 'cerebro', criado_em: sp('13:59:00') },
      'F-20261009-0001': { titulo: 'Fluxo só no contador', agente: 'cerebro', criado_em: sp('15:40:00') },
    },
  });

  // Trello
  escreverJson(path.join(m, 'estado', 'trello', 'resumo.json'), {
    coletado_em: sp('15:20:00'), quadro: { id: 'EXEMPLO0', nome: 'Quadro Exemplo', url: 'https://trello.com/b/EXEMPLO0/quadro-exemplo' },
    totais: { abertas: 13, a_fazer: 9, em_andamento: 3, concluido: 1 },
    projetos: [{ prefixo: 'A', nome: 'Atlas', coluna: '🟩 Atlas', cor: 'green', contagem: { a_fazer: 0, em_andamento: 1, concluido: 0 }, cartoes: [] }],
    colunas_status: [], nao_classificados: [],
    auditoria: { mecanicos: [{ codigo: 'sem-espelho' }, { codigo: 'sem-espelho' }, { codigo: 'prefixo-divergente' }], decisoes: [{ codigo: 'etiqueta-nome-divergente' }, { codigo: 'sem-descricao' }] },
    caixa_de_entrada: { itens: null },
  });
  const serie = [];
  for (let i = 1; i <= 250; i++) serie.push({ coletado_em: new Date(T_AGORA - (251 - i) * 3600000).toISOString(), abertas: i, a_fazer: 1, em_andamento: 1, concluido: 0 });
  serie.splice(100, 0, '{quebrada');
  escreverJsonl(path.join(m, 'estado', 'trello', 'serie.jsonl'), serie);
  fs.writeFileSync(path.join(m, 'estado', 'trello', 'rst.md'), 'RST · Relatório de Status do Trello\nGerado: 08/10/2026 15:20\n');

  // Uso: plano do Maestri + 2 sessões com transcrição
  escreverJson(path.join(maestri, 'usage', 'providers', '.status.json'), {
    providers: [{ id: 'claude', enabled: true, state: 'ready', plan: 'max', lastSuccessAt: '2026-10-08T18:47:00Z', meters: [{ id: 'plan', windows: [
      { id: 'five_hour', usedPercent: 37, resetsAt: '2026-10-08T21:00:00Z', durationSeconds: 18000 },
      { id: 'seven_day', usedPercent: 22, resetsAt: '2026-10-13T12:00:00Z', durationSeconds: 604800 },
    ] }] }],
    updatedAt: '2026-10-08T18:47:00Z',
  });
  const tc = path.join(claude, 'projects', 'proj-c', 'sess-c1.jsonl');
  const tt = path.join(claude, 'projects', 'proj-t', 'sess-t1.jsonl');
  escreverJson(path.join(m, 'estado', 'sessoes', 'sess-c1.json'), { session_id: 'sess-c1', agente: 'cerebro', transcript_path: tc });
  escreverJson(path.join(m, 'estado', 'sessoes', 'sess-t1.json'), { session_id: 'sess-t1', agente: 'coordenador-trello', transcript_path: tt });
  escreverJsonl(tc, [linhaAssistente({ id: 'm1', ts: sp('15:00:00'), e: 100, s: 10 })]);
  escreverJsonl(tt, [linhaAssistente({ id: 'm2', ts: sp('15:10:00'), e: 50, s: 10 })]);

  const index = path.join(raiz, 'index-teste.html');
  fs.writeFileSync(index, INDEX);
  return { raiz, m, maestri, claude, index };
}

function ambiente(r, extra = {}) {
  return Object.assign({}, process.env, {
    MAESTRO_DIR: r.m, MAESTRI_DATA_DIR: r.maestri, CLAUDE_CONFIG_DIR: r.claude, PAINEL_INDEX: r.index,
    PAINEL_AGORA: AGORA, MAESTRO_AGORA: '', PAINEL_TRELLO_JANELA: '0-24', PAINEL_PORTA: '',
  }, extra);
}

/** Sobe o servidor como processo separado e devolve {porta, pid, filho, saida}. */
async function subir(r, extra = {}) {
  const porta = await portaLivre();
  const filho = spawn(process.execPath, [SERVIDOR, '--porta', String(porta)], { env: ambiente(r, extra), windowsHide: true });
  let saida = '';
  let erro = '';
  filho.stdout.on('data', (c) => { saida += c; });
  filho.stderr.on('data', (c) => { erro += c; });
  const linha = await esperarAte(() => {
    if (filho.exitCode !== null) throw new Error(`servidor saiu com ${filho.exitCode}: ${erro}`);
    const m = /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(saida);
    return m ? m : null;
  }, 15000);
  return { porta: Number(linha[1]), pid: Number(linha[2]), filho, saida: () => saida, erro: () => erro };
}

let R;
let S;

suite.teste('sobe na porta pedida, imprime o PID e grava estado/painel.pid; coletor roda ao subir', async () => {
  R = montarRaiz('principal');
  S = await subir(R);
  assert.ok(S.porta >= 4790 && S.porta <= 4799);
  assert.strictEqual(S.pid, S.filho.pid, 'o PID impresso deve ser o do processo node');
  const pidArq = fs.readFileSync(path.join(R.m, 'estado', 'painel.pid'), 'utf8').trim();
  assert.strictEqual(Number(pidArq), S.pid);
  await esperarAte(() => fs.existsSync(path.join(R.m, 'estado', 'uso.json')), 10000);
});

suite.teste('GET / devolve o index.html com no-store, CSP e sem CORS; HEAD sem corpo', async () => {
  const r = await pedir(S.porta, '/', { cabecalhos: { Origin: 'http://evil.example' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.texto, INDEX);
  assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.ok(String(r.headers['content-security-policy']).includes("default-src 'none'"));
  // Anti-clickjacking: nenhuma página de fora pode embutir o painel num iframe.
  assert.ok(String(r.headers['content-security-policy']).includes("frame-ancestors 'none'"));
  assert.strictEqual(r.headers['x-frame-options'], 'DENY');
  for (const caminho of ['/api/estado', '/nao-existe']) assert.strictEqual((await pedir(S.porta, caminho)).headers['x-frame-options'], 'DENY', caminho);
  assert.strictEqual((await pedir(S.porta, '/', { host: 'evil.example' })).headers['x-frame-options'], 'DENY');
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')), 'nenhum cabeçalho CORS');
  const h = await pedir(S.porta, '/', { metodo: 'HEAD' });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.buf.length, 0);
});

suite.teste('GET /api/estado: forma do contrato, KPIs, saúde, agentes, pendências, Trello, uso e eventos', async () => {
  const r = await pedir(S.porta, '/api/estado');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.ok(!Object.keys(r.headers).some((h) => h.startsWith('access-control-')));
  const e = r.json;
  for (const k of ['gerado_em', 'workspace', 'saude', 'kpis', 'agentes', 'pendencias', 'trello', 'trello_rst', 'serie_trello', 'uso', 'eventos']) assert.ok(k in e, `falta ${k}`);
  assert.strictEqual(e.gerado_em, AGORA);
  assert.deepStrictEqual({ nome: e.workspace.nome, raiz: e.workspace.raiz }, { nome: 'Exemplo', raiz: 'C:/teste/raiz' });
  // Saúde: Trello lido há 30 min (ok), Auditor ativo sem log bruto (amarelo), Futuro "a-criar" não conta.
  assert.strictEqual(e.saude.nivel, 'amarelo');
  assert.deepStrictEqual(e.saude.motivos, ['Agente Auditor: nenhum log bruto ainda (hooks instalados?)']);
  assert.strictEqual(e.saude.trello_idade_min, 30);
  assert.strictEqual(e.saude.ultimo_evento_idade_min, 30);
  assert.strictEqual(e.saude.uso_idade_min, 3);
  assert.strictEqual(e.saude.wire, false);
  const hook = (a) => e.saude.hooks.find((h) => h.agente === a);
  assert.strictEqual(hook('cerebro').ultimo_bruto, sp('15:10:00'));
  assert.strictEqual(hook('cerebro').idade_min, 40);
  assert.strictEqual(hook('coordenador-trello').ultimo_bruto, sp('15:00:30'));
  assert.strictEqual(hook('auditor').ultimo_bruto, null);
  assert.strictEqual(hook('desconhecido:abc12345').ultimo_bruto, sp('11:00:00'));
  assert.ok(!e.saude.hooks.some((h) => String(h.agente).startsWith('_')), 'pasta "_..." não é agente');
  // KPIs
  assert.deepStrictEqual(e.kpis.pendencias, { total: 4, critica: 1, alta: 2, normal: 1, baixa: 0 });
  assert.deepStrictEqual(
    { abertas: e.kpis.trello.abertas, a_fazer: e.kpis.trello.a_fazer, em_andamento: e.kpis.trello.em_andamento, concluido: e.kpis.trello.concluido, m: e.kpis.trello.alertas_mecanicos, d: e.kpis.trello.alertas_decisao },
    { abertas: 13, a_fazer: 9, em_andamento: 3, concluido: 1, m: 3, d: 2 },
  );
  const u = e.kpis.uso;
  assert.deepStrictEqual(
    [u.disponivel, u.janela_5h_pct, u.reset_5h, u.semanal_pct, u.reset_semanal, u.idade_min],
    [true, 37, '2026-10-08T18:00:00-03:00', 22, '2026-10-13T09:00:00-03:00', 3],
  );
  // Agentes
  assert.deepStrictEqual(e.agentes.map((a) => a.slug), ['cerebro', 'coordenador-trello', 'auditor', 'futuro']);
  const c = e.agentes[0];
  const t = e.agentes[1];
  assert.strictEqual(c.nivel, 'max');
  assert.deepStrictEqual([t.modelo, t.nivel], ['claude-opus-5-5[1m]', 'xhigh'], 'sem modelo/nível próprio vale o padrão');
  assert.deepStrictEqual(c.ultimo_evento && [c.ultimo_evento.ts, c.ultimo_evento.tipo, c.ultimo_evento.resultado], [sp('15:20:00'), 'decisao', 'aguardando-dono']);
  assert.strictEqual(t.ultimo_evento.resumo, 'Auditoria falhou: portal fora do ar');
  assert.strictEqual(c.eventos_hoje, 4);
  assert.strictEqual(t.eventos_hoje, 3);
  assert.strictEqual(c.fluxos_abertos, 1);
  assert.strictEqual(t.fluxos_abertos, 0);
  assert.strictEqual(c.ultimo_bruto, sp('15:10:00'));
  assert.deepStrictEqual(c.skills, ['orquestracao']);
  assert.deepStrictEqual(c.conectado_a, ['coordenador-trello']);
  assert.strictEqual(c.uso.janela_5h.pct_consumo, 60);
  assert.strictEqual(c.uso.janela_5h.consumo_relativo, 150);
  assert.strictEqual(c.uso.janela_5h.pct_plano_estimado, 22.2);
  assert.strictEqual(t.uso.janela_5h.pct_plano_estimado, 14.8);
  assert.strictEqual(c.uso.hoje.pct_plano_estimado, null);
  assert.strictEqual(c.uso['7d'].pct_consumo, 60);
  assert.strictEqual(e.agentes[3].uso.janela_5h.pct_consumo, 0);
  // Pendências: abertas por severidade e idade, depois respondidas, depois as fechadas mais recentes; teste fora.
  assert.deepStrictEqual(e.pendencias.map((p) => p.id), ['P-0002', 'P-0004', 'P-0001', 'P-0003', 'P-0005', 'P-0007', 'P-0006']);
  assert.strictEqual(e.pendencias[0].idade_min, 230);
  // Trello, série (últimas 200, linha quebrada ignorada) e RST
  assert.strictEqual(e.trello.quadro.id, 'EXEMPLO0');
  assert.strictEqual(e.serie_trello.length, 200);
  assert.strictEqual(e.serie_trello[199].abertas, 250);
  assert.strictEqual(e.serie_trello[0].abertas, 51);
  assert.ok(e.trello_rst.startsWith('RST · Relatório de Status do Trello'));
  assert.strictEqual(e.uso.nota, 'o % por agente é estimado; o % do plano vem do Maestri/Claude');
  // Eventos: 2 meses mais recentes, sem teste, mais recente primeiro, só os campos da tabela.
  assert.deepStrictEqual(e.eventos.map((x) => x.id), [
    'EV-20261008-152000-0008', 'EV-20261008-150000-0007', 'EV-20261008-141500-0005', 'EV-20261008-141000-0004',
    'EV-20261008-140200-0003', 'EV-20261008-140100-0002', 'EV-20261008-140000-0001', 'EV-20261007-230000-0009', 'EV-20260920-090000-bbbb',
  ]);
  const ex = e.eventos[3];
  for (const k of ['id', 'ts', 'agente', 'projeto', 'trello', 'resumo', 'direcao', 'resultado', 'tipo', 'fluxo_id', 'precisa_dono']) assert.ok(k in ex, `evento sem ${k}`);
  assert.ok(!('passos' in ex), 'a tabela não leva passos');
  assert.strictEqual(ex.trello.titulo, 'A: 05/10 - Testar o fluxo de ponta a ponta');
  assert.ok(e.avisos.some((a) => a.includes('logs/eventos/2026-10.jsonl') && a.includes('1 linha')), JSON.stringify(e.avisos));
  assert.ok(e.avisos.some((a) => a.includes('serie.jsonl')), JSON.stringify(e.avisos));
});

suite.teste('GET /api/eventos: filtros, busca sem acento, só o dono, testes, período e paginação', async () => {
  const ids = async (q) => {
    const r = await pedir(S.porta, `/api/eventos${q}`);
    assert.strictEqual(r.status, 200, r.texto);
    return r.json;
  };
  let r = await ids('');
  assert.deepStrictEqual([r.total, r.pagina, r.por_pagina, r.eventos.length], [10, 1, 50, 10]);
  assert.strictEqual(r.eventos[9].id, 'EV-20260815-100000-aaaa', 'todos os meses entram nos filtros');
  assert.strictEqual((await ids('?incluir_testes=1')).total, 11);
  assert.strictEqual((await ids('?agente=coordenador-trello')).total, 4);
  assert.strictEqual((await ids('?agente=cerebro,coordenador-trello')).total, 10);
  r = await ids('?q=concluida');
  assert.deepStrictEqual(r.eventos.map((x) => x.id), ['EV-20261008-141000-0004']);
  assert.strictEqual((await ids(`?q=${encodeURIComponent('CONCLUÍDA')}`)).total, 1);
  assert.strictEqual((await ids(`?q=${F2}`)).total, 5);
  assert.strictEqual((await ids('?q=testar%20ponta')).total, 1, 'busca no título do cartão');
  assert.strictEqual((await ids('?q=ponta%20%20TESTAR')).total, 1, 'cada palavra, em qualquer ordem');
  assert.strictEqual((await ids('?q=ponta%20inexistente')).total, 0, 'todas as palavras precisam aparecer');
  assert.strictEqual((await ids('?q=acao')).total, 1, 'busca sem acento em "ação"');
  r = await ids('?so_dono=1');
  assert.deepStrictEqual(r.eventos.map((x) => x.id), ['EV-20261008-152000-0008', 'EV-20261008-150000-0007']);
  assert.strictEqual((await ids('?desde=2026-10-08&ate=2026-10-08')).total, 7);
  r = await ids('?desde=2026-10-07&ate=2026-10-07');
  assert.deepStrictEqual(r.eventos.map((x) => x.id), ['EV-20261007-230000-0009'], 'ts em UTC cai no dia de São Paulo');
  assert.strictEqual((await ids('?projeto=a')).total, 1);
  assert.strictEqual((await ids('?tipo=execucao')).total, 2);
  assert.strictEqual((await ids('?resultado=falhou')).total, 1);
  assert.strictEqual((await ids(`?fluxo=${F3}`)).total, 1);
  r = await ids('?por_pagina=3&pagina=2');
  assert.deepStrictEqual([r.total, r.pagina, r.por_pagina, r.paginas], [10, 2, 3, 4]);
  assert.deepStrictEqual(r.eventos.map((x) => x.id), ['EV-20261008-141000-0004', 'EV-20261008-140200-0003', 'EV-20261008-140100-0002']);
  assert.deepStrictEqual((await ids('?pagina=99')).eventos, []);
  assert.strictEqual((await ids('?por_pagina=9999')).por_pagina, 500);
  for (const ruim of ['?desde=lixo', '?ate=2026-02-31', '?desde=2026-13-01', '?pagina=0', '?por_pagina=abc']) {
    const x = await pedir(S.porta, `/api/eventos${ruim}`);
    assert.strictEqual(x.status, 400, `${ruim} deveria dar 400`);
    assert.ok(x.json && x.json.erro);
  }
});

suite.teste('GET /api/eventos: contagens do conjunto filtrado (cada faceta ignora o próprio filtro), horas e vários valores', async () => {
  const pegar = async (q) => {
    const r = await pedir(S.porta, `/api/eventos${q}`);
    assert.strictEqual(r.status, 200, r.texto);
    return r.json;
  };
  // Sem filtro: os 10 eventos fora os de teste, contados por faceta (as contagens não dependem da página).
  let r = await pegar('?por_pagina=3');
  assert.deepStrictEqual(r.contagens.resultado, { ok: 7, 'em-andamento': 1, falhou: 1, 'aguardando-dono': 1 });
  assert.deepStrictEqual(r.contagens.agente, { cerebro: 6, 'coordenador-trello': 4 });
  assert.deepStrictEqual(r.contagens.projeto, { D: 1, A: 1, B: 1 });
  assert.strictEqual(Object.values(r.contagens.tipo).reduce((a, b) => a + b, 0), 10);
  assert.deepStrictEqual([r.contagens.tipo.execucao, r.contagens.tipo['pedido-recebido'], r.contagens.tipo.decisao], [2, 2, 1]);
  assert.strictEqual(r.contagens.precisa_dono, 2);
  // Filtro de resultado: a tabela encolhe, a faceta resultado continua inteira e as outras respeitam o filtro.
  r = await pegar('?resultado=ok');
  assert.strictEqual(r.total, 7);
  assert.deepStrictEqual(r.contagens.resultado, { ok: 7, 'em-andamento': 1, falhou: 1, 'aguardando-dono': 1 });
  assert.deepStrictEqual(r.contagens.agente, { cerebro: 4, 'coordenador-trello': 3 });
  assert.strictEqual(r.contagens.precisa_dono, 0);
  // Vários valores por vírgula em agente e resultado.
  r = await pegar('?agente=coordenador-trello&resultado=ok,falhou');
  assert.strictEqual(r.total, 4);
  assert.deepStrictEqual(r.contagens.agente, { cerebro: 4, 'coordenador-trello': 4 });
  assert.deepStrictEqual(r.contagens.resultado, { ok: 3, falhou: 1 });
  assert.strictEqual((await pegar('?projeto=A,b')).total, 2, 'projeto sem diferenciar maiúsculas, vários valores');
  // Só o dono: precisa_dono ignora o próprio filtro (é o número do alternador).
  r = await pegar('?so_dono=1');
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.contagens.precisa_dono, 2);
  assert.deepStrictEqual(r.contagens.resultado, { falhou: 1, 'aguardando-dono': 1 });
  // horas=N: só as últimas N horas (relógio fixo às 15:50); testes continuam fora.
  r = await pegar('?horas=1');
  assert.deepStrictEqual(r.eventos.map((x) => x.id), ['EV-20261008-152000-0008', 'EV-20261008-150000-0007']);
  assert.strictEqual((await pegar('?horas=2')).total, 7);
  assert.strictEqual((await pegar('?horas=2&desde=2026-10-08')).total, 7, 'horas e desde juntos');
  assert.strictEqual((await pegar('?horas=2&incluir_testes=1')).total, 8);
  for (const ruim of ['?horas=0', '?horas=abc', '?horas=-3']) {
    const x = await pedir(S.porta, `/api/eventos${ruim}`);
    assert.strictEqual(x.status, 400, `${ruim} deveria dar 400`);
  }
  // Busca sem resultado: contagens vazias, sem erro.
  r = await pegar('?q=nada-disso-existe');
  assert.deepStrictEqual(r.contagens, { resultado: {}, agente: {}, projeto: {}, tipo: {}, precisa_dono: 0 });
});

suite.teste('GET /api/evento/<id>: sequência do fluxo, comandos por fluxo e por janela, pedido inicial, vizinhos', async () => {
  const r = await pedir(S.porta, '/api/evento/EV-20261008-141000-0004');
  assert.strictEqual(r.status, 200, r.texto);
  const d = r.json;
  assert.strictEqual(d.evento.id, 'EV-20261008-141000-0004');
  assert.deepStrictEqual(d.evento.passos, ['Naveguei', 'Salvei', 'Normalizei']);
  assert.deepStrictEqual(d.fluxo, { id: F2, titulo: 'Leitura do Trello', criado_em: sp('13:59:00'), agente: 'cerebro' });
  assert.deepStrictEqual(d.sequencia.map((x) => x.id), ['EV-20261008-140000-0001', 'EV-20261008-140100-0002', 'EV-20261008-140200-0003', 'EV-20261008-141000-0004', 'EV-20261008-141500-0005']);
  assert.deepStrictEqual(d.pedido_inicial && [d.pedido_inicial.texto, d.pedido_inicial.origem, d.pedido_inicial.fonte], [`Leia o quadro do Trello. ${F2}`, 'dono-direto', 'prompt-do-evento']);
  // Com fluxo_id: os dos 2 agentes; sem fluxo_id: só os do Coordenador, da sessão sess-t1, entre 14:02 e 14:10.
  assert.deepStrictEqual(d.comandos_brutos.map((c) => [c.ts.slice(11, 19), c.correlacao]), [
    ['13:59:50', 'fluxo_id'], ['14:00:30', 'fluxo_id'], ['14:02:30', 'fluxo_id'], ['14:05:00', 'fluxo_id'], ['14:06:00', 'fluxo_id'], ['14:07:00', 'janela'],
  ]);
  assert.deepStrictEqual(d.janela_sem_fluxo, { inicio: sp('14:02:00'), fim: sp('14:10:00'), sessao: 'sess-t1' });
  const falha = d.comandos_brutos[4];
  assert.deepStrictEqual([falha.agente, falha.evento, falha.ferramenta, falha.entrada, falha.ok, falha.sessao], ['coordenador-trello', 'PostToolUseFailure', 'Bash', 'node normalizar.js', false, 'sess-t1']);
  assert.strictEqual(d.comandos_brutos[0].agente, 'cerebro');
  assert.deepStrictEqual([d.anterior_id, d.proximo_id], ['EV-20261008-140200-0003', 'EV-20261008-141500-0005']);
  // Fluxo sem evento pedido-recebido: pedido inicial vem do prompt bruto que trouxe o id.
  const f3 = (await pedir(S.porta, '/api/evento/EV-20261008-150000-0007')).json;
  assert.deepStrictEqual([f3.pedido_inicial.origem, f3.pedido_inicial.fonte], ['rotina', 'prompt']);
  assert.ok(f3.pedido_inicial.texto.includes(F3));
  assert.strictEqual(f3.fluxo.titulo, null);
  assert.deepStrictEqual(f3.comandos_brutos.map((c) => c.ts.slice(11, 19)), ['14:12:00', '14:59:00', '15:00:30']);
  // O mais antigo não tem anterior; evento inexistente é 404.
  const antigo = (await pedir(S.porta, '/api/evento/EV-20260815-100000-aaaa')).json;
  assert.strictEqual(antigo.anterior_id, null);
  const nada = await pedir(S.porta, '/api/evento/EV-NAO-EXISTE');
  assert.strictEqual(nada.status, 404);
  assert.ok(nada.json && nada.json.erro);
});

suite.teste('GET /api/fluxo/<id>: eventos em ordem, comandos do fluxo, testes só a pedido, 404', async () => {
  const r = await pedir(S.porta, `/api/fluxo/${F2}`);
  assert.strictEqual(r.status, 200, r.texto);
  assert.strictEqual(r.json.fluxo.titulo, 'Leitura do Trello');
  assert.strictEqual(r.json.eventos.length, 5);
  // Como o "registrar fluxo": com fluxo_id + a janela de cada evento (o SessionStart das 14:01:30 cai na
  // janela do pedido-recebido do Coordenador, que começa no criado_em do fluxo, 13:59).
  assert.deepStrictEqual(r.json.comandos_brutos.map((c) => [c.ts.slice(11, 19), c.correlacao]), [
    ['13:59:50', 'fluxo_id'], ['14:00:30', 'fluxo_id'], ['14:01:30', 'janela'], ['14:02:30', 'fluxo_id'], ['14:05:00', 'fluxo_id'], ['14:06:00', 'fluxo_id'], ['14:07:00', 'janela'],
  ]);
  assert.deepStrictEqual([r.json.pedido_inicial.fonte, r.json.pedido_inicial.texto], ['prompt-do-evento', `Leia o quadro do Trello. ${F2}`]);
  assert.strictEqual((await pedir(S.porta, `/api/fluxo/${F2}?incluir_testes=1`)).json.eventos.length, 6);
  const so = await pedir(S.porta, '/api/fluxo/F-20261009-0001');
  assert.strictEqual(so.status, 200);
  assert.deepStrictEqual([so.json.fluxo.titulo, so.json.eventos.length], ['Fluxo só no contador', 0]);
  assert.strictEqual((await pedir(S.porta, '/api/fluxo/F-99999999-9999')).status, 404);
});

suite.teste('POST /api/recalcular exige X-Painel; com ele roda o coletor e devolve o estado', async () => {
  const sem = await pedir(S.porta, '/api/recalcular', { metodo: 'POST' });
  assert.strictEqual(sem.status, 403);
  assert.ok(sem.json.erro.includes('X-Painel'));
  const errado = await pedir(S.porta, '/api/recalcular', { metodo: 'POST', cabecalhos: { 'X-Painel': '0' } });
  assert.strictEqual(errado.status, 403);
  const deFora = await pedir(S.porta, '/api/recalcular', { metodo: 'POST', cabecalhos: { 'X-Painel': '1', Origin: 'http://evil.example' } });
  assert.strictEqual(deFora.status, 403);
  const ok = await pedir(S.porta, '/api/recalcular', { metodo: 'POST', cabecalhos: { 'X-Painel': '1', Origin: `http://127.0.0.1:${S.porta}` }, corpo: '{}' });
  assert.strictEqual(ok.status, 200, ok.texto);
  assert.strictEqual(ok.json.recalculo.ok, true);
  assert.strictEqual(ok.json.gerado_em, AGORA);
  assert.ok(ok.json.kpis && ok.json.agentes && ok.json.eventos);
  assert.strictEqual(ok.json.uso.coleta.bytes_lidos, 0, 'recalcular de novo lê só o que mudou');
});

suite.teste('POST /api/cerebro: 501 da Fase B (e 403 sem X-Painel)', async () => {
  const r = await pedir(S.porta, '/api/cerebro', { metodo: 'POST', cabecalhos: { 'X-Painel': '1' } });
  assert.strictEqual(r.status, 501);
  assert.deepStrictEqual(r.json, { erro: 'Fase B: exige o Maestri Wire (ver §11.7)' });
  assert.strictEqual((await pedir(S.porta, '/api/cerebro', { metodo: 'POST' })).status, 403);
});

suite.teste('Host forjado → 403 (inclusive variações); localhost e maiúsculas aceitos', async () => {
  const p = S.porta;
  for (const host of ['evil.example', `evil.example:${p}`, `127.0.0.1:${p}.`, `127.0.0.1.:${p}`, '127.0.0.1', 'localhost', `127.0.0.1:4777`, `[::1]:${p}`, `0.0.0.0:${p}`, `127.0.0.2:${p}`, `localhost.:${p}`, `127.0.0.1:${p}@evil`, ` 127.0.0.1:${p}x`]) {
    const r = await pedir(p, '/api/estado', { host });
    assert.strictEqual(r.status, 403, `Host "${host}" deveria dar 403`);
    assert.ok(!r.texto.includes('"agentes"'));
  }
  // Host vazio, ausente (HTTP/1.0 e 1.1) ou duplicado: recusado (400 do Node ou 403 do painel), nunca 200.
  for (const cru of [
    'GET /api/estado HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n',
    'GET /api/estado HTTP/1.1\r\nConnection: close\r\n\r\n',
    'GET /api/estado HTTP/1.0\r\n\r\n',
    `GET /api/estado HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    `GET http://evil.example/api/estado HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
  ]) {
    const r = await pedirCru(p, cru);
    assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(cru)} → ${r.status}`);
    assert.ok(!r.texto.includes('"agentes"'));
  }
  const absoluta = await pedirCru(p, `GET http://127.0.0.1:${p}/api/estado HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`);
  assert.strictEqual(absoluta.status, 404, 'URL absoluta não é rota');
  assert.strictEqual((await pedir(p, '/', { host: 'evil.example' })).status, 403);
  assert.strictEqual((await pedir(p, '/api/recalcular', { metodo: 'POST', host: 'evil.example', cabecalhos: { 'X-Painel': '1' } })).status, 403);
  assert.strictEqual((await pedir(p, '/api/estado', { host: `localhost:${p}` })).status, 200);
  assert.strictEqual((await pedir(p, '/api/estado', { host: `LOCALHOST:${p}` })).status, 200);
});

suite.teste('caminhos estranhos → 404; métodos errados → 405; sem servir arquivos', async () => {
  const p = S.porta;
  for (const c of ['/index.html', '/servidor.js', '/README.md', '/testes/mock-estado.json', '/../registro/agentes.json', '/%2e%2e/registro/agentes.json',
    '/..%2f..%2fregistro%2fagentes.json', '//etc/passwd', '/api', '/api/', '/api/estado/', '/api/estado/x', '/api/evento/', '/api/evento/..%2f..%2fregistro%2fagentes.json',
    '/api/evento/%2e%2e', '/api/fluxo/a/b', '/api/evento/%E0%A4%A', '/API/ESTADO', '/estado/painel.pid', '/favicon.ico']) {
    const r = await pedir(p, c);
    assert.strictEqual(r.status, 404, `${c} deveria dar 404 (deu ${r.status})`);
    assert.ok(!r.texto.includes('coordenador-trello'), `${c} vazou dados`);
  }
  const put = await pedir(p, '/api/estado', { metodo: 'PUT' });
  assert.strictEqual(put.status, 405);
  assert.strictEqual(put.headers.allow, 'GET, HEAD');
  const opt = await pedir(p, '/api/estado', { metodo: 'OPTIONS', cabecalhos: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.strictEqual(opt.status, 405);
  assert.ok(!Object.keys(opt.headers).some((h) => h.startsWith('access-control-')));
  assert.strictEqual((await pedir(p, '/api/recalcular')).status, 405);
  assert.strictEqual((await pedir(p, '/api/estado', { metodo: 'POST', cabecalhos: { 'X-Painel': '1' } })).status, 405);
});

suite.teste('gzip quando o cliente aceita; resposta continua JSON válido', async () => {
  const r = await pedir(S.porta, '/api/estado', { cabecalhos: { 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-encoding'], 'gzip');
  const e = JSON.parse(zlib.gunzipSync(r.buf).toString('utf8'));
  assert.strictEqual(e.workspace.nome, 'Exemplo');
});

suite.teste('leitura tolerante: evento novo aparece sem reiniciar; arquivos ilegíveis viram aviso, não erro', async () => {
  const arqOut = path.join(R.m, 'logs', 'eventos', '2026-10.jsonl');
  // Completa a linha que estava pela metade e acrescenta outra.
  fs.appendFileSync(arqOut, ',"fluxo_id":"F-20261008-0004","origem":"cerebro","tipo":"aviso","resumo":"Linha completada depois","resultado":"ok"}\n');
  let e = (await pedir(S.porta, '/api/estado')).json;
  assert.strictEqual(e.eventos[0].id, 'EV-20261008-155900-0010');
  fs.writeFileSync(path.join(R.m, 'estado', 'pendencias.json'), '{"pendencias": [');
  fs.writeFileSync(path.join(R.m, 'estado', 'trello', 'resumo.json'), '');
  fs.rmSync(path.join(R.m, 'estado', 'trello', 'rst.md'));
  e = (await pedir(S.porta, '/api/estado')).json;
  assert.deepStrictEqual(e.kpis.pendencias, { total: 0, critica: 0, alta: 0, normal: 0, baixa: 0 });
  assert.ok(e.saude.motivos.some((m) => m.includes('pendencias.json')), JSON.stringify(e.saude.motivos));
  assert.ok(e.saude.motivos.some((m) => m.includes('Resumo do Trello ilegível')), JSON.stringify(e.saude.motivos));
  assert.strictEqual(e.kpis.trello, null);
  assert.strictEqual(e.trello, null);
  assert.strictEqual(e.trello_rst, null);
});

suite.teste('derrubar pelo PID impresso libera a porta', async () => {
  derrubar(S.pid);
  await esperarAte(() => !pidVivo(S.pid), 10000);
  await assert.rejects(pedir(S.porta, '/api/estado'));
  S = null;
});

suite.teste('raiz vazia: tudo ausente vira null/zero com motivos claros; coletor indisponível', async () => {
  const raiz = pastaTmp('servidor-vazia');
  raizes.push(raiz);
  const r = { m: path.join(raiz, 'maestro'), maestri: path.join(raiz, 'maestri'), claude: path.join(raiz, 'claude'), index: path.join(raiz, 'nao-existe.html') };
  const s = await subir(r, { PAINEL_COLETOR: '0' });
  try {
    const idx = await pedir(s.porta, '/');
    assert.strictEqual(idx.status, 503);
    assert.ok(idx.texto.includes('não foi encontrado'));
    const e = (await pedir(s.porta, '/api/estado')).json;
    assert.deepStrictEqual(e.agentes, []);
    assert.deepStrictEqual(e.eventos, []);
    assert.deepStrictEqual(e.pendencias, []);
    assert.deepStrictEqual(e.serie_trello, []);
    assert.strictEqual(e.trello, null);
    assert.strictEqual(e.uso, null);
    assert.strictEqual(e.kpis.uso.disponivel, false);
    assert.ok(e.kpis.uso.motivo.includes('coletor'));
    assert.strictEqual(e.saude.nivel, 'amarelo');
    assert.ok(e.saude.motivos.some((m) => m.includes('agentes.json')));
    assert.ok(e.saude.motivos.some((m) => m.includes('Trello ainda não foi lido')));
    assert.strictEqual(e.saude.ultimo_evento_idade_min, null);
    assert.strictEqual((await pedir(s.porta, '/api/eventos')).json.total, 0);
    // Sem o arquivo do Maestri, recalcular grava um uso.json com o plano indisponível.
    const rc = await pedir(s.porta, '/api/recalcular', { metodo: 'POST', cabecalhos: { 'X-Painel': '1' } });
    assert.strictEqual(rc.status, 200);
    assert.strictEqual(rc.json.kpis.uso.disponivel, false);
    assert.ok(rc.json.kpis.uso.motivo.includes('.status.json'), rc.json.kpis.uso.motivo);
  } finally {
    derrubar(s.pid);
  }
});

suite.teste('porta ocupada: mensagem clara e saída 1; porta inválida: saída 2', async () => {
  const raiz = pastaTmp('servidor-porta');
  raizes.push(raiz);
  const r = { m: path.join(raiz, 'maestro'), maestri: path.join(raiz, 'maestri'), claude: path.join(raiz, 'claude'), index: path.join(raiz, 'x.html') };
  const s = await subir(r, { PAINEL_COLETOR: '0' });
  try {
    const { spawnSync } = require('child_process');
    const dup = spawnSync(process.execPath, [SERVIDOR, '--porta', String(s.porta)], { env: ambiente(r, { PAINEL_COLETOR: '0' }), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(dup.status, 1);
    assert.ok(dup.stderr.includes('já está em uso'), dup.stderr);
    const ruim = spawnSync(process.execPath, [SERVIDOR, '--porta', 'abc'], { env: ambiente(r), encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(ruim.status, 2);
    assert.ok(ruim.stderr.includes('Porta inválida'));
  } finally {
    derrubar(s.pid);
  }
});

suite.teste('em processo: iniciar() grava o PID e parar() apaga; Host conferido com a porta real', async () => {
  const raiz = pastaTmp('servidor-inproc');
  raizes.push(raiz);
  const m = path.join(raiz, 'maestro');
  const porta = await portaLivre();
  const env = { MAESTRO_DIR: m, PAINEL_COLETOR: '0', PAINEL_INDEX: path.join(raiz, 'x.html'), MAESTRI_DATA_DIR: path.join(raiz, 'maestri') };
  const s = await srv.iniciar({ argv: ['--porta', String(porta)], env });
  const pidArq = path.join(m, 'estado', 'painel.pid');
  try {
    assert.strictEqual(Number(fs.readFileSync(pidArq, 'utf8')), process.pid);
    assert.strictEqual((await pedir(porta, '/api/estado')).status, 200);
    assert.strictEqual((await pedir(porta, '/api/estado', { host: `127.0.0.1:${porta + 1}` })).status, 403);
  } finally {
    await s.parar();
  }
  assert.ok(!fs.existsSync(pidArq), 'parar() deve apagar estado/painel.pid');
});

suite.teste('saúde: limites do Trello (2× e 4×), horário das leituras e hooks parados', () => {
  const cfg = { intervaloMin: 60, janela: null };
  const agora = Date.parse('2026-10-08T15:50:00-03:00');
  const saude = (minTrello, hooks = [], janela = null, coletado = null) => srv.calcularSaude({
    agora, cfgTrello: Object.assign({}, cfg, { janela }), hooks,
    trello: { existe: true, erro: null, coletadoEm: coletado !== null ? coletado : agora - minTrello * 60000 },
  });
  assert.deepStrictEqual([saude(100).nivel, saude(100).motivos], ['verde', []]);
  assert.strictEqual(saude(119).nivel, 'verde');
  assert.strictEqual(saude(130).nivel, 'amarelo');
  assert.ok(saude(130).motivos[0].startsWith('Trello lido há 2 h 10 min'), saude(130).motivos[0]);
  assert.strictEqual(saude(241).nivel, 'vermelho');
  assert.strictEqual(saude(130).trello_idade_min, 130);
  // Padrão do contrato: idade real (sem desconto da noite). 241 min e 12 h 51 min → vermelho.
  const padrao = srv.lerConfig([], {}).trello;
  assert.deepStrictEqual(padrao, { intervaloMin: 60, janela: null });
  const ag = Date.parse('2026-10-08T10:21:00-03:00');
  for (const lido of ['2026-10-08T06:20:00-03:00', '2026-10-07T21:30:00-03:00']) {
    const s = srv.calcularSaude({ agora: ag, cfgTrello: padrao, hooks: [], trello: { existe: true, erro: null, coletadoEm: Date.parse(lido) } });
    assert.strictEqual(s.nivel, 'vermelho', lido);
  }
  // Janela 8–22 (opcional): lido às 21:40 e agora 08:30 → só 50 min úteis (verde); lido às 15:00 da véspera → vermelho.
  const janela = { ini: 8 * 60, fim: 22 * 60 };
  const s1 = srv.calcularSaude({ agora: Date.parse('2026-10-09T08:30:00-03:00'), cfgTrello: { intervaloMin: 60, janela }, hooks: [], trello: { existe: true, coletadoEm: Date.parse('2026-10-08T21:40:00-03:00') } });
  assert.strictEqual(s1.nivel, 'verde');
  assert.strictEqual(s1.trello_idade_min, 650);
  const s2 = srv.calcularSaude({ agora: Date.parse('2026-10-09T08:30:00-03:00'), cfgTrello: { intervaloMin: 60, janela }, hooks: [], trello: { existe: true, coletadoEm: Date.parse('2026-10-08T15:00:00-03:00') } });
  assert.strictEqual(s2.nivel, 'vermelho');
  // Com a janela, o motivo diz quanto caiu no horário das leituras (coerente com o selo).
  const s3 = srv.calcularSaude({ agora: Date.parse('2026-10-09T10:30:00-03:00'), cfgTrello: { intervaloMin: 60, janela }, hooks: [], trello: { existe: true, coletadoEm: Date.parse('2026-10-08T21:40:00-03:00') } });
  assert.strictEqual(s3.nivel, 'amarelo');
  assert.ok(/Trello lido há 12 h 50 min, 2 h 50 min no horário das leituras/.test(s3.motivos[0]), s3.motivos[0]);
  assert.strictEqual(Math.round(srv.minutosUteis(Date.parse('2026-10-08T21:40:00-03:00'), Date.parse('2026-10-09T08:30:00-03:00'), janela)), 50);
  // Hooks
  const h = saude(10, [
    { agente: 'a', nome: 'Agente A', ativo: true, ultimo_bruto: null, idade_min: null },
    { agente: 'b', nome: 'Agente B', ativo: true, ultimo_bruto: 'x', idade_min: 25 * 60 },
    { agente: 'c', nome: 'Agente C', ativo: true, ultimo_bruto: 'x', idade_min: 23 * 60 },
    { agente: 'd', nome: 'Agente D', ativo: false, ultimo_bruto: null, idade_min: null },
  ]);
  assert.strictEqual(h.nivel, 'amarelo');
  assert.deepStrictEqual(h.motivos, ['Agente A: nenhum log bruto ainda (hooks instalados?)', 'Agente B sem log bruto há 25 h']);
  const nunca = srv.calcularSaude({ agora, cfgTrello: cfg, hooks: [], trello: { existe: false } });
  assert.deepStrictEqual([nunca.nivel, nunca.motivos], ['amarelo', ['Trello ainda não foi lido (sem estado/trello/resumo.json)']]);
});

suite.teste('rotas e origem do pedido: travessia recusada; envelopes reconhecidos', () => {
  for (const c of ['/api/evento/..%2Fx', '/api/evento/.x', '/api/evento/a%00b', '/api/fluxo/%2e%2e%2f']) assert.strictEqual(srv.acharRota(c), null, c);
  assert.deepStrictEqual(srv.acharRota('/api/evento/EV-1'), { nome: 'evento', metodos: ['GET', 'HEAD'], id: 'EV-1' });
  const porNome = new Map([['cerebro principal', 'cerebro'], ['coordenador do trello', 'coordenador-trello']]);
  assert.strictEqual(srv.origemDoPrompt('[ROTINA] Leia o quadro', porNome), 'rotina');
  assert.strictEqual(srv.origemDoPrompt('[PEDIDO] F-1\nDe: Cérebro Principal → Para: Coordenador do Trello', porNome), 'cerebro');
  assert.strictEqual(srv.origemDoPrompt('[AVISO] F-1\nDe: Coordenador do Trello → Para: Cérebro Principal', porNome), 'agente:coordenador-trello');
  assert.strictEqual(srv.origemDoPrompt('oi, leia o quadro', porNome), 'dono-direto');
  assert.strictEqual(srv.pastaDoAgente('desconhecido:abc'), 'desconhecido-abc');
  assert.strictEqual(srv.pastaDoAgente('../x'), 'x');
});

suite.teste('LeitorJsonl: incremental, linha final incompleta, arquivo trocado', async () => {
  const raiz = pastaTmp('servidor-leitor');
  raizes.push(raiz);
  const arq = path.join(raiz, 'a.jsonl');
  fs.writeFileSync(arq, '{"a":1}\n{"a":2}\n{"a":');
  const leitor = new srv.LeitorJsonl();
  let e = await leitor.ler(arq);
  assert.deepStrictEqual(e.linhas.map((x) => x.a), [1, 2]);
  fs.appendFileSync(arq, '3}\nlixo\n{"a":4}');
  e = await leitor.ler(arq);
  assert.deepStrictEqual(e.linhas.map((x) => x.a), [1, 2, 3, 4]);
  assert.strictEqual(e.invalidas, 1);
  fs.appendFileSync(arq, '\n{"a":5}\n');
  e = await leitor.ler(arq);
  assert.deepStrictEqual(e.linhas.map((x) => x.a), [1, 2, 3, 4, 5]);
  fs.writeFileSync(arq, '{"a":9}\n');
  e = await leitor.ler(arq);
  assert.deepStrictEqual(e.linhas.map((x) => x.a), [9]);
  fs.rmSync(arq);
  e = await leitor.ler(arq);
  assert.deepStrictEqual([e.existe, e.linhas.length], [false, 0]);
  // Teto de memória: com 100 bytes de orçamento só os arquivos mais recentes ficam guardados.
  const pequeno = new srv.LeitorJsonl({ maxBytes: 100 });
  for (const n of ['b', 'c', 'd']) {
    fs.writeFileSync(path.join(raiz, `${n}.jsonl`), `${JSON.stringify({ n, x: 'y'.repeat(40) })}\n`);
    const r = await pequeno.ler(path.join(raiz, `${n}.jsonl`));
    assert.strictEqual(r.linhas[0].n, n);
  }
  assert.ok(pequeno.mapa.size <= 2 && pequeno.bytesGuardados() <= 100, `guardou ${pequeno.mapa.size} arquivos`);
});

suite.teste('pedido inicial: prompt do dono sem fluxo_id antes do pedido-recebido; vizinhos só com id válido', async () => {
  const raiz = pastaTmp('servidor-pedido');
  raizes.push(raiz);
  const m = path.join(raiz, 'maestro');
  escreverJson(path.join(m, 'registro', 'agentes.json'), { workspace: { nome: 'Exemplo' }, agentes: [{ slug: 'cerebro', nome: 'Cérebro Principal', status: 'ativo' }] });
  const F = 'F-20261008-0005';
  const d = (hms) => `2026-10-08T${hms}-03:00`;
  escreverJsonl(path.join(m, 'logs', 'eventos', '2026-10.jsonl'), [
    ev({ id: 'EV-20261008-050000-0001', ts: d('05:00:00'), agente: 'cerebro', fluxo_id: 'F-20261008-0004', tipo: 'execucao', resumo: 'Antes', sessao: 's1' }),
    ev({ id: 'EV-20261008-061100-0002', ts: d('06:11:00'), agente: 'cerebro', fluxo_id: F, origem: 'dono-direto', tipo: 'pedido-recebido', resumo: 'Pedido do dono: mover D: Ambiente de testes', sessao: 's1' }),
    { id: 5, ts: 5, agente: 5 },
    ev({ id: 'EV-20261008-061644-0003', ts: d('06:16:44'), agente: 'cerebro', fluxo_id: F, tipo: 'execucao', resumo: 'Movido', sessao: 's1' }),
    { id: 'EV com espaço', ts: d('06:20:00'), agente: 'cerebro', resumo: 'id inválido' },
  ]);
  escreverJsonl(path.join(m, 'logs', 'bruto', 'cerebro', '2026-10-08.jsonl'), [
    { ts: d('05:30:00'), agente: 'cerebro', sessao: 's1', evento: 'UserPromptSubmit', prompt: 'Prompt antigo, de antes do evento anterior? não: depois dele', cwd: 'C:/x' },
    { ts: d('06:10:44'), agente: 'cerebro', sessao: 's1', evento: 'UserPromptSubmit', prompt: 'Mova o D: Ambiente de testes para Em andamento e confira se o espelho está certo.', cwd: 'C:/x' },
    { ts: d('06:10:50'), agente: 'cerebro', sessao: 'outra', evento: 'UserPromptSubmit', prompt: 'Outra sessão', cwd: 'C:/x' },
    { ts: d('06:12:00'), agente: 'cerebro', sessao: 's1', fluxo_id: F, evento: 'PostToolUse', ferramenta: 'Bash', entrada: 'node mover.js', ok: true, cwd: 'C:/x' },
  ]);
  const porta = await portaLivre();
  const env = { MAESTRO_DIR: m, PAINEL_COLETOR: '0', PAINEL_INDEX: path.join(raiz, 'x.html'), MAESTRI_DATA_DIR: path.join(raiz, 'maestri'), PAINEL_AGORA: d('07:00:00') };
  const s = await srv.iniciar({ argv: ['--porta', String(porta)], env });
  try {
    const r = await pedir(porta, '/api/evento/EV-20261008-061644-0003');
    assert.strictEqual(r.status, 200, r.texto);
    const p = r.json.pedido_inicial;
    assert.deepStrictEqual([p.texto, p.origem, p.fonte, p.ts], ['Mova o D: Ambiente de testes para Em andamento e confira se o espelho está certo.', 'dono-direto', 'prompt-do-evento', d('06:10:44')]);
    assert.strictEqual((await pedir(porta, `/api/fluxo/${F}`)).json.pedido_inicial.texto, p.texto);
    // Id que não é texto (ou fora do formato) não vira vizinho nem entra na lista; vira aviso.
    assert.deepStrictEqual([r.json.anterior_id, r.json.proximo_id], ['EV-20261008-061100-0002', null]);
    const est = (await pedir(porta, '/api/estado')).json;
    assert.deepStrictEqual(est.eventos.map((e) => e.id), ['EV-20261008-061644-0003', 'EV-20261008-061100-0002', 'EV-20261008-050000-0001']);
    assert.ok(est.avisos.some((a) => /2 linha\(s\) ilegível\(is\) ou sem id válido/.test(a)), JSON.stringify(est.avisos));
    // Sem prompt achado na janela: cai no resumo do evento.
    fs.writeFileSync(path.join(m, 'logs', 'bruto', 'cerebro', '2026-10-08.jsonl'), '');
    const sem = (await pedir(porta, '/api/evento/EV-20261008-061644-0003')).json.pedido_inicial;
    assert.deepStrictEqual([sem.texto, sem.fonte], ['Pedido do dono: mover D: Ambiente de testes', 'evento']);
  } finally {
    await s.parar();
  }
});

suite.teste('diasDoFluxo: fluxo longo guarda o 1º dia e os mais recentes; marca o corte', () => {
  const dias = srv.diasDoFluxo('F-20260701-0001', [{ _dia: '2026-07-01', resultado: 'em-andamento' }, { _dia: '2026-10-08', resultado: 'em-andamento' }], '2026-10-08');
  assert.strictEqual(dias.length, 62);
  assert.deepStrictEqual([dias[0], dias[1], dias[2], dias[dias.length - 1]], ['2026-06-30', '2026-07-01', '2026-08-10', '2026-10-08']);
  assert.strictEqual(dias.cortados, 101 - 62);
  const curto = srv.diasDoFluxo('F-20261001-0001', [{ _dia: '2026-10-01', resultado: 'ok' }], '2026-10-08');
  assert.deepStrictEqual([curto[0], curto[curto.length - 1], curto.cortados], ['2026-09-30', '2026-10-02', 0]);
});

suite.teste('IndiceBruto: incremental, linha final incompleta, arquivo trocado, teto de leitura, releitura pela posição', async () => {
  const raiz = pastaTmp('servidor-indice');
  raizes.push(raiz);
  const arq = path.join(raiz, '2026-10-08.jsonl');
  const l = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(arq, l({ ts: sp('10:00:00'), fluxo_id: 'F-1', evento: 'PostToolUse', entrada: 'á' }) + l({ ts: sp('10:01:00'), sessao: 's', evento: 'UserPromptSubmit', prompt: 'faça F-20261008-0009 agora' }) + '{"ts":');
  const ind = new srv.IndiceBruto();
  let e = await ind.ler(arq);
  assert.deepStrictEqual([e.col.n, [...e.porFluxo.keys()], [...e.citados.keys()]], [2, ['F-1'], ['F-20261008-0009']]);
  fs.appendFileSync(arq, `"${sp('10:02:00')}","fluxo_id":"F-1","entrada":"x"}\nlixo\n`);
  e = await ind.ler(arq);
  assert.deepStrictEqual([e.col.n, e.porFluxo.get('F-1'), e.invalidas], [3, [0, 2], 1]);
  const lidas = await ind.materializar(e, [2, 0]);
  assert.deepStrictEqual([lidas.get(0).entrada, lidas.get(2).entrada, lidas.get(2)._t], ['á', 'x', Date.parse(sp('10:02:00'))]);
  // Teto de bytes por requisição: o arquivo que não cabe fica pendente e entra na próxima.
  const outro = path.join(raiz, 'outro.jsonl');
  fs.writeFileSync(outro, l({ ts: sp('11:00:00'), fluxo_id: 'F-2' }).repeat(50));
  const orc = { restante: 10, lidos: 5 };
  const p = await ind.ler(outro, orc);
  assert.deepStrictEqual([p.pendente, p.col.n], [true, 0]);
  assert.deepStrictEqual([(await ind.ler(outro, { restante: 1e6, lidos: 0 })).col.n], [50]);
  // Arquivo trocado por um menor: reindexa do zero.
  fs.writeFileSync(arq, l({ ts: sp('12:00:00'), fluxo_id: 'F-3' }));
  e = await ind.ler(arq);
  assert.deepStrictEqual([e.col.n, [...e.porFluxo.keys()]], [1, ['F-3']]);
  // Teto de linhas guardadas: o arquivo mais antigo sai do cache.
  const pequeno = new srv.IndiceBruto({ maxLinhas: 40 });
  await pequeno.ler(arq);
  await pequeno.ler(outro);
  await pequeno.ler(path.join(raiz, 'nao-existe.jsonl'));
  assert.ok(pequeno.linhasGuardadas() === 50 && pequeno.mapa.size === 1, `guardou ${pequeno.mapa.size}`);
});

suite.teste('estado: itens null nas listas do resumo do Trello e do uso são descartados', () => {
  const tr = srv.limparTrello({ projetos: [null, { nome: 'A', cartoes: [null, { titulo: 'x', problemas: [] }] }, 5], auditoria: { mecanicos: [null, { codigo: 'm' }], decisoes: null } });
  assert.deepStrictEqual(tr.projetos, [{ nome: 'A', cartoes: [{ titulo: 'x', problemas: [] }] }]);
  assert.deepStrictEqual(tr.auditoria.mecanicos, [{ codigo: 'm' }]);
  const uso = srv.limparUso({ por_agente: { janela_5h: [null, 5, { agente: 'a' }], hoje: [] } });
  assert.deepStrictEqual(uso.por_agente, { janela_5h: [{ agente: 'a' }], hoje: [] });
});

suite.rodar().then(() => {
  if (S) derrubar(S.pid);
  if (!process.env.MANTER_TMP) for (const r of raizes) apagar(r);
});
