#!/usr/bin/env node
'use strict';
// servidor.js · painel local do workspace multiagente (Maestri + Claude Code)
//
// Servidor HTTP só com a biblioteca padrão do Node, preso a 127.0.0.1. Serve o index.html e uma
// API JSON que agrega os arquivos de _maestro/ a cada requisição (registro, logs, estado). Nada
// de IA nem de tokens: só leitura de arquivos. Roda o coletor de uso (bin/coletar_uso.js) ao
// subir e a cada 5 min, no próprio processo e sem bloquear as requisições.
//
// Subir:  node painel/servidor.js [--porta 4777]
// Parar:  Ctrl+C no terminal "Servidor do Painel", ou taskkill /PID <pid de estado/painel.pid> /F
//
// Rotas: GET /, GET /api/estado, GET /api/eventos, GET /api/evento/<id>, GET /api/fluxo/<id>,
//        POST /api/recalcular, POST /api/cerebro (Fase B: 501). Prospecção (api-prospeccao.js):
//        GET /prospeccao (302 para /#prospeccao: a Prospecção é uma tela do app desde 09/10/2026),
//        GET /prospeccao/antiga (a página antiga, mantida por compatibilidade), GET /api/prospeccao/estado, GET /api/prospeccao/lead/<id>,
//        POST /api/prospeccao/assumir e /api/prospeccao/devolver {lead_id}. Pendências (api-pendencias.js):
//        POST /api/pendencias/<P-NNNN>/responder {opcao, texto} (grava e avisa o Cérebro). Detalhes no README.md.
// Segurança: escuta só em 127.0.0.1; Host precisa ser 127.0.0.1:<porta> ou localhost:<porta>
//   (senão 403); POST só com o cabeçalho X-Painel: 1 (senão 403); nenhum cabeçalho CORS; só
//   "/", "/prospeccao", "/prospeccao/antiga" e "/api/*" existem (o resto é 404); JSON sempre com Cache-Control: no-store.
//
// Variáveis: PAINEL_PORTA (padrão 4777; --porta tem prioridade), MAESTRO_DIR (padrão: a pasta
//   acima de painel/, a raiz do _maestro), MAESTRI_DATA_DIR e CLAUDE_CONFIG_DIR (repassadas ao coletor),
//   PAINEL_TRELLO_INTERVALO_MIN (60) e PAINEL_TRELLO_JANELA (padrão "0-24", a idade real, como
//   pede o contrato; "8-22" é opcional: só conta o horário das leituras), PAINEL_COLETOR=0 (não
//   roda o coletor sozinho) e, só para testes, PAINEL_INDEX (outro index.html), PAINEL_PROSPECCAO
//   (outro prospeccao.html) e PAINEL_AGORA (relógio fixo; MAESTRO_AGORA também vale).
//   Aviso ao Cérebro (resposta de pendência): PAINEL_AVISAR_CEREBRO=0 desliga e =1 liga; sem ela, liga só
//   dentro de um terminal do Maestri (MAESTRI_TERMINAL_ID) e com relógio de verdade. PAINEL_MAESTRI_CLI
//   troca o executável (testes; padrão MAESTRI_CLI ou "maestri").

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

const coletor = require(path.join(__dirname, '..', 'bin', 'coletar_uso.js'));
const prospeccao = require(path.join(__dirname, 'api-prospeccao.js'));
const pendenciasApi = require(path.join(__dirname, 'api-pendencias.js'));
const { comoData, isoSP, diaSP, instanteSP, horaCurta, lerJson, lerTexto, comNovasTentativas, gravarAtomico } = coletor.util;

const MIN_MS = 60 * 1000;
const HORA_MS = 60 * MIN_MS;
const DIA_MS = 24 * HORA_MS;
const PORTA_PADRAO = 4777;
const COLETOR_INTERVALO_MS = 5 * MIN_MS;
const LIMITE_EVENTOS_ESTADO = 200;
const LIMITE_SERIE = 200;
const LIMITE_FECHADAS = 20;
const LIMITE_COMANDOS = 1500;
const LIMITE_DIAS_FLUXO = 62;                // o 1º dia (e a véspera) sempre entram; o resto são os mais recentes
const BRUTO_BYTES_POR_PEDIDO = 160 * 1024 * 1024; // teto de bytes NOVOS do log bruto lidos numa requisição
const BRUTO_MAX_LINHAS_INDICE = 4e6;         // linhas indexadas guardadas (≈ 30 bytes cada)
const JANELA_MAX_MS = 6 * HORA_MS;           // §10.4 sem fluxo_id: no máximo 6 h antes do evento
const JANELA_SEM_ANTERIOR_MS = 15 * MIN_MS;  // sem evento anterior nem início do fluxo antes: 15 min (como o registrar)
const BRUTO_ATRASADO_MS = 24 * HORA_MS;
const RESULTADOS_DONO = new Set(['falhou', 'bloqueado', 'aguardando-dono']);
const RESULTADOS_ABERTOS = new Set(['em-andamento', 'aguardando-dono', 'bloqueado', 'parcial']);
const ORDEM_SEVERIDADE = new Map([['critica', 0], ['alta', 1], ['normal', 2], ['baixa', 3]]);
const CAMPOS_TABELA = ['id', 'ts', 'agente', 'projeto', 'trello', 'resumo', 'direcao', 'resultado', 'tipo', 'fluxo_id', 'precisa_dono'];
const RE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
// O index.html é um arquivo único (CSS e JS embutidos); nada externo é carregado.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// A /prospeccao/antiga (página antiga, fora do app) é a única com algo externo: a fonte Manrope do Google Fonts (02 §A7).
const CSP_PROSPECCAO = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LIMITE_CORPO = 16 * 1024; // corpo aceito nos POST que leem JSON (assumir/devolver)
const JSON_TIPO = 'application/json; charset=utf-8';
const HTML_TIPO = 'text/html; charset=utf-8';

class ErroUso extends Error {}
class ErroPedido extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// ---------- configuração ----------

/** Janela diária das leituras do Trello ("8-22") em minutos; null = o dia inteiro. */
function lerJanela(texto) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(texto));
  if (!m) throw new ErroUso(`PAINEL_TRELLO_JANELA inválida: "${texto}" (use, por exemplo, 8-22).`);
  const ini = Number(m[1]) * 60 + Number(m[2] || 0);
  const fim = Number(m[3]) * 60 + Number(m[4] || 0);
  if (ini >= fim || fim > 24 * 60) throw new ErroUso(`PAINEL_TRELLO_JANELA inválida: "${texto}" (início antes do fim, até 24).`);
  return ini === 0 && fim === 24 * 60 ? null : { ini, fim };
}

function lerConfig(argv = [], env = process.env) {
  let porta = env.PAINEL_PORTA;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--porta') porta = argv[++i];
    else if (a.startsWith('--porta=')) porta = a.slice('--porta='.length);
    else if (a === '--ajuda' || a === '--help' || a === '-h') return { ajuda: true };
    else throw new ErroUso(`Opção desconhecida: ${a} (use --ajuda).`);
  }
  const p = porta === undefined || porta === '' ? PORTA_PADRAO : Number(porta);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ErroUso(`Porta inválida: "${porta}" (use um número de 1 a 65535).`);
  const textoAgora = env.PAINEL_AGORA || env.MAESTRO_AGORA || '';
  const agoraFixa = textoAgora ? comoData(textoAgora) : null;
  if (textoAgora && !agoraFixa) throw new ErroUso(`Relógio fixo inválido: "${textoAgora}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).`);
  const intervalo = env.PAINEL_TRELLO_INTERVALO_MIN ? Number(env.PAINEL_TRELLO_INTERVALO_MIN) : 60;
  if (!(intervalo > 0)) throw new ErroUso(`PAINEL_TRELLO_INTERVALO_MIN inválido: "${env.PAINEL_TRELLO_INTERVALO_MIN}".`);
  return {
    porta: p,
    maestroDir: path.resolve(env.MAESTRO_DIR || path.join(__dirname, '..')),
    indexPath: path.resolve(env.PAINEL_INDEX || path.join(__dirname, 'index.html')),
    prospeccaoPath: path.resolve(env.PAINEL_PROSPECCAO || path.join(__dirname, 'prospeccao.html')),
    agoraFixa,
    trello: { intervaloMin: intervalo, janela: lerJanela(env.PAINEL_TRELLO_JANELA || '0-24') },
    coletorAtivo: env.PAINEL_COLETOR !== '0',
    avisoCerebro: lerAvisoCerebro(env, agoraFixa),
    env,
  };
}

// Aviso ao Cérebro quando o dono responde uma pendência pelo painel (maestri ask no terminal dele).
function lerAvisoCerebro(env, agoraFixa) {
  const cli = env.PAINEL_MAESTRI_CLI || env.MAESTRI_CLI || 'maestri';
  if (env.PAINEL_AVISAR_CEREBRO === '0') return { ativo: false, cli, motivo: 'aviso desligado (PAINEL_AVISAR_CEREBRO=0)' };
  if (env.PAINEL_AVISAR_CEREBRO === '1') return { ativo: true, cli };
  if (!env.MAESTRI_TERMINAL_ID) return { ativo: false, cli, motivo: 'o servidor não está rodando num terminal do Maestri' };
  if (agoraFixa) return { ativo: false, cli, motivo: 'relógio fixo (teste)' };
  return { ativo: true, cli };
}

// ---------- utilitários ----------

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function idadeMin(valor, t) {
  const d = comoData(valor);
  return d ? Math.max(0, Math.round((t - d.getTime()) / MIN_MS)) : null;
}

/** "agora há pouco", "45 min", "2 h 10 min", "3 dias". */
function duracaoTexto(min) {
  const m = Math.round(min);
  if (m < 1) return 'menos de 1 min';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  return `${Math.floor(m / (24 * 60))} dias`;
}

