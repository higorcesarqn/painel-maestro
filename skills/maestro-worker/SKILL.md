---
name: maestro-worker
description: "The Worker's protocol in a visible terminal (a Maestri floor or an Orca worktree): implement one task on its own branch, with no push and no tracker changes, record status and report in painel-maestro and report to the maestro. Use when the briefing says you are the worker of a Maestri floor or of an Orca worktree."
---

You implement **one** Task in a git worktree of your own (a Maestri floor or an Orca worktree), on a `task/<id>-<slug>` branch created from the integration branch. Whoever dispatches, integrates and talks to the user is the **maestro**, another Claude Code terminal. The briefing you received has the Task, the Item and your code name (the PANEL line), the reading pointers, the scope, the decisions already approved, the exclusive resources and the Workers running in parallel.

The briefing says which **Host** you are in. Follow the common rules below and the section of your Host: [Maestri](#maestri) or [Orca](#orca). In the subagent mode there is no such terminal: the subagent's contract is in its prompt, not in this skill.

## Language

This skill is in English because it is a contract read by agents. Talk to the owner (the user) in Portuguese if they talk to you, and write in Portuguese everything you record in the panel (status texts, reports) and the report you send to the maestro. Commit messages follow the repository's conventions (`docs/agents/`); without one, Portuguese.

## Panel

**`flow`**, in this skill, is `node "$PAINEL_MAESTRO/bin/flow.js"`, run with Bash (Git Bash) inside your worktree, always with `--agent "<your code name>"` (the default role of `status` and `report` is already `worker`). The Task comes from the worktree's branch; if the CLI answers that it is ambiguous or was not found (exit code 2), add `--item <n> --task <id>` from the briefing's PANEL line.

- **Status**: `flow status "<text>" [--state working|blocked|review] [--progress n/m]`. It records the status in the panel and posts it in your Host (your Host's section says how). Text with accents or quotes goes as JSON: write with the Write tool, in your session's scratchpad (outside the worktree), `{"text": "...", "state": "...", "progress": "n/m", "agent": "..."}` and run `flow status --json - < <file>`.
- **Exit codes**: 0 ok; 2 invalid data, the message says what to fix; 1 failure: if the panel did not answer (e.g. `PAINEL_MAESTRO` not defined), your Host's section says how to post the status without the panel, and you mention the failure in the report; if only the Host's command failed, the status was recorded in the panel and you go on.

## Common rules

1. **Status.** When you start: `flow status "Lendo a #<id>"`. At real milestones: `flow status "<where you are>" --progress n/m`. If you need the user: `--state blocked`. Ready to integrate: `--state review`.
2. **Read first.** Read the Task and the parent Item with the briefing's command, the repo's `docs/agents/` and the project memory the briefing points to (this worktree does not load it by itself). Read what is already on the integration branch (the `git log` given).
3. **Only your Task.** What the briefing marks as another Task's is not done here. If your design needs to anticipate something for it, leave only what is needed and say so in the report.
4. **Exclusive resources.** Use only the resources the briefing reserved for you (e.g. the Task's test database, recreated empty before each run). Never the shared resource.
5. **Tests.** TDD at the agreed seams. Before the commit: the module's suite and the integration tests in scope, **two runs in a row** when there is a database. A failure that existed before your change is not a regression: compare with the base (the local convention usually lists the known failures).
6. **Review before the commit.** `/implement` ends with `/code-review`; fix the findings that are yours.
7. **Commit on your worktree's branch**, semantic, citing the Task. **Do not push, do not touch the tracker, do not merge.**
8. **Rebase when the maestro asks.** If the integration branch moves, `git rebase <integration branch>`, run the tests again and report the new SHA (a new report through `flow report`, as below).
9. **A decision that is not yours** (business rule, public contract, exposed name): do not guess. Post `--state blocked` and ask the maestro (your Host's section says how), or decide the minimum and bring it in the report as a "decision for the user".
10. **Do not schedule wake-ups or loops** (`/loop`, `ScheduleWakeup`, routines). The maestro is the one who waits.
11. **A production behavior change outside the scope** (a bug found along the way): stop, `--state blocked`, tell the maestro before fixing it.

## Report

When you finish, or if you get stuck, in this order:

1. Post `flow status "<summary>" --state review` (or `blocked`).
2. **Record the report in the panel** before sending it: write with the Write tool, in your session's scratchpad, a UTF-8 `report.json` and run `flow report --json - < <scratchpad>/report.json`. Branch and SHA come from the worktree.
   ```json
   {"status": "ok", "blocked_reason": "", "tests": "...", "changes": "...", "decisions": ["...", "..."], "risks": "...", "shared_files": ["..."], "agent": "<code name>", "text": "<the whole report, as it goes to the maestro>"}
   ```
   `status` is `ok` or `blocked` (with `blocked_reason`). Exit code 1: go on to step 3 and mention the failure in the report.
3. Deliver it to the maestro, with the same text as the `text` field, the way your Host's section says.

The report, in Portuguese, short running text, in this order:

- **Task, branch, final SHA** and whether it is on top of the integration branch (no push, no tracker, no merge). **Status:** `ok` or `bloqueado: <motivo>`.
- **Tests:** what ran and the result, with the database/environment used and the two runs; the comparison with the base, if something failed.
- **What changed**, in a few lines, from the point of view of whoever uses it.
- **Decisions you made**, numbered, for the maestro to take to the user.
- **Risks and pending work** of other Tasks that you saw.
- **Shared files** with the Tasks running in parallel or the next ones (conflict risk).

## Maestri

You are on a Maestri **floor**; the maestro is a Claude Code terminal on the workspace's Ground, with the name the briefing gave.

- **Status**: `flow status` also runs `maestri floor status` for you (your terminal has `MAESTRI_TERMINAL_ID`). Without the panel (exit code 1, the panel did not answer), post the same status directly with `"$MAESTRI_CLI" floor status "<text>" [--state ...] [--progress n/m]`.
- **Asking the maestro** (common rule 9): `maestri ask "<maestro>" "<question>"`, after posting `--state blocked`.
- **Delivering the report** (step 3 of the Report): answer the maestro by the name the briefing gave:
  ```bash
  maestri ask "<maestro>" "<report>"
  ```
  Use `"$MAESTRI_CLI"` if `maestri` is not on the PATH.
- **Final adjustment floor** (branch `task/<id>-ajuste-final`): it is not a Task in the panel. Post the status directly with `"$MAESTRI_CLI" floor status` and skip step 2 of the Report; the maestro records the result.

## Orca

> To be written in #65, the ticket of the Orca flow (`orchestration-orca`, in `~/.claude/docs/`). Until then, there is no Orca flow that dispatches Workers.

What is already known: your terminal has `ORCA_TERMINAL_HANDLE` and `ORCA_WORKTREE_ID`, and `flow status` moves your worktree's card on the Orca board (`orca worktree set --workspace-status`). If a briefing ever sends you here before #65, follow the common rules, record the report with `flow report` and deliver it the way the briefing says.
