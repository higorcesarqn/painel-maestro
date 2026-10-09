'use strict';
// Testes da resposta de pendência pelo painel (POST /api/pendencias/<id>/responder, api-pendencias.js):
// grava pelo pendencia.js responder (status, resposta, evento decisao) e avisa o Cérebro por um maestri falso.
// Nada sai daqui: raiz temporária em testes/tmp e o "maestri" é um script que só grava os argumentos.

const fs = require('fs');
const path = require('path');
const { assert, criarSuite, pastaTmp, apagar, escreverJson, portaLivre, pedir, esperarAte } = require('./util.js');
const srv = require('../servidor.js');
const pendApi = require('../api-pendencias.js');

const suite = criarSuite('pendências: responder pelo painel');
const raizes = [];
const POST = { metodo: 'POST', cabecalhos: { 'X-Painel': '1', 'Content-Type': 'application/json' } };

function pendencia(id, extra = {}) {
  return Object.assign({
    id, aberta_em: '2026-10-08T05:53:34-03:00', agente: 'coordenador-trello', fluxo_id: 'F-20261008-0004',
    severidade: 'alta', tipo: 'aprovacao', titulo: `Teste ${id}`, contexto: 'Contexto do teste.',
    opcoes: ['A: Aprovar tudo', 'B: Aprovar só a lista', 'C: Não aprovar agora'], recomendacao: 'A, porque sim.',
    trello: null, status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null,
  }, extra);
}

/** Raiz com um agentes.json fictício, pendências de teste e um maestri falso que grava argv em argv-<n>.json. */
function montarRaiz(nome) {
  const raiz = pastaTmp(nome);
  raizes.push(raiz);
  const m = path.join(raiz, 'maestro');
  escreverJson(path.join(m, 'registro', 'agentes.json'), {
    versao: 1, workspace: { nome: 'Exemplo' },
    agentes: [
      { slug: 'cerebro', nome: 'Cérebro Principal', tipo: 'maestro', status: 'ativo' },
      { slug: 'coordenador-trello', nome: 'Coordenador do Trello', tipo: 'sub-cerebro', status: 'ativo' },
    ],
  });
  escreverJson(path.join(m, 'estado', 'pendencias.json'), {
    proximo: 4,
    pendencias: [pendencia('P-0001'), pendencia('P-0002', { opcoes: [] }), pendencia('P-0003', { status: 'resolvida' })],
  });
  const falso = path.join(raiz, 'maestri-falso.js');
  fs.writeFileSync(falso, `require('fs').writeFileSync(require('path').join(__dirname, 'argv-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(process.argv.slice(2)));\n`);
  return { raiz, m, falso };
}

async function subir(r, extra = {}) {
  const porta = await portaLivre();
  const env = Object.assign({
    MAESTRO_DIR: r.m, PAINEL_COLETOR: '0', PAINEL_INDEX: path.join(r.raiz, 'x.html'), MAESTRI_DATA_DIR: path.join(r.raiz, 'maestri'),
    PAINEL_AVISAR_CEREBRO: '1', PAINEL_MAESTRI_CLI: r.falso,
  }, extra);
  const s = await srv.iniciar({ argv: ['--porta', String(porta)], env });
  return { porta, parar: () => s.parar() };
}

