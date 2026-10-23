# Orchestration with Orca worktrees

The `orca` mode of `/implement-pbi` (Azure DevOps) and `/implement-issue` (GitHub): the one they pick in an Orca terminal (`flow host` says `orca`), or when the owner passes `orca` after the number. The skill that pointed here provides the **tracker adapter**: how to read the parent Item and the Tasks, find the blocking edges, mark a Task done and open and finish the PR. Everything below is tracker-agnostic.

It is the Orca version of the Maestri flow (`~/.claude/docs/orchestration-maestri/README.md`). The result is the same, **a single PR** on an **integration branch**, but each Task runs in an **Orca worktree** with a **Claude Code Worker** started and supervised by the Orca's orchestrator (`orca orchestration worker-start`), instead of a Maestri floor. The owner sees each Worker in the Orca, can talk to it and approves each integration. The Worker asks you with the `ask` of its preamble and delivers with `worker_done`; you wait with `check --wait`.

Each step records the flow in **painel-maestro** with the `flow` CLI (section [Panel](#panel)); an Orca browser tab opens the Item's page in the panel.

## Language

This document is in English because it is a contract read by agents. Talk to the owner (the user) in Portuguese, and write in Portuguese everything you record in the panel: titles, context, options, recommendations, decisions, reasons, Finding descriptions, summaries and status texts. The Workers record their reports in Portuguese too (the `maestro-worker` skill says so). What you publish in the tracker (PR, comments, new items) is in Portuguese too, unless the repository's conventions in `docs/agents/` say otherwise. The CLI and script phrases quoted below are quoted verbatim, in Portuguese, as the `flow` and the scripts print them: match them as they are.

Domain terms use the code names of painel-maestro's glossary: **Item** (the parent issue or PBI), **Task**, **Worker**, **PendingDecision** (a pending decision that waits for the owner), **Stage**, **Finding**, **Host**. The Orca's own terms keep their names: a **Run** (the orchestrator's namespace and your inbox), an Orca **task** and a **Dispatch** (one attempt of an Orca task, the Worker's lifecycle authority).

## Roles

- **Maestro**: you, a Claude Code terminal in the Orca, in the repository's own worktree (the one `git worktree list` shows first), on the integration branch. Reads the graph, creates the worktrees, starts the Workers, answers them, reviews, integrates and talks to the user. Does not implement Tasks.
- **Worker**: a Claude Code terminal that `worker-start` opens in a Task's Orca worktree. Reads and follows the `implement` process and the `maestro-worker` skill (the briefing says so).

## Prerequisites (check before step 1)

If one of them fails, stop: tell the owner which one failed and offer the subagent mode (`/implement-issue <n> subagents` or `/implement-pbi <id> subagents`). Never switch modes on your own.

- This session runs in an Orca terminal: `node "$PAINEL_MAESTRO/bin/flow.js" host --json` says `"kind": "orca"` (`ORCA_TERMINAL_HANDLE` defined). A mode forced with `orca` outside the Orca fails here.
- The Orca runtime is up: `orca status --json` answers `"ok": true` with `result.runtime.state` `ready` (the same check is in `flow host --json`, `checks.orca_status.ok`).
- Claude Code's **Bypass Permissions** warning was accepted once on this machine. The Orca's `claude` agent opens with `--dangerously-skip-permissions`; without that acceptance the briefing's Enter falls on "No, exit", the Worker dies and `worker-start` answers `outcome_unknown`. If the owner is not sure, ask them to run `claude --dangerously-skip-permissions` once in any terminal, accept the warning and close it.
- `node "$PAINEL_MAESTRO/bin/flow.js" --help` exits with 0. If it fails because of `PAINEL_MAESTRO`, ask the user to define it (painel-maestro's README, "Definir `PAINEL_MAESTRO`"); without it the flow goes on, but nothing reaches the panel: say so in the final report.
- A clean maestro's worktree (`git status --porcelain` empty): the Orca worktrees start from the integration branch, and `integrate.sh` merges into it here.

## Panel

**`flow`**, in this document, is `node "$PAINEL_MAESTRO/bin/flow.js"`, run with Bash (Git Bash) from inside the repository: the CLI recognizes the project by `git remote origin` (also in an Orca worktree). Write the whole command on every call.

- **Who records**: you always pass `--role maestro --agent maestro`. The Worker records its own status and report (the `maestro-worker` skill). If you ever need to record a Task's status for it (its terminal died), run `node "$PAINEL_MAESTRO/bin/flow.js" status "..." --item <n> --task <task> --role maestro --agent maestro`: with `--role maestro` the CLI only records and never moves **your** worktree's card on the Orca board; it posts to the Orca only for a Worker.
- **Text with accents, quotes or several lines** (titles, context, options, summaries): write a UTF-8 JSON in the scratchpad with the Write tool and run `flow <command> --json - < <scratchpad>/<file>.json`. The JSON fields have the names in the help (`flow --help`, section "JSON PELA ENTRADA PADRÃO"); an argument wins over the JSON. A PowerShell pipe mangles the accents.
- **Exit codes**: 0 ok; **2** invalid data, the message says what to fix (fix it and run it again); **1** panel failure: do not stop the flow, note it and tell the user in the final report with the message.
- **Item key**: `<project>/<number>`, printed by `flow item start` (or by its refusal, the item "já foi iniciado"). The Item's page is `http://127.0.0.1:4777/#items/<project>/<number>`; it refreshes by itself every 20 s. What the panel computes (each Task's state, reports, PendingDecisions) is also in `curl -s http://127.0.0.1:4777/api/items/<project>/<number>`.
- **A PendingDecision** is everything that waits for the user. When taking a choice to them, open it with `flow pending open <n> --kind <kind> --title ... --context ... --option "A: ..." --option "B: ..." --recommendation ...` (prints `P-<id>`); in the Orca it also marks your worktree as unread in the sidebar, the owner's notice. When they answer in your terminal, `flow pending resolve P-<id> --decision "<what they decided>"`; if it no longer applies, `flow pending cancel P-<id> --reason ...`. The kinds are in the steps: `parallelize` (6), `worker_blocked` (8), `task_review` and `decision` (10), `finding` (13), `hml` (14). The PendingDecisions are not the Orca's gates (`gate-create`): the panel is the single record of them, the Orca is only transport.
- **Wait for the PendingDecision.** The user may answer in your terminal or in the panel (Pendências screen), and the panel does not notify you: right after **each** `pending open`, leave `node "$PAINEL_MAESTRO/bin/flow.js" pending wait P-<id>` running in the background (Bash with `run_in_background: true`, from inside the repository), one per PendingDecision, next to the orchestrator's `check --wait` (step 7). It only reads the panel, has no deadline and ends, with exit code 0, when the PendingDecision closes by any path; Claude Code wakes you up with its output, which says how it closed, the decision or the reason and who closed it. When it ends, go by the first line, which says how it closed:
  - **"resolvida com a decisão do dono"** and the line **"A decisão veio do painel"**: the decision is already recorded; go on with it and do **not** run `pending resolve` (it would exit with code 2, "já está resolvida");
  - **"resolvida com a decisão do dono"**, without that line: you are the one who recorded the answer (`pending resolve`, "Fechada por: maestro"); the notice repeats what you did; ignore it;
  - **"cancelada"** or **"resolvida pela integração da task"** (or by the approved HML, the replacement, the Item done): go on as usual (if you are the one who canceled it, the notice only repeats what you did);
  - exit code 2 (wrong id or another project's): fix it and run it again; exit code 1 (panel failure): nobody is waiting for that PendingDecision, so ask for the answer in your terminal and mention the message in the final report.

  In a new session on an Item already in progress, check its PendingDecisions on the Item's page: one answered in the panel while nobody was waiting already has the decision recorded; for each one still open, leave the `wait` running again.

## Orca

**`orca`**, in this document, is the Orca's CLI on the PATH (`orca --version`; the scripts take `ORCA_CLI` when it is defined). Run its commands with Bash (Git Bash), always with `--json`. Text that goes as an argument (`--spec`, `--body`, `--objective`) goes from a file written with the Write tool, as `--spec "$(cat <scratchpad>/<file>.txt)"`: Git Bash passes accents, quotes and line breaks to a Windows program intact (verified with `node`); a PowerShell pipe mangles accents.

The orchestrator's own guide is `orca skills get orchestration` (and `--reference references/<file>.md`; `--references` lists them): its skill is not visible to Claude Code, but the command works without installing it. This document is enough for the normal loop; read the guide's `recovery-and-cleanup` reference when a `worker-start` fails or a Worker stops answering.

## Orca facts (verified; do not repeat the mistake)

Verified on Orca 1.4.224 (2026-10-12), with throwaway Workers and worktrees, already removed.

- **The briefing arrives as pasted text**, after the Orca's own preamble (the Task and Dispatch IDs and the `ask`, `check` and `worker_done` commands): a slash command on its first line does not run. `mattpocock-skills:implement` is `disable-model-invocation`, so the Worker reads its `SKILL.md` and follows it, as `/specify` does with `to-spec`.
- **`worker-start --worktree new-child --name X` creates the branch `<GitHub user>/X`** at `~/orca/workspaces/<repo>/X`. `orca worktree create --name X` does the same (verified: branch `higorcesarqn/task-65-verif`). So the maestro creates the worktree, renames its branch to `task/<id>-<slug>` and only then starts the Worker in it (step 6).
- **The Orca follows a renamed branch** (verified: `orca worktree create --name task-65-verif --base-branch feature/issue-60 --parent-worktree id:<main worktree> --setup skip --json`, then `git -C <path> branch -m task/65-verif`). The worktree's id is `<repo-id>::<path>`, with no branch in it, so it does not change; `orca worktree show --worktree id:<id> --json` and `orca worktree list --json` show at once `branch: refs/heads/task/65-verif`, with the same `displayName` (`task-65-verif`) and parent; the selector `branch:task/65-verif` finds it too. `orca worktree rm --worktree id:<id> --json` answered `removed: true` and took the folder, the `git worktree list` entry, the branch `task/65-verif` and the worktree's terminal along.
- **`orca worktree create` without `--agent` still opens a terminal** in the new worktree (a plain shell); `worktree rm` closes it.
- The Orca's `claude` agent opens with `--dangerously-skip-permissions`; without the warning of that mode accepted once, the briefing's Enter falls on "No, exit" and `worker-start` answers `outcome_unknown` (see [Prerequisites](#prerequisites-check-before-step-1)).
- The Worker's terminal has `ORCA_TERMINAL_HANDLE`, `ORCA_WORKTREE_ID` and `TERM_PROGRAM=Orca`, and no `MAESTRI_*`; the Orca's task and Dispatch IDs come only in the preamble.
- The `orca-cli` and `orchestration` skills of the Orca are not visible to Claude Code; `orca skills get orchestration` works without installing anything.
- **`orca orchestration check --wait` returns the whole FIFO batch** (heartbeats included), whatever `--types` says (`--types` only decides when it wakes up), and replays the same batch until `--ack <delivery_id>`.
- **Just clicking on the Worker's terminal counts as `user_takeover`**: `worker-release` then answers `retained` and closes nothing. Whoever cleans up is `orca worktree rm`, which closes the terminal (retained or not) and deletes the branch (it keeps a branch it cannot prove merged: `integrate.sh` merges first, then removes).
- `worker-start` exits with 0 only for `ready`. On `failed` or `outcome_unknown` it exits with 1 and the JSON has `failedStage`, `residualResources` and the recovery commands: **do not relaunch it blindly**.
- **`git -C ""` acts on the current folder.** A worktree path held in a shell variable that comes out empty turns the branch rename into a rename of the maestro's own integration branch (PBI #3194, after an `rtk` hook rewrite left the variable unset). `scripts/create-worktree.sh` renames on the path the Orca answered and refuses when the maestro leaves the integration branch.
- **The `rtk` hook reformats `grep` in a pipeline** (its compact "N matches in 1 files" output), so `check --wait ... | grep -v _keepalive` breaks the JSON. `scripts/wait-workers.sh` skips the keep-alive lines in its own parser.
- **Each unacknowledged heartbeat costs the maestro a turn**: it reaches the maestro's terminal as "You have 1 orchestration message". `scripts/wait-workers.sh` wakes on heartbeats (`heartbeat` in its `--types`) and acknowledges heartbeat-only batches by itself; without `heartbeat` in `--types` the check never woke on them and every heartbeat reached the maestro (PBI #3202).

## Steps

1. **Read the graph.** Through the adapter, load the parent Item, the child Tasks, each one's state and the blocking edges. Read the repo's `docs/agents/` for local conventions (tracker states, test commands, test database, known failures of the suite). Record in the panel:
   - the Item, if `/specify` has not recorded it yet: `flow item start <n> --stage implementation` with the title through the JSON (`{"number": <n>, "title": "...", "stage": "implementation", "role": "maestro", "agent": "maestro"}`). A message saying the item "já foi iniciado" (exit code 2) means it is already there: move on. Keep the Item key the message carries;
   - the graph: `flow task graph --json - < graph.json` with `{"number": <n>, "tasks": [{"number": <task>, "title": "...", "blocked_by": [<task>, ...]}, ...]}`; a Task closed before this run or out of scope goes with `"out": true`. An Item without child Tasks has no graph: it is its own Task.

   Done when: each Task has a known state and blockers and the graph is in the panel.

2. **Explore (optional).** If the Tasks require understanding code, dispatch an explorer subagent (Agent tool) that saves markdown notes in the session's scratchpad. The Workers receive the path as a pointer.

3. **Prepare the integration branch.** First check that the origin branch is level with its remote (`git status -sb` shows no `ahead`): an unpushed local commit rides into the Item's PR and leaves the local branch diverged after a squash merge (PBI #3202); if it is ahead, ask the owner whether to push it first. From the origin branch (the user's when invoking the skill), create the integration branch (`feature/<type>-<id>` unless there is a local convention), push it and open the PR as a **draft** through the adapter, linked to the parent Item and the Tasks. Note the **origin SHA** (`git rev-parse --short HEAD` right after creating the branch): the briefings and the final adjustment's reviews take the range `<origin SHA>..HEAD`, because the origin branch keeps moving while the Item runs. Record: `flow pr <n> draft --url <PR URL> --branch <integration branch>`. Leave the integration branch checked out in your worktree: the Orca worktrees start from it.

4. **Bind a Run.** One Orca Run per Item: it is your inbox for the Workers' questions and reports.
   ```bash
   orca orchestration run-create --objective "<project>/<n> — <title>" --json
   ```
   Keep the Run's id, from the receipt, for the final report (`orca orchestration run-current --json` shows it again). In a **new session on the same Item**, do not create another one: find it in `orca orchestration run-list --json` (the objective carries the Item key) and bind this terminal to it with `orca orchestration run-use --id <run_id> --json`.

5. **Open the panel in the Orca.** With the panel's server up (`npm start` in painel-maestro's folder; ask the user if `http://127.0.0.1:4777` does not answer), open a browser tab in your worktree on the Item's page:
   ```bash
   orca tab create --url "http://127.0.0.1:4777/#items/<project>/<n>" --json
   ```
   The page shows the Tasks' graph and the table task / worktree and branch / worker / state / SHA, computed from what you and the Workers record; it refreshes by itself.

6. **Dispatch the frontier.** Frontier = open Tasks whose blockers are already integrated. Rules:
   - at most 3 Workers at the same time, unless the user asks otherwise;
   - a Task that produces a unique, sequential artifact (a database migration with a snapshot, a version number, a regenerated lockfile) runs **alone**;
   - two frontier Tasks that clearly touch the same flow: ask the user before parallelizing, with a `parallelize` PendingDecision (options: in parallel, in sequence);
   - each Task gets the exclusive resources the local convention asks for (e.g. its own test database per Task).

   For each Task, from your worktree, in this order:
   1. **Create the worktree** from the integration branch, as a child of yours, with the script:
      ```bash
      bash ~/.claude/docs/orchestration-orca/scripts/create-worktree.sh <id> <slug> <integration branch>
      ```
      It runs `orca worktree create --name task-<id>-<slug> --base-branch <integration branch> --parent-worktree current --json` and prints `worktree: <worktree id>`, `path: <worktree path>` and `branch: task/<id>-<slug>`: take the values from there. Exit 1 is a refusal that says why (`worktree: ...`); read it before anything else. On GitHub, link the issue to the worktree's card afterwards with `orca worktree set --worktree "id:<worktree id>" --issue <task> --json`.
   2. **The branch is already renamed**: the script renames the one the Orca created (`<GitHub user>/task-<id>-<slug>`) to `task/<id>-<slug>` on the path the Orca answered, and checks that your worktree is still on the integration branch. The `flow`, the hook and the usage per agent recognize the Task by that branch.
   3. **Record the dispatch**: `flow task dispatch <n> <task> --floor "task-<id>-<slug>" --worker "<worker>" --branch task/<id>-<slug> --mode orca --role maestro --agent maestro` (`--floor` takes the worktree's name). Give the Workers short, distinct code names (no accents).
   4. **Start the Worker**, with the briefing (template below) written with the Write tool to `<scratchpad>/brief-<id>.txt`:
      ```bash
      orca orchestration worker-start --spec "$(cat <scratchpad>/brief-<id>.txt)" --task-title "#<id> <title>" --worktree "id:<worktree id>" --agent claude --json
      ```
      It creates the Orca task and its Dispatch and pastes the briefing after the preamble. Keep the Dispatch id and the Worker's terminal handle from the receipt. Exit code 1 (`failed` or `outcome_unknown`): **do not relaunch**; read `failedStage` and `residualResources`, then `orca skills get orchestration --reference references/recovery-and-cleanup.md`. `outcome_unknown` right at the start is usually the Bypass Permissions warning not accepted (see [Prerequisites](#prerequisites-check-before-step-1)).

   Start the whole frontier before waiting.

7. **Wait for the Workers.** Do not keep polling and do not schedule wake-ups: leave the wait script running in the background (Bash with `run_in_background: true`), next to the `flow pending wait` of each PendingDecision:
   ```bash
   bash ~/.claude/docs/orchestration-orca/scripts/wait-workers.sh --run <run_id>
   ```
   It loops on `orca orchestration check --wait --types "worker_done,escalation,question,heartbeat"`, acknowledges by itself the batches with only heartbeats, and ends at the first **Delivery** with a real message, printed as `esperar: entrega <delivery_id> (...)` and one `--- <type> <message_id> · <subject>` block per message (payload and body below). That Delivery is not acknowledged: process **every** message of it, then leave the next wait running with its ack:
   ```bash
   bash ~/.claude/docs/orchestration-orca/scripts/wait-workers.sh --run <run_id> --ack <delivery_id>
   ```
   Exit 3 is three empty waits in a row (see below); exit 1, the CLI failed (its answer is on stderr). The script wakes on heartbeats too and acknowledges them, so an "orchestration message" notice in your terminal while it runs is rare; if one comes, run `orca orchestration check --run <run_id> --json` and, for a heartbeat-only batch, ack it with `--ack <delivery_id>`.
   - `heartbeat`: the Worker is alive; the script already acknowledged it.
   - `question`: step 8.
   - `escalation`: the Worker is blocked; treat it as a question that needs you or the user (step 8), answering with `orca orchestration send --to dispatch:<dispatch_id> --subject "..." --body "$(cat <file>)" --json`.
   - `worker_done`: check that its Task and Dispatch ids are the ones you started; then step 9 (the report). After you accept it, release the Worker's terminal with `orca orchestration worker-release --dispatch <dispatch_id> --json`: `retained` is a normal answer (the owner clicked on the terminal, a `user_takeover`); `integrate.sh` closes it with the worktree.

   After three empty waits in a row (the script's exit 3), look instead of waiting blindly: `orca orchestration worker-list --run <run_id> --json` and each row's `projection.liveness` and `projection.nextAction`. Only an `exited` Worker without `worker_done` is lost; `unverifiable` is not proof of anything: keep waiting. Before asking the user for any OK, check the panel too: a Task in `review` with no `worker_done` received has its report on the Item's timeline.

8. **Answer the Workers.** A Worker asks with the `ask` of its preamble and waits, blocked, for your answer:
   - **yours** (scope, the briefing, how something in the repo works): answer with `orca orchestration reply --id <message_id> --body "$(cat <scratchpad>/reply-<id>.txt)" --json`;
   - **the user's** (business rule, public contract, exposed name): open a `worker_blocked` PendingDecision with `--task <task>`, with the question and the Orca's `message_id` in the context, leave its `pending wait` running, ack the batch as usual and, when the PendingDecision closes, `reply` to that `message_id` with the decision. A Worker whose `ask` timed out resumes the same question by its id, so the late reply still reaches it.

9. **Read the report.** The Worker records its report in the panel (`flow report`) before sending `worker_done --report-path <the same JSON> --outcome succeeded|failed`. Read it on the Item's page (or the API in [Panel](#panel)); the JSON at `report-path` is the same text. `--outcome failed` is a Task that did not finish: read why before anything else. A report missing from the panel (the Worker's `flow report` failed) is in the JSON at `report-path`: say so in the final report.

10. **Review.** For each report: read the diff (`git log` / `git diff <integration branch>...task/<id>-<slug>`), check that the branch is on top of the integration branch (`git merge-base --is-ancestor <integration branch> task/<id>-<slug>`) and take to the user, with your recommendation for each:
    - what the Task delivered and the tests (with the database/environment used);
    - the decisions the Worker made;
    - the findings of your review.

    When taking it, open the Task's `task_review` PendingDecision (`--task <task>`, options such as "A: Integrar", "B: Pedir ajuste"): it resolves by itself when the Task is integrated; if the user asks for changes, resolve it with the decision (an answer in the panel arrives already resolved) and open another one on the next report. Each Worker decision the user needs to choose becomes a `decision` PendingDecision. A Finding of your review: `flow finding add <n> --title ... --classification defect|owner_decision|discarded --task <task>` (description through the JSON).

    **Asking for an adjustment**: the Worker's Dispatch already settled with its `worker_done`, so the adjustment is a new supervised attempt in the same worktree: `orca orchestration worker-start --spec "$(cat <adjustment brief>)" --task-title "#<id> ajuste" --worktree "id:<worktree id>" --agent claude --json` (a new Worker that reads the branch, the previous report on the panel and what to change), or, if you did not release the first one, `--terminal <its handle>` instead of `--agent claude` to reuse it.

    **A rule change midway**: before having a new rule approved by the user implemented, test it against the Item's states (e.g. under supervision, rejected, corrected) and tell the user the edge cases. A rule approved in a hurry was the origin of the most serious Finding of PBI #3100.

11. **Integrate, with the user's OK.** One Task at a time, from your worktree:
    ```bash
    bash ~/.claude/docs/orchestration-orca/scripts/integrate.sh task/<id>-<slug> <integration branch> [<n> <task>]
    ```
    The script refuses a dirty maestro's worktree, a Task worktree with uncommitted changes and a merge that is not a fast-forward. If it is not a fast-forward, start an adjustment (step 10) that asks for a rebase on the integration branch and a new gate, and run it again. After the push it records `flow task integrate` with the SHAs before and after (Item and Task come from `feature/<type>-<n>` and `task/<id>-…`; outside that convention, pass them as the 3rd and 4th arguments), then removes the Task's worktree with `orca worktree rm --worktree branch:task/<id>-<slug> --json`, which closes its terminals (the Worker's included, even `retained` by a `user_takeover`) and deletes the branch. The last line says `integrar: painel: task <task> integrada no item <n>`; if it says `integrar: aviso: o painel não registrou ...`, the integration stands and the command to record it comes right below: fix the cause and run it. `integrar: aviso: o Orca não removeu o worktree ...` also keeps the integration: run the `worktree rm` that comes below it. Then: mark the Task done through the adapter and tell the Workers still active that the integration branch moved (`orca orchestration send --to dispatch:<dispatch_id> --subject "Integradora andou" --body "..." --json`), asking for a rebase before the final commit.

12. **Recompute the frontier** and go back to step 6 until every Task is integrated or reported as blocked.

13. **Final adjustment.** Record `flow final-adjustment <n> open` and create its worktree with `create-worktree.sh <n> ajuste-final <integration branch>` (step 6: branch `task/<n>-ajuste-final`, with no `task dispatch`: the final adjustment is not a Task of the graph), then start a Worker in it with a briefing that asks, in this order, for:
    1. the fixes the user already approved for the end;
    2. the two reviews over the range `<origin SHA>..HEAD` (step 3), written out in the briefing with the SHA, after the Worker checks with `git log --oneline <origin SHA>..HEAD` that it holds exactly the Tasks integrated in this run: `mattpocock-skills:code-review` and the native `code-review` at the `medium` level. Tie-break: when a simplification finding contradicts a repo standard or the spec, the standard/spec wins. List in the briefing what the user already accepted in the reviews, so it is not raised again;
    3. classifying each finding: **a clear defect with no design choice** → fixed with a test; **depends on the user** → not fixed, brought with a recommendation; **discarded** → one line on why;
    4. the full suite, compared with the failures already known before calling anything a regression;
    5. the version bump, if the project's `docs/agents/` asks for a version bump in the final adjustment;
    6. one commit.

    In the final adjustment's briefing, tell the Worker that it follows the `maestro-worker` skill's final adjustment rule (status straight through `orca worktree set`, no `flow report`; the report goes in the `worker_done`'s JSON). With the report: record each Finding with `flow finding add` (`defect`, `owner_decision` or `discarded`); a Finding left for later becomes a new item through the adapter, linked with `--new-task <number of the created item>`. Take the "depends on the user" Findings to the user, each with a `finding` PendingDecision; whatever they approve, a new attempt in the same worktree applies in one more commit (step 10, "Asking for an adjustment"). Integrate with `integrate.sh` (on the final adjustment's branch it does not record a Task and reminds you of the next command) and record the result: `flow final-adjustment <n> result --outcome passed|failed --summary ...` (`passed` when the suite is green apart from the known failures and the defects were fixed).

14. **Finish.** Update the PR description (what each Task delivered, rules decided in the review, what changes for whoever consumes the API, tests, what was left for later) and take it out of draft through the adapter; record `flow pr <n> ready`. The merge belongs to the user; if they ask you to do it, record `flow pr <n> merged` afterwards. Mark the parent Item done in the tracker, if the local convention says so. The Item is only **Concluído** in the panel (`flow item done <n>`) after the merge and, if the project uses HML Validation, after the HML is recorded: if the session ends before that, these commands go into the report as the user's next steps.

    **HML reminder**: HML validation follows the `atdd-spec` skill; the result goes to the panel with `flow hml <n> --passed <n> --failed <n> --blocked <n> --card <card URL> --role owner` (a failed or blocked scenario that waits for a decision: an `hml` PendingDecision).

15. **Clean up.** No Task worktree left in `orca worktree list --json` nor in `git worktree list` (only your worktree and the ones that are not this Item's); no local `task/*` branch; `orca orchestration worker-list --run <run_id> --terminal-state reclaimable --json` returns none (a `retained` terminal was closed by `worktree rm`). Report: the PR link, the Item's page in the panel, the Run's id, integrated Tasks, blocked Tasks, new items opened, PendingDecisions still open and what was not recorded in the panel (with the CLI's message).

## Briefing template

There is **no slash command**: the Orca pastes the briefing after its preamble, and a `/` on the first line would not run. The first lines say what to read and follow; the rest are pointers, not text copied from the tracker.

```text
You are the worker of the Orca worktree "task-<id>-<slug>", on branch task/<id>-<slug>, created from the integration branch <integration branch> at <sha>. The maestro is the coordinator of this Orca Run: ask it with the ask command of the preamble above.
Follow the maestro-worker skill: its common rules and its Orca section. In it, read and follow the implement process: the SKILL.md of mattpocock-skills:implement, found with the Glob ~/.claude/plugins/cache/*/mattpocock-skills/*/skills/engineering/implement/SKILL.md (the highest version), for <tracker> <id>.

PANEL
- Item <n>, task <id>, code name "<worker>" (status and report through the flow, as the skill says)

READING
- The task and the parent item: <the adapter's read command>
- Explorer notes: <path, if any>
- Project memory: <absolute path of MEMORY.md> (and the files that matter for this task)
- What is already on the integration branch: git log <origin SHA>..HEAD (origin SHA from step 3)

SCOPE
<what the task delivers, the agreed test points, what to reuse>
DO NOT: <what belongs to other tasks>

DECISIONS ALREADY APPROVED BY THE USER
<a short list, or "none">

EXCLUSIVE RESOURCES OF THIS TASK
<e.g. test database db_<...>_<id>; never the shared one; the worktree is a fresh checkout: install the dependencies the repo's docs/agents/ ask for>

IN PARALLEL
<other active worktrees and the files they touch, or "none">
```
