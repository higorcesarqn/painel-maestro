#!/usr/bin/env node
'use strict';
// registrar · CLI do log semântico e dos fluxos do workspace (Node.js, só biblioteca padrão).
// Subcomandos: novo-fluxo, evento, ultimos, fluxo, importar-pre-registro.
// Códigos de saída: 0 ok · 2 validação · 3 trava esgotada · 1 outros.
const fs = require('fs');
const path = require('path');
const lib = require('./lib_maestro');

const CMD = `node ${lib.barras(path.join(__dirname, 'registrar.js'))}`;
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
      --trello-shortlink X   --trello-titulo "..."   --trello-url U   --status-antes S   --status-depois S
      --passo "..."   --comando "..."   --alteracao "..."   --pendencia P-NNNN      (repetíveis)
      --validacao "..."   --proximo-passo "..."   --precisa-dono   --duracao SEGUNDOS   --teste
      --json '<objeto>'      evento completo em JSON (opções da linha de comando têm prioridade)
      --json -               o JSON vem pela entrada padrão
      --json-arquivo C       o JSON vem de um arquivo (UTF-8; aceita BOM e UTF-16 do PowerShell 5)
      Campos do JSON: agente, fluxo_id, origem, tipo, projeto, trello{shortLink,titulo,url,status_antes,
      status_depois}, resumo, direcao, passos[], comandos[], alteracoes[], resultado, validacao,
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
  tipo        ${lib.TIPOS_EVENTO.join(', ')}
  resultado   ${lib.RESULTADOS.join(', ')}
  resumo      até ${lib.MAX_RESUMO} caracteres, uma linha, começando por verbo ou substantivo concreto
  (acentos são aceitos e normalizados: "execução" vira "execucao")

CÓDIGOS DE SAÍDA
  0 ok · 2 validação (lista cada problema) · 3 trava esgotada · 1 outros erros

EXEMPLOS
  ${CMD} novo-fluxo --titulo "Auditoria semanal do Trello"
  ${CMD} evento --fluxo F-20261008-0002 --origem dono-direto --tipo pedido-recebido --resumo "Pedido do dono: auditar o quadro" --resultado em-andamento
  ${CMD} evento --origem cerebro --tipo delegacao --resumo "Delegada a auditoria ao Coordenador do Trello" --direcao "Trello é domínio do Coordenador; mandei [PEDIDO] com autonomia só de leitura." --resultado em-andamento
  ${CMD} evento --origem cerebro --tipo execucao --resumo "RST gerado: 13 abertas, 11 alertas" --direcao "Li o JSON do quadro porque traz espelhos e checklists numa leitura só." --resultado ok --passo "Li o quadro" --passo "Gerei o RST" --duracao 48
  ${CMD} evento --json-arquivo C:/Temp/ev.json                              (PowerShell: o melhor caminho)
  ${CMD} evento --json - < /c/Temp/ev.json                                 (Git Bash)
  MSYS2_ARG_CONV_EXCL='*' ${CMD} evento --resumo "/compact rodado" ...                                    (Git Bash, texto começando por /)
  (No Windows PowerShell 5, o pipe "Get-Content ... | node" troca acentos e emoji por "?": prefira --json-arquivo
   ou rode antes $OutputEncoding = [Text.UTF8Encoding]::new($false).)
  ${CMD} ultimos --horas 4 --agente coordenador-trello
  ${CMD} fluxo F-20261008-0002
  ${CMD} importar-pre-registro
