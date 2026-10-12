---
name: implement-issue
description: "Implementa uma issue do GitHub e suas sub-issues num PR, com um subagente em worktree por sub-issue, e grava o fluxo no painel-maestro."
disable-model-invocation: true
---

O usuário passou o número de uma issue pai do GitHub. Siga o fluxo em `~/.claude/docs/orchestration-subagents/README.md`, usando este arquivo como **adaptador do tracker**. Tipo na branch: `issue` (ex.: `feature/issue-10`). As "tasks" do fluxo são as sub-issues; uma issue sem sub-issues é a própria task.

## Adaptador GitHub

Use a CLI `gh`, no repo atual (`gh repo view --json nameWithOwner` dá `{owner}/{repo}`). Texto com acento, aspas ou várias linhas (corpo de PR, de issue, de comentário) vai por arquivo (`--body-file`), escrito com o Write tool: no Windows os shells estragam o texto passado como argumento.

- **Item pai e tasks**: `gh issue view <n> --json number,title,body,state` e `gh api repos/{owner}/{repo}/issues/<n>/sub_issues --paginate`. Sem sub-issues nativas, use a task list do corpo da issue pai (`- [ ] #<n>`).
- **Arestas de bloqueio**: `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by` para cada sub-issue. Complemente com linhas `Blocked by #<n>` / `Bloqueada por #<n>` no corpo.
- **Estado**: task fechada é issue com `state: CLOSED`.
- **Abrir PR em rascunho**: `gh pr create --draft --base <origem> --head <integradora> --title "#<n> — <título>" --body-file <arquivo>`, com uma linha `Closes #<x>` para a issue pai e para cada sub-issue. O comando imprime a URL do PR, a que vai para o `flow pr <n> draft --url`.
- **Marcar task concluída**: o `Closes` fecha as issues no merge do PR; durante a execução, comente na sub-issue `gh issue comment <x> --body "Integrada em <integradora> (<sha>)"`.
- **Criar task para depois** (achado que o usuário mandou deixar para depois): `gh issue create --title "..." --body-file <arquivo> --label needs-triage` e ligue como sub-issue da pai (`gh api repos/{owner}/{repo}/issues/<pai>/sub_issues -F sub_issue_id=<id numérico>`, o id de `gh api repos/{owner}/{repo}/issues/<x> --jq .id`).
- **Finalizar PR**: `gh pr ready <pr>`.
