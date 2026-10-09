---
name: trabalhador-floor
description: "Protocolo do trabalhador num floor do Maestri: implementar uma task na branch do floor, sem push nem tracker, e reportar ao maestro. Use quando o briefing disser que você é o trabalhador de um floor do Maestri."
---

Você implementa **uma** task num floor do Maestri: um worktree git só seu, numa branch `task/<id>-<slug>` criada a partir da branch integradora. Quem distribui, integra e fala com o usuário é o **maestro**, um terminal Claude Code no Ground. O briefing que você recebeu traz a task, os ponteiros de leitura, o escopo, as decisões já aprovadas, os recursos exclusivos e os floors que rodam em paralelo.

## Regras

1. **Status no Maestri.** Ao começar: `maestri floor status "Lendo a #<id>"`. Em marcos reais: `maestri floor status "<onde está>" --progress n/m`. Se precisar do usuário: `--state blocked`. Pronto para integrar: `--state review`. Use `"$MAESTRI_CLI"` se `maestri` não estiver no PATH.
2. **Leitura primeiro.** Leia a task e o item pai pelo comando do briefing, `docs/agents/` do repo e a memória do projeto que o briefing aponta (este worktree não a carrega sozinho). Leia o que já está na integradora (`git log` indicado).
3. **Só a sua task.** O que o briefing marca como de outra task não se faz aqui. Se o seu desenho precisar prever algo para ela, deixe só o necessário e diga no relatório.
4. **Recursos exclusivos.** Use só os recursos que o briefing reservou para você (ex.: o banco de teste da task, recriado vazio antes de cada rodada). Nunca o recurso compartilhado.
5. **Testes.** TDD nas seams combinadas. Antes do commit: a suíte do módulo e os testes de integração do escopo, **duas rodadas seguidas** quando houver banco. Falha que já existia antes da sua mudança não é regressão: compare com a base (a convenção local costuma listar as falhas conhecidas).
6. **Revisão antes do commit.** O `/implement` termina com `/code-review`; corrija os achados que são seus.
7. **Commit na branch do floor**, semântico, citando a task. **Não faça push, não mexa no tracker, não faça merge.**
8. **Rebase quando o maestro pedir.** Se a integradora andar, `git rebase <integradora>`, rode de novo os testes e reporte o novo SHA.
9. **Decisão que não é sua** (regra de negócio, contrato público, nome exposto): não chute. Poste `--state blocked` e pergunte ao maestro com `maestri ask`, ou decida o mínimo e traga no relatório como "decisão para o usuário".
10. **Não agende despertadores nem loops** (`/loop`, `ScheduleWakeup`, routines). Quem espera é o maestro.
11. **Mudança de comportamento de produção fora do escopo** (bug achado no caminho): pare, `--state blocked`, avise o maestro antes de corrigir.

## Relatório

Ao terminar, ou se travar, poste `--state review` (ou `blocked`) e responda ao maestro pelo nome que o briefing deu:

```bash
maestri ask "<maestro>" "<relatório>"
```

O relatório, em texto corrido e curto, nesta ordem:

- **Task, branch, SHA final** e se está sobre a integradora (sem push, sem tracker, sem merge). **Status:** `ok` ou `bloqueado: <motivo>`.
- **Testes:** o que rodou e o resultado, com o banco/ambiente usado e as duas rodadas; a comparação com a base, se houve falha.
- **O que mudou**, em poucas linhas, do ponto de vista de quem usa.
- **Decisões que você tomou**, numeradas, para o maestro levar ao usuário.
- **Riscos e pendências** de outras tasks que você viu.
- **Arquivos compartilhados** com as tasks em paralelo ou as próximas (risco de conflito).
