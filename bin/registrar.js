#!/usr/bin/env node
'use strict';
// registrar · CLI do log semântico e dos fluxos do workspace (Node.js, só biblioteca padrão).
// Subcomandos: novo-fluxo, evento, ultimos, fluxo, importar-pre-registro.
// Códigos de saída: 0 ok · 2 validação · 3 trava esgotada · 1 outros.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const CMD = `node ${lib.slashes(path.join(__dirname, 'registrar.js'))}`;
const FLUXO_BOOTSTRAP = 'F-20261008-0001';
const TITULO_BOOTSTRAP = 'Bootstrap da Fase 1';
const DIA_BOOTSTRAP = FLUXO_BOOTSTRAP.slice(2, 10);
const CONTADOR_INICIAL = { dias: {}, fluxos: {} };

const AJUDA = `registrar · log semântico e fluxos do workspace (eventos em _maestro/logs/eventos/AAAA-MM.jsonl)

Forma canônica (funciona igual no Git Bash, no PowerShell e no cmd):
  ${CMD} <subcomando> [opções]
Atalhos: bin/registrar (Git Bash) e bin/registrar.cmd (PowerShell/cmd; o .cmd estraga ^, %VAR% e aspas internas).
Texto com aspas, emoji, ^, % ou acentos: mande o evento em JSON pela entrada padrão (--json -) ou por arquivo
(--json-arquivo, o melhor caminho no PowerShell).
ATENÇÃO Git Bash: na forma "node .../registrar.js", todo argumento que começa com "/" vira caminho do Windows
("/compact" chega como "C:/Program Files/Git/compact"). Use o atalho bin/registrar (já desliga a conversão),
ponha MSYS2_ARG_CONV_EXCL='*' na frente do comando, ou mande o JSON por --json -.

SUBCOMANDOS

  novo-fluxo [--titulo "..."] [--agente S]
      Gera e imprime F-AAAAMMDD-NNNN (contador diário com trava em estado/contador-fluxos.json, que guarda
      título, agente e criado_em de cada fluxo). Dentro de uma sessão do Claude Code, a sessão passa a
      usar esse fluxo: os comandos seguintes (log bruto) e os eventos sem --fluxo herdam o id.

  evento --origem O --tipo T --resumo "..." --resultado R [opções]
      Valida, grava e imprime o id do evento (EV-AAAAMMDD-HHMMSS-xxxx).
      --agente S             padrão: o agente deste terminal (MAESTRI_TERMINAL_ID ou diretório)
      --fluxo F              padrão: o fluxo da sessão atual (CLAUDE_CODE_SESSION_ID); erro se não houver
      --direcao "..."        obrigatória em decisao, execucao, delegacao e auditoria (caminho e porquê)
      --projeto P            ex.: A, B, C (prefixo do projeto)
      --passo "..."   --comando "..."   --alteracao "..."   --pendencia P-NNNN      (repetíveis)
      --validacao "..."   --proximo-passo "..."   --precisa-dono   --duracao SEGUNDOS   --teste
      --json '<objeto>'      evento completo em JSON (opções da linha de comando têm prioridade)
      --json -               o JSON vem pela entrada padrão
      --json-arquivo C       o JSON vem de um arquivo (UTF-8; aceita BOM e UTF-16 do PowerShell 5)
      Campos do JSON: agente, fluxo_id, origem, tipo, projeto, resumo, direcao, passos[], comandos[], alteracoes[], resultado, validacao,
      proximo_passo, precisa_dono, pendencias[], duracao_s, ts (opcional, ISO com fuso), teste.

  ultimos [--horas N] [--agente S] [--fluxo F] [--tipo T] [--limite N] [--incluir-testes] [--json]
      Eventos recentes (padrão: últimas 24 h), do mais antigo para o mais novo. Eventos de teste ficam ocultos.
      No texto, mostra só os 30 mais recentes (--limite muda; --json traz todos, ou --limite deles).

  fluxo F [--limite N] [--json]
      A sequência inteira de um fluxo: título, eventos de todos os meses e o resumo dos comandos brutos de
      todos os agentes com aquele fluxo_id (mais os sem fluxo_id na janela do evento, §10.4). No texto, lista
      as 50 entradas brutas mais recentes (--limite muda; --json traz todas).

  importar-pre-registro [--arquivo C]
      Importa a tabela de logs/pre-registro.md como eventos "bootstrap" do cerebro (origem dono-direto,
      fluxo ${FLUXO_BOOTSTRAP}, tipo original em "tipo_original", "importado_de": "pre-registro").
      Idempotente: linhas já importadas são puladas. Garante o contador de 20261008 em pelo menos 1.
      (O novo-fluxo nunca entrega ${FLUXO_BOOTSTRAP}: nesse dia começa em 0002. Se ${FLUXO_BOOTSTRAP} já for
      de outro fluxo, a importação recusa com código 2 sem gravar nada.)

VALORES PERMITIDOS
  origem      dono-direto, cerebro, rotina, sistema, agente:<slug>
  tipo        ${lib.EVENT_TYPES.join(', ')}
  resultado   ${lib.RESULTS.join(', ')}
  resumo      até ${lib.MAX_SUMMARY} caracteres, uma linha, começando por verbo ou substantivo concreto
  (acentos são aceitos e normalizados: "execução" vira "execucao")

CÓDIGOS DE SAÍDA
  0 ok · 2 validação (lista cada problema) · 3 trava esgotada · 1 outros erros

EXEMPLOS
  ${CMD} novo-fluxo --titulo "Revisão semanal do repositório"
  ${CMD} evento --fluxo F-20261008-0002 --origem dono-direto --tipo pedido-recebido --resumo "Pedido do dono: revisar o repositório" --resultado em-andamento
  ${CMD} evento --origem cerebro --tipo delegacao --resumo "Delegada a revisão ao Coordenador" --direcao "O repositório é domínio do Coordenador; mandei [PEDIDO] com autonomia só de leitura." --resultado em-andamento
  ${CMD} evento --origem cerebro --tipo execucao --resumo "Relatório gerado: 13 abertas, 11 alertas" --direcao "Li o histórico inteiro porque traz as mudanças numa leitura só." --resultado ok --passo "Li o histórico" --passo "Gerei o relatório" --duracao 48
  ${CMD} evento --json-arquivo C:/Temp/ev.json                              (PowerShell: o melhor caminho)
  ${CMD} evento --json - < /c/Temp/ev.json                                 (Git Bash)
  MSYS2_ARG_CONV_EXCL='*' ${CMD} evento --resumo "/compact rodado" ...                                    (Git Bash, texto começando por /)
  (No Windows PowerShell 5, o pipe "Get-Content ... | node" troca acentos e emoji por "?": prefira --json-arquivo
   ou rode antes $OutputEncoding = [Text.UTF8Encoding]::new($false).)
  ${CMD} ultimos --horas 4 --agente coordenador
  ${CMD} fluxo F-20261008-0002
  ${CMD} importar-pre-registro
`;

