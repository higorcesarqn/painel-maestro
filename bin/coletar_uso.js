#!/usr/bin/env node
'use strict';
// coletar_uso.js · métricas de uso do Claude (plano do Maestri e tokens por agente)
//
// Duas medidas, sempre separadas e com a fonte indicada:
//  1. Plano (conta inteira): % da janela de 5 h e da semanal, horário de reset e idade do dado.
//     Fonte: <MAESTRI_DATA_DIR>/usage/providers/.status.json, o mesmo arquivo dos anéis do Maestri
//     Sem o arquivo, sem o provedor Claude ou sem as janelas, o plano fica
//     "indisponível" com o motivo; nenhum número é inventado.
//  2. Participação de cada agente: tokens das transcrições do Claude Code. Cada transcrição é
//     atribuída pelo arquivo estado/sessoes/<session_id>.json (agente + transcript_path, gravado pelo hook),
//     junto com os subagentes da pasta <session_id>/subagents ao lado (qualquer profundidade,
//     arquivos agent-<id>.jsonl). Sessão sem dono não entra. Cada message.id conta uma vez só,
//     com o uso da ÚLTIMA linha daquele id (nos subagentes a primeira linha traz uso parcial).
//
// consumo relativo  = entrada + 5 × saída + 1,25 × escrita de cache + 0,1 × leitura de cache
// % do consumo      = consumo relativo do agente ÷ soma de todos no período
// % estimado plano  = % do consumo × % do plano na janela correspondente
//                     (janela_5h → janela de 5 h; 7d → semanal; "hoje" não tem janela própria)
// Períodos: janela_5h (de reset_5h − 5 h até agora; sem reset válido, as últimas 5 h),
//           hoje (desde 00:00 em São Paulo) e 7d (últimos 7 dias).
//
// Leitura incremental: estado/uso-cache.json guarda, por transcrição, o offset já lido e o
// último uso de cada message.id. Cada rodada lê só os bytes novos; linha final incompleta fica
// para a próxima rodada; transcrição que ainda não existe é ignorada sem erro.
//
// Uso:  node coletar_uso.js [--json] [--sem-gravar] [--agora <ISO>]
//   --json        imprime o uso.json no stdout (sem a flag, imprime um resumo legível)
//   --sem-gravar  não grava estado/uso.json nem estado/uso-cache.json
//   --agora       fixa o "agora" (testes; também vale a variável MAESTRO_AGORA)
// Variáveis: MAESTRO_DIR (padrão: a pasta _maestro acima deste script), MAESTRI_DATA_DIR
//   (padrão ~/.maestri) e CLAUDE_CONFIG_DIR (padrão ~/.claude; só para sessão sem transcript_path).
// Saída: 0 ok (inclusive com o plano indisponível) · 2 uso inválido · 1 erro inesperado.
// Exporta coletar() para o servidor do painel (painel/servidor.js).

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FUSO = 'America/Sao_Paulo';
const MIN_MS = 60 * 1000;
const HORA_MS = 60 * MIN_MS;
const DIA_MS = 24 * HORA_MS;
const PESOS = Object.freeze({ entrada: 1, saida: 5, cache_escrita: 1.25, cache_leitura: 0.1 });
const NOTA = 'o % por agente é estimado; o % do plano vem do Maestri/Claude';
const FORMULA = 'consumo relativo = entrada + 5 × saída + 1,25 × escrita de cache + 0,1 × leitura de cache';
const FONTE = 'plano: provedor Claude do Maestri (usage/providers/.status.json) · por agente: transcrições do Claude Code (projects/*.jsonl), atribuídas pelas sessões em estado/sessoes';
const PERIODOS = ['janela_5h', 'hoje', '7d'];
const CACHE_VERSAO = 1;
const RETENCAO_MS = 8 * DIA_MS;      // mensagens mais velhas que isso saem do cache (o maior período é 7 d)
const BLOCO = 4 * 1024 * 1024;       // leitura incremental em blocos de 4 MB
const LIMITE_SUBAGENTES = 5000;      // arquivos por sessão (proteção contra pasta gigante)
const ESTADOS_COM_FALHA = new Set(['failed', 'fileError', 'executableNotFound', 'needsNewerMaestri']);
const REPETIVEIS = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

class ErroUso extends Error {}

// ---------- datas no fuso de São Paulo (Intl; nunca toISOString nos dados) ----------