function somarDias(dia, n) {
  const [a, m, d] = dia.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

function diaValido(dia) {
  if (!RE_DIA.test(dia)) return false;
  return somarDias(dia, 0) === dia; // recusa 2026-02-31
}

function enumerarDias(inicio, fim, limite) {
  const dias = [];
  for (let d = inicio; d <= fim && dias.length < limite; d = somarDias(d, 1)) dias.push(d);
  return dias;
}

/** Nome da pasta do log bruto de um agente (mesma regra do lib_maestro: "desconhecido:x" → "desconhecido-x"). */
function pastaDoAgente(slug) {
  if (typeof slug !== 'string' || !slug) return null;
  const s = slug.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  return s || null;
}

function agenteDaPasta(pasta) {
  return /^desconhecido-/.test(pasta) ? `desconhecido:${pasta.slice('desconhecido-'.length)}` : pasta;
}

function normalizarBusca(s) {
  return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function truncar(texto, max) {
  const s = String(texto);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function relativo(dir, caminho) {
  return path.relative(dir, caminho).replace(/\\/g, '/');
}

/** Minutos de [desde, ate] dentro da janela diária (horário de São Paulo); sem janela, todos. */
function minutosUteis(desde, ate, janela) {
  if (!(ate > desde)) return 0;
  if (!janela || ate - desde > 60 * DIA_MS) return (ate - desde) / MIN_MS;
  let total = 0;
  const ultimo = diaSP(ate);
  for (let dia = diaSP(desde), i = 0; i < 70; dia = somarDias(dia, 1), i++) {
    const [a, m, d] = dia.split('-').map(Number);
    const ini = instanteSP(a, m, d, Math.floor(janela.ini / 60), janela.ini % 60);
    const fim = janela.fim >= 24 * 60
      ? instanteSP(...somarDias(dia, 1).split('-').map(Number), 0, 0)
      : instanteSP(a, m, d, Math.floor(janela.fim / 60), janela.fim % 60);
    const s = Math.max(ini, desde);
    const e = Math.min(fim, ate);
    if (e > s) total += e - s;
    if (dia === ultimo) break;
  }
  return total / MIN_MS;
}

// ---------- leitura incremental de JSONL (tolerante: linha quebrada, final incompleto, EPERM) ----------

let sequencia = 0;

class LeitorJsonl {
  // max: arquivos guardados; maxBytes: soma dos bytes lidos (o mais antigo sai primeiro, o último fica).
  constructor({ max = Infinity, maxBytes = Infinity, aoLer = null } = {}) {
    this.max = max;
    this.maxBytes = maxBytes;
    this.aoLer = aoLer;
    this.mapa = new Map();
  }

  bytesGuardados() {
    let total = 0;
    for (const e of this.mapa.values()) total += e.bytes || 0;
    return total;
  }

  /** Devolve {caminho, existe, linhas, invalidas, geracao}; lê só os bytes novos desde a última vez. */
  async ler(caminho) {
    const chave = process.platform === 'win32' ? path.resolve(caminho).toLowerCase() : path.resolve(caminho);
    let ent = this.mapa.get(chave);
    if (ent) this.mapa.delete(chave);
    else ent = { caminho, existe: false, linhas: [], invalidas: 0, geracao: 0, offset: 0, bytes: 0, ino: null, nasc: null, tam: -1, mtime: -1, gz: /\.gz$/i.test(caminho), fila: Promise.resolve() };
    this.mapa.set(chave, ent); // fim do Map = usado mais recentemente
    const tarefa = ent.fila.then(() => this.atualizar(ent));
    ent.fila = tarefa.catch(() => {});
    try {
      await tarefa;
      ent.erro = null;
    } catch (e) {
      // Falha momentânea (arquivo preso por outro processo): devolve o que já foi lido.
      ent.erro = e && e.code ? e.code : String(e && e.message ? e.message : e);
    }
    if (!ent.existe) this.mapa.delete(chave);
    while (this.mapa.size > 1 && (this.mapa.size > this.max || (this.maxBytes !== Infinity && this.bytesGuardados() > this.maxBytes))) {
      this.mapa.delete(this.mapa.keys().next().value);
    }
    return ent;
  }

  zerar(ent) {
    ent.linhas = [];
    ent.invalidas = 0;
    ent.offset = 0;
    ent.bytes = 0;
    ent.geracao++;
  }

  analisar(texto, ent) {
    for (let linha of texto.split('\n')) {
      if (linha.charCodeAt(0) === 0xfeff) linha = linha.slice(1);
      linha = linha.trim();
      if (!linha) continue;
      let o;
      try {
        o = JSON.parse(linha);
      } catch (_) {
        ent.invalidas++;
        continue;
      }
      this.aceitar(o, ent);
    }
  }

  aceitar(o, ent) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      ent.invalidas++;
      return;
    }
    sequencia++;
    if (this.aoLer) this.aoLer(o, sequencia);
    ent.linhas.push(o);
  }

  async atualizar(ent) {
    let st;
    try {
      st = await comNovasTentativas(() => fsp.stat(ent.caminho));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        if (ent.existe) this.zerar(ent);
        ent.existe = false;
        return;
      }
      throw e;
    }
    ent.existe = true;
    if (ent.gz) {
      if (st.size === ent.tam && st.mtimeMs === ent.mtime) return;
      this.zerar(ent);
      const buf = await comNovasTentativas(() => fsp.readFile(ent.caminho));
      try {
        const texto = zlib.gunzipSync(buf);
        ent.bytes = texto.length;
        this.analisar(texto.toString('utf8'), ent);
      } catch (_) {
        ent.invalidas++;
      }
      ent.tam = st.size;
      ent.mtime = st.mtimeMs;
      return;
    }
    if (ent.ino !== null && (st.ino !== ent.ino || st.birthtimeMs !== ent.nasc || st.size < ent.offset)) this.zerar(ent);
    ent.ino = st.ino;
    ent.nasc = st.birthtimeMs;
    if (st.size === ent.offset) return;
    const fh = await comNovasTentativas(() => fsp.open(ent.caminho, 'r'));
    try {
      const quer = st.size - ent.offset;
      const buf = Buffer.allocUnsafe(quer);
      let lidos = 0;
      while (lidos < quer) {
        const { bytesRead } = await fh.read(buf, lidos, quer - lidos, ent.offset + lidos);
        if (!bytesRead) break;
        lidos += bytesRead;
      }
      const dados = buf.subarray(0, lidos);
      const nl = dados.lastIndexOf(0x0a);
      let consumido = 0;
      if (nl >= 0) {
        this.analisar(dados.subarray(0, nl).toString('utf8'), ent);
        consumido = nl + 1;
      }
      if (consumido < dados.length) {
        // Final sem \n: só entra se já for um JSON completo; senão ainda está sendo escrito.
        const resto = dados.subarray(consumido).toString('utf8').replace(/^\uFEFF/, '').trim();
        let o = null;
        if (resto) {
          try { o = JSON.parse(resto); } catch (_) { o = null; }
        }
        if (!resto || o !== null) {
          if (o !== null) this.aceitar(o, ent);
          consumido = dados.length;
        }
      }
      ent.offset += consumido;
      ent.bytes = ent.offset;
    } finally {
      await fh.close();
    }
  }
}

// ---------- índice incremental do log bruto ----------
//
// O log bruto pode ter muitos MB por dia e por agente. Em vez de guardar as linhas, cada arquivo
// vira um índice compacto (colunas em typed arrays): ts, posição e tamanho da linha no arquivo,
// sessão e marcas (tem fluxo_id; é um prompt), mais o mapa fluxo_id → linhas e o mapa dos ids de
// fluxo citados nos prompts. A leitura é incremental (só os bytes novos) e as linhas escolhidas são
// relidas do disco pela posição na hora de responder. Cache LRU por número de linhas indexadas.

const MARCA_FLUXO = 1;   // a linha tem fluxo_id
const MARCA_PROMPT = 2;  // UserPromptSubmit com prompt em texto
const RE_FLUXO_CITADO = /F-\d{8}-\d+/g;

class Colunas {
  constructor() {
    this.n = 0;
    this.cap = 0;
    this.t = new Float64Array(0);
    this.off = new Float64Array(0);
    this.len = new Uint32Array(0);
    this.seq = new Uint32Array(0);
    this.ses = new Uint32Array(0);
    this.marca = new Uint8Array(0);
  }

  crescer() {
    const cap = Math.max(256, this.cap * 2);
    for (const [k, Tipo] of [['t', Float64Array], ['off', Float64Array], ['len', Uint32Array], ['seq', Uint32Array], ['ses', Uint32Array], ['marca', Uint8Array]]) {
      const novo = new Tipo(cap);
      novo.set(this[k].subarray(0, this.n));
      this[k] = novo;
    }
    this.cap = cap;
  }

  push(t, off, len, seq, ses, marca) {
    if (this.n === this.cap) this.crescer();
    const i = this.n++;
    this.t[i] = t;
    this.off[i] = off;
    this.len[i] = len;
    this.seq[i] = seq;
    this.ses[i] = ses;
    this.marca[i] = marca;
    return i;
  }
}

class IndiceBruto {
  constructor({ maxLinhas = 3e6, maxArquivos = 2000 } = {}) {
    this.maxLinhas = maxLinhas;
    this.maxArquivos = maxArquivos;
    this.mapa = new Map();
  }

  linhasGuardadas() {
    let n = 0;
    for (const e of this.mapa.values()) n += e.col.n;
    return n;
  }

  novo(caminho) {
    return {
      caminho, existe: false, gz: /\.gz$/i.test(caminho), ino: null, nasc: null, offset: 0, tam: -1, mtime: -1,
      col: new Colunas(), porFluxo: new Map(), citados: new Map(), sessoes: [''], idSessao: new Map([['', 0]]),
      dadosGz: null, invalidas: 0, erro: null, pendente: false, fila: Promise.resolve(),
    };
  }

  zerar(ent) {
    Object.assign(ent, { offset: 0, col: new Colunas(), porFluxo: new Map(), citados: new Map(), sessoes: [''], idSessao: new Map([['', 0]]), dadosGz: null, invalidas: 0 });
  }

  /**
   * Atualiza o índice do arquivo. orcamento: {restante} em bytes; se os bytes novos não cabem e já se
   * leu algo nesta requisição, o arquivo fica para depois (ent.pendente = true).
   */
  async ler(caminho, orcamento) {
    const chave = process.platform === 'win32' ? path.resolve(caminho).toLowerCase() : path.resolve(caminho);
    let ent = this.mapa.get(chave);
    if (ent) this.mapa.delete(chave);
    else ent = this.novo(caminho);
    this.mapa.set(chave, ent);
    const tarefa = ent.fila.then(() => this.atualizar(ent, orcamento));
    ent.fila = tarefa.catch(() => {});
    try {
      await tarefa;
      ent.erro = null;
    } catch (e) {
      ent.erro = e && e.code ? e.code : String(e && e.message ? e.message : e);
    }
    if (!ent.existe) this.mapa.delete(chave);
    while (this.mapa.size > 1 && (this.mapa.size > this.maxArquivos || this.linhasGuardadas() > this.maxLinhas)) {
      const k = this.mapa.keys().next().value;
      if (k === chave) break;
      this.mapa.delete(k);
    }
    return ent;
  }

  indexar(buf, base, ent) {
    let ini = 0;
    while (ini < buf.length) {
      let fim = buf.indexOf(0x0a, ini);
      if (fim < 0) fim = buf.length;
      this.indexarLinha(buf, ini, fim, base, ent);
      ini = fim + 1;
    }
  }

  indexarLinha(buf, ini, fim, base, ent) {
    const texto = buf.toString('utf8', ini, fim).replace(/^﻿/, '').trim();
    if (!texto) return;
    let o;
    try {
      o = JSON.parse(texto);
    } catch (_) {
      ent.invalidas++;
      return;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      ent.invalidas++;
      return;
    }
    const t = Date.parse(o.ts);
    const fluxo = typeof o.fluxo_id === 'string' && o.fluxo_id ? o.fluxo_id : null;
    const prompt = o.evento === 'UserPromptSubmit' && typeof o.prompt === 'string';
    let ses = 0;
    if (typeof o.sessao === 'string' && o.sessao) {
      ses = ent.idSessao.get(o.sessao);
      if (ses === undefined) {
        ses = ent.sessoes.length;
        ent.sessoes.push(o.sessao);
        ent.idSessao.set(o.sessao, ses);
      }
    }
    sequencia++;
    const i = ent.col.push(Number.isFinite(t) ? t : 0, base + ini, fim - ini, sequencia, ses, (fluxo || o.fluxo_id ? MARCA_FLUXO : 0) | (prompt ? MARCA_PROMPT : 0));
    if (fluxo) {
      if (!ent.porFluxo.has(fluxo)) ent.porFluxo.set(fluxo, []);
      ent.porFluxo.get(fluxo).push(i);
    }
    if (prompt) {
      for (const id of new Set(o.prompt.match(RE_FLUXO_CITADO) || [])) {
        if (!ent.citados.has(id)) ent.citados.set(id, []);
        ent.citados.get(id).push(i);
      }
    }
  }

