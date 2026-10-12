# painel-maestro

Painel web local do **fluxo dos itens** que eu implemento com agentes Claude Code: Issues do GitHub e PBIs do Azure DevOps, organizados por **organização** e **projeto**. As skills de implementação (com floors do Maestri ou com subagentes) gravam cada passo do fluxo por um CLI deste repositório (`flow`) num banco SQLite fora do repositório; um servidor Node.js sem dependências calcula o estado de cada item a partir desses eventos e mostra tudo numa página só, em `http://127.0.0.1:4777`.

O painel não usa IA nem gasta tokens: ele lê o que os agentes gravaram. O dono responde as pendências na própria tela Pendências ou no terminal do maestro; o painel grava a resposta em nome dele (ADR 0005).

O vocabulário (Organização, Projeto, Item, Task, Achado, Pendência, Fluxo, Etapa, Maestro, Trabalhador) está em [`CONTEXT.md`](CONTEXT.md); as decisões de arquitetura, em [`docs/adr/`](docs/adr/).

## Como funciona

- **Organizações e projetos.** Cada **projeto** é um projeto do tracker (um repositório do GitHub ou um projeto do Azure DevOps, que pode ter vários repositórios) e pertence a uma **organização**; o trabalho pessoal é a organização "Pessoal", uma organização como as outras. Cada projeto declara o tracker, as **etapas** que usa (por exemplo, sem Validação HML), o estado do tracker que significa "concluído" (no CIDAX é `Committed`) e o workspace do Maestri. O projeto é reconhecido sozinho pelo `git remote origin` da pasta onde o comando roda (também dentro do worktree de um floor); um repositório sem cadastro entra sozinho em **"Sem organização"** e o dono o move para a organização certa pelo painel ("Sem organização" nunca é destino de mover).
- **Item.** Uma Issue pai do GitHub ou um PBI do Azure DevOps, identificado por projeto e número (`cidax/3100`) e mostrado como no tracker (`PBI 3100`, `#12`). O item percorre as **etapas** do fluxo: Especificação → Implementação → Ajuste final → PR pronto → Merge → Validação HML → Concluído (só as que o projeto usa).
- **Tasks.** As filhas do item (sub-issues ou cards filhos), com os bloqueios entre elas, formam um **grafo**. Cada task tem um estado: aguardando, trabalhando, revisão, bloqueada, integrada ou fora. O maestro despacha cada task para um **trabalhador** (um floor do Maestri, com codinome, ou um subagente) numa branch `task/<id>-…` e a integra na branch integradora do item. Uma issue sem filhas é um item com uma task, ele mesmo.
- **Relatórios.** O trabalhador grava o relatório completo (status, testes, o que mudou, decisões, riscos, arquivos compartilhados, o texto inteiro) **antes** de enviá-lo ao maestro, para ele não se perder no terminal.
- **Achados.** O que o maestro encontra nas revisões, classificado como defeito claro, decisão do dono ou descartado; um achado pode virar uma **task nova para triagem**, que aparece no item com o estado "fora".
- **Pendências.** O que espera uma decisão do dono (revisar e integrar uma task, trabalhador bloqueado, decisão, achado que depende do dono, paralelizar tasks, cenário de HML reprovado), com contexto, opções e recomendação. O dono **responde pelo painel** (escolhe uma opção, escreve um comentário se quiser e envia) ou no terminal do maestro, cujo workspace e terminal no Maestri a pendência mostra. A revisão de uma task e o OK para integrá-la são a mesma pendência, que se resolve sozinha quando a task é integrada.
- **PR, HML e conclusão.** O maestro registra o PR em rascunho, o ajuste final, o PR pronto e, quando ele mesmo faz o merge, o merge; o resultado da Validação HML e a conclusão também viram eventos. O merge feito pela interface do tracker, sem agente presente, é descoberto pelo próprio painel (o **verificador de merge**), com um botão "Marcar como mergeado" para quando a consulta falha.
- **Log bruto e uso.** Um hook do Claude Code grava os prompts e comandos de cada sessão dos projetos cadastrados, ligada ao item e à task pela branch; um coletor soma o consumo de tokens por item e por agente e lê o uso do plano Claude (janela de 5 h e semanal) que o Maestri grava.

Tudo que acontece num item é um **evento** guardado para sempre (ADR 0002); o estado do item, das tasks e das pendências é sempre calculado desses eventos, nunca gravado.

## Telas

No topo, o **seletor de organização** (Todas ou uma organização, lembrado neste navegador) filtra todas as telas. O cabeçalho tem o **selo de saúde** (verde, amarelo ou vermelho, com os motivos: hook parado ou falhando, banco ilegível ou de uma versão mais nova do painel-maestro, projetos em "Sem organização", falha do verificador de merge) e o botão **Recalcular** (roda o coletor de uso na hora).

A **aba do navegador** avisa, sem pedir permissão nenhuma, que há pendência esperando o dono: com pendências abertas, o título ganha o número na frente ("(2) Pendências · Painel maestro"), e o favicon (uma caixa de entrada) ganha um ponto, azul ou vermelho forte quando uma delas é crítica. O número é o mesmo do contador de Pendências no menu: todas as organizações, qualquer que seja o seletor do topo. Sem pendência aberta, o título e o favicon ficam sem número e sem ponto. Os dois mudam a cada leitura (20 s), em qualquer tela, e também na demonstração.

