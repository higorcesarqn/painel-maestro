#!/usr/bin/env node
'use strict';
// pendencia · fila de pendências do dono do workspace (decisões que só ele pode tomar).
// Ids P-NNNN globais em estado/pendencias.json (campo "proximo", com trava). Cada ação grava o evento
// correspondente no log semântico. Subcomandos: abrir, listar, mostrar, responder, resolver, cancelar.
// Códigos de saída: 0 ok · 2 validação · 3 trava esgotada · 1 outros.
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

const CMD = `node ${lib.slashes(path.join(__dirname, 'pendencia.js'))}`;
const SEVERIDADES = ['critica', 'alta', 'normal', 'baixa'];
const TIPOS = ['aprovacao', 'decisao', 'informacao-faltando', 'revisao'];
const STATUS = ['aberta', 'respondida', 'resolvida', 'cancelada'];
const ABERTAS = ['aberta', 'respondida'];
const CAMPOS_ENTRADA = ['agente', 'fluxo_id', 'severidade', 'tipo', 'titulo', 'contexto', 'opcoes', 'recomendacao', 'teste'];
const INICIAL = { proximo: 1, pendencias: [] };

const AJUDA = `pendencia · fila de pendências do dono (estado/pendencias.json; cada ação também vira evento no log)

Forma canônica (funciona igual no Git Bash, no PowerShell e no cmd):
  ${CMD} <subcomando> [opções]
Atalhos: bin/pendencia (Git Bash) e bin/pendencia.cmd (PowerShell/cmd; o .cmd estraga ^, %VAR% e aspas internas).
ATENÇÃO Git Bash: na forma "node .../pendencia.js", todo argumento que começa com "/" vira caminho do Windows
("/tmp/x" chega como "C:/.../Temp/x"). Use o atalho bin/pendencia (já desliga a conversão), ponha
MSYS2_ARG_CONV_EXCL='*' na frente do comando, ou mande o JSON por --json -.

SUBCOMANDOS

  abrir --tipo T --titulo "..." --contexto "..." [opções]
      Cria P-NNNN (status aberta), grava o evento pendencia-aberta (aguardando-dono, precisa_dono) e imprime o id.
      --severidade S        critica | alta | normal | baixa (padrão: normal). Crítica tenta "maestri notify"
                            (só funciona no terminal Maestro) e sempre imprime um aviso.
      --tipo T              aprovacao | decisao | informacao-faltando | revisao
      --opcao "A: ..."      repetível (2 a 4 opções, mutuamente exclusivas, cada uma com a consequência)
      --recomendacao "..."  qual opção e por quê, em uma frase
      --agente S            padrão: o agente deste terminal
      --fluxo F             padrão: o fluxo da sessão atual (CLAUDE_CODE_SESSION_ID); erro se não houver
      --origem O            origem do evento (padrão: cerebro para o Cérebro, agente:<slug> para os outros)
      --teste               marca a pendência e os eventos como teste (o painel esconde)
      --json - | --json '<objeto>'  pendência em JSON (campos: ${CAMPOS_ENTRADA.join(', ')})
      --json-arquivo C      o JSON vem de um arquivo (UTF-8 ou UTF-16 com BOM; o melhor caminho no PowerShell)

  listar [--abertas | --todas] [--severidade S] [--agente S] [--incluir-testes] [--json]
      Padrão: abertas e respondidas, por severidade (crítica primeiro) e idade (mais antiga primeiro).

  mostrar P-NNNN [--json]
      Tudo sobre a pendência: contexto, opções, recomendação, resposta, datas.

  responder P-NNNN --resposta "..." [--agente S]
      Guarda a resposta do dono (status respondida) e grava um evento decisao com origem dono-direto.

  resolver P-NNNN [--nota "..."] [--agente S] [--origem O]
      Fecha (status resolvida) e grava o evento pendencia-resolvida.

  cancelar P-NNNN --motivo "..." [--agente S] [--origem O]
      Fecha sem execução (status cancelada) e grava o evento pendencia-resolvida.

  O id aceita P-0003, p-3 ou 3.

CÓDIGOS DE SAÍDA
  0 ok · 2 validação (lista cada problema) · 3 trava esgotada · 1 outros erros

EXEMPLOS
  ${CMD} abrir --fluxo F-20261008-0007 --severidade alta --tipo decisao --titulo "Cometa: definir o nome do pacote" --contexto "O repositório usa um nome e o pacote publicado usa outro." --opcao "A: renomear o pacote para cometa" --opcao "B: manter cometa-core" --recomendacao "A, porque segue o nome do repositório."
  ${CMD} abrir --json - < /c/Temp/p.json      (Git Bash)
  $OutputEncoding = [Text.UTF8Encoding]::new($false); Get-Content C:/Temp/p.json -Encoding utf8 | ${CMD} abrir --json -      (PowerShell; sem o $OutputEncoding, o PowerShell 5 troca acentos e emoji por "?")
  ${CMD} listar
  ${CMD} listar --todas --severidade alta
  ${CMD} mostrar P-0003
  ${CMD} responder P-0003 --resposta "Opção A"
  ${CMD} resolver P-0003 --nota "Pacote renomeado; conferi a publicação às 16:10"
  ${CMD} cancelar P-0004 --motivo "O dono desistiu do projeto"
`;