  async atualizar(ent, orcamento) {
    ent.pendente = false;
    let st;
    try {
      st = await comNovasTentativas(() => fsp.stat(ent.caminho));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        if (ent.existe) this.zerar(ent);
        ent.existe = false;
        return;
      }
      throw e;
    }
    ent.existe = true;
    const cabe = (n) => !orcamento || orcamento.lidos === 0 || n <= orcamento.restante;
    const gastar = (n) => {
      if (!orcamento) return;
      orcamento.restante -= n;
      orcamento.lidos += n;
    };
    if (ent.gz) {
      if (st.size === ent.tam && st.mtimeMs === ent.mtime) return;
      if (!cabe(st.size * 8)) {
        ent.pendente = true;
        return;
      }
      this.zerar(ent);
      const buf = await comNovasTentativas(() => fsp.readFile(ent.caminho));
      try {
        ent.dadosGz = zlib.gunzipSync(buf);
        gastar(ent.dadosGz.length);
        this.indexar(ent.dadosGz, 0, ent);
      } catch (_) {
        ent.dadosGz = null;
        ent.invalidas++;
      }
      ent.tam = st.size;
      ent.mtime = st.mtimeMs;
      return;
    }
    if (ent.ino !== null && (st.ino !== ent.ino || st.birthtimeMs !== ent.nasc || st.size < ent.offset)) this.zerar(ent);
    ent.ino = st.ino;
    ent.nasc = st.birthtimeMs;
    if (st.size === ent.offset) return;
    const quer = st.size - ent.offset;
    if (!cabe(quer)) {
      ent.pendente = true;
      return;
    }
    const fh = await comNovasTentativas(() => fsp.open(ent.caminho, 'r'));
    try {
      const buf = Buffer.allocUnsafe(quer);
      let lidos = 0;
      while (lidos < quer) {
        const { bytesRead } = await fh.read(buf, lidos, quer - lidos, ent.offset + lidos);
        if (!bytesRead) break;
        lidos += bytesRead;
      }
      gastar(lidos);
      const dados = buf.subarray(0, lidos);
      const nl = dados.lastIndexOf(0x0a);
      let consumido = 0;
      if (nl >= 0) {
        this.indexar(dados.subarray(0, nl), ent.offset, ent);
        consumido = nl + 1;
      }
      if (consumido < dados.length) {
        // Final sem \n: só entra se já for um JSON completo; senão ainda está sendo escrito.
        const resto = dados.subarray(consumido).toString('utf8').replace(/^﻿/, '').trim();
        let completo = !resto;
        if (resto) {
          try { JSON.parse(resto); completo = true; } catch (_) { completo = false; }
        }
        if (completo) {
          if (resto) this.indexarLinha(dados, consumido, dados.length, ent.offset, ent);
          consumido = dados.length;
        }
      }
      ent.offset += consumido;
    } finally {
      await fh.close();
    }
  }

  /** Relê as linhas pedidas (índices do arquivo) e devolve os objetos com _t e _seq. */
  async materializar(ent, indices) {
    const saida = new Map();
    if (!indices.length) return saida;
    const col = ent.col;
    const montar = (texto, i) => {
      let o;
      try { o = JSON.parse(texto.replace(/^﻿/, '')); } catch (_) { return; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      Object.defineProperties(o, { _t: { value: col.t[i] }, _seq: { value: col.seq[i] } });
      saida.set(i, o);
    };
    if (ent.gz) {
      if (ent.dadosGz) for (const i of indices) montar(ent.dadosGz.toString('utf8', col.off[i], col.off[i] + col.len[i]), i);
      return saida;
    }
    let fh;
    try {
      fh = await comNovasTentativas(() => fsp.open(ent.caminho, 'r'));
    } catch (_) {
      return saida;
    }
    try {
      for (const i of [...indices].sort((a, b) => col.off[a] - col.off[b])) {
        const buf = Buffer.allocUnsafe(col.len[i]);
        const { bytesRead } = await fh.read(buf, 0, col.len[i], col.off[i]);
        montar(buf.toString('utf8', 0, bytesRead), i);
      }
    } finally {
      await fh.close();
    }
    return saida;
  }
}

function prepararEvento(ev, seq) {
  const t = Date.parse(ev.ts);
  let dia = null;
  if (typeof ev.ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?-03:00$/.test(ev.ts)) dia = ev.ts.slice(0, 10);
  else if (Number.isFinite(t)) dia = diaSP(t);
  Object.defineProperties(ev, {
    _t: { value: Number.isFinite(t) ? t : 0 },
    _dia: { value: dia },
    _seq: { value: seq },
  });
}

function textoBusca(ev) {
  if (ev._busca === undefined) {
    const tr = obj(ev.trello);
    const partes = [ev.resumo, ev.direcao, tr && tr.titulo, ev.fluxo_id].filter((x) => typeof x === 'string');
    Object.defineProperty(ev, '_busca', { value: normalizarBusca(partes.join('\n')) });
  }
  return ev._busca;
}

// ---------- acesso aos arquivos de _maestro ----------

class Dados {
  constructor(maestroDir) {
    this.dir = maestroDir;
    this.p = {
      agentes: path.join(maestroDir, 'registro', 'agentes.json'),
      eventos: path.join(maestroDir, 'logs', 'eventos'),
      bruto: path.join(maestroDir, 'logs', 'bruto'),
      pendencias: path.join(maestroDir, 'estado', 'pendencias.json'),
      contador: path.join(maestroDir, 'estado', 'contador-fluxos.json'),
      trelloResumo: path.join(maestroDir, 'estado', 'trello', 'resumo.json'),
      trelloSerie: path.join(maestroDir, 'estado', 'trello', 'serie.jsonl'),
      trelloRst: path.join(maestroDir, 'estado', 'trello', 'rst.md'),
      uso: path.join(maestroDir, 'estado', 'uso.json'),
      pid: path.join(maestroDir, 'estado', 'painel.pid'),
    };
    this.leitorEventos = new LeitorJsonl({ aoLer: prepararEvento });
    // Log bruto: índice compacto por arquivo (as linhas são relidas do disco só quando escolhidas).
    this.indiceBruto = new IndiceBruto({ maxLinhas: BRUTO_MAX_LINHAS_INDICE });
    this.leitorSerie = new LeitorJsonl();
    this.cacheArquivos = new Map();
    this.cacheListas = new Map();
    this.cacheCaudas = new Map();
    this.cacheAsc = new WeakMap();
  }

  /** Lê arquivo com cache por (ino, tamanho, mtime). tipo "json" → {existe, dados, erro}; "texto" → {existe, texto, erro}. */
  async arquivo(caminho, tipo) {
    let st;
    try {
      st = await comNovasTentativas(() => fsp.stat(caminho));
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        this.cacheArquivos.delete(caminho);
        return { existe: false, dados: null, texto: null, erro: null };
      }
      return { existe: true, dados: null, texto: null, erro: `não consegui ler (${e.code || e.message})` };
    }
    const chave = `${tipo}:${st.ino}:${st.size}:${st.mtimeMs}`;
    const c = this.cacheArquivos.get(caminho);
    if (c && c.chave === chave) return c.valor;
    let valor;
    if (tipo === 'json') {
      valor = await lerJson(caminho);
    } else {
      try {
        const texto = await lerTexto(caminho);
        valor = { existe: texto !== null, texto, erro: null };
      } catch (e) {
        valor = { existe: true, texto: null, erro: `não consegui ler (${e.code || e.message})` };
      }
    }
    if (!valor.erro) this.cacheArquivos.set(caminho, { chave, valor });
    return valor;
  }

  json(caminho) {
    return this.arquivo(caminho, 'json');
  }

  texto(caminho) {
    return this.arquivo(caminho, 'texto');
  }

  async listarMeses() {
    let nomes = [];
    try {
      nomes = await comNovasTentativas(() => fsp.readdir(this.p.eventos));
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
    }
    const arquivos = [];
    for (const n of nomes) {
      const m = /^(\d{4}-\d{2})\.jsonl(\.gz)?$/i.exec(n);
      if (m) arquivos.push({ mes: m[1], gz: !!m[2], caminho: path.join(this.p.eventos, n) });
    }
    return arquivos.sort((a, b) => a.mes.localeCompare(b.mes) || (a.gz ? -1 : 1));
  }

  /** Eventos ("recentes" = 2 meses mais recentes; "todos"), do mais recente para o mais antigo. */
  async eventos(escopo) {
    const arquivos = await this.listarMeses();
    let alvo = arquivos;
    if (escopo === 'recentes') {
      const meses = [...new Set(arquivos.map((a) => a.mes))].slice(-2);
      alvo = arquivos.filter((a) => meses.includes(a.mes));
    }
    const ents = [];
    for (const a of alvo) ents.push(await this.leitorEventos.ler(a.caminho));
    const versao = ents.map((e) => `${e.caminho}#${e.geracao}#${e.linhas.length}#${e.invalidas}`).join('|');
    const c = this.cacheListas.get(escopo);
    if (c && c.versao === versao) return c;
    const vistos = new Set();
    const lista = [];
    const avisos = [];
    for (const e of ents) {
      // Sem id válido (texto no formato de id) o evento não abre no modal nem entra na navegação: fica de fora.
      let semId = 0;
      for (const ev of e.linhas) {
        if (typeof ev.id !== 'string' || !RE_ID.test(ev.id)) {
          semId++;
          continue;
        }
        if (vistos.has(ev.id)) continue;
        vistos.add(ev.id);
        lista.push(ev);
      }
      const ilegiveis = e.invalidas + semId;
      if (ilegiveis) avisos.push(`${relativo(this.dir, e.caminho)}: ${ilegiveis} linha(s) ilegível(is) ou sem id válido ignorada(s)`);
      if (e.erro) avisos.push(`${relativo(this.dir, e.caminho)}: leitura incompleta (${e.erro}); tento de novo na próxima atualização`);
    }
    lista.sort((a, b) => b._t - a._t || b._seq - a._seq);
    const r = { versao, lista, avisos };
    this.cacheListas.set(escopo, r);
    return r;
  }

  /** A mesma lista em ordem crescente (cacheada por lista). */
  crescente(lista) {
    let asc = this.cacheAsc.get(lista);
    if (!asc) {
      asc = lista.slice().reverse();
      this.cacheAsc.set(lista, asc);
    }
    return asc;
  }

  async pastasBruto() {
    try {
      const itens = await comNovasTentativas(() => fsp.readdir(this.p.bruto, { withFileTypes: true }));
      return itens.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
      throw e;
    }
  }

  /** Índices dos arquivos do log bruto de uma pasta num dia (AAAA-MM-DD.jsonl.gz e .jsonl) que existem. */
  async indicesBruto(pasta, dia, orcamento) {
    const saida = [];
    for (const ext of ['.jsonl.gz', '.jsonl']) {
      const ent = await this.indiceBruto.ler(path.join(this.p.bruto, pasta, dia + ext), orcamento);
      if (ent.existe) saida.push(ent);
    }
    return saida;
  }

  /** ts (ISO -03:00) da última entrada do log bruto de uma pasta, lendo só o fim do arquivo mais novo. */
  async ultimoBruto(pasta) {
    const dir = path.join(this.p.bruto, pasta);
    let nomes;
    try {
      nomes = await comNovasTentativas(() => fsp.readdir(dir));
    } catch (_) {
      return null;
    }
    const recentes = nomes.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/i.test(n)).sort().reverse().slice(0, 3);
    for (const n of recentes) {
      const ts = await this.tsFinal(path.join(dir, n));
      if (ts) return ts;
    }
    return null;
  }

  async tsFinal(caminho) {
    let st;
    try {
      st = await comNovasTentativas(() => fsp.stat(caminho));
    } catch (_) {
      return null;
    }
    const chave = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const c = this.cacheCaudas.get(caminho);
    if (c && c.chave === chave) return c.ts;
    let melhor = null;
    if (st.size > 0) {
      const tam = Math.min(st.size, 256 * 1024);
      const fh = await comNovasTentativas(() => fsp.open(caminho, 'r'));
      try {
        const buf = Buffer.allocUnsafe(tam);
        const { bytesRead } = await fh.read(buf, 0, tam, st.size - tam);
        const linhas = buf.subarray(0, bytesRead).toString('utf8').split('\n');
        // Hooks async podem gravar fora de ordem: vale o maior ts entre as últimas linhas válidas.
        let vistas = 0;
        for (let i = linhas.length - 1; i >= 0 && vistas < 50; i--) {
          const l = linhas[i].trim();
          if (!l) continue;
          let o;
          try { o = JSON.parse(l); } catch (_) { continue; }
          const t = Date.parse(o && o.ts);
          if (!Number.isFinite(t)) continue;
          vistas++;
          if (melhor === null || t > melhor) melhor = t;
        }
      } finally {
        await fh.close();
      }
    }
    const ts = melhor === null ? null : isoSP(melhor);
    this.cacheCaudas.set(caminho, { chave, ts });
    return ts;
  }
}

// ---------- saúde ----------

/**
 * nivel: verde | amarelo | vermelho. Regras: leitura do Trello acima de 2× o intervalo → amarelo,
 * acima de 4× → vermelho (idade real; só com PAINEL_TRELLO_JANELA definida conta apenas o horário
 * das leituras); agente ativo
 * sem log bruto há mais de 24 h (ou nunca) → amarelo; arquivos de estado ilegíveis → amarelo.
 */