// ---------------------------------------------------------------------------------- utilidades

/** Agente padrão deste terminal; avisa quando não dá para identificar. */
function agentePadrao() {
  const id = lib.identifyAgent();
  if (!id.known) lib.warn(`aviso: agente não identificado (${id.agent}); use --agente <slug> para registrar em nome de um agente do registro`);
  return id.agent;
}

/** Contador de fluxos com a estrutura esperada {dias:{AAAAMMDD:n}, fluxos:{F:{titulo, agente, criado_em}}}. */
function normalizarContador(c) {
  const r = c && typeof c === 'object' && !Array.isArray(c) ? { ...c } : {};
  r.dias = r.dias && typeof r.dias === 'object' && !Array.isArray(r.dias) ? { ...r.dias } : {};
  r.fluxos = r.fluxos && typeof r.fluxos === 'object' && !Array.isArray(r.fluxos) ? { ...r.fluxos } : {};
  return r;
}

/** Converte "--duracao" em segundos (número >= 0). */
function lerDuracao(texto) {
  const n = Number(String(texto).trim().replace(',', '.').replace(/s$/i, ''));
  if (!Number.isFinite(n) || n < 0) throw lib.argsError(`--duracao espera um número de segundos (recebi "${texto}")`);
  return n;
}

/** Linhas de texto de um evento para "ultimos" e "fluxo". */
function linhasDoEvento(ev, { mostrarFluxo = true } = {}) {
  const d = lib.parseDate(ev.ts);
  const partes = [ev.agente];
  if (mostrarFluxo) partes.push(ev.fluxo_id);
  partes.push(ev.tipo, ev.resultado);
  let cab = `${d ? lib.timeBR(d) : '??:??:??'}  ${partes.join(' · ')}`;
  if (ev.teste) cab += ' · [teste]';
  if (ev.precisa_dono) cab += ' · ⚠ precisa do dono';
  const linhas = [cab, `          ${ev.resumo}`];
  if (ev.direcao) linhas.push(`          direção: ${lib.truncate(String(ev.direcao).replace(/\s+/g, ' '), 160)}`);
  if (Array.isArray(ev.pendencias) && ev.pendencias.length) linhas.push(`          pendências: ${ev.pendencias.join(', ')}`);
  if (ev.proximo_passo) linhas.push(`          próximo passo: ${lib.truncate(String(ev.proximo_passo).replace(/\s+/g, ' '), 160)}`);
  return linhas;
}

