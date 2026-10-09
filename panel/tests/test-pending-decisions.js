'use strict';
// Tests for the pending decision answer through the panel (POST /api/pending-decisions/<id>/answer,
// api-pendencias.js, old model removed in #18): writes through bin/pendencia.js responder (status, answer,
// decisao event) and notifies the Brain through a fake maestri. Nothing leaves this machine: temporary root
// under tests/tmp and the "maestri" is a script that only records its arguments.

const fs = require('fs');
const path = require('path');
const { assert, createSuite, tmpDir, remove, writeJson, freePort, request, waitFor } = require('./util.js');
const srv = require('../server.js');
const pendingApi = require('../api-pendencias.js');

const suite = createSuite('pending decisions: answer through the panel');
const roots = [];
const POST = { method: 'POST', headers: { 'X-Panel': '1', 'Content-Type': 'application/json' } };

/** Old-model pending decision record, as bin/pendencia.js writes it. */
function pendingDecision(id, extra = {}) {
  return Object.assign({
    id, aberta_em: '2026-10-08T05:53:34-03:00', agente: 'coordenador', fluxo_id: 'F-20261008-0004',
    severidade: 'alta', tipo: 'aprovacao', titulo: `Teste ${id}`, contexto: 'Contexto do teste.',
    opcoes: ['A: Aprovar tudo', 'B: Aprovar só a lista', 'C: Não aprovar agora'], recomendacao: 'A, porque sim.',
    status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null,
  }, extra);
}

/** Root with a fictitious agentes.json, test pending decisions and a fake maestri that writes argv to argv-<n>.json. */
function buildRoot(name) {
  const root = tmpDir(name);
  roots.push(root);
  const m = path.join(root, 'maestro');
  writeJson(path.join(m, 'registro', 'agentes.json'), {
    versao: 1, workspace: { nome: 'Exemplo' },
    agentes: [
      { slug: 'cerebro', nome: 'Cérebro Principal', tipo: 'maestro', status: 'ativo' },
      { slug: 'coordenador', nome: 'Coordenador', tipo: 'sub-cerebro', status: 'ativo' },
    ],
  });
  writeJson(path.join(m, 'estado', 'pendencias.json'), {
    proximo: 4,
    pendencias: [pendingDecision('P-0001'), pendingDecision('P-0002', { opcoes: [] }), pendingDecision('P-0003', { status: 'resolvida' })],
  });
  const fake = path.join(root, 'fake-maestri.js');
  fs.writeFileSync(fake, `require('fs').writeFileSync(require('path').join(__dirname, 'argv-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(process.argv.slice(2)));\n`);
  return { root, m, fake };
}

async function start(r, extra = {}) {
  const port = await freePort();
  const env = Object.assign({
    MAESTRO_DIR: r.m, PANEL_COLLECTOR: '0', PANEL_INDEX: path.join(r.root, 'x.html'), MAESTRI_DATA_DIR: path.join(r.root, 'maestri'),
    PANEL_NOTIFY_BRAIN: '1', PANEL_MAESTRI_CLI: r.fake,
  }, extra);
  const s = await srv.start({ argv: ['--port', String(port)], env });
  return { port, stop: () => s.stop() };
}

