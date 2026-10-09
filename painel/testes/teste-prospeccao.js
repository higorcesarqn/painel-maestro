'use strict';
// Testes da prospecção (painel/api-prospeccao.js + rotas do servidor.js + a página antiga painel/prospeccao.html):
//   1. servidor real numa raiz falsa (estado/prospeccao com leads, chips, sinais, envios, Serper):
//      /prospeccao redireciona para a tela do app (/#prospeccao), /prospeccao/antiga serve a página antiga
//      com a CSP da fonte do Google, Host, guarda de POST, assumir/devolver alterando o banco;
//   2. montarEstado em processo: banco vazio, banco grande, ambiente restaurado;
//   3. a página antiga sem navegador: sem emoji, só as cores da marca, Manrope, nada de innerHTML, script compila;
//   4. o app: a Prospecção é uma tela do menu (grupo Operações), com a fonte em painel/ui.
// Tudo em testes/tmp/prospeccao-<pid>/; servidor numa porta de 4790 a 4799, derrubado pelo PID impresso.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { assert, criarSuite, pastaTmp, apagar, escreverJson, escreverJsonl, portaLivre, pedir, esperarAte, derrubar, MAESTRO } = require('./util');

const PAINEL = path.resolve(__dirname, '..');
const SERVIDOR = path.join(PAINEL, 'servidor.js');
const PAGINA = path.join(PAINEL, 'prospeccao.html');
const html = fs.readFileSync(PAGINA, 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const js = scripts.map((m) => m[2]).join('\n');
const srv = require(SERVIDOR);
const api = require(path.join(PAINEL, 'api-prospeccao.js'));
const suite = criarSuite('prospecção (dashboard)');

const AGORA = '2026-10-08T15:50:00-03:00'; // quinta-feira, dentro das janelas
const T = Date.parse(AGORA);
const sp = (deltaH) => {
  const d = new Date(T + deltaH * 3600e3 - 3 * 3600e3);
  return `${d.toISOString().slice(0, 19)}-03:00`;
};
const CHAVE_FALSA = 'serper-chave-falsa-NAO-PODE-VAZAR-7f3a';
const WHATSAPP_DONO = '+5511900000001';
const NUMERO_TESTE = '+5511900000901';
const NUMERO_CHIP = '+5511900000101';
const HOSTIL = '<img src=x onerror=alert(1)>';

const raizes = [];
let R = null;
let S = null;

function lead(id, campos) {
  return Object.assign({
    id, status: 'READY_FOR_APPROACH', etapa: 'novo', origem: 'captador', telefone: null, whatsapp_confirmado: false,
    nome: null, empresa: id, instagram: null, cidade: 'Cidade A', estado: 'XX', segmento: 'varejo',
    pesquisa: null, observacao_concreta: null, gancho: null, potencial_futuro: [], prospect_score: null, classificacao: null,
    data_confidence: null, score_reason: [], distancia_km_aprox: null, numero_whatsapp: null, nota_conversa: null, temperatura: null,
    qualificacao: {}, historico: [], proximo_followup: null, followup_tipo: null, followups_feitos: 0,
    reuniao: { quando: null, link: null, confirmada: false }, notas_para_humano: '',
    humano: { ativo: false, motivo: null, desde: null, notificado_em: null, por: null },
    optout: false, abordado_em: null, ultimo_contato_em: null, ultima_mensagem_lead_em: null,
    criado_em: sp(-72), atualizado_em: sp(-72),
  }, campos);
}

function montarRaiz() {
  const raiz = pastaTmp('prospeccao');
  raizes.push(raiz);
  const m = path.join(raiz, 'maestro');
  const e = path.join(m, 'estado', 'prospeccao');
  escreverJson(path.join(m, 'registro', 'agentes.json'), { versao: 1, agentes: [] });
  escreverJson(path.join(e, 'operacao.json'), {
    qualificador: { ativo: true }, captador: { ativo: false }, modo_teste: true, numeros_teste: [NUMERO_TESTE],
    humano: { nome: 'Dono', whatsapp: WHATSAPP_DONO },
  });
  escreverJson(path.join(e, 'chips.json'), {
    chips: {
      'chip-01': { portal: 'WhatsApp chip-01', numero: NUMERO_CHIP, status: 'ativo', pausado_ate: null, motivo: null, proxima_abordagem_apos: null, criado_em: sp(-100) },
      'chip-02': { portal: 'WhatsApp chip-02', numero: null, status: 'pausado', pausado_ate: sp(30), motivo: 'bloqueios em sequência', proxima_abordagem_apos: null, criado_em: sp(-100) },
    },
  });
  escreverJson(path.join(e, 'sinais.json'), {
    chips: { 'chip-01': { nao_lidas: 2, titulo: '(2) WhatsApp', url: 'https://web.whatsapp.com/', conectado: true, visto_em: sp(-0.01), erro: null } },
    atualizado_em: sp(-0.01),
  });
  escreverJsonl(path.join(e, 'envios.jsonl'), [
    { quando: sp(-3), chip: 'chip-01', lead_id: 'L-quente', telefone: '+5511900000010', tipo: 'abordagem', texto: 'Oi' },
    { quando: sp(-2.9), chip: 'chip-01', lead_id: 'L-quente', telefone: '+5511900000010', tipo: 'abordagem', texto: 'Tudo bem?' },
    { quando: sp(-30), chip: 'chip-01', lead_id: 'L-velho', telefone: '+5511900000011', tipo: 'abordagem', texto: 'ontem' },
  ]);
  escreverJsonl(path.join(e, 'serper-chamadas.jsonl'), [
    { quando: sp(-1), endpoint: 'places', q: 'padaria Cidade A', cache: false, status: 200 },
    { quando: sp(-0.9), endpoint: 'places', q: 'padaria Cidade A', cache: true, status: 200 },
    { quando: sp(-0.8), endpoint: 'search', q: 'x', cache: false, status: 500 },
    { quando: sp(-30), endpoint: 'search', q: 'ontem', cache: false, status: 200 },
  ]);
  fs.mkdirSync(path.join(m, '.segredos'), { recursive: true });
  fs.writeFileSync(path.join(m, '.segredos', 'serper.key'), CHAVE_FALSA);
  const leads = {
    'L-quente': lead('L-quente', {
      status: 'CONTACTED', etapa: 'qualificando', empresa: 'Padaria Exemplo', telefone: '+5511900000010', numero_whatsapp: 'chip-01',
      nota_conversa: 78, temperatura: 'quente', gancho: 'fotos', prospect_score: 85, classificacao: 'HOT', data_confidence: 82,
      pesquisa: 'Loja física no centro.', observacao_concreta: 'Pães com cara de vitrine caprichada.',
      score_reason: ['+15 tamanho: 5,4 mil seguidores', '+10 sem loja online'],
      qualificacao: { tempo_atuacao: '3 anos', decisor: true, dor_principal: 'fotos' },
      historico: [
        { quando: sp(-3), de: 'agente', texto: 'Oi! Aqui é da Empresa Exemplo.', chip: 'chip-01' },
        { quando: sp(-2), de: 'lead', texto: 'Oi, tudo bem', chip: 'chip-01' },
        { quando: sp(-1.5), de: 'agente', texto: 'Vocês fazem as fotos por conta?', chip: 'chip-01' },
      ],
      abordado_em: sp(-3), ultimo_contato_em: sp(-1.5), ultima_mensagem_lead_em: sp(-2), proximo_followup: sp(46), followup_tipo: 'parou_de_responder',
      notas_para_humano: 'Sensível a preço.', avaliado_em: sp(-80), atualizado_em: sp(-1.5),
    }),
    'L-reuniao': lead('L-reuniao', {
      status: 'CONVERTED', etapa: 'reuniao_marcada', empresa: 'Café Exemplo', telefone: '+5511900000012', numero_whatsapp: 'chip-01',
      nota_conversa: 82, temperatura: 'quente', origem: 'importado', segmento: 'boutique',
      reuniao: { quando: sp(20), link: 'https://meet.google.com/abc-defg-hij', confirmada: false },
      abordado_em: sp(-50), ultimo_contato_em: sp(-5), ultima_mensagem_lead_em: sp(-5),
    }),
    'L-fila92': lead('L-fila92', { empresa: 'Loja Alfa', telefone: '+5511900000013', prospect_score: 92, classificacao: 'HOT+', data_confidence: 80, criado_em: sp(-2), avaliado_em: sp(-1), distancia_km_aprox: 4, followers: 5400, whatsapp_confirmado: true, has_ecommerce: false, google_reviews: 230, google_rating: 4.8, instagram_quality: 'fraco', gancho: 'fotos', instagram: '@lojaalfa.exemplo' }),
    'L-fila65': lead('L-fila65', { empresa: 'Loja 65', telefone: '+5511900000014', prospect_score: 65, classificacao: 'QUALIFICADO', data_confidence: 55, criado_em: sp(-2), avaliado_em: sp(-1) }),
    'L-semcontato': lead('L-semcontato', { status: 'QUALIFIED', empresa: 'Fixo 74', telefone: '+551130000001', prospect_score: 74, classificacao: 'WARM', data_confidence: 60 }),
    'L-descartado': lead('L-descartado', { status: 'DISCARDED', empresa: 'Rede X', prospect_score: 40, classificacao: 'DESCARTE', discard_reason: 'score abaixo de 60', atualizado_em: sp(-1) }),
    'L-perdido': lead('L-perdido', { status: 'DISCARDED', etapa: 'perdido', empresa: 'Disse pare', optout: true, telefone: '+5511900000015', abordado_em: sp(-100), numero_whatsapp: 'chip-01' }),
    'L-hostil': lead('L-hostil', { status: 'IN_APPROACH', etapa: 'abordado', empresa: HOSTIL, telefone: '+5511900000016', numero_whatsapp: 'chip-01', abordado_em: sp(-2.9), origem: 'teste', segmento: 'moda jovem' }),
    'L-descoberto': lead('L-descoberto', { status: 'DISCOVERED', empresa: 'Recém descoberta', criado_em: sp(-0.5) }),
  };
  escreverJson(path.join(e, 'leads.json'), { versao: 1, leads });
  return { raiz, m, e };
}

async function subir(r) {
  const porta = await portaLivre();
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: r.m, MAESTRI_DATA_DIR: path.join(r.raiz, 'maestri'), CLAUDE_CONFIG_DIR: path.join(r.raiz, 'claude'),
    PAINEL_AGORA: AGORA, MAESTRO_AGORA: '', PAINEL_COLETOR: '0', PAINEL_PORTA: '', PAINEL_INDEX: '', PAINEL_PROSPECCAO: '',
  });
  const filho = spawn(process.execPath, [SERVIDOR, '--porta', String(porta)], { env, windowsHide: true });
  let saida = '';
  let erro = '';
  filho.stdout.on('data', (c) => { saida += c; });
  filho.stderr.on('data', (c) => { erro += c; });
  const m = await esperarAte(() => {
    if (filho.exitCode !== null) throw new Error(`servidor saiu com ${filho.exitCode}: ${erro}`);
    return /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(saida);
  }, 15000);
  return { porta: Number(m[1]), pid: Number(m[2]), erro: () => erro };
}

