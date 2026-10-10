# painel-maestro

Painel web local do **fluxo dos itens** que eu implemento com agentes Claude Code: Issues do GitHub e PBIs do Azure DevOps, organizados por **empresa** e **projeto**. As skills de implementação (com floors do Maestri ou com subagentes) gravam cada passo do fluxo por um CLI deste repositório (`flow`) num banco SQLite fora do repositório; um servidor Node.js sem dependências calcula o estado de cada item a partir desses eventos e mostra tudo numa página só, em `http://127.0.0.1:4777`.

O painel não usa IA nem gasta tokens: ele só lê o que os agentes gravaram. Nesta fase ele só **mostra** as pendências: o dono responde no terminal do maestro.

O vocabulário (Empresa, Projeto, Item, Task, Achado, Pendência, Fluxo, Etapa, Maestro, Trabalhador) está em [`CONTEXT.md`](CONTEXT.md); as decisões de arquitetura, em [`docs/adr/`](docs/adr/).

## Como funciona

- **Empresas e projetos.** Cada **projeto** é um projeto do tracker (um repositório do GitHub ou um projeto do Azure DevOps, que pode ter vários repositórios) e pertence a uma **empresa**; o trabalho pessoal é a empresa "Pessoal", uma empresa como as outras. Cada projeto declara o tracker, as **etapas** que usa (por exemplo, sem Validação HML), o estado do tracker que significa "concluído" (no CIDAX é `Committed`) e o workspace do Maestri. O projeto é reconhecido sozinho pelo `git remote origin` da pasta onde o comando roda (também dentro do worktree de um floor); um repositório sem cadastro entra sozinho em **"Sem empresa"** e o dono o move para a empresa certa pelo painel ("Sem empresa" nunca é destino de mover).
- **Item.** Uma Issue pai do GitHub ou um PBI do Azure DevOps, identificado por projeto e número (`cidax/3100`) e mostrado como no tracker (`PBI 3100`, `#12`). O item percorre as **etapas** do fluxo: Especificação → Implementação → Ajuste final → PR pronto → Merge → Validação HML → Concluído (só as que o projeto usa).
- **Tasks.** As filhas do item (sub-issues ou cards filhos), com os bloqueios entre elas, formam um **grafo**. Cada task tem um estado: aguardando, trabalhando, revisão, bloqueada, integrada ou fora. O maestro despacha cada task para um **trabalhador** (um floor do Maestri, com codinome, ou um subagente) numa branch `task/<id>-…` e a integra na branch integradora do item. Uma issue sem filhas é um item com uma task, ele mesmo.
- **Relatórios.** O trabalhador grava o relatório completo (status, testes, o que mudou, decisões, riscos, arquivos compartilhados, o texto inteiro) **antes** de enviá-lo ao maestro, para ele não se perder no terminal.
- **Achados.** O que o maestro encontra nas revisões, classificado como defeito claro, decisão do dono ou descartado; um achado pode virar uma **task nova para triagem**, que aparece no item com o estado "fora".
- **Pendências.** O que espera uma decisão do dono (revisar e integrar uma task, trabalhador bloqueado, decisão, achado que depende do dono, paralelizar tasks, cenário de HML reprovado), com contexto, opções, recomendação e **onde responder** (workspace e terminal do maestro no Maestri). A revisão de uma task e o OK para integrá-la são a mesma pendência, que se resolve sozinha quando a task é integrada.
- **PR, HML e conclusão.** O maestro registra o PR em rascunho, o ajuste final, o PR pronto e, quando ele mesmo faz o merge, o merge; o resultado da Validação HML e a conclusão também viram eventos. O merge feito pela interface do tracker, sem agente presente, é descoberto pelo próprio painel (o **verificador de merge**), com um botão "Marcar como mergeado" para quando a consulta falha.
- **Log bruto e uso.** Um hook do Claude Code grava os prompts e comandos de cada sessão dos projetos cadastrados, ligada ao item e à task pela branch; um coletor soma o consumo de tokens por item e por agente e lê o uso do plano Claude (janela de 5 h e semanal) que o Maestri grava.

Tudo que acontece num item é um **evento** guardado para sempre (ADR 0002); o estado do item, das tasks e das pendências é sempre calculado desses eventos, nunca gravado.

## Telas

No topo, o **seletor de empresa** (Todas ou uma empresa, lembrado neste navegador) filtra todas as telas. O cabeçalho tem o **selo de saúde** (verde, amarelo ou vermelho, com os motivos: hook parado, banco ilegível, projetos em "Sem empresa", falha do verificador de merge) e o botão **Recalcular** (roda o coletor de uso na hora).

