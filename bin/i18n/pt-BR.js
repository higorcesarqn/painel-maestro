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
// How a resolved pending decision closed (its resolution) and who closed it, as "flow pending wait" says it.
const PENDING_RESOLUTIONS = {
  decision: 'resolvida com a decisão do dono',
  task_integrated: 'resolvida pela integração da task',
  hml_approved: 'resolvida porque uma Validação HML seguinte passou em tudo',
  replaced: 'resolvida porque o maestro abriu outra pendência de HML no lugar dela',
  item_done: 'resolvida porque o item foi concluído',
};
const PENDING_ROLES = { maestro: 'maestro', worker: 'trabalhador', owner: 'dono' };

const PENDING = {
  kinds: PENDING_KINDS,
  severities: PENDING_SEVERITIES,
  done: {
    opened: (p) => `Pendência P-${p.id} (${PENDING_KINDS[p.kind] || p.kind}) aberta no item ${p.key} (${p.ref})${p.task ? `, task ${p.task}` : ''}.`
      + (p.workspace || p.terminal ? ` Responder em: ${[p.workspace && `workspace "${p.workspace}"`, p.terminal && `terminal "${p.terminal}"`].filter(Boolean).join(', ')}.` : ' Sem workspace/terminal do Maestri: informe --workspace e --terminal para o dono saber onde responder.'),
    resolved: 'Pendência P-{id} do item {key} resolvida; a decisão ficou na linha do tempo do item.',
    canceled: 'Pendência P-{id} do item {key} cancelada.',
  },
  // The owner's notification of pending open inside a Maestri terminal (#44): "maestri notify", up to 500 characters.
  notify: {
    message: (p) => `Pendência nova (${PENDING_SEVERITIES[p.severity] || p.severity}): ${PENDING_KINDS[p.kind] || p.kind} no item ${p.key} (${p.ref})`
      + `${p.task ? `, task ${p.task}` : ''}. ${p.title}`,
    failed: 'aviso: a pendência P-{id} foi gravada, mas o maestri notify falhou: {detail}; o dono pode não ter sido avisado.',
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
    noDatabase: 'a pendência P-{id} não existe: ainda não há banco do painel em {file} (confira MAESTRO_DIR).',
    noProject: 'a pendência P-{id} não existe: o repositório {remote} não tem projeto no painel. Rode o comando no repositório do projeto da pendência.',
  },
  // flow pending wait (#33): what the maestro reads when the pending decision closes.
  wait: {
    waiting: 'Esperando a pendência P-{id} do item {key} ({ref}); o comando termina quando ela fechar.',
    closed: (p) => `Pendência P-${p.id} do item ${p.key} (${p.ref})${p.task ? `, task ${p.task}` : ''}, fechou: `
      + `${p.status === 'canceled' ? 'cancelada' : PENDING_RESOLUTIONS[p.resolution] || 'resolvida'}.`,
    title: 'Título: {title}',
    decision: 'Decisão: {decision}',
    reason: 'Motivo: {reason}',
    noReason: 'Motivo: não informado.',
    closedBy: (p) => `Fechada por: ${PENDING_ROLES[p.role] || 'papel não registrado'}${p.name ? ` (${p.name})` : ''}`
      + `${p.panel ? ', pelo painel' : ''}${p.at ? `, em ${p.at}` : ''}.`,
    fromPanel: 'A decisão veio do painel e já está gravada: siga com ela; não rode flow pending resolve.',
  },
};

