'use strict';
// Testes do bin/coletar_uso.js com transcrições falsas (raiz falsa em testes/tmp/).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assert, MAESTRO, criarSuite, pastaTmp, apagar, escreverJson, escreverJsonl, anexar, linhaAssistente, linhaUsuario,
} = require('./util');

const SCRIPT = path.join(MAESTRO, 'bin', 'coletar_uso.js');
const coletor = require(SCRIPT);

const AGORA = new Date('2026-10-08T15:50:00-03:00');
const sp = (hhmm, dia = '2026-10-08') => `${dia}T${hhmm}:00-03:00`;

const suite = criarSuite('coletor de uso (bin/coletar_uso.js)');
const raizes = [];

function statusPlano({ pct5 = 40, reset5 = '2026-10-08T20:50:00Z', pct7 = 20, reset7 = '2026-10-11T18:50:00Z', estado = 'ready', erro, quando = '2026-10-08T18:45:00Z', semMedidores = false } = {}) {
  const p = { enabled: true, id: 'claude', name: 'Claude Code', plan: 'max', state: estado, lastSuccessAt: quando, notes: [] };
  if (erro) p.error = erro;
  p.meters = semMedidores ? [] : [{
    id: 'plan', label: 'Limites do plano',
    windows: [
      { id: 'five_hour', usedPercent: pct5, resetsAt: reset5, durationSeconds: 18000, ring: 'session' },
      { id: 'seven_day', usedPercent: pct7, resetsAt: reset7, durationSeconds: 604800, ring: 'weekly' },
    ],
  }, { id: 'Fable', label: 'Fable', windows: [{ id: 'limit', usedPercent: 3, resetsAt: reset7, durationSeconds: 604800 }] }];
  return { providers: [p, { id: 'codex', state: 'executableNotFound', meters: [] }], updatedAt: quando };
}

