---
name: implement-issue
description: "Implements a GitHub issue and its sub-issues in one PR, with one subagent in a worktree per sub-issue, and records the flow in painel-maestro."
disable-model-invocation: true
---

The user passed the number of a GitHub parent issue (the **Item**). Follow the flow in `~/.claude/docs/orchestration-subagents/README.md`, using this file as the **tracker adapter**. Type in the branch: `issue` (e.g. `feature/issue-10`). The flow's **Tasks** are the sub-issues; an issue without sub-issues is its own Task.

Talk to the owner (the user) in Portuguese, and write in Portuguese what you record in the panel (titles, context, options, decisions, summaries, reports); the document above says more.

## GitHub adapter

Use the `gh` CLI, in the current repo (`gh repo view --json nameWithOwner` gives `{owner}/{repo}`). Text with accents, quotes or several lines (the body of a PR, an issue or a comment) goes through a file (`--body-file`), written with the Write tool: on Windows the shells mangle text passed as an argument.

- **Parent Item and Tasks**: `gh issue view <n> --json number,title,body,state` and `gh api repos/{owner}/{repo}/issues/<n>/sub_issues --paginate`. Without native sub-issues, use the task list in the parent issue's body (`- [ ] #<n>`).
- **Blocking edges**: `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by` for each sub-issue. Complement it with `Blocked by #<n>` / `Bloqueada por #<n>` lines in the body.
- **State**: a closed Task is an issue with `state: CLOSED`.
- **Open the draft PR**: `gh pr create --draft --base <origin branch> --head <integration branch> --title "#<n> — <title>" --body-file <file>`, with a `Closes #<x>` line for the parent issue and for each sub-issue. The command prints the PR URL, the one that goes to `flow pr <n> draft --url`.
- **Mark a Task done**: `Closes` closes the issues when the PR is merged; during the run, comment on the sub-issue `gh issue comment <x> --body "Integrada em <integration branch> (<sha>)"`.
- **Create a Task for later** (a Finding the user decided to leave for later): `gh issue create --title "..." --body-file <file> --label needs-triage` and link it as a sub-issue of the parent (`gh api repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=<numeric id>`, the id from `gh api repos/{owner}/{repo}/issues/<x> --jq .id`).
- **Finish the PR**: `gh pr ready <pr>`.