- **Visão geral:** o retrato do dia: itens ativos por empresa, projeto e etapa, pendências abertas por severidade, itens parados há muito tempo na mesma etapa (`PANEL_STALE_HOURS`, padrão 48 h), eventos de hoje, atividade recente e o uso do plano.
- **Itens:** a lista (ativos, concluídos ou todos; filtros de projeto, etapa e tracker, além do seletor de empresa do topo), os projetos em "Sem empresa" em destaque para mover, e a **página do item**, com endereço fixo `http://127.0.0.1:4777/#items/<projeto>/<número>` (é o que o portal do Maestri abre): etapa atual e desde quando, a Entrega (PR, ajuste final, Validação HML, conclusão, o estado do verificador de merge), o grafo de tasks com bloqueios e quem está em cada task (floor, trabalhador, branch, SHA, último status), os relatórios, os achados, as etapas do fluxo e a linha do tempo com todos os eventos e quem gravou cada um.
- **Pendências:** as pendências abertas, resolvidas e canceladas, com filtros por severidade e status, cada uma com o item, a task, contexto, opções, recomendação, onde responder e, depois de fechada, a decisão.
- **Log:** os eventos de todos os itens, com filtros por período, projeto, item e tipo; abrir um evento mostra o que foi gravado e os comandos brutos das sessões do Claude Code ligadas a ele.
- **Agentes:** os maestros e trabalhadores ativos, sem cadastro fixo: o maestro de cada item ainda não concluído e o trabalhador de cada task em andamento, com o último evento, a última atividade vista pelo hook e o consumo da janela de 5 h.
- **Uso:** o plano Claude (5 h e semanal, com o reinício), o consumo de cada item em cada período e os tokens de cada agente.
- **Empresas:** o cadastro inteiro, qualquer que seja o seletor do topo: um card por empresa (nome, id, projetos e itens), em ordem alfabética, com "Sem empresa" por último e só quando tem projetos; o botão **Nova empresa** cria uma (nome até 80 caracteres, único sem diferenciar maiúsculas, e o id sugerido a partir do nome, editável antes de salvar e fixo depois); **Excluir**, no card, exclui uma empresa sem projetos depois de confirmar num modal com o nome dela (com projetos o botão fica desabilitado com "mova os N projetos antes"; "Sem empresa" não tem o botão; se ela era a do seletor do topo, ele volta para Todas); dentro de cada card, os projetos (nome, tracker, repositórios, itens) com **Mover para** outra empresa, a mesma linha do card "Sem empresa" da tela Itens.

A página se atualiza sozinha a cada 20 segundos.

## Instalar do zero

### Requisitos

- **Node.js 22.13 ou mais novo** (o painel usa o SQLite embutido do Node, `node:sqlite`, sem nenhuma dependência npm; desenvolvido e testado no Node 22.23). Compilar a página (só se mudar a fonte dela) pede Node 20.19+ ou 22.12+.
- **git** no `PATH` (o projeto é reconhecido pelo `git remote origin`).
- Para o verificador de merge: o **`gh`** autenticado (GitHub) e/ou o **`az`** com `az login` (Azure DevOps). Sem eles o painel funciona; só a consulta automática do merge falha, com o motivo, e o botão "Marcar como mergeado" resolve.
- Para o uso do plano: o app **Maestri**, com o uso dos agentes ligado (Configurações → Agentes → Uso). Fora dele, o plano aparece como indisponível, com o motivo.
- Desenvolvido e testado no Windows (os scripts das skills rodam no Git Bash, que vem com o Git for Windows).

### 1. Clonar

```
git clone <url-do-repositorio> D:\pessoal\git\painel-maestro
cd D:\pessoal\git\painel-maestro
```

A página compilada (`panel/index.html`) já vem no repositório: não é preciso `npm install` para usar o painel. O código fica no repositório; **os dados ficam fora dele**, em `~/.painel-maestro` (`C:\Users\<você>\.painel-maestro`), ou na pasta de `MAESTRO_DIR`, se você a definir.

### 2. Definir `PAINEL_MAESTRO`

As skills chamam o CLI pelo caminho absoluto, `node "$PAINEL_MAESTRO/bin/flow.js" ...`. Defina a variável de usuário com a pasta **do código** (este repositório) e reabra o terminal e o Claude Code:

```
setx PAINEL_MAESTRO "D:\pessoal\git\painel-maestro"
```