/** Raiz falsa com 6 sessões, transcrições e subagentes. */
function montarBase(nome) {
  const raiz = pastaTmp(`coletor-${nome}`);
  raizes.push(raiz);
  const m = path.join(raiz, 'maestro');
  const claude = path.join(raiz, 'claude');
  const maestri = path.join(raiz, 'maestri');
  const proj = (p) => path.join(claude, 'projects', p);
  escreverJson(path.join(m, 'registro', 'agentes.json'), {
    workspace: { id: 'ws', nome: 'Exemplo', raiz: 'C:/teste' },
    padrao: { modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh' },
    agentes: [{ slug: 'cerebro', nome: 'Cérebro Principal' }, { slug: 'coordenador-trello', nome: 'Coordenador do Trello' }, { slug: 'futuro', nome: 'Futuro' }],
  });
  escreverJson(path.join(maestri, 'usage', 'providers', '.status.json'), statusPlano());
  const sessao = (id, dados) => escreverJson(path.join(m, 'estado', 'sessoes', `${id}.json`), Object.assign({ session_id: id, terminal: 't', cwd: 'C:\\teste', iniciado_em: sp('08:00'), visto_em: sp('15:00') }, dados));
  const t1 = path.join(proj('proj-a'), 's1.jsonl');
  sessao('s1', { agente: 'cerebro', transcript_path: t1 });
  sessao('s2', { agente: 'coordenador-trello', transcript_path: path.join(proj('proj-b'), 's2.jsonl') });
  sessao('s3', { agente: null, transcript_path: path.join(proj('proj-a'), 's3.jsonl') });
  sessao('s4', { agente: 'cerebro', transcript_path: path.join(proj('proj-a'), 's4.jsonl') }); // ainda sem arquivo
  sessao('s6', { agente: 'desconhecido:abc12345', transcript_path: path.join(proj('proj-c'), 's6.jsonl') });
  fs.writeFileSync(path.join(m, 'estado', 'sessoes', 's5.json'), '{"session_id": "s5", "agente": ');
  fs.writeFileSync(path.join(m, 'estado', 'sessoes', 's9.json.tmp'), 'lixo');

  escreverJsonl(t1, [
    linhaUsuario('olá, mostre o "usage" do "assistant"'),
    linhaAssistente({ id: 'msg_A', ts: sp('15:00'), e: 10, s: 8, parar: null }),
    linhaAssistente({ id: 'msg_A', ts: '2026-10-08T15:00:01-03:00', e: 10, s: 100, cw: 1000, cr: 5000 }),
    linhaAssistente({ id: 'msg_B', ts: sp('09:50'), e: 20, s: 10 }),
    linhaAssistente({ id: 'msg_C', ts: sp('10:00', '2026-10-06'), e: 30, cr: 1000 }),
    linhaAssistente({ id: 'msg_D', ts: sp('10:00', '2026-09-29'), e: 999 }),
    '{"type":"assistant","message":{"usage": {"input_tokens": 5', // linha quebrada no meio
    JSON.stringify({ type: 'system', subtype: 'turn_duration', usage: 'x' }),
  ]);
  const sub = path.join(proj('proj-a'), 's1', 'subagents');
  escreverJsonl(path.join(sub, 'agent-x1.jsonl'), [
    linhaAssistente({ id: 'msg_E', ts: sp('15:10'), s: 7, sub: true, parar: null }),
    linhaAssistente({ id: 'msg_E', ts: '2026-10-08T15:10:02-03:00', e: 5, s: 50, sub: true }),
  ]);
  escreverJsonl(path.join(sub, 'workflows', 'wf_1', 'agent-y1.jsonl'), [linhaAssistente({ id: 'msg_F', ts: sp('15:20'), e: 1, s: 1, cw: 100, sub: true })]);
  escreverJsonl(path.join(sub, 'workflows', 'wf_1', 'journal.jsonl'), [linhaAssistente({ id: 'msg_J1', ts: sp('15:20'), e: 100000 })]);
  escreverJson(path.join(sub, 'workflows', 'wf_1', 'agent-y1.meta.json'), { agentType: 'x' });
  escreverJsonl(path.join(proj('proj-b'), 's2.jsonl'), [linhaAssistente({ id: 'msg_G', ts: sp('14:00'), e: 100, s: 20, cr: 2000 })]);
  escreverJsonl(path.join(proj('proj-a'), 's3.jsonl'), [linhaAssistente({ id: 'msg_H', ts: sp('15:00'), e: 500000 })]);
  escreverJsonl(path.join(proj('proj-c'), 's6.jsonl'), [linhaAssistente({ id: 'msg_K', ts: sp('15:30'), e: 10, s: 2 })]);
  return { raiz, m, claude, maestri, t1, proj };
}

function opcoes(b, extra = {}) {
  return Object.assign({ maestroDir: b.m, maestriDataDir: b.maestri, claudeDir: b.claude, env: {}, agora: AGORA }, extra);
}

function linha(uso, periodo, agente) {
  return uso.por_agente[periodo].find((l) => l.agente === agente);
}

suite.teste('fórmula do consumo relativo e pesos', () => {
  assert.deepStrictEqual(coletor.PESOS, { entrada: 1, saida: 5, cache_escrita: 1.25, cache_leitura: 0.1 });
  assert.strictEqual(coletor.consumoRelativo({ entrada: 16, saida: 151, cache_escrita: 1100, cache_leitura: 5000 }), 2646);
});

suite.teste('primeira coleta: dedup pela última linha, subagentes, sessões sem dono e períodos', async () => {
  const b = montarBase('base');
  const uso = await coletor.coletar(opcoes(b));
  // Plano
  assert.strictEqual(uso.plano.disponivel, true);
  assert.strictEqual(uso.plano.janela_5h_pct, 40);
  assert.strictEqual(uso.plano.semanal_pct, 20);
  assert.strictEqual(uso.plano.reset_5h, '2026-10-08T17:50:00-03:00');
  assert.strictEqual(uso.plano.reset_semanal, '2026-10-11T15:50:00-03:00');
  assert.strictEqual(uso.plano.idade_min, 5);
  assert.strictEqual(uso.plano.fonte, 'provedor Claude do Maestri');
  assert.strictEqual(uso.nota, 'o % por agente é estimado; o % do plano vem do Maestri/Claude');
  assert.ok(typeof uso.fonte === 'string' && uso.fonte.includes('Maestri'));
  assert.strictEqual(uso.coletado_em, '2026-10-08T15:50:00-03:00');
  assert.strictEqual(uso.periodos.janela_5h.inicio, '2026-10-08T12:50:00-03:00');
  assert.strictEqual(uso.periodos.hoje.inicio, '2026-10-08T00:00:00-03:00');
  assert.strictEqual(uso.periodos['7d'].inicio, '2026-10-01T15:50:00-03:00');
  // Janela de 5 h: A (última linha) + E (última linha) + F; B fora (09:50), journal ignorado.
  const c5 = linha(uso, 'janela_5h', 'cerebro');
  assert.deepStrictEqual([c5.entrada, c5.saida, c5.cache_escrita, c5.cache_leitura, c5.mensagens], [16, 151, 1100, 5000, 3]);
  assert.strictEqual(c5.consumo_relativo, 2646);
  const t5 = linha(uso, 'janela_5h', 'coordenador-trello');
  assert.strictEqual(t5.consumo_relativo, 400);
  const d5 = linha(uso, 'janela_5h', 'desconhecido:abc12345');
  assert.strictEqual(d5.consumo_relativo, 20);
  assert.strictEqual(d5.registrado, false);
  assert.strictEqual(c5.pct_consumo, 86.3);
  assert.strictEqual(t5.pct_consumo, 13);
  assert.strictEqual(d5.pct_consumo, 0.7);
  assert.strictEqual(c5.pct_plano_estimado, 34.5);
  assert.strictEqual(t5.pct_plano_estimado, 5.2);
  assert.strictEqual(uso.totais.janela_5h.consumo_relativo, 3066);
  // Agente registrado sem sessão aparece zerado; sessão sem dono (msg_H) não entra.
  const f5 = linha(uso, 'janela_5h', 'futuro');
  assert.deepStrictEqual([f5.consumo_relativo, f5.pct_consumo, f5.mensagens], [0, 0, 0]);
  assert.ok(!uso.por_agente.janela_5h.some((l) => l.entrada >= 500000));
  // Hoje: + B. 7d: + C. D (9 dias) fica de fora.
  assert.strictEqual(linha(uso, 'hoje', 'cerebro').consumo_relativo, 2716);
  assert.strictEqual(linha(uso, 'hoje', 'cerebro').pct_plano_estimado, null);
  assert.strictEqual(linha(uso, '7d', 'cerebro').consumo_relativo, 2846);
  assert.strictEqual(linha(uso, '7d', 'cerebro').pct_plano_estimado, 17.4);
  assert.strictEqual(uso.totais['7d'].consumo_relativo, 3266);
  // Diagnóstico
  assert.strictEqual(uso.coleta.sessoes, 4);
  assert.strictEqual(uso.coleta.sessoes_sem_dono, 1);
  assert.strictEqual(uso.coleta.sessoes_ilegiveis, 1);
  assert.strictEqual(uso.coleta.transcricoes_ausentes, 1);
  assert.strictEqual(uso.coleta.linhas_invalidas, 1);
  assert.strictEqual(uso.coleta.cache, 'novo');
  // Gravou uso.json e o cache; msg_D foi podada do cache.
  const gravado = JSON.parse(fs.readFileSync(path.join(b.m, 'estado', 'uso.json'), 'utf8'));
  assert.strictEqual(gravado.por_agente.janela_5h[0].agente, 'cerebro');
  const cache = fs.readFileSync(path.join(b.m, 'estado', 'uso-cache.json'), 'utf8');
  assert.ok(cache.includes('msg_A') && !cache.includes('msg_D') && !cache.includes('msg_H') && !cache.includes('msg_J1'));
});

suite.teste('7d: o % estimado do plano usa a participação na semana do plano (reset semanal − 7 d)', async () => {
  const b = montarBase('semana-plano');
  // Semana do plano começa em 07/10 09:00: msg_C (06/10) conta nas barras de 7 dias, mas não no % do plano.
  escreverJson(path.join(b.maestri, 'usage', 'providers', '.status.json'), statusPlano({ reset7: '2026-10-14T12:00:00Z' }));
  const uso = await coletor.coletar(opcoes(b, { gravar: false }));
  assert.deepStrictEqual(uso.periodos['7d'].base_plano, { inicio: '2026-10-07T09:00:00-03:00', fim: '2026-10-08T15:50:00-03:00', base: 'semana do plano (reset semanal − 7 dias)' });
  const c = linha(uso, '7d', 'cerebro');
  assert.strictEqual(c.consumo_relativo, 2846);
  assert.strictEqual(c.pct_consumo, 87.1);
  assert.strictEqual(c.pct_consumo_semana_plano, 86.6);
  assert.strictEqual(c.pct_plano_estimado, 17.3);
  // Sem reset semanal válido: base_plano nula e o % do plano cai na participação dos 7 dias.
  escreverJson(path.join(b.maestri, 'usage', 'providers', '.status.json'), statusPlano({ reset7: null }));
  const sem = await coletor.coletar(opcoes(b, { gravar: false }));
  assert.strictEqual(sem.periodos['7d'].base_plano, null);
});

suite.teste('cache incremental: só bytes novos, mesma mensagem substituída (não somada)', async () => {
  const b = montarBase('incremental');
  await coletor.coletar(opcoes(b));
  const repetida = await coletor.coletar(opcoes(b));
  assert.strictEqual(repetida.coleta.bytes_lidos, 0, 'segunda rodada sem mudanças não deve ler nada');
  assert.strictEqual(repetida.coleta.cache, 'reaproveitado');
  const novo = `${linhaAssistente({ id: 'msg_A', ts: '2026-10-08T15:00:02-03:00', e: 10, s: 120, cw: 1000, cr: 5000 })}\n${linhaAssistente({ id: 'msg_I', ts: sp('15:40'), e: 3, s: 3 })}\n`;
  anexar(b.t1, novo);
  const uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(uso.coleta.bytes_lidos, Buffer.byteLength(novo));
  const c5 = linha(uso, 'janela_5h', 'cerebro');
  assert.strictEqual(c5.consumo_relativo, 2646 + 100 + 18);
  assert.strictEqual(c5.mensagens, 4);
  assert.strictEqual(c5.saida, 151 + 20 + 3);
});

suite.teste('arquivo crescendo: linha final incompleta fica para a próxima rodada', async () => {
  const b = montarBase('crescendo');
  await coletor.coletar(opcoes(b));
  const inteira = linhaAssistente({ id: 'msg_J', ts: sp('15:45'), e: 7, s: 1 });
  const meio = Math.floor(inteira.length / 2);
  anexar(b.t1, inteira.slice(0, meio));
  const parcial = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(parcial, 'janela_5h', 'cerebro').mensagens, 3, 'linha incompleta não pode contar');
  assert.strictEqual(parcial.coleta.linhas_invalidas, 0);
  anexar(b.t1, `${inteira.slice(meio)}\n`);
  const completa = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(completa, 'janela_5h', 'cerebro').mensagens, 4);
  assert.strictEqual(linha(completa, 'janela_5h', 'cerebro').consumo_relativo, 2646 + 12);
  const de_novo = await coletor.coletar(opcoes(b));
  assert.strictEqual(de_novo.coleta.bytes_lidos, 0);
  assert.strictEqual(linha(de_novo, 'janela_5h', 'cerebro').consumo_relativo, 2646 + 12);
  // Última linha completa mas ainda sem \n também conta (uma vez só).
  anexar(b.t1, linhaAssistente({ id: 'msg_N', ts: sp('15:46'), e: 1 }));
  const semQuebra = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(semQuebra, 'janela_5h', 'cerebro').mensagens, 5);
  anexar(b.t1, `\n${linhaAssistente({ id: 'msg_O', ts: sp('15:47'), e: 1 })}\n`);
  const depois = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(depois, 'janela_5h', 'cerebro').mensagens, 6);
});