const lerPend = (r, id) => JSON.parse(fs.readFileSync(path.join(r.m, 'estado', 'pendencias.json'), 'utf8')).pendencias.find((p) => p.id === id);
const argvs = (r) => fs.readdirSync(r.raiz).filter((n) => /^argv-.+\.json$/.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(r.raiz, n), 'utf8')));
function eventos(r) {
  const d = path.join(r.m, 'logs', 'eventos');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

suite.teste('opção + comentário: grava respondida, evento decisao e avisa o Cérebro numa linha só', async () => {
  const r = montarRaiz('pend-ok');
  const s = await subir(r);
  try {
    const corpo = JSON.stringify({ opcao: 'a', texto: 'Pode seguir.\nUse C:\\pasta e "aspas".' });
    const res = await pedir(s.porta, '/api/pendencias/p-1/responder', Object.assign({ corpo }, POST));
    assert.strictEqual(res.status, 200, res.texto);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.aviso_cerebro.enviado, true, JSON.stringify(res.json.aviso_cerebro));
    assert.strictEqual(res.json.aviso_cerebro.para, 'Cérebro Principal');
    const p = lerPend(r, 'P-0001');
    assert.strictEqual(p.status, 'respondida');
    assert.ok(p.resposta.startsWith('A: Aprovar tudo · Comentário do dono: Pode seguir.'), p.resposta);
    assert.ok(p.respondida_em, 'respondida_em');
    const ev = eventos(r).find((e) => e.tipo === 'decisao' && (e.pendencias || []).includes('P-0001'));
    assert.ok(ev, 'evento decisao da P-0001');
    assert.strictEqual(ev.origem, 'dono-direto');
    assert.strictEqual(ev.fluxo_id, 'F-20261008-0004');
    const [argv] = await esperarAte(() => { const a = argvs(r); return a.length ? a : null; });
    assert.deepStrictEqual(argv.slice(0, 2), ['ask', 'Cérebro Principal']);
    const msg = argv[2];
    assert.ok(msg.startsWith('[RESPOSTA DO DONO PELO PAINEL] P-0001 · fluxo F-20261008-0004'), msg);
    assert.ok(!/[\\\n\r\t"]/.test(msg), `a mensagem não pode ter barra invertida, quebra de linha ou aspas retas: ${msg}`);
    assert.ok(msg.includes('Use C:/pasta'), msg);
  } finally {
    await s.parar();
  }
});

suite.teste('segunda resposta 409; sem opção nem texto 400; opção que não existe 400; id desconhecido 404', async () => {
  const r = montarRaiz('pend-erros');
  const s = await subir(r);
  try {
    const ok = await pedir(s.porta, '/api/pendencias/P-0002/responder', Object.assign({ corpo: JSON.stringify({ texto: 'Resposta livre' }) }, POST));
    assert.strictEqual(ok.status, 200, ok.texto);
    assert.strictEqual(lerPend(r, 'P-0002').resposta, 'Resposta livre');
    const de2 = await pedir(s.porta, '/api/pendencias/P-0002/responder', Object.assign({ corpo: JSON.stringify({ texto: 'outra' }) }, POST));
    assert.strictEqual(de2.status, 409, de2.texto);
    const fechada = await pedir(s.porta, '/api/pendencias/P-0003/responder', Object.assign({ corpo: JSON.stringify({ texto: 'x' }) }, POST));
    assert.strictEqual(fechada.status, 409, fechada.texto);
    const vazio = await pedir(s.porta, '/api/pendencias/P-0001/responder', Object.assign({ corpo: JSON.stringify({}) }, POST));
    assert.strictEqual(vazio.status, 400, vazio.texto);
    const semOpcao = await pedir(s.porta, '/api/pendencias/P-0001/responder', Object.assign({ corpo: JSON.stringify({ opcao: 'F' }) }, POST));
    assert.strictEqual(semOpcao.status, 400, semOpcao.texto);
    const invalido = await pedir(s.porta, '/api/pendencias/P-0001/responder', Object.assign({ corpo: 'não é json' }, POST));
    assert.strictEqual(invalido.status, 400, invalido.texto);
    const longo = await pedir(s.porta, '/api/pendencias/P-0001/responder', Object.assign({ corpo: JSON.stringify({ texto: 'x'.repeat(2001) }) }, POST));
    assert.strictEqual(longo.status, 400, longo.texto);
    const nenhuma = await pedir(s.porta, '/api/pendencias/P-0099/responder', Object.assign({ corpo: JSON.stringify({ texto: 'x' }) }, POST));
    assert.strictEqual(nenhuma.status, 404, nenhuma.texto);
    assert.strictEqual(lerPend(r, 'P-0001').status, 'aberta', 'os pedidos recusados não podem gravar nada');
  } finally {
    await s.parar();
  }
});

suite.teste('segurança: sem X-Painel 403, GET 405, id malformado 404', async () => {
  const r = montarRaiz('pend-seg');
  const s = await subir(r);
  try {
    const semCab = await pedir(s.porta, '/api/pendencias/P-0001/responder', { metodo: 'POST', corpo: JSON.stringify({ opcao: 'A' }) });
    assert.strictEqual(semCab.status, 403);
    assert.strictEqual((await pedir(s.porta, '/api/pendencias/P-0001/responder')).status, 405);
    assert.strictEqual((await pedir(s.porta, '/api/pendencias/..%2Fx/responder', Object.assign({ corpo: '{}' }, POST))).status, 404);
    assert.strictEqual(lerPend(r, 'P-0001').status, 'aberta');
    assert.strictEqual(argvs(r).length, 0);
  } finally {
    await s.parar();
  }
});

suite.teste('aviso desligado: grava mesmo assim e diz por quê; /api/estado conta se o aviso está ligado', async () => {
  const r = montarRaiz('pend-sem-aviso');
  const s = await subir(r, { PAINEL_AVISAR_CEREBRO: '0' });
  try {
    const est = await pedir(s.porta, '/api/estado');
    assert.strictEqual(est.json.respostas.aviso_cerebro, false);
    assert.ok(/PAINEL_AVISAR_CEREBRO=0/.test(est.json.respostas.motivo), est.json.respostas.motivo);
    const res = await pedir(s.porta, '/api/pendencias/P-0001/responder', Object.assign({ corpo: JSON.stringify({ opcao: 'B' }) }, POST));
    assert.strictEqual(res.status, 200, res.texto);
    assert.strictEqual(res.json.aviso_cerebro.enviado, false);
    assert.strictEqual(lerPend(r, 'P-0001').resposta, 'B: Aprovar só a lista');
    assert.strictEqual(argvs(r).length, 0);
  } finally {
    await s.parar();
  }
});

suite.teste('config: sem MAESTRI_TERMINAL_ID ou com relógio fixo o aviso fica desligado', () => {
  const sem = srv.lerConfig([], { PAINEL_COLETOR: '0' });
  assert.strictEqual(sem.avisoCerebro.ativo, false);
  const fixo = srv.lerConfig([], { MAESTRI_TERMINAL_ID: 'x', PAINEL_AGORA: '2026-10-08T15:50:00-03:00' });
  assert.strictEqual(fixo.avisoCerebro.ativo, false);
  const real = srv.lerConfig([], { MAESTRI_TERMINAL_ID: 'x', MAESTRI_CLI: 'C:/m/maestri.exe' });
  assert.deepStrictEqual([real.avisoCerebro.ativo, real.avisoCerebro.cli], [true, 'C:/m/maestri.exe']);
});

suite.teste('texto da opção: "A:", "Opção B -" e por posição', () => {
  assert.strictEqual(pendApi.textoDaOpcao({ opcoes: ['A: um', 'B: dois'] }, 'B'), 'B: dois');
  assert.strictEqual(pendApi.textoDaOpcao({ opcoes: ['Opção A - um', 'Opção B - dois'] }, 'A'), 'Opção A - um');
  assert.strictEqual(pendApi.textoDaOpcao({ opcoes: ['um', 'dois'] }, 'B'), 'B: dois');
  assert.strictEqual(pendApi.textoDaOpcao({ opcoes: ['um'] }, 'C'), null);
  assert.strictEqual(pendApi.normalizarId('p-7'), 'P-0007');
  assert.strictEqual(pendApi.normalizarId('P-0002/../x'), null);
});

suite.rodar().finally(() => {
  if (!process.env.MANTER_TMP) for (const d of raizes) apagar(d);
});
