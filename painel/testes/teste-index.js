'use strict';
// Testes do index.html (frontend) sem navegador. A página é o app Preact de painel/ui compilado num arquivo
// único (npm run build); as regras de código valem para a FONTE (ui/src), e as de arquivo único para o build:
//   1. regras do arquivo único: nada externo (a fonte vem embutida), script válido;
//   2. nenhum HTML montado a partir de texto, na fonte; links externos só pelas funções que conferem o host;
//   3. o build compila e só chama as rotas do contrato;
//   4. o mock (?mock=1) cobre o contrato de /api/estado e tem os números pedidos;
//   5. o servidor.js de verdade, numa raiz falsa montada a partir do mock (com dados hostis),
//      entrega tudo o que a página lê (campos, filtros, modal, fluxo) e serve o index.html com CSP.
// Servidor de teste numa porta de 4790 a 4799, derrubado pelo PID que ele imprime.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const { assert, criarSuite, TMP, portaLivre, pedir, esperarAte, derrubar, apagar } = require('./util');

const PAINEL = path.resolve(__dirname, '..');
const INDEX = path.join(PAINEL, 'index.html');
const SERVIDOR = path.join(PAINEL, 'servidor.js');
const FONTE = path.join(PAINEL, 'ui', 'src');
const html = fs.readFileSync(INDEX, 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const js = scripts.map((m) => m[2]).join('\n');
const suite = criarSuite('index.html (frontend)');

/** Arquivos .js/.jsx da fonte do app: { caminho relativo: texto }. */
function lerFonte(dir = FONTE, base = FONTE, acc = {}) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) lerFonte(p, base, acc);
    else if (/\.(js|jsx)$/.test(n.name)) acc[path.relative(base, p).replace(/\\/g, '/')] = fs.readFileSync(p, 'utf8');
  }
  return acc;
}
const fonte = lerFonte();
const fonteToda = Object.values(fonte).join('\n');

// Identificadores de namespace XML que o Preact usa em createElementNS: nunca são baixados.
const NAMESPACES = /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xhtml|1998\/Math\/MathML|1999\/xlink|XML\/1998\/namespace)$/;

