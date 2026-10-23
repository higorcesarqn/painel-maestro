# Orchestration with one subagent per Task

The `subagents` mode of `/implement-pbi` (Azure DevOps) and `/implement-issue` (GitHub): the one they pick in a plain terminal, or when the owner passes `subagents` after the number. The skill that pointed here provides the **tracker adapter**: how to read the parent Item and the Tasks, how to find the blocking edges, how to open and finish the PR. Everything below is tracker-agnostic.

**Prerequisites**: none of the Host's. This mode runs in any terminal, including one of the Orca or the Maestri (the owner forced it there): the [Panel](#panel) section says what changes then.

The goal is **a single PR** that implements the whole parent Item, on a single **integration branch**. You are the **maestro**: you read the graph, dispatch, integrate and review; the subagents implement. Every step of the flow is recorded in painel-maestro with the `flow` CLI (section [Panel](#panel)).

## Language

This document is in English because it is a contract read by agents. Talk to the owner (the user) in Portuguese, and write in Portuguese everything you record in the panel: titles, context, options, recommendations, decisions, reasons, Finding descriptions, summaries, status texts and reports (the implementer's report included: say so in its prompt). What you publish in the tracker (PR, comments, new Tasks) is in Portuguese too, unless the repository's conventions in `docs/agents/` say otherwise. The CLI phrases quoted below are quoted verbatim, in Portuguese, as the `flow` prints them: match them as they are.

## Vocabulary

Domain terms use the code names of painel-maestro's glossary: **Item** (the parent issue or PBI), **Task**, **Worker** (here, the implementer subagent), **PendingDecision** (a pending decision that waits for the owner), **Stage**, **Finding**.

- **Task graph**: the Tasks are not a list of steps, they are nodes with blocking edges (`A blocks B`).
- **Frontier**: the open Tasks whose blockers have already been integrated. Only the frontier can be dispatched.
- **Integration branch**: the PR's branch, created from the **origin branch** (the branch the user was on when invoking the skill).
- **Context pointers**: item IDs, note paths, commit SHAs. Communication with subagents is sparse and done through pointers; the subagent reads the Item in the tracker instead of receiving copied text.
- **Item without Tasks**: an Item without children is its own Task; the Task's number is the Item's.

## Panel

Every panel command runs in Bash (Git Bash on Windows), from inside the project's repository (the CLI recognizes the project by `git remote origin`; a worktree works too):

```bash
node "$PAINEL_MAESTRO/bin/flow.js" <command> ...
```

In the steps below, `flow <command>` abbreviates that line. `node "$PAINEL_MAESTRO/bin/flow.js" --help` has every field.

- **Who records.** You record the graph, PR, dispatch, Task status, PendingDecisions, integration, Findings, final adjustment, ready PR and completion: the default role of `flow` is already maestro, and on `status` pass `--role maestro`. The implementer subagent records only its own report (`flow report`, in the contract of step 4).
- **Text with accents, quotes or several lines** (titles, context, summaries) goes as JSON: write a UTF-8 file in the scratchpad with the Write tool and redirect it, `flow <command> --json - < "<scratchpad>/file.json"`. Arguments win over the JSON, so numbers and short options can stay on the command line. A PowerShell pipe mangles the accents.
- **Status** with `--role maestro` only records the event, even if this session is in a terminal of the Maestri or the Orca: `flow status` posts to the environment only for a Worker, so it never touches your own floor or your own worktree's card.
- **PendingDecisions** are answered in this session or in the panel (Pendências screen). In the Maestri or the Orca, `pending open` also notifies the owner there (`maestri notify`, or your worktree marked as unread): leave it as it is, it is the owner's notice; the line about where to answer is only informative. The panel does not notify this session; you are the one who waits: right after **each** `pending open`, leave `flow pending wait P-<id>` running in the background (Bash with `run_in_background: true`, from inside the repository), one per PendingDecision. It only reads the panel, has no deadline and ends, with exit code 0, when the PendingDecision closes by any path; Claude Code wakes you up with its output, which says how it closed, the decision or the reason and who closed it. When it ends, go by the first line, which says how it closed:
  - **"resolvida com a decisão do dono"** and the line **"A decisão veio do painel"**: the decision is already recorded; go on with it and do **not** run `pending resolve` (it would exit with code 2, "já está resolvida");
  - **"resolvida com a decisão do dono"**, without that line: you are the one who recorded the answer (`pending resolve`, "Fechada por: maestro"); the notice repeats what you did; ignore it;
  - **"cancelada"** or **"resolvida pela integração da task"** (or by the approved HML, the replacement, the Item done): go on as usual (if you are the one who canceled it, the notice only repeats what you did);
  - exit code 2 (wrong id or another project's): fix it and run it again; exit code 1 (panel failure): nobody is waiting for that PendingDecision, so ask for the answer in this session and mention the message in the final report.

  In a new session on an Item already in progress, check its PendingDecisions in the panel (Pendências screen or the Item's page): one answered in the panel while nobody was waiting already has the decision recorded; for each one still open, leave the `wait` running again.
- **Exit codes.** `0` ok. `2` is invalid data: the message says what to fix; fix it and run it again (expected cases are in the steps). `1` is a panel failure: go on with the flow, keep the message and pass it on to the user in the final report. The panel never stops the implementation.

## Steps

0. **Check the panel.** `node "$PAINEL_MAESTRO/bin/flow.js" --help >/dev/null && git remote get-url origin`. `PAINEL_MAESTRO` is the folder of painel-maestro's code (its README explains). If it fails, ask the user whether they define the variable now or the flow goes on without the panel; without the panel, skip the `flow` lines of the steps. Done when: both commands exited with 0, or the user decided to go on without the panel.

1. **Read the graph.** Through the adapter, load the parent Item, the child Tasks and the blocking edges. Read the repository's `docs/agents/`, if it exists, for local conventions (branch name, typecheck/test commands, tracker states). A Task without a declared edge is independent; if two independent Tasks clearly touch the same flow, ask the user before parallelizing. Done when: each Task has a state (open/closed) and a list of known blockers, and the panel has the Item and the graph:
   - Item: `flow item start --json - < item.json` with `{"number": <n>, "title": "<Item title>", "stage": "implementation"}`. A message saying the Item "já foi iniciado" (exit code 2) means `/specify` or an earlier run already recorded the Item: move on.
   - Graph (only if the Item has Tasks): `flow task graph --json - < graph.json` with `{"number": <n>, "tasks": [{"number": 12, "title": "..."}, {"number": 13, "title": "...", "blocked_by": [12]}, {"number": 11, "title": "...", "out": true}]}`. Every Task of the Item goes in; the ones already closed in the tracker go with `"out": true`, and the blocking edges through them stay in the graph.
   - Parallelize: the question to the user is a PendingDecision, `flow pending open <n> --kind parallelize --json - < pending.json` with `title`, `context`, `options` (a list, e.g. `"A: em paralelo"`, `"B: 13 depois da 12"`) and `recommendation`. The CLI prints the id `P-<id>`; leave `flow pending wait P-<id>` running in the background (Panel section). With the answer in this session, `flow pending resolve P-<id> --json - < decision.json` with `{"decision": "..."}`; an answer in the panel arrives already recorded, through the end of the `wait`. Other questions to the user during the flow follow the same pair, with `--kind decision`.

2. **Explore (optional).** If the Tasks require understanding code or external documentation, dispatch an **explorer subagent** that saves markdown notes in the session's scratchpad (outside the repo). The implementers receive the path of those notes as a pointer.

3. **Prepare the integration branch.** First check that the origin branch is level with its remote (`git status -sb` shows no `ahead`): an unpushed local commit rides into the Item's PR and leaves the local branch diverged after a squash merge (PBI #3202); if it is ahead, ask the owner whether to push it first. From the origin branch, create the integration branch (pattern `feature/<type>-<id>` unless there is a local convention), push it and open the PR as a **draft** through the adapter, linked to the parent Item and all the Tasks. Leave the integration branch checked out in the main directory: the worktrees start from it and the merges happen on it. Done when: the PR exists as a draft and the panel recorded it with `flow pr <n> draft --url <PR URL> --branch <integration branch>` (the browser URL, as the adapter says).

4. **Dispatch the frontier.** For each Task in the frontier, record the dispatch and then call an **implementer subagent** through the Agent tool with `isolation: "worktree"` and `run_in_background: true`. Maximum concurrency: 3 at once, unless the user asks otherwise. The implementer's prompt carries only pointers (Item number, Task number, the adapter's read command for the Worker's briefing, path of the notes) and the contract below.

   Dispatch: `flow task dispatch <n> <task> --worker subagente --branch task/<task> --mode subagents` (the Task becomes "trabalhando" in the panel; always pass `--mode`, because without it the `flow` takes the mode of the Host and, in the Orca or the Maestri, would record the wrong one).

   The implementer's contract:
   - Create the `task/<id>` branch in the worktree, from the current HEAD of the integration branch.
   - Install dependencies in the worktree with the repo's lockfile command (`npm ci`, `pnpm i --frozen-lockfile`, ...).
   - Read Task `<id>` and the parent Item in the tracker, with the read command in the prompt, and the explorer's notes, if any.
   - Implement with the `mattpocock-skills:tdd` skill at the agreed seams; run typecheck and the tests of the files touched.
   - Commit on `task/<id>` with a message referencing the Task.
   - Record the report in the panel before answering: write with the Write tool a UTF-8 JSON outside the repository with `status` (`ok` | `blocked`), `blocked_reason`, `tests` (what ran and the result), `changes` (what changed), `decisions` (a list), `risks`, `shared_files` (a list of the shared files touched) and `text` (the whole report), all in Portuguese, and run, from inside the worktree, `node "$PAINEL_MAESTRO/bin/flow.js" report --item <n> --task <id> --json - < <file>` (branch and SHA come from the worktree). Exit code 2: fix the JSON and run it again; exit code 1: go on and mention the message in the answer. `report` is the implementer's only panel command.
   - Answer only: branch name, final SHA, status (`ok` | `bloqueado: <motivo>`), conflict risks (shared files touched: routes, reducer/saga registration, menus, configs) and, if there was one, the `report` failure.

5. **Integrate each completion.** When an implementer answers:
   - `ok`: record `flow status "<one-line summary>" --item <n> --task <id> --state done --role maestro` (the Task becomes ready to integrate). Note the current SHA of the integration branch (`git rev-parse HEAD`) and dispatch a **merge subagent** (foreground, one at a time; merges never run in parallel) that runs `git merge --no-ff task/<id>` on the integration branch, resolves conflicts with the `mattpocock-skills:resolving-merge-conflicts` skill, runs typecheck, pushes and answers the merge SHA. Record `flow task integrate <n> <id> --sha <merge SHA> --sha-before <noted SHA>` and mark the Task done through the adapter.
   - `bloqueado`: record `flow status "<reason>" --item <n> --task <id> --state blocked --role maestro`, open `flow pending open <n> --kind worker_blocked --task <id> --json - < pending.json` (with `title`, `context`, `options`, `recommendation`), leave its `wait` running and take the reason to the user. With the decision in this session, `flow pending resolve P-<id> ...` (one from the panel arrives already recorded); if the PendingDecision no longer applies, `flow pending cancel P-<id> --reason "..."`. A new dispatch of the Task goes back to step 4.

6. **Recompute the frontier.** After each integration, newly unblocked Tasks join the frontier: dispatch them (step 4). Repeat 4–6 until every Task is integrated. Done when: every Task in the graph is integrated (in the panel too) or was reported to the user as blocked.

7. **Review.** Run the full test suite. Then, on the integration branch against the origin branch, run the two reviews in sequence:
   1. The `mattpocock-skills:code-review` skill: Standards + Spec, checks the diff against the repo's standards and against each Task.
   2. The `code-review` skill (Claude Code's native one) at the `medium` level: correctness bugs, reuse and simplification. Typical pitfalls of this flow: helpers duplicated across Tasks and conflicts resolved to the wrong side in the merge.

   Consolidate the findings into a single list. **Tie-break**: when a simplification finding contradicts a repo standard or the spec, the standard/spec wins. Record each Finding of the list with `flow finding add <n> --json - < finding.json` (`title`, `description`, `classification`, and `task` when the Finding comes from a Task):
   - `defect`: fixed now, in the final adjustment.
   - `owner_decision`: depends on the user; open `flow pending open <n> --kind finding` and ask. If they decide it becomes a Task for later, create it through the adapter and link it with `flow finding link <n> <finding> --new-task <number> --new-task-title "..."` (it shows up in the Item as "fora", for triage).
   - `discarded`: what the tie-break or the analysis discarded.

   Open the final adjustment with `flow final-adjustment <n> open` and dispatch **a single** implementer (no worktree, on the integration branch) with the list of `defect` (and whatever the user said to fix now) to fix everything, run typecheck and tests, and push. If the project's `docs/agents/` asks for a version bump in the final adjustment, the implementer's briefing includes the bump. Record the result with `flow final-adjustment <n> result --outcome passed|failed --json - < adjustment.json` (`{"summary": "..."}`; `passed` when the tests ended green). Done when: the tests passed after the fixes and the result is recorded.

8. **Finish.** Take the PR out of draft through the adapter and record `flow pr <n> ready`.

9. **Clean up.** Remove every worktree and local `task/*` branch created in this run (`git worktree list` to check; `git worktree prune`). Report to the user: the PR link, integrated Tasks, blocked Tasks, the Item's page in the panel (`http://127.0.0.1:4777/#items/<key>`, with the key the `flow` prints, e.g. `painel-maestro/10`; if it said it registered the project in "Sem organização", say the project is moved in the panel) and each `flow` command that failed, with the message.

## After the PR is ready

The merge usually happens in the tracker's interface, and the panel detects it by itself. When these moments happen in this session (or in a resumption at the user's request), record:

- **A merge done by you**, at the user's request: `flow pr <n> merged`.
- **HML validation**, when the user validates with the `atdd-spec` skill (it does not record in the panel): `flow hml <n> --passed <n> --failed <n> --blocked <n> --card <card URL> --json - < hml.json` (`{"summary": "..."}`); if the user is the one who validated, `--role owner`.
- **Completion**, when the Item finished the project's flow (merged and, if the project uses it, validated in HML): `flow item done <n>`.

A Stage the project does not use exits with code 2: skip the command.
