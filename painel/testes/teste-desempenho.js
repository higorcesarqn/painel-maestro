'use strict';
// Desempenho do servidor com muitos dados: 50 mil eventos em 2 meses e log bruto grande.
// Confere tempos com folga (máquina com antivírus) e que a segunda leitura é incremental.
// TESTE_PESADO=1 multiplica o log bruto por 5.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, MAESTRO, criarSuite, pastaTmp, apagar, escreverJson, portaLivre, pedir, esperarAte, derrubar } = require('./util');

const SERVIDOR = path.join(MAESTRO, 'painel', 'servidor.js');
const suite = criarSuite('desempenho do servidor (50 mil eventos, log bruto grande)');
const PESADO = process.env.TESTE_PESADO === '1';
const N_EVENTOS = 50000;
const BRUTO_POR_DIA = PESADO ? 50000 : 10000;
const AGORA = '2026-10-08T15:50:00-03:00';
const FLUXO_LONGO = 'F-20260908-0001';
const LONGO_POR_DIA = PESADO ? 8000 : 2000;
let raiz;
let S;

function pad(n, t = 2) {
  return String(n).padStart(t, '0');
}

function montar() {
  raiz = pastaTmp('desempenho');
  const m = path.join(raiz, 'maestro');
  escreverJson(path.join(m, 'registro', 'agentes.json'), {
    workspace: { nome: 'Exemplo', raiz: 'C:/teste' }, padrao: { modelo: 'x', nivel: 'xhigh' },
    agentes: [{ slug: 'cerebro', nome: 'Cérebro Principal', status: 'ativo' }, { slug: 'coordenador-trello', nome: 'Coordenador do Trello', status: 'ativo' }],
  });
  const dir = path.join(m, 'logs', 'eventos');
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.parse('2026-09-01T00:00:00-03:00');
  const passo = (Date.parse(AGORA) - base) / N_EVENTOS;
  const porMes = { '2026-09': [], '2026-10': [] };
  for (let i = 0; i < N_EVENTOS; i++) {
    const t = new Date(base + i * passo - 3 * 3600000);
    const ts = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}-03:00`;
    const dia = ts.slice(0, 10).replace(/-/g, '');
    const fluxo = `F-${dia}-${pad(1 + (i % 40), 4)}`;
    const ev = {
      id: `EV-${dia}-${ts.slice(11, 19).replace(/:/g, '')}-${i.toString(16).padStart(4, '0')}`, ts, agente: i % 3 ? 'cerebro' : 'coordenador-trello',
      fluxo_id: fluxo, origem: 'cerebro', tipo: i % 7 ? 'execucao' : 'decisao', projeto: 'HNMSTG'[i % 6],
      trello: { shortLink: `c${i}`, titulo: `A: tarefa número ${i} com acentuação`, url: `https://trello.com/c/c${i}` },
      resumo: `Executada a etapa ${i} do fluxo ${fluxo}`, direcao: `Escolhi o caminho ${i % 5} porque é o mais simples; ${'detalhe '.repeat(10)}`,
      passos: ['a', 'b', 'c'], comandos: ['node x.js'], alteracoes: [], resultado: i % 50 ? 'ok' : 'falhou', validacao: 'conferido',
      precisa_dono: i % 97 === 0, pendencias: [], duracao_s: i % 120, teste: i % 1000 === 0,
    };
    porMes[ts.slice(0, 7)].push(JSON.stringify(ev));
  }
  // Fluxo longo e aberto (08/09 a hoje) com log bruto em todos os dias: o índice do bruto evita reler tudo.
  porMes['2026-09'].push(JSON.stringify({ id: 'EV-20260908-090000-f001', ts: '2026-09-08T09:00:00-03:00', agente: 'cerebro', fluxo_id: FLUXO_LONGO, origem: 'dono-direto', tipo: 'pedido-recebido', resumo: 'Fluxo longo', resultado: 'em-andamento', sessao: 's1' }));
  porMes['2026-10'].push(JSON.stringify({ id: 'EV-20261008-150000-f002', ts: '2026-10-08T15:00:00-03:00', agente: 'cerebro', fluxo_id: FLUXO_LONGO, origem: 'cerebro', tipo: 'execucao', resumo: 'Fluxo longo segue', resultado: 'em-andamento', sessao: 's1' }));
  for (const [mes, linhas] of Object.entries(porMes)) fs.writeFileSync(path.join(dir, `${mes}.jsonl`), `${linhas.join('\n')}\n`);
  for (const ag of ['cerebro', 'coordenador-trello']) {
    for (const dia of ['2026-10-07', '2026-10-08']) {
      const linhas = [];
      const ini = Date.parse(`${dia}T00:00:00-03:00`);
      for (let i = 0; i < BRUTO_POR_DIA; i++) {
        const t = new Date(ini + i * (86400000 / BRUTO_POR_DIA) - 3 * 3600000);
        const ts = `${dia}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}-03:00`;
        linhas.push(JSON.stringify({
          ts, agente: ag, terminal: 't', sessao: 's1', fluxo_id: i % 2 ? `F-${dia.replace(/-/g, '')}-0001` : undefined,
          evento: 'PostToolUse', ferramenta: 'Bash', entrada: `comando ${i} ${'arg '.repeat(60)}`, ok: true, saida_resumo: 'x'.repeat(200), cwd: 'C:/x',
        }));
      }
      const arq = path.join(m, 'logs', 'bruto', ag, `${dia}.jsonl`);
      fs.mkdirSync(path.dirname(arq), { recursive: true });
      fs.writeFileSync(arq, `${linhas.join('\n')}\n`);
    }
  }
  for (const ag of ['cerebro', 'coordenador-trello']) {
    for (let d = Date.parse('2026-09-08T12:00:00Z'); d < Date.parse('2026-10-07T00:00:00Z'); d += 86400000) {
      const dia = new Date(d).toISOString().slice(0, 10);
      const linhas = [];
      for (let i = 0; i < LONGO_POR_DIA; i++) {
        const seg = Math.floor(i * 86400 / LONGO_POR_DIA);
        const ts = `${dia}T${pad(Math.floor(seg / 3600))}:${pad(Math.floor(seg / 60) % 60)}:${pad(seg % 60)}-03:00`;
        linhas.push(JSON.stringify({ ts, agente: ag, terminal: 't', sessao: 's1', fluxo_id: i % 3 ? FLUXO_LONGO : undefined, evento: 'PostToolUse', ferramenta: 'Bash', entrada: `comando ${i} ${'arg '.repeat(80)}`, ok: true, saida_resumo: 'y'.repeat(200), cwd: 'C:/x' }));
      }
      const arq = path.join(m, 'logs', 'bruto', ag, `${dia}.jsonl`);
      fs.mkdirSync(path.dirname(arq), { recursive: true });
      fs.writeFileSync(arq, `${linhas.join('\n')}\n`);
    }
  }
  return m;
}