function calcularSaude({ agora, trello, hooks, cfgTrello, problemas = [] }) {
  let nivel = 0;
  const motivos = [];
  const subir = (n, texto) => {
    nivel = Math.max(nivel, n);
    motivos.push(texto);
  };
  for (const p of problemas) subir(1, p);
  let trelloIdade = null;
  if (!trello.existe) subir(1, 'Trello ainda não foi lido (sem estado/trello/resumo.json)');
  else if (trello.erro) subir(1, `Resumo do Trello ilegível: ${trello.erro}`);
  else if (trello.coletadoEm === null) subir(1, 'Resumo do Trello sem a hora da leitura (coletado_em)');
  else {
    trelloIdade = Math.max(0, Math.round((agora - trello.coletadoEm) / MIN_MS));
    const util = minutosUteis(trello.coletadoEm, agora, cfgTrello.janela);
    const intervalo = cfgTrello.intervaloMin;
    // Com PAINEL_TRELLO_JANELA (opcional), o motivo diz quanto da idade caiu no horário das leituras.
    const noHorario = cfgTrello.janela && Math.round(util) < trelloIdade ? `, ${duracaoTexto(util)} no horário das leituras` : '';
    const texto = `Trello lido há ${duracaoTexto(trelloIdade)}${noHorario} (rotina a cada ${duracaoTexto(intervalo)})`;
    if (util > 4 * intervalo) subir(2, texto);
    else if (util > 2 * intervalo) subir(1, texto);
  }
  for (const h of hooks) {
    if (!h.ativo) continue;
    if (!h.ultimo_bruto) subir(1, `${h.nome}: nenhum log bruto ainda (hooks instalados?)`);
    else if (h.idade_min !== null && h.idade_min * MIN_MS > BRUTO_ATRASADO_MS) subir(1, `${h.nome} sem log bruto há ${duracaoTexto(h.idade_min)}`);
  }
  return { nivel: ['verde', 'amarelo', 'vermelho'][nivel], motivos, trello_idade_min: trelloIdade };
}

// ---------- montagem das respostas ----------

function camposTabela(ev) {
  const r = {};
  for (const k of CAMPOS_TABELA) r[k] = ev[k] === undefined ? null : ev[k];
  r.trello = obj(ev.trello);
  r.precisa_dono = ev.precisa_dono === true;
  r.origem = ev.origem === undefined ? null : ev.origem;
  if (ev.teste === true) r.teste = true;
  return r;
}

/** Plano do uso.json conferido contra o relógio de agora (idade e janelas que já reiniciaram). */
function planoAgora(plano, t) {
  const p = Object.assign({}, plano);
  p.idade_min = idadeMin(p.atualizado_em, t);
  for (const [pct, reset, motivo, nome] of [['janela_5h_pct', 'reset_5h', 'janela_5h_motivo', 'de 5 h'], ['semanal_pct', 'reset_semanal', 'semanal_motivo', 'semanal']]) {
    const r = Date.parse(p[reset]);
    if (typeof p[pct] === 'number' && Number.isFinite(r) && r <= t) {
      p[pct] = null;
      p[motivo] = `A janela ${nome} reiniciou às ${horaCurta(r, t)}; o % novo aparece na próxima leitura do Maestri.`;
    }
  }
  if (p.disponivel && typeof p.janela_5h_pct !== 'number' && typeof p.semanal_pct !== 'number') {
    p.disponivel = false;
    p.motivo = p.motivo || [p.janela_5h_motivo, p.semanal_motivo].filter(Boolean).join(' ') || 'Sem percentual do plano.';
  }
  return p;
}

/** Cópia do resumo.json sem itens que não são objetos nas listas que o painel percorre. */
function limparTrello(tr) {
  if (!tr) return null;
  const objs = (v) => (Array.isArray(v) ? v.filter((x) => obj(x)) : v);
  const r = Object.assign({}, tr);
  if (Array.isArray(tr.projetos)) {
    r.projetos = objs(tr.projetos).map((p) => (Array.isArray(p.cartoes) ? Object.assign({}, p, { cartoes: objs(p.cartoes) }) : p));
  }
  if (Array.isArray(tr.nao_classificados)) r.nao_classificados = objs(tr.nao_classificados);
  if (obj(tr.auditoria)) r.auditoria = Object.assign({}, tr.auditoria, { mecanicos: objs(tr.auditoria.mecanicos), decisoes: objs(tr.auditoria.decisoes) });
  return r;
}

/** Cópia do uso.json sem itens que não são objetos em por_agente.<período>. */
function limparUso(uso) {
  if (!uso || !obj(uso.por_agente)) return uso;
  const pa = {};
  for (const [k, v] of Object.entries(uso.por_agente)) pa[k] = Array.isArray(v) ? v.filter((x) => obj(x)) : v;
  return Object.assign({}, uso, { por_agente: pa });
}

function linhaDeUso(uso, slug, periodo) {
  const lista = uso && obj(uso.por_agente) && Array.isArray(uso.por_agente[periodo]) ? uso.por_agente[periodo] : [];
  const l = lista.find((x) => x && x.agente === slug);
  if (!l) return { pct_consumo: 0, consumo_relativo: 0, pct_plano_estimado: null, entrada: 0, saida: 0, cache_escrita: 0, cache_leitura: 0, mensagens: 0 };
  const r = Object.assign({}, l);
  delete r.agente;
  delete r.registrado;
  return r;
}

function registroDoFluxo(dados, id) {
  const d = obj(dados);
  if (!d) return null;
  const norm = (x) => (typeof x === 'string' ? { titulo: x } : obj(x) ? x : null);
  if (Array.isArray(d.fluxos)) return norm(d.fluxos.find((x) => x && (x.id === id || x.fluxo_id === id)));
  if (obj(d.fluxos) && d.fluxos[id] !== undefined) return norm(d.fluxos[id]);
  if (d[id] !== undefined) return norm(d[id]);
  return null;
}

function infoFluxo(contador, id, eventosDoFluxo) {
  const reg = registroDoFluxo(contador, id);
  if (!reg && !eventosDoFluxo.length) return null;
  const primeiro = eventosDoFluxo[0] || null;
  return {
    id,
    titulo: reg && typeof reg.titulo === 'string' ? reg.titulo : null,
    criado_em: (reg && reg.criado_em) || (primeiro ? primeiro.ts : null),
    agente: (reg && reg.agente) || (primeiro ? primeiro.agente : null),
  };
}

/** Origem de um prompt bruto pelos envelopes da delegação ([PEDIDO], [AVISO], [ROTINA]...). */
function origemDoPrompt(texto, porNome) {
  const t = String(texto || '');
  if (/^\s*\[ROTINA\]/i.test(t)) return 'rotina';
  if (/^\s*\[(PEDIDO|AVISO|RESPOSTA|COBRAN[CÇ]A)\]/i.test(t)) {
    const de = /De:\s*([^\n→]+?)\s*(?:→|->|\n|$)/.exec(t);
    if (de) {
      const nome = de[1].trim();
      const slug = porNome.get(normalizarBusca(nome)) || nome;
      return slug === 'cerebro' ? 'cerebro' : `agente:${slug}`;
    }
  }
  return 'dono-direto';
}

function vizinhos(asc, ev) {
  // Só eventos com id em texto válido (os que abrem em /api/evento/<id>) servem de vizinho.
  const valido = (e) => typeof e.id === 'string' && RE_ID.test(e.id);
  const visiveis = asc.filter((e) => e === ev || (valido(e) && (ev.teste === true || e.teste !== true)));
  const i = visiveis.indexOf(ev);
  return {
    anterior_id: i > 0 ? visiveis[i - 1].id : null,
    proximo_id: i >= 0 && i < visiveis.length - 1 ? visiveis[i + 1].id : null,
  };
}

function formatarComando(l, pasta, correlacao) {
  const r = {
    ts: l.ts === undefined ? null : l.ts,
    agente: typeof l.agente === 'string' && l.agente ? l.agente : agenteDaPasta(pasta),
    evento: l.evento === undefined ? null : l.evento,
    ferramenta: l.ferramenta === undefined ? null : l.ferramenta,
    entrada: l.entrada === undefined ? null : l.entrada,
    ok: typeof l.ok === 'boolean' ? l.ok : null,
    sessao: l.sessao === undefined ? null : l.sessao,
    fluxo_id: l.fluxo_id === undefined ? null : l.fluxo_id,
    correlacao,
  };
  if (l.erro !== undefined) r.erro = l.erro;
  if (l.duracao_ms !== undefined) r.duracao_ms = l.duracao_ms;
  if (l.agent_type !== undefined) r.agent_type = l.agent_type;
  if (typeof l.prompt === 'string') r.prompt = truncar(l.prompt, 2000);
  return r;
}

// ---------- contexto (dados + coletor) ----------

function criarContexto(cfg) {
  const ctx = {
    cfg,
    dados: new Dados(cfg.maestroDir),
    porta: cfg.porta,
    hostsPermitidos: new Set(),
    origensPermitidas: new Set(),
    coletaAtual: null,
    ultimaColeta: null,
    agora: () => (cfg.agoraFixa ? new Date(cfg.agoraFixa.getTime()) : new Date()),
    log: (msg) => {
      try {
        const h = isoSP(new Date()).slice(11, 19);
        process.stdout.write(`[${h}] ${msg}\n`);
      } catch (_) { /* terminal fechado */ }
    },
    erro: (msg) => {
      try {
        const h = isoSP(new Date()).slice(11, 19);
        process.stderr.write(`[${h}] ${msg}\n`);
      } catch (_) { /* terminal fechado */ }
    },
  };
  ctx.definirPorta = (porta) => {
    ctx.porta = porta;
    ctx.hostsPermitidos = new Set([`127.0.0.1:${porta}`, `localhost:${porta}`]);
    ctx.origensPermitidas = new Set([`http://127.0.0.1:${porta}`, `http://localhost:${porta}`]);
  };
  ctx.definirPorta(cfg.porta);
  /** Roda o coletor de uso; chamadas durante uma coleta esperam a mesma coleta. */
  ctx.executarColetor = (motivo) => {
    if (ctx.coletaAtual) return ctx.coletaAtual;
    const p = (async () => {
      await null;
      const inicio = Date.now();
      try {
        const uso = await coletor.coletar({
          maestroDir: cfg.maestroDir,
          maestriDataDir: cfg.env.MAESTRI_DATA_DIR,
          claudeDir: cfg.env.CLAUDE_CONFIG_DIR,
          env: cfg.env,
          agora: ctx.agora(),
          gravar: true,
        });
        ctx.ultimaColeta = { em: isoSP(new Date()), motivo, ok: true, duracao_ms: Date.now() - inicio, erro: null };
        if (motivo !== 'periodico') {
          const pl = uso.plano;
          const plano = pl.disponivel ? `plano 5 h ${pl.janela_5h_pct ?? '—'}% · semanal ${pl.semanal_pct ?? '—'}%` : 'plano indisponível';
          ctx.log(`Uso coletado (${motivo}): ${plano} · ${uso.coleta.sessoes} sessão(ões) com dono · ${ctx.ultimaColeta.duracao_ms} ms`);
        }
      } catch (e) {
        ctx.ultimaColeta = { em: isoSP(new Date()), motivo, ok: false, duracao_ms: Date.now() - inicio, erro: e && e.message ? e.message : String(e) };
        ctx.erro(`Falha no coletor de uso (${motivo}): ${e && e.stack ? e.stack : e}`);
      } finally {
        ctx.coletaAtual = null;
      }
      return ctx.ultimaColeta;
    })();
    ctx.coletaAtual = p;
    return p;
  };
  return ctx;
}

// ---------- GET /api/estado ----------

