# Orquestração por floors do Maestri

Fluxo compartilhado por `/implementar-pbi-maestri` (Azure DevOps) e `/implementar-issue-maestri` (GitHub). A skill que apontou para cá fornece o **adaptador do tracker**: como ler o item pai e as tasks, achar os bloqueios, marcar uma task concluída e abrir e finalizar o PR. Tudo abaixo é agnóstico de tracker.

É a versão para o Maestri de `~/.claude/docs/orquestracao-subagentes.md`. O resultado é o mesmo, **um único PR** numa **branch integradora**, mas cada task roda num **floor** (worktree git) com um **terminal Claude Code** visível no canvas, em vez de um subagente invisível. O usuário vê cada trabalhador, pode falar com ele e aprova cada integração.

## Papéis

- **Maestro**: você, o terminal com Maestro Mode ligado no **Ground** do workspace. Lê o grafo, abre os floors, revisa, integra e fala com o usuário. Não implementa task.
- **Trabalhador**: um terminal Claude Code num floor. Roda `/mattpocock-skills:implement` sobre uma task e segue a skill `trabalhador-floor`.
- **Caldeira** (opcional): um terminal Shell no Ground para processos longos (docker, servidor, banco).

## Pré-requisitos (confira antes do passo 1)

- O workspace do Maestri tem como **raiz o próprio repositório git**. Com a raiz num diretório-pai, o floor vira pasta comum, sem worktree nem isolamento: pare e peça ao usuário um workspace na raiz do repo (`maestri workspace create "<nome>" --dir <repo>`).
- `/.maestri/` no `.git/info/exclude` do repo.
- `$MAESTRI_CLI` definido (os scripts usam ele, ou `maestri` no PATH).
- Ground limpo (`git status --porcelain` vazio).

## Fatos do Maestri (verificados; não repita o erro)

- **`floor land` não é confiável**: em 7 de 7 integrações ele estourou o tempo limite, apagou o floor e **não fez o merge**. Integre com `scripts/integrar.sh`, que faz o merge com git e depois apaga o floor.
- **`floor create` estoura o tempo limite** enquanto copia os não versionados, mas conclui (o worktree aparece `locked` durante a cópia). `scripts/abrir-floor.sh` espera por ele; nunca repita o create sem conferir `floor list`.
- O floor vira worktree em `<pai-do-repo>\.maestri\floors\<repo>--<branch-sem-barra>`, fora do repo.
- **Recrute sem `--role`**: com role, o terminal abre em `.maestri/roles/<id>/` e perde o `AGENTS.md`/`CLAUDE.md`, as skills e as permissões do repo.
- O trabalhador **não carrega a memória do projeto** (o caminho do projeto é outro). Aponte o `MEMORY.md` por caminho absoluto no briefing.
- O `maestri ask` digita o texto no terminal do trabalhador: um briefing que **começa com `/skill`** roda o comando de barra, e o resto da mensagem (várias linhas) vira o argumento. É assim que o trabalhador roda `/mattpocock-skills:implement`, que só pode ser chamado por digitação.
- O `ask` do briefing volta cedo, com um retrato da tela; não é o relatório. O relatório chega quando o trabalhador roda `maestri ask "<maestro>" "..."`, e aparece no seu terminal como texto colado.
- Pasta fora de um projeto confiável abre o "trust this folder?" do Claude Code, e o `ask` responde "não". Floors dentro do repo não têm isso.
- `maestri connect` liga só nota↔nota/agente, sem direção e sem ciclo: não desenha um grafo de dependências. O painel é um **portal** com Mermaid e uma tabela (`scripts/fluxo.py`).
- `portal check` falha quando o portal não está visível no canvas; confira com `portal evaluate` se precisar.

## Passos

1. **Ler o grafo.** Pelo adaptador, carregue o item pai, as tasks filhas, o estado de cada uma e as arestas de bloqueio. Leia `docs/agents/` do repo para convenções locais (estados do tracker, comandos de teste, banco de teste, falhas já conhecidas da suíte). Pronto quando: cada task tem estado e bloqueadores conhecidos.

2. **Explorar (opcional).** Se as tasks exigem entender código, despache um subagente explorador (Agent tool) que salva notas markdown no scratchpad da sessão. Os trabalhadores recebem o caminho como ponteiro.

3. **Preparar a integradora.** A partir da branch de origem (a do usuário ao invocar a skill), crie a integradora (`feature/<tipo>-<id>` salvo convenção local), faça push e abra o PR em **rascunho** pelo adaptador, ligado ao item pai e às tasks. Deixe a integradora em checkout no Ground: os floors partem do HEAD dela.

4. **Montar o painel.** Crie `estado.json` no scratchpad (formato em `scripts/fluxo.py`: cada task com título, bloqueadores, estado, `floor`, `branch`, trabalhador e SHA; mais as `regras` do maestro para esta execução), gere o HTML e abra o portal. Ele mostra o fluxograma e, abaixo, a tabela Task / floor e branch / trabalhador / estado / SHA:
   ```bash
   python -X utf8 ~/.claude/docs/orquestracao-maestri/scripts/fluxo.py <scratchpad>/estado.json <scratchpad>/fluxo.html
   "$MAESTRI_CLI" portal create "file:///<scratchpad>/fluxo.html" "Painel <tipo> <id>" --size 1100x640
   ```
   Depois de cada mudança de estado: edite o `estado.json`, gere de novo e `portal navigate "<portal>" "file:///..."`. O portal é o painel: não mantenha nota paralela com a mesma tabela. Preencha `floor` e `branch` ao abrir o floor (passo 5) e o SHA ao integrar (passo 8).

