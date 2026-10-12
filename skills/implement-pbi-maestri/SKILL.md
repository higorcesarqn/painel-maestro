---
name: implement-pbi-maestri
description: "Implements a whole Azure DevOps PBI in one PR, with one Maestri floor and one Claude Code terminal per task, recording the flow in painel-maestro. Use only inside Maestri, as the maestro on the Ground."
disable-model-invocation: true
---

The user passed the ID of an Azure DevOps PBI (the **Item**). Follow the flow in `~/.claude/docs/orchestration-maestri/README.md`, using this file as the **tracker adapter**. Type in the branch: `pbi` (e.g. `feature/pbi-10`).

Outside Maestri (no `$MAESTRI_CLI`, or no Maestro Mode on the Ground), stop and suggest `/implement-pbi`, which uses subagents (its flow is in `~/.claude/docs/orchestration-subagents/README.md`).

Talk to the owner (the user) in Portuguese, and write in Portuguese what you record in the panel (titles, context, options, decisions, summaries, reports); the document above says more.

## Azure DevOps adapter

**Read and write through REST with `curl`, not through `az boards`**: on Windows `az` strips accents when redirecting output and when receiving text as an argument. `az` is only for the token. Organization, project and the states come from the repo's `docs/agents/issue-tracker.md`; if something is missing, ask the user.

```bash
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
API="https://dev.azure.com/<org>/<project>/_apis"
```

Write every response to a file and read it with `python -X utf8`, opening the file as UTF-8. **Do not** pass JSON to Python through stdin: the cp1252 console corrupts the accents.

- **Numbers in the panel**: the Item is the PBI's ID; each Task, the child task's ID. A PBI without child tasks is its own Task (no `flow task graph`).
- **Parent Item and Tasks**: `curl -s -H "Authorization: Bearer $TOKEN" "$API/wit/workItems/<id>?\$expand=relations&api-version=7.1" -o pbi.json`. Child tasks are the `System.LinkTypes.Hierarchy-Forward` relations; load each one the same way. Comments: `$API/wit/workItems/<id>/comments?api-version=7.1-preview.4`.
- **Blocking edges**: on a task, the `System.LinkTypes.Dependency-Reverse` (Predecessor) relation points to what blocks it. Complement it with `Bloqueada por: #<id>` lines in the description.
- **Done state**: what `docs/agents/issue-tracker.md` says (the project's `--done-state` in the panel, in `flow project list`, should match; if they differ, `docs/agents/` wins and you tell the user). **Never guess `Done`**: on customized boards it may mean another business stage (in CIDAX, done Tasks and PBIs go to `Committed`; `Done` moves the card to "Liberado para pagamento").
- **Read command for the Worker's briefing**: the two lines of the token and the `curl` above, with the task's id and the PBI's.
- **Mark a Task done**:
  ```bash
  curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json-patch+json" \
    -d '[{"op":"add","path":"/fields/System.State","value":"<done state>"}]' "$API/wit/workItems/<id>?api-version=7.1" -o resp.json
  ```
- **Edit text** (the description, a PBI rule that changed in the review): read the item, build the patch in a UTF-8 file (`json.dump(..., ensure_ascii=False)`) with `{"op":"test","path":"/rev","value":<rev read>}` before the `add`, and send it with `-H "Content-Type: application/json-patch+json; charset=utf-8" --data-binary @patch.json`. Read it back and check the accents.
- **Create an item** (a Finding left for later): `POST "$API/wit/workItems/\$Task?api-version=7.1"` with a json-patch of title, description, Area, Iteration, Tags (include the triage one) and the `System.LinkTypes.Hierarchy-Reverse` relation to the PBI. Follow the title and tag conventions of `docs/agents/`. The `id` of the response is the `--new-task` of `flow finding`.
- **Repository**: the name is the last segment of `git remote get-url origin`; the id comes from `GET $API/git/repositories/<name>?api-version=7.1`.
- **Open the draft PR**: `POST $API/git/repositories/<repo>/pullrequests?api-version=7.1` with `{"sourceRefName":"refs/heads/<integration branch>","targetRefName":"refs/heads/<origin branch>","title":"PBI <id> — <title>","description":"...","isDraft":true,"workItemRefs":[{"id":"<pbi>"},{"id":"<task>"},...]}`, in a UTF-8 file. The description is limited to 4,000 characters. The response's `url` is the API's: for `flow pr <n> draft --url`, use the page address, `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<pullRequestId>`.
- **Finish the PR**: `PATCH $API/git/repositories/<repo>/pullrequests/<pr>?api-version=7.1` with `{"isDraft":false,"description":"<final description>"}`. Check `isDraft:false` in the response.
- **Close the PBI**: after finishing the PR, set the PBI to the done state, if the local convention says so. This does not finish the Item in the panel (step 11 of the flow).
- **Card link** (`flow hml --card`): `https://dev.azure.com/<org>/<project>/_workitems/edit/<id>`.