async function montarEstado(ctx) {
  const { dados, cfg } = ctx;
  const agora = ctx.agora();
  const t = agora.getTime();
  const hoje = diaSP(agora);
  const avisos = [];
  const problemas = [];

  const [reg, evs, pend, cont, resumo, rst, usoArq, serie] = await Promise.all([
    dados.json(dados.p.agentes), dados.eventos('recentes'), dados.json(dados.p.pendencias),
    dados.json(dados.p.contador), dados.json(dados.p.trelloResumo), dados.texto(dados.p.trelloRst),
    dados.json(dados.p.uso), dados.leitorSerie.ler(dados.p.trelloSerie),
  ]);

  // Registro
  const registro = obj(reg.dados) || {};
  if (!reg.existe) problemas.push('registro/agentes.json não existe');
  else if (reg.erro) problemas.push(`registro/agentes.json ilegível (${reg.erro})`);
  const padrao = obj(registro.padrao) || {};
  const ws = obj(registro.workspace) || {};
  const listaAgentes = arr(registro.agentes).filter((a) => obj(a) && typeof a.slug === 'string' && a.slug);
  const workspace = { id: ws.id || null, nome: ws.nome || 'Workspace', raiz: ws.raiz || path.dirname(cfg.maestroDir).replace(/\\/g, '/') };

  // Eventos (testes ficam fora)
  avisos.push(...evs.avisos);
  const eventos = evs.lista.filter((e) => e.teste !== true);
  const ultimoPorFluxo = new Map();
  for (const e of eventos) if (e.fluxo_id && !ultimoPorFluxo.has(e.fluxo_id)) ultimoPorFluxo.set(e.fluxo_id, e);
  const abertos = new Set([...ultimoPorFluxo].filter(([, e]) => RESULTADOS_ABERTOS.has(e.resultado)).map(([f]) => f));
  const abertosPorAgente = new Map();
  for (const e of eventos) {
    if (!e.fluxo_id || !abertos.has(e.fluxo_id)) continue;
    if (!abertosPorAgente.has(e.agente)) abertosPorAgente.set(e.agente, new Set());
    abertosPorAgente.get(e.agente).add(e.fluxo_id);
  }

  // Uso
  const uso = limparUso(obj(usoArq.dados));
  if (usoArq.existe && !uso) avisos.push(`estado/uso.json ilegível (${usoArq.erro || 'formato inesperado'})`);
  const plano = uso && obj(uso.plano) ? planoAgora(uso.plano, t) : null;
  const kUso = plano
    ? {
      disponivel: !!plano.disponivel, janela_5h_pct: typeof plano.janela_5h_pct === 'number' ? plano.janela_5h_pct : null,
      reset_5h: plano.reset_5h || null, semanal_pct: typeof plano.semanal_pct === 'number' ? plano.semanal_pct : null,
      reset_semanal: plano.reset_semanal || null, idade_min: plano.idade_min, atualizado_em: plano.atualizado_em || null,
      motivo: plano.disponivel ? null : plano.motivo || null, janela_5h_motivo: plano.janela_5h_motivo || null,
      semanal_motivo: plano.semanal_motivo || null, fonte: plano.fonte || null, coletado_em: uso.coletado_em || null,
    }
    : {
      disponivel: false, janela_5h_pct: null, reset_5h: null, semanal_pct: null, reset_semanal: null, idade_min: null,
      atualizado_em: null, janela_5h_motivo: null, semanal_motivo: null, fonte: null, coletado_em: null,
      motivo: usoArq.existe ? `estado/uso.json ilegível (${usoArq.erro || 'formato inesperado'}).` : 'O coletor de uso ainda não rodou (sem estado/uso.json).',
    };
  const usoResposta = uso ? Object.assign({}, uso, { plano: plano || uso.plano }) : null;

  // Agentes e hooks
  const agentes = [];
  const hooks = [];
  for (const a of listaAgentes) {
    const pasta = pastaDoAgente(a.slug);
    const ultimoBruto = pasta ? await dados.ultimoBruto(pasta) : null;
    hooks.push({ agente: a.slug, nome: a.nome || a.slug, ativo: a.status === 'ativo', ultimo_bruto: ultimoBruto, idade_min: idadeMin(ultimoBruto, t) });
    const ultimo = eventos.find((e) => e.agente === a.slug) || null;
    agentes.push({
      slug: a.slug, nome: a.nome || a.slug, tipo: a.tipo || null, cor: a.cor || null,
      responsabilidade: a.responsabilidade || null, status: a.status || null,
      modelo: a.modelo || padrao.modelo || null, nivel: a.nivel || padrao.nivel || null,
      skills: arr(a.skills), conectado_a: arr(a.conectado_a), desde: a.desde || null, observacao: a.observacao || null,
      terminal_id: typeof a.terminal_id === 'string' && a.terminal_id ? a.terminal_id : null,
      ultimo_evento: ultimo ? { id: ultimo.id || null, ts: ultimo.ts || null, resumo: ultimo.resumo || null, tipo: ultimo.tipo || null, resultado: ultimo.resultado || null, fluxo_id: ultimo.fluxo_id || null } : null,
      eventos_hoje: eventos.reduce((n, e) => n + (e.agente === a.slug && e._dia === hoje ? 1 : 0), 0),
      fluxos_abertos: (abertosPorAgente.get(a.slug) || new Set()).size,
      ultimo_bruto: ultimoBruto,
      uso: uso ? { janela_5h: linhaDeUso(uso, a.slug, 'janela_5h'), hoje: linhaDeUso(uso, a.slug, 'hoje'), '7d': linhaDeUso(uso, a.slug, '7d') } : null,
    });
  }
  const conhecidas = new Set(listaAgentes.map((a) => pastaDoAgente(a.slug)));
  for (const pasta of await dados.pastasBruto()) {
    // Pastas que começam com "_" ou "." são arquivo morto (ex.: _reatribuido-desconhecido-x): não são agentes.
    if (conhecidas.has(pasta) || /^[._]/.test(pasta)) continue;
    const ub = await dados.ultimoBruto(pasta);
    hooks.push({ agente: agenteDaPasta(pasta), nome: agenteDaPasta(pasta), ativo: false, registrado: false, ultimo_bruto: ub, idade_min: idadeMin(ub, t) });
  }

  // Pendências (testes ficam fora)
  const pd = pend.dados;
  const todasPend = Array.isArray(pd) ? pd : obj(pd) && Array.isArray(pd.pendencias) ? pd.pendencias : null;
  if (pend.existe && !todasPend) problemas.push(`estado/pendencias.json ilegível (${pend.erro || 'sem a lista "pendencias"'})`);
  const validas = arr(todasPend).filter((p) => obj(p) && p.teste !== true);
  const nomeSev = (p) => (ORDEM_SEVERIDADE.has(p.severidade) ? p.severidade : 'normal');
  const sev = (p) => ORDEM_SEVERIDADE.get(nomeSev(p));
  const tempo = (v) => {
    const x = Date.parse(v);
    return Number.isFinite(x) ? x : 0;
  };
  const grupo = (p) => (!p.status || p.status === 'aberta' ? 0 : p.status === 'respondida' ? 1 : 2);
  const ativas = validas.filter((p) => grupo(p) < 2)
    .sort((a, b) => grupo(a) - grupo(b) || sev(a) - sev(b) || tempo(a.aberta_em) - tempo(b.aberta_em) || String(a.id).localeCompare(String(b.id)));
  const fechadas = validas.filter((p) => grupo(p) === 2)
    .sort((a, b) => tempo(b.resolvida_em || b.atualizada_em || b.aberta_em) - tempo(a.resolvida_em || a.atualizada_em || a.aberta_em))
    .slice(0, LIMITE_FECHADAS);
  const pendencias = [...ativas, ...fechadas].map((p) => Object.assign({}, p, { idade_min: idadeMin(p.aberta_em, t) }));
  const kPend = { total: 0, critica: 0, alta: 0, normal: 0, baixa: 0 };
  for (const p of validas) {
    if (grupo(p) !== 0) continue;
    kPend.total++;
    kPend[nomeSev(p)]++;
  }

  // Trello
  const tr = limparTrello(obj(resumo.dados));
  const erroResumo = resumo.existe && !tr ? resumo.erro || 'formato inesperado' : null;
  const totais = tr ? obj(tr.totais) || {} : {};
  const auditoria = tr ? obj(tr.auditoria) || {} : {};
  const kTrello = tr
    ? {
      abertas: numero(totais.abertas), a_fazer: numero(totais.a_fazer), em_andamento: numero(totais.em_andamento),
      concluido: numero(totais.concluido), alertas_mecanicos: arr(auditoria.mecanicos).length,
      alertas_decisao: arr(auditoria.decisoes).length, coletado_em: tr.coletado_em || null,
    }
    : null;
  if (serie.invalidas) avisos.push(`estado/trello/serie.jsonl: ${serie.invalidas} linha(s) ilegível(is) ignorada(s)`);
  if (cont.existe && cont.erro) avisos.push(`estado/contador-fluxos.json ilegível (${cont.erro})`);

  // Saúde
  const coletadoTrello = tr ? comoData(tr.coletado_em) : null;
  const saudeBase = calcularSaude({
    agora: t,
    trello: { existe: resumo.existe, erro: erroResumo, coletadoEm: coletadoTrello ? coletadoTrello.getTime() : null },
    hooks, cfgTrello: cfg.trello, problemas,
  });
  const ultimoEvento = eventos[0] || null;
  const saude = {
    nivel: saudeBase.nivel,
    motivos: saudeBase.motivos,
    trello_idade_min: saudeBase.trello_idade_min,
    ultimo_evento_idade_min: ultimoEvento ? idadeMin(ultimoEvento.ts, t) : null,
    uso_idade_min: kUso.idade_min,
    hooks,
    wire: false,
  };

  return {
    gerado_em: isoSP(agora),
    workspace,
    saude,
    kpis: { pendencias: kPend, trello: kTrello, uso: kUso },
    agentes,
    pendencias,
    trello: tr,
    trello_rst: rst.existe && typeof rst.texto === 'string' ? rst.texto : null,
    serie_trello: serie.existe ? serie.linhas.slice(-LIMITE_SERIE) : [],
    uso: usoResposta,
    eventos: eventos.slice(0, LIMITE_EVENTOS_ESTADO).map(camposTabela),
    coletor: { intervalo_min: COLETOR_INTERVALO_MS / MIN_MS, ativo: cfg.coletorAtivo, ultima: ctx.ultimaColeta, em_andamento: !!ctx.coletaAtual },
    // Resposta de pendência pelo painel: sempre grava; o aviso no terminal do Cérebro depende do Maestri.
    respostas: { aviso_cerebro: !!(cfg.avisoCerebro && cfg.avisoCerebro.ativo), motivo: cfg.avisoCerebro && !cfg.avisoCerebro.ativo ? cfg.avisoCerebro.motivo : null },
    avisos,
  };
}

// ---------- GET /api/eventos ----------

function lerFiltros(sp) {
  const dia = (nome) => {
    const v = (sp.get(nome) || '').trim();
    if (!v) return null;
    if (!diaValido(v)) throw new ErroPedido(400, `Parâmetro "${nome}" inválido: "${truncar(v, 40)}" (use AAAA-MM-DD).`);
    return v;
  };
  const conjunto = (nome, minusculas) => {
    const v = (sp.get(nome) || '').trim();
    if (!v) return null;
    return new Set(v.split(',').map((x) => (minusculas ? x.trim().toLowerCase() : x.trim())).filter(Boolean));
  };
  const inteiro = (nome, padrao, maximo) => {
    const v = (sp.get(nome) || '').trim();
    if (!v) return padrao;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new ErroPedido(400, `Parâmetro "${nome}" inválido: "${truncar(v, 20)}" (use um inteiro a partir de 1).`);
    return Math.min(n, maximo);
  };
  const sim = (nome) => ['1', 'true', 'sim'].includes((sp.get(nome) || '').trim().toLowerCase());
  // Busca: cada palavra precisa aparecer (em qualquer ordem), sem diferenciar maiúsculas e acentos.
  const termos = normalizarBusca(sp.get('q') || '').split(/\s+/).filter(Boolean).slice(0, 20);
  return {
    desde: dia('desde'), ate: dia('ate'), horas: inteiro('horas', null, 24 * 366),
    agente: conjunto('agente', false), projeto: conjunto('projeto', true), tipo: conjunto('tipo', false),
    resultado: conjunto('resultado', false), fluxo: (sp.get('fluxo') || '').trim() || null,
    q: termos.length ? termos : null, soDono: sim('so_dono'), incluirTestes: sim('incluir_testes'),
    pagina: inteiro('pagina', 1, 1e6), porPagina: inteiro('por_pagina', 50, 500),
  };
}

/**
 * Eventos filtrados e paginados, com as contagens do conjunto filtrado inteiro (sem paginação).
 * horas=N: só as últimas N horas (além de desde/ate). Agente, projeto, tipo e resultado aceitam vários
 * valores separados por vírgula. Nas contagens, cada faceta ignora o próprio filtro (os chips mostram o
 * que dá para escolher) e precisa_dono ignora o so_dono (é quanto o "só o que precisa de mim" mostraria).
 */