// ---------------------------------------------------------------------------------- utilidades

/** Corta texto para caber no resumo de evento (100 caracteres, uma linha). */
function cortarResumo(texto) {
  const cps = [...String(texto).replace(/\s+/g, ' ').trim()];
  return cps.length <= lib.MAX_SUMMARY ? cps.join('') : `${cps.slice(0, lib.MAX_SUMMARY - 1).join('')}…`;
}

/** Aceita P-0003, p-3 ou 3 e devolve P-0003. */
function normalizarId(texto) {
  const m = /^\s*(?:P-?)?(\d+)\s*$/i.exec(String(texto || ''));
  if (!m) throw lib.argsError(`id de pendência inválido: "${texto}" (use P-NNNN)`);
  return `P-${String(Number(m[1])).padStart(4, '0')}`;
}

/** Origem padrão do evento de quem age: cerebro para o Cérebro, agente:<slug> para os outros. */
function origemPadrao(agente) {
  if (agente === 'cerebro') return 'cerebro';
  return lib.RE_SLUG.test(agente) ? `agente:${agente}` : 'sistema';
}

/** Agente deste terminal (avisa se não dá para identificar). */
function agentePadrao() {
  const id = lib.identifyAgent();
  if (!id.known) lib.warn(`aviso: agente não identificado (${id.agent}); use --agente <slug>`);
  return id.agent;
}

/** Estrutura do arquivo com os campos esperados (e "proximo" coerente com os ids existentes). */
function normalizarArquivo(dados) {
  const d = dados && typeof dados === 'object' && !Array.isArray(dados) ? { ...dados } : { ...INICIAL };
  d.pendencias = Array.isArray(d.pendencias) ? d.pendencias : [];
  const maior = d.pendencias.reduce((m, p) => {
    const x = /^P-(\d+)$/.exec(p && p.id);
    return x ? Math.max(m, Number(x[1])) : m;
  }, 0);
  d.proximo = Math.max(Number.isInteger(d.proximo) && d.proximo > 0 ? d.proximo : 1, maior + 1);
  return d;
}

/** Lê o arquivo de pendências (sem trava, só leitura). */
function lerPendencias() {
  return normalizarArquivo(lib.readJson(lib.paths().pendingDecisions, INICIAL));
}

/** Valida os dados de uma pendência nova; devolve a lista de problemas. */
function validarNova(p, cadastro) {
  const problemas = [];
  for (const k of Object.keys(p)) if (!CAMPOS_ENTRADA.includes(k)) problemas.push(`campo desconhecido "${k}" (aceitos: ${CAMPOS_ENTRADA.join(', ')})`);
  for (const k of ['agente', 'fluxo_id', 'severidade', 'tipo', 'titulo', 'contexto']) {
    if (!lib.isFilled(p[k])) problemas.push(`falta o campo obrigatório "${k}"`);
  }
  if (lib.isFilled(p.agente)) problemas.push(...lib.agentProblems(p.agente, cadastro));
  if (lib.isFilled(p.fluxo_id) && !lib.RE_FLOW.test(p.fluxo_id)) problemas.push(`fluxo_id "${p.fluxo_id}" inválido: use o formato F-AAAAMMDD-NNNN`);
  if (lib.isFilled(p.severidade) && !SEVERIDADES.includes(p.severidade)) problemas.push(`severidade "${p.severidade}" não é permitida (use: ${SEVERIDADES.join(', ')})`);
  if (lib.isFilled(p.tipo) && !TIPOS.includes(p.tipo)) problemas.push(`tipo "${p.tipo}" não é permitido (use: ${TIPOS.join(', ')})`);
  if (typeof p.titulo === 'string' && /[\r\n]/.test(p.titulo)) problemas.push('"titulo" deve ter uma linha só');
  for (const k of ['agente', 'fluxo_id', 'severidade', 'tipo', 'titulo', 'contexto']) {
    if (p[k] !== undefined && typeof p[k] !== 'string') problemas.push(`"${k}" deve ser texto`);
  }
  if (p.opcoes !== undefined && (!Array.isArray(p.opcoes) || p.opcoes.some((x) => !lib.isFilled(x)))) problemas.push('"opcoes" deve ser uma lista de textos não vazios');
  if (p.recomendacao !== undefined && p.recomendacao !== null && typeof p.recomendacao !== 'string') problemas.push('"recomendacao" deve ser texto');
  if (p.teste !== undefined && typeof p.teste !== 'boolean') problemas.push('"teste" deve ser true ou false');
  return problemas;
}

