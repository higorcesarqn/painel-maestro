# Painel Maestro

Painel local que acompanha itens de trabalho sendo especificados, implementados e validados por agentes Claude Code (no Maestri, no Orca ou por subagentes), organizados por organização e projeto.

O código é em inglês e a interface em português: cada termo traz o nome usado no código. O _Avoid_ vale para o texto em português.

## Organização

**Organização**:
Um agrupamento de projetos de um mesmo dono do trabalho (um contratante, o trabalho pessoal, uma comunidade), montado à mão pelo dono do painel; o trabalho pessoal é a organização "Pessoal". Não é a organização do GitHub nem a do Azure DevOps.
Em código: `Organization`.
_Avoid_: empresa, cliente, org

**Sem organização**:
A organização reservada onde cai o projeto de um repositório sem cadastro, até o dono movê-lo; não é destino de mover, nem se renomeia ou exclui.
Em código: `UNASSIGNED_ORGANIZATION`.
_Avoid_: sem empresa, organização padrão, sem cadastro

**Organização oculta**:
Uma organização que o dono tirou das listagens do painel, por exemplo para apresentá-lo a outra organização; o trabalho dela segue normal e ela continua no cadastro, de onde o dono a mostra de novo.
Em código: `hidden`.
_Avoid_: arquivada, inativa, desativada

**Projeto**:
Um projeto do tracker (um repositório no GitHub, um projeto no Azure DevOps), com os repositórios e pastas locais que pertencem a ele.
Em código: `Project`.
_Avoid_: repo, workspace

## Trabalho

**Item**:
Uma Issue pai do GitHub ou um PBI do Azure DevOps; é o que tem um fluxo.
Em código: `Item`.
_Avoid_: tarefa, card, ticket

**Task**:
Uma filha de um item (sub-issue ou card filho), executada por um trabalhador numa branch própria; uma issue sem filhas é um item com uma task, ela mesma.
Em código: `Task`.
_Avoid_: subtarefa, card filho

**Achado**:
Algo encontrado numa revisão que pode virar uma task nova para triagem.
Em código: `Finding`.
_Avoid_: issue de revisão

**Resumo do diff**:
Os arquivos que uma task alterou desde que saiu da branch integradora, com as linhas adicionadas e removidas de cada um; acompanha o relatório do trabalhador.
Em código: `TaskDiff`.
_Avoid_: patch, mudanças, arquivos compartilhados

**Pendência**:
Algo do fluxo de um item que espera uma decisão do dono, com contexto, opções e recomendação; o dono decide no terminal do maestro ou no painel. A revisão de uma task e o OK para integrá-la são a mesma pendência.
Em código: `PendingDecision`.
_Avoid_: espera, aprovação, gate

**Fluxo**:
A sequência de etapas que um item percorre, da especificação até a conclusão.
Em código: `Flow`.
_Avoid_: pipeline, pedido

**Etapa**:
Uma fase do fluxo de um item: Especificação, Implementação, Ajuste final, PR pronto, Merge, Validação HML, Concluído; cada projeto declara quais usa.
Em código: `Stage`.
_Avoid_: fase, estágio

## Agentes

**Maestro**:
O agente que conduz o fluxo de um item: lê o grafo de tasks, despacha, revisa e integra, sem implementar.
Em código: `Maestro`.
_Avoid_: Cérebro, orquestrador
"Orquestrador do Orca" é outra coisa: o nome do recurso do Orca (`orca orchestration`) com que o maestro inicia e acompanha os trabalhadores no fluxo do Orca; não é o maestro.

**Trabalhador**:
O agente que implementa uma task, num floor do Maestri, num worktree do Orca ou como subagente; existe só enquanto a task dura.
Em código: `Worker`.
_Avoid_: sub-agente, sub-cérebro

**Ambiente**:
Onde o maestro e os trabalhadores rodam: um terminal comum (subagentes), o Maestri ou o Orca. O `flow host` diz qual é, e o status do trabalhador e o aviso de pendência nova passam por ele.
Em código: `Host`.
_Avoid_: plataforma, IDE