const readPending = (r, id) => JSON.parse(fs.readFileSync(path.join(r.m, 'estado', 'pendencias.json'), 'utf8')).pendencias.find((p) => p.id === id);
const argvs = (r) => fs.readdirSync(r.root).filter((n) => /^argv-.+\.json$/.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(r.root, n), 'utf8')));
function events(r) {
  const d = path.join(r.m, 'logs', 'eventos');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const answer = (s, id, body) => request(s.port, `/api/pending-decisions/${id}/answer`, Object.assign({ body: typeof body === 'string' ? body : JSON.stringify(body) }, POST));

suite.test('option + comment: writes answered, a decisao event and notifies the Brain in a single line', async () => {
  const r = buildRoot('pend-ok');
  const s = await start(r);
  try {
    const res = await answer(s, 'p-1', { option: 'a', text: 'Pode seguir.\nUse C:\\pasta e "aspas".' });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.json.ok, true);
    assert.deepStrictEqual(res.json.brain_notice, { sent: true, to: 'Cérebro Principal' });
    assert.strictEqual(res.json.pending_decision.id, 'P-0001');
    assert.strictEqual(res.json.pending_decision.status, 'respondida');
    assert.ok(res.json.pending_decision.answer.startsWith('A: Aprovar tudo · Comentário do dono: Pode seguir.'), res.json.pending_decision.answer);
    const p = readPending(r, 'P-0001');
    assert.strictEqual(p.status, 'respondida');
    assert.ok(p.resposta.startsWith('A: Aprovar tudo · Comentário do dono: Pode seguir.'), p.resposta);
    assert.ok(p.respondida_em, 'respondida_em');
    const ev = events(r).find((e) => e.tipo === 'decisao' && (e.pendencias || []).includes('P-0001'));
    assert.ok(ev, 'decisao event of P-0001');
    assert.strictEqual(ev.origem, 'dono-direto');
    assert.strictEqual(ev.fluxo_id, 'F-20261008-0004');
    const [argv] = await waitFor(() => { const a = argvs(r); return a.length ? a : null; });
    assert.deepStrictEqual(argv.slice(0, 2), ['ask', 'Cérebro Principal']);
    const msg = argv[2];
    assert.ok(msg.startsWith('[RESPOSTA DO DONO PELO PAINEL] P-0001 · fluxo F-20261008-0004'), msg);
    assert.ok(!/[\\\n\r\t"]/.test(msg), `the message cannot have a backslash, line break or straight quotes: ${msg}`);
    assert.ok(msg.includes('Use C:/pasta'), msg);
  } finally {
    await s.stop();
  }
});

suite.test('second answer 409; neither option nor text 400; missing option 400; unknown id 404 — all as codes', async () => {
  const r = buildRoot('pend-errors');
  const s = await start(r);
  try {
    const ok = await answer(s, 'P-0002', { text: 'Resposta livre' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(readPending(r, 'P-0002').resposta, 'Resposta livre');
    const again = await answer(s, 'P-0002', { text: 'outra' });
    assert.strictEqual(again.status, 409, again.text);
    assert.deepStrictEqual(again.json, { error: { code: 'pending_decision_not_open', id: 'P-0002', status: 'respondida' } });
    const closed = await answer(s, 'P-0003', { text: 'x' });
    assert.strictEqual(closed.status, 409, closed.text);
    const empty = await answer(s, 'P-0001', {});
    assert.deepStrictEqual([empty.status, empty.json], [400, { error: { code: 'answer_empty' } }]);
    const noOption = await answer(s, 'P-0001', { option: 'F' });
    assert.deepStrictEqual([noOption.status, noOption.json], [400, { error: { code: 'option_not_found', id: 'P-0001', option: 'F' } }]);
    const invalid = await answer(s, 'P-0001', 'não é json');
    assert.deepStrictEqual([invalid.status, invalid.json], [400, { error: { code: 'invalid_body' } }]);
    const long = await answer(s, 'P-0001', { text: 'x'.repeat(2001) });
    assert.deepStrictEqual([long.status, long.json], [400, { error: { code: 'answer_too_long', max: 2000 } }]);
    const none = await answer(s, 'P-0099', { text: 'x' });
    assert.deepStrictEqual([none.status, none.json], [404, { error: { code: 'pending_decision_not_found', id: 'P-0099' } }]);
    assert.strictEqual(readPending(r, 'P-0001').status, 'aberta', 'refused requests cannot write anything');
  } finally {
    await s.stop();
  }
});

suite.test('security: without X-Panel 403, GET 405, malformed id 404; the old route is gone', async () => {
  const r = buildRoot('pend-sec');
  const s = await start(r);
  try {
    const noHeader = await request(s.port, '/api/pending-decisions/P-0001/answer', { method: 'POST', body: JSON.stringify({ option: 'A' }) });
    assert.strictEqual(noHeader.status, 403);
    assert.strictEqual((await request(s.port, '/api/pending-decisions/P-0001/answer')).status, 405);
    assert.strictEqual((await request(s.port, '/api/pending-decisions/..%2Fx/answer', Object.assign({ body: '{}' }, POST))).status, 404);
    assert.strictEqual((await request(s.port, '/api/pendencias/P-0001/responder', Object.assign({ body: '{"opcao":"A"}' }, POST))).status, 404);
    assert.strictEqual(readPending(r, 'P-0001').status, 'aberta');
    assert.strictEqual(argvs(r).length, 0);
  } finally {
    await s.stop();
  }
});

suite.test('notice off: writes anyway and says why with a code; /api/state tells whether the notice is on', async () => {
  const r = buildRoot('pend-no-notice');
  const s = await start(r, { PANEL_NOTIFY_BRAIN: '0' });
  try {
    const st = await request(s.port, '/api/state');
    assert.deepStrictEqual(st.json.answers, { brain_notice: false, reason: { code: 'brain_notice_off', variable: 'PANEL_NOTIFY_BRAIN' } });
    const res = await answer(s, 'P-0001', { option: 'B' });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.json.brain_notice, { sent: false, reason: { code: 'brain_notice_off', variable: 'PANEL_NOTIFY_BRAIN' } });
    assert.strictEqual(readPending(r, 'P-0001').resposta, 'B: Aprovar só a lista');
    assert.strictEqual(argvs(r).length, 0);
  } finally {
    await s.stop();
  }
});

suite.test('config: without MAESTRI_TERMINAL_ID or with a fixed clock the notice stays off', () => {
  const without = srv.parseConfig([], { PANEL_COLLECTOR: '0' });
  assert.deepStrictEqual([without.brainNotice.active, without.brainNotice.reason], [false, { code: 'brain_notice_no_terminal' }]);
  const fixed = srv.parseConfig([], { MAESTRI_TERMINAL_ID: 'x', PANEL_NOW: '2026-10-08T15:50:00-03:00' });
  assert.deepStrictEqual([fixed.brainNotice.active, fixed.brainNotice.reason], [false, { code: 'brain_notice_fixed_clock' }]);
  const real = srv.parseConfig([], { MAESTRI_TERMINAL_ID: 'x', MAESTRI_CLI: 'C:/m/maestri.exe' });
  assert.deepStrictEqual([real.brainNotice.active, real.brainNotice.cli], [true, 'C:/m/maestri.exe']);
});

suite.test('option text: "A:", "Opção B -" and by position', () => {
  assert.strictEqual(pendingApi.optionText({ opcoes: ['A: um', 'B: dois'] }, 'B'), 'B: dois');
  assert.strictEqual(pendingApi.optionText({ opcoes: ['Opção A - um', 'Opção B - dois'] }, 'A'), 'Opção A - um');
  assert.strictEqual(pendingApi.optionText({ opcoes: ['um', 'dois'] }, 'B'), 'B: dois');
  assert.strictEqual(pendingApi.optionText({ opcoes: ['um'] }, 'C'), null);
  assert.strictEqual(pendingApi.normalizeId('p-7'), 'P-0007');
  assert.strictEqual(pendingApi.normalizeId('P-0002/../x'), null);
});

suite.run().finally(() => {
  if (!process.env.KEEP_TMP) for (const d of roots) remove(d);
});