const FMT_SP = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Date válida a partir de Date, número (ms) ou texto ISO; null se inválida. */
function comoData(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Partes da data no relógio de São Paulo (year, month, day, hour, minute, second). */
function partesSP(data) {
  const p = {};
  for (const x of FMT_SP.formatToParts(data)) p[x.type] = x.value;
  return p;
}

/** ISO 8601 com o deslocamento real de São Paulo (hoje -03:00); null se a data for inválida. */
function isoSP(valor) {
  const d = comoData(valor);
  if (!d) return null;
  const p = partesSP(d);
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const desloc = Math.round((comoUtc - Math.floor(d.getTime() / 1000) * 1000) / MIN_MS);
  const abs = Math.abs(desloc);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${desloc < 0 ? '-' : '+'}${hh}:${mm}`;
}

/** Dia local de São Paulo: AAAA-MM-DD. */
function diaSP(valor) {
  const d = comoData(valor);
  if (!d) return null;
  const p = partesSP(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Instante (ms) em que o relógio de São Paulo marca ano-mes-dia hora:minuto. */
function instanteSP(ano, mes, dia, hora = 0, minuto = 0) {
  const alvo = Date.UTC(ano, mes - 1, dia, hora, minuto);
  let t = alvo + 3 * HORA_MS; // palpite: -03:00
  for (let i = 0; i < 4; i++) {
    const p = partesSP(new Date(t));
    const visto = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    if (visto === alvo) break;
    t += alvo - visto;
  }
  return t;
}

/** Instante (ms) de 00:00 em São Paulo no dia da data. */
function inicioDoDiaSP(valor) {
  const p = partesSP(comoData(valor));
  return instanteSP(+p.year, +p.month, +p.day, 0, 0);
}

/** Interface: DD/MM/AAAA HH:MM. */
function dataHoraBR(valor) {
  const d = comoData(valor);
  if (!d) return '?';
  const p = partesSP(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** HH:MM se for o mesmo dia de referência; senão DD/MM HH:MM. */
function horaCurta(valor, referencia) {
  const d = comoData(valor);
  if (!d) return '?';
  const p = partesSP(d);
  const r = comoData(referencia);
  const mesmoDia = r && diaSP(r) === diaSP(d);
  return mesmoDia ? `${p.hour}:${p.minute}` : `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

// ---------- arquivos: leitura tolerante e gravação atômica ----------

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Repete a operação em EPERM/EBUSY/EACCES (antivírus, rename concorrente no Windows). */
async function comNovasTentativas(fn, tentativas = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!e || !REPETIVEIS.has(e.code) || i >= tentativas) throw e;
      await esperar(Math.min(20 * i * i, 500));
    }
  }
}