async function listarEventos(ctx, sp) {
  const f = lerFiltros(sp);
  const { lista } = await ctx.dados.eventos('todos');
  const desdeT = f.horas ? ctx.agora().getTime() - f.horas * 3600000 : null;
  const grupos = { resultado: new Map(), agente: new Map(), projeto: new Map(), tipo: new Map() };
  const somar = (grupo, chave) => { if (typeof chave === 'string' && chave) grupo.set(chave, (grupo.get(chave) || 0) + 1); };
  let precisaDono = 0;
  const filtrados = [];
  for (const e of lista) {
    if (!f.incluirTestes && e.teste === true) continue;
    if (f.desde && (!e._dia || e._dia < f.desde)) continue;
    if (f.ate && (!e._dia || e._dia > f.ate)) continue;
    if (desdeT !== null && !(e._t >= desdeT)) continue;
    if (f.fluxo && e.fluxo_id !== f.fluxo) continue;
    if (f.q) {
      const texto = textoBusca(e);
      if (!f.q.every((termo) => texto.includes(termo))) continue;
    }
    const projeto = String(e.projeto === undefined || e.projeto === null ? '' : e.projeto);
    const precisa = e.precisa_dono === true || RESULTADOS_DONO.has(e.resultado);
    const okAg = !f.agente || f.agente.has(e.agente);
    const okPr = !f.projeto || f.projeto.has(projeto.toLowerCase());
    const okTi = !f.tipo || f.tipo.has(e.tipo);
    const okRe = !f.resultado || f.resultado.has(e.resultado);
    const okJo = !f.soDono || precisa;
    if (okAg && okPr && okTi && okRe && okJo) filtrados.push(e);
    if (okPr && okTi && okRe && okJo) somar(grupos.agente, e.agente);
    if (okAg && okTi && okRe && okJo) somar(grupos.projeto, projeto.toUpperCase());
    if (okAg && okPr && okRe && okJo) somar(grupos.tipo, e.tipo);
    if (okAg && okPr && okTi && okJo) somar(grupos.resultado, e.resultado);
    if (okAg && okPr && okTi && okRe && precisa) precisaDono++;
  }
  const inicio = (f.pagina - 1) * f.porPagina;
  return {
    total: filtrados.length,
    pagina: f.pagina,
    por_pagina: f.porPagina,
    paginas: Math.max(1, Math.ceil(filtrados.length / f.porPagina)),
    eventos: filtrados.slice(inicio, inicio + f.porPagina).map(camposTabela),
    // Object.fromEntries cria propriedades próprias: uma chave "__proto__" vinda do log não mexe no protótipo.
    contagens: {
      resultado: Object.fromEntries(grupos.resultado), agente: Object.fromEntries(grupos.agente),
      projeto: Object.fromEntries(grupos.projeto), tipo: Object.fromEntries(grupos.tipo), precisa_dono: precisaDono,
    },
  };
}

// ---------- comandos brutos correlacionados (§10.4) ----------