suite.teste('arquivo único: sem script, folha de estilo, fonte ou imagem externa', () => {
  assert.strictEqual(scripts.length, 1, 'um único <script> embutido');
  assert.ok(!/\bsrc\s*=/.test(scripts[0][1]), 'o <script> não tem src');
  assert.ok(!/<link\b(?![^>]*rel="icon"[^>]*href="data:,")[^>]*>/i.test(html), 'nenhum <link> além do ícone vazio');
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(html), 'nada de @import nem url() externo no CSS');
  for (const m of html.matchAll(/url\(\s*['"]?([^'")\s]{0,12})/g)) assert.ok(/^data:/.test(m[1]), `url() só com data: (achei ${m[1]})`);
  assert.ok(/@font-face/.test(html) && /Manrope/.test(html), 'a fonte Manrope vem embutida');
  assert.ok(!/<(img|iframe|object|embed|video|audio)\b/i.test(html), 'nenhuma mídia externa');
  const urls = (html.match(/https?:\/\/[^\s"'`)<\\]+/g) || []).filter((u) => !/^https:\/\/trello\.com\//.test(u)
    && !NAMESPACES.test(u) && !/^http:\/\/127\.0\.0\.1:4795\//.test(u));
  assert.deepStrictEqual(urls, [], `URLs inesperadas: ${urls.join(' ')}`);
  assert.ok(!/fetch\(\s*['"`]https?:/.test(js), 'fetch só para o próprio servidor');
});

suite.teste('texto da API entra como texto: sem innerHTML, eval ou handlers montados por string', () => {
  const proibidos = [/innerHTML/, /dangerouslySetInnerHTML/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/,
    /new\s+Function\s*\(/, /setAttribute\(\s*['"]on/, /createContextualFragment/, /DOMParser/, /\.srcdoc\b/];
  for (const [arq, texto] of Object.entries(fonte)) {
    for (const p of proibidos) assert.ok(!p.test(texto), `uso proibido em ui/src/${arq}: ${p}`);
  }
  // No build, o único innerHTML possível é o do dangerouslySetInnerHTML do próprio Preact, que a fonte nunca usa.
  for (const p of proibidos.slice(2)) assert.ok(!p.test(js), `uso proibido no build: ${p}`);
  // Link externo só pelas funções que conferem protocolo e host.
  assert.ok(/export function urlTrello\(u\)[\s\S]*?x\.protocol === 'https:' && x\.hostname === 'trello\.com'/.test(fonte['dados/dominio.js']), 'urlTrello confere protocolo e host');
  assert.ok(/export function linkMeet\(u\)[\s\S]*?x\.protocol === 'https:' && x\.hostname === 'meet\.google\.com'/.test(fonte['telas/ProspeccaoComum.jsx']), 'linkMeet confere protocolo e host');
  const hrefs = [...fonteToda.matchAll(/\bhref=\{([^}]+)\}/g)].map((m) => m[1].trim());
  assert.ok(hrefs.length > 0, 'há links');
  for (const h of hrefs) assert.ok(['seguro', 'link'].includes(h), `href={${h}} não passa por urlTrello/linkMeet`);
  assert.ok(/const seguro = urlTrello\(url\);/.test(fonte['componentes/dominio.jsx']), 'LinkTrello usa urlTrello');
  assert.ok(/const link = reuniao && linkMeet\(reuniao\.link\);/.test(fonte['telas/ProspeccaoLead.jsx']), 'o link da reunião passa por linkMeet');
  assert.ok(!/\bhref="(?!#)/.test(fonteToda), 'nenhum href fixo para fora');
});

suite.teste('o script embutido compila e usa só as rotas do contrato', () => {
  new vm.Script(js, { filename: 'index.html#script' });
  const api = fonte['dados/api.js'];
  for (const rota of ["api('/api/estado')", '`/api/eventos?', '`/api/evento/${encodeURIComponent(id)}`', "api('/api/recalcular', { metodo: 'POST' })",
    'api(`/api/pendencias/${encodeURIComponent(p.id)}/responder`', "api('/api/prospeccao/estado')"]) {
    assert.ok(api.includes(rota), `a página chama ${rota}`);
  }
  for (const rota of ['/api/estado', '/api/eventos?', '/api/evento/', '/api/recalcular', '/api/pendencias/', '/api/prospeccao/estado']) {
    assert.ok(js.includes(rota), `o build chama ${rota}`);
  }
  const permitidas = /^\/api\/(estado|eventos|evento\/|fluxo\/|recalcular|cerebro|pendencias\/|prospeccao\/(estado|lead\/|assumir|devolver|))$/;
  for (const m of js.matchAll(/\/api\/[a-z_/-]*/g)) assert.ok(permitidas.test(m[0]), `rota fora do contrato no build: ${m[0]}`);
  assert.ok(/'X-Painel': '1'/.test(api), 'POST leva X-Painel: 1');
  assert.ok(/export const INTERVALO_MS = 20000;/.test(api), 'atualiza a cada 20 s');
  assert.ok(/export const POR_PAGINA = 50;/.test(api), 'paginação de 50');
  assert.ok(/timeZone: TZ/.test(fonte['dados/formato.js']) && /export const TZ = 'America\/Sao_Paulo'/.test(fonte['dados/formato.js']), 'datas em America/Sao_Paulo');
  assert.ok(/<meta name="color-scheme" content="dark">/.test(html), 'tema escuro da marca');
  assert.ok(/<html lang="pt-BR">/.test(html));
});

suite.teste('mock-estado.json segue o contrato e tem o cenário pedido', () => {
  const e = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-estado.json'), 'utf8'));
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-detalhes.json'), 'utf8'));
  for (const k of ['gerado_em', 'workspace', 'saude', 'kpis', 'agentes', 'pendencias', 'trello', 'trello_rst', 'serie_trello', 'uso', 'eventos']) assert.ok(k in e, `falta ${k}`);
  for (const k of ['nivel', 'motivos', 'trello_idade_min', 'ultimo_evento_idade_min', 'uso_idade_min', 'hooks', 'wire']) assert.ok(k in e.saude, `saude.${k}`);
  assert.strictEqual(e.trello.totais.abertas, 13);
  assert.strictEqual(e.trello.projetos.reduce((n, p) => n + p.cartoes.length, 0), 13, '13 cartões no resumo');
  assert.strictEqual(e.agentes.length, 2);
  assert.strictEqual(e.pendencias.length, 6);
  assert.strictEqual(new Set(e.pendencias.map((p) => p.severidade)).size, 4, 'as 4 severidades');
  assert.ok(e.eventos.length >= 38 && e.eventos.length <= 45, `~40 eventos (${e.eventos.length})`);
  assert.strictEqual(new Set(e.eventos.map((x) => x.ts.slice(0, 10))).size, 2, '2 dias');
  assert.strictEqual(new Set(e.eventos.map((x) => x.fluxo_id)).size, 2, '2 fluxos');
  assert.strictEqual(e.kpis.uso.janela_5h_pct, 37);
  assert.strictEqual(e.kpis.uso.semanal_pct, 22);
  for (const ev of e.eventos) assert.ok(d.eventos.some((x) => x.id === ev.id), `detalhe de ${ev.id}`);
  for (let i = 1; i < e.eventos.length; i++) assert.ok(Date.parse(e.eventos[i - 1].ts) >= Date.parse(e.eventos[i].ts), 'mais recente primeiro');
});

let porta = null;
let pid = null;
let raiz = null;

suite.teste('servidor real numa raiz falsa (mock + dados hostis) entrega o que a página lê', async () => {
  raiz = path.join(TMP, `index-${process.pid}`);
  const montar = spawnSync(process.execPath, [path.join(__dirname, 'montar-raiz-mock.js'), path.join(raiz, 'm'), '--hostil'], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(montar.status, 0, montar.stderr);
  fs.mkdirSync(path.join(raiz, 'maestri'), { recursive: true });
  fs.mkdirSync(path.join(raiz, 'claude'), { recursive: true });
  const estadoMock = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-estado.json'), 'utf8'));
  const p = await portaLivre();
  const env = Object.assign({}, process.env, {
    MAESTRO_DIR: path.join(raiz, 'm'), MAESTRI_DATA_DIR: path.join(raiz, 'maestri'), CLAUDE_CONFIG_DIR: path.join(raiz, 'claude'),
    PAINEL_AGORA: estadoMock.gerado_em, MAESTRO_AGORA: '', PAINEL_COLETOR: '0', PAINEL_PORTA: '', PAINEL_INDEX: '', PAINEL_TRELLO_JANELA: '0-24',
  });
  const filho = spawn(process.execPath, [SERVIDOR, '--porta', String(p)], { env, windowsHide: true });
  let saida = '';
  filho.stdout.on('data', (c) => { saida += c; });
  const m = await esperarAte(() => /Painel no ar em http:\/\/127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(saida), 15000);
  porta = Number(m[1]);
  pid = Number(m[2]);

  const idx = await pedir(porta, '/');
  assert.strictEqual(idx.status, 200);
  assert.strictEqual(idx.texto, html, 'serve este index.html');
  assert.ok(/default-src 'none'/.test(idx.headers['content-security-policy'] || ''), 'CSP');
  assert.strictEqual(idx.headers['cache-control'], 'no-store');

  const est = (await pedir(porta, '/api/estado')).json;
  assert.ok(est && est.kpis && est.kpis.pendencias.total === 5, 'pendências abertas (4 do mock + 1 hostil)');
  assert.strictEqual(est.pendencias[0].severidade, 'critica', 'abertas primeiro, por severidade');
  assert.ok(est.pendencias.some((x) => x.id === 'P-0099'), 'a pendência hostil está na lista');
  for (const a of est.agentes) {
    for (const k of ['slug', 'nome', 'cor', 'responsabilidade', 'status', 'modelo', 'nivel', 'skills', 'conectado_a', 'eventos_hoje', 'fluxos_abertos', 'ultimo_bruto', 'uso']) assert.ok(k in a, `agente.${k}`);
    assert.ok(a.ultimo_evento && a.ultimo_evento.id, 'ultimo_evento.id para abrir o modal');
  }
  assert.ok(est.trello && Array.isArray(est.trello.projetos) && est.trello_rst && est.serie_trello.length === 9);
  const ev0 = est.eventos[0];
  for (const k of ['id', 'ts', 'agente', 'projeto', 'trello', 'resumo', 'direcao', 'resultado', 'tipo', 'fluxo_id', 'precisa_dono']) assert.ok(k in ev0, `evento.${k}`);

  // filtros que a página monta
  const q = (s) => pedir(porta, `/api/eventos?${s}`).then((r) => r.json);
  const tudo = await q('pagina=1&por_pagina=50');
  assert.strictEqual(tudo.por_pagina, 50);
  assert.ok(tudo.eventos.every((e) => !e.teste), 'testes ocultos por padrão');
  const comTestes = await q('incluir_testes=1&por_pagina=50');
  assert.ok(comTestes.total > tudo.total, 'o filtro "Mostrar testes" traz os de teste');
  const fl = await q('fluxo=F-20261008-0001&por_pagina=50');
  assert.ok(fl.total > 0 && fl.eventos.every((e) => e.fluxo_id === 'F-20261008-0001'), 'filtro por fluxo (clique no modal)');
  const dono = await q('so_dono=1');
  assert.ok(dono.eventos.every((e) => e.precisa_dono || ['falhou', 'bloqueado', 'aguardando-dono'].includes(e.resultado)));
  const busca = await q('q=LEITURA%20quadro&agente=coordenador-trello');
  assert.ok(busca.total > 0 && busca.eventos.every((e) => e.agente === 'coordenador-trello'));
  const dia = await q('desde=2026-10-09&ate=2026-10-09');
  assert.ok(dia.eventos.every((e) => e.ts.startsWith('2026-10-09')));

  // modal
  const det = (await pedir(porta, `/api/evento/${encodeURIComponent('EV-20261009-102400-beef')}`)).json;
  assert.ok(det.evento && det.evento.resumo.includes('<script>'), 'o texto hostil chega cru; a página o mostra como texto');
  assert.ok(Array.isArray(det.sequencia) && det.sequencia.some((s) => s.id === det.evento.id), 'sequência com o atual');
  assert.ok(Array.isArray(det.comandos_brutos) && det.comandos_brutos.length > 0, 'comandos brutos correlacionados');
  assert.ok(det.pedido_inicial && det.pedido_inicial.texto, 'pedido inicial');
  assert.ok('anterior_id' in det && 'proximo_id' in det);
  const nao = await pedir(porta, '/api/evento/EV-nao-existe');
  assert.strictEqual(nao.status, 404);
  assert.ok(nao.json && nao.json.erro);

  // botões do cabeçalho
  const semCab = await pedir(porta, '/api/recalcular', { metodo: 'POST' });
  assert.strictEqual(semCab.status, 403);
  const rec = await pedir(porta, '/api/recalcular', { metodo: 'POST', cabecalhos: { 'X-Painel': '1' } });
  assert.strictEqual(rec.status, 200);
  assert.ok(rec.json && rec.json.gerado_em && rec.json.kpis);
  const cer = await pedir(porta, '/api/cerebro', { metodo: 'POST', cabecalhos: { 'X-Painel': '1' } });
  assert.strictEqual(cer.status, 501);
});

(async () => {
  try {
    await suite.rodar();
  } finally {
    derrubar(pid);
    if (raiz && !process.env.MANTER_TMP) apagar(raiz);
  }
})();
