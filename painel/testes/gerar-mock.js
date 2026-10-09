#!/usr/bin/env node
'use strict';
/*
 * gerar-mock.js: gera os dados de teste do painel (modo ?mock=1 do index.html).
 *
 *   mock-estado.json    uma resposta realista de GET /api/estado (o contrato do painel)
 *   mock-detalhes.json  o que o modo de teste usa para imitar /api/eventos, /api/evento/<id>
 *                       e /api/fluxo/<id>: eventos completos (inclusive os de teste),
 *                       comandos brutos e fluxos
 *
 * Todos os dados são fictícios (workspace "Exemplo", projetos Atlas, Boreal, Cometa, Delta, Eco
 * e Faro). Nenhum nome, id ou caminho é real.
 *
 * Cenário: sexta, 09/10/2026 às 10:24:30 (America/Sao_Paulo).
 * - Quinta 08/10: montagem do workspace (fluxo F-20261008-0001) e a primeira auditoria das
 *   dependências dos projetos (fluxo F-20261008-0002), que achou 13 pacotes desatualizados.
 * - A rotina leu as dependências de hora em hora; o dono atualizou 3 pacotes à mão, e as
 *   atualizações automáticas seguem bloqueadas até a P-0002.
 * - Sexta 09/10: o Maestri reiniciou às 08:55 e o Coordenador parou no diálogo de
 *   confiança; as leituras das 09:00 e 10:00 não rodaram (P-0006 crítica).
 *
 * Uso: node gerar-mock.js   (grava os dois arquivos ao lado deste script)
 * Só biblioteca padrão. Determinístico: rodar de novo gera os mesmos arquivos.
 */

const fs = require('fs');
const path = require('path');

const AGORA = '2026-10-09T10:24:30-03:00';
const D1 = '2026-10-08';
const D2 = '2026-10-09';
const F1 = 'F-20261008-0001';
const F2 = 'F-20261008-0002';
const RAIZ = 'C:/exemplo/workspace';
const BIN = `${RAIZ}/_maestro/bin`;
const AUDITAR = `${RAIZ}/_maestro/skills/coordenador/deps-leitura/auditar.js`;

const ts = (dia, hora) => `${dia}T${hora}-03:00`;
const min = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);

function hex4(s) {
  let x = 2166136261;
  for (const ch of s) { x ^= ch.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; }
  return (x & 0xffff).toString(16).padStart(4, '0');
}

// ---------------------------------------------------------------- agentes (agentes.json)

const AGENTES = [
  {
    slug: 'cerebro', nome: 'Cérebro Principal', tipo: 'maestro', cor: '#E8C547',
    responsabilidade: 'Cérebro Principal', status: 'ativo',
    modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh',
    skills: ['orquestracao', 'pendencias', 'painel', 'onboarding-agente', 'protocolo-delegacao', 'registro-eventos'],
    conectado_a: ['coordenador', 'portal:painel', 'nota:Bootstrap · Progresso'],
    terminal: '0000aaaa-0000-4000-8000-000000000001', sessao: '0000aaaa-0000-4000-8000-0000000000a1',
    cwd: RAIZ,
  },
  {
    slug: 'coordenador', nome: 'Coordenador de Dependências', tipo: 'sub-cerebro', cor: '#3B82F6',
    responsabilidade: 'Coordenador de Dependências', status: 'ativo',
    modelo: 'claude-opus-5-5[1m]', nivel: 'xhigh',
    skills: ['deps-leitura', 'deps-atualizacao', 'deps-auditoria', 'deps-relatorio', 'protocolo-delegacao', 'registro-eventos'],
    conectado_a: ['cerebro'],
    terminal: '0000bbbb-0000-4000-8000-000000000002', sessao: '0000bbbb-0000-4000-8000-0000000000b2',
    cwd: `${RAIZ}/.maestri/roles/0000bbbb`,
  },
];
const AG = Object.fromEntries(AGENTES.map((a) => [a.slug, a]));

// ---------------------------------------------------------------- eventos (logs/eventos/2026-10.jsonl)

const TIPOS = ['pedido-recebido', 'delegacao', 'resposta-recebida', 'aviso', 'consulta', 'execucao', 'auditoria', 'relatorio', 'decisao', 'pendencia-aberta', 'pendencia-resolvida', 'bloqueio', 'erro', 'manutencao', 'bootstrap'];
const RESULTADOS = ['ok', 'parcial', 'falhou', 'bloqueado', 'aguardando-dono', 'em-andamento'];
const COM_DIRECAO = ['decisao', 'execucao', 'delegacao', 'auditoria'];

const EVENTOS = [];
function ev(dia, hora, agente, fluxo, tipo, resultado, resumo, x = {}) {
  const t = ts(dia, hora);
  const e = {
    id: `EV-${dia.replace(/-/g, '')}-${hora.replace(/:/g, '')}-${hex4(agente + resumo)}`,
    ts: t, agente, fluxo_id: fluxo,
    origem: x.origem || 'cerebro',
    tipo,
    projeto: x.projeto || null,
    resumo,
    direcao: x.direcao || null,
    passos: x.passos || [],
    comandos: x.comandos || [],
    alteracoes: x.alteracoes || [],
    resultado,
    validacao: x.validacao || null,
    proximo_passo: x.proximo_passo || null,
    precisa_dono: !!x.precisa_dono,
    pendencias: x.pendencias || [],
    duracao_s: x.duracao_s == null ? null : x.duracao_s,
  };
  if (x.teste) e.teste = true;
  e.sessao = x.sessao === undefined ? AG[agente].sessao : x.sessao;
  if (x.tipo_original) { e.tipo_original = x.tipo_original; e.importado_de = 'logs/pre-registro.md'; }
  // validações do registrar (§10.3), para o mock não mentir sobre o formato
  if (!TIPOS.includes(tipo)) throw new Error(`tipo inválido: ${tipo}`);
  if (!RESULTADOS.includes(resultado)) throw new Error(`resultado inválido: ${resultado}`);
  if (resumo.length > 100) throw new Error(`resumo com ${resumo.length} caracteres: ${resumo}`);
  if (COM_DIRECAO.includes(x.tipo_original || tipo) && !e.direcao) throw new Error(`direcao obrigatória: ${resumo}`);
  EVENTOS.push(e);
  return e;
}

