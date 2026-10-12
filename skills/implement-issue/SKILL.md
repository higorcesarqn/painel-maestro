---
name: implement-issue
description: "Implements a GitHub issue and its sub-issues in one PR, one Worker per sub-issue, and records the flow in painel-maestro. Finds the Host with `flow host` and follows its flow (subagents, Maestri floors or Orca worktrees); a mode passed after the number wins."
disable-model-invocation: true
---

The user passed the number of a GitHub parent issue (the **Item**) and, optionally, a mode: `/implement-issue <n> [subagents|maestri|orca]`. Choose the mode (below) and follow that mode's flow, using this file as the **tracker adapter**. Type in the branch: `issue` (e.g. `feature/issue-10`). The flow's **Tasks** are the sub-issues; an issue without sub-issues is its own Task.

Talk to the owner (the user) in Portuguese, and write in Portuguese what you record in the panel (titles, context, options, decisions, summaries, reports); the flow's document says more.

## Mode

1. **Choose.** A mode passed after the number wins over the detection. Without it, run `node "$PAINEL_MAESTRO/bin/flow.js" host --json` (it does not need a repository) and take its `mode` (`subagents`, `maestri` or `orca`). If the `flow` does not run (e.g. `PAINEL_MAESTRO` not defined), read the variables it reads: `ORCA_TERMINAL_HANDLE` not empty → `orca`; otherwise `MAESTRI_TERMINAL_ID` not empty → `maestri`; otherwise `subagents`. Any other word after the number: ask the owner which mode they meant.
2. **Say it.** Tell the owner, in one line, the mode and whether it was passed or detected (e.g. "Modo: subagentes (detectado: terminal comum)").
3. **Follow the mode's flow:**
   - `subagents`: `~/.claude/docs/orchestration-subagents/README.md` (one subagent in a worktree per Task; it also runs inside the Orca or the Maestri);
   - `maestri`: `~/.claude/docs/orchestration-maestri/README.md` (one Maestri floor and one Claude Code terminal per Task);
   - `orca`: `~/.claude/docs/orchestration-orca/README.md` (one Orca worktree and one Claude Code Worker supervised by the Orca's orchestrator per Task).
4. **Prerequisites.** Each flow lists its prerequisites: check them before its step 1. If one fails, stop, tell the owner which one failed and offer the subagent mode. **Never switch modes on your own**: the owner decides, so they always know which mode the Item ran in.
5. **Every `flow task dispatch` passes `--mode <mode>`**, the mode chosen here, so the Item's page shows how each Task was dispatched.

## GitHub adapter

The same in every mode. Use the `gh` CLI, in the current repo (`gh repo view --json nameWithOwner` gives `{owner}/{repo}`). Text with accents, quotes or several lines (the body of a PR, an issue or a comment) goes through a file (`--body-file`), written with the Write tool: on Windows the shells mangle text passed as an argument.

- **Numbers in the panel**: the Item is the parent issue's number; each Task, the sub-issue's number. An issue without sub-issues is its own Task (no `flow task graph`).
- **Parent Item and Tasks**: `gh issue view <n> --json number,title,body,state,comments` and `gh api repos/{owner}/{repo}/issues/<n>/sub_issues --paginate`. Without native sub-issues, use the task list in the parent issue's body (`- [ ] #<n>`).
- **Blocking edges**: `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by` for each sub-issue. Complement it with `Blocked by #<n>` / `Bloqueada por #<n>` lines in the body.
- **State**: a closed Task is an issue with `state: CLOSED`, or a sub-issue already integrated in this run (a comment "Integrada em ...", and `integrated` in the panel).
- **Read command for the Worker's briefing**: `gh issue view <x> --json number,title,body,comments` and the same for the parent issue.
- **Open the draft PR**: `gh pr create --draft --base <origin branch> --head <integration branch> --title "#<n> — <title>" --body-file <file>`, with a `Closes #<x>` line for the parent issue and for each sub-issue. The command prints the PR URL, the one that goes to `flow pr <n> draft --url`.
- **Mark a Task done**: `Closes` closes the issues when the PR is merged; during the run, comment on the sub-issue `gh issue comment <x> --body "Integrada em <integration branch> (<sha>)"`.
- **Edit text** (a rule that changed in the review): `gh issue edit <n> --body-file <file>`, then `gh issue view` to check.
- **Create a Task for later** (a Finding the user decided to leave for later): `gh issue create --title "..." --body-file <file> --label needs-triage` and link it as a sub-issue of the parent (`gh api repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=<numeric id>`, the id from `gh api repos/{owner}/{repo}/issues/<x> --jq .id`). The number of the created issue is the `--new-task` of `flow finding link`.
- **Finish the PR**: `gh pr edit <pr> --body-file <final body file>` when the description changed, and `gh pr ready <pr>`.
- **Card link** (`flow hml --card`): `https://github.com/{owner}/{repo}/issues/<n>`.