/** Dias do log bruto que podem ter comandos do fluxo: do dia do id (ou 1º evento) − 1 ao último + 1. */
function diasDoFluxo(fluxoId, eventosDoFluxo, hoje) {
  const m = /^F-(\d{4})(\d{2})(\d{2})-/.exec(fluxoId);
  let ini = m && diaValido(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  let fim = null;
  for (const e of eventosDoFluxo) {
    if (!e._dia) continue;
    if (!ini || e._dia < ini) ini = e._dia;
    if (!fim || e._dia > fim) fim = e._dia;
  }
  if (!ini) return [];
  const ultimo = eventosDoFluxo[eventosDoFluxo.length - 1];
  // Fluxo ainda aberto (ou sem eventos): os comandos podem continuar até hoje.
  fim = !fim || (ultimo && RESULTADOS_ABERTOS.has(ultimo.resultado)) ? hoje : somarDias(fim, 1);
  if (fim > hoje) fim = hoje;
  ini = somarDias(ini, -1);
  if (fim < ini) fim = ini;
  // Fluxo longo: ficam a véspera e o 1º dia (pedido inicial) e os dias mais recentes; o meio sai.
  const total = Math.round((Date.parse(`${fim}T12:00:00Z`) - Date.parse(`${ini}T12:00:00Z`)) / DIA_MS) + 1;
  let dias;
  if (total <= LIMITE_DIAS_FLUXO) {
    dias = enumerarDias(ini, fim, LIMITE_DIAS_FLUXO);
  } else {
    const segundo = somarDias(ini, 1);
    const recentes = [];
    for (let d = fim; recentes.length < LIMITE_DIAS_FLUXO - 2 && d > segundo; d = somarDias(d, -1)) recentes.push(d);
    dias = [ini, segundo, ...recentes.reverse()];
  }
  Object.defineProperty(dias, 'cortados', { value: Math.max(0, total - dias.length) });
  return dias;
}

/**
 * Janela §10.4 de um evento para os comandos sem fluxo_id: do evento anterior do mesmo agente (e da
 * mesma sessão, quando o evento tem sessao) até o evento. Sem anterior, desde o início do fluxo (se
 * for antes) ou 15 min antes, como o "registrar fluxo". Nunca mais que 6 h.
 */
function janelaDoEvento(ev, asc, inicioFluxo, posicao) {
  const pasta = pastaDoAgente(ev.agente);
  if (!pasta || !(ev._t > 0)) return null;
  const sessao = typeof ev.sessao === 'string' && ev.sessao ? ev.sessao : null;
  let anterior = null;
  const daqui = posicao && posicao.has(ev) ? posicao.get(ev) : asc.indexOf(ev);
  for (let i = daqui - 1; i >= 0; i--) {
    const e = asc[i];
    if (e.agente !== ev.agente || e._t >= ev._t) continue;
    if (e.teste === true && ev.teste !== true) continue;
    if (sessao && e.sessao !== sessao) continue;
    anterior = e;
    break;
  }
  let inicio;
  if (anterior) inicio = anterior._t;
  else if (Number.isFinite(inicioFluxo) && inicioFluxo < ev._t) inicio = inicioFluxo;
  else inicio = ev._t - JANELA_SEM_ANTERIOR_MS;
  return { pasta, inicio: Math.max(inicio, ev._t - JANELA_MAX_MS), fim: ev._t, sessao };
}

/** Início do fluxo: o mais cedo entre o criado_em do contador e o primeiro evento. */
function inicioDoFluxo(info, eventosDoFluxo) {
  const candidatos = [info && Date.parse(info.criado_em), eventosDoFluxo.length ? eventosDoFluxo[0]._t : NaN].filter((x) => Number.isFinite(x) && x > 0);
  return candidatos.length ? Math.min(...candidatos) : NaN;
}

/**
 * Janela onde procurar o prompt que trouxe o pedido de um evento "pedido-recebido": do evento
 * anterior do mesmo agente (e da mesma sessão, quando o evento tem sessao) até o próprio evento; sem
 * anterior, as 6 h antes dele. Não usa o início do fluxo: o id nasce DEPOIS do pedido do dono.
 */
function janelaDoPedido(ev, asc) {
  const pasta = pastaDoAgente(ev.agente);
  if (!pasta || !(ev._t > 0)) return null;
  const sessao = typeof ev.sessao === 'string' && ev.sessao ? ev.sessao : null;
  let inicio = ev._t - JANELA_MAX_MS;
  for (let i = asc.indexOf(ev) - 1; i >= 0; i--) {
    const e = asc[i];
    if (e.agente !== ev.agente || e._t >= ev._t) continue;
    if (e.teste === true && ev.teste !== true) continue;
    if (sessao && e.sessao !== sessao) continue;
    inicio = Math.max(inicio, e._t);
    break;
  }
  // 1 min de folga depois do evento: o hook do prompt é assíncrono e pode gravar um pouco depois.
  return { pasta, inicio, fim: ev._t, sessao, folga: MIN_MS };
}

/**
 * Comandos brutos de um fluxo (§10.4): os com o mesmo fluxo_id (ou prompts que citam o id), de todas
 * as pastas de agente, nos dias do fluxo; e os sem fluxo_id que caem na janela de algum dos eventos
 * (mesmo agente e mesma sessão). Cada um volta com correlacao "fluxo_id" ou "janela" (os mesmos
 * rótulos do "registrar fluxo"). Lê pelo índice do log bruto, com teto de bytes novos por requisição:
 * os arquivos que não couberem ficam para a próxima vez e a resposta sai marcada como incompleta.
 */
async function coletarBrutos(ctx, { fluxoId, dias = [], janelas = [], janelaPedido = null, referencia }) {
  const dados = ctx.dados;
  const orcamento = { restante: BRUTO_BYTES_POR_PEDIDO, lidos: 0 };
  // Ordem de leitura (importa quando o teto é atingido): janelas, pedido, 1º dia do fluxo e o resto
  // pela proximidade do dia de referência.
  const tarefas = [];
  const vistos = new Set();
  const somar = (pasta, dia) => {
    const k = `${pasta}|${dia}`;
    if (!vistos.has(k)) {
      vistos.add(k);
      tarefas.push({ pasta, dia });
    }
  };
  for (const j of [...janelas, janelaPedido].filter(Boolean)) {
    for (const d of enumerarDias(diaSP(j.inicio), diaSP(j.fim + (j.folga || 0)), 3)) somar(j.pasta, d);
  }
  if (fluxoId && dias.length) {
    const pastas = await dados.pastasBruto();
    const refDia = Number.isFinite(referencia) && referencia > 0 ? diaSP(referencia) : dias[dias.length - 1];
    const dist = (d) => Math.abs(Date.parse(`${d}T12:00:00Z`) - Date.parse(`${refDia}T12:00:00Z`));
    const ordem = [...dias.slice(0, 2), ...dias.slice(2).sort((a, b) => dist(a) - dist(b) || (a < b ? 1 : -1))];
    for (const d of ordem) for (const p of pastas) somar(p, d);
  }

  const achados = new Map(); // ent → Map(i → correlacao)
  const marcar = (ent, i, correlacao) => {
    if (!achados.has(ent)) achados.set(ent, new Map());
    const m = achados.get(ent);
    if (m.get(i) !== 'fluxo_id') m.set(i, correlacao);
  };
  const prompts = [];
  let pedidoJanela = null;
  let pendentes = 0;
  for (const { pasta, dia } of tarefas) {
    const ents = await dados.indicesBruto(pasta, dia, orcamento);
    const daPasta = janelas.filter((j) => j.pasta === pasta);
    for (const ent of ents) {
      if (ent.pendente) {
        pendentes++;
        continue;
      }
      const col = ent.col;
      if (fluxoId) {
        const proprios = ent.porFluxo.get(fluxoId) || [];
        const citam = new Set(ent.citados.get(fluxoId) || []);
        for (const i of proprios) marcar(ent, i, 'fluxo_id');
        for (const i of citam) marcar(ent, i, 'fluxo_id');
        for (const i of new Set([...proprios, ...citam])) {
          if (col.marca[i] & MARCA_PROMPT) prompts.push({ ent, i, pasta, traz: citam.has(i) });
        }
      }
      for (const j of daPasta) {
        const ses = j.sessao ? ent.idSessao.get(j.sessao) : null;
        if (ses === undefined) continue;
        for (let i = 0; i < col.n; i++) {
          if (col.marca[i] & MARCA_FLUXO) continue;
          const t = col.t[i];
          if (t > j.inicio && t <= j.fim && (ses === null || col.ses[i] === ses)) marcar(ent, i, 'janela');
        }
      }
      if (janelaPedido && janelaPedido.pasta === pasta) {
        const j = janelaPedido;
        const ses = j.sessao ? ent.idSessao.get(j.sessao) : null;
        if (ses !== undefined) {
          const doFluxo = new Set(fluxoId ? ent.porFluxo.get(fluxoId) || [] : []);
          for (let i = 0; i < col.n; i++) {
            if (!(col.marca[i] & MARCA_PROMPT)) continue;
            const t = col.t[i];
            if (!(t > j.inicio && t <= j.fim + j.folga) || (ses !== null && col.ses[i] !== ses)) continue;
            // Prefere o prompt sem fluxo_id (ou do próprio fluxo) mais próximo antes do evento.
            const limpo = !(col.marca[i] & MARCA_FLUXO) || doFluxo.has(i);
            const antes = t <= j.fim;
            const nota = (limpo ? 2 : 0) + (antes ? 1 : 0);
            const melhor = !pedidoJanela || nota > pedidoJanela.nota
              || (nota === pedidoJanela.nota && (antes ? t > pedidoJanela.t : t < pedidoJanela.t));
            if (melhor) pedidoJanela = { ent, i, pasta, t, nota };
          }
        }
      }
    }
  }

  let lista = [];
  for (const [ent, m] of achados) for (const [i, correlacao] of m) lista.push({ ent, i, correlacao, t: ent.col.t[i], seq: ent.col.seq[i] });
  lista.sort((a, b) => a.t - b.t || a.seq - b.seq);
  let omitidos = 0;
  if (lista.length > LIMITE_COMANDOS) {
    omitidos = lista.length - LIMITE_COMANDOS;
    const ref = Number.isFinite(referencia) && referencia > 0 ? referencia : lista[lista.length - 1].t;
    lista = lista.slice().sort((a, b) => Math.abs(a.t - ref) - Math.abs(b.t - ref)).slice(0, LIMITE_COMANDOS)
      .sort((a, b) => a.t - b.t || a.seq - b.seq);
  }
  // Pedido inicial pelo fluxo: o primeiro prompt que trouxe o id no texto; senão, o primeiro do fluxo.
  prompts.sort((a, b) => a.ent.col.t[a.i] - b.ent.col.t[b.i] || a.ent.col.seq[a.i] - b.ent.col.seq[b.i]);
  const pedidoFluxo = prompts.find((p) => p.traz) || prompts[0] || null;

  // Relê do disco só as linhas escolhidas.
  const pedir = new Map();
  const quero = (ent, i) => {
    if (!pedir.has(ent)) pedir.set(ent, new Set());
    pedir.get(ent).add(i);
  };
  for (const x of lista) quero(x.ent, x.i);
  for (const p of [pedidoFluxo, pedidoJanela]) if (p) quero(p.ent, p.i);
  const lidas = new Map();
  for (const [ent, conj] of pedir) lidas.set(ent, await dados.indiceBruto.materializar(ent, [...conj]));
  const linha = (ent, i) => (lidas.get(ent) && lidas.get(ent).get(i)) || null;
  const comoPedido = (p) => {
    const l = p && linha(p.ent, p.i);
    return l && typeof l.prompt === 'string' ? { l, pasta: p.pasta, traz: !!p.traz } : null;
  };

  const comandos = [];
  for (const x of lista) {
    const l = linha(x.ent, x.i);
    if (l) comandos.push(formatarComando(l, path.basename(path.dirname(x.ent.caminho)), x.correlacao));
  }
  const avisos = [];
  if (dias.cortados) avisos.push(`fluxo com ${dias.length + dias.cortados} dias: o log bruto de ${dias.cortados} dia(s) do meio ficou de fora`);
  if (pendentes) avisos.push(`${pendentes} arquivo(s) do log bruto ainda não foram lidos (teto de leitura por consulta); abra de novo em instantes para completar`);
  return {
    comandos,
    truncados: omitidos > 0 || avisos.length > 0,
    omitidos,
    aviso: avisos.length ? `${avisos.join('; ')}.` : null,
    pedido: comoPedido(pedidoFluxo),
    pedidoJanela: comoPedido(pedidoJanela),
  };
}

/**
 * Pedido que abriu o fluxo (§11.5 item 2). Com evento "pedido-recebido": o texto do prompt bruto que
 * o trouxe (último UserPromptSubmit do mesmo agente na janela antes do evento), com a origem do
 * evento; sem o prompt, o campo pedido/texto do evento ou o resumo. Sem esse evento: o prompt bruto
 * que trouxe o id do fluxo (ou o primeiro prompt do fluxo).
 */
function pedidoInicial(eventosDoFluxo, brutos, porNome) {
  const ev = eventosDoFluxo.find((e) => e.tipo === 'pedido-recebido');
  if (ev) {
    const base = { origem: ev.origem || null, agente: ev.agente || null, evento_id: ev.id || null };
    const doEvento = [ev.pedido, ev.texto].find((x) => typeof x === 'string' && x.trim());
    const pb = brutos && brutos.pedidoJanela;
    if (!doEvento && pb && pb.l.prompt.trim()) {
      return Object.assign(base, { texto: truncar(pb.l.prompt, 4000), ts: pb.l.ts || ev.ts || null, fonte: 'prompt-do-evento', sessao: pb.l.sessao || null });
    }
    return Object.assign(base, { texto: doEvento || (typeof ev.resumo === 'string' ? ev.resumo : ''), ts: ev.ts || null, fonte: 'evento' });
  }
  const pedidoBruto = brutos && brutos.pedido;
  if (pedidoBruto) {
    const l = pedidoBruto.l;
    return {
      texto: truncar(l.prompt, 4000), origem: origemDoPrompt(l.prompt, porNome), ts: l.ts || null,
      agente: typeof l.agente === 'string' && l.agente ? l.agente : agenteDaPasta(pedidoBruto.pasta),
      fonte: 'prompt', origem_inferida: true,
    };
  }
  return null;
}

async function mapaDeNomes(ctx) {
  const reg = await ctx.dados.json(ctx.dados.p.agentes);
  const lista = arr(obj(reg.dados) && reg.dados.agentes).filter((a) => obj(a) && typeof a.slug === 'string');
  return new Map(lista.map((a) => [normalizarBusca(a.nome || a.slug), a.slug]));
}

// ---------- GET /api/evento/<id> e /api/fluxo/<id> ----------

async function detalharEvento(ctx, id) {
  const { lista } = await ctx.dados.eventos('todos');
  const ev = lista.find((e) => e.id === id);
  if (!ev) return null;
  const asc = ctx.dados.crescente(lista);
  // Eventos de teste só entram na sequência quando o próprio evento é de teste.
  const doFluxo = ev.fluxo_id ? asc.filter((e) => e.fluxo_id === ev.fluxo_id && (ev.teste === true || e.teste !== true)) : [ev];
  const hoje = diaSP(ctx.agora());
  const cont = await ctx.dados.json(ctx.dados.p.contador);
  const fluxo = ev.fluxo_id ? infoFluxo(cont.dados, ev.fluxo_id, doFluxo) : null;
  // Janela §10.4 do evento (comandos sem fluxo_id do mesmo agente e sessão antes dele).
  const janela = janelaDoEvento(ev, asc, inicioDoFluxo(fluxo, doFluxo));
  const dias = ev.fluxo_id ? diasDoFluxo(ev.fluxo_id, doFluxo, hoje) : [];
  const evPedido = doFluxo.find((e) => e.tipo === 'pedido-recebido');
  const brutos = await coletarBrutos(ctx, {
    fluxoId: ev.fluxo_id || null, dias, janelas: janela ? [janela] : [],
    janelaPedido: evPedido ? janelaDoPedido(evPedido, asc) : null, referencia: ev._t,
  });
  const porNome = await mapaDeNomes(ctx);
  return Object.assign({
    evento: ev,
    fluxo,
    pedido_inicial: pedidoInicial(doFluxo, brutos, porNome),
    sequencia: doFluxo,
    comandos_brutos: brutos.comandos,
    comandos_truncados: brutos.truncados,
    comandos_omitidos: brutos.omitidos,
    comandos_aviso: brutos.aviso,
    janela_sem_fluxo: janela ? { inicio: isoSP(janela.inicio), fim: isoSP(janela.fim), sessao: janela.sessao } : null,
  }, vizinhos(asc, ev));
}

async function detalharFluxo(ctx, id, sp) {
  const { lista } = await ctx.dados.eventos('todos');
  const asc = ctx.dados.crescente(lista);
  const todos = asc.filter((e) => e.fluxo_id === id);
  const reais = todos.filter((e) => e.teste !== true);
  // Testes ficam fora, a não ser com incluir_testes=1 ou quando o fluxo só tem eventos de teste.
  const incluirTestes = sp && ['1', 'true', 'sim'].includes(String(sp.get('incluir_testes') || '').toLowerCase());
  const eventos = incluirTestes || !reais.length ? todos : reais;
  const cont = await ctx.dados.json(ctx.dados.p.contador);
  const fluxo = infoFluxo(cont.dados, id, eventos);
  if (!fluxo) return null;
  const hoje = diaSP(ctx.agora());
  // Como o "registrar fluxo": comandos com o fluxo_id e, sem ele, os da janela de cada evento.
  const inicio = inicioDoFluxo(fluxo, eventos);
  const posicao = eventos.length > 5 ? new Map(asc.map((e, i) => [e, i])) : null;
  const janelas = eventos.map((e) => janelaDoEvento(e, asc, inicio, posicao)).filter(Boolean);
  const evPedido = eventos.find((e) => e.tipo === 'pedido-recebido');
  const brutos = await coletarBrutos(ctx, {
    fluxoId: id, dias: diasDoFluxo(id, eventos, hoje), janelas,
    janelaPedido: evPedido ? janelaDoPedido(evPedido, asc) : null, referencia: null,
  });
  const porNome = await mapaDeNomes(ctx);
  return {
    fluxo,
    eventos,
    comandos_brutos: brutos.comandos,
    comandos_truncados: brutos.truncados,
    comandos_omitidos: brutos.omitidos,
    comandos_aviso: brutos.aviso,
    pedido_inicial: pedidoInicial(eventos, brutos, porNome),
  };
}

// ---------- HTTP ----------

function responder(req, res, status, corpo, tipo, extras = {}) {
  let buf = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), 'utf8');
  const cab = Object.assign({
    'Content-Type': tipo,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Nada do painel pode ser embutido em iframe de outro site (clickjacking no Recalcular etc.).
    'X-Frame-Options': 'DENY',
  }, extras);
  if (buf.length > 4096 && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
    buf = zlib.gzipSync(buf);
    cab['Content-Encoding'] = 'gzip';
    cab.Vary = 'Accept-Encoding';
  }
  cab['Content-Length'] = buf.length;
  res.writeHead(status, cab);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function responderJson(req, res, status, objeto, extras) {
  responder(req, res, status, JSON.stringify(objeto), JSON_TIPO, extras);
}

function escaparHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ROTAS_FIXAS = {
  '/': { nome: 'index', metodos: ['GET', 'HEAD'] },
  '/api/estado': { nome: 'estado', metodos: ['GET', 'HEAD'] },
  '/api/eventos': { nome: 'eventos', metodos: ['GET', 'HEAD'] },
  '/api/recalcular': { nome: 'recalcular', metodos: ['POST'] },
  '/api/cerebro': { nome: 'cerebro', metodos: ['POST'] },
  '/prospeccao': { nome: 'prospeccao', metodos: ['GET', 'HEAD'] },
  '/prospeccao/antiga': { nome: 'prospeccao-antiga', metodos: ['GET', 'HEAD'] },
  '/api/prospeccao/estado': { nome: 'prospeccao-estado', metodos: ['GET', 'HEAD'] },
  '/api/prospeccao/assumir': { nome: 'prospeccao-assumir', metodos: ['POST'] },
  '/api/prospeccao/devolver': { nome: 'prospeccao-devolver', metodos: ['POST'] },
};

function acharRota(caminho) {
  if (Object.prototype.hasOwnProperty.call(ROTAS_FIXAS, caminho)) return ROTAS_FIXAS[caminho];
  const mp = /^\/api\/pendencias\/([^/]+)\/responder$/.exec(caminho);
  if (mp) {
    const idPend = pendenciasApi.normalizarId(mp[1]);
    return idPend ? { nome: 'pendencia-responder', metodos: ['POST'], id: idPend } : null;
  }
  const ml = /^\/api\/prospeccao\/lead\/([^/]+)$/.exec(caminho);
  if (ml) {
    let idLead;
    try {
      idLead = decodeURIComponent(ml[1]);
    } catch (_) {
      return null;
    }
    return prospeccao.idValido(idLead) ? { nome: 'prospeccao-lead', metodos: ['GET', 'HEAD'], id: idLead } : null;
  }
  const m = /^\/api\/(evento|fluxo)\/([^/]+)$/.exec(caminho);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch (_) {
    return null;
  }
  return RE_ID.test(id) ? { nome: m[1], metodos: ['GET', 'HEAD'], id } : null;
}