5. **Despachar a fronteira.** Fronteira = tasks abertas cujos bloqueadores já estão integrados. Regras:
   - no máximo 3 floors trabalhando ao mesmo tempo, salvo pedido do usuário;
   - task que gera um artefato único e sequencial (migration de banco com snapshot, número de versão, lockfile regenerado) roda **sozinha**;
   - duas tasks da fronteira que claramente mexem no mesmo fluxo: pergunte ao usuário antes de paralelizar;
   - cada task recebe os recursos exclusivos que a convenção local pedir (ex.: um banco de teste próprio por task).

   Para cada task: escreva o briefing (modelo abaixo) num arquivo do scratchpad e rode, do Ground:
   ```bash
   bash ~/.claude/docs/orquestracao-maestri/scripts/abrir-floor.sh "<floor>" task/<id>-<slug> "<trabalhador>" <scratchpad>/brief-<id>.txt <integradora>
   ```
   O script cria o floor (esperando o timeout), recruta o trabalhador sem role e manda o briefing em segundo plano. Dê codinomes curtos e distintos aos trabalhadores (sem acento).

6. **Esperar o relatório.** Não fique consultando. O relatório chega no seu terminal. Antes de pedir qualquer OK ao usuário, rode `maestri floor status --floor "<floor>"` em **todos** os floors ativos: um floor em `review` sem relatório recebido é relatório perdido (leia com `maestri check "<trabalhador>"`).

7. **Revisar.** Para cada relatório: leia o diff (`git log` / `git diff <integradora>...task/<id>`), confira que a branch está sobre a integradora (`git merge-base --is-ancestor <integradora> task/<id>`) e leve ao usuário, com a sua recomendação para cada uma:
   - o que a task entregou e os testes (com o banco/ambiente usado);
   - as decisões que o trabalhador tomou;
   - os achados da sua revisão.

   **Mudança de regra no meio do caminho**: antes de mandar implementar uma regra nova aprovada pelo usuário, teste-a contra os estados do item (ex.: em supervisão, rejeitado, corrigido) e diga ao usuário os casos de borda. Uma regra aprovada às pressas foi a origem do achado mais sério do PBI #3100.

8. **Integrar, com o OK do usuário.** Uma task por vez:
   ```bash
   bash ~/.claude/docs/orquestracao-maestri/scripts/integrar.sh "<floor>" task/<id>-<slug> <integradora>
   ```
   O script recusa Ground sujo, floor com alteração não commitada e merge que não seja fast-forward. Se não for fast-forward, peça ao trabalhador (ainda vivo) um rebase sobre a integradora e um novo gate, e rode de novo. Depois: marque a task concluída pelo adaptador, atualize o `estado.json` e o portal, e avise os trabalhadores ainda ativos de que a integradora andou, pedindo rebase antes do commit final.

9. **Recalcular a fronteira** e voltar ao passo 5 até todas as tasks estarem integradas ou reportadas como bloqueadas.

10. **Ajuste final.** Abra um floor `"<id> Ajuste"` (branch `task/<id>-ajuste-final`) com um briefing que pede, nesta ordem:
    1. as correções que o usuário já aprovou para o fim;
    2. as duas revisões sobre a integradora inteira contra a branch de origem: `mattpocock-skills:code-review` e a `code-review` nativa em nível `medium`. Desempate: quando um achado de simplificação contradiz padrão do repo ou a spec, vence o padrão/spec;
    3. classificar cada achado: **defeito claro sem escolha de desenho** → corrige com teste; **depende do usuário** → não corrige, traz com recomendação; **descartado** → uma linha de porquê;
    4. a suíte completa, comparada com as falhas já conhecidas antes de chamar algo de regressão;
    5. um commit.

    Leve os achados "depende do usuário" ao usuário; o que ele aprovar, o mesmo trabalhador aplica num commit a mais. Integre com o `integrar.sh`.

11. **Finalizar.** Atualize a descrição do PR (o que cada task entregou, regras decididas na revisão, o que muda para quem consome a API, testes, o que ficou para depois) e tire-o do rascunho pelo adaptador. Marque o item pai concluído, se a convenção local mandar.

12. **Limpar.** `maestri floor list` só com o Ground; `git worktree list` só com o repo; nenhuma branch `task/*` local. Reporte: link do PR, tasks integradas, tasks bloqueadas, itens novos abertos.

## Modelo de briefing

A **primeira linha é o comando de barra**: é ela que faz o trabalhador rodar o `/implement`. O resto são ponteiros, não texto copiado do tracker.

```text
/mattpocock-skills:implement <tracker> <id> — <título da task>
Você é o trabalhador do floor "<floor>" do Maestri, na branch task/<id>-<slug>, criada a partir da integradora <integradora> em <sha>. O maestro é o terminal "<nome do maestro>". Siga o protocolo da skill trabalhador-floor.

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