const lerBanco = () => JSON.parse(fs.readFileSync(path.join(R.e, 'leads.json'), 'utf8'));
const post = (caminho, corpo, extra = {}) => pedir(S.porta, caminho, {
  metodo: 'POST', cabecalhos: Object.assign({ 'X-Painel': '1', 'Content-Type': 'application/json' }, extra.cabecalhos || {}),
  corpo: corpo === undefined ? undefined : typeof corpo === 'string' ? corpo : JSON.stringify(corpo), host: extra.host,
});

// Estado real: o banco e a operação não podem mudar durante os testes (a vigia real pode mexer em sinais.json).
const REAL = path.join(MAESTRO, 'estado', 'prospeccao');
function fotoReal() {
  return ['leads.json', 'operacao.json', 'optout.json', 'chips.json'].map((n) => {
    try {
      return `${n}:${fs.statSync(path.join(REAL, n)).mtimeMs}`;
    } catch (_) {
      return `${n}:ausente`;
    }
  }).join('|');
}
const fotoAntes = fotoReal();

suite.teste('sobe numa raiz falsa; GET /prospeccao manda para a tela do app (302 → /#prospeccao)', async () => {
  R = montarRaiz();
  S = await subir(R);
  const r = await pedir(S.porta, '/prospeccao');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/#prospeccao');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.strictEqual(r.headers['x-frame-options'], 'DENY');
  assert.strictEqual(String(r.headers['content-security-policy']), srv.CSP, 'o aviso do redirecionamento usa a CSP do painel, sem nada externo');
  assert.ok(r.texto.includes('href="/#prospeccao"'), 'o corpo tem o link para quem não segue o 302');
  const head = await pedir(S.porta, '/prospeccao', { metodo: 'HEAD' });
  assert.strictEqual(head.status, 302);
  assert.strictEqual(head.buf.length, 0);
});

