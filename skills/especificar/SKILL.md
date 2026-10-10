---
name: especificar
description: "Especifica um item novo (issue do GitHub ou PBI do Azure DevOps) com grill-with-docs → to-spec → to-tickets e registra as etapas no painel-maestro."
disable-model-invocation: true
---

Você conduz a especificação de um **item** do começo ao fim: grill, spec, tickets. Em dois pontos você grava a etapa do item no painel pelo CLI `flow` do painel-maestro: **Especificação** assim que o item existe no tracker e **Implementação** quando os tickets estão publicados. O texto que o usuário passou junto do comando é o ponto de partida do grill.

## 0. Pré-requisitos

Confira antes de começar o grill, pelo Bash (Git Bash no Windows):

```bash
node "$PAINEL_MAESTRO/bin/flow.js" --help >/dev/null && git remote get-url origin
```

- `PAINEL_MAESTRO` é a pasta do código do painel-maestro (o repositório, não a pasta dos dados). Se o comando falhar por ela, pare e peça ao usuário para defini-la (o README do painel-maestro explica); sem ela o item não chega ao painel.
- A pasta atual é o repositório do projeto: o CLI reconhece o projeto pelo `git remote origin`. Num projeto do Azure DevOps com vários repositórios, qualquer um deles serve.
- O tracker e os rótulos vêm de `docs/agents/issue-tracker.md` deste repositório. Sem esse arquivo, peça ao usuário para rodar `/setup-matt-pocock-skills`.

**Pronto quando** os dois comandos saíram com 0.

## 1. Grill

Faça o que a `grill-with-docs` faz: chame o Skill tool duas vezes, com `mattpocock-skills:grilling` e `mattpocock-skills:domain-modeling`, e siga as duas juntas sobre o pedido do usuário.

**Pronto quando** cada ramo da árvore de decisões está resolvido e o usuário concordou em seguir para a spec.

## 2. Spec

A `to-spec` só o usuário pode disparar (`disable-model-invocation`), então leia o `SKILL.md` dela e siga-o aqui mesmo. Ache o arquivo com o Glob `~/.claude/plugins/cache/*/mattpocock-skills/*/skills/engineering/to-spec/SKILL.md` (havendo mais de uma versão, a maior).

**Pronto quando** o item foi publicado no tracker e você tem o **número** e o **título** dele como ficaram lá:

- GitHub: o `gh issue create` imprime a URL `.../issues/<número>`.
- Azure DevOps: a resposta do `POST` do work item traz `id` (o número do PBI) e `fields["System.Title"]`.

## 3. Registrar a Especificação

Logo depois de publicar, antes de qualquer outra coisa. O título quase sempre tem acentos, então ele vai por JSON na entrada padrão: grave um arquivo UTF-8 no scratchpad com o Write tool e redirecione-o no Bash (pipe do PowerShell estraga os acentos).

```json
{"number": 3100, "title": "Conciliação de boletos", "stage": "specification", "role": "maestro"}
```

```bash
node "$PAINEL_MAESTRO/bin/flow.js" item start --json - < "<scratchpad>/item-3100.json"
```

O CLI responde, por exemplo, `Item cidax/3100 (PBI 3100) iniciado em Especificação.`: guarde a chave `cidax/3100` para o relatório. Se ele disser que cadastrou o projeto em "Sem empresa", repasse isso ao usuário no fim (ele move o projeto pelo painel).

- **Código 2**: dado inválido; a mensagem diz o que corrigir. "Já foi iniciado" significa que uma tentativa anterior já gravou o item: siga em frente. Etapa que o projeto não usa: avise o usuário e siga sem registrar.
- **Código 1**: falha do painel. Siga com a especificação e avise o usuário no fim, com a mensagem.

**Pronto quando** o CLI saiu com 0 (ou o caso acima foi tratado).

## 4. Tickets

A `to-tickets` também é só do usuário: leia `~/.claude/plugins/cache/*/mattpocock-skills/*/skills/engineering/to-tickets/SKILL.md` (a maior versão) e siga-o, com o item do passo 2 como pai (sub-issues no GitHub, tasks filhas no Azure DevOps).

**Pronto quando** cada ticket aprovado pelo usuário está publicado, ligado ao item e com as arestas de bloqueio. Se o usuário decidir que o item não precisa de tickets (ele é a própria task), o passo também termina.

## 5. Registrar a Implementação

```bash
node "$PAINEL_MAESTRO/bin/flow.js" stage <número> implementation --role maestro
```

Os códigos de saída são tratados como no passo 3.

## 6. Relatório

Entregue ao usuário:

- o item (link no tracker) e os tickets publicados, com os bloqueios;
- a página do item no painel: `http://127.0.0.1:4777/#items/<chave>` (a chave do passo 3, ex.: `#items/cidax/3100`);
- o que não foi gravado no painel e por quê, se algo falhou;
- o próximo passo: implementar o item com a skill de implementação do tracker (`/implementar-issue`, `/implementar-pbi` ou as variantes `-maestri`).
