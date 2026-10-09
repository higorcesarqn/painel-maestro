# painel-maestro

Painel web local para acompanhar um workspace multiagente montado no app Maestri com agentes Claude Code. Um servidor Node.js sem dependências lê os arquivos que os agentes gravam (log de eventos, fila de pendências, uso do plano) e mostra tudo numa página só, em `http://127.0.0.1`.

Este repositório traz **só o painel** e os scripts de linha de comando que gravam os dados que ele lê. Os agentes em si (papéis, prompts, rotinas) não estão aqui: cada um monta os seus. O método que eles seguem vem como modelo para adaptar (veja [Skills e protocolos do workspace](#skills-e-protocolos-do-workspace)).

## A ideia

No workspace, um agente principal, o **Cérebro Principal**, recebe os pedidos do dono. Ele não executa trabalho de domínio: entende o pedido, decide quem atende e delega a sub-agentes especializados, cada um com o seu domínio (por exemplo, um **Coordenador de Dependências** que audita os pacotes dos projetos). O Cérebro acompanha até a resposta, valida e devolve o resultado ao dono.

Todo pedido abre um **fluxo** (`F-AAAAMMDD-NNNN`), e tudo que acontece nele vira um **evento** num log: quem fez, de onde veio o pedido, o tipo, o resultado e a **direção**, isto é, o caminho que o agente tomou e por quê. Em paralelo, hooks do Claude Code gravam o **log bruto** de cada agente (prompts, comandos, ferramentas usadas), que o painel liga ao evento certo pelo id do fluxo ou pela janela de tempo.

As decisões que só o dono pode tomar entram numa **fila de pendências**, sempre com contexto, opções e uma recomendação. O dono responde pelo próprio painel, e a resposta fica gravada na pendência e vira evento no fluxo de origem.

O painel junta tudo isso num lugar só e não usa IA nem gasta tokens: ele só lê arquivos.

## Telas

O menu tem um grupo, Workspace (fonte em `panel/ui/src/data/context.js`):

- **Itens** (modelo novo): a lista de itens (Issues do GitHub e PBIs do Azure DevOps) com a etapa de cada um, e a **página do item**, com a etapa atual, as etapas do fluxo e a linha do tempo. A página de um item tem endereço fixo, `http://127.0.0.1:4777/#items/<projeto>/<número>` (ex.: `#items/cidax/3100`), que o portal do Maestri abre direto.
- **Visão geral:** números do topo (pendências por severidade, uso do plano, eventos de hoje), atividade e resultados de 7 dias por agente, último evento de cada agente e atividade recente. O cabeçalho tem um **selo de saúde** (verde, amarelo ou vermelho) com os motivos: hooks parados, arquivos ilegíveis.
- **Pendências:** a fila do dono, com filtros por severidade e status; cada pendência mostra contexto, opções e recomendação, e o dono responde ali mesmo (opção + comentário, Ctrl+Enter envia).
- **Log:** a tabela de eventos com busca, período, chips de agente e projeto, tipo, resultado e "só o que precisa de mim". Clicar numa linha abre o **modal do evento**: o pedido inicial, a direção, os passos, os comandos brutos ligados a ele e a sequência do fluxo.
- **Agentes:** um cartão por agente (último evento, eventos de hoje, fluxos abertos, consumo) e a ficha completa num modal, com o log bruto de cada um.
- **Uso:** o plano do Claude (janela de 5 h e semanal, com o horário de reinício) e a participação de cada agente no consumo de tokens.

A página se atualiza sozinha a cada 20 segundos.

## Demonstração em 1 minuto

Precisa só do Node.js. A página compilada (`panel/index.html`) já vem no repositório, então não é preciso instalar nada.

```
git clone <url-do-repositorio> painel-maestro
cd painel-maestro
npm run demo
```

Abra **http://127.0.0.1:4795/?mock=1**. O `?mock=1` faz a página ler dados fictícios de `panel/tests/mock-*.json` (um workspace "Exemplo" com dois agentes, pendências, eventos e comandos brutos, e, na tela Itens, itens de três empresas e de "Sem empresa" em todas as etapas, no GitHub e no Azure DevOps); uma faixa azul avisa que são dados de teste. Para parar, Ctrl+C.

O servidor da demonstração aceita só as portas 4790 a 4799 (padrão 4795). Outra porta: `npm run demo -- 4794`.

### O servidor de verdade sobre dados de exemplo

Para ver o `server.js` real (a API inteira, com os filtros e o modal calculados no servidor) sem dados seus, monte uma raiz falsa a partir dos mesmos mocks. No Git Bash, Linux ou macOS:

```
node panel/tests/build-mock-root.js
R=panel/tests/tmp/mock-root
MAESTRO_DIR=$R MAESTRI_DATA_DIR=$R/maestri CLAUDE_CONFIG_DIR=$R/claude \
  PANEL_NOW=2026-10-09T10:24:30-03:00 PANEL_COLLECTOR=0 PANEL_NOTIFY_BRAIN=0 \
  node panel/server.js --port 4793
```

Abra **http://127.0.0.1:4793** (sem `?mock=1`). O `PANEL_NOW` fixa o relógio no momento do cenário de exemplo e o `PANEL_COLLECTOR=0` desliga o coletor de uso. Ctrl+C para parar. A pasta `panel/tests/tmp/` pode ser apagada depois.

## Ligar a dados reais

### Modelo novo: itens, o CLI `flow` e o `maestro.db`

O painel está passando a girar em torno do fluxo de cada **item** (#1). A primeira fatia (#5) já funciona ao lado do modelo antigo, que continua igual: o maestro roda o CLI `flow` dentro do repositório do projeto e o painel mostra o item nas telas Itens e Item.

```
node /caminho/para/painel-maestro/bin/flow.js item start 3100 --title "Conciliação de boletos"   # entra em Especificação
node /caminho/para/painel-maestro/bin/flow.js item start 12 --title "..." --stage implementation   # sem /especificar: Especificação conta como concluída
node /caminho/para/painel-maestro/bin/flow.js stage 3100 implementation
node /caminho/para/painel-maestro/bin/flow.js item start --json - < item.json                   # {"number": 12, "title": "...", "stage": "...", "role": "maestro", "agent": "..."}
node /caminho/para/painel-maestro/bin/flow.js --help
```

Tasks do item (#7): o maestro registra o grafo, o despacho e a integração; o trabalhador, o status.

```
# maestro
node .../bin/flow.js task graph 12 --task "13|Gerar o PDF" --task "14|Enviar por e-mail|13" [--out 15]   # <task>|<título>[|<bloqueios>]
node .../bin/flow.js task graph --json - < grafo.json        # {"number": 12, "tasks": [{"number": 13, "title": "...", "blocked_by": [], "out": false}, ...]}
node .../bin/flow.js task dispatch 12 13 --floor "Gerar PDF" --worker "Ária" --branch task/13-gerar-pdf
node .../bin/flow.js task integrate 12 13 --sha 4be1c2d9 [--sha-before 9a01f3c]
# trabalhador (no worktree da task)
node .../bin/flow.js status "Testes verdes, ligando a tela" --progress 3/5
node .../bin/flow.js status "Preciso decidir o formato do token" --state blocked
node .../bin/flow.js status "Pronto para revisar" --state review          # ou: --item 12 --task 13
```

- **Grafo:** a lista de tasks do item com os bloqueios (as tasks que precisam estar integradas antes); o último grafo registrado vale. Bloqueio fora do grafo, task repetida, task bloqueando a si mesma e ciclo são recusados (código 2). `--out` (ou `"out": true` no JSON) marca tasks fora do item. Um item **sem grafo** é **uma task só, ele mesmo** (o número da task é o do item).
- **Estados de task** (calculados dos eventos): `waiting` aguardando (no grafo, ainda não despachada), `working` trabalhando (despachada, ou status `working`), `review` revisão (status `review` ou `done`), `blocked` bloqueada (status `blocked`), `integrated` integrada (`task integrate`), `out` fora. Integrada ou fora só sai disso com um novo `task dispatch` (retrabalho).
- **Status, o comando único do trabalhador:** dentro de um terminal do Maestri (com `MAESTRI_TERMINAL_ID`) roda `maestri floor status "<texto>" --state <estado> [--progress n/m]` e grava o evento `task-status`; fora do Maestri (subagente) só grava. O executável é `FLOW_MAESTRI_CLI` (padrão: `MAESTRI_CLI` ou `maestri`; um caminho `.js` roda com o `node`). Se o `maestri` falhar, o evento fica gravado (com `maestri: "failed"`) e o comando sai com **código 1**. Papel padrão: `worker`.
- **Como o status acha a task:** `--item`/`--task` quando informados; senão, pela branch atual: a task despachada com essa branch (`task dispatch --branch`) ou, senão, `task/<id>-…` → task `<id>`, procurada nos itens do projeto (se ela existir em mais de um item, `--item` decide). Com `--item` e um item de uma task só, `--task` é dispensável.

PR, ajuste final, Validação HML e conclusão (#9):

```
node .../bin/flow.js pr 12 draft --url https://github.com/org/repo/pull/34 --branch feature/issue-12   # PR criado em rascunho (leva a Implementação, se o item estiver antes)
node .../bin/flow.js final-adjustment 12 open                                                       # → Ajuste final
node .../bin/flow.js final-adjustment 12 result --outcome passed --summary "Testes e build ok"       # resultado (passed|failed); a etapa não muda
node .../bin/flow.js pr 12 ready                                                                    # saiu do rascunho → PR pronto
node .../bin/flow.js pr 12 merged                                                                   # o maestro fez o merge → Merge
node .../bin/flow.js hml 3100 --passed 7 --failed 1 --blocked 0 --card https://dev.azure.com/org/proj/_workitems/edit/3100 --role owner   # → Validação HML
node .../bin/flow.js item done 12                                                                   # → Concluído: sai da lista de ativos, continua consultável
```

- **PR:** a URL é obrigatória no primeiro registro; depois, URL, número e branch integradora ficam dos registros anteriores. O número sai da URL (`/pull/34`, `/pullrequest/812`) quando `--pr` não vem.
- **Links** (`--url`, `--card`): só `https` de `github.com`, `dev.azure.com` ou `*.visualstudio.com`; outro endereço é recusado (código 2), e a página só mostra links desses domínios.
- **Etapas do projeto:** um evento cuja etapa o projeto não usa é recusado (por exemplo, `hml` num projeto sem Validação HML, que vai de Merge direto a Concluído).
- **JSON:** os mesmos campos (`state`, `url`, `pr`, `branch`; `action`, `outcome`, `summary`; `passed`, `failed`, `blocked`, `card`, `summary`) vêm por `--json -`.

- **Projeto:** sai do `git remote origin` da pasta atual (também dentro do worktree de um floor; as formas SSH e HTTPS do mesmo repositório dão o mesmo projeto). Um repositório sem cadastro é cadastrado sozinho na empresa **"Sem empresa"** (id e nome tirados do nome do repositório; GitHub ou Azure DevOps pelo endereço) e o comando segue. A chave de um item é `projeto/número` (`cidax/3100`); o número aparece como no tracker: `PBI 3100` no Azure DevOps, `#12` no GitHub.
- **Etapas** (ids em inglês, nomes em português): `specification` Especificação, `implementation` Implementação, `final_adjustment` Ajuste final, `pr_ready` PR pronto, `merge` Merge, `hml_validation` Validação HML, `done` Concluído. Etapa fora da lista do projeto é recusada.
- **Campos:** por argumento ou por JSON na entrada padrão (`--json -`, melhor para acentos, aspas e várias linhas); o argumento vale mais que o JSON. `--role maestro|worker|owner` (padrão `maestro`) e `--agent "<codinome>"` dizem quem gravou.
- **Erros:** dado inválido (número, etapa, título, item já iniciado ou ainda não iniciado, pasta sem `remote origin`) sai com **código 2** e a mensagem no stderr; outros erros, código 1. As mensagens vêm do dicionário pt-BR do CLI (`bin/i18n/pt-BR.js`).
- **Dados:** cada passo vira um **evento** no `maestro.db` (SQLite embutido do Node, `node:sqlite`, Node 22.13+), em `MAESTRO_DIR`, cujo padrão para o modelo novo é **`~/.painel-maestro`** (`C:\Users\<você>\.painel-maestro`). O banco usa WAL e espera a vez (`busy_timeout`), então o maestro e os trabalhadores gravam ao mesmo tempo sem perder eventos; a versão do esquema fica no próprio banco e é migrada ao abrir. O estado do item nunca é gravado: o painel o calcula dos eventos (ADR 0002). O aviso de módulo experimental do SQLite é silenciado.

Com `MAESTRO_DIR` definido, o modelo antigo e o novo usam a mesma pasta; sem ele, o antigo continua na pasta do repositório e o novo vai para `~/.painel-maestro`. O servidor lê o `maestro.db` do mesmo jeito: suba-o com o mesmo `MAESTRO_DIR` (ou nenhum) que os agentes usam.

### Instalar as skills do dono (`PAINEL_MAESTRO` e `install-skills.js`)

As skills que gravam o fluxo no painel vivem em `skills/` deste repositório e são ligadas à pasta do Claude. Hoje é a `/especificar` (`skills/especificar/`): ela roda `grill-with-docs` → `to-spec` → `to-tickets` e grava o item em **Especificação** logo depois que o `to-spec` publica a issue ou o PBI, e em **Implementação** quando o `to-tickets` termina. Funciona com GitHub e Azure DevOps (o tracker vem do `docs/agents/issue-tracker.md` do repositório onde ela roda).

1. **`PAINEL_MAESTRO`**: as skills chamam o CLI por caminho absoluto, `node "$PAINEL_MAESTRO/bin/flow.js" ...`, de dentro do repositório do projeto. Defina a variável de usuário com a pasta **do código** (este repositório, não a dos dados) e reabra o terminal e o Claude Code:

   ```
   setx PAINEL_MAESTRO "D:\pessoal\git\painel-maestro"
   ```

   No Git Bash do Claude Code ela aparece como `$PAINEL_MAESTRO`; caminhos com `\` funcionam no `node`. Confira com `node "$PAINEL_MAESTRO/bin/flow.js" --help`.

2. **Ligar as skills** ao `~/.claude/skills`:

   ```
   node bin/install-skills.js           # instala; rodar de novo é seguro
   node bin/install-skills.js --undo    # desfaz: remove os links e devolve o que havia antes
   node bin/install-skills.js --help
   ```

   - **O que é ligado:** só o que `skills/links.json` declara (`{"links": [{"source": "skills/especificar", "target": "skills/especificar"}]}`, a origem relativa a este repositório e o destino relativo à pasta do Claude). As skills antigas de `skills/cerebro/` e `skills/compartilhadas/` não são declaradas e não são instaladas.
   - **Como:** cada destino vira uma *junction* de diretório no Windows (não exige administrador; funciona com o repositório e o `~/.claude` em discos diferentes) e um symlink de diretório nos outros sistemas. Editar a skill no repositório já vale no Claude Code.
   - **Backup:** o que já existir no destino e não for um link deste repositório vai para `~/.claude/backups/painel-maestro/<destino>` (fora de `skills/`, para o Claude Code não carregar duas skills com o mesmo nome). O `--undo` remove só os links deste repositório (nunca o conteúdo deles) e devolve os backups.
   - **Conflitos:** a instalação planeja tudo antes de mexer em qualquer coisa. Se um backup já ocupar o lugar, ou se no `--undo` o destino não for mais um link deste repositório e houver backup, o comando sai com **código 2** e nada é alterado; a mensagem diz o que mover.
   - **Pasta do Claude:** `--claude-dir <pasta>`, senão `CLAUDE_CONFIG_DIR`, senão `~/.claude`. Os testes usam sempre uma pasta temporária.

3. **Conferir:** abra o painel (`npm start`), rode `/especificar` num repositório de teste e acompanhe o item em `http://127.0.0.1:4777/#items/<projeto>/<número>`: ele aparece em Especificação depois da spec e passa para Implementação depois dos tickets.

### Onde ficam os dados (modelo antigo)

Tudo é lido de uma pasta raiz, o `MAESTRO_DIR`. Sem a variável, a raiz é **a própria pasta do repositório** (a pasta acima de `panel/` e de `bin/`). O jeito mais simples é clonar o repositório como `_maestro/` dentro da pasta do seu workspace:

```
<seu-workspace>/
  _maestro/            ← este repositório (MAESTRO_DIR)
    bin/  panel/
    registro/agentes.json
    logs/  state/  estado/   ← criados pelos scripts e pelos hooks
```

Os dados (`registro/`, `logs/`, `state/`, `estado/`, `.segredos/`) ficam fora do git pelo `.gitignore`. `registro/`, `logs/eventos/` e `estado/` são do modelo antigo (Cérebro), com nomes e campos em português, e saem na #18; o que sobrevive (log bruto, sessões, uso) grava em inglês em `logs/raw/` e `state/`. Se preferir os dados em outro lugar, aponte `MAESTRO_DIR` para lá, no servidor e no ambiente dos agentes.

| No painel | Arquivo (dentro do `MAESTRO_DIR`) | Quem grava |
|---|---|---|
| agentes, cores, modelo, skills | `registro/agentes.json` | você (à mão ou por um agente) |
| log de eventos, fluxos, modal | `logs/eventos/AAAA-MM.jsonl` | `bin/registrar.js` |
| títulos dos fluxos | `estado/contador-fluxos.json` | `bin/registrar.js novo-fluxo` |
| comandos brutos, saúde dos hooks | `logs/raw/<agente>/AAAA-MM-DD.jsonl` | `bin/hook-log.js` (hook do Claude Code) |
| pendências do dono | `estado/pendencias.json` | `bin/pendencia.js` (e o painel, ao responder) |
| uso do Claude | `state/usage.json` | `bin/collect-usage.js` (o servidor roda sozinho) |

Arquivo ausente não quebra nada: a parte correspondente aparece vazia, com o motivo. A API é em inglês (rotas, campos e variáveis) e nunca devolve frases: motivos, avisos e erros vêm como códigos `{code, ...params}` que a página traduz (ADR 0004). O formato completo de cada arquivo está nos mocks (`panel/tests/mock-state.json` e `mock-details.json`) e o `panel/tests/build-mock-root.js` mostra em que arquivo cada parte vai. A documentação técnica do servidor (rotas, filtros, saúde, uso, variáveis) está em [`panel/README.md`](panel/README.md).

### 1. Cadastre os agentes

`registro/agentes.json`, no mínimo:

```json
{
  "workspace": { "id": null, "nome": "Meu workspace", "raiz": null },
  "agentes": [
    {
      "slug": "cerebro", "nome": "Cérebro Principal", "tipo": "maestro", "cor": "#E8C547",
      "responsabilidade": "Recebe os pedidos do dono, roteia e valida",
      "terminal_id": null, "diretorios": [], "modelo": "claude-opus-5-5", "nivel": "xhigh",
      "conectado_a": ["coordenador"], "skills": [], "status": "ativo"
    },
    {
      "slug": "coordenador", "nome": "Coordenador de Dependências", "tipo": "sub-cerebro", "cor": "#4F6BFF",
      "responsabilidade": "Audita as dependências dos projetos",
      "terminal_id": null, "diretorios": [], "modelo": "claude-opus-5-5", "nivel": "high",
      "conectado_a": ["cerebro"], "skills": [], "status": "ativo"
    }
  ]
}
```

O hook descobre qual agente está rodando pelo `terminal_id` (o id do terminal no Maestri, que chega na variável `MAESTRI_TERMINAL_ID`) ou pelos `diretorios` (a pasta de trabalho do agente). O `workspace.id` é o id do workspace no Maestri (`MAESTRI_WORKSPACE_ID`); com ele preenchido, sessões de outros workspaces são ignoradas. Um agente com `status: "ativo"` e sem log bruto há mais de 24 h deixa o selo amarelo.

### 2. Registre eventos e pendências

Os agentes chamam estes comandos (as instruções de cada agente devem dizer quando):

```
node bin/registrar.js novo-fluxo --titulo "Auditar as dependências" --agente cerebro
node bin/registrar.js evento --agente cerebro --fluxo F-20261009-0001 --origem dono-direto \
  --tipo pedido-recebido --resumo "Pedido para auditar as dependências" --resultado em-andamento
node bin/registrar.js evento --agente cerebro --fluxo F-20261009-0001 --origem cerebro \
  --tipo delegacao --resumo "Pedi a auditoria ao Coordenador" --direcao "As dependências são do Coordenador" --resultado ok
node bin/pendencia.js abrir --agente cerebro --fluxo F-20261009-0001 --tipo decisao --severidade alta \
  --titulo "Remover o pacote antigo?" --contexto "..." --opcao "A: remover" --opcao "B: manter" \
  --recomendacao "A: nenhum arquivo importa o pacote há 30 dias"
```

Dentro de uma sessão do Claude Code com o hook instalado, `--agente` e `--fluxo` podem ser omitidos: o agente sai do cadastro e o fluxo, da sessão. Texto com aspas ou acentos vai melhor em JSON pela entrada padrão (`--json -`). Todas as opções: `node bin/registrar.js --help` e `node bin/pendencia.js --help`.

### 3. Instale o hook do Claude Code

O `bin/hook-log.js` lê o evento do hook pela entrada padrão e grava uma linha no log bruto do agente. Ele nunca escreve no stdout nem no stderr, sai sempre com 0, desiste em cerca de 1,5 s, trunca entradas e saídas e redige segredos. Exemplo para o `settings.json` do Claude Code (troque o caminho):

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook-log.js" }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook-log.js" }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook-log.js" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook-log.js" }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook-log.js" }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook-log.js" }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node /caminho/para/_maestro/bin/hook-log.js" }] }]
  }
}
```

O hook entende esses sete eventos; se a sua versão do Claude Code não tiver algum deles, deixe-o de fora. Ele só grava sessões do workspace: as que rodam dentro da pasta que contém o `MAESTRO_DIR` ou num terminal do Maestri com o mesmo `workspace.id`. As outras saem em poucos milissegundos, sem gravar nada. Ele também grava `state/sessions/<session_id>.json`, que é o que permite atribuir o consumo de tokens a cada agente.

### 4. Suba o painel

```
node panel/server.js            # ou: npm start
```

Abra **http://127.0.0.1:4777** (use `127.0.0.1`, não `localhost`). Outra porta: `--port 4780` ou a variável `PANEL_PORT`. O servidor grava o PID em `state/panel.pid` e roda o coletor de uso ao subir e a cada 5 minutos.

Sobre o uso do Claude:
- a **participação de cada agente** vem das transcrições locais do Claude Code (`~/.claude`, ou `CLAUDE_CONFIG_DIR`), só das sessões que o hook atribuiu a um agente;
- o **% do plano** (5 h e semanal) vem do arquivo que o Maestri grava em `~/.maestri/usage/providers/.status.json` (ou `MAESTRI_DATA_DIR`). Fora do Maestri, essa parte aparece como indisponível, com o motivo.

Quando o dono responde uma pendência pelo painel, o servidor pode avisar o Cérebro no terminal dele pela CLI do Maestri (`maestri ask`). Isso liga sozinho só quando o servidor roda dentro de um terminal do Maestri; `PANEL_NOTIFY_BRAIN=0` desliga e `1` força.

**Verificador de merge (#11).** Para os itens com PR pronto e ainda não mergeado, o servidor consulta o PR na subida e a cada 10 min (`PANEL_MERGE_CHECK_SECONDS`), só leitura: GitHub pelo `gh pr view`, Azure DevOps pela REST com o token do `az account get-access-token`. Merge confirmado vira evento (origem "painel") e leva o item para Merge; uma falha aparece na página do item e no selo de saúde, e o botão **Marcar como mergeado** resolve à mão. `PANEL_MERGE_CHECK=0` desliga (e `=1` liga mesmo com `PANEL_COLLECTOR=0`); `PANEL_GH_CLI`, `PANEL_AZ_CLI` e `PANEL_AZURE_DEVOPS_URL` trocam os executáveis e a base da REST. Detalhes em `panel/README.md`.

### Variáveis de ambiente (nomes novos)

As variáveis passaram para o inglês (#3). Quem tinha as antigas no ambiente precisa trocar:

| Nome novo | Nome antigo |
|---|---|
| `PANEL_PORT` | `PAINEL_PORTA` |
| `PANEL_COLLECTOR` | `PAINEL_COLETOR` |
| `PANEL_INDEX` | `PAINEL_INDEX` |
| `PANEL_NOW` | `PAINEL_AGORA` |
| `PANEL_NOTIFY_BRAIN` | `PAINEL_AVISAR_CEREBRO` |
| `PANEL_MAESTRI_CLI` | `PAINEL_MAESTRI_CLI` |
| `MAESTRO_NOW` | `MAESTRO_AGORA` |
| `MAESTRO_LOCK` | `MAESTRO_TRAVA` |
| `MAESTRO_LOCK_WAIT_MS` | `MAESTRO_TRAVA_ESPERA_MS` |
| `MOCK_PORT` | `MOCK_PORTA` |
| `KEEP_TMP` | `MANTER_TMP` |
| `HEAVY_TEST` | `TESTE_PESADO` |

`MAESTRO_DIR`, `MAESTRI_DATA_DIR`, `CLAUDE_CONFIG_DIR` e `MAESTRI_CLI` não mudaram. O que cada uma faz está em [`panel/README.md`](panel/README.md#variáveis-de-ambiente). Também mudaram a opção `--porta` (agora `--port`), o cabeçalho `X-Painel` (agora `X-Panel`) e os nomes dos scripts de `bin/` (o hook agora é `bin/hook-log.js`: atualize o `settings.json` do Claude Code).

## Scripts de `bin/`

Todos usam só a biblioteca padrão do Node e respeitam `MAESTRO_DIR` (o `flow.js` precisa do Node 22.13+, pelo `node:sqlite`).

| Script | Para que serve |
|---|---|
| `flow.js` | **modelo novo**: `item start`, `stage`, `pr`, `final-adjustment`, `hml`, `item done`, `task graph`/`dispatch`/`integrate` e `status` gravam os eventos de um item e das tasks dele no `maestro.db` (veja [Modelo novo](#modelo-novo-itens-o-cli-flow-e-o-maestrodb)) |
| `install-skills.js` | liga as skills do dono declaradas em `skills/links.json` ao `~/.claude`, com backup e `--undo` (veja [Instalar as skills](#instalar-as-skills-do-dono-painel_maestro-e-install-skillsjs)) |
| `flow-store.js`, `flow-projection.js`, `flow-repo.js`, `i18n/` | banco do modelo novo (`node:sqlite`, WAL, migrações), projeção pura do estado do item, projeto pelo `git remote origin` e o dicionário pt-BR do CLI |
| `registrar.js` | log semântico: `novo-fluxo`, `evento`, `ultimos`, `fluxo` |
| `pendencia.js` | fila de pendências do dono: `abrir`, `listar`, `mostrar`, `responder`, `resolver`, `cancelar` |
| `hook-log.js` | hook do Claude Code que grava o log bruto e o estado das sessões |
| `collect-usage.js` | coletor de uso do Claude (`--json`, `--no-write`); o servidor já o chama |
| `time-window.js` | sai 0 dentro de uma faixa de horário e 1 fora (`node bin/time-window.js 8 22`), útil como pré-condição de rotinas agendadas |
| `lib.js` | funções comuns: caminhos, datas no fuso de São Paulo, trava entre processos, gravação atômica de JSON, JSONL, redação de segredos |

Quase todos aceitam `--help` (o `time-window.js` não: ele só recebe início e fim). Os horários e datas usam o fuso `America/Sao_Paulo`.

## Segurança

- O servidor escuta **só em 127.0.0.1**. O cabeçalho `Host` precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>`; qualquer outro recebe 403 (proteção contra DNS rebinding).
- Todo `POST` exige o cabeçalho **`X-Panel: 1`** e, se vier `Origin`, ele precisa ser o próprio painel; senão, 403. Outra página aberta no navegador não consegue acionar o servidor. Os corpos JSON vão até 16 KB (acima disso, 413).
- Nenhum cabeçalho CORS. Só existem `/` e `/api/*`; nenhum arquivo é servido pelo nome (o resto é 404).
- Toda resposta leva `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY`. A página leva uma **Content-Security-Policy** que bloqueia qualquer recurso externo e impede que outro site a embuta num iframe.
- A página é um arquivo único (JS, CSS e fonte embutidos). Todo texto vindo da API entra como texto, nunca como HTML; a página não tem links para fora.
- **Sem dependências** no servidor e nos scripts: só a biblioteca padrão do Node. O servidor não faz nenhuma requisição para fora da máquina. As dependências npm (Preact, Vite, a fonte Manrope e os ícones Lucide) servem só para compilar a página.