A **notificação do navegador** leva o aviso para fora da aba. O dono a liga pelo **sino** no cabeçalho, ao lado do selo de saúde; o navegador só pede a permissão nesse clique, e a escolha fica lembrada neste navegador. O sino mostra se a notificação está desligada, ligada ou bloqueada pelo navegador (aí, libere as notificações do site nas configurações do navegador e clique de novo); onde o navegador não tem notificação, como provavelmente no portal do Maestri, ele não aparece, e na demonstração aparece desabilitado ("indisponível na demonstração"). Com o sino ligado e a aba escondida, cada pendência que abre entre uma leitura e outra (20 s) vira uma notificação do sistema com o título, a severidade e o item; várias na mesma leitura viram uma só ("3 pendências novas"). Abrir ou recarregar o painel nunca notifica as que já estavam abertas, e com a aba à vista nada sai: o título e a lista já mostram. Clicar na notificação foca a aba e abre a pendência em destaque na tela Pendências (ou a lista, quando são várias); com o painel aberto em duas abas, a mesma pendência aparece uma vez só. Toda pendência avisa, de qualquer severidade e organização, a de HML derivada inclusive.

- **Visão geral:** o retrato do dia: itens ativos por organização, projeto e etapa, pendências abertas por severidade, itens parados há muito tempo na mesma etapa (`PANEL_STALE_HOURS`, padrão 48 h), eventos de hoje, atividade recente e o uso do plano.
- **Itens:** a lista (ativos, concluídos ou todos; filtros de projeto, etapa e tracker, além do seletor de organização do topo), os projetos em "Sem organização" em destaque para mover, e a **página do item**, com endereço fixo `http://127.0.0.1:4777/#items/<projeto>/<número>` (é o que o portal do Maestri abre): etapa atual e desde quando, a Entrega (PR, ajuste final, Validação HML, conclusão, o estado do verificador de merge), o grafo de tasks com bloqueios e quem está em cada task (floor, trabalhador, branch, SHA, último status), os relatórios, os achados, as etapas do fluxo e a linha do tempo com todos os eventos e quem gravou cada um.
- **Pendências:** as pendências abertas, resolvidas e canceladas, com filtros por severidade e status, cada uma com o item, a task, contexto, opções, recomendação e, depois de fechada, a decisão. Na pendência aberta, a coluna **Responder** traz as opções como botões que só selecionam (a recomendada destacada), um comentário (obrigatório quando não há opções) e o botão **Enviar resposta**; abaixo, o workspace e o terminal do maestro, para conversar com ele. A resposta grava o mesmo `pending-decision-resolved` do `flow pending resolve`, com papel dono e origem painel, e a pendência passa para resolvida na hora. Se ela fechou enquanto você lia (o maestro resolveu, a task foi integrada, ela foi cancelada), a tela diz que ela já foi fechada e mostra como ficou; outros erros aparecem traduzidos, sem apagar o que você escreveu. O maestro que estiver esperando a pendência é acordado com a decisão; senão, ele a vê quando retomar o item.
- **Log:** os eventos de todos os itens, com filtros por período, projeto, item e tipo; abrir um evento mostra o que foi gravado e os comandos brutos das sessões do Claude Code ligadas a ele.
- **Agentes:** os maestros e trabalhadores ativos, sem cadastro fixo: o maestro de cada item ainda não concluído e o trabalhador de cada task em andamento, com o último evento, a última atividade vista pelo hook e o consumo da janela de 5 h.
- **Uso:** o plano Claude (5 h e semanal, com o reinício), o consumo de cada item em cada período e os tokens de cada agente.
- **Configurações:** aberta pela engrenagem no rodapé do menu (fora das telas de trabalho e das setas do menu), com uma aba por seção, cada uma no próprio endereço (`#settings/<seção>`). A primeira, e por ora a única, é **Organizações** (`#settings/organizations`, também o que abre `#settings` e o endereço antigo `#organizations`): o cadastro inteiro, as organizações ocultas inclusive, qualquer que seja o seletor do topo: um card por organização (nome, id, projetos e itens), em ordem alfabética, com "Sem organização" por último e só quando tem projetos ou está oculta; **Ocultar**, no card, tira a organização de todas as listagens do painel sem pedir confirmação, e **Mostrar** a traz de volta (o card da oculta continua no mesmo lugar, com o selo "Oculta" e as pendências abertas dela, que não aparecem em outro lugar do painel; "Sem organização" também tem o botão); o botão **Nova organização** cria uma (nome até 80 caracteres, único sem diferenciar maiúsculas, e o id sugerido a partir do nome, editável antes de salvar e fixo depois); **Renomear**, no card, abre um modal com o nome atual preenchido (mesma regra de nome, e o próprio nome com outras maiúsculas é aceito; o id não muda; o seletor do topo e as outras telas passam a mostrar o nome novo; "Sem organização" não tem o botão); **Excluir**, no card, exclui uma organização sem projetos depois de confirmar num modal com o nome dela (com projetos o botão fica desabilitado com "mova os N projetos antes"; "Sem organização" não tem o botão; se ela era a do seletor do topo, ele volta para Todas); dentro de cada card, os projetos (nome, tracker, repositórios, itens) com **Mover para** outra organização, as ocultas inclusive, a mesma linha do card "Sem organização" da tela Itens (lá sem as ocultas).