/** Texto do arquivo, ou null se ele não existir. */
async function lerTexto(caminho) {
  try {
    return await comNovasTentativas(() => fsp.readFile(caminho, 'utf8'));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

/** {existe, dados, erro}: nunca lança; JSON inválido é tentado de novo (escritor no meio da gravação). */
async function lerJson(caminho, { tentativas = 3 } = {}) {
  for (let i = 1; ; i++) {
    let texto;
    try {
      texto = await lerTexto(caminho);
    } catch (e) {
      return { existe: true, dados: null, erro: `não consegui ler (${e.code || e.message})` };
    }
    if (texto === null) return { existe: false, dados: null, erro: null };
    const limpo = texto.replace(/^﻿/, '').trim();
    let erro;
    if (!limpo) erro = 'arquivo vazio';
    else {
      try {
        return { existe: true, dados: JSON.parse(limpo), erro: null };
      } catch (e) {
        erro = `JSON inválido (${e.message})`;
      }
    }
    if (i >= tentativas) return { existe: true, dados: null, erro };
    await esperar(40 * i);
  }
}

/** Grava por temporário + rename, com novas tentativas (rename por cima de arquivo aberto dá EPERM). */
async function gravarAtomico(caminho, conteudo) {
  await fsp.mkdir(path.dirname(caminho), { recursive: true });
  const tmp = `${caminho}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, conteudo);
  try {
    await comNovasTentativas(() => fsp.rename(tmp, caminho), 12);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

// ---------- caminhos ----------

function caminhos(opcoes = {}) {
  const env = opcoes.env || process.env;
  const maestroDir = path.resolve(opcoes.maestroDir || env.MAESTRO_DIR || path.join(__dirname, '..'));
  const maestriDir = path.resolve(opcoes.maestriDataDir || env.MAESTRI_DATA_DIR || path.join(os.homedir(), '.maestri'));
  const claudeDir = path.resolve(opcoes.claudeDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  return {
    maestroDir, maestriDir, claudeDir,
    status: path.join(maestriDir, 'usage', 'providers', '.status.json'),
    agentes: path.join(maestroDir, 'registro', 'agentes.json'),
    sessoes: path.join(maestroDir, 'estado', 'sessoes'),
    uso: path.join(maestroDir, 'estado', 'uso.json'),
    cache: path.join(maestroDir, 'estado', 'uso-cache.json'),
  };
}

// No Windows o mesmo arquivo pode aparecer com maiúsculas diferentes.
function chaveArquivo(caminho) {
  const r = path.resolve(caminho);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

// ---------- medida 1: plano ----------

function numeroOuNull(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function acharJanela(janelas, id, duracao) {
  return janelas.find((w) => w && w.id === id) || janelas.find((w) => w && Number(w.durationSeconds) === duracao) || null;
}

function aplicarJanela(plano, qual, janela, t) {
  const c = qual === '5h'
    ? { pct: 'janela_5h_pct', reset: 'reset_5h', dur: 'janela_5h_duracao_s', motivo: 'janela_5h_motivo', nome: 'de 5 h' }
    : { pct: 'semanal_pct', reset: 'reset_semanal', dur: 'semanal_duracao_s', motivo: 'semanal_motivo', nome: 'semanal' };
  if (!janela) {
    plano[c.motivo] = `O Maestri não trouxe a janela ${c.nome}.`;
    return;
  }
  const pct = numeroOuNull(janela.usedPercent);
  const reset = comoData(janela.resetsAt);
  plano[c.dur] = numeroOuNull(janela.durationSeconds);
  plano[c.reset] = reset ? isoSP(reset) : null;
  if (pct === null) {
    plano[c.motivo] = `A janela ${c.nome} veio sem o percentual usado.`;
    return;
  }
  if (reset && reset.getTime() <= t) {
    // A janela já reiniciou depois da última leitura: o valor antigo enganaria.
    const quando = plano.atualizado_em ? ` (${horaCurta(plano.atualizado_em, t)})` : '';
    plano[c.motivo] = `A janela ${c.nome} reiniciou às ${horaCurta(reset, t)}, depois da última leitura do Maestri${quando}; o % novo aparece na próxima leitura.`;
    return;
  }
  plano[c.pct] = pct;
}

/** Lê o .status.json do Maestri e devolve o bloco "plano" do uso.json. */
async function lerPlano(arquivo, agora) {
  const t = agora.getTime();
  const plano = {
    disponivel: false, fonte: 'provedor Claude do Maestri', arquivo: arquivo.replace(/\\/g, '/'),
    janela_5h_pct: null, reset_5h: null, semanal_pct: null, reset_semanal: null,
    janela_5h_duracao_s: null, semanal_duracao_s: null, janela_5h_motivo: null, semanal_motivo: null,
    atualizado_em: null, idade_min: null, plano: null, estado: null, motivo: null, avisos: [],
  };
  const r = await lerJson(arquivo);
  if (!r.existe) {
    plano.motivo = `O Maestri ainda não gravou o uso do plano (${plano.arquivo} não existe). Ligue o uso dos agentes no Maestri (Configurações → Agentes → Uso) e deixe os anéis visíveis.`;
    return plano;
  }
  if (r.erro) {
    plano.motivo = `Não consegui ler ${plano.arquivo}: ${r.erro}.`;
    return plano;
  }
  const provedores = r.dados && Array.isArray(r.dados.providers) ? r.dados.providers : [];
  const p = provedores.find((x) => x && x.id === 'claude');
  if (!p) {
    plano.motivo = 'O arquivo de uso do Maestri não tem o provedor "claude".';
    return plano;
  }
  plano.estado = typeof p.state === 'string' ? p.state : null;
  plano.plano = typeof p.plan === 'string' ? p.plan : null;
  const quando = comoData(p.lastSuccessAt) || comoData(r.dados.updatedAt);
  if (quando) {
    plano.atualizado_em = isoSP(quando);
    plano.idade_min = Math.max(0, Math.round((t - quando.getTime()) / MIN_MS));
  }
  const erroProvedor = typeof p.error === 'string' && p.error.trim() ? p.error.trim() : null;
  if (p.enabled === false || p.state === 'off') {
    plano.motivo = 'O provedor Claude está desligado no Maestri (Configurações → Agentes → Uso).';
    return plano;
  }
  const medidores = Array.isArray(p.meters) ? p.meters : [];
  const medidor = medidores.find((m) => m && m.id === 'plan') || null;
  const janelas = medidor && Array.isArray(medidor.windows) ? medidor.windows : [];
  aplicarJanela(plano, '5h', acharJanela(janelas, 'five_hour', 18000), t);
  aplicarJanela(plano, '7d', acharJanela(janelas, 'seven_day', 604800), t);
  if (plano.janela_5h_pct === null && plano.semanal_pct === null) {
    if (!janelas.length) {
      plano.motivo = plano.estado && plano.estado !== 'ready'
        ? `O Maestri não conseguiu ler o uso do Claude (estado "${plano.estado}"${erroProvedor ? `: ${erroProvedor}` : ''}).`
        : 'O Maestri ainda não trouxe as janelas do plano (5 h e semanal).';
    } else {
      plano.motivo = [plano.janela_5h_motivo, plano.semanal_motivo].filter(Boolean).join(' ');
    }
    return plano;
  }
  plano.disponivel = true;
  if (plano.estado && ESTADOS_COM_FALHA.has(plano.estado)) {
    const de = plano.atualizado_em ? ` de ${horaCurta(plano.atualizado_em, t)}` : '';
    plano.avisos.push(`A última consulta do Maestri falhou (estado "${plano.estado}"${erroProvedor ? `: ${erroProvedor}` : ''}); os valores são da leitura${de}.`);
  }
  for (const m of [plano.janela_5h_motivo, plano.semanal_motivo]) if (m) plano.avisos.push(m);
  return plano;
}

// ---------- medida 2: transcrições por sessão ----------

const RE_ID_SESSAO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Sessões com dono: [{id, agente, transcricao}]. Conta as sem dono e as ilegíveis em diag. */
async function lerSessoes(dir, claudeDir, diag) {
  let nomes;
  try {
    nomes = await comNovasTentativas(() => fsp.readdir(dir));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
  const sessoes = [];
  for (const nome of nomes.sort()) {
    if (!/\.json$/i.test(nome)) continue; // ignora .tmp e .lock
    const r = await lerJson(path.join(dir, nome), { tentativas: 2 });
    const s = r.dados;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      if (r.existe) diag.sessoes_ilegiveis++;
      continue;
    }
    const agente = typeof s.agente === 'string' ? s.agente.trim() : '';
    if (!agente) {
      diag.sessoes_sem_dono++;
      continue;
    }
    const id = typeof s.session_id === 'string' && s.session_id ? s.session_id : nome.replace(/\.json$/i, '');
    let transcricao = typeof s.transcript_path === 'string' && s.transcript_path.trim() ? path.resolve(s.transcript_path.trim()) : null;
    if (!transcricao && typeof s.cwd === 'string' && s.cwd && RE_ID_SESSAO.test(id)) {
      // Mesma regra de pasta do Claude Code: cada caractere fora de [A-Za-z0-9] vira "-".
      transcricao = path.join(claudeDir, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
    }
    if (!transcricao) {
      diag.sessoes_sem_transcricao++;
      continue;
    }
    sessoes.push({ id, agente, transcricao });
  }
  return sessoes;
}

function pastaSubagentes(transcricao) {
  const base = path.basename(transcricao).replace(/\.jsonl$/i, '');
  return path.join(path.dirname(transcricao), base, 'subagents');
}

/** Arquivos agent-*.jsonl em qualquer profundidade (journal.jsonl e .meta.json ficam de fora). */
async function listarSubagentes(dir) {
  const achados = [];
  async function andar(d, nivel) {
    if (nivel > 8 || achados.length >= LIMITE_SUBAGENTES) return;
    let itens;
    try {
      itens = await fsp.readdir(d, { withFileTypes: true });
    } catch (_) {
      return; // pasta ainda não existe (sessão sem subagentes)
    }
    for (const it of itens) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) await andar(p, nivel + 1);
      else if (it.isFile() && /^agent-.+\.jsonl$/i.test(it.name)) achados.push(p);
    }
  }
  await andar(dir, 0);
  return achados.sort();
}

function inteiro(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Guarda o uso de uma linha "assistant": a última linha de cada message.id substitui as anteriores. */
function registrarObjeto(o, entrada, diag) {
  if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return;
  const u = o.message.usage;
  if (!u || typeof u !== 'object') return;
  const ts = Date.parse(o.timestamp);
  if (!Number.isFinite(ts)) return;
  const id = o.message.id ? String(o.message.id)
    : o.requestId ? `req:${o.requestId}`
      : o.uuid ? `uuid:${o.uuid}` : null;
  if (!id) return;
  entrada.msgs[id] = [ts, inteiro(u.input_tokens), inteiro(u.output_tokens),
    inteiro(u.cache_creation_input_tokens), inteiro(u.cache_read_input_tokens)];
  diag.linhas_com_uso++;
}

function processarTexto(texto, entrada, diag) {
  for (let linha of texto.split('\n')) {
    if (linha.charCodeAt(0) === 0xfeff) linha = linha.slice(1);
    // Atalho: só linhas com uso interessam (as de ferramenta podem ter megabytes).
    if (!linha || linha.indexOf('"usage"') < 0 || linha.indexOf('"assistant"') < 0) continue;
    let o;
    try {
      o = JSON.parse(linha);
    } catch (_) {
      diag.linhas_invalidas++;
      continue;
    }
    registrarObjeto(o, entrada, diag);
  }
}

/** Lê os bytes novos de uma transcrição a partir do offset guardado. */
async function lerIncremento(caminho, entrada, tamanho, diag) {
  const fh = await comNovasTentativas(() => fsp.open(caminho, 'r'));
  try {
    let pos = entrada.offset;
    let resto = null;
    while (pos < tamanho) {
      const quer = Math.min(BLOCO, tamanho - pos);
      const buf = Buffer.allocUnsafe(quer);
      const { bytesRead } = await fh.read(buf, 0, quer, pos);
      if (bytesRead <= 0) break;
      diag.bytes_lidos += bytesRead;
      pos += bytesRead;
      let dados = buf.subarray(0, bytesRead);
      if (resto) dados = Buffer.concat([resto, dados]);
      const nl = dados.lastIndexOf(0x0a);
      if (nl < 0) {
        resto = dados; // linha maior que o bloco: continua juntando
        continue;
      }
      // Cortar no \n é seguro em UTF-8 (byte de continuação nunca vale 0x0A).
      processarTexto(dados.subarray(0, nl).toString('utf8'), entrada, diag);
      resto = nl + 1 < dados.length ? Buffer.from(dados.subarray(nl + 1)) : null;
      entrada.offset = pos - (resto ? resto.length : 0);
      await new Promise((r) => setImmediate(r)); // deixa o servidor atender entre blocos
    }
    if (resto && resto.length) {
      // Fim do arquivo sem \n: só consome se já for um JSON completo; senão a linha ainda
      // está sendo escrita e fica para a próxima rodada.
      const texto = resto.toString('utf8').replace(/^﻿/, '').trim();
      let o = null;
      if (texto) {
        try { o = JSON.parse(texto); } catch (_) { o = null; }
      }
      if (!texto || (o && typeof o === 'object')) {
        if (o) registrarObjeto(o, entrada, diag);
        entrada.offset = pos;
      }
    }
  } finally {
    await fh.close();
  }
}

/** Atualiza a entrada de cache de uma transcrição. Devolve {entrada|null, mudou}. */
async function atualizarArquivo(caminho, anterior, t, diag, avisos) {
  let st;
  try {
    st = await comNovasTentativas(() => fsp.stat(caminho));
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      diag.transcricoes_ausentes++;
      return { entrada: null, mudou: !!anterior };
    }
    avisos.push(`Não consegui ler ${caminho.replace(/\\/g, '/')}: ${e.code || e.message}`);
    return { entrada: anterior || null, mudou: false };
  }
  if (!st.isFile()) {
    diag.transcricoes_ausentes++;
    return { entrada: null, mudou: !!anterior };
  }
  diag.transcricoes++;
  if (st.mtimeMs < t - RETENCAO_MS) {
    // Parada há mais tempo que a retenção: nada dela cai nos períodos.
    diag.transcricoes_antigas++;
    return { entrada: null, mudou: !!anterior };
  }
  let entrada = anterior;
  const trocou = entrada && (entrada.ino !== st.ino || Math.abs((entrada.nasc || 0) - st.birthtimeMs) > 1 || st.size < entrada.offset);
  if (!entrada || trocou) {
    if (trocou) diag.transcricoes_recomecadas++;
    entrada = { caminho: caminho.replace(/\\/g, '/'), offset: 0, ino: st.ino, nasc: st.birthtimeMs, msgs: {} };
  }
  if (st.size === entrada.offset) return { entrada, mudou: !anterior || trocou };
  try {
    await lerIncremento(caminho, entrada, st.size, diag);
  } catch (e) {
    avisos.push(`Leitura interrompida em ${caminho.replace(/\\/g, '/')}: ${e.code || e.message}`);
  }
  return { entrada, mudou: true };
}

async function carregarCache(arquivo, diag) {
  const vazio = () => ({ versao: CACHE_VERSAO, atualizado_em: null, arquivos: {} });
  const r = await lerJson(arquivo, { tentativas: 2 });
  if (!r.existe) {
    diag.cache = 'novo';
    return { cache: vazio(), novo: true };
  }
  const d = r.dados;
  if (!d || typeof d !== 'object' || d.versao !== CACHE_VERSAO || !d.arquivos || typeof d.arquivos !== 'object') {
    diag.cache = `recriado (${r.erro || 'formato diferente'})`;
    return { cache: vazio(), novo: true };
  }
  for (const [k, e] of Object.entries(d.arquivos)) {
    const ok = e && typeof e === 'object' && Number.isFinite(e.offset) && e.offset >= 0 && e.msgs && typeof e.msgs === 'object';
    if (!ok) delete d.arquivos[k];
  }
  diag.cache = 'reaproveitado';
  return { cache: d, novo: false };
}

// ---------- agregação ----------

function arred(n, casas = 1) {
  const f = 10 ** casas;
  return Math.round((n + Number.EPSILON) * f) / f;
}

function novoTotal() {
  return { entrada: 0, saida: 0, cache_escrita: 0, cache_leitura: 0, mensagens: 0 };
}

function consumoRelativo(s) {
  return s.entrada * PESOS.entrada + s.saida * PESOS.saida + s.cache_escrita * PESOS.cache_escrita + s.cache_leitura * PESOS.cache_leitura;
}

/** Início de cada período (ms) e de onde ele vem. */
function calcularPeriodos(agora, plano) {
  const t = agora.getTime();
  let inicio5 = t - 5 * HORA_MS;
  let base5 = 'últimas 5 h (sem reset válido do plano)';
  const reset = Date.parse(plano.reset_5h);
  if (Number.isFinite(reset) && reset > t) {
    const dur = (plano.janela_5h_duracao_s || 5 * 3600) * 1000;
    if (reset - dur <= t) {
      inicio5 = reset - dur;
      base5 = 'desde o início da janela de 5 h do plano (reset − 5 h)';
    }
  }
  // A semana do plano (reset_semanal − 7 d até agora) é a base do % estimado do plano no período
  // "7d": o semanal_pct do Maestri vale para ela, não para os 7 dias corridos das barras.
  let semana = null;
  const resetS = Date.parse(plano.reset_semanal);
  if (Number.isFinite(resetS) && resetS > t) {
    const durS = (plano.semanal_duracao_s || 7 * 24 * 3600) * 1000;
    if (resetS - durS <= t) semana = { inicio: resetS - durS, fim: t, base: 'semana do plano (reset semanal − 7 dias)' };
  }
  return {
    janela_5h: { inicio: inicio5, fim: t, base: base5 },
    hoje: { inicio: inicioDoDiaSP(agora), fim: t, base: 'desde 00:00 (São Paulo)' },
    '7d': { inicio: t - 7 * DIA_MS, fim: t, base: 'últimos 7 dias', plano: semana },
  };
}

/** Deduplica por message.id em todas as transcrições com dono e soma por agente e período. */
function agregar(cache, donos, periodos, plano, registrados) {
  const msgs = new Map();
  for (const [chave, e] of Object.entries(cache.arquivos)) {
    const dono = donos.get(chave);
    if (!dono) continue;
    for (const [id, m] of Object.entries(e.msgs)) {
      if (!Array.isArray(m) || m.length < 5) continue;
      const atual = msgs.get(id);
      // A mesma mensagem copiada em outro arquivo (sessão bifurcada) tem o mesmo uso: conta uma vez.
      if (!atual || m[0] > atual.m[0] || (m[0] === atual.m[0] && m[2] > atual.m[2])) msgs.set(id, { m, agente: dono.agente });
    }
  }
  const somarPeriodo = (inicio, fim) => {
    const somas = new Map(registrados.map((slug) => [slug, novoTotal()]));
    const total = novoTotal();
    for (const { m, agente } of msgs.values()) {
      if (m[0] < inicio || m[0] > fim + MIN_MS) continue;
      if (!somas.has(agente)) somas.set(agente, novoTotal());
      for (const s of [somas.get(agente), total]) {
        s.entrada += m[1]; s.saida += m[2]; s.cache_escrita += m[3]; s.cache_leitura += m[4]; s.mensagens++;
      }
    }
    return { somas, total };
  };
  const porAgente = {};
  const totais = {};
  for (const nome of PERIODOS) {
    const { inicio, fim } = periodos[nome];
    const { somas, total } = somarPeriodo(inicio, fim);
    const consumoTotal = consumoRelativo(total);
    const pctPlano = !plano.disponivel ? null : nome === 'janela_5h' ? plano.janela_5h_pct : nome === '7d' ? plano.semanal_pct : null;
    // "7d": a participação para o % do plano é medida na semana do plano (a mesma base do semanal_pct);
    // as barras continuam nos 7 dias corridos.
    const basePlano = nome === '7d' && periodos[nome].plano ? somarPeriodo(periodos[nome].plano.inicio, periodos[nome].plano.fim) : null;
    const consumoPlano = basePlano ? consumoRelativo(basePlano.total) : null;
    for (const slug of basePlano ? basePlano.somas.keys() : []) if (!somas.has(slug)) somas.set(slug, novoTotal());
    porAgente[nome] = [...somas].map(([agente, s]) => {
      const consumo = consumoRelativo(s);
      const fracao = consumoTotal > 0 ? consumo / consumoTotal : 0;
      let fracaoPlano = fracao;
      const linha = {};
      if (basePlano) {
        const sp = basePlano.somas.get(agente);
        fracaoPlano = consumoPlano > 0 && sp ? consumoRelativo(sp) / consumoPlano : 0;
        linha.pct_consumo_semana_plano = arred(100 * fracaoPlano, 1);
      }
      return Object.assign({
        agente,
        registrado: registrados.includes(agente),
        entrada: s.entrada, saida: s.saida, cache_escrita: s.cache_escrita, cache_leitura: s.cache_leitura,
        mensagens: s.mensagens,
        consumo_relativo: arred(consumo, 1),
        pct_consumo: arred(100 * fracao, 1),
        pct_plano_estimado: typeof pctPlano === 'number' ? arred(fracaoPlano * pctPlano, 1) : null,
      }, linha);
    }).sort((a, b) => b.consumo_relativo - a.consumo_relativo || a.agente.localeCompare(b.agente));
    totais[nome] = Object.assign({}, total, { consumo_relativo: arred(consumoTotal, 1) });
  }
  return { porAgente, totais, mensagens: msgs.size };
}

// ---------- coleta ----------

/**
 * Roda a coleta. opcoes: {maestroDir, maestriDataDir, claudeDir, env, agora, gravar (padrão true)}.
 * Devolve o objeto do uso.json (também gravado em estado/uso.json quando gravar).
 */
async function coletar(opcoes = {}) {
  const inicio = Date.now();
  const env = opcoes.env || process.env;
  const agora = comoData(opcoes.agora) || comoData(env.MAESTRO_AGORA) || new Date();
  const t = agora.getTime();
  const c = caminhos(Object.assign({}, opcoes, { env }));
  const gravar = opcoes.gravar !== false;
  const avisos = [];
  const diag = {
    sessoes: 0, sessoes_sem_dono: 0, sessoes_ilegiveis: 0, sessoes_sem_transcricao: 0,
    transcricoes: 0, transcricoes_ausentes: 0, transcricoes_antigas: 0, transcricoes_recomecadas: 0,
    bytes_lidos: 0, linhas_com_uso: 0, linhas_invalidas: 0, mensagens: 0, cache: null, duracao_ms: 0,
  };

  const plano = await lerPlano(c.status, agora);
  const registro = await lerJson(c.agentes);
  if (registro.erro) avisos.push(`registro/agentes.json: ${registro.erro}`);
  const registrados = registro.dados && Array.isArray(registro.dados.agentes)
    ? registro.dados.agentes.filter((a) => a && typeof a.slug === 'string' && a.slug).map((a) => a.slug)
    : [];

  const { cache, novo } = await carregarCache(c.cache, diag);
  let mudou = novo;

  // Dono de cada arquivo nesta rodada (a sessão manda; se o hook corrigir o agente, a atribuição segue).
  const sessoes = await lerSessoes(c.sessoes, c.claudeDir, diag);
  diag.sessoes = sessoes.length;
  const donos = new Map();
  for (const s of sessoes) {
    const arquivos = [s.transcricao, ...(await listarSubagentes(pastaSubagentes(s.transcricao)))];
    for (const a of arquivos) {
      const k = chaveArquivo(a);
      if (!donos.has(k)) donos.set(k, { agente: s.agente, caminho: a });
    }
  }
  for (const k of Object.keys(cache.arquivos)) {
    if (!donos.has(k)) {
      delete cache.arquivos[k];
      mudou = true;
    }
  }
  for (const [k, d] of donos) {
    const r = await atualizarArquivo(d.caminho, cache.arquivos[k], t, diag, avisos);
    if (r.mudou) mudou = true;
    if (r.entrada) cache.arquivos[k] = r.entrada;
    else delete cache.arquivos[k];
  }
  // Poda: mensagens fora da retenção não servem a nenhum período.
  const limite = t - RETENCAO_MS;
  for (const e of Object.values(cache.arquivos)) {
    for (const [id, m] of Object.entries(e.msgs)) {
      if (!Array.isArray(m) || !(m[0] >= limite)) {
        delete e.msgs[id];
        mudou = true;
      }
    }
  }

  const periodos = calcularPeriodos(agora, plano);
  const ag = agregar(cache, donos, periodos, plano, registrados);
  diag.mensagens = ag.mensagens;
  diag.duracao_ms = Date.now() - inicio;
  if (diag.sessoes_sem_dono) avisos.push(`${diag.sessoes_sem_dono} sessão(ões) sem agente em estado/sessoes ficaram de fora.`);
  if (diag.linhas_invalidas) avisos.push(`${diag.linhas_invalidas} linha(s) de transcrição ilegível(is) ignorada(s).`);

  const uso = {
    coletado_em: isoSP(agora),
    fonte: FONTE,
    nota: NOTA,
    formula: FORMULA,
    plano,
    periodos: Object.fromEntries(PERIODOS.map((p) => {
      const x = { inicio: isoSP(periodos[p].inicio), fim: isoSP(periodos[p].fim), base: periodos[p].base };
      // Só no "7d": de onde vem a participação usada no % estimado do plano (a semana do plano).
      if (periodos[p].plano) x.base_plano = { inicio: isoSP(periodos[p].plano.inicio), fim: isoSP(periodos[p].plano.fim), base: periodos[p].plano.base };
      else if (p === '7d') x.base_plano = null;
      return [p, x];
    })),
    por_agente: ag.porAgente,
    totais: ag.totais,
    coleta: diag,
    avisos,
  };

  if (gravar) {
    if (mudou) {
      cache.atualizado_em = uso.coletado_em;
      await gravarAtomico(c.cache, JSON.stringify(cache));
    }
    await gravarAtomico(c.uso, JSON.stringify(uso, null, 2) + '\n');
  }
  return uso;
}

// ---------- linha de comando ----------

const AJUDA = `Uso: node coletar_uso.js [--json] [--sem-gravar] [--agora <ISO>]
  Coleta o uso do Claude: o % do plano (Maestri) e a participação de cada agente
  (transcrições do Claude Code), e grava estado/uso.json.
  --json        imprime o uso.json no stdout
  --sem-gravar  não grava estado/uso.json nem estado/uso-cache.json
  --agora       fixa o "agora" (testes), ex.: 2026-10-08T15:50:00-03:00
Variáveis: MAESTRO_DIR, MAESTRI_DATA_DIR (padrão ~/.maestri), CLAUDE_CONFIG_DIR (padrão ~/.claude).`;

function lerArgs(argv) {
  const o = { json: false, semGravar: false, agora: null, ajuda: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--sem-gravar') o.semGravar = true;
    else if (a === '--ajuda' || a === '--help' || a === '-h') o.ajuda = true;
    else if (a === '--agora' || a.startsWith('--agora=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const d = comoData(v);
      if (!d) throw new ErroUso(`--agora inválido: "${v === undefined ? '' : v}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).`);
      o.agora = d;
    } else throw new ErroUso(`Opção desconhecida: ${a} (use --ajuda).`);
  }
  return o;
}

