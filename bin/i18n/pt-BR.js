'use strict';
// pt-BR dictionary of the flow CLI (ADR 0004): every message a person reads. The keys are in English; the values
// are what the person reads. Same idea as the page's dictionary (panel/ui/src/i18n/pt-BR.js): a text with {param}
// or a function when the text needs logic. Read through t() in bin/i18n/index.js.

const STAGES = {
  specification: 'Especificação',
  implementation: 'Implementação',
  final_adjustment: 'Ajuste final',
  pr_ready: 'PR pronto',
  merge: 'Merge',
  hml_validation: 'Validação HML',
  done: 'Concluído',
};

const PR_STATES = { draft: 'em rascunho', ready: 'pronto', merged: 'mergeado' };

module.exports = {
  stages: STAGES,
  companies: {
    unassigned: 'Sem empresa',
  },
  done: {
    itemStarted: (p) => `Item ${p.key} (${p.ref}) iniciado em ${STAGES[p.stage] || p.stage}.`,
    stageChanged: (p) => `Item ${p.key} (${p.ref}) agora em ${STAGES[p.stage] || p.stage}.`,
    projectRegistered: 'Projeto "{project}" cadastrado em "{company}" a partir de {remote}. Mova-o para a empresa certa pelo painel.',
  },
  errors: {
    prefix: 'erro: {message}',
    unknownCommand: 'subcomando desconhecido: "{command}" (veja flow --help).',
    missingCommand: 'falta o subcomando (veja flow --help).',
    unknownOption: 'opção desconhecida: --{option} (veja flow --help).',
    missingValue: 'falta o valor de --{option}.',
    repeatedOption: '--{option} foi informado mais de uma vez.',
    unexpectedArgument: 'argumento inesperado: "{value}" (veja flow --help).',
    jsonStdinInteractive: '--json - espera o JSON pela entrada padrão (pipe ou redirecionamento), ex.: node bin/flow.js item start --json - < item.json',
    jsonOnlyStdin: '--json só aceita "-" (o JSON vem pela entrada padrão).',
    jsonEmpty: 'o JSON da entrada padrão está vazio.',
    jsonInvalid: 'o JSON da entrada padrão é inválido: {detail}',
    jsonNotObject: 'o JSON da entrada padrão precisa ser um objeto ({...}).',
    jsonFieldType: 'o campo "{field}" do JSON precisa ser {expected}.',
    missingNumber: 'falta o número do item (ex.: flow item start 12 --title "...").',
    invalidNumber: 'número de item inválido: "{value}" (use um inteiro positivo, como no tracker: 12 ou 3100).',
    missingTitle: 'falta o título do item (--title "..." ou "title" no JSON).',
    titleTooLong: 'o título tem {length} caracteres; o máximo é {max}.',
    missingStage: 'falta a etapa (ex.: flow stage 12 implementation).',
    unknownStage: (p) => `etapa desconhecida: "${p.stage}". Use uma destas: ${p.allowed.map((s) => `${s} (${STAGES[s] || s})`).join(', ')}.`,
    stageNotInProject: (p) => `o projeto "${p.project}" não usa a etapa "${p.stage}". Etapas do projeto: ${p.allowed.join(', ')}.`,
    invalidRole: 'papel inválido: "{value}" (use {allowed}).',
    invalidAgent: 'nome de agente inválido: use até {max} caracteres, numa linha só.',
    notARepository: 'não achei o "git remote origin" em {cwd}. Rode o comando dentro do repositório do projeto (ou do worktree de um floor).',
    itemAlreadyStarted: (p) => `o item ${p.key} (${p.ref}) já foi iniciado em ${p.at}. Para mudar a etapa, use: flow stage ${p.number} <etapa>.`,
    itemNotStarted: (p) => `o item ${p.key} (${p.ref}) ainda não foi iniciado. Comece com: flow item start ${p.number} --title "...".`,
    unexpected: 'falha inesperada: {detail}',
  },
  // PR, final adjustment, HML and conclusion (#9).
  delivery: {
    done: {
      pr: (p) => `Item ${p.key} (${p.ref}): PR ${PR_STATES[p.state] || p.state} registrado. Etapa: ${STAGES[p.stage] || p.stage}.`,
      'adjustment-open': (p) => `Item ${p.key} (${p.ref}): ajuste final aberto. Etapa: ${STAGES[p.stage] || p.stage}.`,
      'adjustment-result': (p) => `Item ${p.key} (${p.ref}): ajuste final ${p.outcome === 'passed' ? 'aprovado' : 'reprovado'}. Etapa: ${STAGES[p.stage] || p.stage}.`,
      hml: (p) => `Item ${p.key} (${p.ref}): Validação HML registrada (${p.passed} aprovado(s), ${p.failed} reprovado(s), ${p.blocked} bloqueado(s)). Etapa: ${STAGES[p.stage] || p.stage}.`,
      'item-done': (p) => `Item ${p.key} (${p.ref}) concluído. Ele sai da lista de ativos e continua consultável no painel.`,
    },
    errors: {
      missingPrState: 'falta o estado do PR (ex.: flow pr 12 draft --url https://github.com/org/repo/pull/34).',
      invalidPrState: 'estado de PR inválido: "{value}" (use draft, ready ou merged).',
      invalidPrNumber: 'número de PR inválido: "{value}" (use um inteiro positivo).',
      invalidBranch: 'nome de branch inválido: use até {max} caracteres, sem espaços.',
      missingPrUrl: 'falta a URL do PR (--url): o item ainda não tem PR registrado. Ex.: flow pr {number} {state} --url https://github.com/org/repo/pull/34',
      linkNotTracker: 'o link de {option} precisa ser https de um tracker (github.com, dev.azure.com ou *.visualstudio.com): "{value}".',
      invalidAdjustmentAction: 'ação de ajuste final inválida: "{value}" (use open ou result).',
      openTakesNoResult: '"final-adjustment open" não leva --outcome nem --summary; o resultado vem depois com "final-adjustment <número> result".',
      invalidOutcome: 'resultado do ajuste final inválido: "{value}" (use --outcome passed ou failed).',
      adjustmentNotOpen: (p) => `o item ${p.key} (${p.ref}) não tem ajuste final aberto. Abra antes com: flow final-adjustment ${p.number} open.`,
      summaryTooLong: 'o resumo tem {length} caracteres; o máximo é {max}.',
      invalidCount: 'quantidade inválida em {option}: "{value}" (use um inteiro a partir de 0).',
      noScenarios: 'informe quantos cenários foram aprovados, reprovados e bloqueados (--passed, --failed, --blocked); pelo menos um maior que 0.',
      alreadyDone: 'o item {key} ({ref}) já está concluído.',
    },
  },
  help: (p) => `flow · registra o fluxo dos itens no painel (eventos em ${p.db})

O projeto é reconhecido pelo "git remote origin" da pasta atual (vale dentro do worktree de um floor).
Um repositório sem cadastro entra na empresa "Sem empresa" e o comando segue.

USO
  node bin/flow.js item start <número> --title "..." [--stage <etapa>] [opções do agente]
      Inicia o item (Issue do GitHub ou PBI do Azure DevOps) na etapa dada (padrão: a primeira do projeto,
      em geral specification). As etapas anteriores contam como concluídas.
  node bin/flow.js stage <número> <etapa> [opções do agente]
      Muda a etapa do item.
  node bin/flow.js pr <número> draft|ready|merged [--url <URL do PR>] [--pr <n>] [--branch <branch integradora>]
      Registra o PR do item: draft (criado em rascunho; leva o item a Implementação, se ele estiver antes),
      ready (saiu do rascunho → PR pronto) ou merged (mergeado pelo próprio maestro → Merge). A URL é
      obrigatória no primeiro registro; o número sai da URL quando --pr não vem.
  node bin/flow.js final-adjustment <número> open [opções do agente]
      Abre o ajuste final (→ Ajuste final).
  node bin/flow.js final-adjustment <número> result --outcome passed|failed [--summary "..."]
      Registra o resultado do ajuste final (a etapa não muda).
  node bin/flow.js hml <número> --passed <n> --failed <n> --blocked <n> [--card <URL do card>] [--summary "..."]
      Registra o resultado da Validação HML (→ Validação HML). Use --role owner quando for o dono.
  node bin/flow.js item done <número>
      Conclui o item (→ Concluído): ele sai da lista de ativos e continua consultável.
  Links (--url, --card) só de trackers: https em github.com, dev.azure.com ou *.visualstudio.com.
  Um evento cuja etapa o projeto não usa é recusado (ex.: hml num projeto sem Validação HML).

OPÇÕES DO AGENTE
  --role maestro|worker|owner     quem grava (padrão: maestro)
  --agent "<nome>"                codinome do agente (opcional)

JSON PELA ENTRADA PADRÃO (texto com acentos, aspas e várias linhas chega intacto em qualquer shell)
  --json -     os campos vêm num objeto JSON pela entrada padrão; os argumentos valem mais que o JSON
  Campos: number, title, stage, role, agent; state, url, pr, branch (pr); action, outcome, summary
  (final-adjustment); passed, failed, blocked, card, summary (hml).
  ex.: node bin/flow.js item start --json - < item.json

ETAPAS
${Object.entries(STAGES).map(([id, name]) => `  ${id.padEnd(17)} ${name}`).join('\n')}

CÓDIGOS DE SAÍDA
  0 ok · 2 dados inválidos (a mensagem diz o que corrigir) · 1 outros erros

VARIÁVEIS
  MAESTRO_DIR   pasta dos dados (padrão: ~/.painel-maestro)
`,
};
