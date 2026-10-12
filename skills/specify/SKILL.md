---
name: specify
description: "Specifies a new Item (a GitHub issue or an Azure DevOps PBI) with grill-with-docs → to-spec → to-tickets and records its Stages in painel-maestro."
disable-model-invocation: true
---

You run the specification of an **Item** from start to finish: grill, spec, tickets. At two points you record the Item's Stage in the panel with painel-maestro's `flow` CLI: **specification** as soon as the Item exists in the tracker, and **implementation** when the tickets are published. The text the user passed along with the command is the starting point of the grill.

## Language

This skill is in English because it is a contract read by agents. Talk to the owner (the user) in Portuguese, and write in Portuguese everything you record in the panel (titles, context, options, decisions, summaries, reports). What you publish in the tracker (the Item, the tickets, comments) is in Portuguese too, unless the repository's conventions in `docs/agents/` say otherwise. The CLI phrases quoted below are quoted verbatim, in Portuguese, as the `flow` prints them: match them as they are.

Domain terms use the code names of painel-maestro's glossary: `Item`, `Task`, `Worker`, `PendingDecision`, `Stage`, `Finding`.

## 0. Prerequisites

Check before starting the grill, with Bash (Git Bash on Windows):

```bash
node "$PAINEL_MAESTRO/bin/flow.js" --help >/dev/null && git remote get-url origin
```

- `PAINEL_MAESTRO` is the folder of painel-maestro's code (the repository, not the data folder). If the command fails because of it, stop and ask the user to define it (painel-maestro's README explains how); without it the Item never reaches the panel.
- The current folder is the project's repository: the CLI recognizes the project by `git remote origin`. In an Azure DevOps project with several repositories, any of them will do.
- The tracker and the labels come from this repository's `docs/agents/issue-tracker.md`. Without that file, ask the user to run `/setup-matt-pocock-skills`.

**Done when** both commands exited with 0.

## 1. Grill

Do what `grill-with-docs` does: call the Skill tool twice, with `mattpocock-skills:grilling` and `mattpocock-skills:domain-modeling`, and follow both together on the user's request.

**Done when** every branch of the decision tree is resolved and the user agreed to move on to the spec.

## 2. Spec

Only the user can trigger `to-spec` (`disable-model-invocation`), so read its `SKILL.md` and follow it right here. Find the file with the Glob `~/.claude/plugins/cache/*/mattpocock-skills/*/skills/engineering/to-spec/SKILL.md` (if there is more than one version, the highest).

**Done when** the Item was published in the tracker and you have its **number** and **title** as they ended up there:

- GitHub: `gh issue create` prints the URL `.../issues/<number>`.
- Azure DevOps: the response of the work item `POST` has `id` (the PBI number) and `fields["System.Title"]`.

## 3. Record the specification Stage

Right after publishing, before anything else. The title almost always has accents, so it goes as JSON on standard input: write a UTF-8 file in the scratchpad with the Write tool and redirect it in Bash (a PowerShell pipe mangles the accents).

```json
{"number": 3100, "title": "Conciliação de boletos", "stage": "specification", "role": "maestro"}
```

```bash
node "$PAINEL_MAESTRO/bin/flow.js" item start --json - < "<scratchpad>/item-3100.json"
```

The CLI answers, for example, `Item cidax/3100 (PBI 3100) iniciado em Especificação.`: keep the key `cidax/3100` for the report. If it says it registered the project in "Sem organização", pass that on to the user at the end (they move the project in the panel).

- **Exit code 2**: invalid data; the message says what to fix. A message saying the Item "já foi iniciado" means an earlier attempt already recorded it: move on. A Stage the project does not use: tell the user and move on without recording it.
- **Exit code 1**: the panel failed. Go on with the specification and tell the user at the end, with the message.

**Done when** the CLI exited with 0 (or the case above was handled).

## 4. Tickets

`to-tickets` is also user-only: read `~/.claude/plugins/cache/*/mattpocock-skills/*/skills/engineering/to-tickets/SKILL.md` (the highest version) and follow it, with the Item from step 2 as the parent (sub-issues on GitHub, child tasks on Azure DevOps).

**Done when** every ticket the user approved is published, linked to the Item and with its blocking edges. If the user decides the Item needs no tickets (it is its own Task), the step also ends.

## 5. Record the implementation Stage

```bash
node "$PAINEL_MAESTRO/bin/flow.js" stage <number> implementation --role maestro
```

Exit codes are handled as in step 3.

## 6. Report

Give the user, in Portuguese:

- the Item (link in the tracker) and the published tickets, with the blocking edges;
- the Item's page in the panel: `http://127.0.0.1:4777/#items/<key>` (the key from step 3, e.g. `#items/cidax/3100`);
- what was not recorded in the panel and why, if something failed;
- the next step: implement the Item with the tracker's implementation skill (`/implement-issue <n>` or `/implement-pbi <id>`; it picks the mode from the Host, and a mode passed after the number, such as `subagents`, wins).