function pct(v) {
  return typeof v === 'number' ? `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—';
}

function resumoLegivel(uso, gravou) {
  const L = [];
  const p = uso.plano;
  L.push(`Uso coletado em ${dataHoraBR(uso.coletado_em)}`);
  if (p.disponivel) {
    const r5 = p.reset_5h ? ` (reinicia ${horaCurta(p.reset_5h, uso.coletado_em)})` : '';
    const r7 = p.reset_semanal ? ` (reinicia ${horaCurta(p.reset_semanal, uso.coletado_em)})` : '';
    const idade = p.idade_min === null ? '' : ` · dado de ${p.idade_min} min`;
    L.push(`Plano: 5 h ${pct(p.janela_5h_pct)}${r5} · semanal ${pct(p.semanal_pct)}${r7}${idade}`);
  } else {
    L.push(`Plano: indisponível. ${p.motivo}`);
  }
  for (const a of p.avisos || []) L.push(`  Aviso: ${a}`);
  const slugs = [...new Set(PERIODOS.flatMap((x) => uso.por_agente[x].map((l) => l.agente)))];
  L.push('Por agente, % do consumo (janela de 5 h · hoje · 7 dias):');
  if (!slugs.length) L.push('  nenhum agente com sessão registrada');
  for (const s of slugs) {
    const v = PERIODOS.map((x) => (uso.por_agente[x].find((l) => l.agente === s) || {}).pct_consumo);
    L.push(`  ${s.padEnd(24)} ${v.map(pct).join(' · ')}`);
  }
  const d = uso.coleta;
  const mb = (d.bytes_lidos / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  L.push(`Sessões: ${d.sessoes} com dono, ${d.sessoes_sem_dono} sem dono · transcrições: ${d.transcricoes} (${d.transcricoes_ausentes} ainda sem arquivo) · ${mb} MB lidos · cache ${d.cache}`);
  for (const a of uso.avisos) L.push(`Aviso: ${a}`);
  L.push(gravou ? 'Gravado em estado/uso.json' : 'Nada gravado (--sem-gravar)');
  return L.join('\n') + '\n';
}

async function main(argv) {
  const args = lerArgs(argv);
  if (args.ajuda) {
    process.stdout.write(AJUDA + '\n');
    return 0;
  }
  const uso = await coletar({ agora: args.agora || undefined, gravar: !args.semGravar });
  process.stdout.write(args.json ? JSON.stringify(uso, null, 2) + '\n' : resumoLegivel(uso, !args.semGravar));
  return 0;
}

module.exports = {
  coletar, lerPlano, calcularPeriodos, consumoRelativo, caminhos, PESOS, NOTA, FORMULA, PERIODOS,
  util: {
    comoData, partesSP, isoSP, diaSP, instanteSP, inicioDoDiaSP, dataHoraBR, horaCurta,
    comNovasTentativas, lerTexto, lerJson, gravarAtomico, esperar,
  },
};

if (require.main === module) {
  main(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo;
  }).catch((e) => {
    if (e instanceof ErroUso) {
      process.stderr.write(`Erro: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`Erro inesperado: ${e && e.stack ? e.stack : e}\n`);
      process.exitCode = 1;
    }
  });
}
