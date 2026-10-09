# Painel do workspace

Painel local de um workspace multiagente (Maestri + Claude Code). Um servidor Node.js só com a biblioteca padrão (`server.js`) serve a página (`index.html`) e uma API JSON em inglês que lê, a cada requisição, os arquivos do `MAESTRO_DIR`. Não usa IA nem gasta tokens.

| Arquivo | O que é |
|---|---|
| `panel/server.js` | servidor HTTP e API (Node 22, CommonJS, sem dependências) |
| `panel/ui/` | **fonte da página**: app Preact com identidade visual própria (telas, componentes, gráficos em SVG). O build gera o `index.html` |
| `panel/index.html` | a página compilada (arquivo único, sem nada externo; não edite à mão: rode o build do `ui/`) |
| `panel/api-items.js` | itens do modelo novo: lê os eventos do `maestro.db` (`bin/flow-store.js`) e calcula cada item pela projeção pura (`bin/flow-projection.js`) |
| `panel/api-pendencias.js` | resposta de pendência pelo painel: grava pelo `pendencia.js responder` e avisa o Cérebro (`maestri ask`) |
| `bin/collect-usage.js` | coletor de uso do Claude, chamado pelo servidor e pela linha de comando |
| `bin/time-window.js` | filtro de horário para o `--pre-run` das rotinas |
| `panel/tests/` | testes sem framework (`run-all.js`) |

## Subir

Num terminal comum (no Maestri, um terminal shell no canvas, não um agente), na raiz do repositório:

```
node panel/server.js
```

Ele imprime `Painel no ar em http://127.0.0.1:4777 (PID 12345)`, grava o PID em `state/panel.pid` (dentro do `MAESTRO_DIR`) e roda o coletor de uso na hora e depois a cada 5 minutos (no próprio processo, sem travar as requisições). Abra `http://127.0.0.1:4777` no navegador ou num portal do Maestri (use `127.0.0.1`, não `localhost`). A página se atualiza sozinha a cada 20 segundos.

Outra porta: `--port 4780` ou a variável `PANEL_PORT` (o `--port` vale mais).

## Parar

- **Ctrl+C** no terminal do servidor. Ele apaga o `state/panel.pid` ao sair.
- **PowerShell:** `Stop-Process -Id (Get-Content state/panel.pid)`
- **cmd:** `taskkill /PID <pid de state/panel.pid> /F`
- **Git Bash:** `taskkill //PID $(cat state/panel.pid) //F`. No Git Bash, `kill $!` não derruba o node (o `$!` é o PID do MSYS, não o do Windows).

Com `taskkill /F` o processo morre sem chance de limpar, então o `panel.pid` antigo fica no disco. Isso não atrapalha: a próxima subida grava o PID novo por cima.

## Portas e segurança

- **4777** é a porta padrão do painel. Os testes usam só **4790 a 4799**.
- Escuta **só em 127.0.0.1**: outros endereços de rede da máquina não alcançam o painel.
- O cabeçalho `Host` precisa ser exatamente `127.0.0.1:<porta>` ou `localhost:<porta>`; qualquer outro recebe **403** (protege contra DNS rebinding).
- `POST` só com o cabeçalho `X-Panel: 1` (e, se vier `Origin`, ele precisa ser o próprio painel); senão **403**. Outra página aberta no navegador não consegue acionar o servidor.
- Nenhum cabeçalho CORS. Só existem `/` e `/api/*`: qualquer outro caminho (inclusive `/index.html`, `/../` e afins) é **404**. Nenhum arquivo é servido pelo nome.
- Toda resposta leva `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY`; o HTML leva uma `Content-Security-Policy` que bloqueia qualquer recurso externo (a página é um arquivo único) e, com `frame-ancestors 'none'`, impede que outro site embuta o painel num iframe para induzir cliques (clickjacking no Recalcular, por exemplo).

## Rotas

