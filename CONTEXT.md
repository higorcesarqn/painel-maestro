# Painel Maestro

Painel local que acompanha itens de trabalho sendo especificados, implementados e validados por agentes Claude Code (no Maestri ou por subagentes), organizados por empresa e projeto.

O código é em inglês e a interface em português: cada termo traz o nome usado no código. O _Avoid_ vale para o texto em português.

## Organização

**Empresa**:
Um agrupamento de projetos de um mesmo contratante; o trabalho pessoal é a empresa "Pessoal".
Em código: `Company`.
_Avoid_: cliente, organização

**Sem empresa**:
A empresa reservada onde cai o projeto de um repositório sem cadastro, até o dono movê-lo; não é destino de mover, nem se renomeia ou exclui.
Em código: `UNASSIGNED_COMPANY`.
_Avoid_: empresa padrão, sem cadastro

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

**Pendência**:
Algo do fluxo de um item que espera uma decisão do dono, com contexto, opções e recomendação; a revisão de uma task e o OK para integrá-la são a mesma pendência.
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

**Trabalhador**:
O agente que implementa uma task, num floor do Maestri ou como subagente; existe só enquanto a task dura.
Em código: `Worker`.
_Avoid_: sub-agente, sub-cérebro