// Help of "flow org" and "flow project" (#6), a section of the flow help.
const ADMIN_HELP = `ORGANIZAÇÕES E PROJETOS (dono; não precisam rodar dentro de um repositório)
  node bin/flow.js org list
  node bin/flow.js org add <id> --name "<nome>"
      Cadastra uma organização. O trabalho pessoal é uma organização como as outras (ex.: personal, "Pessoal").
      O nome tem até 80 caracteres e não repete o de outra organização nem o de "Sem organização", mesmo com outras
      maiúsculas (Configurações → Organizações, no painel, cria com a mesma regra). O id não muda depois.
  node bin/flow.js org rename <id> --name "<nome>"
      Renomeia uma organização; o id continua o mesmo (Configurações → Organizações, no painel, também renomeia).
      O nome novo segue a regra do cadastro, e o próprio nome com outras maiúsculas é aceito. "Sem organização"
      (unassigned) não se renomeia.
  node bin/flow.js org remove <id>
      Exclui uma organização sem projetos (Configurações → Organizações, no painel, também exclui). Com projetos,
      mova-os antes (flow project move); "Sem organização" (unassigned) não se exclui.
  node bin/flow.js org hide <id>
  node bin/flow.js org unhide <id>
      Oculta uma organização (ela sai das listagens do painel, o trabalho dela segue normal) e a mostra de novo.
      Repetir não é erro. "Sem organização" (unassigned) também pode ser oculta. O org list marca as ocultas.
  node bin/flow.js project list [--org <id>]
  node bin/flow.js project add <id> --org <id> [--name "<nome>"] [--tracker github|azure_devops]
        [--repo <url do remote>]... [--stages <etapa,...>] [--done-state "<estado>"] [--workspace "<workspace>"]
      Cadastra um projeto ("Sem organização", unassigned, não vale como --org). Repita --repo para cada repositório (um projeto do Azure DevOps costuma ter vários);
      sem --repo, vale o remote da pasta atual. O tracker vem do remote quando não é informado. --stages: as
      etapas que o projeto usa (padrão: todas); --done-state: o estado do tracker que significa concluído (ex.:
      Committed); --workspace: o workspace do Maestri do projeto.
  node bin/flow.js project edit <id> [--name] [--org] [--tracker] [--repo <url>]... [--remove-repo <url>]...
        [--stages] [--done-state] [--workspace]
      Muda o cadastro (um --done-state ou --workspace vazio apaga o valor). O id não muda.
  node bin/flow.js project move <id> <organização>
      Move o projeto para outra organização (o painel também faz isso, em Configurações → Organizações e no card
      "Sem organização" da tela Itens). "Sem organização" (unassigned) não é destino: ela só recebe os repositórios
      sem cadastro.
  JSON (--json -): id, name, organization, tracker, repos, remove_repos, stages, done_state, maestri_workspace.
`;

const FINDING_CLASSES = { defect: 'defeito claro', owner_decision: 'depende do dono', discarded: 'descartado' };