| Rota | Devolve |
|---|---|
| `GET /` | o `index.html` (503 com aviso se o arquivo não existir) |
| `GET /api/state` | tudo da tela inicial: `generated_at`, `workspace`, `health`, `kpis` (`pending_decisions` e `usage`), `agents`, `pending_decisions`, `usage`, `events` (+ `collector`, `answers` e `warnings`) |
| `GET /api/events?since=&until=&hours=&agent=&project=&type=&result=&q=&owner_only=1&include_tests=1&flow=&page=1&per_page=50` | `{total, page, per_page, pages, events, counts}` de todos os meses, mais recente primeiro. `counts` = `{result, agent, project, type, needs_owner}` do conjunto filtrado, sem paginação; cada faceta ignora o próprio filtro (os chips mostram o que dá para escolher) e `needs_owner` ignora o `owner_only` |
| `GET /api/event/<id>` | `{event, flow, initial_request, sequence, raw_commands, raw_commands_truncated, raw_commands_omitted, raw_commands_warnings, window_without_flow, previous_id, next_id}`; 404 se não existir |
| `GET /api/flow/<id>` | `{flow, events, raw_commands, raw_commands_truncated, raw_commands_omitted, raw_commands_warnings, initial_request}`; `?include_tests=1` traz os eventos de teste |
| `GET /api/items` | modelo novo: `{items}`, um por item com evento `item-started`, o mais recente primeiro. Cada item: `{key, project: {id, name, tracker, company: {id, name}}, number, tracker, tracker_ref, title, stage, stage_since, started_at, updated_at}`. `key` é `<projeto>/<número>`; `tracker` é `github` ou `azure_devops`; `tracker_ref` é o número como no tracker (`#12`, `PBI 3100`). Sem `maestro.db` ainda: `{items: []}` (o servidor não cria o banco) |
| `GET /api/items/<projeto>/<número>` | `{item}`: os mesmos campos, mais `stages` (`[{id, status: done\|current\|pending, entered_at}]`, as etapas do projeto em ordem) e `timeline` (`[{id, at, type, task_number, agent: {role, name}, source, payload}]`, todos os eventos do item em ordem). 404 `item_not_found` (`{project, number}`) se o item não existe; endereço fora do formato (projeto `[a-z0-9-]`, número inteiro sem zero à esquerda) → 404 `route_not_found` |
| `POST /api/recalculate` | roda o coletor de uso e devolve o mesmo corpo de `/api/state` (+ `recalculation`) |
| `POST /api/brain` | 501: reservado para uma fase futura (conversa com o Cérebro pelo painel) |
| `POST /api/pending-decisions/<P-NNNN>/answer` | corpo `{"option": "A", "text": "..."}` (pelo menos um; texto até 2000 caracteres): grava a resposta pelo `pendencia.js responder` (status `respondida`, evento `decisao` no fluxo da pendência) e avisa o Cérebro no terminal dele. Devolve `{ok, pending_decision, brain_notice: {sent, to \| reason}}`; 409 se a pendência não estiver aberta, 404 se não existir, 400 para corpo ou opção inválidos |

**Códigos em vez de frases (ADR 0004).** Nenhuma resposta traz frase pronta: motivos de saúde, avisos, notas, bases de período e erros vêm como `{code, ...params}` (ex.: `{"code": "hook_stale", "agent": "b", "name": "Agente B", "minutes": 1500}`) e a página traduz. Erros sempre no formato `{"error": {code, ...params}}` (ex.: `{"error": {"code": "event_not_found", "id": "EV-…"}}`, `{"error": {"code": "invalid_param", "param": "since", "value": "lixo", "expected": "date"}}`). Os registros do modelo antigo (eventos de `bin/registrar.js` e pendências de `bin/pendencia.js`) saem com os nomes de campo em inglês (`panel/legacy-records.js`), mas os valores guardados (tipos, resultados, origens, severidades e status) seguem os do modelo antigo, que sai na #18. A página lê as respostas como vêm e traduz os códigos pelo mesmo dicionário dos textos dela (`ui/src/i18n/pt-BR.js`, seção `codes`).

Detalhes dos filtros de `/api/events`:
- `since` e `until` em `AAAA-MM-DD`, pelo dia de São Paulo (valor inválido → 400). `hours=N` traz só as últimas N horas (o "24 h" do Log).
- `agent`, `project`, `type` e `result` aceitam vários valores separados por vírgula; `project` não diferencia maiúsculas.
- `q` procura no resumo, na direção e no fluxo, sem diferenciar maiúsculas nem acentos; cada palavra precisa aparecer, em qualquer ordem.
- `owner_only=1` traz só `needs_owner: true` ou resultado `falhou`, `bloqueado` ou `aguardando-dono`.
- Eventos com `test: true` só aparecem com `include_tests=1`.
- `per_page` vai até 500.