No Git Bash do Claude Code ela aparece como `$PAINEL_MAESTRO`; caminhos com `\` funcionam no `node`. Confira com `node "$PAINEL_MAESTRO/bin/flow.js" --help`.

### 3. Instalar as skills

As skills que gravam o fluxo no painel vivem em `skills/` e são ligadas à pasta do Claude (`~/.claude`), para terem versão e diff aqui e serem usadas de lá:

```
node bin/install-skills.js           # liga as skills; rodar de novo é seguro
node bin/install-skills.js --undo    # desfaz: remove os links e devolve o que havia antes
node bin/install-skills.js --help
```

- **O que é ligado:** só o que `skills/links.json` declara (origem relativa a este repositório, destino relativo à pasta do Claude): as skills `especificar`, `implementar-issue`, `implementar-pbi`, `implementar-issue-maestri`, `implementar-pbi-maestri` e `trabalhador-floor` em `~/.claude/skills/<nome>`, e os documentos de orquestração `skills/docs/orquestracao-subagentes` → `~/.claude/docs/orquestracao-subagentes` e `skills/docs/orquestracao-maestri` → `~/.claude/docs/orquestracao-maestri` (com os scripts `open-floor.sh` e `integrate.sh`).
- **Como:** cada destino vira uma *junction* de diretório no Windows (não exige administrador; funciona com o repositório e o `~/.claude` em discos diferentes) e um symlink de diretório nos outros sistemas. Editar a skill no repositório já vale no Claude Code.
- **Backups:** o que já existir no destino e não for um link deste repositório (por exemplo, uma versão antiga de `implementar-issue-maestri`) vai para `~/.claude/backups/painel-maestro/<destino>` (fora de `skills/`, para o Claude Code não carregar duas skills com o mesmo nome). O `--undo` remove só os links deste repositório (nunca o conteúdo deles) e devolve os backups.
- **Conflitos:** a instalação planeja tudo antes de mexer em qualquer coisa. Se um backup já ocupar o lugar, ou se no `--undo` o destino não for mais um link deste repositório e houver backup, o comando sai com **código 2** e nada é alterado; a mensagem diz o que mover.
- **Pasta do Claude:** `--claude-dir <pasta>`, senão `CLAUDE_CONFIG_DIR`, senão `~/.claude`.

As skills:

- **`/especificar`**: roda `grill-with-docs` → `to-spec` → `to-tickets`; grava o item em **Especificação** assim que o `to-spec` publica a issue ou o PBI, e em **Implementação** quando o `to-tickets` termina.
- **`/implementar-issue`** e **`/implementar-pbi`**: o maestro (a sessão que roda a skill) implementa o item num PR só, com um **subagente** em worktree por task, sem Maestri; o fluxo comum está em `~/.claude/docs/orquestracao-subagentes/README.md`.
- **`/implementar-issue-maestri`** e **`/implementar-pbi-maestri`**: o maestro, no Ground de um workspace do Maestri, implementa o item num PR só, com um **floor** e um terminal Claude Code por task; o fluxo comum está em `~/.claude/docs/orquestracao-maestri/README.md`. O portal do canvas abre a página do item no painel.
- **`trabalhador-floor`**: o protocolo do trabalhador num floor: status pelo `flow status` (que também roda o `maestri floor status`) e relatório gravado com `flow report` antes de ir ao maestro.

Todas funcionam com GitHub e Azure DevOps (o tracker vem do `docs/agents/issue-tracker.md` do repositório onde elas rodam). A `especificacao-atdd-hml` continua sincronizada do claude.ai, sem mudança: as skills lembram de registrar o resultado da HML com `flow hml`.

### 4. Instalar o hook do Claude Code

O `bin/hook-log.js` grava o log bruto (prompts, comandos, ferramentas) de cada sessão no `bruto.db`. Instale-o no `settings.json` do usuário (`~/.claude/settings.json`), para valer em qualquer pasta (troque o caminho):

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node \"D:/pessoal/git/painel-maestro/bin/hook-log.js\"" }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node \"D:/pessoal/git/painel-maestro/bin/hook-log.js\"" }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"D:/pessoal/git/painel-maestro/bin/hook-log.js\"" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"D:/pessoal/git/painel-maestro/bin/hook-log.js\"" }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "node \"D:/pessoal/git/painel-maestro/bin/hook-log.js\"" }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "node \"D:/pessoal/git/painel-maestro/bin/hook-log.js\"" }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node \"D:/pessoal/git/painel-maestro/bin/hook-log.js\"" }] }]
  }
}
```

