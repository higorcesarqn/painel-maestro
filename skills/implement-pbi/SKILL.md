---
name: implement-pbi
description: "Implements a whole Azure DevOps PBI in one PR, one Worker per task, and records the flow in painel-maestro. Finds the Host with `flow host` and follows its flow (subagents, Maestri floors or Orca worktrees); a mode passed after the ID wins."
disable-model-invocation: true
---

The user passed the ID of an Azure DevOps PBI (the **Item**) and, optionally, a mode: `/implement-pbi <id> [subagents|maestri|orca]`. Choose the mode (below) and follow that mode's flow, using this file as the **tracker adapter**. Type in the branch: `pbi` (e.g. `feature/pbi-10`). The flow's **Tasks** are the PBI's child tasks; a PBI without child tasks is its own Task.

Talk to the owner (the user) in Portuguese, and write in Portuguese what you record in the panel (titles, context, options, decisions, summaries, reports); the flow's document says more.

## Mode

1. **Choose.** A mode passed after the ID wins over the detection. Without it, run `node "$PAINEL_MAESTRO/bin/flow.js" host --json` (it does not need a repository) and take its `mode` (`subagents`, `maestri` or `orca`). If the `flow` does not run (e.g. `PAINEL_MAESTRO` not defined), read the variables it reads: `ORCA_TERMINAL_HANDLE` not empty → `orca`; otherwise `MAESTRI_TERMINAL_ID` not empty → `maestri`; otherwise `subagents`. Any other word after the ID: ask the owner which mode they meant.
2. **Say it.** Tell the owner, in one line, the mode and whether it was passed or detected (e.g. "Modo: subagentes (detectado: terminal comum)").
3. **Follow the mode's flow:**
   - `subagents`: `~/.claude/docs/orchestration-subagents/README.md` (one subagent in a worktree per Task; it also runs inside the Orca or the Maestri);
   - `maestri`: `~/.claude/docs/orchestration-maestri/README.md` (one Maestri floor and one Claude Code terminal per Task);
   - `orca`: `~/.claude/docs/orchestration-orca/README.md` (one Orca worktree and one Claude Code Worker supervised by the Orca's orchestrator per Task).
4. **Prerequisites.** Each flow lists its prerequisites: check them before its step 1. If one fails, stop, tell the owner which one failed and offer the subagent mode. **Never switch modes on your own**: the owner decides, so they always know which mode the Item ran in.
5. **Every `flow task dispatch` passes `--mode <mode>`**, the mode chosen here, so the Item's page shows how each Task was dispatched.

## Azure DevOps adapter

The same in every mode. **Read and write through REST with `curl`, not through `az boards`**: on Windows `az` strips accents from the text it receives as an argument and from redirected output (the Bash tool's included). `az` is only for the token. Organization, project and the states come from the repo's `docs/agents/issue-tracker.md` (or `az devops configure --list`); if something is missing, ask the user.

```bash
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
API="https://dev.azure.com/<org>/<project>/_apis"
```

Write every response to a file and read it with `python -X utf8`, opening the file as UTF-8, or with the Read tool. **Do not** pass JSON to Python through stdin: the cp1252 console corrupts the accents. Every text you send (title, description, PR) goes in a UTF-8 file with `--data-binary @<file>` and a `charset=utf-8` content type; read it back and check the accents.

- **Numbers in the panel**: the Item is the PBI's ID; each Task, the child task's ID. A PBI without child tasks is its own Task (no `flow task graph`).
- **Parent Item and Tasks**: `curl -s -H "Authorization: Bearer $TOKEN" "$API/wit/workItems/<id>?\$expand=relations&api-version=7.1" -o pbi.json`. Child tasks are the `System.LinkTypes.Hierarchy-Forward` relations; load each one the same way. Comments: `$API/wit/workItems/<id>/comments?api-version=7.1-preview.4`.
- **Blocking edges**: on a task, the `System.LinkTypes.Dependency-Reverse` (Predecessor) relation points to what blocks it. Complement it with `Bloqueada por: #<id>` lines in the description (`System.Description`).
- **Done state**: what `docs/agents/issue-tracker.md` says (the project's `--done-state` in the panel, in `node "$PAINEL_MAESTRO/bin/flow.js" project list`, should match; if they differ, `docs/agents/` wins and you tell the user). Without a written convention, read the state of an item that is already done. **Never guess `Done`**: on customized boards it may mean another business stage (in CIDAX, done Tasks and PBIs go to `Committed`; `Done` moves the card to "Liberado para pagamento").
- **State**: a closed Task is one in the done state (or another state of the Completed category), or a task already integrated in this run (`integrated` in the panel).
- **Read command for the Worker's briefing**: the two lines of the token and the `curl` above, with the task's id and the PBI's.
- **Mark a Task done**:
  ```bash
  curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json-patch+json" \
    -d '[{"op":"add","path":"/fields/System.State","value":"<done state>"}]' "$API/wit/workItems/<id>?api-version=7.1" -o resp.json
  ```
- **Edit text** (the description, a PBI rule that changed in the review): read the item, build the patch in a UTF-8 file (`json.dump(..., ensure_ascii=False)`) with `{"op":"test","path":"/rev","value":<rev read>}` before the `add`, and send it with `-H "Content-Type: application/json-patch+json; charset=utf-8" --data-binary @patch.json`. Read it back and check the accents.
- **Create a Task for later** (a Finding the user decided to leave for later): `POST "$API/wit/workItems/\$Task?api-version=7.1"` with a json-patch of title, description, Area, Iteration, Tags (include the triage one) and the `System.LinkTypes.Hierarchy-Reverse` relation to the PBI. Follow the title and tag conventions of `docs/agents/`. The `id` of the response is the `--new-task` of `flow finding link`.
- **Repository**: the name is the last segment of `git remote get-url origin`; the id comes from `GET $API/git/repositories/<name>?api-version=7.1`.
- **Open the draft PR**: `POST $API/git/repositories/<repo>/pullrequests?api-version=7.1` with `{"sourceRefName":"refs/heads/<integration branch>","targetRefName":"refs/heads/<origin branch>","title":"PBI <id> — <title>","description":"...","isDraft":true,"workItemRefs":[{"id":"<pbi>"},{"id":"<task>"},...]}`, in a UTF-8 file. The description is limited to 4,000 characters. The response's `url` is the API's: for `flow pr <n> draft --url`, use the page address, `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<pullRequestId>`.
- **Finish the PR**: `PATCH $API/git/repositories/<repo>/pullrequests/<pr>?api-version=7.1` with `{"isDraft":false,"description":"<final description>"}`. Check `isDraft:false` in the response.
- **Close the PBI**: after finishing the PR, set the PBI to the done state, if the local convention says so. This does not finish the Item in the panel (the flow's last steps say when).
- **Card link** (`flow hml --card`): `https://dev.azure.com/<org>/<project>/_workitems/edit/<id>`.