// ---- Fluxo 1: bootstrap (pré-registro importado e eventos do registrar)
const pre = (hora, tipoOriginal, resultado, resumo, x = {}) => ev(D1, hora, 'cerebro', F1, 'bootstrap', resultado, resumo, Object.assign({ tipo_original: tipoOriginal, sessao: null }, x));
pre('00:52:02', 'pedido-recebido', 'ok', 'Pedido do dono: montar o workspace a partir do documento de instruções', {
  origem: 'dono-direto',
  direcao: 'Pedido chegou pelo chat do Maestri; carreguei as skills de conexão e de gestão do Maestri antes de agir.',
});
pre('00:54:00', 'consulta', 'ok', 'Lido o documento de instruções inteiro', {
  origem: 'dono-direto',
  direcao: 'Leitura integral antes de qualquer ação, como o próprio pedido exige; nada foi criado nessa etapa.',
});
pre('00:57:00', 'consulta', 'ok', 'Fase 0: reconhecimento do Maestri, do Claude Code e da máquina', {
  origem: 'dono-direto',
  direcao: `Só leitura: workspace Exemplo em ${RAIZ}; uso do plano em ~/.maestri/usage/providers/.status.json; sem Python; Node 22 presente.`,
});
pre('00:58:30', 'pendencia-aberta', 'aguardando-dono', 'Perguntado ao dono: confirmar a raiz e escolher Node.js ou instalar Python', {
  origem: 'dono-direto', precisa_dono: true, pendencias: ['P-0001'],
  direcao: 'O documento manda confirmar a raiz antes de criar arquivos e parar se faltar python3; recomendei Node.js (já instalado e é o runtime dos hooks).',
});
pre('00:59:30', 'consulta', 'em-andamento', 'Disparado workflow de 3 sondas (CLI do Maestri, Claude Code, Windows)', {
  origem: 'dono-direto',
  direcao: 'Testes empíricos só no scratchpad para descobrir o formato real dos hooks, a carga de CLAUDE.md e skills a partir de diretório-pai, o modelo 1M, a trava de arquivo em Node, junções e a porta 4777.',
});
pre('01:00:30', 'decisao', 'ok', 'Dono confirmou: raiz do workspace, Node.js, todos os agentes em Opus 5.5 1M xhigh', {
  origem: 'dono-direto', pendencias: ['P-0001'],
  direcao: 'Decisão do dono registrada; modelo e nível por agente vão para agentes.json para o painel mostrar; controle pelo painel fica como evolução sugerida.',
});
pre('01:01:00', 'execucao', 'ok', 'Criada a árvore de diretórios de _maestro/', {
  origem: 'dono-direto',
  direcao: 'Criei só pastas, na raiz confirmada pelo dono; arquivos vêm na Fase 1 depois que as convenções fecharem a Fase 0.',
});
ev(D1, '01:35:10', 'cerebro', F1, 'execucao', 'ok', 'Fase 1: CLAUDE.md, fichas, protocolos e manual de dependências gravados', {
  origem: 'dono-direto', sessao: null, duracao_s: 1830,
  direcao: 'Textos integrais do documento de instruções, com a adaptação para Node registrada em decisoes.md; o manual foi salvo verbatim e conferido por hash.',
  passos: ['Gravei o CLAUDE.md da raiz', 'Gravei as fichas do Cérebro e do Coordenador', 'Gravei os 4 protocolos (delegação, autonomia, registro, pendências)', 'Salvei o manual de dependências e os princípios verbatim', 'Conferi os hashes antes e depois'],
  alteracoes: ['CLAUDE.md (raiz do workspace)', '_maestro/registro/fichas/cerebro.md', '_maestro/registro/fichas/coordenador.md', '_maestro/conhecimento/protocolos/ (4 arquivos)', '_maestro/conhecimento/dependencias/manual.md'],
  validacao: 'md5 do manual igual ao do documento original (antes.md5 = depois.md5)',
});
ev(D1, '02:10:45', 'cerebro', F1, 'decisao', 'ok', 'Registradas as decisões de adaptação em decisoes.md', {
  origem: 'dono-direto', sessao: null,
  direcao: 'Cada adaptação da máquina (Node, junções, EXLOCK, hooks no settings do usuário) virou decisão numerada, para os próximos agentes não refazerem as sondas.',
  alteracoes: ['_maestro/registro/decisoes.md'],
});
ev(D1, '02:40:00', 'cerebro', F1, 'execucao', 'ok', 'Fase 2: registrar.js e pendencia.js com trava EXLOCK e gravação atômica', {
  origem: 'dono-direto', sessao: null, duracao_s: 2410,
  direcao: 'EXLOCK do Windows no lugar do fcntl: a trava some sozinha quando o processo dono dela morre; os JSONL usam uma chamada de append por linha, sem trava.',
  passos: ['Escrevi lib_maestro.js (trava, gravação atômica, fuso)', 'Escrevi registrar.js e pendencia.js', 'Criei os wrappers sh e .cmd', 'Rodei o teste de concorrência com 8 processos'],
  comandos: [`node ${BIN}/registrar.js novo-fluxo --titulo "Teste de concorrência"`, `node ${BIN}/testes/concorrencia.js --processos 8 --vezes 100`],
  alteracoes: ['_maestro/bin/lib_maestro.js', '_maestro/bin/registrar.js', '_maestro/bin/pendencia.js', '_maestro/bin/registrar, registrar.cmd, pendencia, pendencia.cmd'],
  validacao: 'Contador fechou 800/800 com 8 processos; 0 linhas corrompidas em 2400 appends',
});
ev(D1, '02:52:12', 'cerebro', F1, 'execucao', 'ok', 'Teste do registrar: evento completo via --json', {
  origem: 'sistema', sessao: null, teste: true,
  direcao: 'Evento de teste para conferir a validação e a gravação; marcado como teste para o painel esconder.',
});
ev(D1, '02:53:40', 'cerebro', F1, 'erro', 'falhou', 'Teste do registrar: resultado inválido rejeitado com código 2', {
  origem: 'sistema', sessao: null, teste: true,
  validacao: 'O registrar recusou "resultado": "talvez" e não gravou nada',
});
ev(D1, '03:05:30', 'cerebro', F1, 'execucao', 'ok', 'Hooks do log bruto instalados no settings.json do usuário', {
  origem: 'dono-direto', sessao: null, duracao_s: 640,
  direcao: 'Forma exec (node + args) por ser ~100 ms mais rápida que via Git Bash; backup e mescla com os hooks que já existem, nunca sobrescrita.',
  passos: ['Backup de ~/.claude/settings.json', 'Mescla dos 8 eventos na forma exec', 'Validação do JSON', 'Sessão de teste conferindo o log bruto'],
  comandos: [`node ${BIN}/instalar-hooks.js --backup`],
  alteracoes: ['~/.claude/settings.json (8 hooks acrescentados; backup ao lado)'],
  validacao: 'A sessão de teste gravou SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop e SessionEnd',
});
ev(D1, '03:20:05', 'cerebro', F1, 'execucao', 'ok', 'Fase 3: recrutado o Coordenador de Dependências (Opus 5.5 1M, xhigh)', {
  origem: 'dono-direto',
  direcao: 'Recruta com --preset "Claude Code" e o comando que fixa o modelo; terminal_id e diretório gravados em agentes.json.',
  comandos: ['maestri recruit "Coordenador de Dependências" --preset "Claude Code" --command \'claude --model "claude-opus-5-5[1m]" --effort xhigh\''],
  alteracoes: ['_maestro/registro/agentes.json (terminal_id e diretorios do Coordenador)'],
  validacao: 'maestri list mostra o Coordenador conectado ao Cérebro',
});
ev(D1, '03:31:50', 'cerebro', F1, 'execucao', 'ok', 'Skills do Coordenador expostas por junção e carregando', {
  origem: 'dono-direto',
  direcao: 'Junção NTFS em .claude/skills da raiz porque symlink exige admin; conferi que as 4 skills aparecem na sessão do Coordenador.',
  alteracoes: ['.claude/skills/ (4 junções para _maestro/skills/coordenador)'],
  validacao: 'A sessão do Coordenador listou deps-leitura, deps-atualizacao, deps-auditoria e deps-relatorio',
});