A página se atualiza sozinha a cada 20 segundos. O rodapé do menu mostra a versão do painel-maestro (veja [Versão](#versão)). Quando a página muda no disco (um `npm run build`, um `git pull` que traz outro `index.html`), uma aba aberta antes mostra, em até 20 s, uma faixa fixa no topo: "O painel foi atualizado. Recarregue para usar a versão nova.", com o botão **Recarregar**.

## Instalar do zero

### Requisitos

- **Node.js 22.13 ou mais novo** (o painel usa o SQLite embutido do Node, `node:sqlite`, sem nenhuma dependência npm; desenvolvido e testado no Node 22.23). Compilar a página (só se mudar a fonte dela) pede Node 20.19+ ou 22.12+.
- **git** no `PATH` (o projeto é reconhecido pelo `git remote origin`).
- Para o verificador de merge: o **`gh`** autenticado (GitHub) e/ou o **`az`** com `az login` (Azure DevOps). Sem eles o painel funciona; só a consulta automática do merge falha, com o motivo, e o botão "Marcar como mergeado" resolve.
- Para o uso do plano: o app **Maestri**, com o uso dos agentes ligado (Configurações → Agentes → Uso). Fora dele (no Orca ou num terminal comum), o plano aparece como indisponível e sem fonte, sem número inventado: o Orca não guarda o percentual do plano. Os tokens por item e por agente vêm das transcrições do Claude Code em qualquer ambiente.
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

- **O que é ligado:** só o que `skills/links.json` declara (origem relativa a este repositório, destino relativo à pasta do Claude): as skills `specify`, `implement-issue`, `implement-pbi` e `maestro-worker` em `~/.claude/skills/<nome>`, e os documentos de orquestração `skills/docs/orchestration-subagents` → `~/.claude/docs/orchestration-subagents` `skills/docs/orchestration-maestri` → `~/.claude/docs/orchestration-maestri` (com os scripts `open-floor.sh` e `integrate.sh`) e `skills/docs/orchestration-orca` → `~/.claude/docs/orchestration-orca` (com o `integrate.sh` do Orca).
- **Como:** cada destino vira uma *junction* de diretório no Windows (não exige administrador; funciona com o repositório e o `~/.claude` em discos diferentes) e um symlink de diretório nos outros sistemas. Editar a skill no repositório já vale no Claude Code.
- **Backups:** o que já existir no destino e não for um link deste repositório (por exemplo, uma cópia antiga de `implement-issue`) vai para `~/.claude/backups/painel-maestro/<destino>` (fora de `skills/`, para o Claude Code não carregar duas skills com o mesmo nome). O `--undo` remove só os links deste repositório (nunca o conteúdo deles) e devolve os backups.
- **Conflitos:** a instalação planeja tudo antes de mexer em qualquer coisa. Se um backup já ocupar o lugar, ou se no `--undo` o destino não for mais um link deste repositório e houver backup, o comando sai com **código 2** e nada é alterado; a mensagem diz o que mover.
- **Nomes antigos:** a lista `retired` do `skills/links.json` guarda os nomes em português que as skills tinham até a #61 (`especificar`, `implementar-issue`, `implementar-pbi`, `implementar-issue-maestri`, `implementar-pbi-maestri`, `trabalhador-floor`, `docs/orquestracao-subagentes` e `docs/orquestracao-maestri`) e as variantes `implement-issue-maestri` e `implement-pbi-maestri`, que a #64 juntou à skill de cada tracker. A instalação remove esses destinos só quando são links deste repositório; o que não for link nosso fica como está. O `--undo` também remove um link antigo que tenha sobrado e devolve o backup que o nome antigo tinha.
- **Pasta do Claude:** `--claude-dir <pasta>`, senão `CLAUDE_CONFIG_DIR`, senão `~/.claude`.
- **Depois de atualizar o painel-maestro**, rode `node bin/install-skills.js` de novo (é seguro repetir): ele confere que `~/.claude` aponta para as skills desta versão e põe no backup uma cópia antiga que não seja link. Mudanças de comportamento das skills, como esperar cada pendência com `flow pending wait` (#33), só valem para o maestro com as skills desta versão instaladas.

As skills:

- **`/specify`**: roda `grill-with-docs` → `to-spec` → `to-tickets`; grava o item em **Especificação** assim que o `to-spec` publica a issue ou o PBI, e em **Implementação** quando o `to-tickets` termina.
- **`/implement-issue <número> [modo]`** (GitHub) e **`/implement-pbi <id> [modo]`** (Azure DevOps): uma skill por tracker. O maestro (a sessão que roda a skill) implementa o item num PR só, com um trabalhador por task, e o adaptador do tracker é o mesmo em todos os modos. O modo diz onde os trabalhadores rodam:
  - **`subagents`**: um **subagente** em worktree por task, invisível; funciona em qualquer terminal. Fluxo em `~/.claude/docs/orchestration-subagents/README.md`.
  - **`maestri`**: o maestro no Ground de um workspace do Maestri, com um **floor** e um terminal Claude Code por task; o portal do canvas abre a página do item no painel. Fluxo em `~/.claude/docs/orchestration-maestri/README.md`.
  - **`orca`**: o maestro num terminal do Orca, no worktree do próprio repositório, com um **worktree do Orca** (branch `task/<id>-<slug>`) e um trabalhador Claude Code por task, iniciado e supervisionado pelo orquestrador do Orca (`orca orchestration worker-start`, um Run por item); o trabalhador pergunta com `ask` e entrega com `worker_done`, o maestro espera com `check --wait`, integra com o `integrate.sh` do Orca (que remove o worktree com `orca worktree rm`) e abre a página do item numa aba do navegador do Orca. Fluxo em `~/.claude/docs/orchestration-orca/README.md`.

  **Sem o modo**, a skill roda `flow host` e escolhe pelo ambiente: `orca` no Orca, `maestri` no Maestri, `subagents` num terminal comum. **Para forçar um modo**, passe-o depois do número: `/implement-issue 60 subagents` usa subagentes mesmo dentro do Orca ou do Maestri. O modo passado vale mais que a detecção (ADR 0006). Antes de começar, a skill confere os pré-requisitos do modo (no Maestri, por exemplo, o workspace na raiz do repositório); se um falha, ela para, diz qual e oferece os subagentes, sem trocar de modo sozinha. Cada task despachada grava o modo, que a página do item mostra.
- **`maestro-worker`**: o protocolo do trabalhador num terminal visível: regras comuns (status pelo `flow status`, relatório gravado com `flow report` antes de ir ao maestro, só a sua task, sem push nem tracker) e uma seção por ambiente. No Maestri, o `flow status` também roda o `maestri floor status` e o relatório vai ao maestro com `maestri ask`; no Orca, o `flow status` move o card do worktree, a pergunta vai pelo `ask` do preâmbulo do Orca e o relatório, gravado com `flow report`, é entregue com `worker_done --report-path` (#65). No modo subagentes, o contrato do trabalhador vai no prompt.

As skills são em inglês, porque são contrato lido por agente; o agente fala com o dono em português e grava no painel em português, e as frases do `flow` e dos scripts que elas citam ficam em português, ao pé da letra (ADR 0004). Todas funcionam com GitHub e Azure DevOps (o tracker vem do `docs/agents/issue-tracker.md` do repositório onde elas rodam). A `especificacao-atdd-hml` continua sincronizada do claude.ai, sem mudança: as skills lembram de registrar o resultado da HML com `flow hml`.

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
- **Ligação pela branch:** `task/<id>-…` (ou `task/<id>`) é a task `<id>`; `feature/pbi-<id>` ou `feature/issue-<n>` é o maestro do item; `task/<item>-ajuste-final` (o floor do ajuste final) não é task: conta como o maestro do item; outra branch liga só ao projeto ("sem item" no uso). A convenção vive num lugar só (`parseBranch` em `bin/flow-repo.js`, com o `integrationBranch` ao lado, que dá a integradora do item para o resumo do diff), usado pelo hook e pelo `flow status`/`flow report`; o `integrate.sh` segue a mesma regra.
- **Garantias:** nunca escreve no stdout nem no stderr, sai sempre com 0, desiste de tudo em cerca de 1,5 s (nunca atrasa nem quebra a sessão), trunca entradas (600 caracteres) e saídas (300) e redige segredos (`«redigido»`).
- **Retenção:** o servidor apaga do `bruto.db` o que tem mais de 90 dias, ao subir e uma vez por dia.
- **Banco de uma versão mais nova** (#28): com um `maestro.db` atualizado por um painel-maestro mais novo que este código, o hook não sabe se a sessão é de um projeto e não grava nada, mas deixa `<MAESTRO_DIR>/hook-failure.json` para o selo de saúde, que mostra "Hook parado desde …: atualize o código" até o hook gravar de novo.
- O hook entende esses sete eventos; se a sua versão do Claude Code não tiver algum deles, deixe-o de fora. O hook e o servidor precisam ver o mesmo `MAESTRO_DIR` (ou nenhum).

### 5. Cadastrar organizações e projetos

Opcional (um repositório sem cadastro entra sozinho em "Sem organização"), mas é o que deixa o painel organizado. Estes comandos não precisam rodar dentro de um repositório:

```
node bin/flow.js org add contoso --name "Contoso"
node bin/flow.js org add personal --name "Pessoal"
node bin/flow.js project add cidax --name "CIDAX" --org contoso --tracker azure_devops \
  --repo https://dev.azure.com/contoso/CIDAX/_git/cidax-api --repo https://dev.azure.com/contoso/CIDAX/_git/cidax-web \
  --stages specification,implementation,final_adjustment,pr_ready,merge,hml_validation,done --done-state Committed --workspace "CIDAX"
node bin/flow.js project add painel-maestro --org personal --repo https://github.com/higorcesarqn/painel-maestro \
  --stages specification,implementation,final_adjustment,pr_ready,merge,done
```

### 6. Subir o painel

```
npm start                          # ou: node panel/server.js [--port 4777]
```

Abra **http://127.0.0.1:4777** (use `127.0.0.1`, não `localhost`). O servidor grava o PID em `~/.painel-maestro/state/panel.pid`, roda o coletor de uso ao subir e a cada 5 minutos e o verificador de merge a cada 10 minutos. Para parar: Ctrl+C no terminal do servidor (ou `taskkill /PID <pid> /F`). No Maestri, suba-o num terminal shell do canvas (não num agente) e abra-o num portal.

### 7. Conferir

Rode `/specify` num repositório de teste e acompanhe o item em `http://127.0.0.1:4777/#items/<projeto>/<número>`: ele aparece em Especificação depois da spec e passa para Implementação depois dos tickets. Depois rode `/implement-issue <número>` (ou `/implement-pbi <id>`; no Ground de um workspace do Maestri, a mesma skill usa os floors): o grafo aparece com as tasks, cada uma com trabalhador, branch, status, relatório e o SHA da integração, seguido do PR em rascunho, dos achados, do ajuste final e do PR pronto. O selo de saúde fica verde quando o hook está gravando as sessões.

### Vindo do painel original

Os nomes mudaram (código em inglês, ADR 0004) e não há apelidos para os antigos: troque-os onde estiverem configurados.

- Hook: `bin/hook_log.js` → `bin/hook-log.js` (no `~/.claude/settings.json`).
- Filtro de horário das rotinas do Maestri: `bin/janela-horario.js` → `bin/time-window.js`; `--agora`/`MAESTRO_AGORA` → `--now`/`MAESTRO_NOW`.
- Servidor: `painel/servidor.js` → `panel/server.js`; `--porta` → `--port`; `PAINEL_PORTA` → `PANEL_PORT`, `PAINEL_COLETOR` → `PANEL_COLLECTOR`, `PAINEL_AGORA` → `PANEL_NOW` (as variáveis do servidor são `PANEL_*`); `PAINEL_AVISAR_CEREBRO` não existe mais.
- Dados: em `MAESTRO_DIR` (padrão `~/.painel-maestro`); as pastas antigas dentro do repositório (`registro/`, `estado/`) não são lidas.

## O CLI `flow`

`bin/flow.js` grava cada passo do fluxo como um evento no `maestro.db`. Ele roda **dentro do repositório do projeto** (o projeto sai do `git remote origin` da pasta atual, também no worktree de um floor); só `org` e `project` rodam em qualquer pasta. Nas skills ele é sempre `node "$PAINEL_MAESTRO/bin/flow.js" ...`; abaixo, `flow` abrevia isso. A ajuda completa: `node bin/flow.js --help`.

**Regras comuns:**

- **Quem grava:** `--role maestro|worker|owner` (padrão `maestro`; no `status` e no `report`, `worker`) e `--agent "<codinome>"`.
- **JSON pela entrada padrão:** `--json -` recebe os campos num objeto JSON, o jeito certo para texto com acentos, aspas e várias linhas em qualquer shell do Windows (nas skills: o JSON num arquivo temporário e `--json - < arquivo.json`). O argumento vale mais que o JSON.
- **Códigos de saída:** `0` ok; `2` dado inválido (a mensagem no stderr começa com `erro:` e diz o que corrigir; nada é gravado); `1` outros erros, entre eles um `maestro.db` atualizado por um painel-maestro mais novo que este código (#28: a mensagem pede para atualizar o código e nada é gravado).
- **Etapas** (ids em inglês): `specification` Especificação, `implementation` Implementação, `final_adjustment` Ajuste final, `pr_ready` PR pronto, `merge` Merge, `hml_validation` Validação HML, `done` Concluído. Uma etapa que o projeto não usa é recusada.
- **Links** (`--url`, `--card`): só `https` em `github.com`, `dev.azure.com` ou `*.visualstudio.com`.
- **Concorrência:** o maestro e vários trabalhadores gravam ao mesmo tempo sem perder nem corromper eventos (WAL e `busy_timeout`, ADR 0003).

**Item e etapas (maestro):**

```
flow item start 3100 --title "Conciliação de boletos"                  # entra em Especificação (a 1ª etapa do projeto)
flow item start 12 --title "Exportar PDF" --stage implementation       # sem /specify: as etapas anteriores contam como concluídas
flow stage 3100 implementation
flow item start --json - < item.json                                   # {"number": 12, "title": "...", "stage": "...", "agent": "..."}
```

**Tasks (maestro):**

```
flow task graph 12 --task "13|Gerar o PDF" --task "14|Enviar por e-mail|13" [--out 15]   # <task>|<título>[|<bloqueios>]; o último grafo vale
flow task graph --json - < grafo.json        # {"number": 12, "tasks": [{"number": 13, "title": "...", "blocked_by": [], "out": false}]}
flow task dispatch 12 13 --floor "Gerar PDF" --worker "Ária" --branch task/13-gerar-pdf   # --worker subagente, sem floor, fora do Maestri
flow task dispatch 12 14 --worker subagente --mode subagents        # o modo; sem --mode, vale o do flow host (none → subagents)
flow host --json                                                    # o ambiente: {kind: orca|maestri|none, mode, terminal, workspace, checks}
flow task integrate 12 13 --sha 4be1c2d9 --sha-before 9a01f3c
```

Ciclo, bloqueio fora do grafo, task repetida ou bloqueando a si mesma são recusados (código 2). Uma task integrada ou fora só muda de estado com um novo despacho (retrabalho).

**Status e relatório (trabalhador, no worktree da task):**

```
flow status "Testes verdes, ligando a tela" --progress 3/5          # --state working (padrão)
flow status "Preciso do certificado de HML" --state blocked
flow status "Pronto para revisar" --state review                    # done também conta como revisão
flow report --json - < <scratchpad>/relatorio.json                  # antes de mandar o relatório ao maestro; o JSON fora do worktree
flow report --status blocked --reason "Falta o certificado" --json - < <scratchpad>/relatorio.json
flow report --base integra/carrinho --json - < <scratchpad>/relatorio.json   # integradora fora da convenção (ou "base" no JSON)
```

- O `status` é o comando único do trabalhador e passa pelo **ambiente** (#62, `bin/flow-host.js`): num terminal do Maestri (com `MAESTRI_TERMINAL_ID`) ele também roda `maestri floor status` com os mesmos argumentos; num terminal do Orca (com `ORCA_TERMINAL_HANDLE`, que vale mais que o do Maestri) roda `orca worktree set --worktree current --workspace-status <coluna> --comment "<texto>" --json`, que move o card do worktree (`working` e `blocked` → `in-progress`, `blocked` também `--unread`; `review` e `done` → `in-review`; o progresso vai no fim do comentário); num terminal comum (subagente) só grava. Só o status do trabalhador vai para o ambiente: com `--role maestro` (ou `owner`) ele só grava (#60). Se o `maestri` ou o `orca` falhar, o evento fica gravado e o comando sai com 1. O evento guarda `host: {kind, result}` (`result: recorded` no do maestro; os de antes da #62 guardavam `maestri` e continuam lidos como `kind: maestri`).
- O `flow host` diz o ambiente (`orca`, `maestri` ou `none`, com o modo de despacho dele, `mode`, e o terminal e o worktree ou workspace) e, no Orca, se o `orca status --json` responde com o runtime pronto (`ready`); sai com 0 em todos os casos e não precisa de repositório. O `task dispatch` grava o modo (`--mode subagents|maestri|orca`; sem ele, o do ambiente), e a página do item o mostra em cada task.
- A task vem de `--item`/`--task` ou, sem eles, da branch atual: a task despachada com essa branch ou `task/<id>-…`.
- O relatório (`status`, `blocked_reason`, `branch`, `sha`, `tests`, `changes`, `decisions`, `risks`, `shared_files`, `text`) fica exatamente como escrito; branch e SHA, quando não vêm, saem do worktree. O `relatorio.json` vai num arquivo fora do repositório (o scratchpad da sessão): dentro do worktree ele conta como não commitado no resumo do diff.
- **Resumo do diff** (#41): com SHA (o `--sha` ou o HEAD do worktree), o `report` calcula sozinho os arquivos que a task commitou desde que saiu da branch integradora, com as linhas `+`/`-` e os totais, e os grava no campo `diff` do próprio relatório (`git diff --numstat -z -M` do `merge-base(base, sha)` até o `sha`, só commits: uma task que saiu da integradora antes de outra ser integrada não mostra os arquivos da outra). A base é, nesta ordem, `--base` (ou `base` no JSON), a branch gravada no `flow pr --branch` e a convenção do tracker (`feature/issue-<n>` no GitHub, `feature/pbi-<n>` no Azure DevOps); para cada nome vale a ref local e depois `origin/<nome>`. Arquivo binário vem com `binary: true` e sem contagem de linhas (conta no total de arquivos, fica fora dos totais de linhas); renomeado vem com `from`, o caminho antigo. Acima de 200 arquivos ficam os 200 primeiros na ordem do git, com `truncated: true` e os totais do diff inteiro. `uncommitted` é o número de arquivos com mudança fora de commit no worktree (`git status --porcelain`), contado só quando o SHA é o HEAD do próprio worktree da task (outra pasta no mesmo commit, como a do maestro, não conta). Sem resumo (sem SHA, sem base, erro ou timeout de 10 s do git), o relatório é gravado sem `diff`, o comando sai com 0 e uma segunda linha diz o motivo. A página do item mostra o resumo dentro de cada relatório.

**Pendências (maestro):**

```
flow pending open 12 --kind task_review --task 13 --severity high --title "Revisar e integrar a task 13" \
     --context "..." --option "A: Integrar" --option "B: Pedir ajuste" --recommendation "A: testes verdes"   # imprime P-<id>
flow pending open --json - < pendencia.json
flow pending resolve P-7 --decision "A, com a ressalva X"     # a decisão fica na linha do tempo do item
flow pending cancel P-7 --reason "Entrou na especificação"
flow pending wait P-7                                         # espera ela fechar (o maestro o deixa em segundo plano)
```

Uma pendência que o dono já respondeu pelo painel não aceita outra resolução: o `pending resolve` sai com o "não está aberta" de sempre (código 2).

No Orca (#62), o `pending open` marca o worktree do maestro como não lido (`orca worktree set --worktree current --unread --json`) e grava onde responder: o worktree (`ORCA_WORKTREE_ID`) e o terminal (`ORCA_TERMINAL_HANDLE`) do maestro, salvo `--workspace`/`--terminal`. Uma falha do aviso no Orca segue a mesma regra do Maestri, abaixo.

O `pending open` rodado num terminal do Maestri (com `MAESTRI_TERMINAL_ID`, o Maestro Mode) avisa o dono com `maestri notify` (#44): uma notificação do sistema, de até 500 caracteres, com a severidade, o tipo, o item, a task e o título da pendência ("Pendência nova (alta): revisão de task no item painel-maestro/40 (#40), task 44. Revisar a task 44"), pelo mesmo executável e prazo do `maestri floor status` (`FLOW_MAESTRI_CLI`). Fora do Maestri (subagentes) nada é chamado. Uma falha do aviso nunca falha o comando: a pendência é gravada, o comando sai com **0** e imprime a pendência como sempre, e uma linha no stderr diz que o dono pode não ter sido avisado. O evento guarda como foi (`notification`: `sent`, `failed` ou `outside`) e a tela Pendências mostra quando falhou, enquanto a pendência está aberta. A pendência de HML derivada do `flow hml` não chama o `maestri`.

O `pending wait` é como o maestro fica sabendo da resposta (ADR 0005): as skills de orquestração o deixam rodando em segundo plano depois de cada `pending open`. Ele só lê o `maestro.db`, a cada poucos segundos (`FLOW_WAIT_INTERVAL_MS`, padrão 3000), sem prazo e sem depender do servidor do painel, e não cadastra o projeto. Termina com **código 0** quando a pendência fecha por qualquer caminho (resposta pelo painel, `pending resolve`, cancelamento, integração da task, HML aprovada, substituição, item concluído) ou na hora, se ela já estava fechada, e imprime a chave do item e o id, como ela fechou, a decisão ou o motivo e quem fechou (papel e nome). Quando a decisão veio do painel, uma linha a mais diz que ela já está gravada e que não é para rodar `pending resolve`. Sai com **2** para id inválido ou pendência que o projeto não tem e com **1** numa falha do banco (inclusive banco mais novo que o código). Aceita `--json -` com `{"id": "P-7"}`.

```
Pendência P-7 do item painel-maestro/31 (#31), task 33, fechou: resolvida com a decisão do dono.
Título: Revisar a task 33
Decisão: B: Pedir ajuste — mantenha o nome antigo
Fechada por: dono, pelo painel, em 2026-10-10T14:05:12-03:00.
A decisão veio do painel e já está gravada: siga com ela; não rode flow pending resolve.
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

**Organizações e projetos (dono, em qualquer pasta):**

```
flow org list
flow org add <id> --name "<nome>"   # nome até 80, único sem diferenciar maiúsculas, nunca o de "Sem organização" (Configurações → Organizações também cria)
flow org rename <id> --name "<nome>" # o id não muda; "Sem organização" não se renomeia (Configurações → Organizações também renomeia)
flow org remove <id>                # só organização sem projetos; "Sem organização" não se exclui (Configurações → Organizações também exclui)
flow org hide <id>                  # oculta: sai das listagens do painel, o trabalho segue normal; "Sem organização" também (o org list marca as ocultas)
flow org unhide <id>                # mostra de novo; repetir hide ou unhide não é erro
flow project list [--org <id>]
flow project add <id> --org <id> [--name] [--tracker github|azure_devops] [--repo <url>]... [--stages a,b,...] [--done-state "..."] [--workspace "..."]
flow project edit <id> [--name] [--org] [--tracker] [--repo <url>]... [--remove-repo <url>]... [--stages] [--done-state] [--workspace]
flow project move <id> <organização> # "Sem organização" (unassigned) não é destino (nem em project add/edit): código 2
```

Um projeto do Azure DevOps com vários repositórios é um projeto só: o CLI rodado em qualquer um deles (ou num worktree deles) resolve o mesmo projeto. As formas SSH e HTTPS do mesmo remote são iguais.

## Verificador de merge

O merge do PR costuma acontecer na interface do tracker, sem agente presente (uma exceção do ADR 0001). Então o servidor consulta, na subida e a cada `PANEL_MERGE_CHECK_SECONDS` (padrão 600), **só os itens com PR pronto e ainda não mergeado**, só leitura: GitHub pelo `gh pr view`, Azure DevOps pela REST com o token do `az account get-access-token`. Merge confirmado vira o evento `pr-changed` (origem "painel") e leva o item para Merge. Uma falha (por exemplo, `az` sem login) aparece com o motivo na página do item e no selo de saúde; o botão **Marcar como mergeado**, no cartão Entrega da página do item, grava o merge à mão. Com `PANEL_COLLECTOR=0` ou relógio fixo (`PANEL_NOW`) ele fica desligado, a não ser que `PANEL_MERGE_CHECK=1`.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `MAESTRO_DIR` | `~/.painel-maestro` | pasta dos dados: `maestro.db`, `bruto.db`, `hook-failure.json`, `state/usage.json`, `state/panel.pid`. O servidor, o `flow`, o hook e o coletor precisam ver a mesma |
| `PAINEL_MAESTRO` | | pasta do código (este repositório), usada pelas skills e pelo `integrate.sh` para achar o `bin/flow.js` |
| `PANEL_PORT` | `4777` | porta do servidor (`--port` vale mais) |
| `PANEL_COLLECTOR` | ligado | `0` desliga o coletor de uso automático (o Recalcular continua funcionando) |
| `PANEL_STALE_HOURS` | `48` | horas na mesma etapa para um item ativo contar como parado na Visão geral |
| `PANEL_MERGE_CHECK` | acompanha o coletor | verificador de merge: `0` desliga, `1` liga |
| `PANEL_MERGE_CHECK_SECONDS` | `600` | intervalo entre as consultas de merge |
| `PANEL_GH_CLI`, `PANEL_AZ_CLI` | `gh`, `az` | executáveis do verificador de merge (os testes usam scripts falsos) |
| `PANEL_AZURE_DEVOPS_URL` | `https://dev.azure.com` | base da REST do Azure DevOps |
| `FLOW_MAESTRI_CLI` | `MAESTRI_CLI` ou `maestri` | executável do `maestri` usado pelo `flow status` e pelo `flow pending open` (um caminho `.js` roda com o `node`) |
| `FLOW_WAIT_INTERVAL_MS` | `3000` | intervalo entre as leituras do `flow pending wait`, em ms (os testes usam 50) |
| `FLOW_ORCA_CLI` | `orca` | executável do `orca` usado pelo `flow host`, pelo `flow status` e pelo `flow pending open` no Orca (um caminho `.js` roda com o `node`) |
| `ORCA_TERMINAL_HANDLE`, `ORCA_WORKTREE_ID` | (do Orca) | terminal e worktree do Orca onde o comando roda: com `ORCA_TERMINAL_HANDLE`, o ambiente é o Orca (vale mais que o Maestri); a pendência diz onde responder |
| `MAESTRI_CLI` | `maestri` | executável do Maestri usado pelos scripts das skills (o Maestri define nos terminais dele) |
| `ORCA_CLI` | `orca` | executável do Orca usado pelo `integrate.sh` do fluxo do Orca (o teste usa um falso) |
| `MAESTRI_TERMINAL_ID`, `MAESTRI_TERMINAL_NAME`, `MAESTRI_WORKSPACE_ID`, `MAESTRI_WORKSPACE_NAME` | (do Maestri) | terminal e workspace onde o comando roda: o `flow status` chama o `maestri floor status`, o `flow pending open` chama o `maestri notify` e a pendência diz onde responder |
| `MAESTRI_DATA_DIR` | `~/.maestri` | onde está o `usage/providers/.status.json` do plano Claude |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | pasta do Claude Code (transcrições e o destino do `install-skills.js`) |
| `PANEL_INDEX`, `PANEL_NOW`, `MAESTRO_NOW` | | só para testes: outro `index.html` e relógio fixo |
| `PANEL_REPO_DIR` | a pasta do código | só para testes: o repositório de onde o servidor lê a versão e confere se o código dele mudou (`server_outdated`) |
| `PANEL_OUTDATED_CACHE_MS` | `5000` | só para testes: o cache da checagem do `server_outdated`, em ms (os testes usam 200) |
| `MOCK_PORT` | `4795` | porta da demonstração |
| `PANEL_TEST_PORTS` | `4790-4799` | testes: a faixa de portas dos servidores de teste, para dois floors rodarem a suíte ao mesmo tempo |
| `KEEP_TMP`, `HEAVY_TEST` | | testes: `1` guarda as pastas temporárias; `1` aumenta o teste de desempenho |

Detalhes de cada uma em [`panel/README.md`](panel/README.md#variáveis-de-ambiente).

## Demonstração

Precisa só do Node.js:

```
npm run demo                 # ou: npm run demo -- 4794 (portas 4790 a 4799)
```

Abra **http://127.0.0.1:4795/?mock=1**. A página lê dados fictícios de `panel/tests/mock-items.json`: as organizações Contoso, Fabrikam e Pessoal, a Northwind oculta (com projeto, itens e uma pendência aberta, para conferir Configurações → Organizações) e dois projetos em "Sem organização", projetos do GitHub e do Azure DevOps (um com vários repositórios), itens em todas as etapas, o PBI 3112 com tasks nos seis estados e bloqueios, relatórios e achados, pendências abertas e fechadas dos seis tipos (as abertas, com e sem opções, podem ser respondidas: na demonstração a resposta fica só na memória da página), itens parados, uso por item e por agente e os agentes ativos. Uma faixa azul avisa que são dados de teste. Ctrl+C para parar.

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

Os testes não usam framework nem navegador. A regra principal: o CLI `flow` e o hook rodam **como processos** em repositórios git temporários com `remote origin` fictício (e worktrees), gravam num `maestro.db`/`bruto.db` temporário e o resultado é conferido **só pela API do servidor**; nenhum teste lê o banco. O `maestri`, o `gh` e o `az` são scripts falsos apontados por variável de ambiente. Cada arquivo trabalha em `panel/tests/tmp/`, sobe servidores só nas portas 4790 a 4799 (`PANEL_TEST_PORTS=4790-4794` restringe a faixa, para dois floors rodarem a suíte ao mesmo tempo) e apaga tudo no fim (`KEEP_TMP=1` guarda). A lista do que cada arquivo cobre está em [`panel/README.md`](panel/README.md#testes).

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

## Versão

O painel-maestro tem uma versão só, o semver do `package.json` da raiz, mostrada com o commit do código: `v1.1.0 · a5c2e21` no rodapé do menu, junto de "Painel local", e `painel-maestro 1.1.0 (a5c2e21)` no `node bin/flow.js --version` (ou `-v`, em qualquer pasta). O commit do painel é o da hora em que o servidor subiu (o rodapé só muda quando ele reinicia); rodando de uma pasta sem git, ou sem git no `PATH`, o commit some e fica só o semver. Quando um commit posterior muda o que o servidor executa (`bin/`, os `.js` de primeiro nível de `panel/` ou o `package.json`), depois de um `git pull` ou de uma troca de branch, o selo de saúde fica amarelo com "O código do servidor mudou desde que ele subiu" (`server_outdated`): reinicie o servidor. Commits só de docs, testes, fonte da UI ou da página compilada e edições não commitadas não acendem o aviso; sem git, a checagem fica desligada. A versão do schema do banco (#28) é outra, separada.

A página tem também um **id da página**: o build (`panel/ui/scripts/publish.js`) grava um hash do conteúdo da página num `<meta name="page-id">` do `index.html`. O servidor lê o id do `index.html` atual (com a mesma leitura em cache que serve a página) e o devolve no `/api/state`; a aba compara o id dela com esse a cada leitura e, quando diferem, mostra a faixa "O painel foi atualizado" com **Recarregar**. A faixa não fecha e nunca recarrega sozinha; a demonstração (`?mock=1`) não compara. Como o id é do conteúdo, e não do commit nem do semver, reiniciar o servidor com a mesma página, ou mudar docs, testes e código que não altera a página, não acende a faixa.

A convenção: o ajuste final de cada item sobe o minor; uma correção avulsa fora de item sobe o patch; a tag `vX.Y.Z` no merge é opcional, do dono. Os detalhes estão em [`docs/agents/versao.md`](docs/agents/versao.md).

## Estrutura

```
painel-maestro/
├── bin/                         CLI, hook e coletor (só biblioteca padrão do Node)
│   ├── flow.js                  CLI flow: grava os eventos de cada item no maestro.db
│   ├── flow-admin.js            flow org / flow project: cadastro de organizações e projetos
│   ├── flow-store.js            maestro.db (node:sqlite, WAL, esquema e migrações)
│   ├── flow-projection.js       estado do item calculado dos eventos (função pura)
│   ├── flow-repo.js             projeto pelo git remote origin (também em worktrees)
│   ├── hook-log.js              hook do Claude Code → log bruto (bruto.db)
│   ├── hook-failure.js          falha do hook (maestro.db mais novo que o código) para o selo de saúde
│   ├── raw-store.js             bruto.db (node:sqlite, WAL, retenção de 90 dias)
│   ├── collect-usage.js         uso do plano e tokens por item e por agente
│   ├── install-skills.js        liga as skills ao ~/.claude (backup e --undo)
│   ├── time-window.js           filtro de horário (pré-condição de rotinas agendadas do Maestri)
│   ├── version.js               versão do painel-maestro (semver do package.json e commit do código)
│   ├── lib.js                   datas no fuso de São Paulo, entrada padrão, redação de segredos
│   └── i18n/                    dicionário pt-BR das mensagens do CLI
├── panel/
│   ├── server.js                servidor HTTP e API (em inglês, devolve códigos)
│   ├── api-*.js                 itens, projetos, pendências, log, uso, Visão geral
│   ├── health.js                selo de saúde
│   ├── server-outdated.js       aviso de servidor desatualizado (código mudou no git desde a subida)
│   ├── merge-check.js           verificador de merge e "marcar como mergeado"
│   ├── index.html               a página compilada (não edite à mão)
│   ├── README.md                documentação técnica do servidor e da página
│   ├── ui/                      fonte da página (Preact + Vite)
│   └── tests/                   testes, demonstração (mock-items.json) e geradores
├── skills/
│   ├── links.json               o que o install-skills.js liga ao ~/.claude
│   ├── specify/                 /specify
│   ├── implement-issue/, implement-pbi/   uma skill por tracker (GitHub, Azure DevOps); o modo vem do ambiente ou do argumento
│   ├── maestro-worker/          protocolo do trabalhador num floor do Maestri ou num worktree do Orca
│   └── docs/                    orchestration-subagents/, orchestration-maestri/ (com open-floor.sh e integrate.sh) e orchestration-orca/ (com integrate.sh)
├── docs/adr/                    decisões de arquitetura
├── docs/agents/                 configuração das skills de engenharia neste repositório (tracker, rótulos, domínio, versão)
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