/** Imprime eventos agrupados por dia (separador "── quinta-feira, 08/10/2026 ──"). */
function imprimirEventos(eventos, opcoes) {
  let diaAtual = null;
  for (const ev of eventos) {
    const d = lib.parseDate(ev.ts);
    const dia = d ? lib.dateBR(d) : '?';
    if (dia !== diaAtual) {
      diaAtual = dia;
      lib.print(`── ${d ? lib.longDay(d) : 'data inválida'} ──`);
    }
    for (const l of linhasDoEvento(ev, opcoes)) lib.print(l);
  }
}

// ---------------------------------------------------------------------------------- novo-fluxo

function cmdNovoFluxo(argv) {
  const { opts: op } = lib.parseArgs(argv, { text: ['titulo', 'agente'] });
  const quando = lib.now();
  const iso = lib.isoSP(quando);
  const dia = lib.spStamps(quando).compacto;
  const agente = op.agente !== undefined ? op.agente.trim() : agentePadrao();
  const problemas = lib.agentProblems(agente, lib.loadAgentsSafe());
  const titulo = op.titulo !== undefined ? op.titulo.replace(/\s+/g, ' ').trim() : null;
  if (op.titulo !== undefined && !titulo) problemas.push('--titulo veio vazio');
  if (problemas.length) throw lib.validationError(problemas, 'Não criei o fluxo');
  let id = null;
  lib.updateJson(lib.paths().flowCounter, (atual) => {
    const c = normalizarContador(atual);
    // F-20261008-0001 é do bootstrap: nesse dia o contador começa em 0002 mesmo antes da importação.
    const n = Math.max(Number(c.dias[dia]) || 0, dia === DIA_BOOTSTRAP ? 1 : 0) + 1;
    c.dias[dia] = n;
    id = `F-${dia}-${String(n).padStart(4, '0')}`;
    c.fluxos[id] = { titulo, agente, criado_em: iso };
    return c;
  }, { initial: CONTADOR_INICIAL, backup: true });
  // A sessão do Claude Code que criou o fluxo passa a trabalhar nele: os comandos seguintes (log bruto)
  // e os eventos sem --fluxo herdam o id, mesmo que o prompt não tenha trazido um F-....
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (lib.safeSessionId(sid)) {
    try {
      lib.updateSession(sid, (s) => ({
        ...(s && typeof s === 'object' ? s : { session_id: sid, agent: agente, terminal: process.env.MAESTRI_TERMINAL_ID || null, started_at: iso }),
        flow_id: id,
        flow_since: iso,
        seen_at: iso,
      }), { timeoutMs: 3000 });
    } catch (e) {
      lib.warn(`aviso: o fluxo ${id} foi criado, mas não consegui ligá-lo à sessão (${e.message}); use --fluxo ${id} nos eventos`);
    }
  }
  lib.print(id);
}