async function rotear(ctx, req, res) {
  // Só assumir/devolver leem o corpo (até 16 KB); o resto é descartado, com teto de 1 MB.
  let recebidos = 0;
  const partes = [];
  const corpo = new Promise((resolve) => {
    req.on('data', (c) => {
      recebidos += c.length;
      if (recebidos > 1024 * 1024) req.destroy();
      else if (recebidos <= LIMITE_CORPO) partes.push(c);
    });
    req.on('end', () => resolve(recebidos > LIMITE_CORPO ? null : Buffer.concat(partes)));
    req.on('close', () => resolve(null));
  });
  req.on('error', () => {});

  const host = String(req.headers.host || '').toLowerCase();
  if (!ctx.hostsPermitidos.has(host)) {
    return responderJson(req, res, 403, { erro: `Host não permitido. Abra o painel em http://127.0.0.1:${ctx.porta}.` });
  }
  if (req.method === 'POST') {
    if (req.headers['x-painel'] !== '1') return responderJson(req, res, 403, { erro: 'POST exige o cabeçalho X-Painel: 1.' });
    const origem = req.headers.origin;
    if (origem !== undefined && !ctx.origensPermitidas.has(String(origem).toLowerCase())) {
      return responderJson(req, res, 403, { erro: 'Origem não permitida.' });
    }
  }
  const url = String(req.url || '');
  if (!url.startsWith('/') || url.startsWith('//')) return responderJson(req, res, 404, { erro: 'Rota não encontrada.' });
  const q = url.indexOf('?');
  const caminho = q < 0 ? url : url.slice(0, q);
  const consulta = new URLSearchParams(q < 0 ? '' : url.slice(q + 1));
  const rota = acharRota(caminho);
  if (!rota) return responderJson(req, res, 404, { erro: 'Rota não encontrada.' });
  if (!rota.metodos.includes(req.method)) {
    return responderJson(req, res, 405, { erro: `Método ${req.method} não aceito aqui (use ${rota.metodos.join(' ou ')}).` }, { Allow: rota.metodos.join(', ') });
  }

  switch (rota.nome) {
    case 'index': {
      const r = await ctx.dados.texto(ctx.cfg.indexPath);
      if (!r.existe || typeof r.texto !== 'string') {
        const html = `<!doctype html><meta charset="utf-8"><title>Painel</title><p>O arquivo do painel não foi encontrado em ${escaparHtml(ctx.cfg.indexPath.replace(/\\/g, '/'))}.</p>`;
        return responder(req, res, 503, html, HTML_TIPO, { 'Content-Security-Policy': CSP });
      }
      return responder(req, res, 200, r.texto, HTML_TIPO, { 'Content-Security-Policy': CSP });
    }
    case 'estado':
      return responderJson(req, res, 200, await montarEstado(ctx));
    case 'eventos':
      return responderJson(req, res, 200, await listarEventos(ctx, consulta));
    case 'evento': {
      const r = await detalharEvento(ctx, rota.id);
      if (!r) return responderJson(req, res, 404, { erro: `Evento não encontrado: ${rota.id}` });
      return responderJson(req, res, 200, r);
    }
    case 'fluxo': {
      const r = await detalharFluxo(ctx, rota.id, consulta);
      if (!r) return responderJson(req, res, 404, { erro: `Fluxo não encontrado: ${rota.id}` });
      return responderJson(req, res, 200, r);
    }
    case 'recalcular': {
      const r = await ctx.executarColetor('recalcular');
      const estado = await montarEstado(ctx);
      estado.recalculo = { ok: !!(r && r.ok), duracao_ms: r ? r.duracao_ms : null, erro: r && !r.ok ? r.erro : null };
      return responderJson(req, res, 200, estado);
    }
    case 'cerebro':
      return responderJson(req, res, 501, { erro: 'Fase B: exige o Maestri Wire (ver §11.7)' });
    case 'pendencia-responder': {
      const buf = await corpo;
      if (buf === null) return responderJson(req, res, 413, { erro: `Corpo grande demais ou incompleto (até ${LIMITE_CORPO / 1024} KB).` });
      const r = await pendenciasApi.responderPendencia(ctx.cfg, ctx.agora(), rota.id, buf);
      ctx.log(`Pendência ${rota.id} respondida pelo painel; aviso ao Cérebro: ${r.aviso_cerebro.enviado ? `enviado (${r.aviso_cerebro.para})` : `não enviado (${r.aviso_cerebro.motivo})`}`);
      return responderJson(req, res, 200, r);
    }
    case 'prospeccao': {
      // A Prospecção virou tela do app (menu Operações): o portal "Prospecção · Painel" cai nela.
      const html = '<!doctype html><meta charset="utf-8"><title>Prospecção</title><p><a href="/#prospeccao">A Prospecção agora é uma tela do painel.</a></p>';
      return responder(req, res, 302, html, HTML_TIPO, { Location: '/#prospeccao', 'Content-Security-Policy': CSP });
    }
    case 'prospeccao-antiga': {
      const r = await ctx.dados.texto(ctx.cfg.prospeccaoPath);
      if (!r.existe || typeof r.texto !== 'string') {
        const html = `<!doctype html><meta charset="utf-8"><title>Prospecção</title><p>O arquivo do dashboard não foi encontrado em ${escaparHtml(ctx.cfg.prospeccaoPath.replace(/\\/g, '/'))}.</p>`;
        return responder(req, res, 503, html, HTML_TIPO, { 'Content-Security-Policy': CSP_PROSPECCAO });
      }
      return responder(req, res, 200, r.texto, HTML_TIPO, { 'Content-Security-Policy': CSP_PROSPECCAO });
    }
    case 'prospeccao-estado':
      return responderJson(req, res, 200, prospeccao.montarEstado(ctx.cfg, ctx.agora()));
    case 'prospeccao-lead': {
      const r = prospeccao.detalharLead(ctx.cfg, ctx.agora(), rota.id);
      if (!r) return responderJson(req, res, 404, { erro: `Lead não encontrado: ${rota.id}` });
      return responderJson(req, res, 200, r);
    }
    case 'prospeccao-assumir':
    case 'prospeccao-devolver': {
      const buf = await corpo;
      if (buf === null) return responderJson(req, res, 413, { erro: `Corpo grande demais ou incompleto (até ${LIMITE_CORPO / 1024} KB).` });
      const acao = rota.nome === 'prospeccao-assumir' ? 'assumir' : 'devolver';
      return responderJson(req, res, 200, await prospeccao.alterarLead(ctx.cfg, ctx.agora(), acao, buf));
    }
    default:
      return responderJson(req, res, 404, { erro: 'Rota não encontrada.' });
  }
}

function criarManipulador(ctx) {
  return (req, res) => {
    rotear(ctx, req, res).catch((e) => {
      const status = e instanceof ErroPedido || e instanceof prospeccao.ErroProspeccao || e instanceof pendenciasApi.ErroPendencia ? e.status : 500;
      if (status === 500) ctx.erro(`Erro em ${req.method} ${String(req.url).slice(0, 200)}: ${e && e.stack ? e.stack : e}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      responderJson(req, res, status, { erro: status === 500 ? 'Erro interno do painel (detalhes no terminal do servidor).' : e.message });
    });
  };
}

// ---------- ciclo de vida ----------

function lerPidSync(arquivo) {
  try {
    return Number(fs.readFileSync(arquivo, 'utf8').trim());
  } catch (_) {
    return null;
  }
}

function removerPidSync(arquivo) {
  try {
    if (lerPidSync(arquivo) === process.pid) fs.unlinkSync(arquivo);
  } catch (_) { /* já saiu */ }
}

/**
 * Sobe o servidor. opcoes: {cfg} ou {argv, env}. Devolve {servidor, porta, ctx, parar}.
 * Não registra sinais nem encerra o processo (isso fica com a linha de comando).
 */
async function iniciar(opcoes = {}) {
  const cfg = opcoes.cfg || lerConfig(opcoes.argv || [], opcoes.env || process.env);
  const ctx = criarContexto(cfg);
  const servidor = http.createServer({ headersTimeout: 10000, requestTimeout: 30000 }, criarManipulador(ctx));
  servidor.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(cfg.porta, '127.0.0.1', () => {
      servidor.off('error', reject);
      resolve();
    });
  });
  servidor.on('error', (e) => ctx.erro(`Erro no servidor: ${e && e.message}`));
  ctx.definirPorta(servidor.address().port);
  const arquivoPid = ctx.dados.p.pid;
  await gravarAtomico(arquivoPid, `${process.pid}\n`);
  let timer = null;
  if (cfg.coletorAtivo) {
    ctx.executarColetor('inicio');
    timer = setInterval(() => ctx.executarColetor('periodico'), COLETOR_INTERVALO_MS);
  }
  let parado = false;
  async function parar() {
    if (parado) return;
    parado = true;
    if (timer) clearInterval(timer);
    removerPidSync(arquivoPid);
    await new Promise((resolve) => {
      servidor.close(() => resolve());
      if (typeof servidor.closeAllConnections === 'function') servidor.closeAllConnections();
    });
    if (ctx.coletaAtual) await ctx.coletaAtual.catch(() => {});
  }
  return { servidor, porta: ctx.porta, ctx, parar, arquivoPid };
}

const AJUDA = `Uso: node servidor.js [--porta 4777]
  Sobe o painel do workspace em http://127.0.0.1:<porta> (só nesta máquina).
  Parar: Ctrl+C neste terminal, ou taskkill /PID <pid de estado/painel.pid> /F
Variáveis: PAINEL_PORTA, MAESTRO_DIR, MAESTRI_DATA_DIR, CLAUDE_CONFIG_DIR,
  PAINEL_TRELLO_INTERVALO_MIN (60), PAINEL_TRELLO_JANELA (0-24), PAINEL_COLETOR=0 (sem coletor automático).
`;

module.exports = {
  iniciar, lerConfig, calcularSaude, minutosUteis, duracaoTexto, montarEstado, listarEventos,
  detalharEvento, detalharFluxo, acharRota, pastaDoAgente, origemDoPrompt, diasDoFluxo, LeitorJsonl, Dados,
  IndiceBruto, janelaDoPedido, pedidoInicial, limparTrello, limparUso, CSP, CSP_PROSPECCAO,
};

if (require.main === module) {
  let cfg;
  try {
    cfg = lerConfig(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`Erro: ${e.message}\n`);
    process.exit(2);
  }
  if (cfg.ajuda) {
    process.stdout.write(AJUDA);
    process.exit(0);
  }
  process.on('unhandledRejection', (e) => {
    try { process.stderr.write(`Erro não tratado: ${e && e.stack ? e.stack : e}\n`); } catch (_) { /* nada */ }
  });
  iniciar({ cfg }).then(({ porta, parar, arquivoPid }) => {
    process.stdout.write(`Painel no ar em http://127.0.0.1:${porta} (PID ${process.pid})\n`);
    process.stdout.write(`Dados: ${cfg.maestroDir.replace(/\\/g, '/')} · PID em ${arquivoPid.replace(/\\/g, '/')}\n`);
    process.stdout.write(`Para parar: Ctrl+C aqui, ou taskkill /PID ${process.pid} /F\n`);
    let saindo = false;
    const sair = (sinal) => {
      if (saindo) return;
      saindo = true;
      try { process.stdout.write(`Encerrando o painel (${sinal})...\n`); } catch (_) { /* terminal fechado */ }
      setTimeout(() => process.exit(0), 3000).unref();
      parar().finally(() => process.exit(0));
    };
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(s, () => sair(s));
    process.on('exit', () => removerPidSync(arquivoPid));
  }).catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
      process.stderr.write(`Erro: a porta ${cfg.porta} já está em uso em 127.0.0.1. Outro painel já está rodando? Veja o PID em ${path.join(cfg.maestroDir, 'estado', 'painel.pid').replace(/\\/g, '/')} ou suba em outra porta com --porta.\n`);
    } else if (e && e.code === 'EACCES') {
      process.stderr.write(`Erro: sem permissão para usar a porta ${cfg.porta}.\n`);
    } else {
      process.stderr.write(`Erro ao subir o painel: ${e && e.stack ? e.stack : e}\n`);
    }
    process.exit(1);
  });
}