suite.teste('arquivo trocado ou truncado recomeça do zero; transcrição que aparece depois entra', async () => {
  const b = montarBase('trocado');
  await coletor.coletar(opcoes(b));
  const s2 = path.join(b.proj('proj-b'), 's2.jsonl');
  fs.unlinkSync(s2);
  escreverJsonl(s2, [linhaAssistente({ id: 'msg_G2', ts: sp('15:45'), e: 1, s: 1 }), linhaAssistente({ id: 'msg_G3', ts: sp('15:46'), e: 1, s: 1 })]);
  let uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(uso, 'janela_5h', 'coordenador-trello').consumo_relativo, 12);
  fs.writeFileSync(s2, `${linhaAssistente({ id: 'msg_G4', ts: sp('15:47'), e: 2 })}\n`); // menor que o offset
  uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(uso, 'janela_5h', 'coordenador-trello').consumo_relativo, 2);
  assert.ok(uso.coleta.transcricoes_recomecadas >= 1);
  escreverJsonl(path.join(b.proj('proj-a'), 's4.jsonl'), [linhaAssistente({ id: 'msg_P', ts: sp('15:48'), e: 4 })]);
  uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(uso.coleta.transcricoes_ausentes, 0);
  assert.strictEqual(linha(uso, 'janela_5h', 'cerebro').consumo_relativo, 2646 + 4);
});