- **Só projetos cadastrados:** o hook grava só as sessões cuja pasta pertence a um projeto do `maestro.db` (pelo `git remote origin`, inclusive no worktree de um floor; um repositório entra no cadastro na primeira vez que o `flow` roda nele). As outras sessões da máquina saem em poucos milissegundos, sem gravar nada.
- **Ligação pela branch:** `task/<id>-…` (ou `task/<id>`) é a task `<id>`; `feature/pbi-<id>` ou `feature/issue-<n>` é o maestro do item; `task/<item>-ajuste-final` (o floor do ajuste final) não é task: conta como o maestro do item; outra branch liga só ao projeto ("sem item" no uso). A convenção vive num lugar só (`parseBranch` em `bin/flow-repo.js`), usado pelo hook e pelo `flow status`/`flow report`; o `integrate.sh` segue a mesma regra.
- **Garantias:** nunca escreve no stdout nem no stderr, sai sempre com 0, desiste de tudo em cerca de 1,5 s (nunca atrasa nem quebra a sessão), trunca entradas (600 caracteres) e saídas (300) e redige segredos (`«redigido»`).
- **Retenção:** o servidor apaga do `bruto.db` o que tem mais de 90 dias, ao subir e uma vez por dia.
- O hook entende esses sete eventos; se a sua versão do Claude Code não tiver algum deles, deixe-o de fora. O hook e o servidor precisam ver o mesmo `MAESTRO_DIR` (ou nenhum).

### 5. Cadastrar empresas e projetos

Opcional (um repositório sem cadastro entra sozinho em "Sem empresa"), mas é o que deixa o painel organizado. Estes comandos não precisam rodar dentro de um repositório:

```
node bin/flow.js company add contoso --name "Contoso"
node bin/flow.js company add personal --name "Pessoal"
node bin/flow.js project add cidax --name "CIDAX" --company contoso --tracker azure_devops \
  --repo https://dev.azure.com/contoso/CIDAX/_git/cidax-api --repo https://dev.azure.com/contoso/CIDAX/_git/cidax-web \
  --stages specification,implementation,final_adjustment,pr_ready,merge,hml_validation,done --done-state Committed --workspace "CIDAX"
node bin/flow.js project add painel-maestro --company personal --repo https://github.com/higorcesarqn/painel-maestro \
  --stages specification,implementation,final_adjustment,pr_ready,merge,done
```

### 6. Subir o painel

```
npm start                          # ou: node panel/server.js [--port 4777]
```

Abra **http://127.0.0.1:4777** (use `127.0.0.1`, não `localhost`). O servidor grava o PID em `~/.painel-maestro/state/panel.pid`, roda o coletor de uso ao subir e a cada 5 minutos e o verificador de merge a cada 10 minutos. Para parar: Ctrl+C no terminal do servidor (ou `taskkill /PID <pid> /F`). No Maestri, suba-o num terminal shell do canvas (não num agente) e abra-o num portal.

### 7. Conferir

Rode `/especificar` num repositório de teste e acompanhe o item em `http://127.0.0.1:4777/#items/<projeto>/<número>`: ele aparece em Especificação depois da spec e passa para Implementação depois dos tickets. Depois rode `/implementar-issue <número>` (ou `/implementar-pbi <id>`, ou as versões `-maestri` no Ground de um workspace do Maestri): o grafo aparece com as tasks, cada uma com trabalhador, branch, status, relatório e o SHA da integração, seguido do PR em rascunho, dos achados, do ajuste final e do PR pronto. O selo de saúde fica verde quando o hook está gravando as sessões.

### Vindo do painel original

Os nomes mudaram (código em inglês, ADR 0004) e não há apelidos para os antigos: troque-os onde estiverem configurados.

- Hook: `bin/hook_log.js` → `bin/hook-log.js` (no `~/.claude/settings.json`).
- Filtro de horário das rotinas do Maestri: `bin/janela-horario.js` → `bin/time-window.js`; `--agora`/`MAESTRO_AGORA` → `--now`/`MAESTRO_NOW`.
- Servidor: `painel/servidor.js` → `panel/server.js`; `--porta` → `--port`; `PAINEL_PORTA` → `PANEL_PORT`, `PAINEL_COLETOR` → `PANEL_COLLECTOR`, `PAINEL_AGORA` → `PANEL_NOW` (as variáveis do servidor são `PANEL_*`); `PAINEL_AVISAR_CEREBRO` não existe mais.
- Dados: em `MAESTRO_DIR` (padrão `~/.painel-maestro`); as pastas antigas dentro do repositório (`registro/`, `estado/`) não são lidas.

## O CLI `flow`