suite.teste('GET /prospeccao/antiga serve a página antiga com CSP da fonte do Google, anti-iframe e no-store', async () => {
  const r = await pedir(S.porta, '/prospeccao/antiga');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.texto, html, 'serve o painel/prospeccao.html');
  assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.strictEqual(r.headers['x-frame-options'], 'DENY');
  const csp = String(r.headers['content-security-policy']);
  for (const parte of ["default-src 'none'", "frame-ancestors 'none'", 'style-src \'unsafe-inline\' https://fonts.googleapis.com', 'font-src \'self\' data: https://fonts.gstatic.com', "connect-src 'self'"]) {
    assert.ok(csp.includes(parte), `CSP sem ${parte}`);
  }
  assert.ok(!/script-src[^;]*https?:/.test(csp), 'nenhum script externo liberado');
  assert.ok(String(srv.CSP).includes("font-src 'self' data:;"), 'a CSP do painel principal continua sem nada externo');
  const head = await pedir(S.porta, '/prospeccao/antiga', { metodo: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.buf.length, 0);
  assert.strictEqual((await pedir(S.porta, '/prospeccao/')).status, 404);
  assert.strictEqual((await pedir(S.porta, '/prospeccao/antiga/')).status, 404);
  assert.strictEqual((await pedir(S.porta, '/prospeccao.html')).status, 404, 'o arquivo não é servido pelo nome');
});