async function tempo(fn) {
  const t0 = process.hrtime.bigint();
  const r = await fn();
  return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

function memoriaMb(pid) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const m = /"([\d.,\s]+) K"/.exec(r.stdout || '');
  return m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : null;
}

suite.teste('gera 50 mil eventos e o log bruto e sobe o servidor', async () => {
  const m = montar();
  const porta = await portaLivre();
  const env = Object.assign({}, process.env, { MAESTRO_DIR: m, PAINEL_AGORA: AGORA, PAINEL_COLETOR: '0', PAINEL_INDEX: path.join(raiz, 'x.html'), PAINEL_TRELLO_JANELA: '0-24', MAESTRI_DATA_DIR: path.join(raiz, 'maestri') });
  const filho = spawn(process.execPath, [SERVIDOR, '--porta', String(porta)], { env, windowsHide: true });
  let saida = '';
  filho.stdout.on('data', (c) => { saida += c; });
  const mm = await esperarAte(() => /\(PID (\d+)\)/.exec(saida), 15000);
  S = { porta, pid: Number(mm[1]) };
});

suite.teste('/api/estado: primeira leitura < 8 s, seguintes < 1 s (incremental)', async () => {
  const fria = await tempo(() => pedir(S.porta, '/api/estado'));
  assert.strictEqual(fria.r.status, 200);
  assert.strictEqual(fria.r.json.eventos.length, 200);
  const quente = await tempo(() => pedir(S.porta, '/api/estado'));
  console.log(`        /api/estado: fria ${fria.ms.toFixed(0)} ms, quente ${quente.ms.toFixed(0)} ms, ${(fria.r.buf.length / 1024).toFixed(0)} KB`);
  assert.ok(fria.ms < 8000, `fria lenta: ${fria.ms} ms`);
  assert.ok(quente.ms < 1000, `quente lenta: ${quente.ms} ms`);
  // Um evento novo no fim do mês entra sem reler o arquivo inteiro.
  const novo = { id: 'EV-20261008-155000-ffff', ts: '2026-10-08T15:50:00-03:00', agente: 'cerebro', fluxo_id: 'F-20261008-0001', origem: 'cerebro', tipo: 'aviso', resumo: 'Evento novíssimo', resultado: 'ok' };
  fs.appendFileSync(path.join(raiz, 'maestro', 'logs', 'eventos', '2026-10.jsonl'), `${JSON.stringify(novo)}\n`);
  const depois = await tempo(() => pedir(S.porta, '/api/estado'));
  assert.strictEqual(depois.r.json.eventos[0].id, 'EV-20261008-155000-ffff');
  assert.ok(depois.ms < 1500, `depois do append: ${depois.ms} ms`);
});