Correlação do modal: `raw_commands` traz as entradas do log bruto com o mesmo `flow_id` (de todos os agentes, nos dias do fluxo) e, para as entradas sem `flow_id`, as do mesmo agente (e da mesma sessão, quando o evento tem sessão) entre o evento anterior desse agente e o atual (sem evento anterior: desde o início do fluxo, se for antes, ou 15 min antes, como o `registrar fluxo`), limitado às 6 h anteriores. Cada comando diz como foi ligado: `correlation: "flow_id"` ou `"window"`. O `initial_request` ("O que foi pedido") parte do primeiro evento `pedido-recebido` do fluxo: o texto é o do prompt bruto que trouxe o pedido, ou seja, o último `UserPromptSubmit` do mesmo agente (e da mesma sessão, quando o evento tem sessão) entre o evento anterior desse agente e o `pedido-recebido` (no máximo 6 h antes; `source: "event_prompt"`), com a origem do evento. Isso pega o pedido do dono mesmo sem `flow_id` no log bruto (o id só nasce depois do pedido). Sem esse prompt, vale o campo `pedido`/`texto` do evento ou o resumo (`source: "event"`). Sem evento `pedido-recebido`, vem do primeiro prompt bruto que trouxe o id do fluxo (`source: "prompt"`, origem deduzida do envelope: `[ROTINA]`, `[PEDIDO] … De: …`). `previous_id` e `next_id` seguem a ordem do tempo e só apontam para eventos com id válido (eventos sem id em texto ficam fora da lista e contam em `warnings`).

Log bruto grande: cada arquivo do log bruto vira um índice compacto na memória (hora, posição da linha, sessão, `flow_id` e ids citados nos prompts), lido de forma incremental; só as linhas escolhidas são relidas do disco. Numa consulta, o servidor lê no máximo 160 MB novos do log bruto: o que não couber fica para a próxima vez e a resposta sai com `raw_commands_truncated: true` e o motivo em `raw_commands_warnings` (código `raw_files_pending`; o modal mostra "Leitura parcial do log bruto"). Acima de 1500 comandos ficam os mais próximos do evento (`raw_commands_omitted` diz quantos saíram). Fluxo com mais de 62 dias: entram a véspera e o 1º dia (pedido inicial) e os 60 dias mais recentes; o meio sai, com aviso (`long_flow_days_cut`).

## A página (`index.html`, fonte em `ui/`)

App Preact (a API do React em 4 KB) com componentes próprios e gráficos em SVG desenhados no código, compilado pelo Vite num **arquivo único**: o JS, o CSS e a fonte Manrope 300/400 (subconjunto latino, como `data:`) vão dentro do HTML. Nada externo, então a CSP do servidor continua a mesma. Medido para um portal do canvas de **1520 × 1095**: nenhuma tela rola a página; listas e tabelas rolam por dentro dos cartões.

**Identidade visual:** fundo `#000`, cartões `#101010` com borda `1px #242424` e raio 14px, texto `#F5F5F5`, secundário `#888`, azul `#0000FF` só como acento (`#4F6BFF` quando é texto), rótulos em caixa alta com `.3em`, ícones Lucide com traço 1,75, sem emoji e sem gradiente. As cores ficam em variáveis no topo de `ui/src/styles/base.css`.

**Menu = telas.** Toda tela nova é um item do menu, nunca uma página separada:
1. um item em `SCREENS` (`ui/src/data/context.js`), com `id` e `group` (hoje só `workspace`; um bloco novo do menu é um item novo em `GROUPS`, no mesmo arquivo), e o nome no menu e o título no dicionário (`nav.<id>` e `screens.<id>` em `ui/src/i18n/pt-BR.js`);
2. um componente em `SCREEN_COMPONENTS` (`ui/src/app/App.jsx`) e um ícone em `ICONS` (`ui/src/app/Sidebar.jsx`);
3. a tela em `ui/src/screens/<Name>.jsx`, com o CSS dela em `ui/src/styles/<name>.css`, importado pela própria tela.
A tela fica em `#<id>` na URL (com sub-abas, `#<id>/<sub>`: o App entrega a sub-aba em `subrota`); as setas ↑ ↓ com o foco no menu passam de uma tela para outra, de um grupo para o outro.

**Componentes prontos** (`ui/src/components/`): `Card` (com `label`, `info`, `actions`, `scroll`), `Kpi` (número grande, `info`, `highlight`, clicável), `InfoHint` (ícone (i) com balão; é onde vão os textos explicativos, nunca dentro do cartão), `Badge`, `Segmented`, `Meter`, `Ring`, `Modal`, `Empty`, `Collapsible`, `Skeleton`; gráficos em `charts.jsx` (barras empilhadas, linhas, rosca, barrinha de 7 dias); campos de filtro em `fields.jsx`.