// ---------------------------------------------------------------------------------- evento

const MAPA_TEXTO = {
  agente: 'agente', fluxo: 'fluxo_id', origem: 'origem', tipo: 'tipo', resumo: 'resumo', direcao: 'direcao',
  resultado: 'resultado', projeto: 'projeto', validacao: 'validacao', 'proximo-passo': 'proximo_passo',
};
const MAPA_LISTA = { passo: 'passos', comando: 'comandos', alteracao: 'alteracoes', pendencia: 'pendencias' };

function cmdEvento(argv) {
  const { opts: op } = lib.parseArgs(argv, {
    text: [...Object.keys(MAPA_TEXTO), 'duracao', 'json', 'json-arquivo'],
    list: Object.keys(MAPA_LISTA),
    bool: ['precisa-dono', 'teste'],
  });
  if (op.json !== undefined && op['json-arquivo'] !== undefined) throw lib.argsError('use --json ou --json-arquivo, não os dois');
  let ev = {};
  if (op.json !== undefined) ev = op.json === '-' ? lib.readJsonFromStdin() : lib.parseJsonObject(op.json, '--json');
  if (op['json-arquivo'] !== undefined) ev = lib.readJsonFromFile(op['json-arquivo']);
  ev = { ...ev };
  for (const [flag, campo] of Object.entries(MAPA_TEXTO)) if (op[flag] !== undefined) ev[campo] = op[flag];
  for (const [flag, campo] of Object.entries(MAPA_LISTA)) if (op[flag] !== undefined) ev[campo] = op[flag];
  if (op['precisa-dono'] !== undefined) ev.precisa_dono = op['precisa-dono'];
  if (op.teste !== undefined) ev.teste = op.teste;
  if (op.duracao !== undefined) ev.duracao_s = lerDuracao(op.duracao);
  // Padrões: agente deste terminal e fluxo da sessão.
  if (ev.agente === undefined) ev.agente = agentePadrao();
  let semFluxo = false;
  if (ev.fluxo_id === undefined) {
    const f = lib.flowOfSession(process.env.CLAUDE_CODE_SESSION_ID);
    if (f) ev.fluxo_id = f;
    else semFluxo = true;
  }
  const { event: evento, problems: problemas } = lib.buildEvent(ev);
  if (problemas.length) {
    const lista = semFluxo
      ? problemas.map((p) => (p === 'falta o campo obrigatório "fluxo_id"' ? lib.missingFlowMessage(process.env.CLAUDE_CODE_SESSION_ID) : p))
      : problemas;
    throw lib.validationError(lista, 'Evento inválido, nada foi gravado');
  }
  lib.writeEvent(evento);
  lib.print(evento.id);
}

// ---------------------------------------------------------------------------------- ultimos

/** Lê --limite N (inteiro >= 1); "padrao" quando ausente. */
function lerLimite(op, padrao) {
  if (op.limite === undefined) return padrao;
  const n = Number(op.limite);
  if (!Number.isInteger(n) || n < 1) throw lib.argsError(`--limite espera um número inteiro maior que zero (recebi "${op.limite}")`);
  return n;
}

