---
name: implement-pbi
description: "Implements a whole Azure DevOps PBI in one PR, with one subagent in a worktree per task, and records the flow in painel-maestro."
disable-model-invocation: true
---

The user passed the ID of an Azure DevOps PBI (the **Item**). Follow the flow in `~/.claude/docs/orchestration-subagents/README.md`, using this file as the **tracker adapter**. Type in the branch: `pbi` (e.g. `feature/pbi-10`). A PBI without child tasks is its own **Task**.

Talk to the owner (the user) in Portuguese, and write in Portuguese what you record in the panel (titles, context, options, decisions, summaries, reports); the document above says more.

## Azure DevOps adapter

Use the `az` CLI with the `azure-devops` extension. Organization and project come from the repo's `docs/agents/` or from `az devops configure --list`; if neither is set, ask the user and configure them with `az devops configure --defaults organization=... project=...`.

- **Parent Item and Tasks**: `az boards work-item show --id <pbi> --expand relations`. Child tasks are the `System.LinkTypes.Hierarchy-Forward` relations; load each one with `az boards work-item show --id <task> --expand relations`.
- **Blocking edges**: on a task, the `System.LinkTypes.Dependency-Reverse` (Predecessor) relation points to what blocks it. Complement it with `Bloqueada por: #<id>` lines in the description (`System.Description`).
- **State**: a closed Task is one in a state of the Completed category (`Done`, `Closed`...). The project's done state comes from `docs/agents/` (or from the project's `--done-state` in the panel, `node "$PAINEL_MAESTRO/bin/flow.js" project list`); without a written convention, read it with `az boards work-item show` on an item that is already done. On customized boards `Done` may be another business stage: use the state the convention says.
- **Open the draft PR**: `az repos pr create --draft true --source-branch <integration branch> --target-branch <origin branch> --title "PBI <id> — <title>" --work-items <pbi> <tasks...> --description "..."`. The URL for `flow pr <n> draft --url` is `<repository.webUrl>/pullrequest/<pullRequestId>`, fields of the response.
- **Mark a Task done**: `az boards work-item update --id <task> --state <done state>`.
- **Create a Task for later** (a Finding the user decided to leave for later): `az boards work-item create --type Task --title "..."` and link it to the PBI with `az boards work-item relation add --id <new task> --relation-type parent --target-id <pbi>`; tags and area follow `docs/agents/`.
- **Finish the PR**: `az repos pr update --id <pr> --draft false`.

### Accents on Windows

On Windows `az` strips accents from the text it receives as an argument and from redirected output (the Bash tool's included). Ids, relations and states come through unharmed; titles and descriptions do not. Check every text `az` read or wrote: the title that goes to the panel and to the PR, the PR description, a created task. If there is a `?` or `�` in place of an accented letter, read or fix that text through REST, with UTF-8 files:

```bash
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
API="https://dev.azure.com/<org>/<project>/_apis"
curl -s -H "Authorization: Bearer $TOKEN" "$API/wit/workItems/<id>?api-version=7.1" -o item.json
```

- Read the response with `python -X utf8`, opening the file as UTF-8 (JSON through Python's stdin goes through the cp1252 console and loses the accents), or with the Read tool.
- Work item: `PATCH "$API/wit/workItems/<id>?api-version=7.1"` with `-H "Content-Type: application/json-patch+json; charset=utf-8" --data-binary @patch.json` (`[{"op":"add","path":"/fields/System.Title","value":"..."}]`).
- PR: `PATCH "$API/git/repositories/<repository>/pullrequests/<pr>?api-version=7.1"` with `-H "Content-Type: application/json; charset=utf-8" --data-binary @pr.json` (`{"title":"...","description":"..."}`; the description is limited to 4,000 characters). The repository is the last segment of `git remote get-url origin`.