/** Registra o evento de uma ação; se falhar, avisa e marca a saída com 1 (a pendência já foi gravada). */
function registrarEventoDaAcao(dados) {
  try {
    return lib.recordEvent(dados);
  } catch (e) {
    lib.warn(`erro: a pendência foi gravada, mas o evento não: ${lib.errorMessage(e)}`);
    process.exitCode = 1;
    return null;
  }
}

/** Tenta "maestri notify" (só funciona no terminal Maestro) e sempre imprime um aviso. */
function notificarCritica(p) {
  const mensagem = [...`Pendência crítica ${p.id}: ${p.titulo}`.replace(/\s+/g, ' ').trim()].slice(0, 500).join(''); // limite do notify
  if (p.teste) {
    lib.warn(`AVISO: ${p.id} é crítica, mas é de teste; a notificação não foi enviada.`);
    return;
  }
  let comando = null;
  try {
    // MAESTRO_NOTIFY_CMD (JSON com o comando, ex.: ["node","falso.js"]) existe para os testes.
    comando = process.env.MAESTRO_NOTIFY_CMD ? JSON.parse(process.env.MAESTRO_NOTIFY_CMD) : [process.env.MAESTRI_CLI || 'maestri'];
  } catch { comando = null; }
  let ok = false;
  let detalhe = '';
  if (Array.isArray(comando) && comando.length && comando.every((x) => typeof x === 'string' && x)) {
    const r = spawnSync(comando[0], [...comando.slice(1), 'notify', mensagem], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    ok = !r.error && r.status === 0;
    if (!ok) detalhe = r.error ? (r.error.code || r.error.message) : String(r.stderr || r.stdout || `saída ${r.status}`).trim().split(/\r?\n/)[0];
  } else {
    detalhe = 'MAESTRO_NOTIFY_CMD inválido';
  }
  if (ok) lib.warn(`AVISO: ${p.id} é crítica; o dono foi notificado (maestri notify).`);
  else lib.warn(`AVISO: ${p.id} é crítica, mas a notificação não saiu (maestri notify só funciona no terminal Maestro${detalhe ? `; ${detalhe}` : ''}). Avise o Cérebro com [AVISO] ${p.fluxo_id} ${p.id}.`);
}

// ---------------------------------------------------------------------------------- abrir

function cmdAbrir(argv) {
  const { opts: op } = lib.parseArgs(argv, {
    text: ['agente', 'fluxo', 'severidade', 'tipo', 'titulo', 'contexto', 'recomendacao', 'origem', 'json', 'json-arquivo'],
    list: ['opcao'],
    bool: ['teste'],
  });
  if (op.json !== undefined && op['json-arquivo'] !== undefined) throw lib.argsError('use --json ou --json-arquivo, não os dois');
  let p = {};
  if (op.json !== undefined) p = op.json === '-' ? lib.readJsonFromStdin() : lib.parseJsonObject(op.json, '--json');
  if (op['json-arquivo'] !== undefined) p = lib.readJsonFromFile(op['json-arquivo']);
  p = { ...p };
  const mapa = { agente: 'agente', fluxo: 'fluxo_id', severidade: 'severidade', tipo: 'tipo', titulo: 'titulo', contexto: 'contexto', recomendacao: 'recomendacao' };
  for (const [flag, campo] of Object.entries(mapa)) if (op[flag] !== undefined) p[campo] = op[flag];
  if (op.opcao !== undefined) p.opcoes = op.opcao;
  if (op.teste !== undefined) p.teste = op.teste;
  for (const k of ['severidade', 'tipo']) if (typeof p[k] === 'string') p[k] = lib.normalizeEnum(p[k]);
  if (typeof p.fluxo_id === 'string') p.fluxo_id = p.fluxo_id.trim().toUpperCase();
  if (typeof p.titulo === 'string') p.titulo = p.titulo.trim();
  // Nunca gravar segredo na fila, nem por descuido.
  for (const k of ['titulo', 'contexto', 'recomendacao']) if (typeof p[k] === 'string') p[k] = lib.redact(p[k]);
  if (Array.isArray(p.opcoes)) p.opcoes = p.opcoes.map((x) => (typeof x === 'string' ? lib.redact(x) : x));
  if (p.severidade === undefined) p.severidade = 'normal';
  if (p.agente === undefined) p.agente = agentePadrao();
  let semFluxo = false;
  if (p.fluxo_id === undefined) {
    const f = lib.flowOfSession(process.env.CLAUDE_CODE_SESSION_ID);
    if (f) p.fluxo_id = f; else semFluxo = true;
  }
  const cadastro = lib.loadAgentsSafe();
  let problemas = validarNova(p, cadastro);
  if (semFluxo) problemas = problemas.map((x) => (x === 'falta o campo obrigatório "fluxo_id"' ? lib.missingFlowMessage(process.env.CLAUDE_CODE_SESSION_ID) : x));
  const origem = op.origem !== undefined ? lib.normalizeEnum(op.origem) : origemPadrao(p.agente);
  if (op.origem !== undefined) problemas.push(...lib.originProblems(origem, cadastro));
  if (problemas.length) throw lib.validationError(problemas, 'Pendência inválida, nada foi gravado');
  const quando = lib.now();
  let nova = null;
  lib.updateJson(lib.paths().pendingDecisions, (atual) => {
    const d = normalizarArquivo(atual);
    const id = `P-${String(d.proximo).padStart(4, '0')}`;
    d.proximo += 1;
    nova = {
      id,
      aberta_em: lib.isoSP(quando),
      agente: p.agente,
      fluxo_id: p.fluxo_id,
      severidade: p.severidade,
      tipo: p.tipo,
      titulo: p.titulo,
      contexto: p.contexto,
      opcoes: Array.isArray(p.opcoes) ? p.opcoes : [],
      recomendacao: p.recomendacao || null,
      status: 'aberta',
      resposta: null,
      respondida_em: null,
      resolvida_em: null,
    };
    if (p.teste) nova.teste = true;
    d.pendencias.push(nova);
    return d;
  }, { initial: INICIAL, backup: true });
  registrarEventoDaAcao({
    agente: nova.agente,
    fluxo_id: nova.fluxo_id,
    origem,
    tipo: 'pendencia-aberta',
    resumo: cortarResumo(`${nova.id} aberta [${nova.severidade}]: ${nova.titulo}`),
    resultado: 'aguardando-dono',
    precisa_dono: true,
    pendencias: [nova.id],
    teste: nova.teste ? true : undefined,
  });
  if (nova.severidade === 'critica') notificarCritica(nova);
  lib.print(nova.id);
}

// ---------------------------------------------------------------------------------- listar e mostrar

const ORDEM_SEVERIDADE = Object.fromEntries(SEVERIDADES.map((s, i) => [s, i]));

/** Ordena por severidade (crítica primeiro) e idade (mais antiga primeiro). */
function ordenar(lista) {
  return [...lista].sort((a, b) => ((ORDEM_SEVERIDADE[a.severidade] ?? 9) - (ORDEM_SEVERIDADE[b.severidade] ?? 9))
    || (Date.parse(a.aberta_em) - Date.parse(b.aberta_em)));
}

function cmdListar(argv) {
  const { opts: op } = lib.parseArgs(argv, { text: ['severidade', 'agente'], bool: ['abertas', 'todas', 'incluir-testes', 'json'] });
  if (op.abertas && op.todas) throw lib.argsError('use --abertas ou --todas, não os dois');
  const severidade = op.severidade !== undefined ? lib.normalizeEnum(op.severidade) : undefined;
  if (severidade !== undefined && !SEVERIDADES.includes(severidade)) throw lib.argsError(`--severidade "${op.severidade}" não existe (use: ${SEVERIDADES.join(', ')})`);
  const status = op.todas ? STATUS : (op.abertas ? ['aberta'] : ABERTAS);
  const lista = ordenar(lerPendencias().pendencias.filter((p) => p && status.includes(p.status)
    && (op['incluir-testes'] || p.teste !== true)
    && (severidade === undefined || p.severidade === severidade)
    && (op.agente === undefined || p.agente === op.agente)));
  if (op.json) { lib.print(JSON.stringify(lista, null, 2)); return; }
  const rotulo = op.todas ? 'Pendências (todas)' : (op.abertas ? 'Pendências abertas' : 'Pendências abertas e respondidas');
  if (!lista.length) { lib.print(`${rotulo}: nenhuma.`); return; }
  lib.print(`${rotulo} (${lista.length}):`);
  for (const p of lista) {
    lib.print(`${p.id} [${p.severidade}] ${p.status} · ${lib.readableAge(p.aberta_em)} · ${p.agente} · ${p.fluxo_id}${p.teste ? ' · [teste]' : ''}`);
    lib.print(`       ${p.titulo}`);
    if (p.status === 'respondida' && p.resposta) lib.print(`       resposta: ${lib.truncate(String(p.resposta).replace(/\s+/g, ' '), 150)}`);
  }
}

/** Data ISO em "08/10/2026 15:45 (há 2 h)". */
function quando(iso) {
  const d = lib.parseDate(iso);
  return d ? `${lib.dateTimeBR(d)} (${lib.readableAge(d)})` : '-';
}

function cmdMostrar(argv) {
  const { opts: op, pos } = lib.parseArgs(argv, { bool: ['json'] }, { maxPositional: 1 });
  if (!pos.length) throw lib.argsError('informe a pendência: pendencia mostrar P-NNNN');
  const id = normalizarId(pos[0]);
  const p = lerPendencias().pendencias.find((x) => x && x.id === id);
  if (!p) throw lib.argsError(`pendência ${id} não encontrada`);
  if (op.json) { lib.print(JSON.stringify(p, null, 2)); return; }
  lib.print(`${p.id} · ${p.severidade} · ${p.tipo} · ${p.status}${p.teste ? ' · [teste]' : ''}`);
  lib.print(`Título: ${p.titulo}`);
  lib.print(`Aberta em ${quando(p.aberta_em)} por ${p.agente} · fluxo ${p.fluxo_id}`);
  lib.print('Contexto:');
  for (const l of String(p.contexto || '').split(/\r?\n/)) lib.print(`  ${l}`);
  if (Array.isArray(p.opcoes) && p.opcoes.length) {
    lib.print('Opções:');
    for (const o of p.opcoes) lib.print(`  - ${o}`);
  }
  if (p.recomendacao) lib.print(`Recomendação: ${p.recomendacao}`);
  lib.print(`Resposta: ${p.resposta ? p.resposta : '(sem resposta)'}${p.respondida_em ? ` · em ${quando(p.respondida_em)}` : ''}`);
  if (p.status === 'resolvida') lib.print(`Resolvida em ${quando(p.resolvida_em)}${p.nota ? ` · nota: ${p.nota}` : ''}`);
  if (p.status === 'cancelada') lib.print(`Cancelada em ${quando(p.resolvida_em)} · motivo: ${p.motivo || '-'}`);
}

// ---------------------------------------------------------------------------------- responder, resolver, cancelar

/**
 * Muda o status de uma pendência sob trava. "aplicar" recebe a pendência (aberta ou respondida) e a altera.
 * Devolve uma cópia da pendência depois da mudança.
 */
function mudarPendencia(id, acao, aplicar) {
  let resultado = null;
  lib.updateJson(lib.paths().pendingDecisions, (atual) => {
    const d = normalizarArquivo(atual);
    const p = d.pendencias.find((x) => x && x.id === id);
    if (!p) throw lib.argsError(`pendência ${id} não encontrada`);
    if (!ABERTAS.includes(p.status)) throw lib.validationError([`${id} está ${p.status}; só dá para ${acao} pendência aberta ou respondida`], `Não dá para ${acao} ${id}`);
    aplicar(p);
    resultado = { ...p };
    return d;
  }, { initial: INICIAL, backup: true });
  return resultado;
}

/** Lê id posicional, --agente e --origem comuns a responder, resolver e cancelar. */
function lerAcao(argv, textos, nomeAcao) {
  const { opts: op, pos } = lib.parseArgs(argv, { text: ['agente', 'origem', ...textos] }, { maxPositional: 1 });
  if (!pos.length) throw lib.argsError(`informe a pendência: pendencia ${nomeAcao} P-NNNN`);
  const id = normalizarId(pos[0]);
  const agente = op.agente !== undefined ? op.agente.trim() : agentePadrao();
  const cadastro = lib.loadAgentsSafe();
  const problemas = lib.agentProblems(agente, cadastro);
  const origem = op.origem !== undefined ? lib.normalizeEnum(op.origem) : undefined;
  if (origem !== undefined) problemas.push(...lib.originProblems(origem, cadastro));
  return { op, id, agente, origem, problemas };
}

function cmdResponder(argv) {
  const { op, id, agente, problemas } = lerAcao(argv, ['resposta'], 'responder');
  if (op.origem !== undefined) problemas.push('responder não aceita --origem: a origem é sempre dono-direto');
  if (!lib.isFilled(op.resposta)) problemas.push('falta --resposta "..." (a resposta do dono)');
  if (problemas.length) throw lib.validationError(problemas, 'Nada foi gravado');
  const resposta = lib.redact(op.resposta.trim());
  const iso = lib.isoSP(lib.now());
  const p = mudarPendencia(id, 'responder', (x) => { x.status = 'respondida'; x.resposta = resposta; x.respondida_em = iso; });
  registrarEventoDaAcao({
    agente,
    fluxo_id: p.fluxo_id,
    origem: 'dono-direto',
    tipo: 'decisao',
    resumo: cortarResumo(`${p.id} respondida pelo dono: ${resposta}`),
    direcao: `Resposta do dono à ${p.id} (${p.titulo}): ${resposta}`,
    resultado: 'ok',
    pendencias: [p.id],
    teste: p.teste ? true : undefined,
  });
  lib.print(`${p.id} respondida`);
}

function cmdResolver(argv) {
  const { op, id, agente, origem, problemas } = lerAcao(argv, ['nota'], 'resolver');
  if (problemas.length) throw lib.validationError(problemas, 'Nada foi gravado');
  const nota = lib.isFilled(op.nota) ? lib.redact(op.nota.trim()) : null;
  const iso = lib.isoSP(lib.now());
  const p = mudarPendencia(id, 'resolver', (x) => { x.status = 'resolvida'; x.resolvida_em = iso; if (nota) x.nota = nota; });
  registrarEventoDaAcao({
    agente,
    fluxo_id: p.fluxo_id,
    origem: origem || origemPadrao(agente),
    tipo: 'pendencia-resolvida',
    resumo: cortarResumo(`${p.id} resolvida: ${p.titulo}`),
    direcao: nota || undefined,
    resultado: 'ok',
    pendencias: [p.id],
    teste: p.teste ? true : undefined,
  });
  lib.print(`${p.id} resolvida`);
}

function cmdCancelar(argv) {
  const { op, id, agente, origem, problemas } = lerAcao(argv, ['motivo'], 'cancelar');
  if (!lib.isFilled(op.motivo)) problemas.push('falta --motivo "..." (por que a pendência foi cancelada)');
  if (problemas.length) throw lib.validationError(problemas, 'Nada foi gravado');
  const motivo = lib.redact(op.motivo.trim());
  const iso = lib.isoSP(lib.now());
  const p = mudarPendencia(id, 'cancelar', (x) => { x.status = 'cancelada'; x.resolvida_em = iso; x.motivo = motivo; });
  registrarEventoDaAcao({
    agente,
    fluxo_id: p.fluxo_id,
    origem: origem || origemPadrao(agente),
    tipo: 'pendencia-resolvida',
    resumo: cortarResumo(`${p.id} cancelada: ${p.titulo}`),
    direcao: `Cancelada sem execução: ${motivo}`,
    resultado: 'ok',
    pendencias: [p.id],
    teste: p.teste ? true : undefined,
  });
  lib.print(`${p.id} cancelada`);
}

// ---------------------------------------------------------------------------------- principal

const SUBCOMANDOS = {
  abrir: cmdAbrir,
  listar: cmdListar,
  mostrar: cmdMostrar,
  responder: cmdResponder,
  resolver: cmdResolver,
  cancelar: cmdCancelar,
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

module.exports = { normalizarId, cortarResumo, validarNova, ordenar, SEVERIDADES, TIPOS, STATUS };
