#!/usr/bin/env node
'use strict';
// serper · buscas no Serper (Google Maps "places" e Google "search") para o Captador.
// Contrato: conhecimento/prospeccao/contrato.md §5. Chave em .segredos/serper.key (nunca impressa nem gravada).
// Cache de 30 dias em estado/prospeccao/serper-cache/<sha1>.json; cada chamada vira uma linha em
// estado/prospeccao/serper-chamadas.jsonl {quando, endpoint, q, cache, status} (sem a chave).
// Variáveis só para teste: PROSPECCAO_SERPER_URL (troca a base), PROSPECCAO_SERPER_TIMEOUT_MS.
// Códigos de saída: 0 ok · 1 sem chave, erro do Serper ou de rede · 2 uso errado.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('../lib_maestro');

const CMD = `node ${lib.barras(path.join(__dirname, 'serper.js'))}`;
const BASE_PADRAO = 'https://google.serper.dev';
const ENDPOINTS = ['places', 'search'];
const TIMEOUT_PADRAO_MS = 20000;
const MSG_SEM_CHAVE = 'Falta a chave do Serper: crie .segredos/serper.key na raiz do _maestro (MAESTRO_DIR)';

const AJUDA = `serper · buscas do Captador no Serper (Google Maps e Google), com cache de 30 dias e registro de uso

Forma canônica:
  ${CMD} <subcomando> [opções]

SUBCOMANDOS
  places --q "padaria Cidade A" [--num N] [--sem-cache] [--json]
      Busca no Google Maps: nome, endereço, telefone, site, nota, avaliações, categoria, lat/lng.
  search --q "\\"Padaria Exemplo\\" Cidade A instagram" [--num N] [--sem-cache] [--json]
      Busca no Google: resultados orgânicos (título, link, trecho). O trecho costuma trazer os seguidores.
  uso [--dia AAAA-MM-DD] [--json]
      Chamadas do dia (padrão: hoje): total, pagas (fora do cache), do cache, com erro, por endpoint.

  --json        saída em JSON: {endpoint, q, cache, quando, resposta}
  --sem-cache   ignora o cache e consulta o Serper (a resposta nova substitui a do cache)

A chave fica em .segredos/serper.key e nunca é impressa nem registrada.

CÓDIGOS DE SAÍDA
  0 ok · 1 sem chave, erro do Serper ou de rede · 2 uso errado
`;

// ---------------------------------------------------------------------------------- caminhos

function caminhosSerper() {
  const estado = path.join(lib.caminhos().estado, 'prospeccao');
  return {
    estado,
    cache: path.join(estado, 'serper-cache'),
    chamadas: path.join(estado, 'serper-chamadas.jsonl'),
    chave: path.join(lib.dirMaestro(), '.segredos', 'serper.key'),
  };
}

/** Dias de validade do cache (config/captacao.json, padrão 30). */
function diasDeCache() {
  try {
    const c = lib.lerJson(path.join(__dirname, 'config', 'captacao.json'), {});
    if (Number(c.cache_dias) > 0) return Number(c.cache_dias);
  } catch { /* usa o padrão */ }
  return 30;
}

/** Lê a chave; sem chave, erro code 'ESEMCHAVE' (sai com 1). Nunca devolve a chave em mensagem. */
function lerChave() {
  let chave = '';
  try { chave = lib.decodificarTexto(fs.readFileSync(caminhosSerper().chave)).trim(); } catch { /* sem arquivo */ }
  if (!chave) {
    const e = new Error(MSG_SEM_CHAVE);
    e.code = 'ESEMCHAVE';
    throw e;
  }
  return chave;
}

// ---------------------------------------------------------------------------------- cache e log

/** Parâmetros que vão no corpo do POST (a ordem fixa garante o mesmo sha1). */
function corpoDaBusca(q, { num } = {}) {
  const corpo = { q: String(q), gl: 'br', hl: 'pt-br' };
  if (num !== undefined && num !== null) corpo.num = Number(num);
  return corpo;
}

function chaveDeCache(endpoint, corpo) {
  return crypto.createHash('sha1').update(JSON.stringify({ endpoint, ...corpo })).digest('hex');
}

function arquivoDeCache(endpoint, corpo) {
  return path.join(caminhosSerper().cache, `${chaveDeCache(endpoint, corpo)}.json`);
}

/** Entrada de cache válida (mais nova que cache_dias) ou null. */
function lerCache(endpoint, corpo) {
  let c;
  try { c = lib.lerJson(arquivoDeCache(endpoint, corpo), null); } catch { return null; }
  if (!c || !c.resposta) return null;
  const quando = lib.lerData(c.quando);
  if (!quando) return null;
  const idadeMs = lib.agora().getTime() - quando.getTime();
  if (idadeMs < 0 || idadeMs > diasDeCache() * 86400e3) return null;
  return c;
}