suite.teste('GET /api/prospeccao/estado: KPIs das duas abas, kanban, chips, fila, para você, Serper', async () => {
  const r = await pedir(S.porta, '/api/prospeccao/estado');
  assert.strictEqual(r.status, 200, r.texto);
  assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  const e = r.json;
  for (const k of ['gerado_em', 'operacao', 'vigia', 'chips', 'contagens', 'qualificacao', 'prospeccao', 'avisos']) assert.ok(k in e, `falta ${k}`);
  assert.strictEqual(e.gerado_em, AGORA);
  assert.deepStrictEqual(
    { q: e.operacao.qualificador_ativo, c: e.operacao.captador_ativo, t: e.operacao.modo_teste, n: e.operacao.numeros_teste, ex: e.operacao.existe },
    { q: true, c: false, t: true, n: 1, ex: true });

  const k = e.qualificacao.kpis;
  assert.strictEqual(k.leads_hoje, 2, 'L-quente e L-hostil abordados hoje');
  assert.strictEqual(k.abordados_total, 4);
  assert.strictEqual(k.responderam_total, 2);
  assert.strictEqual(k.respostas_pct, 50);
  assert.strictEqual(k.qualificados, 1, 'reunião marcada conta como qualificado');
  assert.strictEqual(k.reunioes_marcadas, 1);
  assert.strictEqual(k.reunioes_48h, 1);
  assert.strictEqual(k.chips_ativos, 1);
  assert.strictEqual(k.chips_total, 2);

  const kb = e.qualificacao.kanban;
  assert.strictEqual(kb.novo.total, 2, 'a fila (READY_FOR_APPROACH) é a coluna novo');
  assert.strictEqual(kb.qualificando.leads[0].id, 'L-quente');
  assert.strictEqual(kb.reuniao_marcada.total, 1);
  assert.strictEqual(kb.perdido.total, 1);
  assert.strictEqual(kb.abordado.leads[0].empresa, HOSTIL, 'texto hostil chega cru; a página o mostra como texto');
  const todos = Object.values(kb).flatMap((c) => c.leads.map((l) => l.id));
  for (const fora of ['L-semcontato', 'L-descartado', 'L-descoberto']) assert.ok(!todos.includes(fora), `${fora} é do captador, não entra no kanban`);
  const c1 = kb.qualificando.leads[0];
  for (const campo of ['empresa', 'nota_conversa', 'temperatura', 'gancho', 'ultimo_contato_em', 'proximo_followup', 'chip', 'segmento', 'origem']) assert.ok(campo in c1, `cartão.${campo}`);

  const pv = e.qualificacao.para_voce;
  assert.deepStrictEqual(pv.reunioes_48h.map((l) => l.id), ['L-reuniao']);
  assert.deepStrictEqual(pv.quentes_sem_reuniao.map((l) => l.id), ['L-quente']);
  assert.deepStrictEqual(pv.com_humano, []);

  const ch = Object.fromEntries(e.chips.map((c) => [c.id, c]));
  assert.strictEqual(ch['chip-01'].nao_lidas, 2);
  assert.strictEqual(ch['chip-01'].conectado, true);
  assert.strictEqual(ch['chip-01'].abordagens_hoje, 1, 'abordagens = leads distintos de hoje');
  assert.strictEqual(ch['chip-01'].mensagens_hoje, 2);
  assert.strictEqual(ch['chip-01'].limite, 20);
  assert.strictEqual(ch['chip-02'].status, 'pausado');
  assert.strictEqual(ch['chip-02'].motivo_pausa, 'bloqueios em sequência');

  const p = e.prospeccao;
  assert.strictEqual(p.kpis.descobertos_hoje, 3, 'L-fila92, L-fila65 e L-descoberto criados hoje');
  assert.strictEqual(p.kpis.investigados_hoje, 3, 'avaliado_em hoje (2) + descartado sem avaliado_em mexido hoje (1)');
  assert.strictEqual(p.kpis.aprovados, 4, '85, 92, 65 e 74');
  assert.strictEqual(p.kpis.descartados, 1, 'só o descartado pelo captador');
  assert.deepStrictEqual(p.kpis.faixas, { '60+': 4, '70+': 3, '80+': 2, '90+': 1 });
  assert.strictEqual(p.kpis.capacidade_diaria, 20);
  assert.strictEqual(p.kpis.fila, 2);
  assert.strictEqual(p.kpis.fila_minima, 40);
  assert.strictEqual(p.kpis.dias_fila, 0.1);
  assert.strictEqual(p.fila_por_faixa['90+'], 1);
  assert.deepStrictEqual(p.tabela.leads.slice(0, 3).map((l) => l.id), ['L-fila92', 'L-quente', 'L-semcontato'], 'tabela pelo score');
  const t92 = p.tabela.leads[0];
  for (const campo of ['prospect_score', 'classificacao', 'empresa', 'instagram', 'followers', 'cidade', 'distancia_km_aprox', 'whatsapp_confirmado', 'has_ecommerce', 'google_reviews', 'instagram_quality', 'gancho', 'data_confidence', 'status']) {
    assert.ok(campo in t92, `tabela.${campo}`);
  }
  assert.deepStrictEqual(p.sem_contato.leads.map((l) => l.id), ['L-semcontato']);
  assert.deepStrictEqual({ total: p.serper.total, pagas: p.serper.pagas, cache: p.serper.cache, erros: p.serper.erros, chave: p.serper.tem_chave },
    { total: 3, pagas: 1, cache: 1, erros: 1, chave: true });
});