suite.teste('dono da sessão muda: atribuição segue o arquivo de sessão; sessão apagada sai do cache', async () => {
  const b = montarBase('dono');
  await coletor.coletar(opcoes(b));
  escreverJson(path.join(b.m, 'estado', 'sessoes', 's6.json'), { session_id: 's6', agente: 'coordenador-trello', transcript_path: path.join(b.proj('proj-c'), 's6.jsonl') });
  let uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(uso.coleta.bytes_lidos, 0);
  assert.strictEqual(linha(uso, 'janela_5h', 'coordenador-trello').consumo_relativo, 420);
  assert.strictEqual(linha(uso, 'janela_5h', 'desconhecido:abc12345'), undefined);
  fs.unlinkSync(path.join(b.m, 'estado', 'sessoes', 's2.json'));
  uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(uso, 'janela_5h', 'coordenador-trello').consumo_relativo, 20);
  assert.ok(!fs.readFileSync(path.join(b.m, 'estado', 'uso-cache.json'), 'utf8').includes('msg_G'));
});

suite.teste('sessão sem transcript_path: caminho derivado do cwd (CLAUDE_CONFIG_DIR/projects)', async () => {
  const b = montarBase('derivado');
  escreverJson(path.join(b.m, 'estado', 'sessoes', 's8.json'), { session_id: 's8', agente: 'coordenador-trello', cwd: 'C:\\proj\\x' });
  escreverJsonl(path.join(b.claude, 'projects', 'C--proj-x', 's8.jsonl'), [linhaAssistente({ id: 'msg_L', ts: sp('15:30'), e: 1, s: 1 })]);
  const uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(linha(uso, 'janela_5h', 'coordenador-trello').consumo_relativo, 406);
});