`bin/flow.js` grava cada passo do fluxo como um evento no `maestro.db`. Ele roda **dentro do repositório do projeto** (o projeto sai do `git remote origin` da pasta atual, também no worktree de um floor); só `company` e `project` rodam em qualquer pasta. Nas skills ele é sempre `node "$PAINEL_MAESTRO/bin/flow.js" ...`; abaixo, `flow` abrevia isso. A ajuda completa: `node bin/flow.js --help`.

**Regras comuns:**

- **Quem grava:** `--role maestro|worker|owner` (padrão `maestro`; no `status` e no `report`, `worker`) e `--agent "<codinome>"`.
- **JSON pela entrada padrão:** `--json -` recebe os campos num objeto JSON, o jeito certo para texto com acentos, aspas e várias linhas em qualquer shell do Windows (nas skills: o JSON num arquivo temporário e `--json - < arquivo.json`). O argumento vale mais que o JSON.
- **Códigos de saída:** `0` ok; `2` dado inválido (a mensagem no stderr começa com `erro:` e diz o que corrigir; nada é gravado); `1` outros erros.
- **Etapas** (ids em inglês): `specification` Especificação, `implementation` Implementação, `final_adjustment` Ajuste final, `pr_ready` PR pronto, `merge` Merge, `hml_validation` Validação HML, `done` Concluído. Uma etapa que o projeto não usa é recusada.
- **Links** (`--url`, `--card`): só `https` em `github.com`, `dev.azure.com` ou `*.visualstudio.com`.
- **Concorrência:** o maestro e vários trabalhadores gravam ao mesmo tempo sem perder nem corromper eventos (WAL e `busy_timeout`, ADR 0003).

**Item e etapas (maestro):**

```
flow item start 3100 --title "Conciliação de boletos"                  # entra em Especificação (a 1ª etapa do projeto)
flow item start 12 --title "Exportar PDF" --stage implementation       # sem /especificar: as etapas anteriores contam como concluídas
flow stage 3100 implementation
flow item start --json - < item.json                                   # {"number": 12, "title": "...", "stage": "...", "agent": "..."}
```

**Tasks (maestro):**

```
flow task graph 12 --task "13|Gerar o PDF" --task "14|Enviar por e-mail|13" [--out 15]   # <task>|<título>[|<bloqueios>]; o último grafo vale
flow task graph --json - < grafo.json        # {"number": 12, "tasks": [{"number": 13, "title": "...", "blocked_by": [], "out": false}]}
flow task dispatch 12 13 --floor "Gerar PDF" --worker "Ária" --branch task/13-gerar-pdf   # --worker subagente, sem floor, fora do Maestri
flow task integrate 12 13 --sha 4be1c2d9 --sha-before 9a01f3c
```

Ciclo, bloqueio fora do grafo, task repetida ou bloqueando a si mesma são recusados (código 2). Uma task integrada ou fora só muda de estado com um novo despacho (retrabalho).

**Status e relatório (trabalhador, no worktree da task):**

```
flow status "Testes verdes, ligando a tela" --progress 3/5          # --state working (padrão)
flow status "Preciso do certificado de HML" --state blocked
flow status "Pronto para revisar" --state review                    # done também conta como revisão
flow report --json - < relatorio.json                               # antes de mandar o relatório ao maestro
flow report --status blocked --reason "Falta o certificado" --json - < relatorio.json
```

- O `status` é o comando único do trabalhador: dentro de um terminal do Maestri (com `MAESTRI_TERMINAL_ID`) ele também roda `maestri floor status` com os mesmos argumentos; fora do Maestri (subagente) só grava. Se o `maestri` falhar, o evento fica gravado e o comando sai com 1.
- A task vem de `--item`/`--task` ou, sem eles, da branch atual: a task despachada com essa branch ou `task/<id>-…`.
- O relatório (`status`, `blocked_reason`, `branch`, `sha`, `tests`, `changes`, `decisions`, `risks`, `shared_files`, `text`) fica exatamente como escrito; branch e SHA, quando não vêm, saem do worktree.

**Pendências (maestro):**

```
flow pending open 12 --kind task_review --task 13 --severity high --title "Revisar e integrar a task 13" \
     --context "..." --option "A: Integrar" --option "B: Pedir ajuste" --recommendation "A: testes verdes"   # imprime P-<id>
flow pending open --json - < pendencia.json
flow pending resolve P-7 --decision "A, com a ressalva X"     # a decisão fica na linha do tempo do item
flow pending cancel P-7 --reason "Entrou na especificação"
```