function cmdUltimos(argv) {
  const { opts: op } = lib.parseArgs(argv, { text: ['horas', 'agente', 'fluxo', 'tipo', 'limite'], bool: ['incluir-testes', 'json'] });
  let horas = 24;
  if (op.horas !== undefined) {
    horas = Number(String(op.horas).replace(',', '.'));
    if (!Number.isFinite(horas) || horas <= 0) throw lib.argsError(`--horas espera um número maior que zero (recebi "${op.horas}")`);
  }
  const limite = lerLimite(op, op.json ? Infinity : 30);
  const tipo = op.tipo !== undefined ? lib.normalizeEnum(op.tipo) : undefined;
  if (tipo !== undefined && !lib.EVENT_TYPES.includes(tipo)) throw lib.argsError(`--tipo "${op.tipo}" não existe (use: ${lib.EVENT_TYPES.join(', ')})`);
  if (op.agente !== undefined) {
    const p = lib.agentProblems(op.agente.trim(), lib.loadAgentsSafe(), '--agente');
    if (p.length) throw lib.argsError(p.join('; '));
  }
  const fluxo = op.fluxo !== undefined ? op.fluxo.trim().toUpperCase() : undefined;
  if (fluxo !== undefined && !lib.RE_FLOW.test(fluxo)) throw lib.argsError(`--fluxo "${op.fluxo}" inválido: use o formato F-AAAAMMDD-NNNN`);
  const fim = lib.now();
  const inicio = new Date(fim.getTime() - horas * 3600e3);
  const eventos = lib.readEvents({ desde: inicio }).filter((e) => {
    const d = lib.parseDate(e.ts);
    if (!d || d < inicio) return false;
    if (!op['incluir-testes'] && e.teste === true) return false;
    if (op.agente !== undefined && e.agente !== op.agente.trim()) return false;
    if (fluxo !== undefined && e.fluxo_id !== fluxo) return false;
    if (tipo !== undefined && e.tipo !== tipo) return false;
    return true;
  });
  const mostrar = eventos.length > limite ? eventos.slice(-limite) : eventos; // os mais recentes
  if (op.json) { lib.print(JSON.stringify(mostrar, null, 2)); return; }
  const rotulo = Number.isInteger(horas) ? `${horas} h` : `${String(horas).replace('.', ',')} h`;
  if (!eventos.length) { lib.print(`Nenhum evento nas últimas ${rotulo}.`); return; }
  lib.print(`Eventos das últimas ${rotulo} (${eventos.length}):`);
  if (mostrar.length < eventos.length) lib.print(`(mostrando os ${mostrar.length} mais recentes de ${eventos.length}; use --limite N ou --json)`);
  imprimirEventos(mostrar);
}

// ---------------------------------------------------------------------------------- fluxo

/** Resumo dos comandos brutos por agente: total, falhas, ferramentas, primeiro e último horário. */
function resumirBrutos(brutos) {
  const porAgente = {};
  for (const b of brutos) {
    const a = porAgente[b.agent] || (porAgente[b.agent] = { agente: b.agent, entradas: 0, ferramentas: {}, falhas: 0, prompts: 0, primeiro: b.ts, ultimo: b.ts });
    a.entradas++;
    if (b.tool && (b.hook_event === 'PostToolUse' || b.hook_event === 'PostToolUseFailure')) a.ferramentas[b.tool] = (a.ferramentas[b.tool] || 0) + 1;
    if (b.ok === false) a.falhas++;
    if (b.hook_event === 'UserPromptSubmit') a.prompts++;
    a.ultimo = b.ts;
  }
  return Object.values(porAgente);
}