// ---- Fluxo 2: primeira auditoria das dependências, pendências e rotina
ev(D1, '13:48:30', 'cerebro', F2, 'delegacao', 'ok', 'Delegada ao Coordenador a primeira auditoria das dependências', {
  origem: 'cerebro',
  direcao: 'Fase 4 do bootstrap em somente leitura: o dono vê o diagnóstico antes de liberar qualquer atualização. Pedi relatório, auditoria e as pendências de decisão.',
  comandos: [`node ${BIN}/registrar.js novo-fluxo --titulo "Dependências: primeira auditoria e pendências"`, 'maestri ask "Coordenador de Dependências" "[DELEGACAO F-20261008-0002] Faça a primeira auditoria das dependências…"'],
});
ev(D1, '13:49:05', 'coordenador', F2, 'pedido-recebido', 'ok', 'Pedido do Cérebro: primeira auditoria, relatório e pendências (somente leitura)', { origem: 'cerebro' });
ev(D1, '13:52:40', 'coordenador', F2, 'execucao', 'ok', 'Leitura completa das dependências dos 6 projetos: 13 pacotes desatualizados', {
  origem: 'cerebro', duracao_s: 215,
  direcao: 'Li os arquivos de trava em vez de rodar a instalação porque trazem as versões exatas numa leitura só; nenhuma escrita, bootstrap em somente leitura.',
  passos: ['Listei os arquivos de trava dos 6 projetos', 'Salvei as versões em versoes.json', 'A primeira auditoria falhou (registro fora do ar) e repeti', 'Comparei com as versões publicadas', 'Gravei o resumo'],
  comandos: ['npm outdated --json --prefix atlas', 'npm outdated --json --prefix delta', `node ${AUDITAR} --fluxo ${F2}`],
  alteracoes: ['estado/dependencias/versoes.json', 'estado/dependencias/resumo.json'],
  validacao: '13 pacotes desatualizados na leitura = 13 no resumo; 3 com versão nova de correção',
  proximo_passo: 'Rodar a auditoria (manual §8) e gerar o relatório',
});
ev(D1, '14:05:10', 'coordenador', F2, 'auditoria', 'ok', 'Auditoria das dependências: 11 atualizações de correção e 9 decisões', {
  origem: 'cerebro', duracao_s: 742,
  direcao: 'Classifiquei como mecânico só o que o manual §12 permite fazer sem ok (versões de correção); versões maiores, remoções e trocas de pacote ficaram como decisão.',
  passos: ['Reli o checklist de auditoria do manual §8', 'Comparei item a item com o diagnóstico do manual §10', 'Separei mecânicos (nível 1) de decisões (nível 2 e 3)'],
  validacao: 'Bate com o diagnóstico do manual §10: 11 atualizações de correção; 9 decisões',
  proximo_passo: 'Gerar o relatório e abrir as pendências de decisão',
});
ev(D1, '14:06:00', 'coordenador', F2, 'relatorio', 'ok', 'Relatório das dependências gerado e salvo', {
  origem: 'cerebro', alteracoes: ['estado/dependencias/relatorio.md'],
});
ev(D1, '14:12:20', 'coordenador', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0002: liberar as atualizações de correção', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0002'],
  comandos: [`node ${BIN}/pendencia.js abrir --agente coordenador --fluxo ${F2} --severidade alta --tipo aprovacao --titulo "Liberar as atualizações de correção das dependências"`],
});
ev(D1, '14:13:05', 'coordenador', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0003: Eco, definir a versão do Node', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0003'], projeto: 'E',
});
ev(D1, '14:13:50', 'coordenador', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0004: renomear o script "build:prod" para "build"', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0004'],
});
ev(D1, '14:14:30', 'coordenador', F2, 'pendencia-aberta', 'aguardando-dono', 'Aberta P-0005: remover 5 dependências sem uso', {
  origem: 'cerebro', precisa_dono: true, pendencias: ['P-0005'],
});
ev(D1, '14:16:00', 'cerebro', F2, 'resposta-recebida', 'ok', 'Recebido do Coordenador: relatório e 4 pendências abertas', { origem: 'agente:coordenador' });
ev(D1, '14:18:30', 'cerebro', F2, 'aviso', 'ok', 'Avisado o dono: 4 decisões de dependências esperando (P-0002 a P-0005)', {
  origem: 'cerebro', pendencias: ['P-0002', 'P-0003', 'P-0004', 'P-0005'],
});