suite.teste('nada sensível sai na API: chave do Serper, WhatsApp do dono, números de teste e dos chips', async () => {
  for (const caminho of ['/api/prospeccao/estado', '/api/prospeccao/lead/L-quente']) {
    const t = (await pedir(S.porta, caminho)).texto;
    for (const segredo of [CHAVE_FALSA, WHATSAPP_DONO, NUMERO_TESTE, NUMERO_CHIP]) assert.ok(!t.includes(segredo), `${caminho} vazou ${segredo}`);
  }
});

suite.teste('GET /api/prospeccao/lead/<id>: lead completo com histórico; 404 e ids estranhos', async () => {
  const r = await pedir(S.porta, '/api/prospeccao/lead/L-quente');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.lead.id, 'L-quente');
  assert.strictEqual(r.json.lead.historico.length, 3);
  assert.deepStrictEqual(r.json.lead.score_reason, ['+15 tamanho: 5,4 mil seguidores', '+10 sem loja online']);
  assert.strictEqual(r.json.lead.pesquisa, 'Loja física no centro.');
  assert.strictEqual(r.json.portal, 'WhatsApp chip-01');
  const nao = await pedir(S.porta, '/api/prospeccao/lead/nao-existe');
  assert.strictEqual(nao.status, 404);
  assert.ok(nao.json && nao.json.erro);
  for (const c of ['/api/prospeccao/lead/', '/api/prospeccao/lead/..%2f..%2fleads', '/api/prospeccao/lead/a%00b', '/api/prospeccao/lead/%E0%A4%A',
    '/api/prospeccao/lead/a/b', '/api/prospeccao/lead/constructor%2F', '/api/prospeccao', '/api/prospeccao/', '/api/prospeccao/estado/x']) {
    assert.strictEqual((await pedir(S.porta, c)).status, 404, c);
  }
  assert.strictEqual((await pedir(S.porta, '/api/prospeccao/lead/constructor')).status, 404, 'chave do protótipo não é lead');
  assert.strictEqual(srv.acharRota('/api/prospeccao/lead/L-1').nome, 'prospeccao-lead');
  assert.strictEqual(srv.acharRota('/api/prospeccao/lead/..%2Fx'), null);
});

suite.teste('Host forjado → 403 nas rotas novas; métodos errados → 405', async () => {
  const p = S.porta;
  for (const host of ['evil.example', `evil.example:${p}`, '127.0.0.1:4777', `127.0.0.2:${p}`]) {
    for (const c of ['/prospeccao', '/prospeccao/antiga', '/api/prospeccao/estado', '/api/prospeccao/lead/L-quente']) {
      const r = await pedir(p, c, { host });
      assert.strictEqual(r.status, 403, `${host} ${c}`);
      assert.ok(!r.texto.includes('Padaria Exemplo'));
    }
    assert.strictEqual((await post('/api/prospeccao/assumir', { lead_id: 'L-quente' }, { host })).status, 403);
  }
  assert.strictEqual((await pedir(p, '/api/prospeccao/estado', { host: `localhost:${p}` })).status, 200);
  assert.strictEqual((await pedir(p, '/api/prospeccao/assumir')).status, 405);
  assert.strictEqual((await pedir(p, '/api/prospeccao/estado', { metodo: 'POST', cabecalhos: { 'X-Painel': '1' } })).status, 405);
  assert.strictEqual((await pedir(p, '/prospeccao', { metodo: 'DELETE' })).status, 405);
  assert.strictEqual((await pedir(p, '/prospeccao/antiga', { metodo: 'POST', cabecalhos: { 'X-Painel': '1' } })).status, 405);
  assert.strictEqual(lerBanco().leads['L-quente'].humano.ativo, false, 'nada mudou no banco');
});