function cmdFluxo(argv) {
  const { opts: op, pos } = lib.parseArgs(argv, { text: ['limite'], bool: ['json'] }, { maxPositional: 1 });
  const limite = lerLimite(op, 50);
  if (!pos.length) throw lib.argsError('informe o fluxo: registrar fluxo F-AAAAMMDD-NNNN');
  const fluxo = pos[0].trim().toUpperCase();
  if (!lib.RE_FLOW.test(fluxo)) throw lib.argsError(`fluxo "${pos[0]}" inválido: use o formato F-AAAAMMDD-NNNN`);
  const todos = lib.readEvents();
  const eventos = todos.filter((e) => e.fluxo_id === fluxo);
  const contador = normalizarContador(lib.readJson(lib.paths().flowCounter, null));
  const info = contador.fluxos[fluxo] || null;
  const brutos = lib.rawForFlow(fluxo, { events: eventos, allEvents: todos, start: info && info.criado_em });
  if (!eventos.length && !brutos.length && !info) {
    const e = new Error(`fluxo ${fluxo} não encontrado (nenhum evento, comando bruto ou registro no contador)`);
    e.code = 'ENAOENCONTRADO';
    throw e;
  }
  const resumo = resumirBrutos(brutos);
  if (op.json) {
    lib.print(JSON.stringify({
      fluxo,
      titulo: info ? info.titulo : null,
      agente: info ? info.agente : null,
      criado_em: info ? info.criado_em : null,
      eventos,
      comandos_brutos: brutos,
      resumo_brutos: resumo,
    }, null, 2));
    return;
  }
  lib.print(`Fluxo ${fluxo}${info && info.titulo ? ` · ${info.titulo}` : ''}`);
  if (info) {
    const d = lib.parseDate(info.criado_em);
    lib.print(`Criado em ${d ? lib.dateTimeBR(d) : '?'}${info.agente ? ` por ${info.agente}` : ''}`);
  }
  lib.print('');
  lib.print(`Eventos (${eventos.length})`);
  if (eventos.length) imprimirEventos(eventos, { mostrarFluxo: false });
  else lib.print('  (nenhum evento registrado ainda)');
  lib.print('');
  const falhas = brutos.filter((b) => b.ok === false).length;
  lib.print(`Comandos brutos (${brutos.length}${falhas ? ` · ${falhas} ${falhas === 1 ? 'falha' : 'falhas'}` : ''})`);
  if (!brutos.length) { lib.print('  (nenhum: os hooks não gravaram nada com este fluxo)'); return; }
  for (const a of resumo) {
    const ferr = Object.entries(a.ferramentas).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    const d1 = lib.parseDate(a.primeiro);
    const d2 = lib.parseDate(a.ultimo);
    lib.print(`  ${a.agente}: ${a.entradas} ${a.entradas === 1 ? 'entrada' : 'entradas'}${ferr ? ` (${ferr})` : ''}${a.falhas ? ` · ${a.falhas} ${a.falhas === 1 ? 'falha' : 'falhas'}` : ''} · ${d1 ? lib.timeBR(d1) : '?'} → ${d2 ? lib.timeBR(d2) : '?'}`);
  }
  const mostrar = brutos.length > limite ? brutos.slice(-limite) : brutos;
  if (brutos.length > limite) lib.print(`  (mostrando as ${limite} entradas mais recentes de ${brutos.length}; use --limite N ou --json para ver todas)`);
  for (const b of mostrar) {
    const d = lib.parseDate(b.ts);
    let o;
    if (b.tool) o = `${b.tool} ${b.ok === false ? 'FALHOU' : (b.ok === true ? 'ok' : b.hook_event)}  ${lib.truncate(String(b.input || '').replace(/\s+/g, ' '), 110)}`;
    else if (b.hook_event === 'UserPromptSubmit') o = `prompt  ${lib.truncate(String(b.prompt || '').replace(/\s+/g, ' '), 110)}`;
    else o = `${b.hook_event}${b.output_summary ? `  ${lib.truncate(String(b.output_summary).replace(/\s+/g, ' '), 100)}` : ''}`;
    lib.print(`  ${d ? lib.timeBR(d) : '??:??:??'}  ${b.agent}${b.agent_type ? `/${b.agent_type}` : ''}  ${o}${b.correlation === 'window' ? '  (pela janela de tempo)' : ''}`);
  }
}