**Textos (ADR 0004).** O código da página é em inglês (identificadores, arquivos, classes CSS e comentários) e nenhum texto visível fica escrito em componente ou tela: tudo vem do dicionário `ui/src/i18n/pt-BR.js`, pela função `t(chave, parâmetros)` de `ui/src/i18n/index.js` (ex.: `t('log.page', { page: 2, pages: 7 })` → "Página 2 de 7"). Uma entrada é um texto com `{parâmetro}`, um plural `{ one, other }` escolhido por `count` (que sai formatado como número) ou uma função, quando o texto precisa de lógica. Os códigos do servidor ficam na seção `codes` e saem por `translateCode(código)`; `txt(valor)` (`ui/src/data/format.js`) mostra qualquer valor da API, traduzindo o que for código. O idioma ativo é um ponto só, `ui/src/i18n/locale.js` (fixo em `pt-BR`), que também decide o formato de datas e números (padrão brasileiro). Acrescentar o inglês é escrever outro dicionário com as mesmas chaves e registrá-lo em `index.js`. Os endereços antigos das telas (`#visao`, `#pendencias`, `#agentes`, `#uso`) continuam abrindo a tela certa.

**Telas** (o menu tem um grupo, Workspace):
- **Itens** (modelo novo, `ui/src/screens/Items.jsx`): a lista (`GET /api/items`: item como no tracker, título, etapa, projeto e empresa, última mudança; clique ou Enter abre o item) e a **página do item** em `#items/<projeto>/<número>` (`GET /api/items/<projeto>/<número>`): número, projeto, tracker, título, a etapa atual e desde quando, as etapas do fluxo (concluídas, atual, a seguir) e a linha do tempo. Esse endereço é fixo: é o que o portal do Maestri abre (`http://127.0.0.1:4777/#items/cidax/3100`). A tela relê a cada 20 s enquanto está aberta. Os nomes das etapas, papéis e trackers vêm do dicionário (`items.*`).
- **Visão geral:** números do topo (pendências por severidade, uso 5 h e semanal, eventos de hoje), atividade de 7 dias por agente, resultados de 7 dias, último evento de cada agente e atividade recente.
- **Pendências:** números no topo (abertas, por severidade, respondidas, fechadas, a mais antiga; clicar filtra), lista, a pendência e a **resposta**: opção (a recomendada vem marcada) + comentário, Ctrl+Enter envia (`POST /api/pending-decisions/<id>/answer`). A resposta fica gravada na pendência e vai ao terminal do Cérebro; depois a próxima aberta já aparece.
- **Log:** cartões por resultado no topo (clicar filtra), busca (atalho "/"), período em botões, agentes e projetos como chips com contagem, tipo, "só o que precisa de mim", testes e filtros ativos com x; tabela com 50 por página.
- **Modal do evento** (clique ou Enter na linha): pedido, direção, passos, comandos e validação; ← (mais recente) e → (mais antigo) seguem a tabela filtrada.
- **Agentes:** um cartão resumido por agente (último evento, eventos hoje, fluxos abertos, consumo, 7 dias) e a ficha completa num modal (← → trocam de agente), mais resultados de 7 dias e o log bruto de cada um.
- **Uso:** plano (5 h e semanal, com reinício), participação por agente em três períodos e a tabela de tokens.

Consulta `/api/state` a cada 20 s; a tela, os filtros, o modal e o que está aberto continuam como estavam. Se o servidor não responder, uma faixa vermelha avisa e a tela fica com a última leitura boa. Todo texto da API entra como texto (o Preact nunca monta HTML a partir de texto); a página não tem links para fora.

**Mexer na página:**
```
cd panel/ui
npm run dev      # http://127.0.0.1:5173, com /api apontando para o painel real (4777); ?mock=1 usa os dados de teste
npm run build    # compila e grava ../index.html (scripts/publish.js junta tudo num arquivo só)
npm run check    # confere o ../index.html (um único script, nada externo)
```
Depois do build, a página nova aparece no próximo carregamento (o servidor lê o `index.html` a cada pedido); reinicie o servidor só quando mudar o `server.js` ou os `api-*.js`.

### Modo de teste (`?mock=1`)

Para mexer na página sem servidor nem dados reais: `node panel/tests/serve-mock.js` (porta 4795; aceita 4790–4799) e abra `http://127.0.0.1:4795/?mock=1`. A página lê `tests/mock-state.json` (resposta de `/api/state`), `tests/mock-details.json` (eventos completos, comandos brutos e fluxos) e `tests/mock-items.json` (respostas de `/api/items` e `/api/items/<projeto>/<número>`: Contoso, Fabrikam, Pessoal e "Sem empresa", projetos GitHub e Azure DevOps e itens em todas as etapas) e imita `/api/events`, `/api/event/<id>`, `/api/flow/<id>` e as rotas de itens no próprio navegador. O `tests/generate-mock-items.js` regrava o `mock-items.json` passando eventos fictícios pelo próprio `api-items.js` (a mesma projeção do servidor). Uma faixa azul avisa que os dados são fictícios. `tests/generate-mock.js` regrava os dois arquivos. Em produção (sem `?mock=1`) nada disso é usado, e o servidor real nem serve `/tests/...` (404).