suite.teste('guarda de POST: sem X-Painel ou com Origin de fora → 403; corpo inválido → 400; lead inexistente → 404; corpo grande → 413', async () => {
  const antes = fs.readFileSync(path.join(R.e, 'leads.json'), 'utf8');
  const semCab = await pedir(S.porta, '/api/prospeccao/assumir', { metodo: 'POST', cabecalhos: { 'Content-Type': 'application/json' }, corpo: JSON.stringify({ lead_id: 'L-quente' }) });
  assert.strictEqual(semCab.status, 403);
  assert.strictEqual((await post('/api/prospeccao/assumir', { lead_id: 'L-quente' }, { cabecalhos: { Origin: 'http://evil.example' } })).status, 403);
  assert.strictEqual((await post('/api/prospeccao/devolver', { lead_id: 'L-quente' }, { cabecalhos: { 'X-Painel': '0' } })).status, 403);
  assert.strictEqual((await post('/api/prospeccao/assumir')).status, 400, 'sem corpo');
  assert.strictEqual((await post('/api/prospeccao/assumir', '{lead_id:')).status, 400, 'JSON quebrado');
  assert.strictEqual((await post('/api/prospeccao/assumir', { id: 'L-quente' })).status, 400, 'sem lead_id');
  assert.strictEqual((await post('/api/prospeccao/assumir', { lead_id: '../leads' })).status, 400, 'lead_id fora do formato');
  assert.strictEqual((await post('/api/prospeccao/assumir', { lead_id: 'nao-existe' })).status, 404);
  assert.strictEqual((await post('/api/prospeccao/assumir', { lead_id: 'L-quente', x: 'a'.repeat(20000) })).status, 413);
  assert.strictEqual(fs.readFileSync(path.join(R.e, 'leads.json'), 'utf8'), antes, 'o banco não mudou');
});

suite.teste('assumir: pausa o agente no lead (humano.por = painel) pelo leads.js; devolver o devolve; devolver de novo → 409', async () => {
  const a = await post('/api/prospeccao/assumir', { lead_id: 'L-quente' }, { cabecalhos: { Origin: `http://127.0.0.1:${S.porta}` } });
  assert.strictEqual(a.status, 200, a.texto);
  assert.strictEqual(a.json.ok, true);
  assert.strictEqual(a.json.lead.etapa, 'passado_humano');
  let l = lerBanco().leads['L-quente'];
  assert.strictEqual(l.humano.ativo, true);
  assert.strictEqual(l.humano.por, 'painel');
  assert.strictEqual(l.humano.etapa_anterior, 'qualificando');
  assert.ok(l.humano.notificado_em, 'quem assumiu foi o dono: o aviso não fica pendente');
  assert.strictEqual(l.etapa, 'passado_humano');
  assert.strictEqual(l.proximo_followup, null, 'sem follow-up com o humano');
  assert.ok(!a.texto.includes(WHATSAPP_DONO), 'a resposta não traz o WhatsApp do dono');

  const e = (await pedir(S.porta, '/api/prospeccao/estado')).json;
  assert.deepStrictEqual(e.qualificacao.para_voce.com_humano.map((x) => x.id), ['L-quente']);
  assert.strictEqual(e.qualificacao.kanban.passado_humano.leads[0].humano.por, 'painel');
  assert.deepStrictEqual(e.qualificacao.para_voce.quentes_sem_reuniao, [], 'lead com o humano sai de "quentes sem reunião"');

  const d = await post('/api/prospeccao/devolver', { lead_id: 'L-quente' });
  assert.strictEqual(d.status, 200, d.texto);
  l = lerBanco().leads['L-quente'];
  assert.strictEqual(l.humano.ativo, false);
  assert.strictEqual(l.etapa, 'qualificando', 'volta para a etapa de antes');
  assert.strictEqual(l.status, 'CONTACTED');
  const de2 = await post('/api/prospeccao/devolver', { lead_id: 'L-quente' });
  assert.strictEqual(de2.status, 409);
  assert.ok(/não está com o humano/.test(de2.json.erro), de2.json.erro);
});

suite.teste('o estado real (_maestro/estado/prospeccao) não foi tocado', () => {
  assert.strictEqual(fotoReal(), fotoAntes);
});