Não exponha a porta do painel na rede: ele não tem login e foi feito para uso local.

## Compilar a página

A fonte da página fica em `panel/ui/` (Preact, compilado pelo Vite num HTML único). O resultado, `panel/index.html`, é versionado; só é preciso compilar se você mudar a fonte. O Vite 8 pede Node 20.19+ ou 22.12+.

```
cd panel/ui
npm ci
npm run build      # vite build + scripts/publish.js, que grava ../index.html
npm run check      # confere o index.html: um único script, nada externo
npm run dev        # http://127.0.0.1:5173, com /api apontando para o painel em 127.0.0.1:4777
```

Da raiz do repositório, `npm run build` faz o mesmo que o `npm run build` dentro de `panel/ui` (depois do `npm ci` lá). Com `npm run dev`, abra `http://127.0.0.1:5173/?mock=1` para usar os dados de teste sem servidor. Depois de compilar, rode os testes. Como acrescentar uma tela nova está em [`panel/README.md`](panel/README.md#a-página-indexhtml-fonte-em-ui).

## Testes

```
npm test                                   # node panel/tests/run-all.js
node panel/tests/run-all.js server       # só os arquivos com "server" no nome
```

Os testes não usam framework nem navegador. Cada arquivo monta uma raiz falsa em `panel/tests/tmp/` e aponta `MAESTRO_DIR`, `MAESTRI_DATA_DIR` e `CLAUDE_CONFIG_DIR` para ela, sobe servidores só nas portas 4790 a 4799 e apaga tudo no fim (`KEEP_TMP=1` guarda para inspeção). O teste das pendências e o das tasks usam uma CLI do Maestri falsa, que só grava os argumentos. São 12 arquivos: coletor de uso, modelo novo (`test-flow.js`, `test-flow-tasks.js` e `test-flow-delivery.js`, PR, ajuste final, HML e conclusão), hook do log bruto, dicionário, desempenho (50 mil eventos e log bruto grande), página compilada, instalador das skills (`test-install-skills.js`, sempre numa pasta do Claude temporária), filtro de horário, pendências e servidor. Eles conferem códigos, não frases. O `test-flow.js`, o `test-flow-tasks.js` e o `test-flow-delivery.js` seguem uma regra só: o CLI `flow` roda como processo dentro de repositórios git temporários com `remote origin` fictício (e um worktree), grava num `maestro.db` temporário e o resultado é conferido só pela API do servidor, inclusive com 12 processos gravando ao mesmo tempo; nenhum teste lê o banco.

Para regerar os dados da demonstração: `node panel/tests/generate-mock.js` e, para os itens, `node panel/tests/generate-mock-items.js` (usa a mesma projeção do servidor).

## Estrutura

```
painel-maestro/
├── bin/                      scripts de linha de comando (só biblioteca padrão do Node)
│   ├── flow.js               modelo novo: CLI que grava os eventos de cada item no maestro.db
│   ├── flow-store.js         maestro.db (node:sqlite, WAL, esquema e migrações)
│   ├── flow-projection.js    estado do item calculado dos eventos (função pura)
│   ├── flow-repo.js          projeto pelo git remote origin
│   ├── install-skills.js     liga as skills do dono ao ~/.claude (backup e --undo)
│   ├── i18n/                 dicionário pt-BR das mensagens do CLI
│   ├── registrar.js          log de eventos e fluxos
│   ├── pendencia.js          fila de pendências do dono
│   ├── hook-log.js           hook do Claude Code → log bruto
│   ├── collect-usage.js      uso do plano e tokens por agente
│   ├── time-window.js        filtro de horário para rotinas
│   └── lib.js                biblioteca comum
├── panel/
│   ├── server.js             servidor HTTP e API (em inglês, devolve códigos)
│   ├── api-items.js          itens do modelo novo (/api/items)
│   ├── merge-check.js        verificador de merge do PR (gh / REST do Azure DevOps) e "marcar como mergeado"
│   ├── legacy-records.js     nomes em inglês para os registros do modelo antigo
│   ├── api-pendencias.js     resposta de pendência pelo painel
│   ├── index.html            a página compilada (não edite à mão)
│   ├── README.md             documentação técnica do servidor e da página
│   ├── ui/                   fonte da página (Preact + Vite)
│   │   ├── src/app/          casca, menu e topo
│   │   ├── src/screens/      uma tela por arquivo
│   │   ├── src/components/   cartões, KPIs, gráficos em SVG, modal
│   │   ├── src/data/         API, modo de teste, consultas e formatação (datas e números no padrão brasileiro)
│   │   ├── src/i18n/         dicionário pt-BR (todo texto da página) e o idioma ativo
│   │   ├── src/styles/       CSS por tela
│   │   └── scripts/publish.js   junta o build num HTML único
│   └── tests/                testes, mocks e servidores de demonstração
├── skills/
│   ├── links.json            skills do dono que o install-skills.js liga ao ~/.claude
│   ├── especificar/          /especificar: grill → spec → tickets, gravando as etapas no painel
│   ├── cerebro/              orquestracao, pendencias, painel, onboarding-agente
│   └── compartilhadas/       protocolo-delegacao, registro-eventos
├── conhecimento/protocolos/  delegação, pendências, registro, autonomia
├── exemplos/                 CLAUDE.md (regra comum) e responsabilidade-cerebro.md
├── package.json
├── LICENSE
└── README.md
```

## Requisitos e limites

- Node.js 22.13 ou mais novo para o servidor e o `flow.js` (o `node:sqlite` do modelo novo; desenvolvido e testado no Node 22.23); os scripts do modelo antigo rodam no Node 18+; Node 20.19+ ou 22.12+ para compilar a página.
- Desenvolvido e testado no Windows. Os caminhos e a trava entre processos têm tratamento para outros sistemas, mas eles não foram testados.
- O painel só lê arquivos: quem mantém os dados em dia são os seus agentes.
- O botão de conversar com o Cérebro pelo painel ainda não existe (`POST /api/brain` responde 501).
- O painel saiu de um workspace maior. Alguns comentários do código citam scripts e documentos desse workspace que não vêm neste repositório: eles só produzem os arquivos que o painel lê, e o formato desses arquivos está descrito acima.

## Skills e protocolos do workspace

Além do painel, o repositório traz o método que os agentes seguem, em texto. São **modelos para adaptar**: copie, troque nomes, projetos e regras pelos do seu workspace e mantenha o que servir. Os caminhos citados são relativos à raiz do repositório (o `MAESTRO_DIR`); arquivos como `registro/agentes.md` e `registro/roteamento.md` são do workspace de quem usar e não vêm aqui.

- **`skills/cerebro/`**, skills do agente principal (Cérebro):
  - `orquestracao`: classificar cada pedido do dono, achar quem responde por ele, delegar, acompanhar, validar e responder (resultado, o que precisa do dono, detalhes);
  - `pendencias`: a fila de decisões do dono, do jeito de escrever (contexto, opções, recomendação) até devolver a decisão a quem pediu e fechar;
  - `painel`: manter este painel no ar e com dado fresco;
  - `onboarding-agente`: criar um sub-agente novo para um domínio e ligá-lo ao resto.
- **`skills/compartilhadas/`**, para todos os agentes:
  - `protocolo-delegacao`: os envelopes [PEDIDO], [RESPOSTA], [AVISO] e [COBRANÇA], o fluxo `F-AAAAMMDD-NNNN` e como mandar com `maestri ask` sem perder nem duplicar pedido;
  - `registro-eventos`: como gravar cada evento com `bin/registrar.js` (tipo, resumo, direção, resultado) e quando abrir pendência com `bin/pendencia.js`.
- **`conhecimento/protocolos/`**: as regras por trás das skills, em quatro arquivos: delegação, pendências, registro e autonomia (o que cada agente faz sozinho, o que propõe e o que é sempre do dono).
- **`exemplos/`**: `CLAUDE.md`, a regra comum de todos os agentes do workspace, e `responsabilidade-cerebro.md`, o papel do agente principal.

As skills seguem o formato de skill do Claude Code (pasta com `SKILL.md` e cabeçalho `name`/`description`). Para usá-las, copie ou ligue as pastas em `.claude/skills/` do workspace. As skills do dono do modelo novo (`skills/especificar/` e as que vierem) são outra coisa: estão declaradas em `skills/links.json` e são ligadas pelo `bin/install-skills.js` (veja [Instalar as skills](#instalar-as-skills-do-dono-painel_maestro-e-install-skillsjs)).

## Licença

[MIT](LICENSE).

**Terceiros** (embutidos no `panel/index.html` compilado):
- [Preact](https://preactjs.com) · licença MIT.
- [Lucide](https://lucide.dev) (`lucide-preact`, ícones) · licença ISC.
- Fonte [Manrope](https://github.com/sharanda/manrope) · SIL Open Font License 1.1 (Copyright 2019 The Manrope Project Authors).
