#!/usr/bin/env node
'use strict';
// hook_log.js · hook do Claude Code → log bruto em _maestro/logs/bruto/<agente>/AAAA-MM-DD.jsonl (decisões 5 a 9).
// Instalado no ~/.claude/settings.json na forma exec, sem shell:
//   {"type":"command","command":"node","args":["bin/hook_log.js"]}
// Regras: nunca escreve no stdout nem no stderr (em SessionStart e UserPromptSubmit o stdout vira contexto do
// modelo); sai sempre com 0; desiste de tudo em ~1,5 s; nunca espera trava por mais de ~300 ms; quando a sessão
// não é do workspace, sai em poucos ms (sem ler arquivo, se possível); trunca entrada (600) e saída (300) e
// redige segredos com «redigido».

// ---- silêncio total e saída garantida com código 0
process.stdout.write = () => true;
process.stderr.write = () => true;
process.noDeprecation = true;
process.removeAllListeners('warning');
process.on('warning', () => {});
let saindo = false;
function sair() {
  if (saindo) return;
  saindo = true;
  try { process.exit(0); } catch (_) { /* nada a fazer */ }
}
process.on('uncaughtException', sair);
process.on('unhandledRejection', sair);
setTimeout(sair, 1500); // trava de tempo total: nunca prende o Claude Code

const LIMITE_ENTRADA = 600;
const LIMITE_SAIDA = 300;
const LIMITE_PROMPT = 1000;
const ESPERA_TRAVA_MS = 300;
const EVENTOS_DE_SESSAO = ['SessionStart', 'UserPromptSubmit', 'Stop'];

/** Filtro rápido (sem a lib): o caminho fica dentro da raiz? */
function dentroRapido(filho, pai) {
  if (typeof filho !== 'string' || !filho.trim()) return false;
  const path = require('path');
  const n = (s) => path.resolve(s.trim().replace(/\\/g, '/').replace(/^\/([a-zA-Z])(\/|$)/, '$1:/'))
    .replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = n(filho);
  const r = n(pai);
  return f === r || f.startsWith(`${r}/`);
}

/** Dorme sem gastar CPU (síncrono). */
function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let cacheaPendente = null;