function gravarCache(endpoint, corpo, resposta, quando) {
  lib.gravarJsonAtomico(arquivoDeCache(endpoint, corpo), { quando, endpoint, q: corpo.q, num: corpo.num, resposta }, { sincronizar: false });
}

function registrarChamada(endpoint, q, cache, status) {
  lib.anexarJsonl(caminhosSerper().chamadas, { quando: lib.isoSP(), endpoint, q: String(q), cache, status });
}

// ---------------------------------------------------------------------------------- HTTP

/** POST JSON com timeout; resolve {status, corpo} (texto). Nunca põe a chave em mensagem de erro. */
function postar(url, chave, corpo, timeoutMs) {
  const u = new URL(url);
  const modulo = u.protocol === 'http:' ? require('http') : require('https');
  const dados = Buffer.from(JSON.stringify(corpo), 'utf8');
  return new Promise((resolve, reject) => {
    const req = modulo.request(u, {
      method: 'POST',
      headers: { 'X-API-KEY': chave, 'Content-Type': 'application/json', 'Content-Length': dados.length },
    }, (res) => {
      const partes = [];
      res.on('data', (p) => partes.push(p));
      res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf8') }));
      res.on('error', (e) => reject(e));
    });
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`o Serper não respondeu em ${Math.round(timeoutMs / 1000)} s`);
      e.code = 'ETIMEOUT';
      req.destroy(e);
    });
    req.on('error', (e) => reject(e));
    req.end(dados);
  });
}

/**
 * Consulta um endpoint ("places" ou "search"), usando o cache quando houver.
 * opcoes: num, semCache. Devolve {endpoint, q, cache, quando, resposta}.
 * Erros: ESEMCHAVE (sem chave), ESERPER (status HTTP de erro ou resposta inválida), ETIMEOUT, erros de rede.
 */
async function consultar(endpoint, q, { num, semCache = false } = {}) {
  if (!ENDPOINTS.includes(endpoint)) throw lib.erroArgs(`endpoint desconhecido: ${endpoint} (use: ${ENDPOINTS.join(', ')})`);
  if (typeof q !== 'string' || !q.trim()) throw lib.erroArgs('falta a busca: --q "..."');
  if (num !== undefined && num !== null && !(Number.isInteger(Number(num)) && Number(num) > 0 && Number(num) <= 100)) {
    throw lib.erroArgs(`--num "${num}" inválido (use um inteiro de 1 a 100)`);
  }
  const corpo = corpoDaBusca(q.trim(), { num });
  if (!semCache) {
    const c = lerCache(endpoint, corpo);
    if (c) {
      registrarChamada(endpoint, corpo.q, true, 200);
      return { endpoint, q: corpo.q, cache: true, quando: c.quando, resposta: c.resposta };
    }
  }
  const chave = lerChave();
  const base = (process.env.PROSPECCAO_SERPER_URL || BASE_PADRAO).replace(/\/+$/, '');
  const timeoutMs = Number(process.env.PROSPECCAO_SERPER_TIMEOUT_MS) > 0 ? Number(process.env.PROSPECCAO_SERPER_TIMEOUT_MS) : TIMEOUT_PADRAO_MS;
  let r;
  try {
    r = await postar(`${base}/${endpoint}`, chave, corpo, timeoutMs);
  } catch (e) {
    registrarChamada(endpoint, corpo.q, false, e.code === 'ETIMEOUT' ? 'timeout' : 'erro-rede');
    const erro = new Error(e.code === 'ETIMEOUT' ? e.message : `falha de rede ao chamar o Serper (${e.code || e.message})`);
    erro.code = e.code === 'ETIMEOUT' ? 'ETIMEOUT' : 'EREDE';
    throw erro;
  }
  registrarChamada(endpoint, corpo.q, false, r.status);
  if (r.status < 200 || r.status >= 300) {
    const e = new Error(`o Serper respondeu ${r.status}: ${lib.resumir(r.corpo.replace(/\s+/g, ' '), 200)}`);
    e.code = 'ESERPER';
    e.status = r.status;
    throw e;
  }
  let resposta;
  try { resposta = JSON.parse(r.corpo); } catch {
    const e = new Error('o Serper devolveu uma resposta que não é JSON');
    e.code = 'ESERPER';
    throw e;
  }
  const quando = lib.isoSP();
  gravarCache(endpoint, corpo, resposta, quando);
  return { endpoint, q: corpo.q, cache: false, quando, resposta };
}

