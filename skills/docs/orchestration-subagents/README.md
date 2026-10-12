# Orquestração de subagentes por task

Fluxo compartilhado por `/implement-pbi` (Azure DevOps) e `/implement-issue` (GitHub). A skill que apontou para cá fornece o **adaptador do tracker**: como ler o item pai e as tasks, como achar os bloqueios, como abrir e finalizar o PR. Tudo abaixo é agnóstico de tracker.

O objetivo é **um único PR** que implementa o item pai inteiro, numa única **branch integradora**. Você é o **maestro**: lê o grafo, despacha, integra e revisa; quem implementa são os subagentes. Cada passo do fluxo é gravado no painel-maestro pelo CLI `flow` (seção [Painel](#painel)).

## Vocabulário

- **Grafo de tasks**: as tasks não são uma lista de passos, são nós com arestas de bloqueio (`A bloqueia B`).
- **Fronteira**: as tasks abertas cujos bloqueadores já foram integrados. Só a fronteira pode ser despachada.
- **Branch integradora**: a branch do PR, criada a partir da **branch de origem** (a branch em que o usuário estava ao invocar a skill).
- **Ponteiros de contexto**: IDs de itens, caminhos de notas, SHAs de commit. A comunicação com subagentes é esparsa e feita por ponteiros; o subagente lê o item no tracker em vez de receber o texto copiado.
- **Item sem tasks**: um item sem filhas é a própria task; o número da task é o do item.

## Painel

Todo comando do painel roda no Bash (Git Bash no Windows), de dentro do repositório do projeto (o CLI reconhece o projeto pelo `git remote origin`; vale também numa worktree):

```bash
node "$PAINEL_MAESTRO/bin/flow.js" <comando> ...
```

Nos passos abaixo, `flow <comando>` abrevia essa linha. `node "$PAINEL_MAESTRO/bin/flow.js" --help` tem todos os campos.

- **Quem grava.** Você grava grafo, PR, despacho, status das tasks, pendências, integração, achados, ajuste final, PR pronto e conclusão: o papel padrão do `flow` já é maestro, e no `status` passe `--role maestro`. O subagente implementador grava só o próprio relatório (`flow report`, no contrato do passo 4).
- **Texto com acento, aspas ou várias linhas** (títulos, contexto, resumos) vai por JSON: grave um arquivo UTF-8 no scratchpad com o Write tool e redirecione-o, `flow <comando> --json - < "<scratchpad>/arquivo.json"`. Os argumentos valem mais que o JSON, então números e opções curtas podem ficar na linha de comando. Pipe do PowerShell estraga os acentos.
- **Status** roda sempre com `MAESTRI_TERMINAL_ID=` na frente (`MAESTRI_TERMINAL_ID= node "$PAINEL_MAESTRO/bin/flow.js" status ...`): assim ele só grava o evento, mesmo que esta sessão esteja num terminal do Maestri.
- **Pendências** são respondidas nesta sessão ou no painel (tela Pendências): o aviso do `pending open` sobre workspace/terminal do Maestri é só informativo. O painel não avisa esta sessão; quem espera é você: logo depois de **cada** `pending open`, deixe `flow pending wait P-<id>` rodando em segundo plano (Bash com `run_in_background: true`, de dentro do repositório), um por pendência. Ele só lê o painel, não tem prazo e termina, com código 0, quando a pendência fecha por qualquer caminho; o Claude Code te acorda com a saída, que diz como ela fechou, a decisão ou o motivo e quem fechou. Ao terminar, guie-se pela primeira linha, que diz como ela fechou:
  - **resolvida com a decisão do dono** e a linha **"A decisão veio do painel"**: a decisão já está gravada; siga com ela e **não** rode `pending resolve` (ele sairia com código 2, "já está resolvida");
  - **resolvida com a decisão do dono**, sem essa linha: foi você quem gravou a resposta (`pending resolve`, "Fechada por: maestro"); o aviso repete o que você fez; ignore;
  - **cancelada** ou **resolvida pela integração da task** (ou pela HML aprovada, pela substituição, pelo item concluído): siga como hoje (se foi você quem cancelou, o aviso só repete o que fez);
  - código 2 (id errado ou de outro projeto): corrija e rode de novo; código 1 (falha do painel): ninguém está esperando essa pendência, então peça a resposta nesta sessão e cite a mensagem no relatório final.

  Numa sessão nova sobre um item já em andamento, confira as pendências dele no painel (tela Pendências ou página do item): uma respondida pelo painel enquanto ninguém esperava já tem a decisão gravada; para cada uma ainda aberta, deixe o `wait` rodando de novo.
- **Códigos de saída.** `0` ok. `2` é dado inválido: a mensagem diz o que corrigir; corrija e rode de novo (casos esperados estão nos passos). `1` é falha do painel: siga o fluxo, guarde a mensagem e repasse ao usuário no relatório final. O painel nunca para a implementação.

## Passos

0. **Conferir o painel.** `node "$PAINEL_MAESTRO/bin/flow.js" --help >/dev/null && git remote get-url origin`. `PAINEL_MAESTRO` é a pasta do código do painel-maestro (o README dele explica). Se falhar, pergunte ao usuário se ele define a variável agora ou se o fluxo segue sem painel; sem painel, pule as linhas `flow` dos passos. Pronto quando: os dois comandos saíram com 0, ou o usuário decidiu seguir sem painel.

1. **Ler o grafo.** Pelo adaptador, carregue o item pai, as tasks filhas e as arestas de bloqueio. Leia `docs/agents/` do repositório, se existir, para convenções locais (nome de branch, comandos de typecheck/teste, estados do tracker). Task sem aresta declarada é independente; se duas tasks independentes claramente tocam o mesmo fluxo, pergunte ao usuário antes de paralelizar. Pronto quando: cada task tem estado (aberta/fechada) e lista de bloqueadores conhecidos, e o painel tem o item e o grafo:
   - Item: `flow item start --json - < item.json` com `{"number": <n>, "title": "<título do item>", "stage": "implementation"}`. "Já foi iniciado" (código 2) significa que o `/specify` ou uma execução anterior já gravou o item: siga em frente.
   - Grafo (só se o item tem tasks): `flow task graph --json - < grafo.json` com `{"number": <n>, "tasks": [{"number": 12, "title": "..."}, {"number": 13, "title": "...", "blocked_by": [12]}, {"number": 11, "title": "...", "out": true}]}`. Entram todas as tasks do item; as que já estavam fechadas no tracker vão com `"out": true`, e os bloqueios por elas continuam no grafo.
   - Paralelizar: a pergunta ao usuário é uma pendência, `flow pending open <n> --kind parallelize --json - < pendencia.json` com `title`, `context`, `options` (lista, ex.: `"A: em paralelo"`, `"B: 13 depois da 12"`) e `recommendation`. O CLI imprime o id `P-<id>`; deixe o `flow pending wait P-<id>` rodando em segundo plano (seção Painel). Com a resposta nesta sessão, `flow pending resolve P-<id> --json - < decisao.json` com `{"decision": "..."}`; a resposta pelo painel já chega gravada, pelo fim do `wait`. Outras perguntas ao usuário durante o fluxo seguem o mesmo par, com `--kind decision`.

2. **Explorar (opcional).** Se as tasks exigem entender código ou documentação externa, despache um **subagente explorador** que salva notas markdown no scratchpad da sessão (fora do repo). Os implementadores recebem o caminho dessas notas como ponteiro.

3. **Preparar a branch integradora.** A partir da branch de origem, crie a branch integradora (padrão `feature/<tipo>-<id>` salvo convenção local), faça push e abra o PR em **rascunho** pelo adaptador, vinculado ao item pai e a todas as tasks. Deixe a branch integradora em checkout no diretório principal: é dela que as worktrees partem e é nela que os merges acontecem. Pronto quando: o PR existe em rascunho e o painel o registrou com `flow pr <n> draft --url <URL do PR> --branch <integradora>` (a URL de navegador, como o adaptador diz).

4. **Despachar a fronteira.** Para cada task da fronteira, grave o despacho e então chame um **subagente implementador** via Agent tool com `isolation: "worktree"` e `run_in_background: true`. Concorrência máxima: 3 simultâneos, salvo pedido do usuário. O prompt do implementador leva só ponteiros (número do item, número da task, caminho das notas) e o contrato abaixo.

   Despacho: `flow task dispatch <n> <task> --worker subagente --branch task/<task>` (a task passa a "trabalhando" no painel).

   Contrato do implementador:
   - Criar a branch `task/<id>` na worktree, a partir do HEAD atual da branch integradora.
   - Instalar dependências na worktree com o comando do lockfile do repo (`npm ci`, `pnpm i --frozen-lockfile`, ...).
   - Ler a task `<id>` no tracker e as notas do explorador, se houver.
   - Implementar com a skill `mattpocock-skills:tdd` nas seams combinadas; rodar typecheck e os testes dos arquivos tocados.
   - Commitar na `task/<id>` com mensagem referenciando a task.
   - Gravar o relatório no painel antes de responder: escrever com o Write tool um JSON UTF-8 fora do repositório com `status` (`ok` | `blocked`), `blocked_reason`, `tests` (o que rodou e o resultado), `changes` (o que mudou), `decisions` (lista), `risks`, `shared_files` (lista de arquivos compartilhados tocados) e `text` (o relatório inteiro), e rodar, de dentro da worktree, `node "$PAINEL_MAESTRO/bin/flow.js" report --item <n> --task <id> --json - < <arquivo>` (branch e SHA saem da worktree). Código 2: corrigir o JSON e rodar de novo; código 1: seguir e citar a mensagem na resposta. O `report` é o único comando do painel do implementador.
   - Responder apenas: nome da branch, SHA final, status (`ok` | `bloqueado: <motivo>`), riscos de conflito (arquivos compartilhados tocados: rotas, registro de reducers/sagas, menus, configs) e, se houve, a falha do `report`.

5. **Integrar cada conclusão.** Quando um implementador responder:
   - `ok`: grave `flow status "<resumo em uma linha>" --item <n> --task <id> --state done --role maestro` (a task fica pronta para integrar). Anote o SHA atual da branch integradora (`git rev-parse HEAD`) e despache um **subagente de merge** (foreground, um por vez; merges nunca rodam em paralelo) que faz `git merge --no-ff task/<id>` na branch integradora, resolve conflitos com a skill `mattpocock-skills:resolving-merge-conflicts`, roda typecheck, faz push e responde o SHA do merge. Grave `flow task integrate <n> <id> --sha <SHA do merge> --sha-before <SHA anotado>` e marque a task como concluída pelo adaptador.
   - `bloqueado`: grave `flow status "<motivo>" --item <n> --task <id> --state blocked --role maestro`, abra `flow pending open <n> --kind worker_blocked --task <id> --json - < pendencia.json` (com `title`, `context`, `options`, `recommendation`), deixe o `wait` dela rodando e leve o motivo ao usuário. Com a decisão nesta sessão, `flow pending resolve P-<id> ...` (a do painel já chega gravada); se a pendência deixar de valer, `flow pending cancel P-<id> --reason "..."`. Um novo despacho da task volta ao passo 4.

6. **Recalcular a fronteira.** Após cada integração, tasks recém-desbloqueadas entram na fronteira: despache-as (passo 4). Repita 4–6 até todas as tasks estarem integradas. Pronto quando: toda task do grafo está integrada (no painel também) ou foi reportada como bloqueada ao usuário.

7. **Revisar.** Rode a suíte completa de testes. Depois, na branch integradora contra a branch de origem, rode as duas revisões em sequência:
   1. Skill `mattpocock-skills:code-review`: Standards + Spec, confere o diff contra os padrões do repo e contra cada task.
   2. Skill `code-review` (nativa do Claude Code) no nível `medium`: bugs de corretude, reuso e simplificação. Pegadinhas típicas deste fluxo: helpers duplicados entre tasks e conflitos resolvidos para o lado errado no merge.

   Consolide os achados numa única lista. **Desempate**: quando um achado de simplificação contradiz um padrão do repo ou a spec, vence o padrão/spec. Grave cada achado da lista com `flow finding add <n> --json - < achado.json` (`title`, `description`, `classification`, e `task` quando o achado nasce de uma task):
   - `defect`: corrige-se agora, no ajuste final.
   - `owner_decision`: depende do usuário; abra `flow pending open <n> --kind finding` e pergunte. Se ele decidir que vira uma task para depois, crie-a pelo adaptador e ligue com `flow finding link <n> <achado> --new-task <número> --new-task-title "..."` (ela aparece no item como "fora", para triagem).
   - `discarded`: o que o desempate ou a análise descartou.

   Abra o ajuste final com `flow final-adjustment <n> open` e despache **um único** implementador (sem worktree, na branch integradora) com a lista de `defect` (e o que o usuário mandou corrigir agora) para corrigir tudo, rode typecheck e testes, e faça push. Se `docs/agents/` do projeto pede subir a versão no ajuste final, o briefing do implementador inclui a subida. Grave o resultado com `flow final-adjustment <n> result --outcome passed|failed --json - < ajuste.json` (`{"summary": "..."}`; `passed` quando os testes ficaram verdes). Pronto quando: os testes passaram depois das correções e o resultado está gravado.

8. **Finalizar.** Tire o PR do rascunho pelo adaptador e grave `flow pr <n> ready`.

9. **Limpar.** Remova todas as worktrees e branches `task/*` locais criadas nesta execução (`git worktree list` para conferir; `git worktree prune`). Reporte ao usuário: link do PR, tasks integradas, tasks bloqueadas, a página do item no painel (`http://127.0.0.1:4777/#items/<chave>`, com a chave que o `flow` imprime, ex.: `painel-maestro/10`; se ele disse que cadastrou o projeto em "Sem organização", diga que o projeto se move pelo painel) e cada comando `flow` que falhou, com a mensagem.

## Depois do PR pronto

O merge costuma acontecer na interface do tracker, e o painel o detecta sozinho. Quando estes momentos acontecem nesta sessão (ou numa retomada a pedido do usuário), grave:

- **Merge feito por você**, a pedido do usuário: `flow pr <n> merged`.
- **Validação HML**, quando o usuário valida com a skill `especificacao-atdd-hml` (ela não grava no painel): `flow hml <n> --passed <n> --failed <n> --blocked <n> --card <URL do card> --json - < hml.json` (`{"summary": "..."}`); se quem validou foi o usuário, `--role owner`.
- **Conclusão**, quando o item terminou o fluxo do projeto (mergeado e, se o projeto usa, validado em HML): `flow item done <n>`.

Uma etapa que o projeto não usa sai com código 2: pule o comando.