// ---- de volta ao fluxo 1 (Fases 5 e 6)
ev(D1, '15:12:30', 'cerebro', F1, 'execucao', 'ok', 'Fase 5: painel no ar em http://127.0.0.1:4777', {
  origem: 'dono-direto',
  direcao: 'Servidor Node só em 127.0.0.1 com checagem de Host; o terminal Servidor do Painel roda o node e o próprio servidor grava o PID em estado/painel.pid.',
  comandos: ['curl -s -o /dev/null -w "%{http_code} %{time_total}" http://127.0.0.1:4777/api/estado', 'curl -s -H "Host: exemplo.invalido" http://127.0.0.1:4777/api/estado'],
  validacao: 'GET /api/estado 200 em 41 ms; Host forjado recebeu 403',
});
ev(D1, '15:20:00', 'cerebro', F1, 'consulta', 'parcial', 'Conferido o painel no portal: 5 abas, tema claro e escuro', {
  origem: 'dono-direto',
  direcao: 'Screenshots do portal Painel em 900 px e em tela cheia; o gráfico da semana ainda tem um dia só.',
  proximo_passo: 'O gráfico ganha pontos com as leituras de hora em hora (Fase 6)',
});
ev(D1, '15:41:00', 'cerebro', F1, 'decisao', 'ok', 'Dono aprovou a rotina de leitura das dependências de hora em hora (8h às 22h)', {
  origem: 'dono-direto',
  direcao: 'Leitura é só consulta aos arquivos de trava: custo baixo. As atualizações ficam para depois da liberação da P-0002.',
});
ev(D1, '15:44:30', 'cerebro', F1, 'execucao', 'ok', 'Rotina "Dependências · leitura" criada no Maestri, pulando se ocupado', {
  origem: 'dono-direto',
  direcao: 'Criada pela CLI com o prompt da §13 e o fluxo F-20261008-0002 no texto, para as leituras ficarem ligadas à primeira; a primeira execução é às 16:00.',
  comandos: ['maestri routine create "Dependências · leitura" --command "[ROTINA F-20261008-0002] Leia as dependências (somente leitura)…" --hourly --from 08:00 --to 22:00 --skip-if-busy'],
  validacao: 'maestri routine list mostra a rotina ativa, próxima execução às 16:00',
});
ev(D1, '15:58:00', 'cerebro', F1, 'relatorio', 'ok', 'Relatório final do bootstrap entregue ao dono', {
  origem: 'dono-direto', pendencias: ['P-0002', 'P-0003', 'P-0005'],
  proximo_passo: 'Aguardar as decisões P-0002, P-0003 e P-0005 para liberar as atualizações',
});

// ---- leituras de rotina (fluxo 2)
const leitura = (dia, hora, resumo, x = {}) => ev(dia, hora, 'coordenador', F2, 'execucao', 'ok', resumo, Object.assign({
  origem: 'rotina', duracao_s: 38,
  direcao: 'Leitura de rotina dos arquivos de trava, somente leitura; resumo e relatório atualizados.',
  validacao: '13 pacotes desatualizados na leitura = 13 no resumo',
}, x));
leitura(D1, '16:00:40', 'Leitura das dependências: 13 desatualizados, sem mudança');
leitura(D1, '17:00:35', 'Leitura das dependências: 13 desatualizados, sem mudança');
leitura(D1, '18:00:30', 'Leitura das dependências: Delta atualizou o cliente de e-mail', {
  projeto: 'D',
  direcao: 'Mudança feita pelo dono no Delta; só registrei. O pacote ainda tem uma versão de correção nova (atualização esperando a P-0002).',
});
leitura(D1, '19:00:25', 'Leitura das dependências: 13 desatualizados, sem mudança');
leitura(D1, '20:00:50', 'Leitura das dependências: Boreal atualizou o gerador de páginas', {
  projeto: 'B',
  direcao: 'Mudança feita pelo dono; só registrei. Ficou uma versão de correção para trás.',
});
leitura(D1, '21:00:20', 'Leitura das dependências: 13 desatualizados, sem mudança');
leitura(D1, '22:00:30', 'Leitura das dependências: 13 desatualizados, sem mudança');
leitura(D2, '08:00:45', 'Leitura das dependências: Cometa atualizou a fila, mas a trava ficou velha', {
  projeto: 'C', duracao_s: 44,
  direcao: 'O dono atualizou o pacote à noite sem regerar o arquivo de trava. Regerar é mecânico, mas as escritas seguem bloqueadas até a P-0002; alertas mecânicos passaram de 11 para 12.',
  passos: ['Li os arquivos de trava', 'Salvei as versões', 'Comparei com a leitura das 22:00', 'Avisei o Cérebro do alerta novo'],
  comandos: ['npm outdated --json --prefix cometa', `node ${AUDITAR} --fluxo ${F2}`, 'maestri ask "Cérebro Principal" "[AVISO F-20261008-0002] Novo alerta mecânico…"'],
  alteracoes: ['estado/dependencias/resumo.json', 'estado/dependencias/relatorio.md'],
  proximo_passo: 'Regerar a trava quando a P-0002 for liberada',
});

// ---- sexta 09/10
ev(D2, '08:41:10', 'cerebro', F2, 'resposta-recebida', 'ok', 'Dono respondeu a P-0004: pode renomear "build:prod" para "build"', {
  origem: 'dono-direto', pendencias: ['P-0004'],
  comandos: [`node ${BIN}/pendencia.js responder P-0004 --resposta "Pode renomear."`],
});
ev(D2, '08:42:00', 'cerebro', F2, 'delegacao', 'ok', 'Repassada ao Coordenador a resposta da P-0004', {
  origem: 'dono-direto', pendencias: ['P-0004'],
  direcao: 'As escritas ainda não foram liberadas (P-0002); pedi para guardar a resposta e executar junto com as atualizações de correção, num ciclo só, relendo as travas no fim.',
});
ev(D2, '09:15:30', 'cerebro', F2, 'erro', 'falhou', 'Rotina das 09:00 não registrou a leitura das dependências', {
  origem: 'sistema', precisa_dono: true,
  direcao: 'Conferi o terminal do Coordenador: depois do reinício do Maestri às 08:55 ele está parado no diálogo "Do you trust the files in this folder?". Não aceito diálogo de confiança sozinho.',
  passos: ['Notei a falta do evento das 09:00', 'Perguntei ao Coordenador pelo maestri (sem resposta em 60 s)', 'Olhei o terminal: diálogo de confiança aberto'],
  proximo_passo: 'Abrir pendência crítica para o dono aceitar o diálogo',
});
ev(D2, '09:30:10', 'cerebro', F2, 'consulta', 'ok', 'Teste do painel: evento marcado como teste', { origem: 'sistema', teste: true });
ev(D2, '10:02:15', 'cerebro', F2, 'pendencia-aberta', 'bloqueado', 'Aberta P-0006: aceitar o diálogo de confiança no terminal do Coordenador', {
  origem: 'sistema', precisa_dono: true, pendencias: ['P-0006'],
  direcao: 'Crítica porque as dependências estão sem leitura desde 08:00 e as rotinas seguem falhando; recomendei aceitar na raiz para nenhum role parar de novo.',
  proximo_passo: 'Quando o dono aceitar, pedir uma leitura avulsa e conferir o hook do Coordenador',
});
ev(D2, '10:20:05', 'cerebro', F2, 'consulta', 'ok', 'Dono perguntou o status das dependências: respondido com o relatório das 08:00', {
  origem: 'dono-direto',
  direcao: 'Respondi com o relatório salvo das 08:00 e avisei que a leitura está parada até a P-0006.',
});