/** Guarda a última cópia boa do cadastro em estado/agentes-cache.json (só quando o agentes.json mudou). */
function guardarCache(fs, path, arq, cache, texto) {
  try {
    let velho = true;
    try { velho = fs.statSync(cache).mtimeMs < fs.statSync(arq).mtimeMs; } catch (_) { /* sem cache ainda */ }
    if (!velho) return;
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const tmp = `${cache}.tmp-${process.pid}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    fs.writeFileSync(tmp, texto);
    try { fs.renameSync(tmp, cache); } catch (_) { try { fs.unlinkSync(tmp); } catch (__) { /* ignora */ } }
  } catch (_) { /* o cache é só uma rede de proteção */ }
}

/**
 * Lê registro/agentes.json SEM a lib (rápido, para decidir "é nosso?" antes de carregá-la). Em EBUSY/EPERM
 * tenta de novo por até ~200 ms; com JSON pela metade (alguém regravando), tenta de novo uma vez depois de
 * ~30 ms. Se ainda falhar, usa a última cópia boa (estado/agentes-cache.json). Arquivo ausente devolve null.
 */
function lerCadastro(base) {
  const fs = require('fs');
  const path = require('path');
  const arq = path.join(base, 'registro', 'agentes.json');
  const cache = path.join(base, 'estado', 'agentes-cache.json');
  const normal = (c) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    if (!Array.isArray(c.agentes)) c.agentes = [];
    return c;
  };
  const inicio = Date.now();
  let repetiuJson = false;
  for (;;) {
    let texto;
    try {
      texto = fs.readFileSync(arq, 'utf8').replace(/^﻿/, '');
      const c = normal(JSON.parse(texto));
      // O cache só é gravado depois de confirmar que a sessão é nossa (sessão alheia não grava nada).
      if (c) { cacheaPendente = () => guardarCache(fs, path, arq, cache, texto); return c; }
      break;
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      if (e instanceof SyntaxError) {
        if (repetiuJson) break;
        repetiuJson = true;
        dormir(30);
        continue;
      }
      if (!(e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) || Date.now() - inicio >= 200) break;
      dormir(10);
    }
  }
  try { return normal(JSON.parse(fs.readFileSync(cache, 'utf8'))); } catch (_) { return null; }
}

/** "entrada" da linha: comando (Bash/PowerShell), arquivo + tamanho (Read/Write/Edit) ou JSON truncado. */
function resumoEntrada(lib, ferramenta, entrada) {
  if (entrada === undefined || entrada === null) return undefined;
  if (typeof entrada !== 'object') return lib.resumir(String(entrada), LIMITE_ENTRADA);
  if ((ferramenta === 'Bash' || ferramenta === 'PowerShell') && typeof entrada.command === 'string') {
    return lib.resumir(entrada.command, LIMITE_ENTRADA);
  }
  const arquivo = typeof entrada.file_path === 'string' ? entrada.file_path : (typeof entrada.notebook_path === 'string' ? entrada.notebook_path : null);
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(ferramenta) && arquivo) {
    let tamanho = '';
    if (ferramenta === 'Write' && typeof entrada.content === 'string') tamanho = ` (${entrada.content.length} caracteres)`;
    else if (ferramenta === 'Edit' && typeof entrada.old_string === 'string' && typeof entrada.new_string === 'string') {
      tamanho = ` (${entrada.old_string.length} → ${entrada.new_string.length} caracteres${entrada.replace_all ? ', todas as ocorrências' : ''})`;
    } else if (ferramenta === 'MultiEdit' && Array.isArray(entrada.edits)) tamanho = ` (${entrada.edits.length} edições)`;
    else if (ferramenta === 'Read' && (entrada.offset || entrada.limit)) tamanho = ` (linhas ${entrada.offset || 1}${entrada.limit ? ` +${entrada.limit}` : ''})`;
    else if (ferramenta === 'Read' && entrada.pages) tamanho = ` (páginas ${entrada.pages})`;
    return lib.resumir(arquivo + tamanho, LIMITE_ENTRADA);
  }
  // Redige o objeto antes de serializar: JSON dentro de texto aparece cru e as regras de chave=valor valem.
  return lib.resumir(JSON.stringify(lib.redigirValor(entrada)), LIMITE_ENTRADA);
}

const FERRAMENTAS_DE_ARQUIVO = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** Resumo sem conteúdo para Write/Edit/MultiEdit/NotebookEdit: o que foi feito e quantas linhas (nunca o texto). */
function resumoArquivo(ferramenta, r) {
  if (!r || typeof r !== 'object') return `${ferramenta} ok`;
  if (ferramenta === 'Write') {
    const linhas = typeof r.content === 'string' ? ` (${r.content.split('\n').length} linhas)` : '';
    return `${r.type === 'create' ? 'criado' : (r.type === 'update' ? 'atualizado' : 'gravado')}${linhas}`;
  }
  if (ferramenta === 'NotebookEdit') return `notebook editado${typeof r.edit_mode === 'string' ? ` (${r.edit_mode.slice(0, 20)})` : ''}`;
  let mais = 0;
  let menos = 0;
  if (Array.isArray(r.structuredPatch)) {
    for (const h of r.structuredPatch) {
      if (!h || !Array.isArray(h.lines)) continue;
      for (const l of h.lines) {
        if (typeof l !== 'string') continue;
        if (l.startsWith('+')) mais++;
        else if (l.startsWith('-')) menos++;
      }
    }
  }
  const patch = Array.isArray(r.structuredPatch) ? ` (+${mais} −${menos} linhas)` : '';
  return `editado${patch}${r.replaceAll ? ', todas as ocorrências' : ''}`;
}

/** "saida_resumo": stdout/stderr (Bash/PowerShell), linhas lidas (Read), resumo sem conteúdo (Write/Edit) ou JSON redigido e truncado. */
function resumoSaida(lib, ferramenta, r) {
  if (r === undefined || r === null) return undefined;
  if (FERRAMENTAS_DE_ARQUIVO.includes(ferramenta)) return resumoArquivo(ferramenta, r);
  if (typeof r === 'string') return lib.resumir(r, LIMITE_SAIDA);
  if (typeof r !== 'object') return lib.resumir(String(r), LIMITE_SAIDA);
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    let s = typeof r.stdout === 'string' ? r.stdout : '';
    if (r.stderr) s += `${s ? '\n' : ''}[stderr] ${r.stderr}`;
    if (r.interrupted) s = `(interrompido) ${s}`;
    return lib.resumir(s, LIMITE_SAIDA);
  }
  if (ferramenta === 'Read') {
    if (r.file && typeof r.file === 'object' && typeof r.file.numLines === 'number') {
      return `${r.file.numLines} linhas lidas${typeof r.file.totalLines === 'number' ? ` de ${r.file.totalLines}` : ''}`;
    }
    return `lido (${typeof r.type === 'string' ? r.type.slice(0, 20) : 'arquivo'})`; // imagem, PDF, notebook: nunca o conteúdo
  }
  return lib.resumir(JSON.stringify(lib.redigirValor(r)), LIMITE_SAIDA);
}

/** Versão do Claude Code: stdin.version ou AI_AGENT ("claude-code_2-1-292_agent" vira "claude-code 2.1.292"). */
function versaoDe(p, env) {
  if (typeof p.version === 'string' && p.version.trim()) return p.version.trim().slice(0, 40);
  const a = typeof env.AI_AGENT === 'string' ? env.AI_AGENT.trim() : '';
  if (!a) return undefined;
  const m = /^([A-Za-z][\w.-]*?)_(\d+(?:-\d+)+)(?:_|$)/.exec(a);
  return m ? `${m[1]} ${m[2].replace(/-/g, '.')}` : a.slice(0, 60);
}

function processar(texto) {
  const path = require('path');
  let p;
  try { p = JSON.parse(String(texto).replace(/^\uFEFF/, '')); } catch (_) { return; }
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.hook_event_name !== 'string') return;
  const env = process.env;
  const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd : process.cwd();

  // 1) Filtros rápidos, antes de carregar a lib:
  //    fora do Maestri e fora da raiz do workspace → não é nosso (sem ler arquivo nenhum);
  //    Maestri de OUTRO workspace → não é nosso (lê só o agentes.json, ou a última cópia boa dele).
  const base = path.resolve(env.MAESTRO_DIR || path.join(__dirname, '..'));
  if (!env.MAESTRI_WORKSPACE_ID) {
    const raiz = path.dirname(base);
    if (![cwd, env.CLAUDE_PROJECT_DIR].some((d) => dentroRapido(d, raiz))) return;
  }
  const cadastro = lerCadastro(base);
  const wsId = cadastro && cadastro.workspace && typeof cadastro.workspace.id === 'string' ? cadastro.workspace.id : null;
  if (env.MAESTRI_WORKSPACE_ID && wsId && env.MAESTRI_WORKSPACE_ID !== wsId) return;

  // 2) Workspace e agente (decisão 5).
  const lib = require('./lib_maestro');
  const id = lib.identificarAgente({ env, cwd, cadastro });
  if (!id.nosso) return;
  if (cacheaPendente) cacheaPendente();

  const quando = lib.agora();
  const iso = lib.isoSP(quando);
  const evento = p.hook_event_name;
  const sid = lib.idSessaoSeguro(p.session_id);
  const fluxoNoPrompt = evento === 'UserPromptSubmit' ? lib.ultimoFluxoNoTexto(p.prompt) : null;

  // 3) Estado da sessão e correlação de fluxo (decisão 8). Nunca espera trava mais de ~300 ms.
  let fluxo = null;
  if (sid && EVENTOS_DE_SESSAO.includes(evento)) {
    try {
      const s = lib.atualizarSessao(sid, (atual) => {
        const a = atual && typeof atual === 'object' && !Array.isArray(atual) ? atual : {};
        const trocou = !!fluxoNoPrompt && fluxoNoPrompt !== a.fluxo_id;
        return {
          ...a,
          session_id: sid,
          agente: id.agente,
          terminal: id.terminal || null,
          cwd,
          transcript_path: typeof p.transcript_path === 'string' ? p.transcript_path : (a.transcript_path || null),
          iniciado_em: a.iniciado_em || iso,
          visto_em: iso,
          fluxo_id: fluxoNoPrompt || a.fluxo_id || null,
          fluxo_desde: trocou ? iso : (a.fluxo_desde || null),
        };
      }, { tempoMaximoMs: ESPERA_TRAVA_MS, sincronizar: false, limparTemporarios: false }); // sessão é estado derivado: sem fsync
      fluxo = s && s.fluxo_id;
    } catch (_) {
      fluxo = fluxoNoPrompt || lib.fluxoDaSessao(sid, { tempoMaximoMs: 100 });
    }
  } else if (sid) {
    fluxo = lib.fluxoDaSessao(sid, { tempoMaximoMs: 100 });
  }

  // 4) A linha do log bruto (decisão 9).
  const linha = { ts: iso, agente: id.agente, terminal: id.terminal || null, sessao: sid || null };
  if (p.agent_id !== undefined && p.agent_id !== null) linha.agent_id = String(p.agent_id);
  if (p.agent_type !== undefined && p.agent_type !== null) linha.agent_type = String(p.agent_type);
  if (fluxo) linha.fluxo_id = fluxo;
  linha.evento = evento;
  if (typeof p.tool_name === 'string') {
    linha.ferramenta = p.tool_name;
    const e = resumoEntrada(lib, p.tool_name, p.tool_input);
    if (e !== undefined && e !== '') linha.entrada = e;
  }
  if (evento === 'PostToolUse') {
    linha.ok = true;
    const s = resumoSaida(lib, p.tool_name, p.tool_response);
    if (s) linha.saida_resumo = s;
  } else if (evento === 'PostToolUseFailure') {
    linha.ok = false;
    const bruto = typeof p.error === 'string' ? p.error : (p.error === undefined || p.error === null ? '' : JSON.stringify(p.error));
    const erro = `${p.is_interrupt ? '(interrompido) ' : ''}${bruto}`;
    if (erro) linha.erro = lib.resumir(erro, LIMITE_SAIDA);
  } else if ((evento === 'Stop' || evento === 'SubagentStop') && typeof p.last_assistant_message === 'string' && p.last_assistant_message) {
    linha.saida_resumo = lib.resumir(p.last_assistant_message, LIMITE_SAIDA);
  }
  if (typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms)) linha.duracao_ms = p.duration_ms;
  if (evento === 'UserPromptSubmit' && typeof p.prompt === 'string') linha.prompt = lib.resumir(p.prompt, LIMITE_PROMPT);
  if (evento === 'SessionStart' && p.source) linha.detalhe = String(p.source).slice(0, 40);
  if (evento === 'SessionEnd' && p.reason) linha.detalhe = String(p.reason).slice(0, 40);
  linha.cwd = cwd;
  const versao = versaoDe(p, env);
  if (versao) linha.versao = versao;
  lib.anexarJsonl(lib.arquivoBruto(id.agente, quando), linha);
}

// ---- lê todo o stdin (assíncrono, para a trava de tempo funcionar) e processa uma vez
const pedacos = [];
try {
  process.stdin.on('data', (c) => { pedacos.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
  process.stdin.on('end', () => {
    try { processar(Buffer.concat(pedacos).toString('utf8')); } catch (_) { /* nunca falha o agente */ }
    sair();
  });
  process.stdin.on('error', sair);
  process.stdin.resume();
} catch (_) {
  sair();
}