Tipos (`--kind`): `task_review` (exige `--task`; resolvida sozinha pela integração da task), `worker_blocked`, `decision`, `finding`, `parallelize`, `hml` (um `flow hml` com falha ou bloqueio já abre uma sozinho, que fecha quando uma HML seguinte passar em tudo ou o item for concluído; abrir uma `hml` à mão a substitui). Severidades: `critical`, `high`, `normal` (padrão), `low`. Onde responder: `--workspace`/`--terminal`, senão o terminal do Maestri onde o comando roda (`MAESTRI_WORKSPACE_NAME`/`_ID`, `MAESTRI_TERMINAL_NAME`/`_ID`) e o workspace do projeto.

**Achados (maestro):**

```
flow finding add 12 --title "Corrida ao juntar carrinhos" --classification defect --task 13 --description "..." --new-task 27
flow finding add 12 --title "Limite do carrinho" --classification owner_decision
flow finding link 12 2 --new-task 28 --new-task-title "Limitar o carrinho a 50 itens"
```

**PR, ajuste final, HML e conclusão:**

```
flow pr 12 draft --url https://github.com/org/repo/pull/34 --branch feature/issue-12   # PR em rascunho
flow final-adjustment 12 open                                                       # → Ajuste final
flow final-adjustment 12 result --outcome passed --summary "Testes e build ok"
flow pr 12 ready                                                                    # → PR pronto
flow pr 12 merged                                                                   # quando o maestro faz o merge → Merge
flow hml 3100 --passed 7 --failed 1 --blocked 0 --card https://dev.azure.com/org/proj/_workitems/edit/3100 --role owner   # → Validação HML
flow item done 12                                                                   # → Concluído
```

**Empresas e projetos (dono, em qualquer pasta):**

```
flow company list
flow company add <id> --name "<nome>"   # nome até 80, único sem diferenciar maiúsculas (a tela Empresas também cria)
flow company remove <id>                # só empresa sem projetos; "Sem empresa" não se exclui (a tela Empresas também exclui)
flow project list [--company <id>]
flow project add <id> --company <id> [--name] [--tracker github|azure_devops] [--repo <url>]... [--stages a,b,...] [--done-state "..."] [--workspace "..."]
flow project edit <id> [--name] [--company] [--tracker] [--repo <url>]... [--remove-repo <url>]... [--stages] [--done-state] [--workspace]
flow project move <id> <empresa>        # "Sem empresa" (unassigned) não é destino: código 2
```

Um projeto do Azure DevOps com vários repositórios é um projeto só: o CLI rodado em qualquer um deles (ou num worktree deles) resolve o mesmo projeto. As formas SSH e HTTPS do mesmo remote são iguais.

## Verificador de merge

O merge do PR costuma acontecer na interface do tracker, sem agente presente (a única exceção do ADR 0001). Então o servidor consulta, na subida e a cada `PANEL_MERGE_CHECK_SECONDS` (padrão 600), **só os itens com PR pronto e ainda não mergeado**, só leitura: GitHub pelo `gh pr view`, Azure DevOps pela REST com o token do `az account get-access-token`. Merge confirmado vira o evento `pr-changed` (origem "painel") e leva o item para Merge. Uma falha (por exemplo, `az` sem login) aparece com o motivo na página do item e no selo de saúde; o botão **Marcar como mergeado**, no cartão Entrega da página do item, grava o merge à mão. Com `PANEL_COLLECTOR=0` ou relógio fixo (`PANEL_NOW`) ele fica desligado, a não ser que `PANEL_MERGE_CHECK=1`.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `MAESTRO_DIR` | `~/.painel-maestro` | pasta dos dados: `maestro.db`, `bruto.db`, `state/usage.json`, `state/panel.pid`. O servidor, o `flow`, o hook e o coletor precisam ver a mesma |
| `PAINEL_MAESTRO` | | pasta do código (este repositório), usada pelas skills e pelo `integrate.sh` para achar o `bin/flow.js` |
| `PANEL_PORT` | `4777` | porta do servidor (`--port` vale mais) |
| `PANEL_COLLECTOR` | ligado | `0` desliga o coletor de uso automático (o Recalcular continua funcionando) |
| `PANEL_STALE_HOURS` | `48` | horas na mesma etapa para um item ativo contar como parado na Visão geral |
| `PANEL_MERGE_CHECK` | acompanha o coletor | verificador de merge: `0` desliga, `1` liga |
| `PANEL_MERGE_CHECK_SECONDS` | `600` | intervalo entre as consultas de merge |
| `PANEL_GH_CLI`, `PANEL_AZ_CLI` | `gh`, `az` | executáveis do verificador de merge (os testes usam scripts falsos) |
| `PANEL_AZURE_DEVOPS_URL` | `https://dev.azure.com` | base da REST do Azure DevOps |
| `FLOW_MAESTRI_CLI` | `MAESTRI_CLI` ou `maestri` | executável do `maestri` usado pelo `flow status` (um caminho `.js` roda com o `node`) |
| `MAESTRI_CLI` | `maestri` | executável do Maestri usado pelos scripts das skills (o Maestri define nos terminais dele) |
| `MAESTRI_TERMINAL_ID`, `MAESTRI_TERMINAL_NAME`, `MAESTRI_WORKSPACE_ID`, `MAESTRI_WORKSPACE_NAME` | (do Maestri) | terminal e workspace onde o comando roda: o `flow status` chama o `maestri floor status` e a pendência diz onde responder |
| `MAESTRI_DATA_DIR` | `~/.maestri` | onde está o `usage/providers/.status.json` do plano Claude |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | pasta do Claude Code (transcrições e o destino do `install-skills.js`) |
| `PANEL_INDEX`, `PANEL_NOW`, `MAESTRO_NOW` | | só para testes: outro `index.html` e relógio fixo |
| `MOCK_PORT` | `4795` | porta da demonstração |
| `KEEP_TMP`, `HEAVY_TEST` | | testes: `1` guarda as pastas temporárias; `1` aumenta o teste de desempenho |