suite.teste('/api/eventos com busca e filtros em todos os meses < 2 s', async () => {
  const q = await tempo(() => pedir(S.porta, `/api/eventos?q=${encodeURIComponent('ACENTUAÇÃO 4999')}&so_dono=0&pagina=1`));
  assert.strictEqual(q.r.status, 200);
  assert.ok(q.r.json.total >= 1);
  const f = await tempo(() => pedir(S.porta, '/api/eventos?agente=coordenador-trello&tipo=decisao&desde=2026-09-10&ate=2026-10-05&por_pagina=500'));
  console.log(`        /api/eventos: busca ${q.ms.toFixed(0)} ms, filtros ${f.ms.toFixed(0)} ms (${f.r.json.total} eventos)`);
  assert.ok(q.ms < 2000 && f.ms < 2000);
});

suite.teste('/api/evento/<id> com milhares de comandos brutos no fluxo < 4 s, resposta limitada', async () => {
  const lista = (await pedir(S.porta, '/api/eventos?desde=2026-10-08&ate=2026-10-08&q=F-20261008-0001&por_pagina=1')).json;
  const id = lista.eventos[0].id;
  const d = await tempo(() => pedir(S.porta, `/api/evento/${id}`));
  assert.strictEqual(d.r.status, 200);
  assert.ok(d.r.json.comandos_brutos.length <= 1500);
  assert.strictEqual(d.r.json.comandos_truncados, true);
  const f = await tempo(() => pedir(S.porta, '/api/fluxo/F-20261008-0001'));
  console.log(`        /api/evento: ${d.ms.toFixed(0)} ms (${(d.r.buf.length / 1024).toFixed(0)} KB) · /api/fluxo: ${f.ms.toFixed(0)} ms · memória do servidor: ${memoriaMb(S.pid)} MB`);
  assert.ok(d.ms < 4000 && f.ms < 4000);
});

suite.teste('fluxo longo e aberto (31 dias de log bruto): a 2ª e a 3ª consultas não releem nada', async () => {
  const f1 = await tempo(() => pedir(S.porta, `/api/fluxo/${FLUXO_LONGO}`));
  assert.strictEqual(f1.r.status, 200);
  assert.ok(f1.r.json.comandos_brutos.length > 0 && f1.r.json.comandos_brutos.length <= 1500);
  assert.strictEqual(f1.r.json.comandos_truncados, true);
  assert.ok(f1.r.json.comandos_omitidos > 0);
  // Com o teto de leitura por consulta, um log bruto enorme se completa em poucas consultas.
  let consultas = 1;
  for (let r = f1.r; /ainda não foram lidos/.test(r.json.comandos_aviso || '') && consultas < 8; consultas++) r = await pedir(S.porta, `/api/fluxo/${FLUXO_LONGO}`);
  assert.ok(consultas < 8, 'o índice deveria se completar');
  if (consultas > 1) console.log(`        índice completo depois de ${consultas} consulta(s)`);
  const f2 = await tempo(() => pedir(S.porta, `/api/fluxo/${FLUXO_LONGO}`));
  assert.ok(!/ainda não foram lidos/.test(f2.r.json.comandos_aviso || ''));
  const f3 = await tempo(() => pedir(S.porta, `/api/fluxo/${FLUXO_LONGO}`));
  const e1 = await tempo(() => pedir(S.porta, '/api/evento/EV-20261008-150000-f002'));
  assert.strictEqual(e1.r.status, 200);
  const mb = memoriaMb(S.pid);
  console.log(`        /api/fluxo longo: ${f1.ms.toFixed(0)} ms, depois ${f2.ms.toFixed(0)} e ${f3.ms.toFixed(0)} ms · /api/evento ${e1.ms.toFixed(0)} ms (${(e1.r.buf.length / 1024).toFixed(0)} KB) · memória ${mb} MB`);
  // A consulta quente custa o mesmo que montar ~670 KB de resposta: o /api/evento (mesmo índice,
  // mesmo tamanho) mede esse custo na máquina de agora; reler o log bruto custaria muito mais.
  const teto = Math.max(800, f1.ms / 3, e1.ms * 1.5);
  assert.ok(f2.ms < teto && f3.ms < teto, `consultas seguintes deveriam usar o índice (teto ${teto.toFixed(0)} ms)`);
  assert.ok(e1.ms < 1500);
  if (mb !== null) assert.ok(mb < 700, `memória alta: ${mb} MB`);
});

suite.rodar().then(() => {
  if (S) derrubar(S.pid);
  if (!process.env.MANTER_TMP && raiz) apagar(raiz);
});