EVENTOS.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

// ---------------------------------------------------------------- pendências (estado/pendencias.json)

const PENDENCIAS = [
  {
    id: 'P-0001', aberta_em: ts(D1, '00:58:30'), agente: 'cerebro', fluxo_id: F1, severidade: 'critica', tipo: 'decisao',
    titulo: 'Confirmar a raiz do workspace e a linguagem dos scripts (não há Python)',
    contexto: 'O documento de instruções manda confirmar a raiz antes de criar arquivos e parar se faltar python3. Nesta máquina não há Python; o Node 22 já roda os hooks.',
    opcoes: [`A: raiz ${RAIZ} e scripts em Node.js 22`, 'B: instalar o Python 3 e seguir o documento à risca'],
    recomendacao: 'A: o Node já está instalado e é o runtime dos hooks; o fcntl do Python nem existe no Windows.',
    status: 'resolvida', resposta: 'A. E todos os agentes em Opus 5.5 com 1M, nível xhigh.',
    respondida_em: ts(D1, '01:00:30'), resolvida_em: ts(D1, '01:00:30'), nota: 'Registrado em decisoes.md.', motivo: null, teste: false, atualizada_em: ts(D1, '01:00:30'),
  },
  {
    id: 'P-0002', aberta_em: ts(D1, '14:12:20'), agente: 'coordenador', fluxo_id: F2, severidade: 'alta', tipo: 'aprovacao',
    titulo: 'Liberar as atualizações de correção das dependências',
    contexto: 'Na auditoria de 08/10 eram 11 atualizações de correção. Desde 09/10 08:00 são 12 (a trava do Cometa ficou velha). São correções dentro das regras do manual §12, mas o bootstrap está em somente leitura.',
    opcoes: ['A: liberar todas agora', 'B: liberar só a trava do Cometa e revisar a lista das correções antes', 'C: manter somente leitura por enquanto'],
    recomendacao: 'A: são mecânicas e reversíveis (a trava anterior fica no histórico), e rodo os testes de cada projeto depois de cada uma.',
    status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D2, '08:00:45'),
  },
  {
    id: 'P-0003', aberta_em: ts(D1, '14:13:05'), agente: 'coordenador', fluxo_id: F2, severidade: 'alta', tipo: 'decisao',
    titulo: 'Eco: definir a versão do Node',
    contexto: 'O Eco declara Node 18 no package.json, mas o CI roda em Node 22 e duas dependências já exigem Node 20.',
    opcoes: ['A: subir o Eco para Node 22', 'B: subir para Node 20', 'C: manter Node 18 e travar as duas dependências'],
    recomendacao: 'A: os outros projetos já usam Node 22 e o CI também.',
    status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D1, '14:13:05'),
  },
  {
    id: 'P-0004', aberta_em: ts(D1, '14:13:50'), agente: 'coordenador', fluxo_id: F2, severidade: 'normal', tipo: 'decisao',
    titulo: 'Renomear o script "build:prod" para "build"',
    contexto: 'O script de build se chama "build:prod" só no Delta; os outros projetos usam "build" (manual §10, item 3).',
    opcoes: ['A: renomear o script para "build"', 'B: manter "build:prod" e criar um apelido'],
    recomendacao: 'A, como o manual já prevê.',
    status: 'respondida', resposta: 'Pode renomear.', respondida_em: ts(D2, '08:41:10'), resolvida_em: null, nota: 'Executar junto com as atualizações de correção (P-0002).', motivo: null, teste: false, atualizada_em: ts(D2, '08:42:00'),
  },
  {
    id: 'P-0005', aberta_em: ts(D1, '14:14:30'), agente: 'coordenador', fluxo_id: F2, severidade: 'baixa', tipo: 'aprovacao',
    titulo: 'Remover 5 dependências sem uso',
    contexto: 'Duas no Boreal, duas no Cometa e uma no Faro. Nenhum arquivo importa essas dependências. Remoção só com ok do dono.',
    opcoes: ['A: remover as 5', 'B: remover só as 3 de desenvolvimento'],
    recomendacao: 'A: nenhuma está em uso e elas deixam a instalação mais lenta.',
    status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D1, '14:14:30'),
  },
  {
    id: 'P-0006', aberta_em: ts(D2, '10:02:15'), agente: 'cerebro', fluxo_id: F2, severidade: 'critica', tipo: 'aprovacao',
    titulo: 'Aceitar o diálogo de confiança no terminal do Coordenador',
    contexto: 'Depois do reinício do Maestri às 08:55, o Claude do Coordenador parou em "Do you trust the files in this folder?". As leituras das 09:00 e das 10:00 não rodaram e as dependências estão sem leitura desde 08:00.',
    opcoes: ['A: aceitar no terminal do Coordenador', 'B: aceitar uma vez na raiz do workspace, para nenhum role parar de novo'],
    recomendacao: 'B: resolve de vez para todos os roles do workspace (a confiança vale para as pastas abaixo).',
    status: 'aberta', resposta: null, respondida_em: null, resolvida_em: null, nota: null, motivo: null, teste: false, atualizada_em: ts(D2, '10:02:15'),
  },
];

// ---------------------------------------------------------------- comandos brutos (logs/bruto/<agente>/AAAA-MM-DD.jsonl)

const BRUTOS = [];
function bruto(dia, hora, agente, evento, ferramenta, entrada, x = {}) {
  const a = AG[agente];
  const linha = { ts: ts(dia, hora), agente, terminal: a.terminal, sessao: a.sessao };
  if (x.fluxo) linha.fluxo_id = x.fluxo;
  linha.evento = evento;
  if (ferramenta) linha.ferramenta = ferramenta;
  if (evento === 'UserPromptSubmit') linha.prompt = entrada;
  else if (entrada != null) linha.entrada = entrada;
  if (evento === 'PostToolUse') linha.ok = true;
  if (evento === 'PostToolUseFailure') { linha.ok = false; linha.erro = x.erro || 'falhou'; }
  if (x.saida) linha.saida_resumo = x.saida;
  if (x.duracao_ms != null) linha.duracao_ms = x.duracao_ms;
  linha.cwd = a.cwd;
  linha.versao = '2.1.292';
  BRUTOS.push(linha);
}
const C = 'cerebro';
const K = 'coordenador';
const REG = `node ${BIN}/registrar.js evento --json -`;