Detalhes de cada uma em [`panel/README.md`](panel/README.md#variáveis-de-ambiente).

## Demonstração

Precisa só do Node.js:

```
npm run demo                 # ou: npm run demo -- 4794 (portas 4790 a 4799)
```

Abra **http://127.0.0.1:4795/?mock=1**. A página lê dados fictícios de `panel/tests/mock-items.json`: as empresas Contoso, Fabrikam e Pessoal e dois projetos em "Sem empresa", projetos do GitHub e do Azure DevOps (um com vários repositórios), itens em todas as etapas, o PBI 3112 com tasks nos seis estados e bloqueios, relatórios e achados, pendências abertas e fechadas dos seis tipos, itens parados, uso por item e por agente e os agentes ativos. Uma faixa azul avisa que são dados de teste. Ctrl+C para parar.

O `mock-items.json` é gerado por `node panel/tests/generate-mock-items.js`, que passa eventos fictícios pelo próprio código do servidor (a projeção, as APIs, o coletor de uso, a saúde): a demonstração nunca se afasta do formato da API.

Para ver o **servidor de verdade** com os mesmos dados, num `maestro.db` real (Git Bash):

```
node panel/tests/build-mock-root.js [--hostile]
R=panel/tests/tmp/mock-root
MAESTRO_DIR=$R PANEL_NOW=2026-10-09T10:24:30-03:00 PANEL_COLLECTOR=0 node panel/server.js --port 4793
```

Abra **http://127.0.0.1:4793** (sem `?mock=1`). O `--hostile` acrescenta um item com HTML e `javascript:` nos textos, para conferir que tudo aparece como texto. A pasta `panel/tests/tmp/` pode ser apagada depois.

## Testes

```
npm test                                   # node panel/tests/run-all.js
node panel/tests/run-all.js flow           # só os arquivos com "flow" no nome
npm run build                              # compila a página (depois de npm ci em panel/ui)
npm --prefix panel/ui run check            # confere a página compilada: um único script, nada externo
```

Os testes não usam framework nem navegador. A regra principal: o CLI `flow` e o hook rodam **como processos** em repositórios git temporários com `remote origin` fictício (e worktrees), gravam num `maestro.db`/`bruto.db` temporário e o resultado é conferido **só pela API do servidor**; nenhum teste lê o banco. O `maestri`, o `gh` e o `az` são scripts falsos apontados por variável de ambiente. Cada arquivo trabalha em `panel/tests/tmp/`, sobe servidores só nas portas 4790 a 4799 e apaga tudo no fim (`KEEP_TMP=1` guarda). A lista do que cada arquivo cobre está em [`panel/README.md`](panel/README.md#testes).

## Segurança

- O servidor escuta **só em 127.0.0.1**. O cabeçalho `Host` precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>`; qualquer outro recebe 403 (proteção contra DNS rebinding).
- Todo `POST` exige o cabeçalho **`X-Panel: 1`** e, se vier `Origin`, ele precisa ser o próprio painel; senão, 403. Outra página aberta no navegador não consegue acionar o servidor. Os corpos JSON vão até 16 KB.
- Nenhum cabeçalho CORS. Só existem `/` e `/api/*`; nenhum arquivo é servido pelo nome (o resto é 404).
- Toda resposta leva `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY`. A página leva uma **Content-Security-Policy** que bloqueia qualquer recurso externo e impede que outro site a embuta num iframe.
- A página é um arquivo único (JS, CSS e fonte embutidos). Todo texto vindo da API entra como texto, nunca como HTML; os únicos links para fora são os do PR e do card, e só para `github.com`, `dev.azure.com` e `*.visualstudio.com`.
- O hook e o log bruto redigem segredos (tokens, senhas, `Authorization`, credenciais em URL, valores de variáveis de ambiente com nome de segredo) antes de gravar.
- **Sem dependências** no servidor, no CLI e no hook: só a biblioteca padrão do Node. O servidor só sai da máquina pelo verificador de merge (o `gh` e a REST do Azure DevOps, só leitura). As dependências npm (Preact, Vite, a fonte Manrope e os ícones Lucide) servem só para compilar a página.

Não exponha a porta do painel na rede: ele não tem login e foi feito para uso local.

## Compilar a página

A fonte da página fica em `panel/ui/` (Preact, compilado pelo Vite num HTML único). O resultado, `panel/index.html`, é versionado; só é preciso compilar se você mudar a fonte.

```
cd panel/ui
npm ci
npm run build      # vite build + scripts/publish.js, que grava ../index.html
npm run check      # confere o index.html: um único script, nada externo
npm run dev        # http://127.0.0.1:5173, com /api apontando para o painel em 127.0.0.1:4777 (?mock=1 usa a demonstração)
```

Da raiz, `npm run build` faz o mesmo. Como acrescentar uma tela nova está em [`panel/README.md`](panel/README.md#a-página-indexhtml-fonte-em-ui).

## Estrutura

```
painel-maestro/
├── bin/                         CLI, hook e coletor (só biblioteca padrão do Node)
│   ├── flow.js                  CLI flow: grava os eventos de cada item no maestro.db
│   ├── flow-admin.js            flow company / flow project: cadastro de empresas e projetos
│   ├── flow-store.js            maestro.db (node:sqlite, WAL, esquema e migrações)
│   ├── flow-projection.js       estado do item calculado dos eventos (função pura)
│   ├── flow-repo.js             projeto pelo git remote origin (também em worktrees)
│   ├── hook-log.js              hook do Claude Code → log bruto (bruto.db)
│   ├── raw-store.js             bruto.db (node:sqlite, WAL, retenção de 90 dias)
│   ├── collect-usage.js         uso do plano e tokens por item e por agente
│   ├── install-skills.js        liga as skills ao ~/.claude (backup e --undo)
│   ├── time-window.js           filtro de horário (pré-condição de rotinas agendadas do Maestri)
│   ├── lib.js                   datas no fuso de São Paulo, entrada padrão, redação de segredos
│   └── i18n/                    dicionário pt-BR das mensagens do CLI
├── panel/
│   ├── server.js                servidor HTTP e API (em inglês, devolve códigos)
│   ├── api-*.js                 itens, projetos, pendências, log, uso, Visão geral
│   ├── health.js                selo de saúde
│   ├── merge-check.js           verificador de merge e "marcar como mergeado"
│   ├── index.html               a página compilada (não edite à mão)
│   ├── README.md                documentação técnica do servidor e da página
│   ├── ui/                      fonte da página (Preact + Vite)
│   └── tests/                   testes, demonstração (mock-items.json) e geradores
├── skills/
│   ├── links.json               o que o install-skills.js liga ao ~/.claude
│   ├── especificar/             /especificar
│   ├── implementar-issue/, implementar-pbi/                    fluxo com subagentes (GitHub, Azure DevOps)
│   ├── implementar-issue-maestri/, implementar-pbi-maestri/    fluxo com floors do Maestri
│   ├── trabalhador-floor/       protocolo do trabalhador num floor
│   └── docs/                    orquestracao-subagentes/ e orquestracao-maestri/ (com open-floor.sh e integrate.sh)
├── docs/adr/                    decisões de arquitetura
├── docs/agents/                 configuração das skills de engenharia neste repositório (tracker, rótulos, domínio)
├── CONTEXT.md                   vocabulário do domínio
├── package.json
├── LICENSE
└── README.md
```

## Licença

[MIT](LICENSE). Este repositório nasceu de [joaopedrokleinprevidi/painel-maestro](https://github.com/joaopedrokleinprevidi/painel-maestro) (MIT); o `LICENSE` original é mantido.

**Terceiros** (embutidos no `panel/index.html` compilado):
- [Preact](https://preactjs.com) · licença MIT.
- [Lucide](https://lucide.dev) (`lucide-preact`, ícones) · licença ISC.
- Fonte [Manrope](https://github.com/sharanda/manrope) · SIL Open Font License 1.1 (Copyright 2019 The Manrope Project Authors).
