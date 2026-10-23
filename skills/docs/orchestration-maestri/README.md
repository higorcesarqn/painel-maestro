# Orchestration with Maestri floors

The `maestri` mode of `/implement-pbi` (Azure DevOps) and `/implement-issue` (GitHub): the one they pick in a Maestri terminal (`flow host` says `maestri`), or when the owner passes `maestri` after the number. The skill that pointed here provides the **tracker adapter**: how to read the parent Item and the Tasks, find the blocking edges, mark a Task done and open and finish the PR. Everything below is tracker-agnostic.

It is the Maestri version of the subagent flow, described in `~/.claude/docs/orchestration-subagents/README.md`. The result is the same, **a single PR** on an **integration branch**, but each Task runs on a **floor** (a git worktree) with a **Claude Code terminal** visible on the canvas, instead of an invisible subagent. The user sees each Worker, can talk to it and approves each integration.

Each step records the flow in **painel-maestro** with the `flow` CLI (section [Panel](#panel)); the canvas portal opens the Item's page in the panel.

## Language

This document is in English because it is a contract read by agents. Talk to the owner (the user) in Portuguese, and write in Portuguese everything you record in the panel: titles, context, options, recommendations, decisions, reasons, Finding descriptions, summaries and status texts. The Workers record their reports in Portuguese too (the `maestro-worker` skill says so). What you publish in the tracker (PR, comments, new items) is in Portuguese too, unless the repository's conventions in `docs/agents/` say otherwise. The CLI and script phrases quoted below are quoted verbatim, in Portuguese, as the `flow` and the scripts print them: match them as they are.

Domain terms use the code names of painel-maestro's glossary: **Item** (the parent issue or PBI), **Task**, **Worker**, **PendingDecision** (a pending decision that waits for the owner), **Stage**, **Finding**.

## Roles

- **Maestro**: you, the terminal with Maestro Mode on, on the workspace's **Ground**. Reads the graph, opens the floors, reviews, integrates and talks to the user. Does not implement Tasks.
- **Worker**: a Claude Code terminal on a floor. Runs `/mattpocock-skills:implement` on a Task and follows the `maestro-worker` skill.
- **Boiler** (optional): a Shell terminal on the Ground for long-running processes (docker, server, database).

## Prerequisites (check before step 1)

If one of them fails, stop: tell the owner which one failed and offer the subagent mode (`/implement-issue <n> subagents` or `/implement-pbi <id> subagents`). Never switch modes on your own.

- This session runs in a Maestri terminal (`MAESTRI_TERMINAL_ID` defined; `flow host` says `maestri`) with Maestro Mode on, on the workspace's Ground. A mode forced with `maestri` outside the Maestri fails here.
- The Maestri workspace has **the git repository itself as its root**. With the root in a parent directory, the floor becomes a plain folder, with no worktree and no isolation: stop and ask the user for a workspace at the repo's root (`maestri workspace create "<name>" --dir <repo>`).
- `/.maestri/` in the repo's `.git/info/exclude`.
- `$MAESTRI_CLI` defined (the scripts use it, or `maestri` on the PATH).
- A clean Ground (`git status --porcelain` empty).
- `node "$PAINEL_MAESTRO/bin/flow.js" --help` exits with 0. If it fails because of `PAINEL_MAESTRO`, ask the user to define it (painel-maestro's README, "Definir `PAINEL_MAESTRO`"); without it the flow goes on, but nothing reaches the panel: say so in the final report.

## Panel

**`flow`**, in this document, is `node "$PAINEL_MAESTRO/bin/flow.js"`, run with Bash (Git Bash) from inside the repository: the CLI recognizes the project by `git remote origin` (also in a floor's worktree). Write the whole command on every call.

- **Who records**: you always pass `--role maestro --agent "<your name on the canvas>"`. The Worker records its own status and report (the `maestro-worker` skill). If you ever need to record a Task's status for it (its terminal died), run `node "$PAINEL_MAESTRO/bin/flow.js" status "..." --item <n> --task <task> --role maestro --agent "<your name>"`: with `--role maestro` the CLI only records; it posts to the Maestri only for a Worker.
- **Text with accents, quotes or several lines** (titles, context, options, summaries): write a UTF-8 JSON in the scratchpad with the Write tool and run `flow <command> --json - < <scratchpad>/<file>.json`. The JSON fields have the names in the help (`flow --help`, section "JSON PELA ENTRADA PADRÃO"); an argument wins over the JSON. A PowerShell pipe mangles the accents.
- **Exit codes**: 0 ok; **2** invalid data, the message says what to fix (fix it and run it again); **1** panel failure: do not stop the flow, note it and tell the user in the final report with the message.
- **Item key**: `<project>/<number>`, printed by `flow item start` (or by its refusal, the item "já foi iniciado"). The Item's page is `http://127.0.0.1:4777/#items/<project>/<number>`; it refreshes by itself every 20 s. What the panel computes (each Task's state, reports, PendingDecisions) is also in `curl -s http://127.0.0.1:4777/api/items/<project>/<number>`.
- **A PendingDecision** is everything that waits for the user. When taking a choice to them, open it with `flow pending open <n> --kind <kind> --title ... --context ... --option "A: ..." --option "B: ..." --recommendation ...` (prints `P-<id>`); when they answer in your terminal, `flow pending resolve P-<id> --decision "<what they decided>"`; if it no longer applies, `flow pending cancel P-<id> --reason ...`. The kinds are in the steps: `parallelize` (5), `worker_blocked` (6), `task_review` and `decision` (7), `finding` (10), `hml` (11).
- **Wait for the PendingDecision.** The user may answer in your terminal or in the panel (Pendências screen), and the panel does not notify you: right after **each** `pending open`, leave `node "$PAINEL_MAESTRO/bin/flow.js" pending wait P-<id>` running in the background (Bash with `run_in_background: true`, from inside the repository), one per PendingDecision. It only reads the panel, has no deadline and ends, with exit code 0, when the PendingDecision closes by any path; Claude Code wakes you up with its output, which says how it closed, the decision or the reason and who closed it. When it ends, go by the first line, which says how it closed:
  - **"resolvida com a decisão do dono"** and the line **"A decisão veio do painel"**: the decision is already recorded; go on with it and do **not** run `pending resolve` (it would exit with code 2, "já está resolvida");
  - **"resolvida com a decisão do dono"**, without that line: you are the one who recorded the answer (`pending resolve`, "Fechada por: maestro"); the notice repeats what you did; ignore it;
  - **"cancelada"** or **"resolvida pela integração da task"** (or by the approved HML, the replacement, the Item done): go on as usual (if you are the one who canceled it, the notice only repeats what you did);
  - exit code 2 (wrong id or another project's): fix it and run it again; exit code 1 (panel failure): nobody is waiting for that PendingDecision, so ask for the answer in your terminal and mention the message in the final report.

  In a new session on an Item already in progress, check its PendingDecisions on the Item's page: one answered in the panel while nobody was waiting already has the decision recorded; for each one still open, leave the `wait` running again.

## Maestri facts (verified; do not repeat the mistake)

- **`floor land` is not reliable**: in 7 out of 7 integrations it timed out, deleted the floor and **did not merge**. Integrate with `scripts/integrate.sh`, which merges with git, records the integration in the panel and then deletes the floor.
- **`floor create` times out** while it copies the untracked files, but it completes (the worktree shows as `locked` during the copy). `scripts/open-floor.sh` waits for it; never repeat the create without checking `floor list`.
- The floor becomes a worktree at `<repo-parent>\.maestri\floors\<repo>--<branch-without-slash>`, outside the repo.
- **Recruit without `--role`**: with a role, the terminal opens in `.maestri/roles/<id>/` and loses the repo's `AGENTS.md`/`CLAUDE.md`, skills and permissions.
- The Worker **does not load the project memory** (the project path is different). Point to `MEMORY.md` by absolute path in the briefing.
- `maestri ask` types the text into the Worker's terminal: a briefing that **starts with `/skill`** runs the slash command, and the rest of the message (several lines) becomes its argument. That is how the Worker runs `/mattpocock-skills:implement`, which can only be called by typing.
- The briefing's `ask` returns early, with a snapshot of the screen; it is not the report. The report arrives when the Worker runs `maestri ask "<maestro>" "..."`, and it shows up in your terminal as pasted text. Before that it records it in the panel (`flow report`), so a report that did not reach the terminal is on the Item's timeline.
- A folder outside a trusted project opens Claude Code's "trust this folder?" prompt, and the `ask` answers "no". Floors inside the repo do not have that.
- `maestri connect` only links note↔note/agent, with no direction and no cycles: it does not draw a dependency graph. The Tasks' graph and table are on the Item's page in the panel, opened in a **portal**.
- `portal check` fails when the portal is not visible on the canvas; check with `portal evaluate` if you need to.

## Steps

1. **Read the graph.** Through the adapter, load the parent Item, the child Tasks, each one's state and the blocking edges. Read the repo's `docs/agents/` for local conventions (tracker states, test commands, test database, known failures of the suite). Record in the panel:
   - the Item, if `/specify` has not recorded it yet: `flow item start <n> --stage implementation` with the title through the JSON (`{"number": <n>, "title": "...", "stage": "implementation", "role": "maestro", "agent": "..."}`). A message saying the item "já foi iniciado" (exit code 2) means it is already there: move on. Keep the Item key the message carries;
   - the graph: `flow task graph --json - < graph.json` with `{"number": <n>, "tasks": [{"number": <task>, "title": "...", "blocked_by": [<task>, ...]}, ...]}`; a Task closed before this run or out of scope goes with `"out": true`. An Item without child Tasks has no graph: it is its own Task.

   Done when: each Task has a known state and blockers and the graph is in the panel.

2. **Explore (optional).** If the Tasks require understanding code, dispatch an explorer subagent (Agent tool) that saves markdown notes in the session's scratchpad. The Workers receive the path as a pointer.

3. **Prepare the integration branch.** First check that the origin branch is level with its remote (`git status -sb` shows no `ahead`): an unpushed local commit rides into the Item's PR and leaves the local branch diverged after a squash merge (PBI #3202); if it is ahead, ask the owner whether to push it first. From the origin branch (the user's when invoking the skill), create the integration branch (`feature/<type>-<id>` unless there is a local convention) and push it. Do **not** open the PR yet: GitHub refuses a PR whose branch has no commit ahead of the base (`gh pr create`: "No commits between ..."), so the draft PR is opened right after the first integration (step 8). Leave the integration branch checked out on the Ground: the floors start from its HEAD.

4. **Open the panel on the canvas.** With the panel's server up (`npm start` in painel-maestro's folder; ask the user if `http://127.0.0.1:4777` does not answer), open a portal on the Item's page:
   ```bash
   "$MAESTRI_CLI" portal create "http://127.0.0.1:4777/#items/<project>/<n>" "Painel <type> <id>" --size 1100x640
   ```
   The page shows the Tasks' graph and the table task / floor and branch / worker / state / SHA, computed from what you and the Workers record; it refreshes by itself. The portal is the panel: do not keep a parallel note with the same table.

5. **Dispatch the frontier.** Frontier = open Tasks whose blockers are already integrated. Rules:
   - at most 3 floors working at the same time, unless the user asks otherwise;
   - a Task that produces a unique, sequential artifact (a database migration with a snapshot, a version number, a regenerated lockfile) runs **alone**;
   - two frontier Tasks that clearly touch the same flow: ask the user before parallelizing, with a `parallelize` PendingDecision (options: in parallel, in sequence);
   - each Task gets the exclusive resources the local convention asks for (e.g. its own test database per Task).

   For each Task: write the briefing (template below) to a scratchpad file, record the dispatch and open the floor, from the Ground:
   ```bash
   node "$PAINEL_MAESTRO/bin/flow.js" task dispatch <n> <task> --floor "<floor>" --worker "<worker>" --branch task/<id>-<slug> --mode maestri --role maestro --agent "<your name>"
   bash ~/.claude/docs/orchestration-maestri/scripts/open-floor.sh "<floor>" task/<id>-<slug> "<worker>" <scratchpad>/brief-<id>.txt <integration branch>
   ```
   The script creates the floor (waiting out the timeout), recruits the Worker without a role and sends the briefing in the background. Give the Workers short, distinct code names (no accents).

6. **Wait for the report.** Do not keep polling. The report arrives in your terminal. Before asking the user for any OK, run `maestri floor status --floor "<floor>"` on **all** active floors: a floor in `review` with no report received is a lost report (read it on the Item's timeline, through the [Panel](#panel) API, or with `maestri check "<worker>"`). A Worker in `blocked` that needs the user: open a `worker_blocked` PendingDecision with `--task <task>`, leave its `wait` running and resolve it with the answer, if it comes through your terminal.

7. **Review.** For each report: read the diff (`git log` / `git diff <integration branch>...task/<id>`), check that the branch is on top of the integration branch (`git merge-base --is-ancestor <integration branch> task/<id>`) and take to the user, with your recommendation for each:
   - what the Task delivered and the tests (with the database/environment used);
   - the decisions the Worker made;
   - the findings of your review.

   When taking it, open the Task's `task_review` PendingDecision (`--task <task>`, options such as "A: Integrar", "B: Pedir ajuste"): it resolves by itself when the Task is integrated; if the user asks for changes, resolve it with the decision (an answer in the panel arrives already resolved) and open another one on the next report. Each Worker decision the user needs to choose becomes a `decision` PendingDecision. A Finding of your review: `flow finding add <n> --title ... --classification defect|owner_decision|discarded --task <task>` (description through the JSON).

   **A rule change midway**: before having a new rule approved by the user implemented, test it against the Item's states (e.g. under supervision, rejected, corrected) and tell the user the edge cases. A rule approved in a hurry was the origin of the most serious Finding of PBI #3100.

8. **Integrate, with the user's OK.** One Task at a time:
   ```bash
   bash ~/.claude/docs/orchestration-maestri/scripts/integrate.sh "<floor>" task/<id>-<slug> <integration branch> [<n> <task>]
   ```
   The script refuses a dirty Ground, a floor with uncommitted changes and a merge that is not a fast-forward. If it is not a fast-forward, ask the Worker (still alive) for a rebase on the integration branch and a new gate, and run it again. After the push it records `flow task integrate` with the SHAs before and after (Item and Task come from `feature/<type>-<n>` and `task/<id>-…`; outside that convention, pass them as the 4th and 5th arguments). The last line says `integrar: painel: task <task> integrada no item <n>`; if it says `integrar: aviso: o painel não registrou ...`, the integration stands and the command to record it comes right below: fix the cause and run it. Then: mark the Task done through the adapter and tell the Workers still active that the integration branch moved, asking for a rebase before the final commit. **After the first integration**, open the PR as a **draft** through the adapter, linked to the parent Item and the Tasks, and record it: `flow pr <n> draft --url <PR URL> --branch <integration branch>`.

9. **Recompute the frontier** and go back to step 5 until every Task is integrated or reported as blocked.

10. **Final adjustment.** Record `flow final-adjustment <n> open` and open a floor `"<id> Ajuste"` (branch `task/<id>-ajuste-final`, with no `task dispatch`: the final adjustment is not a Task of the graph) with a briefing that asks, in this order, for:
    1. the fixes the user already approved for the end;
    2. the two reviews over the whole integration branch against the origin branch: `mattpocock-skills:code-review` and the native `code-review` at the `medium` level. Tie-break: when a simplification finding contradicts a repo standard or the spec, the standard/spec wins;
    3. classifying each finding: **a clear defect with no design choice** → fixed with a test; **depends on the user** → not fixed, brought with a recommendation; **discarded** → one line on why;
    4. the full suite, compared with the failures already known before calling anything a regression;
    5. the version bump, if the project's `docs/agents/` asks for a version bump in the final adjustment;
    6. one commit.

    In the final adjustment's briefing, tell the Worker that the status goes directly through `"$MAESTRI_CLI" floor status` and that it does not record a `flow report` (there is no Task to receive them). With the report: record each Finding with `flow finding add` (`defect`, `owner_decision` or `discarded`); a Finding left for later becomes a new item through the adapter, linked with `--new-task <number of the created item>`. Take the "depends on the user" Findings to the user, each with a `finding` PendingDecision; whatever they approve, the same Worker applies in one more commit. Integrate with `integrate.sh` (on the final adjustment's branch it does not record a Task and reminds you of the next command) and record the result: `flow final-adjustment <n> result --outcome passed|failed --summary ...` (`passed` when the suite is green apart from the known failures and the defects were fixed).

11. **Finish.** Update the PR description (what each Task delivered, rules decided in the review, what changes for whoever consumes the API, tests, what was left for later) and take it out of draft through the adapter; record `flow pr <n> ready`. The merge belongs to the user; if they ask you to do it, record `flow pr <n> merged` afterwards. Mark the parent Item done in the tracker, if the local convention says so. The Item is only **Concluído** in the panel (`flow item done <n>`) after the merge and, if the project uses HML Validation, after the HML is recorded: if the session ends before that, these commands go into the report as the user's next steps.

    **HML reminder**: HML validation follows the `atdd-spec` skill; the result goes to the panel with `flow hml <n> --passed <n> --failed <n> --blocked <n> --card <card URL> --role owner` (a failed or blocked scenario that waits for a decision: an `hml` PendingDecision).

12. **Clean up.** `maestri floor list` with only the Ground; `git worktree list` with only the repo; no local `task/*` branch. Report: the PR link, the Item's page in the panel, integrated Tasks, blocked Tasks, new items opened, PendingDecisions still open and what was not recorded in the panel (with the CLI's message).

## Briefing template

The **first line is the slash command**: it is what makes the Worker run `/implement`. The rest are pointers, not text copied from the tracker.

```text
/mattpocock-skills:implement <tracker> <id> — <task title>
You are the worker of the Maestri floor "<floor>", on branch task/<id>-<slug>, created from the integration branch <integration branch> at <sha>. The maestro is the terminal "<maestro name>". Follow the maestro-worker skill: its common rules and its Maestri section.

PANEL
- Item <n>, task <id>, code name "<worker>" (status and report through the flow, as the skill says)

READING
- The task and the parent item: <the adapter's read command>
- Explorer notes: <path, if any>
- Project memory: <absolute path of MEMORY.md> (and the files that matter for this task)
- What is already on the integration branch: git log <origin sha>..HEAD

SCOPE
<what the task delivers, the agreed test points, what to reuse>
DO NOT: <what belongs to other tasks>

DECISIONS ALREADY APPROVED BY THE USER
<a short list, or "none">

EXCLUSIVE RESOURCES OF THIS TASK
<e.g. test database db_<...>_<id>; never the shared one>

IN PARALLEL
<other active floors and the files they touch, or "none">
```