suite.teste('cache corrompido é recriado sem mudar o resultado', async () => {
  const b = montarBase('cache-ruim');
  const antes = await coletor.coletar(opcoes(b));
  fs.writeFileSync(path.join(b.m, 'estado', 'uso-cache.json'), '{lixo');
  const depois = await coletor.coletar(opcoes(b));
  assert.ok(String(depois.coleta.cache).startsWith('recriado'), depois.coleta.cache);
  assert.deepStrictEqual(depois.por_agente, antes.por_agente);
});

suite.teste('plano indisponível: sem .status.json, provedor ausente, desligado, sem janelas', async () => {
  const b = montarBase('sem-plano');
  const arq = path.join(b.maestri, 'usage', 'providers', '.status.json');
  fs.unlinkSync(arq);
  let uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(uso.plano.disponivel, false);
  assert.ok(uso.plano.motivo.includes('.status.json'), uso.plano.motivo);
  assert.strictEqual(uso.plano.janela_5h_pct, null);
  assert.strictEqual(linha(uso, 'janela_5h', 'cerebro').pct_plano_estimado, null);
  assert.strictEqual(linha(uso, '7d', 'cerebro').pct_plano_estimado, null);
  assert.ok(linha(uso, 'janela_5h', 'cerebro').pct_consumo > 0, 'a participação continua sem o plano');
  assert.strictEqual(uso.periodos.janela_5h.inicio, '2026-10-08T10:50:00-03:00', 'sem reset: últimas 5 h');
  fs.writeFileSync(arq, '{"providers": [');
  uso = await coletor.coletar(opcoes(b));
  assert.ok(uso.plano.motivo.includes('Não consegui ler'), uso.plano.motivo);
  escreverJson(arq, { providers: [{ id: 'codex', state: 'ready', meters: [] }] });
  uso = await coletor.coletar(opcoes(b));
  assert.ok(uso.plano.motivo.includes('"claude"'), uso.plano.motivo);
  const desligado = statusPlano();
  desligado.providers[0].enabled = false;
  escreverJson(arq, desligado);
  uso = await coletor.coletar(opcoes(b));
  assert.ok(uso.plano.motivo.includes('desligado'), uso.plano.motivo);
  escreverJson(arq, statusPlano({ estado: 'executableNotFound', erro: 'The executable wasn\'t found', semMedidores: true }));
  uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(uso.plano.disponivel, false);
  assert.ok(uso.plano.motivo.includes('executableNotFound'), uso.plano.motivo);
});

