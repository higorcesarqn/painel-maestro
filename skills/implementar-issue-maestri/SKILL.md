---
name: implementar-issue-maestri
description: "Implementa uma issue do GitHub e suas sub-issues num PR, com um floor do Maestri e um terminal Claude Code por sub-issue. Use só dentro do Maestri, como maestro no Ground."
disable-model-invocation: true
---

O usuário passou o número de uma issue pai do GitHub. Siga o fluxo em `~/.claude/docs/orquestracao-maestri/README.md`, usando este arquivo como **adaptador do tracker**. Tipo na branch: `issue` (ex.: `feature/issue-10`). As "tasks" do fluxo são as sub-issues.

Fora do Maestri (sem `$MAESTRI_CLI`, ou sem Maestro Mode no Ground), pare e sugira `/implementar-issue`, que usa subagentes.

## Adaptador GitHub

Use a CLI `gh`, no repo atual (`gh repo view --json nameWithOwner` dá `{owner}/{repo}`). Para texto com acento no Windows, passe o corpo por arquivo (`--body-file`), não por argumento.

- **Item pai e tasks**: `gh issue view <n> --json number,title,body,state,comments` e `gh api repos/{owner}/{repo}/issues/<n>/sub_issues --paginate`. Sem sub-issues nativas, use a task list do corpo da issue pai (`- [ ] #<n>`).
- **Arestas de bloqueio**: `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by` para cada sub-issue. Complemente com linhas `Blocked by #<n>` / `Bloqueada por #<n>` no corpo.
- **Estado**: task fechada é issue com `state: CLOSED`, ou sub-issue já integrada nesta execução (comentário "Integrada em ...").
- **Comando de leitura para o briefing do trabalhador**: `gh issue view <x> --json number,title,body,comments` e o mesmo para a issue pai.
- **Marcar task concluída**: o `Closes` do PR fecha as issues no merge; durante a execução, comente na sub-issue `gh issue comment <x> --body "Integrada em <integradora> (<sha>)"`.
- **Editar texto** (regra que mudou na revisão): `gh issue edit <n> --body-file corpo.md`, depois `gh issue view` para conferir.
- **Criar item** (achado que fica para depois): `gh issue create --title "..." --body-file corpo.md --label needs-triage` e ligue como sub-issue da pai (`gh api repos/{owner}/{repo}/issues/<pai>/sub_issues -f sub_issue_id=<id numérico>`).
- **Abrir PR em rascunho**: `gh pr create --draft --base <origem> --head <integradora> --title "#<n> — <título>" --body-file corpo.md`, com uma linha `Closes #<x>` para a issue pai e para cada sub-issue.
- **Finalizar PR**: `gh pr edit <pr> --body-file corpo-final.md` e `gh pr ready <pr>`.