Para ver a página com o **servidor de verdade** sobre os mesmos dados: `node tests/build-mock-root.js [pasta em tests/tmp] [--hostile]` monta uma raiz falsa de dados (`MAESTRO_DIR`) e imprime a linha para subir o `server.js` nela (porta de teste, relógio fixo, coletor desligado). `--hostile` acrescenta evento e pendência com HTML e `javascript:` para conferir que tudo aparece como texto.

Exemplo completo (Git Bash), da raiz do repositório: `node panel/tests/build-mock-root.js` e depois `R=panel/tests/tmp/mock-root; MAESTRO_DIR=$R MAESTRI_DATA_DIR=$R/maestri CLAUDE_CONFIG_DIR=$R/claude PANEL_NOW=2026-10-09T10:24:30-03:00 PANEL_COLLECTOR=0 node panel/server.js --port 4793`; derrube com Ctrl+C (ou `taskkill //PID <pid> //F`; como o `taskkill /F` não deixa o servidor se despedir, o `state/panel.pid` da raiz falsa fica para trás, e o próximo início o regrava).

## De onde vem cada dado

| No painel | Arquivo (em `MAESTRO_DIR`) | Quem grava |
|---|---|---|
| itens, etapas, linha do tempo (modelo novo) | `maestro.db` (padrão `~/.painel-maestro/maestro.db` quando `MAESTRO_DIR` não está definido) | `bin/flow.js` |
| agentes, cores, modelo, nível, skills | `registro/agentes.json` (modelo antigo) | Cérebro |
| tabela de log, modal, últimos eventos | `logs/eventos/AAAA-MM.jsonl` (modelo antigo; `/api/state` lê os 2 meses mais recentes; filtros e fluxos leem todos) | `bin/registrar.js` |
| comandos brutos, saúde dos hooks | `logs/raw/<agente>/AAAA-MM-DD.jsonl` (e `.jsonl.gz`) | `bin/hook-log.js` (hooks do Claude Code) |
| pendências do dono | `estado/pendencias.json` (modelo antigo) | `bin/pendencia.js` |
| título do fluxo | `estado/contador-fluxos.json` (modelo antigo) | `registrar novo-fluxo` |
| uso do Claude | `state/usage.json` | `bin/collect-usage.js` |
| % do plano (5 h e semanal) | `~/.maestri/usage/providers/.status.json` (via `usage.json`) | o próprio Maestri |
| consumo por agente | transcrições `~/.claude/projects/…`, atribuídas por `state/sessions/<session_id>.json` (via `usage.json`) | Claude Code + hook (`bin/hook-log.js`) |

Os arquivos marcados como modelo antigo continuam com os nomes e campos em português que os comandos antigos gravam; eles saem na #18. O que sobrevive grava em inglês: a linha do log bruto é `{ts, agent, terminal, session, flow_id?, hook_event, tool?, input?, ok?, output_summary?, error?, duration_ms?, prompt?, detail?, cwd, version?}` e a sessão é `{session_id, agent, terminal, cwd, transcript_path, started_at, seen_at, flow_id, flow_since}`.

A leitura é tolerante: arquivo ausente vira `null` ou lista vazia, linha JSONL quebrada é ignorada (e contada em `warnings`), linha final ainda sendo escrita fica para a próxima leitura, e arquivo preso por outro processo (EPERM/EBUSY no Windows) é lido de novo em seguida. Os JSONL são lidos de forma incremental (só os bytes novos), então a página continua rápida com dezenas de milhares de eventos.

## Modelo novo: `maestro.db`

Gravado pelo `bin/flow.js` (veja o README da raiz) e lido pelo `api-items.js`, pelo `node:sqlite` (Node 22.13+, sem npm; o `ExperimentalWarning` é silenciado em `bin/flow-store.js`). WAL e `busy_timeout` de 15 s: cada gravação é uma transação curta `BEGIN IMMEDIATE`, então vários processos gravam ao mesmo tempo sem perder eventos. A versão do esquema fica em `PRAGMA user_version` e as migrações rodam ao abrir (`MIGRATIONS` em `bin/flow-store.js`). Tabelas:

- `companies(id, name, created_at)`: a "Sem empresa" é `unassigned`.
- `projects(id, name, company_id, tracker, stages, done_state, maestri_workspace, created_at)`: `tracker` `github`/`azure_devops`; `stages` é a lista JSON de etapas que o projeto usa (padrão: as sete).
- `project_repos(remote, project_id)`: o remote normalizado (`github.com/acme/widgets`, `dev.azure.com/org/projeto/_git/repo`) aponta para o projeto; um projeto pode ter vários repositórios.
- `events(id, at, type, project_id, item_number, task_number, agent_role, agent_name, source, payload)`: append-only (gatilhos recusam UPDATE e DELETE), guardada para sempre. Tipos desta fatia: `item-started` (`{title, stage}`) e `stage-changed` (`{stage}`); `source` é `cli`.

O estado de um item nunca é gravado: `projectItem(events, project)` (`bin/flow-projection.js`, função pura) devolve `{number, title, stage, stages, started_at, updated_at, stage_since}` e ignora tipos de evento que ainda não conhece.

## Saúde (selo do cabeçalho)

- **Hooks:** `yellow` se algum agente com `status: "ativo"` não tem log bruto há mais de 24 h (`hook_stale`) ou nunca teve (`hook_never`).
- **Arquivos de estado ilegíveis** (`agentes.json`, `pendencias.json`): `yellow` (`registry_missing`, `file_unreadable`).
- `health.level` é `green`, `yellow` ou `red`; `health.reasons` traz cada motivo como código; `health.hooks` lista o último log bruto de cada agente (inclusive pastas `desconhecido-*`; pastas que começam com `_` ou `.`, como `_reassigned-…`, são arquivo morto e ficam de fora). `wire` é sempre `false` (reservado para uma fase futura).

## Uso do Claude

Duas medidas separadas, sempre com a fonte indicada:

1. **Plano (conta inteira):** % da janela de 5 h e da semanal, horário de reset e idade do dado, lidos do `.status.json` do Maestri (o mesmo dos anéis). O Maestri só atualiza esse arquivo a cada 5 min com os anéis visíveis (mais devagar em segundo plano), por isso o painel mostra a idade. Se a janela já reiniciou depois da última leitura do Maestri, o % fica vazio com o motivo (o valor antigo enganaria).
2. **Participação de cada agente:** tokens das transcrições do Claude Code, atribuídas pelo dono da sessão em `state/sessions/`. Cada `message.id` conta uma vez, com a última linha (nos subagentes a primeira linha traz uso parcial). Sessão sem agente não entra.

`consumo relativo = entrada + 5 × saída + 1,25 × escrita de cache + 0,1 × leitura de cache`; `% do consumo` = participação no período; `% estimado do plano` = % do consumo × % do plano da janela correspondente (5 h → janela de 5 h; 7 dias → semanal; "hoje" não tem). Períodos: `window_5h` (de reset − 5 h até agora; sem reset válido, as últimas 5 h), `today` (desde 00:00 em São Paulo) e `7d`. No `7d`, as barras mostram os 7 dias corridos, mas o % estimado do plano usa a participação de cada agente na **semana do plano** (de reset semanal − 7 dias até agora; `periods["7d"].plan_basis` e `plan_week_consumption_pct`), que é a mesma base do % semanal do Maestri; sem reset semanal válido, usa os 7 dias corridos (`plan_basis: null`). A nota "o % por agente é estimado; o % do plano vem do Maestri/Claude" vai junto no `usage.json` como código (`usage_note`), assim como a fórmula, as fontes, as bases dos períodos e os motivos do plano indisponível.

Coletor pela linha de comando (não precisa do servidor):

```
node bin/collect-usage.js            # resumo legível e grava state/usage.json
node bin/collect-usage.js --json     # imprime o usage.json
node bin/collect-usage.js --no-write # não grava nada; --now <ISO> fixa o relógio
```

A leitura é incremental: `state/usage-cache.json` guarda o ponto já lido de cada transcrição e o último uso de cada mensagem (só dos últimos 8 dias). Apagar esse arquivo é seguro: a próxima rodada relê tudo.

## Rotinas: `time-window.js`

Para o `--pre-run` das rotinas do Maestri: sai 0 dentro da janela (horário de São Paulo) e 1 fora, sem escrever nada no stdout.

```
node bin/time-window.js 8 22
```

O fim é exclusivo (`8 22` aceita de 08:00 a 21:59; use `24` para ir até 23:59), aceita minutos (`8:30`) e janela que vira a noite (`22 6`). `--now <ISO>` (ou `MAESTRO_NOW`) fixa o relógio. Argumento inválido sai 2 com a mensagem no stderr.