// bootstrap depois dos hooks (03:05): sessão do Cérebro sem fluxo no prompt
bruto(D1, '03:18:44', C, 'PostToolUse', 'Bash', 'maestri preset list', { duracao_ms: 820, saida: 'Claude Code, Codex, Antigravity, OpenCode, Shell' });
bruto(D1, '03:19:40', C, 'PostToolUse', 'Bash', 'maestri recruit "Coordenador de Dependências" --preset "Claude Code" --command \'claude --model "claude-opus-5-5[1m]" --effort xhigh\'', { duracao_ms: 6140, saida: 'Recruited "Coordenador de Dependências"' });
bruto(D1, '03:19:58', C, 'PostToolUse', 'Edit', `${RAIZ}/_maestro/registro/agentes.json`, { duracao_ms: 35 });
bruto(D1, '03:20:03', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 190 });
bruto(D1, '03:29:12', C, 'PostToolUse', 'Bash', `node -e "require('fs').symlinkSync('${RAIZ}/_maestro/skills/coordenador/deps-leitura', '${RAIZ}/.claude/skills/deps-leitura', 'junction')"`, { duracao_ms: 120 });
bruto(D1, '03:31:47', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 185 });
// fluxo 2: delegação (prompt do dono sem fluxo; o id só aparece no texto mandado ao Coordenador)
bruto(D1, '13:47:52', C, 'UserPromptSubmit', null, 'Pode seguir para a Fase 4.');
bruto(D1, '13:48:12', C, 'PostToolUse', 'Bash', `node ${BIN}/registrar.js novo-fluxo --titulo "Dependências: primeira auditoria e pendências"`, { duracao_ms: 210, saida: F2 });
bruto(D1, '13:48:21', C, 'PostToolUse', 'Bash', 'maestri ask "Coordenador de Dependências" "[DELEGACAO F-20261008-0002] Faça a primeira auditoria das dependências (somente leitura), gere o relatório e abra as pendências de decisão."', { duracao_ms: 1450 });
bruto(D1, '13:48:29', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 175 });
// Coordenador: o prompt traz o fluxo, e as entradas seguintes herdam
bruto(D1, '13:49:01', K, 'UserPromptSubmit', null, '[DELEGACAO F-20261008-0002] Faça a primeira auditoria das dependências (somente leitura), gere o relatório e abra as pendências de decisão.', { fluxo: F2 });
bruto(D1, '13:49:03', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 180 });
bruto(D1, '13:49:20', K, 'PostToolUse', 'Skill', 'deps-leitura', { fluxo: F2, duracao_ms: 40 });
bruto(D1, '13:49:41', K, 'PostToolUse', 'Bash', 'npm outdated --json --prefix atlas', { fluxo: F2, duracao_ms: 2310 });
bruto(D1, '13:50:05', K, 'PostToolUse', 'Bash', `npm outdated --json --prefix delta > ${RAIZ}/_maestro/estado/dependencias/versoes.json`, { fluxo: F2, duracao_ms: 1870 });
bruto(D1, '13:50:31', K, 'PostToolUseFailure', 'Bash', `node ${AUDITAR} --fluxo ${F2}`, { fluxo: F2, duracao_ms: 260, erro: 'Exit code 2: ErroEntrada: o registro de pacotes não respondeu; leia de novo em instantes' });
bruto(D1, '13:51:10', K, 'PostToolUse', 'Bash', `npm outdated --json --prefix delta > ${RAIZ}/_maestro/estado/dependencias/versoes.json`, { fluxo: F2, duracao_ms: 2050 });
bruto(D1, '13:51:44', K, 'PostToolUse', 'Bash', `node ${AUDITAR} --fluxo ${F2}`, { fluxo: F2, duracao_ms: 310, saida: 'Resumo: 13 desatualizados · 11 de correção · 2 maiores' });
bruto(D1, '13:52:38', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 190 });
bruto(D1, '13:58:12', K, 'PostToolUse', 'Read', `${RAIZ}/_maestro/conhecimento/dependencias/manual.md`, { fluxo: F2, duracao_ms: 22 });
bruto(D1, '14:00:02', K, 'PostToolUse', 'Glob', '_maestro/estado/dependencias/*.json', { duracao_ms: 15 });
bruto(D1, '14:04:55', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 200 });
bruto(D1, '14:05:58', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 170 });
bruto(D1, '14:12:18', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador --fluxo ${F2} --severidade alta --tipo aprovacao --titulo "Liberar as atualizações de correção das dependências"`, { fluxo: F2, duracao_ms: 230, saida: 'P-0002' });
bruto(D1, '14:13:02', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador --fluxo ${F2} --severidade alta --tipo decisao --titulo "Eco: definir a versão do Node"`, { fluxo: F2, duracao_ms: 220, saida: 'P-0003' });
bruto(D1, '14:13:47', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador --fluxo ${F2} --severidade normal --tipo decisao --titulo "Renomear o script \\"build:prod\\" para \\"build\\""`, { fluxo: F2, duracao_ms: 215, saida: 'P-0004' });
bruto(D1, '14:14:27', K, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente coordenador --fluxo ${F2} --severidade baixa --tipo aprovacao --titulo "Remover 5 dependências sem uso"`, { fluxo: F2, duracao_ms: 225, saida: 'P-0005' });
bruto(D1, '14:15:10', K, 'PostToolUse', 'Bash', 'maestri ask "Cérebro Principal" "[RESPOSTA F-20261008-0002] Relatório em estado/dependencias/relatorio.md; 11 mecânicos, 9 decisões; abri P-0002 a P-0005."', { fluxo: F2, duracao_ms: 1320 });
bruto(D1, '14:15:12', K, 'Stop', null, null, { fluxo: F2 });
// leitura de 09/10 08:00
bruto(D2, '08:00:02', K, 'UserPromptSubmit', null, '[ROTINA F-20261008-0002] Leia as dependências (somente leitura), atualize o resumo e o relatório, e registre o evento. Se houver alerta novo ou algo que precise do dono, avise o Cérebro com [AVISO].', { fluxo: F2 });
bruto(D2, '08:00:14', K, 'PostToolUse', 'Bash', 'npm outdated --json --prefix cometa', { fluxo: F2, duracao_ms: 2240 });
bruto(D2, '08:00:21', K, 'PostToolUse', 'Bash', `npm outdated --json --prefix delta > ${RAIZ}/_maestro/estado/dependencias/versoes.json`, { fluxo: F2, duracao_ms: 1910 });
bruto(D2, '08:00:30', K, 'PostToolUse', 'Bash', `node ${AUDITAR} --fluxo ${F2}`, { fluxo: F2, duracao_ms: 295, saida: 'Resumo: 13 desatualizados · 12 mecânicos' });
bruto(D2, '08:00:38', K, 'PostToolUse', 'Bash', 'maestri ask "Cérebro Principal" "[AVISO F-20261008-0002] Novo alerta mecânico: a trava do Cometa ficou velha."', { fluxo: F2, duracao_ms: 1290 });
bruto(D2, '08:00:44', K, 'PostToolUse', 'Bash', REG, { fluxo: F2, duracao_ms: 185 });
bruto(D2, '08:00:47', K, 'Stop', null, null, { fluxo: F2 });
bruto(D2, '08:58:12', K, 'SessionEnd', null, null, { fluxo: F2 });
// Cérebro na sexta (prompts do dono sem id de fluxo: correlação pela janela de tempo, §10.4)
bruto(D2, '08:41:00', C, 'UserPromptSubmit', null, 'Sobre a P-0004: pode renomear.');
bruto(D2, '08:41:08', C, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js responder P-0004 --resposta "Pode renomear."`, { duracao_ms: 205 });
bruto(D2, '08:41:09', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 180 });
bruto(D2, '08:41:55', C, 'PostToolUse', 'Bash', 'maestri ask "Coordenador de Dependências" "[DELEGACAO F-20261008-0002] Resposta da P-0004: pode renomear build:prod para build. Execute junto com as atualizações de correção quando a P-0002 liberar as escritas."', { duracao_ms: 1380 });
bruto(D2, '08:41:59', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 170 });
bruto(D2, '09:14:40', C, 'PostToolUse', 'Bash', 'maestri list', { duracao_ms: 760 });
bruto(D2, '09:15:02', C, 'PostToolUseFailure', 'Bash', 'maestri ask "Coordenador de Dependências" "[ROTINA F-20261008-0002] A leitura das 09:00 rodou?"', { duracao_ms: 60110, erro: 'Exit code 1: o terminal "Coordenador de Dependências" não respondeu em 60 s' });
bruto(D2, '09:15:28', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 190 });
bruto(D2, '10:02:10', C, 'PostToolUse', 'Bash', `node ${BIN}/pendencia.js abrir --agente cerebro --fluxo ${F2} --severidade critica --tipo aprovacao --titulo "Aceitar o diálogo de confiança no terminal do Coordenador"`, { duracao_ms: 240, saida: 'P-0006' });
bruto(D2, '10:02:13', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 175 });
bruto(D2, '10:19:30', C, 'UserPromptSubmit', null, 'Como estão as dependências?');
bruto(D2, '10:19:58', C, 'PostToolUse', 'Read', `${RAIZ}/_maestro/estado/dependencias/relatorio.md`, { duracao_ms: 18 });
bruto(D2, '10:20:03', C, 'PostToolUse', 'Bash', REG, { duracao_ms: 180 });
bruto(D2, '10:23:58', C, 'PostToolUse', 'Bash', `node ${BIN}/registrar.js ultimos --horas 2`, { duracao_ms: 160 });

BRUTOS.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

// ---------------------------------------------------------------- uso (estado/uso.json, §12)

const PLANO = {
  disponivel: true, fonte: 'provedor Claude do Maestri (~/.maestri/usage/providers/.status.json)',
  janela_5h_pct: 37, reset_5h: ts(D2, '13:00:00'), semanal_pct: 22, reset_semanal: '2026-10-13T09:00:00-03:00',
  atualizado_em: ts(D2, '10:21:30'),
};
const TOKENS = {
  janela_5h: [
    { agente: 'cerebro', entrada: 2140, saida: 18650, cache_escrita: 286400, cache_leitura: 8934200 },
    { agente: 'coordenador', entrada: 610, saida: 5320, cache_escrita: 98200, cache_leitura: 2210500 },
  ],
  hoje: [
    { agente: 'cerebro', entrada: 2140, saida: 18650, cache_escrita: 286400, cache_leitura: 8934200 },
    { agente: 'coordenador', entrada: 610, saida: 5320, cache_escrita: 98200, cache_leitura: 2210500 },
    { agente: 'desconhecido:atlas', entrada: 820, saida: 6100, cache_escrita: 51200, cache_leitura: 1302000 },
  ],
  '7d': [
    { agente: 'cerebro', entrada: 41820, saida: 412300, cache_escrita: 3184500, cache_leitura: 96541000 },
    { agente: 'coordenador', entrada: 9840, saida: 61250, cache_escrita: 1240300, cache_leitura: 24318700 },
    { agente: 'desconhecido:atlas', entrada: 3100, saida: 22400, cache_escrita: 402100, cache_leitura: 5120400 },
  ],
};
const r1 = (v) => Math.round(v * 10) / 10;
function periodoUso(lista, pctPlano) {
  const comC = lista.map((x) => Object.assign({}, x, { consumo_relativo: Math.round(x.entrada + 5 * x.saida + 1.25 * x.cache_escrita + 0.1 * x.cache_leitura) }));
  const soma = comC.reduce((s, x) => s + x.consumo_relativo, 0);
  return comC.map((x) => {
    const pc = r1((100 * x.consumo_relativo) / soma);
    return Object.assign(x, { pct_consumo: pc, pct_plano_estimado: pctPlano == null ? null : r1((pc * pctPlano) / 100) });
  }).sort((a, b) => b.pct_consumo - a.pct_consumo);
}
const USO = {
  coletado_em: ts(D2, '10:21:44'),
  plano: PLANO,
  por_agente: {
    janela_5h: periodoUso(TOKENS.janela_5h, PLANO.janela_5h_pct),
    hoje: periodoUso(TOKENS.hoje, null),
    '7d': periodoUso(TOKENS['7d'], PLANO.semanal_pct),
  },
};

// ---------------------------------------------------------------- montagem de /api/estado

const naoTeste = EVENTOS.filter((e) => !e.teste);
const recentes = [...naoTeste].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
const camposTabela = (e) => ({
  id: e.id, ts: e.ts, agente: e.agente, projeto: e.projeto, resumo: e.resumo,
  direcao: e.direcao, resultado: e.resultado, tipo: e.tipo, fluxo_id: e.fluxo_id, precisa_dono: e.precisa_dono,
});
const ultimoBruto = (slug) => {
  const l = BRUTOS.filter((b) => b.agente === slug);
  return l.length ? l[l.length - 1].ts : null;
};
const usoAgente = (slug) => {
  const r = {};
  for (const per of ['janela_5h', 'hoje', '7d']) {
    const x = USO.por_agente[per].find((i) => i.agente === slug);
    r[per] = x ? { pct_consumo: x.pct_consumo, consumo_relativo: x.consumo_relativo, pct_plano_estimado: x.pct_plano_estimado } : null;
  }
  return r;
};

const abertas = PENDENCIAS.filter((p) => p.status === 'aberta' && !p.teste);
const ordemSev = { critica: 0, alta: 1, normal: 2, baixa: 3 };
const porSevIdade = (a, b) => ordemSev[a.severidade] - ordemSev[b.severidade] || Date.parse(a.aberta_em) - Date.parse(b.aberta_em);
const pendOrdenadas = [
  ...PENDENCIAS.filter((p) => p.status === 'aberta' || p.status === 'respondida').sort(porSevIdade),
  ...PENDENCIAS.filter((p) => p.status !== 'aberta' && p.status !== 'respondida')
    .sort((a, b) => Date.parse(b.resolvida_em || b.atualizada_em) - Date.parse(a.resolvida_em || a.atualizada_em)).slice(0, 20),
];

// Saúde, com a mesma regra do servidor: agente ativo sem log bruto há mais de 24 h (ou nunca) → amarelo.
const hooks = AGENTES.map((a) => ({ agente: a.slug, ultimo_bruto: ultimoBruto(a.slug), idade_min: min(ultimoBruto(a.slug), AGORA) }));
const motivos = [];
for (const a of AGENTES) {
  const h = hooks.find((x) => x.agente === a.slug);
  if (a.status !== 'ativo') continue;
  if (!h.ultimo_bruto) motivos.push(`${a.nome}: nenhum log bruto ainda (hooks instalados?)`);
  else if (h.idade_min > 24 * 60) motivos.push(`${a.nome} sem log bruto há ${Math.floor(h.idade_min / 60)} h`);
}

const estado = {
  gerado_em: AGORA,
  workspace: { nome: 'Exemplo', raiz: RAIZ },
  saude: {
    nivel: motivos.length ? 'amarelo' : 'verde',
    motivos,
    ultimo_evento_idade_min: min(recentes[0].ts, AGORA),
    uso_idade_min: min(PLANO.atualizado_em, AGORA),
    hooks,
    wire: false,
  },
  kpis: {
    pendencias: {
      total: abertas.length,
      critica: abertas.filter((p) => p.severidade === 'critica').length,
      alta: abertas.filter((p) => p.severidade === 'alta').length,
      normal: abertas.filter((p) => p.severidade === 'normal').length,
      baixa: abertas.filter((p) => p.severidade === 'baixa').length,
    },
    uso: {
      disponivel: PLANO.disponivel, janela_5h_pct: PLANO.janela_5h_pct, reset_5h: PLANO.reset_5h,
      semanal_pct: PLANO.semanal_pct, reset_semanal: PLANO.reset_semanal, idade_min: min(PLANO.atualizado_em, AGORA),
    },
  },
  agentes: AGENTES.map((a) => {
    const meus = recentes.filter((e) => e.agente === a.slug);
    const u = meus[0] || null;
    return {
      slug: a.slug, nome: a.nome, tipo: a.tipo, cor: a.cor, responsabilidade: a.responsabilidade, status: a.status,
      modelo: a.modelo, nivel: a.nivel, skills: a.skills, conectado_a: a.conectado_a,
      ultimo_evento: u ? { ts: u.ts, resumo: u.resumo, tipo: u.tipo, resultado: u.resultado } : null,
      eventos_hoje: meus.filter((e) => e.ts.startsWith(D2)).length,
      // o fluxo 1 (bootstrap) terminou no relatório final; o fluxo 2 segue aberto (pendências)
      fluxos_abertos: meus.some((e) => e.fluxo_id === F2) ? 1 : 0,
      ultimo_bruto: ultimoBruto(a.slug),
      uso: usoAgente(a.slug),
    };
  }),
  pendencias: pendOrdenadas,
  uso: USO,
  eventos: recentes.slice(0, 200).map(camposTabela),
};

const detalhes = {
  descricao: 'Dados extras do modo de teste do painel (index.html?mock=1): eventos completos (inclusive os de teste), comandos brutos e fluxos, para imitar /api/eventos, /api/evento/<id> e /api/fluxo/<id> sem o servidor. Gerado por testes/gerar-mock.js.',
  gerado_em: AGORA,
  fluxos: {
    [F1]: { titulo: 'Bootstrap da Fase 1', agente: 'cerebro', criado_em: ts(D1, '00:52:02') },
    [F2]: { titulo: 'Dependências: primeira auditoria e pendências', agente: 'cerebro', criado_em: ts(D1, '13:48:12') },
  },
  eventos: EVENTOS,
  comandos_brutos: BRUTOS,
};

// ---------------------------------------------------------------- conferências e gravação

const ids = new Set();
for (const e of EVENTOS) {
  if (ids.has(e.id)) throw new Error(`id repetido: ${e.id}`);
  ids.add(e.id);
}
const dias = new Set(naoTeste.map((e) => e.ts.slice(0, 10)));
const fluxos = new Set(EVENTOS.map((e) => e.fluxo_id));
if (dias.size !== 2 || fluxos.size !== 2) throw new Error('o cenário deve ter 2 dias e 2 fluxos');

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'mock-estado.json'), JSON.stringify(estado, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(dir, 'mock-detalhes.json'), JSON.stringify(detalhes, null, 2) + '\n', 'utf8');
console.log(`mock-estado.json: ${estado.eventos.length} eventos na tabela, ${estado.pendencias.length} pendências, saúde ${estado.saude.nivel}`);
console.log(`mock-detalhes.json: ${EVENTOS.length} eventos (${EVENTOS.length - naoTeste.length} de teste), ${BRUTOS.length} comandos brutos, ${fluxos.size} fluxos`);
