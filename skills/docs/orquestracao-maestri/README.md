# Orquestração por floors do Maestri

Fluxo compartilhado por `/implementar-pbi-maestri` (Azure DevOps) e `/implementar-issue-maestri` (GitHub). A skill que apontou para cá fornece o **adaptador do tracker**: como ler o item pai e as tasks, achar os bloqueios, marcar uma task concluída e abrir e finalizar o PR. Tudo abaixo é agnóstico de tracker.

É a versão para o Maestri do fluxo de `/implementar-issue` e `/implementar-pbi` com subagentes, descrito em `~/.claude/docs/orquestracao-subagentes/README.md`. O resultado é o mesmo, **um único PR** numa **branch integradora**, mas cada task roda num **floor** (worktree git) com um **terminal Claude Code** visível no canvas, em vez de um subagente invisível. O usuário vê cada trabalhador, pode falar com ele e aprova cada integração.

Cada passo grava o fluxo no **painel-maestro** pelo CLI `flow` (seção [Painel](#painel)); o portal do canvas abre a página do item no painel.

## Papéis

- **Maestro**: você, o terminal com Maestro Mode ligado no **Ground** do workspace. Lê o grafo, abre os floors, revisa, integra e fala com o usuário. Não implementa task.
- **Trabalhador**: um terminal Claude Code num floor. Roda `/mattpocock-skills:implement` sobre uma task e segue a skill `trabalhador-floor`.
- **Caldeira** (opcional): um terminal Shell no Ground para processos longos (docker, servidor, banco).

## Pré-requisitos (confira antes do passo 1)

- O workspace do Maestri tem como **raiz o próprio repositório git**. Com a raiz num diretório-pai, o floor vira pasta comum, sem worktree nem isolamento: pare e peça ao usuário um workspace na raiz do repo (`maestri workspace create "<nome>" --dir <repo>`).
- `/.maestri/` no `.git/info/exclude` do repo.
- `$MAESTRI_CLI` definido (os scripts usam ele, ou `maestri` no PATH).
- Ground limpo (`git status --porcelain` vazio).
- `node "$PAINEL_MAESTRO/bin/flow.js" --help` sai com 0. Se falhar por `PAINEL_MAESTRO`, peça ao usuário para defini-la (README do painel-maestro, "Instalar as skills do dono"); sem ela o fluxo segue, mas nada chega ao painel: avise no relatório final.

## Painel

**`flow`**, neste documento, é `node "$PAINEL_MAESTRO/bin/flow.js"`, rodado pelo Bash (Git Bash) de dentro do repositório: o CLI reconhece o projeto pelo `git remote origin` (também no worktree de um floor). Escreva o comando inteiro a cada chamada.

- **Quem grava**: você passa sempre `--role maestro --agent "<seu nome no canvas>"`. O trabalhador grava o próprio status e relatório (skill `trabalhador-floor`). Se um dia precisar gravar o status de uma task por ele (o terminal dele morreu), rode `MAESTRI_TERMINAL_ID= node "$PAINEL_MAESTRO/bin/flow.js" status "..." --item <n> --task <task> --role maestro --agent "<seu nome>"`: sem a variável, o CLI só grava e não posta o status no seu próprio terminal.
- **Texto com acento, aspas ou várias linhas** (títulos, contexto, opções, resumos): escreva um JSON UTF-8 no scratchpad com o Write tool e rode `flow <comando> --json - < <scratchpad>/<arquivo>.json`. Os campos do JSON têm os nomes da ajuda (`flow --help`, seção "JSON pela entrada padrão"); um argumento vale mais que o JSON. Pipe do PowerShell estraga os acentos.
- **Códigos de saída**: 0 ok; **2** dado inválido, a mensagem diz o que corrigir (corrija e rode de novo); **1** falha do painel: não pare o fluxo, anote e avise o usuário no relatório final com a mensagem.
- **Chave do item**: `<projeto>/<número>`, impressa pelo `flow item start` (ou pela recusa "já foi iniciado"). A página do item é `http://127.0.0.1:4777/#items/<projeto>/<número>`; ela se atualiza sozinha a cada 20 s. O que o painel calcula (estado de cada task, relatórios, pendências) também sai em `curl -s http://127.0.0.1:4777/api/items/<projeto>/<número>`.
- **Pendência** é tudo o que espera o usuário. Ao levar uma escolha a ele, abra-a com `flow pending open <n> --kind <tipo> --title ... --context ... --option "A: ..." --option "B: ..." --recommendation ...` (imprime `P-<id>`); quando ele responder no seu terminal, `flow pending resolve P-<id> --decision "<o que ele decidiu>"`; se ela deixar de valer, `flow pending cancel P-<id> --reason ...`. Os tipos estão nos passos: `parallelize` (5), `worker_blocked` (6), `task_review` e `decision` (7), `finding` (10), `hml` (11).
- **Esperar a pendência.** O usuário pode responder no seu terminal ou no painel (tela Pendências), e o painel não te avisa: logo depois de **cada** `pending open`, deixe `node "$PAINEL_MAESTRO/bin/flow.js" pending wait P-<id>` rodando em segundo plano (Bash com `run_in_background: true`, de dentro do repositório), um por pendência. Ele só lê o painel, não tem prazo e termina, com código 0, quando a pendência fecha por qualquer caminho; o Claude Code te acorda com a saída, que diz como ela fechou, a decisão ou o motivo e quem fechou. Ao terminar, guie-se pela primeira linha, que diz como ela fechou:
  - **resolvida com a decisão do dono** e a linha **"A decisão veio do painel"**: a decisão já está gravada; siga com ela e **não** rode `pending resolve` (ele sairia com código 2, "já está resolvida");
  - **resolvida com a decisão do dono**, sem essa linha: foi você quem gravou a resposta (`pending resolve`, "Fechada por: maestro"); o aviso repete o que você fez; ignore;
  - **cancelada** ou **resolvida pela integração da task** (ou pela HML aprovada, pela substituição, pelo item concluído): siga como hoje (se foi você quem cancelou, o aviso só repete o que fez);
  - código 2 (id errado ou de outro projeto): corrija e rode de novo; código 1 (falha do painel): ninguém está esperando essa pendência, então peça a resposta no seu terminal e cite a mensagem no relatório final.

  Numa sessão nova sobre um item já em andamento, confira as pendências dele na página do item: uma respondida pelo painel enquanto ninguém esperava já tem a decisão gravada; para cada uma ainda aberta, deixe o `wait` rodando de novo.

## Fatos do Maestri (verificados; não repita o erro)

- **`floor land` não é confiável**: em 7 de 7 integrações ele estourou o tempo limite, apagou o floor e **não fez o merge**. Integre com `scripts/integrate.sh`, que faz o merge com git, grava a integração no painel e depois apaga o floor.
- **`floor create` estoura o tempo limite** enquanto copia os não versionados, mas conclui (o worktree aparece `locked` durante a cópia). `scripts/open-floor.sh` espera por ele; nunca repita o create sem conferir `floor list`.
- O floor vira worktree em `<pai-do-repo>\.maestri\floors\<repo>--<branch-sem-barra>`, fora do repo.
- **Recrute sem `--role`**: com role, o terminal abre em `.maestri/roles/<id>/` e perde o `AGENTS.md`/`CLAUDE.md`, as skills e as permissões do repo.
- O trabalhador **não carrega a memória do projeto** (o caminho do projeto é outro). Aponte o `MEMORY.md` por caminho absoluto no briefing.
- O `maestri ask` digita o texto no terminal do trabalhador: um briefing que **começa com `/skill`** roda o comando de barra, e o resto da mensagem (várias linhas) vira o argumento. É assim que o trabalhador roda `/mattpocock-skills:implement`, que só pode ser chamado por digitação.
- O `ask` do briefing volta cedo, com um retrato da tela; não é o relatório. O relatório chega quando o trabalhador roda `maestri ask "<maestro>" "..."`, e aparece no seu terminal como texto colado. Antes disso ele o grava no painel (`flow report`), então um relatório que não chegou ao terminal está na linha do tempo do item.
- Pasta fora de um projeto confiável abre o "trust this folder?" do Claude Code, e o `ask` responde "não". Floors dentro do repo não têm isso.
- `maestri connect` liga só nota↔nota/agente, sem direção e sem ciclo: não desenha um grafo de dependências. O grafo e a tabela das tasks ficam na página do item no painel, aberta num **portal**.
- `portal check` falha quando o portal não está visível no canvas; confira com `portal evaluate` se precisar.

## Passos

1. **Ler o grafo.** Pelo adaptador, carregue o item pai, as tasks filhas, o estado de cada uma e as arestas de bloqueio. Leia `docs/agents/` do repo para convenções locais (estados do tracker, comandos de teste, banco de teste, falhas já conhecidas da suíte). Grave no painel:
   - o item, se a `/especificar` ainda não o gravou: `flow item start <n> --stage implementation` com o título pelo JSON (`{"number": <n>, "title": "...", "stage": "implementation", "role": "maestro", "agent": "..."}`). "Já foi iniciado" (código 2) significa que ele já está lá: siga. Guarde a chave do item que a mensagem traz;
   - o grafo: `flow task graph --json - < grafo.json` com `{"number": <n>, "tasks": [{"number": <task>, "title": "...", "blocked_by": [<task>, ...]}, ...]}`; task fechada antes desta execução ou fora do escopo vai com `"out": true`. Um item sem tasks filhas não tem grafo: ele é a própria task.

   Pronto quando: cada task tem estado e bloqueadores conhecidos e o grafo está no painel.

2. **Explorar (opcional).** Se as tasks exigem entender código, despache um subagente explorador (Agent tool) que salva notas markdown no scratchpad da sessão. Os trabalhadores recebem o caminho como ponteiro.

3. **Preparar a integradora.** A partir da branch de origem (a do usuário ao invocar a skill), crie a integradora (`feature/<tipo>-<id>` salvo convenção local), faça push e abra o PR em **rascunho** pelo adaptador, ligado ao item pai e às tasks. Grave: `flow pr <n> draft --url <URL do PR> --branch <integradora>`. Deixe a integradora em checkout no Ground: os floors partem do HEAD dela.

4. **Abrir o painel no canvas.** Com o servidor do painel no ar (`npm start` na pasta do painel-maestro; peça ao usuário se `http://127.0.0.1:4777` não responder), abra um portal na página do item:
   ```bash
   "$MAESTRI_CLI" portal create "http://127.0.0.1:4777/#items/<projeto>/<n>" "Painel <tipo> <id>" --size 1100x640
   ```
   A página mostra o grafo das tasks e a tabela task / floor e branch / trabalhador / estado / SHA, calculados do que você e os trabalhadores gravam; ela se atualiza sozinha. O portal é o painel: não mantenha nota paralela com a mesma tabela.

5. **Despachar a fronteira.** Fronteira = tasks abertas cujos bloqueadores já estão integrados. Regras:
   - no máximo 3 floors trabalhando ao mesmo tempo, salvo pedido do usuário;
   - task que gera um artefato único e sequencial (migration de banco com snapshot, número de versão, lockfile regenerado) roda **sozinha**;
   - duas tasks da fronteira que claramente mexem no mesmo fluxo: pergunte ao usuário antes de paralelizar, com uma pendência `parallelize` (opções: em paralelo, em sequência);
   - cada task recebe os recursos exclusivos que a convenção local pedir (ex.: um banco de teste próprio por task).

   Para cada task: escreva o briefing (modelo abaixo) num arquivo do scratchpad, grave o despacho e abra o floor, do Ground:
   ```bash
   node "$PAINEL_MAESTRO/bin/flow.js" task dispatch <n> <task> --floor "<floor>" --worker "<trabalhador>" --branch task/<id>-<slug> --role maestro --agent "<seu nome>"
   bash ~/.claude/docs/orquestracao-maestri/scripts/open-floor.sh "<floor>" task/<id>-<slug> "<trabalhador>" <scratchpad>/brief-<id>.txt <integradora>
   ```
   O script cria o floor (esperando o timeout), recruta o trabalhador sem role e manda o briefing em segundo plano. Dê codinomes curtos e distintos aos trabalhadores (sem acento).

6. **Esperar o relatório.** Não fique consultando. O relatório chega no seu terminal. Antes de pedir qualquer OK ao usuário, rode `maestri floor status --floor "<floor>"` em **todos** os floors ativos: um floor em `review` sem relatório recebido é relatório perdido (leia-o na linha do tempo do item, pela API do [Painel](#painel), ou com `maestri check "<trabalhador>"`). Trabalhador em `blocked` que precisa do usuário: abra uma pendência `worker_blocked` com `--task <task>`, deixe o `wait` dela rodando e resolva-a com a resposta, se ela vier pelo seu terminal.

7. **Revisar.** Para cada relatório: leia o diff (`git log` / `git diff <integradora>...task/<id>`), confira que a branch está sobre a integradora (`git merge-base --is-ancestor <integradora> task/<id>`) e leve ao usuário, com a sua recomendação para cada uma:
   - o que a task entregou e os testes (com o banco/ambiente usado);
   - as decisões que o trabalhador tomou;
   - os achados da sua revisão.

   Ao levar, abra a pendência `task_review` da task (`--task <task>`, opções como "A: Integrar", "B: Pedir ajuste"): ela se resolve sozinha quando a task é integrada; se o usuário pedir ajuste, resolva-a com a decisão (a resposta pelo painel já chega resolvida) e abra outra no próximo relatório. Cada decisão do trabalhador que o usuário precisa escolher vira uma pendência `decision`. Achado da sua revisão: `flow finding add <n> --title ... --classification defect|owner_decision|discarded --task <task>` (descrição pelo JSON).

   **Mudança de regra no meio do caminho**: antes de mandar implementar uma regra nova aprovada pelo usuário, teste-a contra os estados do item (ex.: em supervisão, rejeitado, corrigido) e diga ao usuário os casos de borda. Uma regra aprovada às pressas foi a origem do achado mais sério do PBI #3100.

8. **Integrar, com o OK do usuário.** Uma task por vez:
   ```bash
   bash ~/.claude/docs/orquestracao-maestri/scripts/integrate.sh "<floor>" task/<id>-<slug> <integradora> [<n> <task>]
   ```
   O script recusa Ground sujo, floor com alteração não commitada e merge que não seja fast-forward. Se não for fast-forward, peça ao trabalhador (ainda vivo) um rebase sobre a integradora e um novo gate, e rode de novo. Depois do push ele grava `flow task integrate` com os SHAs de antes e depois (item e task saem de `feature/<tipo>-<n>` e `task/<id>-…`; fora dessa convenção, passe-os como 4º e 5º argumentos). A última linha diz `integrar: painel: task <task> integrada no item <n>`; se disser `integrar: aviso: o painel não registrou ...`, a integração valeu e o comando para gravá-la vem logo abaixo: corrija a causa e rode-o. Depois: marque a task concluída pelo adaptador e avise os trabalhadores ainda ativos de que a integradora andou, pedindo rebase antes do commit final.

9. **Recalcular a fronteira** e voltar ao passo 5 até todas as tasks estarem integradas ou reportadas como bloqueadas.

10. **Ajuste final.** Grave `flow final-adjustment <n> open` e abra um floor `"<id> Ajuste"` (branch `task/<id>-ajuste-final`, sem `task dispatch`: o ajuste final não é task do grafo) com um briefing que pede, nesta ordem:
    1. as correções que o usuário já aprovou para o fim;
    2. as duas revisões sobre a integradora inteira contra a branch de origem: `mattpocock-skills:code-review` e a `code-review` nativa em nível `medium`. Desempate: quando um achado de simplificação contradiz padrão do repo ou a spec, vence o padrão/spec;
    3. classificar cada achado: **defeito claro sem escolha de desenho** → corrige com teste; **depende do usuário** → não corrige, traz com recomendação; **descartado** → uma linha de porquê;
    4. a suíte completa, comparada com as falhas já conhecidas antes de chamar algo de regressão;
    5. a subida de versão, se `docs/agents/` do projeto pede subir a versão no ajuste final;
    6. um commit.

    No briefing do ajuste final, diga ao trabalhador que o status vai direto pelo `"$MAESTRI_CLI" floor status` e que ele não grava `flow report` (não há task para recebê-los). Com o relatório: grave cada achado com `flow finding add` (`defect`, `owner_decision` ou `discarded`); um achado que fica para depois vira item novo pelo adaptador, ligado com `--new-task <número do item criado>`. Leve os achados "depende do usuário" ao usuário, cada um com uma pendência `finding`; o que ele aprovar, o mesmo trabalhador aplica num commit a mais. Integre com o `integrate.sh` (na branch do ajuste final ele não grava task e lembra o próximo comando) e grave o resultado: `flow final-adjustment <n> result --outcome passed|failed --summary ...` (`passed` quando a suíte está verde fora das falhas já conhecidas e os defeitos foram corrigidos).

11. **Finalizar.** Atualize a descrição do PR (o que cada task entregou, regras decididas na revisão, o que muda para quem consome a API, testes, o que ficou para depois) e tire-o do rascunho pelo adaptador; grave `flow pr <n> ready`. O merge é do usuário; se ele pedir que você o faça, grave `flow pr <n> merged` depois. Marque o item pai concluído no tracker, se a convenção local mandar. O item só fica **Concluído** no painel (`flow item done <n>`) depois do merge e, se o projeto usa Validação HML, do registro da HML: se a sessão acabar antes, esses comandos vão para o relatório como próximos passos do usuário.

    **Lembrete de HML**: a validação em HML segue a skill `especificacao-atdd-hml`; o resultado vai para o painel com `flow hml <n> --passed <n> --failed <n> --blocked <n> --card <URL do card> --role owner` (cenário reprovado ou bloqueado que espera decisão: pendência `hml`).

12. **Limpar.** `maestri floor list` só com o Ground; `git worktree list` só com o repo; nenhuma branch `task/*` local. Reporte: link do PR, a página do item no painel, tasks integradas, tasks bloqueadas, itens novos abertos, pendências ainda abertas e o que não foi gravado no painel (com a mensagem do CLI).

## Modelo de briefing

A **primeira linha é o comando de barra**: é ela que faz o trabalhador rodar o `/implement`. O resto são ponteiros, não texto copiado do tracker.

```text
/mattpocock-skills:implement <tracker> <id> — <título da task>
Você é o trabalhador do floor "<floor>" do Maestri, na branch task/<id>-<slug>, criada a partir da integradora <integradora> em <sha>. O maestro é o terminal "<nome do maestro>". Siga o protocolo da skill trabalhador-floor.

PAINEL
- Item <n>, task <id>, codinome "<trabalhador>" (status e relatório pelo flow, como diz a skill)

LEITURA
- A task e o item pai: <comando de leitura do adaptador>
- Notas do explorador: <caminho, se houver>
- Memória do projeto: <caminho absoluto do MEMORY.md> (e os arquivos que importam para esta task)
- O que já está na integradora: git log <sha da origem>..HEAD

ESCOPO
<o que a task entrega, os pontos de teste combinados, o que reaproveitar>
NÃO FAÇA: <o que é de outras tasks>

DECISÕES JÁ APROVADAS PELO USUÁRIO
<lista curta, ou "nenhuma">

RECURSOS EXCLUSIVOS DESTA TASK
<ex.: banco de teste db_<...>_<id>; nunca o compartilhado>

EM PARALELO
<outros floors ativos e os arquivos que eles tocam, ou "nenhum">
```