## Variáveis de ambiente

| Variável | Nome antigo | Padrão | Para quê |
|---|---|---|---|
| `PANEL_PORT` | `PAINEL_PORTA` | 4777 | porta (o `--port`, antes `--porta`, vale mais) |
| `MAESTRO_DIR` | (igual) | modelo antigo: a pasta acima de `panel/` (a raiz do repositório); modelo novo (`maestro.db`): `~/.painel-maestro` | raiz dos dados (os testes apontam para `panel/tests/tmp/`). Definida, vale para os dois modelos |
| `MAESTRI_DATA_DIR` | (igual) | `~/.maestri` | onde está `usage/providers/.status.json` (o Maestri já define nos terminais dele) |
| `CLAUDE_CONFIG_DIR` | (igual) | `~/.claude` | transcrições de sessões sem `transcript_path` |
| `PANEL_COLLECTOR` | `PAINEL_COLETOR` | (ligado) | `0` desliga o coletor automático (o botão Recalcular continua funcionando) |
| `PANEL_INDEX` | `PAINEL_INDEX` | | só para testes: outro `index.html` |
| `PANEL_NOW` | `PAINEL_AGORA` | | só para testes: relógio fixo do servidor (`MAESTRO_NOW` também vale) |
| `MAESTRO_NOW` | `MAESTRO_AGORA` | | só para testes: relógio fixo dos scripts de `bin/` |
| `MAESTRO_LOCK` | `MAESTRO_TRAVA` | `exlock` no Windows, `wx` nos outros | estratégia da trava entre processos (todos precisam usar a mesma) |
| `MAESTRO_LOCK_WAIT_MS` | `MAESTRO_TRAVA_ESPERA_MS` | 10000 | espera máxima pela trava nos comandos |
| `PANEL_NOTIFY_BRAIN` | `PAINEL_AVISAR_CEREBRO` | automático | aviso ao Cérebro quando o dono responde uma pendência pelo painel: `0` desliga, `1` liga; sem a variável, liga só dentro de um terminal do Maestri (`MAESTRI_TERMINAL_ID`) e com relógio de verdade. `/api/state` → `answers` diz se está ligado e por quê |
| `PANEL_MAESTRI_CLI` | `PAINEL_MAESTRI_CLI` | `MAESTRI_CLI` ou `maestri` | executável usado no aviso (os testes apontam para um script falso que só grava os argumentos) |
| `MOCK_PORT` | `MOCK_PORTA` | 4795 | porta do `tests/serve-mock.js` |
| `KEEP_TMP` | `MANTER_TMP` | | testes: `1` guarda as raízes temporárias |
| `HEAVY_TEST` | `TESTE_PESADO` | | testes: `1` multiplica o log bruto do teste de desempenho |

## Diagnóstico

- **Selo amarelo ou vermelho:** passe o mouse no selo; cada motivo diz o que olhar. O mesmo motivo, como código, está em `health.reasons` de `/api/state`.
- **"… nenhum log bruto ainda (hooks instalados?)" ou "sem log bruto há …":** os hooks não estão gravando para aquele agente. Confira se os hooks do Claude Code chamam `bin/hook-log.js` e se há arquivo do dia em `logs/raw/<agente>/`. Se os comandos estão caindo numa pasta `desconhecido-<id>`, o `terminal_id` do agente em `registro/agentes.json` está errado ou vazio. Um agente parado de propósito pode ficar sem log: troque o `status` dele para algo diferente de `ativo`.
- **Uso do plano "indisponível":** o motivo aparece no KPI (`kpis.usage.reason`). Em geral: o uso dos agentes está desligado no Maestri (Configurações → Agentes → Uso), os anéis não estão visíveis, ou a última consulta do Maestri falhou. Confira `~/.maestri/usage/providers/.status.json` (`state`, `error`, `lastSuccessAt`). Dado velho aparece pela idade (`kpis.usage.age_min`).
- **Consumo por agente zerado:** não há arquivo de sessão com dono em `state/sessions/` (hooks ainda não instalados ou sessão iniciada antes deles). `usage.json` → `collection` mostra quantas sessões e transcrições foram lidas e quantas ficaram sem dono.
- **Botão Recalcular não muda nada:** o coletor só relê o que mudou; se o plano estiver indisponível, o motivo continua o mesmo até o Maestri gravar de novo. Erros do coletor aparecem no terminal do servidor e em `collector.last`.
- **"a porta 4777 já está em uso":** já existe um painel rodando (veja `state/panel.pid`) ou outro programa na porta: `netstat -ano | findstr :4777` mostra o PID.
- **Página com "arquivo do painel não foi encontrado" (503):** falta o `panel/index.html`.
- **Linhas ignoradas:** `warnings` de `/api/state` lista arquivos com linhas JSONL ilegíveis (`event_lines_ignored`).
- **Eventos de teste:** eventos e pendências com `teste: true` ficam fora dos KPIs e da tabela; o filtro "mostrar testes" (`include_tests=1`) traz os eventos.

