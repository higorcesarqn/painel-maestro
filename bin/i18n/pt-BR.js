'use strict';
// pt-BR dictionary of the bin/ commands and of the server's terminal (ADR 0004): every message a person reads. The keys are in English; the values
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

// Pending decisions (#10): kinds and severities of "flow pending open".
const PENDING_KINDS = {
  task_review: 'revisão de task',
  worker_blocked: 'trabalhador bloqueado',
  decision: 'decisão',
  finding: 'achado que depende do dono',
  parallelize: 'paralelizar tasks',
  hml: 'Validação HML',
};
const PENDING_SEVERITIES = { critical: 'crítica', high: 'alta', normal: 'normal', low: 'baixa' };

const PENDING = {
  kinds: PENDING_KINDS,
  severities: PENDING_SEVERITIES,
  done: {
    opened: (p) => `Pendência P-${p.id} (${PENDING_KINDS[p.kind] || p.kind}) aberta no item ${p.key} (${p.ref})${p.task ? `, task ${p.task}` : ''}.`
      + (p.workspace || p.terminal ? ` Responder em: ${[p.workspace && `workspace "${p.workspace}"`, p.terminal && `terminal "${p.terminal}"`].filter(Boolean).join(', ')}.` : ' Sem workspace/terminal do Maestri: informe --workspace e --terminal para o dono saber onde responder.'),
    resolved: 'Pendência P-{id} do item {key} resolvida; a decisão ficou na linha do tempo do item.',
    canceled: 'Pendência P-{id} do item {key} cancelada.',
  },
  errors: {
    missingKind: 'falta o tipo da pendência (--kind): {allowed}.',
    invalidKind: 'tipo de pendência inválido: "{value}" (use {allowed}).',
    invalidSeverity: 'severidade inválida: "{value}" (use {allowed}).',
    missingTitle: 'falta o título da pendência (--title "..." ou "title" no JSON).',
    tooManyOptions: 'opções demais (máximo {max}).',
    reviewNeedsTask: 'a pendência de revisão (task_review) precisa da task: --task <número>.',
    textTooLong: 'o campo "{field}" tem {length} caracteres; o máximo é {max}.',
    missingId: 'falta o id da pendência (ex.: flow pending resolve P-7 --decision "...").',
    invalidId: 'id de pendência inválido: "{value}" (use P-<número> ou só o número, como o flow pending open mostrou).',
    missingDecision: 'falta a decisão do dono (--decision "..." ou "decision" no JSON).',
    notFound: 'a pendência P-{id} não existe no projeto "{project}". Rode o comando no repositório do projeto da pendência.',
    notOpen: (p) => `a pendência P-${p.id} já está ${p.status === 'canceled' ? 'cancelada' : 'resolvida'}${p.at ? ` (desde ${p.at})` : ''}.`,
  },
};

// Help of "flow company" and "flow project" (#6), a section of the flow help.
const ADMIN_HELP = `EMPRESAS E PROJETOS (dono; não precisam rodar dentro de um repositório)
  node bin/flow.js company list
  node bin/flow.js company add <id> --name "<nome>"
      Cadastra uma empresa. O trabalho pessoal é uma empresa como as outras (ex.: personal, "Pessoal").
  node bin/flow.js project list [--company <id>]
  node bin/flow.js project add <id> --company <id> [--name "<nome>"] [--tracker github|azure_devops]
        [--repo <url do remote>]... [--stages <etapa,...>] [--done-state "<estado>"] [--workspace "<workspace>"]
      Cadastra um projeto. Repita --repo para cada repositório (um projeto do Azure DevOps costuma ter vários);
      sem --repo, vale o remote da pasta atual. O tracker vem do remote quando não é informado. --stages: as
      etapas que o projeto usa (padrão: todas); --done-state: o estado do tracker que significa concluído (ex.:
      Committed); --workspace: o workspace do Maestri do projeto.
  node bin/flow.js project edit <id> [--name] [--company] [--tracker] [--repo <url>]... [--remove-repo <url>]...
        [--stages] [--done-state] [--workspace]
      Muda o cadastro (um --done-state ou --workspace vazio apaga o valor). O id não muda.
  node bin/flow.js project move <id> <empresa>
      Move o projeto para outra empresa (o painel também faz isso, para os projetos em "Sem empresa").
  JSON (--json -): id, name, company, tracker, repos, remove_repos, stages, done_state, maestri_workspace.
`;

const FINDING_CLASSES = { defect: 'defeito claro', owner_decision: 'depende do dono', discarded: 'descartado' };