`;

// ---------------------------------------------------------------------------------- utilidades

/** Agente padrão deste terminal; avisa quando não dá para identificar. */
function agentePadrao() {
  const id = lib.identificarAgente();
  if (!id.conhecido) lib.avisar(`aviso: agente não identificado (${id.agente}); use --agente <slug> para registrar em nome de um agente do registro`);
  return id.agente;
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
  if (!Number.isFinite(n) || n < 0) throw lib.erroArgs(`--duracao espera um número de segundos (recebi "${texto}")`);
  return n;
}

/** Linhas de texto de um evento para "ultimos" e "fluxo". */
function linhasDoEvento(ev, { mostrarFluxo = true } = {}) {
  const d = lib.lerData(ev.ts);
  const partes = [ev.agente];
  if (mostrarFluxo) partes.push(ev.fluxo_id);
  partes.push(ev.tipo, ev.resultado);
  let cab = `${d ? lib.horaBR(d) : '??:??:??'}  ${partes.join(' · ')}`;
  if (ev.teste) cab += ' · [teste]';
  if (ev.precisa_dono) cab += ' · ⚠ precisa do dono';
  const linhas = [cab, `          ${ev.resumo}`];
  if (ev.direcao) linhas.push(`          direção: ${lib.truncar(String(ev.direcao).replace(/\s+/g, ' '), 160)}`);
  if (ev.trello && (ev.trello.titulo || ev.trello.shortLink || ev.trello.url)) {
    linhas.push(`          trello: ${[ev.trello.titulo, ev.trello.url || ev.trello.shortLink].filter(Boolean).join(' · ')}`);
  }
  if (Array.isArray(ev.pendencias) && ev.pendencias.length) linhas.push(`          pendências: ${ev.pendencias.join(', ')}`);
  if (ev.proximo_passo) linhas.push(`          próximo passo: ${lib.truncar(String(ev.proximo_passo).replace(/\s+/g, ' '), 160)}`);
  return linhas;
}

/** Imprime eventos agrupados por dia (separador "── quinta-feira, 08/10/2026 ──"). */
function imprimirEventos(eventos, opcoes) {
  let diaAtual = null;
  for (const ev of eventos) {
    const d = lib.lerData(ev.ts);
    const dia = d ? lib.dataBR(d) : '?';
    if (dia !== diaAtual) {
      diaAtual = dia;
      lib.escrever(`── ${d ? lib.diaPorExtenso(d) : 'data inválida'} ──`);
    }
    for (const l of linhasDoEvento(ev, opcoes)) lib.escrever(l);
  }
}

// ---------------------------------------------------------------------------------- novo-fluxo

function cmdNovoFluxo(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['titulo', 'agente'] });
  const quando = lib.agora();
  const iso = lib.isoSP(quando);
  const dia = lib.carimbosSP(quando).compacto;
  const agente = op.agente !== undefined ? op.agente.trim() : agentePadrao();
  const problemas = lib.problemasDoAgente(agente, lib.carregarAgentesSeguro());
  const titulo = op.titulo !== undefined ? op.titulo.replace(/\s+/g, ' ').trim() : null;
  if (op.titulo !== undefined && !titulo) problemas.push('--titulo veio vazio');
  if (problemas.length) throw lib.erroValidacao(problemas, 'Não criei o fluxo');
  let id = null;
  lib.atualizarJson(lib.caminhos().contadorFluxos, (atual) => {
    const c = normalizarContador(atual);
    // F-20261008-0001 é do bootstrap: nesse dia o contador começa em 0002 mesmo antes da importação.
    const n = Math.max(Number(c.dias[dia]) || 0, dia === DIA_BOOTSTRAP ? 1 : 0) + 1;
    c.dias[dia] = n;
    id = `F-${dia}-${String(n).padStart(4, '0')}`;
    c.fluxos[id] = { titulo, agente, criado_em: iso };
    return c;
  }, { inicial: CONTADOR_INICIAL, backup: true });
  // A sessão do Claude Code que criou o fluxo passa a trabalhar nele: os comandos seguintes (log bruto)
  // e os eventos sem --fluxo herdam o id, mesmo que o prompt não tenha trazido um F-....
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (lib.idSessaoSeguro(sid)) {
    try {
      lib.atualizarSessao(sid, (s) => ({
        ...(s && typeof s === 'object' ? s : { session_id: sid, agente, terminal: process.env.MAESTRI_TERMINAL_ID || null, iniciado_em: iso }),
        fluxo_id: id,
        fluxo_desde: iso,
        visto_em: iso,
      }), { tempoMaximoMs: 3000 });
    } catch (e) {
      lib.avisar(`aviso: o fluxo ${id} foi criado, mas não consegui ligá-lo à sessão (${e.message}); use --fluxo ${id} nos eventos`);
    }
  }
  lib.escrever(id);
}

// ---------------------------------------------------------------------------------- evento

const MAPA_TEXTO = {
  agente: 'agente', fluxo: 'fluxo_id', origem: 'origem', tipo: 'tipo', resumo: 'resumo', direcao: 'direcao',
  resultado: 'resultado', projeto: 'projeto', validacao: 'validacao', 'proximo-passo': 'proximo_passo',
};
const MAPA_LISTA = { passo: 'passos', comando: 'comandos', alteracao: 'alteracoes', pendencia: 'pendencias' };
const MAPA_TRELLO = {
  'trello-shortlink': 'shortLink', 'trello-titulo': 'titulo', 'trello-url': 'url', 'status-antes': 'status_antes', 'status-depois': 'status_depois',
};

function cmdEvento(argv) {
  const { op } = lib.lerArgumentos(argv, {
    texto: [...Object.keys(MAPA_TEXTO), ...Object.keys(MAPA_TRELLO), 'duracao', 'json', 'json-arquivo'],
    lista: Object.keys(MAPA_LISTA),
    bool: ['precisa-dono', 'teste'],
  });
  if (op.json !== undefined && op['json-arquivo'] !== undefined) throw lib.erroArgs('use --json ou --json-arquivo, não os dois');
  let ev = {};
  if (op.json !== undefined) ev = op.json === '-' ? lib.lerJsonDoStdin() : lib.lerObjetoJson(op.json, '--json');
  if (op['json-arquivo'] !== undefined) ev = lib.lerJsonDeArquivo(op['json-arquivo']);
  ev = { ...ev };
  for (const [flag, campo] of Object.entries(MAPA_TEXTO)) if (op[flag] !== undefined) ev[campo] = op[flag];
  for (const [flag, campo] of Object.entries(MAPA_LISTA)) if (op[flag] !== undefined) ev[campo] = op[flag];
  const temTrello = Object.keys(MAPA_TRELLO).some((f) => op[f] !== undefined);
  if (temTrello) {
    const t = ev.trello && typeof ev.trello === 'object' && !Array.isArray(ev.trello) ? { ...ev.trello } : {};
    for (const [flag, campo] of Object.entries(MAPA_TRELLO)) if (op[flag] !== undefined) t[campo] = op[flag];
    ev.trello = t;
  }
  if (op['precisa-dono'] !== undefined) ev.precisa_dono = op['precisa-dono'];
  if (op.teste !== undefined) ev.teste = op.teste;
  if (op.duracao !== undefined) ev.duracao_s = lerDuracao(op.duracao);
  // Padrões: agente deste terminal e fluxo da sessão.
  if (ev.agente === undefined) ev.agente = agentePadrao();
  let semFluxo = false;
  if (ev.fluxo_id === undefined) {
    const f = lib.fluxoDaSessao(process.env.CLAUDE_CODE_SESSION_ID);
    if (f) ev.fluxo_id = f;
    else semFluxo = true;
  }
  const { evento, problemas } = lib.montarEvento(ev);
  if (problemas.length) {
    const lista = semFluxo
      ? problemas.map((p) => (p === 'falta o campo obrigatório "fluxo_id"' ? lib.mensagemSemFluxo(process.env.CLAUDE_CODE_SESSION_ID) : p))
      : problemas;
    throw lib.erroValidacao(lista, 'Evento inválido, nada foi gravado');
  }
  lib.gravarEvento(evento);
  lib.escrever(evento.id);
}

// ---------------------------------------------------------------------------------- ultimos

/** Lê --limite N (inteiro >= 1); "padrao" quando ausente. */
function lerLimite(op, padrao) {
  if (op.limite === undefined) return padrao;
  const n = Number(op.limite);
  if (!Number.isInteger(n) || n < 1) throw lib.erroArgs(`--limite espera um número inteiro maior que zero (recebi "${op.limite}")`);
  return n;
}

function cmdUltimos(argv) {
  const { op } = lib.lerArgumentos(argv, { texto: ['horas', 'agente', 'fluxo', 'tipo', 'limite'], bool: ['incluir-testes', 'json'] });
  let horas = 24;
  if (op.horas !== undefined) {
    horas = Number(String(op.horas).replace(',', '.'));
    if (!Number.isFinite(horas) || horas <= 0) throw lib.erroArgs(`--horas espera um número maior que zero (recebi "${op.horas}")`);
  }
  const limite = lerLimite(op, op.json ? Infinity : 30);
  const tipo = op.tipo !== undefined ? lib.normalizarEnum(op.tipo) : undefined;
  if (tipo !== undefined && !lib.TIPOS_EVENTO.includes(tipo)) throw lib.erroArgs(`--tipo "${op.tipo}" não existe (use: ${lib.TIPOS_EVENTO.join(', ')})`);
  if (op.agente !== undefined) {
    const p = lib.problemasDoAgente(op.agente.trim(), lib.carregarAgentesSeguro(), '--agente');
    if (p.length) throw lib.erroArgs(p.join('; '));
  }
  const fluxo = op.fluxo !== undefined ? op.fluxo.trim().toUpperCase() : undefined;
  if (fluxo !== undefined && !lib.RE_FLUXO.test(fluxo)) throw lib.erroArgs(`--fluxo "${op.fluxo}" inválido: use o formato F-AAAAMMDD-NNNN`);
  const fim = lib.agora();
  const inicio = new Date(fim.getTime() - horas * 3600e3);
  const eventos = lib.lerEventos({ desde: inicio }).filter((e) => {
    const d = lib.lerData(e.ts);
    if (!d || d < inicio) return false;
    if (!op['incluir-testes'] && e.teste === true) return false;
    if (op.agente !== undefined && e.agente !== op.agente.trim()) return false;
    if (fluxo !== undefined && e.fluxo_id !== fluxo) return false;
    if (tipo !== undefined && e.tipo !== tipo) return false;
    return true;
  });
  const mostrar = eventos.length > limite ? eventos.slice(-limite) : eventos; // os mais recentes
  if (op.json) { lib.escrever(JSON.stringify(mostrar, null, 2)); return; }
  const rotulo = Number.isInteger(horas) ? `${horas} h` : `${String(horas).replace('.', ',')} h`;
  if (!eventos.length) { lib.escrever(`Nenhum evento nas últimas ${rotulo}.`); return; }
  lib.escrever(`Eventos das últimas ${rotulo} (${eventos.length}):`);
  if (mostrar.length < eventos.length) lib.escrever(`(mostrando os ${mostrar.length} mais recentes de ${eventos.length}; use --limite N ou --json)`);
  imprimirEventos(mostrar);
}

// ---------------------------------------------------------------------------------- fluxo

/** Resumo dos comandos brutos por agente: total, falhas, ferramentas, primeiro e último horário. */
function resumirBrutos(brutos) {
  const porAgente = {};
  for (const b of brutos) {
    const a = porAgente[b.agente] || (porAgente[b.agente] = { agente: b.agente, entradas: 0, ferramentas: {}, falhas: 0, prompts: 0, primeiro: b.ts, ultimo: b.ts });
    a.entradas++;
    if (b.ferramenta && (b.evento === 'PostToolUse' || b.evento === 'PostToolUseFailure')) a.ferramentas[b.ferramenta] = (a.ferramentas[b.ferramenta] || 0) + 1;
    if (b.ok === false) a.falhas++;
    if (b.evento === 'UserPromptSubmit') a.prompts++;
    a.ultimo = b.ts;
  }
  return Object.values(porAgente);
}

function cmdFluxo(argv) {
  const { op, pos } = lib.lerArgumentos(argv, { texto: ['limite'], bool: ['json'] }, { maxPosicionais: 1 });
  const limite = lerLimite(op, 50);
  if (!pos.length) throw lib.erroArgs('informe o fluxo: registrar fluxo F-AAAAMMDD-NNNN');
  const fluxo = pos[0].trim().toUpperCase();
  if (!lib.RE_FLUXO.test(fluxo)) throw lib.erroArgs(`fluxo "${pos[0]}" inválido: use o formato F-AAAAMMDD-NNNN`);
  const todos = lib.lerEventos();
  const eventos = todos.filter((e) => e.fluxo_id === fluxo);
  const contador = normalizarContador(lib.lerJson(lib.caminhos().contadorFluxos, null));
  const info = contador.fluxos[fluxo] || null;
  const brutos = lib.brutosDoFluxo(fluxo, { eventos, todosEventos: todos, inicio: info && info.criado_em });
  if (!eventos.length && !brutos.length && !info) {
    const e = new Error(`fluxo ${fluxo} não encontrado (nenhum evento, comando bruto ou registro no contador)`);
    e.code = 'ENAOENCONTRADO';
    throw e;
  }
  const resumo = resumirBrutos(brutos);
  if (op.json) {
    lib.escrever(JSON.stringify({
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
  lib.escrever(`Fluxo ${fluxo}${info && info.titulo ? ` · ${info.titulo}` : ''}`);
  if (info) {
    const d = lib.lerData(info.criado_em);
    lib.escrever(`Criado em ${d ? lib.dataHoraBR(d) : '?'}${info.agente ? ` por ${info.agente}` : ''}`);
  }
  lib.escrever('');
  lib.escrever(`Eventos (${eventos.length})`);
  if (eventos.length) imprimirEventos(eventos, { mostrarFluxo: false });
  else lib.escrever('  (nenhum evento registrado ainda)');
  lib.escrever('');
  const falhas = brutos.filter((b) => b.ok === false).length;
  lib.escrever(`Comandos brutos (${brutos.length}${falhas ? ` · ${falhas} ${falhas === 1 ? 'falha' : 'falhas'}` : ''})`);
  if (!brutos.length) { lib.escrever('  (nenhum: os hooks não gravaram nada com este fluxo)'); return; }
  for (const a of resumo) {
    const ferr = Object.entries(a.ferramentas).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    const d1 = lib.lerData(a.primeiro);
    const d2 = lib.lerData(a.ultimo);
    lib.escrever(`  ${a.agente}: ${a.entradas} ${a.entradas === 1 ? 'entrada' : 'entradas'}${ferr ? ` (${ferr})` : ''}${a.falhas ? ` · ${a.falhas} ${a.falhas === 1 ? 'falha' : 'falhas'}` : ''} · ${d1 ? lib.horaBR(d1) : '?'} → ${d2 ? lib.horaBR(d2) : '?'}`);
  }
  const mostrar = brutos.length > limite ? brutos.slice(-limite) : brutos;
  if (brutos.length > limite) lib.escrever(`  (mostrando as ${limite} entradas mais recentes de ${brutos.length}; use --limite N ou --json para ver todas)`);
  for (const b of mostrar) {
    const d = lib.lerData(b.ts);
    let o;
    if (b.ferramenta) o = `${b.ferramenta} ${b.ok === false ? 'FALHOU' : (b.ok === true ? 'ok' : b.evento)}  ${lib.truncar(String(b.entrada || '').replace(/\s+/g, ' '), 110)}`;
    else if (b.evento === 'UserPromptSubmit') o = `prompt  ${lib.truncar(String(b.prompt || '').replace(/\s+/g, ' '), 110)}`;
    else o = `${b.evento}${b.saida_resumo ? `  ${lib.truncar(String(b.saida_resumo).replace(/\s+/g, ' '), 100)}` : ''}`;
    lib.escrever(`  ${d ? lib.horaBR(d) : '??:??:??'}  ${b.agente}${b.agent_type ? `/${b.agent_type}` : ''}  ${o}${b.correlacao === 'janela' ? '  (pela janela de tempo)' : ''}`);
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
        cabecalho = dividirLinhaTabela(l).map((c) => lib.normalizarEnum(c));
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
  const { op } = lib.lerArgumentos(argv, { texto: ['arquivo'] });
  const arquivo = op.arquivo !== undefined ? path.resolve(op.arquivo) : lib.caminhos().preRegistro;
  let texto;
  try { texto = lib.decodificarTexto(fs.readFileSync(arquivo)); } catch (e) {
    throw lib.erroArgs(`não consegui ler ${lib.barras(arquivo)}: ${e.code || e.message}`);
  }
  const { cabecalho, linhas } = lerTabelaMarkdown(texto);
  if (!cabecalho) throw lib.erroArgs(`${lib.barras(arquivo)} não tem uma tabela markdown (| ts | tipo | resumo | direcao | resultado |)`);
  const faltando = ['ts', 'tipo', 'resumo', 'direcao', 'resultado'].filter((c) => !cabecalho.includes(c));
  if (faltando.length) throw lib.erroArgs(`a tabela de ${lib.barras(arquivo)} não tem as colunas: ${faltando.join(', ')}`);
  if (!linhas.length) throw lib.erroArgs(`a tabela de ${lib.barras(arquivo)} não tem linhas`);
  const cadastro = lib.carregarAgentesSeguro();
  const prontos = [];
  const problemas = [];
  for (const l of linhas) {
    const tipoOriginal = lib.normalizarEnum(l.tipo);
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
    if (!lib.TIPOS_EVENTO.includes(tipoOriginal)) p.push(`tipo original "${l.tipo}" não é um tipo permitido`);
    const d = lib.lerData(l.ts);
    const semente = `${d ? lib.isoSP(d) : l.ts}|${tipoOriginal}|${l.resumo}`;
    const r = lib.montarEvento(dados, { env: {}, cadastro, semente });
    p.push(...r.problemas);
    if (p.length) problemas.push(...p.map((x) => `linha ${l.__linha}: ${x}`));
    else prontos.push(r.evento);
  }
  if (problemas.length) throw lib.erroValidacao(problemas, `${lib.barras(arquivo)} tem linhas inválidas; nada foi importado`);
  const chave = (e) => `${e.ts}|${e.tipo_original}|${e.resumo}`;
  const novos = [];
  let repetidos = 0;
  // Trava própria: duas importações ao mesmo tempo não duplicam eventos.
  fs.mkdirSync(lib.caminhos().estado, { recursive: true });
  lib.comTrava(path.join(lib.caminhos().estado, 'importacao-pre-registro'), () => {
    // Primeiro o contador: o dia do bootstrap fica em pelo menos 1 e o fluxo reservado ganha o título.
    // Se F-20261008-0001 já for de OUTRO fluxo (criado antes desta correção), recusa sem gravar nada:
    // misturar os eventos do bootstrap com os de um pedido real não tem volta.
    lib.atualizarJson(lib.caminhos().contadorFluxos, (atual) => {
      const c = normalizarContador(atual);
      const f = c.fluxos[FLUXO_BOOTSTRAP] && typeof c.fluxos[FLUXO_BOOTSTRAP] === 'object' ? c.fluxos[FLUXO_BOOTSTRAP] : null;
      if (f && (f.titulo !== TITULO_BOOTSTRAP || (f.agente && f.agente !== 'cerebro'))) {
        throw lib.erroValidacao([
          `${FLUXO_BOOTSTRAP} já pertence a outro fluxo: título ${f.titulo ? `"${f.titulo}"` : '(sem título)'}, agente ${f.agente || '?'}, criado em ${f.criado_em || '?'}`,
          `o id ${FLUXO_BOOTSTRAP} é reservado ao bootstrap; misturar os eventos não tem volta`,
          'resolva à mão: renumere esse fluxo (contador-fluxos.json e os eventos dele) ou peça ao Cérebro para decidir; depois rode a importação de novo',
        ], 'Nada foi importado');
      }
      c.dias[DIA_BOOTSTRAP] = Math.max(Number(c.dias[DIA_BOOTSTRAP]) || 0, 1);
      c.fluxos[FLUXO_BOOTSTRAP] = {
        titulo: TITULO_BOOTSTRAP,
        agente: 'cerebro',
        criado_em: (f && f.criado_em) || (prontos[0] ? prontos[0].ts : lib.isoSP(lib.agora())),
      };
      return c;
    }, { inicial: CONTADOR_INICIAL, backup: true });
    const existentes = new Set(lib.lerEventos().filter((e) => e.importado_de === 'pre-registro').map(chave));
    for (const ev of prontos) {
      if (existentes.has(chave(ev))) { repetidos++; continue; }
      lib.gravarEvento(ev);
      existentes.add(chave(ev));
      novos.push(ev);
    }
  });
  for (const ev of novos) lib.escrever(ev.id);
  lib.escrever(`Importados ${novos.length} de ${prontos.length} eventos de ${path.basename(arquivo)} (${repetidos} já existiam) no fluxo ${FLUXO_BOOTSTRAP} · ${TITULO_BOOTSTRAP}.`);
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
    lib.escrever(AJUDA);
    if (!argv.length) process.exitCode = 2;
    return;
  }
  const sub = SUBCOMANDOS[argv[0]];
  if (!sub) throw lib.erroArgs(`subcomando desconhecido: ${argv[0]} (use: ${Object.keys(SUBCOMANDOS).join(', ')}; veja --help)`);
  sub(argv.slice(1));
}

if (require.main === module) lib.executarComando(principal);

module.exports = { lerTabelaMarkdown, dividirLinhaTabela, normalizarContador };
