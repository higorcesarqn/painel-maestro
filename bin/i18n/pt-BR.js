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

// What a worker posts with "flow status --state" (the states of "maestri floor status").
const WORKER_STATES = {
  working: 'trabalhando',
  blocked: 'bloqueada',
  review: 'revisão',
  done: 'pronta (revisão)',
};

const PR_STATES = { draft: 'em rascunho', ready: 'pronto', merged: 'mergeado' };

const FINDING_CLASSES = { defect: 'defeito claro', owner_decision: 'depende do dono', discarded: 'descartado' };

module.exports = {
  stages: STAGES,
  workerStates: WORKER_STATES,
  companies: {
    unassigned: 'Sem empresa',
  },
  // bin/install-skills.js (#15)
  installSkills: {
    done: {
      claudeDir: 'Pasta do Claude: {dir}',
      linked: '{target}: ligado a {source}.',
      alreadyLinked: '{target}: já estava ligado a este repositório.',
      backedUp: '{target}: o que existia foi guardado em {backup}.',
      unlinked: '{target}: link removido.',
      restored: '{target}: backup restaurado.',
      notOurs: '{target}: não é um link deste repositório; ficou como está.',
      nothingToUndo: '{target}: nada para desfazer.',
    },
    errors: {
      unknownArgument: 'argumento desconhecido: "{value}" (veja node bin/install-skills.js --help).',
      missingValue: 'falta o valor de --{option}.',
      manifestUnreadable: 'não consegui ler {file}: {detail}',
      manifestShape: '{file} precisa ser um objeto com a lista "links".',
      manifestEntry: 'entrada inválida em skills/links.json: {entry} (use "source" e "target" relativos, sem "..").',
      manifestRepeated: 'o destino {target} aparece mais de uma vez em skills/links.json.',
      sourceMissing: 'a pasta {source} declarada em skills/links.json não existe no repositório.',
      backupTaken: '{target} existe e não é um link deste repositório, mas o backup {backup} já está ocupado. Mova um dos dois e rode de novo.',
      targetReplaced: '{target} não é mais um link deste repositório e há um backup em {backup}. Resolva à mão qual dos dois fica e rode de novo.',
      conflicts: (p) => `nada foi alterado:\n${p.list.map((l) => `  - ${l}`).join('\n')}`,
    },
    help: (p) => `install-skills · liga as skills do dono deste repositório à pasta do Claude (~/.claude)

USO
  node bin/install-skills.js [--claude-dir <pasta>]           instala (liga cada entrada de skills/links.json)
  node bin/install-skills.js --undo [--claude-dir <pasta>]    desfaz (remove os links e restaura os backups)

O que é instalado: ${p.manifest} ({"links": [{"source": "skills/x", "target": "skills/x"}]}).
Cada link é uma junction de diretório no Windows (não exige administrador). O que já existir no destino e
não for um link deste repositório vai para <pasta do Claude>/backups/painel-maestro/<destino>; --undo devolve.
Rodar de novo é seguro: o que já está ligado fica como está. Um conflito para tudo antes de mudar qualquer coisa.

PASTA DO CLAUDE
  --claude-dir, senão CLAUDE_CONFIG_DIR, senão ~/.claude

CÓDIGOS DE SAÍDA
  0 ok · 2 dados inválidos ou conflito (nada alterado) · 1 outros erros
`,
  },
  done: {
    itemStarted: (p) => `Item ${p.key} (${p.ref}) iniciado em ${STAGES[p.stage] || p.stage}.`,
    stageChanged: (p) => `Item ${p.key} (${p.ref}) agora em ${STAGES[p.stage] || p.stage}.`,
    projectRegistered: 'Projeto "{project}" cadastrado em "{company}" a partir de {remote}. Mova-o para a empresa certa pelo painel.',
    taskGraph: (p) => `Grafo de tasks do item ${p.key} (${p.ref}) registrado: ${p.count} task${p.count === 1 ? '' : 's'}.`,
    taskDispatched: (p) => `Task ${p.task} do item ${p.key} (${p.ref}) despachada${p.floor ? ` no floor "${p.floor}"` : ''}${p.worker ? ` para ${p.worker}` : ''}${p.branch ? ` (branch ${p.branch})` : ''}.`,
    taskIntegrated: 'Task {task} do item {key} ({ref}) integrada em {sha}.',
    taskStatus: (p) => `Status da task ${p.task} do item ${p.key}: ${WORKER_STATES[p.state] || p.state} · "${p.text}".`,
    floorStatusPosted: 'Status do floor atualizado no Maestri (maestri floor status).',
    floorStatusFailed: 'O status foi gravado no painel, mas o maestri floor status falhou.',
    outsideMaestri: 'Fora do Maestri (sem MAESTRI_TERMINAL_ID): só gravado no painel.',
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
    missingTask: 'falta o número da task (ex.: flow task dispatch 12 13 --floor "..." --worker "...").',
    invalidTaskNumber: 'número de task inválido: "{value}" (use um inteiro positivo, como no tracker).',
    missingTasks: 'falta o grafo de tasks: use --task "<número>|<título>[|<bloqueios>]" (uma vez por task) ou "tasks" no JSON.',
    tooManyTasks: 'o grafo tem tasks demais (máximo {max}).',
    invalidTaskSpec: 'task inválida: "{value}". Use --task "<número>|<título>" ou "<número>|<título>|<bloqueios separados por vírgula>", ex.: --task "14|Enviar por e-mail|13".',
    missingTaskTitle: 'falta o título da task {task}.',
    duplicateTask: 'a task {task} aparece mais de uma vez no grafo.',
    selfBlocker: 'a task {task} não pode bloquear a si mesma.',
    unknownBlocker: 'a task {task} é bloqueada pela {blocker}, que não está no grafo.',
    unknownOutTask: 'a task {task} de --out não está no grafo.',
    graphCycle: 'os bloqueios formam um ciclo: {cycle}.',
    taskNotInItem: 'a task {task} não é do item {key} (tasks do item: {tasks}). Registre o grafo com: flow task graph.',
    taskNotFound: 'nenhum item do projeto "{project}" tem a task {task}. Informe o item com --item <número> ou registre o grafo.',
    taskAmbiguous: 'a task {task} aparece em mais de um item ({items}): informe qual com --item <número>.',
    branchAmbiguous: 'a branch {branch} foi despachada para mais de uma task ({tasks}): informe qual com --item e --task.',
    statusNoTask: 'não sei de qual task é este status (branch atual: {branch}). Rode na branch da task (task/<id>-…) ou informe --item e --task.',
    missingSha: 'falta o SHA da integração (--sha <sha> ou "sha" no JSON).',
    invalidSha: 'SHA inválido em {field}: "{value}" (use de 7 a 64 caracteres hexadecimais).',
    invalidText: 'o campo "{field}" precisa ter até {max} caracteres, numa linha só.',
    missingStatusText: 'falta o texto do status (ex.: flow status "Testes verdes, ligando a tela" --progress 3/5).',
    invalidStatusState: 'estado inválido: "{value}" (use {allowed}).',
    invalidProgress: 'progresso inválido: "{value}" (use n/m, ex.: 3/5).',
    maestriNotFound: 'não achei o executável "{cli}" (configure FLOW_MAESTRI_CLI ou MAESTRI_CLI)',
    maestriFailed: 'o status foi gravado no painel, mas o maestri floor status falhou: {detail}',
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
  // Worker's reports and maestro's findings (#8).
  review: {
    done: {
      report: (p) => `Relatório da task ${p.task} do item ${p.key} gravado (${p.status === 'ok' ? 'ok' : 'bloqueado'}). Agora envie-o ao maestro.`,
      findingRecorded: (p) => `Achado ${p.finding} do item ${p.key} (${p.ref}) registrado: ${FINDING_CLASSES[p.classification] || p.classification}${p.task ? `; virou a task ${p.task} (fora, para triagem)` : ''}.`,
      findingLinked: 'Achado {finding} do item {key} ({ref}) ligado à task {task} (fora, para triagem).',
    },
    errors: {
      missingStatus: 'falta o status do relatório (--status ok|blocked ou "status" no JSON).',
      invalidStatus: 'status do relatório inválido: "{value}" (use ok ou blocked).',
      emptyReport: 'o relatório está vazio: mande o texto ("text") e os campos (tests, changes, decisions, risks, shared_files) pelo --json -.',
      textTooLong: 'o campo "{field}" tem {length} caracteres; o máximo é {max}.',
      listTooLong: 'o campo "{field}" tem itens demais (máximo {max}).',
      missingFindingTitle: 'falta o título do achado (--title "..." ou "title" no JSON).',
      missingClassification: 'falta a classificação do achado (--classification defect|owner_decision|discarded).',
      invalidClassification: 'classificação inválida: "{value}" (use defect, owner_decision ou discarded).',
      discardedNewTask: 'um achado descartado não vira task (tire --new-task ou mude a classificação).',
      missingNewTask: 'falta a task nova (--new-task <número>).',
      missingFinding: 'falta o número do achado (ex.: flow finding link 12 2 --new-task 27).',
      invalidFinding: 'número de achado inválido: "{value}".',
      findingNotFound: 'o item {key} não tem o achado {finding}.',
      findingAlreadyLinked: 'o achado {finding} do item {key} já virou a task {task}.',
      taskAlreadyInItem: 'a task {task} já é do item {key}; o achado vira uma task nova (use outro número).',
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

TASKS (maestro)
  node bin/flow.js task graph <número> --task "<task>|<título>[|<bloqueios>]" ... [--out <task,...>]
      Registra o grafo de tasks do item (repita --task uma vez por task). Bloqueios: as tasks, separadas por
      vírgula, que precisam estar integradas antes desta. --out marca tasks fora do item. O último grafo
      registrado vale; um item sem grafo é uma task só, ele mesmo (o número da task é o do item).
      ex.: --task "13|Gerar o PDF" --task "14|Enviar por e-mail|13"
  node bin/flow.js task dispatch <número> <task> [--floor "<floor>"] [--worker "<codinome>"] [--branch <branch>]
      Registra a task despachada: floor do Maestri, trabalhador (codinome ou "subagente") e branch.
  node bin/flow.js task integrate <número> <task> --sha <sha> [--sha-before <sha>]
      Registra a task integrada na branch integradora (SHA depois e, opcional, antes da integração).

STATUS (trabalhador)
  node bin/flow.js status "<texto>" [--state working|blocked|review|done] [--progress n/m] [--item <número>] [--task <task>]
      O comando único de status: dentro do Maestri (com MAESTRI_TERMINAL_ID) roda "maestri floor status"
      com os mesmos argumentos e grava o evento; fora do Maestri (subagente) só grava. --state padrão: working;
      "done" conta como pronta para revisão. Sem --item/--task, a task vem da branch atual: a task despachada
      com esta branch ou, senão, task/<task>-… (--item resolve quando a task existe em mais de um item).
      Papel padrão: worker. Se o maestri falhar, o evento é gravado e o comando sai com 1.

RELATÓRIO (trabalhador, antes de enviá-lo ao maestro)
  node bin/flow.js report [--item <número>] [--task <task>] [--status ok|blocked] [--reason "..."] [--branch <b>] [--sha <sha>] --json - < relatorio.json
      Grava o relatório completo da task. Os campos longos vêm pelo JSON e ficam exatamente como escritos:
      status (ok|blocked), blocked_reason, branch, sha, tests, changes, decisions (lista), risks,
      shared_files (lista) e text (o relatório inteiro, em texto livre). A task vem como no status (--item/--task
      ou a branch atual); branch e SHA, quando não vêm, saem da pasta atual. Papel padrão: worker.

ACHADOS (maestro)
  node bin/flow.js finding add <número> --title "..." --classification defect|owner_decision|discarded [--description "..."] [--task <origem>] [--new-task <n> [--new-task-title "..."]]
      Registra um achado do item (defect: defeito claro; owner_decision: depende do dono; discarded: descartado),
      opcionalmente com a task de origem. --new-task liga o achado a uma task nova para triagem: ela aparece no
      item com o estado "fora" até entrar no grafo ou ser despachada. Os achados são numerados por item (1, 2, …).
  node bin/flow.js finding link <número> <achado> --new-task <n> [--new-task-title "..."]
      Liga depois um achado já registrado à task nova que ele virou.

OPÇÕES DO AGENTE
  --role maestro|worker|owner     quem grava (padrão: maestro; no status, worker)
  --agent "<nome>"                codinome do agente (opcional)

JSON PELA ENTRADA PADRÃO (texto com acentos, aspas e várias linhas chega intacto em qualquer shell)
  --json -     os campos vêm num objeto JSON pela entrada padrão; os argumentos valem mais que o JSON
  Campos: number (o item), title, stage, role, agent; task, tasks ([{number, title, blocked_by, out}]), floor,
  worker, branch, sha, sha_before, text, state, progress (tasks e status); state, url, pr, branch (pr);
  action, outcome, summary (final-adjustment); passed, failed, blocked, card, summary (hml); status,
  blocked_reason, tests, changes, decisions, risks, shared_files, text (report); title, description,
  classification, task, new_task, new_task_title, finding (finding).
  ex.: node bin/flow.js item start --json - < item.json

ETAPAS
${Object.entries(STAGES).map(([id, name]) => `  ${id.padEnd(17)} ${name}`).join('\n')}

CÓDIGOS DE SAÍDA
  0 ok · 2 dados inválidos (a mensagem diz o que corrigir) · 1 outros erros

VARIÁVEIS
  MAESTRO_DIR           pasta dos dados (padrão: ~/.painel-maestro)
  MAESTRI_TERMINAL_ID   presente num terminal do Maestri: o status também roda "maestri floor status"
  FLOW_MAESTRI_CLI      executável do maestri usado pelo status (padrão: MAESTRI_CLI ou "maestri")
`,
};