suite.teste('montarEstado em processo: banco vazio vira zeros e listas vazias; não cria arquivo; ambiente restaurado', () => {
  const raiz = pastaTmp('prospeccao-vazio');
  raizes.push(raiz);
  const antes = { dir: process.env.MAESTRO_DIR, agora: process.env.MAESTRO_AGORA };
  const e = api.montarEstado({ maestroDir: raiz, agoraFixa: new Date(T) }, new Date(T));
  assert.deepStrictEqual({ dir: process.env.MAESTRO_DIR, agora: process.env.MAESTRO_AGORA }, antes, 'MAESTRO_DIR e MAESTRO_AGORA voltam ao que eram');
  assert.strictEqual(e.contagens.total, 0);
  assert.strictEqual(e.operacao.existe, false);
  assert.strictEqual(e.operacao.qualificador_ativo, false, 'sem operacao.json: desligada (padrão)');
  assert.strictEqual(e.operacao.modo_teste, true);
  assert.deepStrictEqual(e.chips, []);
  assert.strictEqual(e.qualificacao.kpis.respostas_pct, null);
  assert.strictEqual(e.prospeccao.kpis.dias_fila, null, 'sem chip ativo não há dias de fila');
  assert.strictEqual(e.prospeccao.serper.tem_chave, false);
  assert.ok(Object.values(e.qualificacao.kanban).every((c) => c.total === 0 && c.leads.length === 0));
  assert.ok(!fs.existsSync(path.join(raiz, 'estado', 'prospeccao', 'operacao.json')), 'a leitura não grava nada');
});

suite.teste('banco grande (6000 leads): uma leitura, resposta enxuta (200 por etapa, 300 na tabela) e rápida', () => {
  const raiz = pastaTmp('prospeccao-grande');
  raizes.push(raiz);
  const leads = {};
  for (let i = 0; i < 6000; i++) {
    const id = `G-${i}`;
    leads[id] = lead(id, { prospect_score: i % 100, telefone: `+55119000${String(i).padStart(5, '0')}`, historico: [{ quando: sp(-1), de: 'agente', texto: 'x'.repeat(200) }] });
  }
  escreverJson(path.join(raiz, 'estado', 'prospeccao', 'leads.json'), { versao: 1, leads });
  const t0 = Date.now();
  const e = api.montarEstado({ maestroDir: raiz, agoraFixa: new Date(T) }, new Date(T));
  const ms = Date.now() - t0;
  assert.strictEqual(e.contagens.total, 6000);
  assert.strictEqual(e.qualificacao.kanban.novo.total, 6000);
  assert.strictEqual(e.qualificacao.kanban.novo.leads.length, 200);
  assert.strictEqual(e.prospeccao.tabela.total, 6000);
  assert.strictEqual(e.prospeccao.tabela.leads.length, 300);
  assert.strictEqual(e.prospeccao.tabela.leads[0].prospect_score, 99);
  const tamanho = JSON.stringify(e).length;
  assert.ok(tamanho < 600 * 1024, `resposta com ${tamanho} bytes`);
  assert.ok(ms < 5000, `levou ${ms} ms`);
});

// ---------- a página ----------

const CORES_DA_MARCA = new Set(['#000', '#000000', '#101010', '#242424', '#f5f5f5', '#888', '#888888', '#0000ff', '#4f6bff']);