module.exports = {
  stages: STAGES,
  workerStates: WORKER_STATES,
  pending: PENDING,
  companies: {
    unassigned: 'Sem empresa',
  },
  // bin/collect-usage.js: help, errors and the readable summary (the codes of usage.json, in Portuguese for the CLI)
  usage: {
    help: `Uso: node collect-usage.js [--json] [--no-write] [--now <ISO>]
  Coleta o uso do Claude: o % do plano (Maestri) e a participação de cada item e de cada
  agente (transcrições das sessões que o hook ligou no bruto.db), e grava state/usage.json.
  --json       imprime o usage.json no stdout
  --no-write   não grava state/usage.json nem state/usage-cache.json
  --now        fixa o "agora" (testes), ex.: 2026-10-08T15:50:00-03:00
Variáveis: MAESTRO_DIR (padrão ~/.painel-maestro), MAESTRI_DATA_DIR (padrão ~/.maestri), CLAUDE_CONFIG_DIR (padrão ~/.claude).`,
    errors: {
      prefix: 'Erro: {message}',
      unexpected: 'Erro inesperado: {detail}',
      invalidNow: '--now inválido: "{value}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).',
      unknownOption: 'Opção desconhecida: {option} (use --help).',
    },
    // c: the code's parameters, plus time(iso) (short time next to the collection) and describe(code) (a nested code)
    codes: {
      plan_file_missing: 'O Maestri ainda não gravou o uso do plano ({file} não existe). Ligue o uso dos agentes no Maestri (Configurações → Agentes → Uso) e deixe os anéis visíveis.',
      plan_file_unreadable: (c) => `Não consegui ler ${c.file}: ${c.describe(c.error)}.`,
      read_failed: 'não consegui ler ({detail})',
      empty_file: 'arquivo vazio',
      invalid_json: 'JSON inválido ({detail})',
      plan_provider_missing: 'O arquivo de uso do Maestri não tem o provedor "claude".',
      plan_provider_off: 'O provedor Claude está desligado no Maestri (Configurações → Agentes → Uso).',
      plan_read_failed: (c) => `O Maestri não conseguiu ler o uso do Claude (estado "${c.state}"${c.error ? `: ${c.error}` : ''}).`,
      plan_windows_missing: 'O Maestri ainda não trouxe as janelas do plano (5 h e semanal).',
      plan_windows_unavailable: (c) => [c.describe(c.window_5h_reason), c.describe(c.weekly_reason)].filter(Boolean).join(' '),
      plan_last_read_failed: (c) => `A última consulta do Maestri falhou (estado "${c.state}"${c.error ? `: ${c.error}` : ''}); os valores são da leitura${c.read_at ? ` de ${c.time(c.read_at)}` : ''}.`,
      window_missing: (c) => `O Maestri não trouxe a janela ${c.window === '5h' ? 'de 5 h' : 'semanal'}.`,
      window_without_pct: (c) => `A janela ${c.window === '5h' ? 'de 5 h' : 'semanal'} veio sem o percentual usado.`,
      window_reset: (c) => `A janela ${c.window === '5h' ? 'de 5 h' : 'semanal'} reiniciou às ${c.time(c.reset_at)}, depois da última leitura do Maestri${c.read_at ? ` (${c.time(c.read_at)})` : ''}; o % novo aparece na próxima leitura.`,
      raw_log_missing: 'Ainda não há log bruto (bruto.db): o hook não gravou nenhuma sessão de projeto cadastrado.',
      invalid_transcript_lines: '{count} linha(s) de transcrição ilegível(is) ignorada(s).',
      transcript_unreadable: 'Não consegui ler {file}: {error}',
      transcript_read_interrupted: 'Leitura interrompida em {file}: {error}',
    },
    summary: {
      collected: 'Uso coletado em {when}',
      resets: ' (reinicia {when})',
      age: ' · dado de {minutes} min',
      plan: 'Plano: 5 h {pct5}{reset5} · semanal {pct7}{reset7}{age}',
      planUnavailable: 'Plano: indisponível. {reason}',
      planWarning: '  Aviso: {warning}',
      byItem: 'Por item, % do consumo (janela de 5 h · hoje · 7 dias):',
      byAgent: 'Por agente, % do consumo (janela de 5 h · hoje · 7 dias):',
      noSessions: '  nenhuma sessão com consumo',
      cache: { new: 'novo', reused: 'reaproveitado', recreated: 'recriado' },
      collection: 'Sessões: {sessions} · transcrições: {transcripts} ({missing} ainda sem arquivo) · {mb} MB lidos · cache {cache}',
      warning: 'Aviso: {warning}',
      wrote: 'Gravado em state/usage.json',
      notWritten: 'Nada gravado (--no-write)',
    },
  },
  // bin/time-window.js (the --pre-run of Maestri routines)
  timeWindow: {
    prefix: 'time-window: {message}',
    start: 'Início',
    end: 'Fim',
    invalidHour: '{label} inválido: "{value}" (use H, HH ou HH:MM, ex.: 8 ou 22:30).',
    hourOutOfRange: '{label} fora do intervalo: "{value}".',
    invalidNow: '--now inválido: "{value}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).',
    unknownOption: 'Opção desconhecida: {option}.',
    missingRange: 'Informe início e fim, ex.: node time-window.js 8 22',
    emptyRange: 'Início e fim iguais: a janela ficaria vazia.',
  },
  // panel/server.js and panel/merge-check.js: help, start-up and the terminal's log lines
  server: {
    help: `Uso: node server.js [--port 4777]
  Sobe o painel em http://127.0.0.1:<porta> (só nesta máquina).
  Parar: Ctrl+C neste terminal, ou taskkill /PID <pid de <MAESTRO_DIR>/state/panel.pid> /F
Variáveis: PANEL_PORT, MAESTRO_DIR (padrão ~/.painel-maestro), MAESTRI_DATA_DIR, CLAUDE_CONFIG_DIR,
  PANEL_COLLECTOR=0 (sem coletor automático), PANEL_STALE_HOURS (padrão 48: horas na mesma
  etapa para um item contar como parado na Visão geral).
  Verificador de merge: PANEL_MERGE_CHECK=0 (desliga) ou 1 (liga), PANEL_MERGE_CHECK_SECONDS
  (intervalo, padrão 600), PANEL_GH_CLI, PANEL_AZ_CLI, PANEL_AZURE_DEVOPS_URL.
`,
    errors: {
      prefix: 'Erro: {message}',
      unknownOption: 'Opção desconhecida: {option} (use --help).',
      invalidPort: 'Porta inválida: "{value}" (use um número de 1 a 65535).',
      invalidNow: 'Relógio fixo inválido: "{value}" (use ISO, ex.: 2026-10-08T15:50:00-03:00).',
      invalidStaleHours: 'PANEL_STALE_HOURS inválido: "{value}" (use um número de horas maior que zero).',
      invalidMergeCheck: 'PANEL_MERGE_CHECK inválido: "{value}" (use 0 ou 1).',
      invalidMergeCheckSeconds: 'PANEL_MERGE_CHECK_SECONDS inválido: "{value}" (use um inteiro a partir de 1).',
      portInUse: 'Erro: a porta {port} já está em uso em 127.0.0.1. Outro painel já está rodando? Veja o PID em {pidFile} ou suba em outra porta com --port.',
      portDenied: 'Erro: sem permissão para usar a porta {port}.',
      startFailed: 'Erro ao subir o painel: {detail}',
      unhandled: 'Erro não tratado: {detail}',
    },
    started: 'Painel no ar em http://127.0.0.1:{port} (PID {pid})',
    data: 'Dados: {dir} · PID em {pidFile}',
    howToStop: 'Para parar: Ctrl+C aqui, ou taskkill /PID {pid} /F',
    stopping: 'Encerrando o painel ({signal})...',
    indexMissing: 'O arquivo do painel não foi encontrado em {file}.',
    log: {
      usageCollected: 'Uso coletado ({trigger}): {plan} · {sessions} sessão(ões) · {ms} ms',
      usagePlan: (c) => (c.available ? `plano 5 h ${c.pct5}% · semanal ${c.pct7}%` : 'plano indisponível'),
      collectorFailed: 'Falha no coletor de uso ({trigger}): {detail}',
      projectMoved: 'Projeto {project} movido pelo painel para a empresa {company}',
      requestFailed: 'Erro em {method} {url}: {detail}',
      serverError: 'Erro no servidor: {detail}',
      rawPurged: 'Log bruto: {entries} registro(s) e {sessions} sessão(ões) com mais de 90 dias apagados',
      rawPurgeFailed: 'Falha na limpeza do log bruto: {detail}',
      mergeCheckItemFailed: 'Verificação de merge de {key} falhou: {code}{detail}',
      mergeRecorded: 'PR de {key} mergeado no tracker: gravado (origem painel)',
      mergeCheckFailed: 'Falha na verificação de merge: {detail}',
      markedMerged: 'PR de {key} marcado como mergeado pelo painel',
    },
  },
  // flow company / flow project (bin/flow-admin.js, #6)
  admin: {
    kinds: { company: 'empresa', project: 'projeto' },
    trackers: { github: 'GitHub', azure_devops: 'Azure DevOps' },
    done: {
      companyAdded: 'Empresa "{company}" ({name}) cadastrada.',
      companyLine: (p) => `${p.id.padEnd(20)} ${p.name} · ${p.count} projeto${p.count === 1 ? '' : 's'}`,
      noCompanies: 'Nenhuma empresa cadastrada. Cadastre com: flow company add <id> --name "<nome>".',
      projectAdded: 'Projeto "{project}" cadastrado.',
      projectEdited: 'Projeto "{project}" alterado.',
      projectMoved: 'Projeto "{project}" movido de "{from}" para "{to}".',
      projectLine: (p) => `${p.id.padEnd(20)} ${p.name} · ${p.company} · ${p.tracker} · etapas: ${p.stages}`
        + `${p.doneState ? ` · concluído no tracker: ${p.doneState}` : ''}${p.workspace ? ` · workspace do Maestri: ${p.workspace}` : ''}`,
      repoLine: '    repositório: {remote}',
      noProjects: 'Nenhum projeto cadastrado.',
    },
    errors: {
      missingCompanyId: 'falta o id da empresa (ex.: flow company add contoso --name "Contoso").',
      missingProjectId: 'falta o id do projeto (ex.: flow project add cidax --company contoso --repo <url>).',
      invalidId: 'id de {kind} inválido: "{value}" (use letras minúsculas, números e "-", começando por letra ou número).',
      emptyText: 'o campo --{field} não pode ficar vazio.',
      invalidText: 'o campo --{field} precisa ter até {max} caracteres, numa linha só.',
      invalidTracker: 'tracker inválido: "{value}" (use {allowed}).',
      missingStages: 'informe ao menos uma etapa em --stages (separadas por vírgula).',
      tooManyRepos: 'repositórios demais (máximo {max}).',
      invalidRepo: 'URL de repositório inválida: "{value}" (use a URL do "git remote", HTTPS ou SSH).',
      missingCompanyName: 'falta o nome da empresa (--name "<nome>").',
      companyExists: 'a empresa "{company}" já existe ({name}).',
      unknownCompany: 'a empresa "{company}" não existe (empresas: {known}). Cadastre com: flow company add {company} --name "<nome>".',
      unknownProject: 'o projeto "{project}" não existe (projetos: {known}).',
      projectExists: 'o projeto "{project}" já existe. Para mudá-lo, use: flow project edit {project} ...',
      missingCompany: 'falta a empresa do projeto (--company <id>; o trabalho pessoal é uma empresa como as outras).',
      missingRepo: 'falta o repositório do projeto: use --repo <url do remote> ou rode o comando dentro do repositório.',
      repoTaken: 'o repositório {remote} já é do projeto "{project}". Para juntá-lo a outro, remova-o antes com: flow project edit {project} --remove-repo <url>.',
      repoTracker: 'o repositório {remote} é do {repoTracker}, mas o projeto usa o {tracker}.',
      repoNotInProject: 'o repositório {remote} não é do projeto "{project}".',
      lastRepo: 'o projeto "{project}" precisa de ao menos um repositório.',
      nothingToChange: 'nada para mudar: informe ao menos uma opção (veja flow --help).',
    },
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

PENDÊNCIAS (maestro)
  node bin/flow.js pending open <número> --kind <tipo> --title "..." [--task <task>] [--severity <severidade>]
        [--context "..."] [--option "A: ..."]... [--recommendation "..."] [--workspace "<workspace>"] [--terminal "<terminal>"]
      Abre uma pendência para o dono, ligada ao item e, opcional, a uma task; mostra o id (P-<n>).
      Tipos: ${Object.entries(PENDING_KINDS).map(([id, name]) => `${id} (${name})`).join(', ')}.
      Severidades: ${Object.entries(PENDING_SEVERITIES).map(([id, name]) => `${id} (${name})`).join(', ')}; padrão normal.
      Onde o dono responde: --workspace/--terminal, senão o terminal do Maestri onde o comando roda
      (MAESTRI_WORKSPACE_NAME ou MAESTRI_WORKSPACE_ID, MAESTRI_TERMINAL_NAME ou MAESTRI_TERMINAL_ID).
      A revisão de uma task (task_review, exige --task) se resolve sozinha quando a task é integrada.
  node bin/flow.js pending resolve <id> --decision "..."
      Resolve a pendência com o que o dono decidiu; a decisão fica na linha do tempo do item.
  node bin/flow.js pending cancel <id> [--reason "..."]
      Cancela a pendência.

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

${ADMIN_HELP}
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
  Pendências: id, kind, severity, title, context, options (lista de textos), recommendation, workspace, terminal,
  decision, reason.
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