module.exports = {
  stages: STAGES,
  workerStates: WORKER_STATES,
  pending: PENDING,
  organizations: {
    unassigned: 'Sem organização',
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
      schema_too_new: 'O {file} foi atualizado por uma versão mais nova do painel-maestro (schema v{db_version}; este código lê até a v{code_version}): atualize o código. As sessões de task sem item conhecido ficaram sem item.',
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
      projectMoved: 'Projeto {project} movido pelo painel para a organização {organization}',
      organizationCreated: 'Organização {organization} ({name}) criada pelo painel',
      organizationRenamed: 'Organização {organization} renomeada pelo painel de {from} para {name}',
      organizationRemoved: 'Organização {organization} ({name}) excluída pelo painel',
      organizationHidden: 'Organização {organization} ({name}) oculta pelo painel',
      organizationShown: 'Organização {organization} ({name}) mostrada pelo painel',
      requestFailed: 'Erro em {method} {url}: {detail}',
      serverError: 'Erro no servidor: {detail}',
      rawPurged: 'Log bruto: {entries} registro(s) e {sessions} sessão(ões) com mais de 90 dias apagados',
      rawPurgeFailed: 'Falha na limpeza do log bruto: {detail}',
      mergeCheckItemFailed: 'Verificação de merge de {key} falhou: {code}{detail}',
      mergeRecorded: 'PR de {key} mergeado no tracker: gravado (origem painel)',
      mergeCheckFailed: 'Falha na verificação de merge: {detail}',
      markedMerged: 'PR de {key} marcado como mergeado pelo painel',
      pendingAnswered: 'Pendência P-{id} de {key} respondida pelo painel',
    },
  },
  // flow org / flow project (bin/flow-admin.js, #6)
  admin: {
    kinds: { organization: 'organização', project: 'projeto' },
    trackers: { github: 'GitHub', azure_devops: 'Azure DevOps' },
    done: {
      organizationAdded: 'Organização "{organization}" ({name}) cadastrada.',
      organizationRenamed: 'Organização "{organization}" renomeada de "{from}" para "{name}".',
      organizationRemoved: 'Organização "{organization}" ({name}) excluída.',
      // #49: org hide / org unhide; repeating is not an error.
      organizationHidden: 'Organização "{organization}" ({name}) oculta: ela sai das listagens do painel e o trabalho dela segue normal.',
      organizationAlreadyHidden: 'Organização "{organization}" ({name}) já estava oculta.',
      organizationShown: 'Organização "{organization}" ({name}) mostrada de novo nas listagens do painel.',
      organizationAlreadyShown: 'Organização "{organization}" ({name}) já estava visível.',
      organizationLine: (p) => `${p.id.padEnd(20)} ${p.name} · ${p.count} projeto${p.count === 1 ? '' : 's'}${p.hidden ? ' · oculta' : ''}`,
      noOrganizations: 'Nenhuma organização cadastrada. Cadastre com: flow org add <id> --name "<nome>".',
      projectAdded: 'Projeto "{project}" cadastrado.',
      projectEdited: 'Projeto "{project}" alterado.',
      projectMoved: 'Projeto "{project}" movido de "{from}" para "{to}".',
      projectLine: (p) => `${p.id.padEnd(20)} ${p.name} · ${p.organization} · ${p.tracker} · etapas: ${p.stages}`
        + `${p.doneState ? ` · concluído no tracker: ${p.doneState}` : ''}${p.workspace ? ` · workspace do Maestri: ${p.workspace}` : ''}`,
      repoLine: '    repositório: {remote}',
      noProjects: 'Nenhum projeto cadastrado.',
    },
    errors: {
      missingOrganizationId: 'falta o id da organização (ex.: flow org add contoso --name "Contoso").',
      missingProjectId: 'falta o id do projeto (ex.: flow project add cidax --org contoso --repo <url>).',
      invalidId: 'id de {kind} inválido: "{value}" (use letras minúsculas, números e "-", começando por letra ou número).',
      emptyText: 'o campo --{field} não pode ficar vazio.',
      invalidText: 'o campo --{field} precisa ter até {max} caracteres, numa linha só.',
      invalidTracker: 'tracker inválido: "{value}" (use {allowed}).',
      missingStages: 'informe ao menos uma etapa em --stages (separadas por vírgula).',
      tooManyRepos: 'repositórios demais (máximo {max}).',
      invalidRepo: 'URL de repositório inválida: "{value}" (use a URL do "git remote", HTTPS ou SSH).',
      missingOrganizationName: 'falta o nome da organização (--name "<nome>").',
      unknownOrganization: 'a organização "{organization}" não existe (organizações: {known}). Cadastre com: flow org add {organization} --name "<nome>".',
      organizationNotFound: 'a organização "{organization}" não existe (organizações: {known}).',
      unknownProject: 'o projeto "{project}" não existe (projetos: {known}).',
      projectExists: 'o projeto "{project}" já existe. Para mudá-lo, use: flow project edit {project} ...',
      missingOrganization: 'falta a organização do projeto (--org <id>; o trabalho pessoal é uma organização como as outras).',
      missingRepo: 'falta o repositório do projeto: use --repo <url do remote> ou rode o comando dentro do repositório.',
      repoTaken: 'o repositório {remote} já é do projeto "{project}". Para juntá-lo a outro, remova-o antes com: flow project edit {project} --remove-repo <url>.',
      repoTracker: 'o repositório {remote} é do {repoTracker}, mas o projeto usa o {tracker}.',
      repoNotInProject: 'o repositório {remote} não é do projeto "{project}".',
      lastRepo: 'o projeto "{project}" precisa de ao menos um repositório.',
      nothingToChange: 'nada para mudar: informe ao menos uma opção (veja flow --help).',
    },
    // Codes of the rules of the register (RegisterError, bin/flow-store.js); organization_not_found and project_not_found
    // reuse unknownOrganization (organizationNotFound in an org subcommand: rename, remove, hide, unhide) and unknownProject above.
    codes: {
      // Moving a project to, adding a project to, removing (#24) or renaming (#23) "Sem organização".
      organization_reserved: '"Sem organização" é reservada: ela só recebe os repositórios sem cadastro, então não é destino de mover nem organização de um projeto cadastrado, não se renomeia e não se exclui (organizações cadastradas: flow org list).',
      // #24: removing an organization that still has projects.
      organization_not_empty: (p) => `a organização "${p.organization}" (${p.name}) tem ${p.project_count} projeto${p.project_count === 1 ? ': mova-o' : 's: mova-os'} antes para outra organização (flow project list --org ${p.organization} e flow project move <projeto> <organização>).`,
      // #22 and #23: creating or renaming an organization under the name rule of the store.
      organization_exists: (p) => `a organização "${p.organization}" já existe (${p.name || 'reservada para "Sem organização"'}).`,
      organization_name_taken: 'o nome "{name}" já é da organização "{organization}" ({organization_name}): escolha outro nome (sem diferenciar maiúsculas).',
      invalid_field: (p) => (p.field === 'name'
        ? `o nome da organização precisa ter de 1 a ${p.max} caracteres, numa linha só (os espaços das pontas não contam).`
        : `id de organização inválido: "${p.value}" (use letras minúsculas, números e "-", começando por letra ou número, até 80 caracteres).`),
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
    projectRegistered: 'Projeto "{project}" cadastrado em "{organization}" a partir de {remote}. Mova-o para a organização certa pelo painel.',
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
    jsonFieldType: (p) => `o campo "${p.field}" do JSON precisa ser ${{ text: 'texto', number: 'número', list: 'uma lista', text_list: 'uma lista de textos' }[p.expected] || p.expected}.`,
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
    schemaTooNew: 'o banco {file} foi atualizado por uma versão mais nova do painel-maestro (schema v{db_version}; este código lê até a v{code_version}): atualize o código (git pull no painel-maestro). Nada foi gravado.',
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
  // flow --version (#36): the semver of the root package.json and the commit of the code (none outside a clone).
  version: (p) => `painel-maestro${p.product ? ` ${p.product}` : ''}${p.commit ? ` (${p.commit})` : ''}`,
  help: (p) => `flow · registra o fluxo dos itens no painel (eventos em ${p.db})

O projeto é reconhecido pelo "git remote origin" da pasta atual (vale dentro do worktree de um floor).
Um repositório sem cadastro entra na organização "Sem organização" e o comando segue.

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
      Dentro do Maestri (com MAESTRI_TERMINAL_ID), avisa o dono com "maestri notify" (a pendência, a severidade,
      o item e o título); se o aviso falhar, a pendência é gravada mesmo assim, o comando sai com 0 e uma linha no
      stderr diz que o dono pode não ter sido avisado. Fora do Maestri, nada é chamado.
  node bin/flow.js pending resolve <id> --decision "..."
      Resolve a pendência com o que o dono decidiu; a decisão fica na linha do tempo do item.
  node bin/flow.js pending cancel <id> [--reason "..."]
      Cancela a pendência.
  node bin/flow.js pending wait <id>
      Espera a pendência fechar, por qualquer caminho (resposta pelo painel, pending resolve, cancelamento,
      integração da task, HML aprovada, substituição, item concluído), e sai com 0 mostrando como ela fechou, a
      decisão ou o motivo e quem fechou. Só lê o maestro.db, a cada poucos segundos, sem prazo e sem depender do
      servidor do painel; se ela já estava fechada, termina na hora. O maestro o deixa rodando em segundo plano
      depois de cada pending open. Decisão que veio do painel já está gravada: não rode pending resolve.

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
VERSÃO
  node bin/flow.js --version  (ou -v)
      Mostra a versão do painel-maestro: painel-maestro <semver> (<commit>). O semver é o do package.json da
      raiz; o commit é o do código, e some quando ele roda de uma pasta sem git (ou sem git no PATH).
      É a mesma versão do rodapé do painel. Não precisa rodar dentro de um repositório.

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
  FLOW_WAIT_INTERVAL_MS intervalo entre as leituras do pending wait, em ms (padrão: 3000)
`,
};