## Testes

```
node panel/tests/run-all.js
node panel/tests/run-all.js server   # só os arquivos com "server" no nome
```

- `test-collector.js`: transcrições falsas (deduplicação pela última linha, subagentes, sessão sem dono, cache incremental, arquivo crescendo, arquivo trocado, plano indisponível, janela reiniciada, % do plano no 7d pela semana do plano, CLI); motivos e avisos conferidos como códigos.
- `test-flow.js`: o modelo novo, só pela seam combinada: o CLI `bin/flow.js` roda como processo dentro de repositórios git temporários com `remote origin` fictício → `maestro.db` temporário (`MAESTRO_DIR`) → API do servidor. Iniciar item e mudar etapa (lista e item pela API), auto-cadastro em "Sem empresa", worktree com o mesmo projeto, Azure DevOps (`PBI 3100`, remotes SSH e HTTPS iguais), JSON pela entrada padrão (acentos, aspas, várias linhas; argumento vale mais), dados inválidos com código 2 e nada gravado, nenhum `ExperimentalWarning` na saída, 12 processos concorrentes (banco novo, mesmo repositório sem cadastro, mesmo item) sem perder evento, 404/403/405 da API e o servidor sem banco. Nenhum teste lê o banco.
- `test-hook.js`: o hook rodando como processo, alimentado pela entrada padrão como o Claude Code faz (prompt, ferramenta, falha, sessão fora do workspace, entrada inválida), conferido só pela API: comandos ligados ao fluxo, segredo redigido, saúde dos hooks e sessão contada pelo coletor.
- `test-server.js`: raiz falsa realista numa porta de 4790 a 4799 (cada rota, filtros, modal, Host forjado → 403, POST sem `X-Panel` → 403, caminhos estranhos → 404, métodos errados → 405, leitura tolerante, porta ocupada, PID, anti-iframe, pedido inicial pelo prompt sem `flow_id`, vizinhos só com id válido, índice do log bruto, fluxo longo, itens null no estado, rotas antigas e em português removidas → 404, nenhuma frase em português nas respostas).
- `test-performance.js`: 50 mil eventos e log bruto grande e um fluxo aberto há 31 dias, cuja 2ª consulta usa o índice sem reler o log (`HEAVY_TEST=1` multiplica o log bruto).
- `test-time-window.js`: `time-window.js`.
- `test-pending-decisions.js`: resposta de pendência pelo painel numa raiz falsa, com um `maestri` falso (opção + comentário, só texto, 409 na segunda resposta e em pendência fechada, 400/404, sem `X-Panel` → 403, GET → 405, aviso desligado, mensagem ao Cérebro numa linha só, sem barra invertida nem aspas retas).
- `test-i18n.js`: o dicionário sem navegador: o idioma ativo é um ponto só (pt-BR), `t()` com parâmetros e plural, todo código que o servidor pode devolver tem tradução (com os mesmos textos de antes), toda chave usada existe e toda chave existe porque é usada, e nenhum texto visível escrito direto em componente ou tela.
- `test-index.js`: a página sem navegador. No build: arquivo único (fonte embutida, `url()` só `data:`, nenhuma URL além dos namespaces XML do Preact), script compila, só rotas do contrato (inclusive `/api/items`). O `mock-items.json` tem item em toda etapa, os dois trackers e várias empresas, e a página do item lê `#items/<projeto>/<número>`. Na fonte (`ui/src`): nenhum `innerHTML`/`dangerouslySetInnerHTML`/`eval`, nenhum `href` para fora, intervalos e fuso do contrato. Mais o cenário do mock e o servidor real numa raiz montada do mock com dados hostis (campos que a página lê, filtros, modal, 404, POST sem `X-Panel` → 403, Recalcular, `/api/brain` → 501). Rode depois de cada `npm run build`.

Tudo é gravado em `panel/tests/tmp/<teste>-<pid>/` e apagado no fim (`KEEP_TMP=1` guarda para inspeção). Os servidores de teste são derrubados pelo PID que eles mesmos imprimem.