/** Busca no Google Maps; devolve a resposta do Serper (com "places"). */
async function places(q, opcoes) { return (await consultar('places', q, opcoes)).resposta; }

/** Busca no Google; devolve a resposta do Serper (com "organic"). */
async function search(q, opcoes) { return (await consultar('search', q, opcoes)).resposta; }

/** Uso de um dia (AAAA-MM-DD, padrão hoje em São Paulo): {dia, total, pagas, cache, erros, por_endpoint}. */
function uso(dia) {
  const d = dia || lib.carimbosSP().aaaammdd;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw lib.erroArgs(`--dia "${d}" inválido (use AAAA-MM-DD)`);
  const r = { dia: d, total: 0, pagas: 0, cache: 0, erros: 0, por_endpoint: {} };
  for (const c of lib.lerJsonl(caminhosSerper().chamadas)) {
    if (typeof c.quando !== 'string' || !c.quando.startsWith(d)) continue;
    r.total++;
    const e = r.por_endpoint[c.endpoint] || (r.por_endpoint[c.endpoint] = { total: 0, pagas: 0, cache: 0 });
    e.total++;
    if (c.cache) { r.cache++; e.cache++; } else if (c.status >= 200 && c.status < 300) { r.pagas++; e.pagas++; } // gastou crédito
    else r.erros++;
  }
  return r;
}

// ---------------------------------------------------------------------------------- saída em texto

function textoPlaces(r) {
  const lista = Array.isArray(r.resposta.places) ? r.resposta.places : [];
  const linhas = [`${lista.length} lugar(es) para "${r.q}"${r.cache ? ' (cache)' : ''}`];
  lista.forEach((p, i) => {
    const partes = [p.title, p.address, p.phoneNumber, p.website,
      p.rating !== undefined ? `nota ${p.rating} (${p.ratingCount || 0} avaliações)` : null, p.category,
      p.latitude !== undefined ? `${p.latitude},${p.longitude}` : null].filter((x) => x !== undefined && x !== null && x !== '');
    linhas.push(`${i + 1}. ${partes.join(' · ')}`);
  });
  return linhas.join('\n');
}

function textoSearch(r) {
  const lista = Array.isArray(r.resposta.organic) ? r.resposta.organic : [];
  const linhas = [`${lista.length} resultado(s) para "${r.q}"${r.cache ? ' (cache)' : ''}`];
  lista.forEach((o, i) => {
    linhas.push(`${i + 1}. ${o.title || ''} · ${o.link || ''}`);
    if (o.snippet) linhas.push(`   ${String(o.snippet).replace(/\s+/g, ' ')}`);
  });
  return linhas.join('\n');
}

// ---------------------------------------------------------------------------------- principal

async function cmdBusca(endpoint, argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['q', 'num'], bool: ['json', 'sem-cache'] });
  const r = await consultar(endpoint, op.q, { num: op.num, semCache: !!op['sem-cache'] });
  if (op.json) lib.escrever(JSON.stringify(r, null, 2));
  else lib.escrever(endpoint === 'places' ? textoPlaces(r) : textoSearch(r));
}

function cmdUso(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['dia'], bool: ['json'] });
  const r = uso(op.dia);
  if (op.json) { lib.escrever(JSON.stringify(r, null, 2)); return; }
  const pe = Object.entries(r.por_endpoint).map(([k, v]) => `${k} ${v.pagas} pagas/${v.cache} cache`).join(', ');
  lib.escrever(`${r.dia}: ${r.total} chamadas, ${r.pagas} pagas, ${r.cache} do cache, ${r.erros} com erro${pe ? ` (${pe})` : ''}`);
}

async function principal() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.some((a) => a === '--help' || a === '-h') || ['ajuda', 'help'].includes(argv[0])) {
    lib.escrever(AJUDA);
    if (!argv.length) process.exitCode = 2;
    return;
  }
  const [sub, ...resto] = argv;
  if (sub === 'places' || sub === 'search') return cmdBusca(sub, resto);
  if (sub === 'uso') return cmdUso(resto);
  throw lib.erroArgs(`subcomando desconhecido: ${sub} (use: places, search, uso; veja --help)`);
}

if (require.main === module) {
  principal().catch((e) => {
    process.stderr.write(e.code === 'ESEMCHAVE' ? `${e.message}\n` : `erro: ${lib.mensagemDeErro(e)}\n`);
    process.exitCode = lib.codigoDeSaida(e) === 2 ? 2 : 1;
  });
}

module.exports = { places, search, uso, consultar, caminhosSerper, chaveDeCache, corpoDaBusca, MSG_SEM_CHAVE, ENDPOINTS };
