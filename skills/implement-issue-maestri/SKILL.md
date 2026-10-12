---
name: implement-issue-maestri
description: "Implements a GitHub issue and its sub-issues in one PR, with one Maestri floor and one Claude Code terminal per sub-issue, recording the flow in painel-maestro. Use only inside Maestri, as the maestro on the Ground."
disable-model-invocation: true
---

The user passed the number of a GitHub parent issue (the **Item**). Follow the flow in `~/.claude/docs/orchestration-maestri/README.md`, using this file as the **tracker adapter**. Type in the branch: `issue` (e.g. `feature/issue-10`). The flow's **Tasks** are the sub-issues.

Outside Maestri (no `$MAESTRI_CLI`, or no Maestro Mode on the Ground), stop and suggest `/implement-issue`, which uses subagents (its flow is in `~/.claude/docs/orchestration-subagents/README.md`).

Talk to the owner (the user) in Portuguese, and write in Portuguese what you record in the panel (titles, context, options, decisions, summaries, reports); the document above says more.

## GitHub adapter

Use the `gh` CLI, in the current repo (`gh repo view --json nameWithOwner` gives `{owner}/{repo}`). For text with accents on Windows, pass the body through a file (`--body-file`), not as an argument.

- **Numbers in the panel**: the Item is the parent issue's number; each Task, the sub-issue's number. An issue without sub-issues is its own Task (no `flow task graph`).
- **Parent Item and Tasks**: `gh issue view <n> --json number,title,body,state,comments` and `gh api repos/{owner}/{repo}/issues/<n>/sub_issues --paginate`. Without native sub-issues, use the task list in the parent issue's body (`- [ ] #<n>`).
- **Blocking edges**: `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by` for each sub-issue. Complement it with `Blocked by #<n>` / `Bloqueada por #<n>` lines in the body.
- **State**: a closed Task is an issue with `state: CLOSED`, or a sub-issue already integrated in this run (a comment "Integrada em ...", and `integrated` in the panel).
- **Read command for the Worker's briefing**: `gh issue view <x> --json number,title,body,comments` and the same for the parent issue.
- **Mark a Task done**: the PR's `Closes` closes the issues when it is merged; during the run, comment on the sub-issue `gh issue comment <x> --body "Integrada em <integration branch> (<sha>)"`.
- **Edit text** (a rule that changed in the review): `gh issue edit <n> --body-file body.md`, then `gh issue view` to check.
- **Create an item** (a Finding left for later): `gh issue create --title "..." --body-file body.md --label needs-triage` and link it as a sub-issue of the parent (`gh api repos/{owner}/{repo}/issues/<parent>/sub_issues -f sub_issue_id=<numeric id>`). The number of the created issue is the `--new-task` of `flow finding`.
- **Open the draft PR**: `gh pr create --draft --base <origin branch> --head <integration branch> --title "#<n> — <title>" --body-file body.md`, with a `Closes #<x>` line for the parent issue and for each sub-issue. The URL it prints is the `--url` of `flow pr <n> draft`.
- **Finish the PR**: `gh pr edit <pr> --body-file final-body.md` and `gh pr ready <pr>`.
- **Card link** (`flow hml --card`): `https://github.com/{owner}/{repo}/issues/<n>`.