// ---------------------------------------------------------------------------------- importar-pre-registro

/** Divide uma linha de tabela markdown em células (aceita \\| dentro da célula). */
function dividirLinhaTabela(linha) {
  let s = linha.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** Lê a primeira tabela markdown do texto: devolve linhas como objetos {cabeçalho: valor} (cabeçalhos sem acento). */
function lerTabelaMarkdown(texto) {
  const linhas = texto.split(/\r?\n/);
  let cabecalho = null;
  const saida = [];
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].trim();
    if (!l.startsWith('|')) {
      if (cabecalho) break; // a tabela acabou
      continue;
    }
    if (!cabecalho) {
      const prox = (linhas[i + 1] || '').trim();
      if (/^\|?\s*:?-{3,}/.test(prox)) {
        cabecalho = dividirLinhaTabela(l).map((c) => lib.normalizeEnum(c));
        i++;
      }
      continue;
    }
    const celulas = dividirLinhaTabela(l);
    const obj = {};
    cabecalho.forEach((k, j) => { obj[k] = celulas[j] !== undefined ? celulas[j] : ''; });
    obj.__linha = i + 1;
    saida.push(obj);
  }
  return { cabecalho, linhas: saida };
}

function cmdImportarPreRegistro(argv) {
  const { opts: op } = lib.parseArgs(argv, { text: ['arquivo'] });
  const arquivo = op.arquivo !== undefined ? path.resolve(op.arquivo) : lib.paths().preRegistry;
  let texto;
  try { texto = lib.decodeText(fs.readFileSync(arquivo)); } catch (e) {
    throw lib.argsError(`não consegui ler ${lib.slashes(arquivo)}: ${e.code || e.message}`);
  }
  const { cabecalho, linhas } = lerTabelaMarkdown(texto);
  if (!cabecalho) throw lib.argsError(`${lib.slashes(arquivo)} não tem uma tabela markdown (| ts | tipo | resumo | direcao | resultado |)`);
  const faltando = ['ts', 'tipo', 'resumo', 'direcao', 'resultado'].filter((c) => !cabecalho.includes(c));
  if (faltando.length) throw lib.argsError(`a tabela de ${lib.slashes(arquivo)} não tem as colunas: ${faltando.join(', ')}`);
  if (!linhas.length) throw lib.argsError(`a tabela de ${lib.slashes(arquivo)} não tem linhas`);
  const cadastro = lib.loadAgentsSafe();
  const prontos = [];
  const problemas = [];
  for (const l of linhas) {
    const tipoOriginal = lib.normalizeEnum(l.tipo);
    const dados = {
      ts: l.ts,
      agente: 'cerebro',
      fluxo_id: FLUXO_BOOTSTRAP,
      origem: 'dono-direto',
      tipo: 'bootstrap',
      resumo: l.resumo,
      direcao: l.direcao || undefined,
      resultado: l.resultado,
      tipo_original: tipoOriginal,
      importado_de: 'pre-registro',
    };
    const p = [];
    if (!lib.EVENT_TYPES.includes(tipoOriginal)) p.push(`tipo original "${l.tipo}" não é um tipo permitido`);
    const d = lib.parseDate(l.ts);
    const semente = `${d ? lib.isoSP(d) : l.ts}|${tipoOriginal}|${l.resumo}`;
    const r = lib.buildEvent(dados, { env: {}, registry: cadastro, seed: semente });
    p.push(...r.problems);
    if (p.length) problemas.push(...p.map((x) => `linha ${l.__linha}: ${x}`));
    else prontos.push(r.event);
  }
  if (problemas.length) throw lib.validationError(problemas, `${lib.slashes(arquivo)} tem linhas inválidas; nada foi importado`);
  const chave = (e) => `${e.ts}|${e.tipo_original}|${e.resumo}`;
  const novos = [];
  let repetidos = 0;
  // Trava própria: duas importações ao mesmo tempo não duplicam eventos.
  fs.mkdirSync(lib.paths().legacyState, { recursive: true });
  lib.withLock(path.join(lib.paths().legacyState, 'importacao-pre-registro'), () => {
    // Primeiro o contador: o dia do bootstrap fica em pelo menos 1 e o fluxo reservado ganha o título.
    // Se F-20261008-0001 já for de OUTRO fluxo (criado antes desta correção), recusa sem gravar nada:
    // misturar os eventos do bootstrap com os de um pedido real não tem volta.
    lib.updateJson(lib.paths().flowCounter, (atual) => {
      const c = normalizarContador(atual);
      const f = c.fluxos[FLUXO_BOOTSTRAP] && typeof c.fluxos[FLUXO_BOOTSTRAP] === 'object' ? c.fluxos[FLUXO_BOOTSTRAP] : null;
      if (f && (f.titulo !== TITULO_BOOTSTRAP || (f.agente && f.agente !== 'cerebro'))) {
        throw lib.validationError([
          `${FLUXO_BOOTSTRAP} já pertence a outro fluxo: título ${f.titulo ? `"${f.titulo}"` : '(sem título)'}, agente ${f.agente || '?'}, criado em ${f.criado_em || '?'}`,
          `o id ${FLUXO_BOOTSTRAP} é reservado ao bootstrap; misturar os eventos não tem volta`,
          'resolva à mão: renumere esse fluxo (contador-fluxos.json e os eventos dele) ou peça ao Cérebro para decidir; depois rode a importação de novo',
        ], 'Nada foi importado');
      }
      c.dias[DIA_BOOTSTRAP] = Math.max(Number(c.dias[DIA_BOOTSTRAP]) || 0, 1);
      c.fluxos[FLUXO_BOOTSTRAP] = {
        titulo: TITULO_BOOTSTRAP,
        agente: 'cerebro',
        criado_em: (f && f.criado_em) || (prontos[0] ? prontos[0].ts : lib.isoSP(lib.now())),
      };
      return c;
    }, { initial: CONTADOR_INICIAL, backup: true });
    const existentes = new Set(lib.readEvents().filter((e) => e.importado_de === 'pre-registro').map(chave));
    for (const ev of prontos) {
      if (existentes.has(chave(ev))) { repetidos++; continue; }
      lib.writeEvent(ev);
      existentes.add(chave(ev));
      novos.push(ev);
    }
  });
  for (const ev of novos) lib.print(ev.id);
  lib.print(`Importados ${novos.length} de ${prontos.length} eventos de ${path.basename(arquivo)} (${repetidos} já existiam) no fluxo ${FLUXO_BOOTSTRAP} · ${TITULO_BOOTSTRAP}.`);
}

// ---------------------------------------------------------------------------------- principal

const SUBCOMANDOS = {
  'novo-fluxo': cmdNovoFluxo,
  evento: cmdEvento,
  ultimos: cmdUltimos,
  fluxo: cmdFluxo,
  'importar-pre-registro': cmdImportarPreRegistro,
};

function principal() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.some((a) => a === '--help' || a === '-h') || ['ajuda', 'help'].includes(argv[0])) {
    lib.print(AJUDA);
    if (!argv.length) process.exitCode = 2;
    return;
  }
  const sub = SUBCOMANDOS[argv[0]];
  if (!sub) throw lib.argsError(`subcomando desconhecido: ${argv[0]} (use: ${Object.keys(SUBCOMANDOS).join(', ')}; veja --help)`);
  sub(argv.slice(1));
}

if (require.main === module) lib.runCommand(principal);

module.exports = { lerTabelaMarkdown, dividirLinhaTabela, normalizarContador };