suite.teste('página: sem emoji, sem gradiente, só as cores da marca (02 §A7), Manrope 300/400, rótulos .3em', () => {
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u.exec(html);
  assert.strictEqual(emoji, null, `emoji encontrado: ${emoji && emoji[0]}`);
  assert.ok(!/gradient/i.test(html), 'nada de gradiente');
  const cores = [...html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  const fora = [...new Set(cores.filter((c) => !CORES_DA_MARCA.has(c)))];
  assert.deepStrictEqual(fora, [], `cores fora da marca: ${fora.join(' ')}`);
  assert.ok(!/\brgb\((?!0, 0, 0)|\bhsl\(/i.test(html), 'sem rgb()/hsl() de outras cores');
  for (const token of ['--fundo: #000', '--cartao: #101010', '--borda: #242424', '--texto: #F5F5F5', '--mudo: #888', '--azul: #0000FF', '--azul-texto: #4F6BFF', '--raio: 14px']) {
    assert.ok(html.includes(token), `falta ${token}`);
  }
  assert.ok(/border: 1px solid var\(--borda\); border-radius: var\(--raio\)/.test(html), 'cartão com borda 1px #242424 e raio 14px');
  assert.ok(html.includes('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400&display=swap'), 'Manrope 300/400 do Google Fonts');
  assert.ok(/letter-spacing: \.3em; text-transform: uppercase/.test(html), 'rótulos em caixa alta com .3em');
  assert.ok(/stroke-width: 1\.75/.test(html), 'ícones monoline stroke 1.75');
  const pesos = [...html.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1]);
  assert.ok(pesos.every((p) => p === '300' || p === '400'), `pesos fora de 300/400: ${pesos.join(',')}`);
});

suite.teste('página: só a fonte é externa; texto da API entra como texto; script compila e usa as rotas certas', () => {
  assert.strictEqual(scripts.length, 1);
  assert.ok(!/\bsrc\s*=/.test(scripts[0][1]), 'o <script> não tem src');
  const urls = (html.match(/https?:\/\/[^\s"'`)<\\]+/g) || []).filter((u) => !/^https:\/\/fonts\.googleapis\.com\/css2\?family=Manrope/.test(u)
    && u !== 'http://www.w3.org/2000/svg' && !/^https:\/\/meet\.google\.com/.test(u) && u !== 'https://');
  assert.deepStrictEqual(urls, [], `URLs inesperadas: ${urls.join(' ')}`);
  for (const proibido of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /setAttribute\(\s*['"]on/, /DOMParser/]) {
    assert.ok(!proibido.test(js), `uso proibido: ${proibido}`);
  }
  assert.ok(/x\.protocol === 'https:' && x\.hostname === 'meet\.google\.com'/.test(js), 'link de reunião só https://meet.google.com');
  new vm.Script(js, { filename: 'prospeccao.html#script' });
  for (const rota of ["'/api/prospeccao/estado'", '`/api/prospeccao/lead/${encodeURIComponent(id)}`', '`/api/prospeccao/${acao}`']) assert.ok(js.includes(rota), `a página chama ${rota}`);
  assert.ok(/'X-Painel'\] = '1'/.test(js), 'POST leva X-Painel: 1');
  assert.ok(/const INTERVALO_MS = 30000;/.test(js), 'atualiza a cada 30 s');
  assert.ok(/const TZ = 'America\/Sao_Paulo'/.test(js));
  for (const texto of ['Assumir conversa', 'Devolver ao agente', 'Para você agora', 'Score alto sem contato', 'Modo teste', 'Operação desligada', 'Dias de fila']) {
    assert.ok(html.includes(texto), `falta "${texto}"`);
  }
  assert.ok(/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(html) && /@media \(max-width: 640px\)/.test(html), 'funciona em celular');
});

suite.teste('app: a Prospecção é uma tela do menu, no grupo Operações (fonte em painel/ui)', () => {
  const UI = path.join(PAINEL, 'ui', 'src');
  const contexto = fs.readFileSync(path.join(UI, 'dados', 'contexto.js'), 'utf8');
  assert.ok(/\{ id: 'operacoes', nome: 'Operações' \}/.test(contexto), 'GRUPOS tem Operações');
  assert.ok(/\{ id: 'prospeccao', nome: 'Prospecção', titulo: 'Prospecção', grupo: 'operacoes' \}/.test(contexto), 'ABAS tem a Prospecção no grupo Operações');
  const app = fs.readFileSync(path.join(UI, 'app', 'App.jsx'), 'utf8');
  assert.ok(/prospeccao: Prospeccao/.test(app), 'a tela está em TELAS');
  const lateral = fs.readFileSync(path.join(UI, 'app', 'Lateral.jsx'), 'utf8');
  assert.ok(!/href="\/prospeccao"/.test(lateral), 'o menu não tem mais o link para a página separada');
  const tela = fs.readFileSync(path.join(UI, 'telas', 'Prospeccao.jsx'), 'utf8') + fs.readFileSync(path.join(UI, 'telas', 'ProspeccaoLead.jsx'), 'utf8');
  for (const texto of ['Para você agora', 'Score alto sem contato', 'Dias de fila', 'Serper hoje', 'Funil', 'Captação', 'Assumir conversa', 'Devolver ao agente']) {
    assert.ok(tela.includes(texto), `a tela tem "${texto}"`);
  }
  for (const proibido of [/innerHTML/, /dangerouslySetInnerHTML/, /\beval\s*\(/, /new\s+Function\s*\(/]) assert.ok(!proibido.test(tela), `uso proibido: ${proibido}`);
  assert.ok(/x\.protocol === 'https:' && x\.hostname === 'meet\.google\.com'/.test(fs.readFileSync(path.join(UI, 'telas', 'ProspeccaoComum.jsx'), 'utf8')), 'link de reunião só https://meet.google.com');
  assert.ok(fs.readFileSync(path.join(PAINEL, 'index.html'), 'utf8').includes('prospeccao'), 'o index.html publicado leva à Prospecção');
});

(async () => {
  try {
    await suite.rodar();
  } finally {
    if (S) derrubar(S.pid);
    if (!process.env.MANTER_TMP) for (const r of raizes) apagar(r);
  }
})();
