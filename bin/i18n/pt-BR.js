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

module.exports = {
  stages: STAGES,
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
  help: (p) => `flow · registra o fluxo dos itens no painel (eventos em ${p.db})

O projeto é reconhecido pelo "git remote origin" da pasta atual (vale dentro do worktree de um floor).
Um repositório sem cadastro entra na empresa "Sem empresa" e o comando segue.

USO
  node bin/flow.js item start <número> --title "..." [--stage <etapa>] [opções do agente]
      Inicia o item (Issue do GitHub ou PBI do Azure DevOps) na etapa dada (padrão: a primeira do projeto,
      em geral specification). As etapas anteriores contam como concluídas.
  node bin/flow.js stage <número> <etapa> [opções do agente]
      Muda a etapa do item.

OPÇÕES DO AGENTE
  --role maestro|worker|owner     quem grava (padrão: maestro)
  --agent "<nome>"                codinome do agente (opcional)

JSON PELA ENTRADA PADRÃO (texto com acentos, aspas e várias linhas chega intacto em qualquer shell)
  --json -     os campos vêm num objeto JSON pela entrada padrão; os argumentos valem mais que o JSON
  Campos: number, title, stage, role, agent.
  ex.: node bin/flow.js item start --json - < item.json

ETAPAS
${Object.entries(STAGES).map(([id, name]) => `  ${id.padEnd(17)} ${name}`).join('\n')}

CÓDIGOS DE SAÍDA
  0 ok · 2 dados inválidos (a mensagem diz o que corrigir) · 1 outros erros

VARIÁVEIS
  MAESTRO_DIR   pasta dos dados (padrão: ~/.painel-maestro)
`,
};