suite.teste('janela de 5 h que já reiniciou: % nulo com motivo; consulta que falhou vira aviso', async () => {
  const b = montarBase('expirada');
  const arq = path.join(b.maestri, 'usage', 'providers', '.status.json');
  escreverJson(arq, statusPlano({ reset5: '2026-10-08T18:00:00Z' })); // 15:00 em SP, antes de agora
  let uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(uso.plano.disponivel, true);
  assert.strictEqual(uso.plano.janela_5h_pct, null);
  assert.ok(/reiniciou às 15:00/.test(uso.plano.janela_5h_motivo), uso.plano.janela_5h_motivo);
  assert.strictEqual(uso.plano.semanal_pct, 20);
  assert.strictEqual(linha(uso, 'janela_5h', 'cerebro').pct_plano_estimado, null);
  assert.strictEqual(typeof linha(uso, '7d', 'cerebro').pct_plano_estimado, 'number');
  assert.strictEqual(uso.periodos.janela_5h.inicio, '2026-10-08T10:50:00-03:00');
  escreverJson(arq, statusPlano({ estado: 'failed', erro: 'timeout' }));
  uso = await coletor.coletar(opcoes(b));
  assert.strictEqual(uso.plano.disponivel, true);
  assert.ok(uso.plano.avisos.some((a) => a.includes('falhou') && a.includes('timeout')), JSON.stringify(uso.plano.avisos));
});

suite.teste('transcrição grande: primeira leitura em blocos, segunda não relê nada', async () => {
  const b = montarBase('grande');
  const t7 = path.join(b.proj('proj-g'), 's7.jsonl');
  escreverJson(path.join(b.m, 'estado', 'sessoes', 's7.json'), { session_id: 's7', agente: 'futuro', transcript_path: t7 });
  const grande = 'x'.repeat(2000);
  const partes = [];
  for (let i = 0; i < 6000; i++) {
    partes.push(linhaUsuario(grande));
    partes.push(linhaAssistente({ id: `msg_big_${i}`, ts: sp('15:30'), e: 1, s: 1, parar: null }));
    partes.push(linhaAssistente({ id: `msg_big_${i}`, ts: sp('15:30'), e: 1, s: 2 }));
  }
  fs.mkdirSync(path.dirname(t7), { recursive: true });
  fs.writeFileSync(t7, `${partes.join('\n')}\n`);
  const tamanho = fs.statSync(t7).size;
  const t0 = Date.now();
  let uso = await coletor.coletar(opcoes(b));
  const primeira = Date.now() - t0;
  const f = linha(uso, 'janela_5h', 'futuro');
  assert.strictEqual(f.mensagens, 6000);
  assert.strictEqual(f.consumo_relativo, 6000 * (1 + 10));
  assert.ok(uso.coleta.bytes_lidos >= tamanho);
  const t1 = Date.now();
  uso = await coletor.coletar(opcoes(b));
  const segunda = Date.now() - t1;
  assert.strictEqual(uso.coleta.bytes_lidos, 0);
  assert.ok(primeira < 15000, `primeira leitura lenta: ${primeira} ms`);
  console.log(`        (${(tamanho / 1048576).toFixed(1)} MB: primeira ${primeira} ms, segunda ${segunda} ms)`);
});

function rodarCli(b, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { MAESTRO_DIR: b.m, MAESTRI_DATA_DIR: b.maestri, CLAUDE_CONFIG_DIR: b.claude, MAESTRO_AGORA: '' }),
  });
}

suite.teste('CLI: --json --sem-gravar não grava; resumo legível; opção inválida sai 2', () => {
  const b = montarBase('cli');
  const usoArq = path.join(b.m, 'estado', 'uso.json');
  const r = rodarCli(b, ['--json', '--sem-gravar', '--agora', '2026-10-08T15:50:00-03:00']);
  assert.strictEqual(r.status, 0, r.stderr);
  const uso = JSON.parse(r.stdout);
  assert.strictEqual(linha(uso, 'janela_5h', 'cerebro').consumo_relativo, 2646);
  assert.ok(!fs.existsSync(usoArq) && !fs.existsSync(path.join(b.m, 'estado', 'uso-cache.json')), '--sem-gravar gravou algo');
  const h = rodarCli(b, ['--agora=2026-10-08T15:50:00-03:00']);
  assert.strictEqual(h.status, 0, h.stderr);
  assert.ok(h.stdout.includes('Plano: 5 h 40%') && h.stdout.includes('Gravado em estado/uso.json'), h.stdout);
  assert.ok(fs.existsSync(usoArq));
  const ruim = rodarCli(b, ['--opcao-que-nao-existe']);
  assert.strictEqual(ruim.status, 2);
  assert.strictEqual(ruim.stdout, '');
  assert.ok(ruim.stderr.includes('Opção desconhecida'));
  const agoraRuim = rodarCli(b, ['--agora', 'ontem']);
  assert.strictEqual(agoraRuim.status, 2);
});

suite.rodar().then(() => {
  if (!process.env.MANTER_TMP) for (const r of raizes) apagar(r);
});
