#!/usr/bin/env bash
# Integrates a floor's branch into the integration branch, without relying on `maestri floor land`
# (which deleted the floor without merging), and records the task as integrated in painel-maestro.
#
# Usage (from the Ground, at the repo's root, with the user's OK):
#   integrate.sh "<floor>" <task-branch> <integration-branch> [<item> [<task>]]
#
# Refuses: a Ground off the integration branch or dirty, a floor with uncommitted changes, a merge that is not
# a fast-forward (ask the worker to rebase on the integration branch). After the merge: push, check the remote,
# record in the panel, delete the floor and the task's local branch.
#
# Panel: runs `node "$PAINEL_MAESTRO/bin/flow.js" task integrate <item> <task> --sha <after> --sha-before <before>
# --role maestro` (with `--agent "$MAESTRI_TERMINAL_NAME"` when there is one). The item comes from the integration
# branch (feature/issue-<n> or feature/pbi-<n>) and the task from the branch (task/<id>-...), unless they come as arguments.
# If the panel does not record it, the integration still stands: the script exits with 0 and ends with
# "integrar: aviso: o painel não registrou ..." on stderr, followed by the command to run again.
# Recorded: the last line of the output is "integrar: painel: task <task> integrada no item <item>".
# The task/<id>-ajuste-final branch (the final adjustment floor) is not a task: nothing is recorded; the last line
# reminds of `flow final-adjustment <item> result`.
# The checks, the merge, the record in the panel and the closing lines are in integrate-common.sh (next to this file,
# shared with the Orca's integrate.sh); this script keeps its arguments and the cleanup of the floor.
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.
set -euo pipefail

M="${MAESTRI_CLI:-maestri}"
FLOOR="${1:?floor}"; BRANCH="${2:?branch da task}"; INTEGRATION="${3:?integradora}"; ITEM="${4:-}"; TASK="${5:-}"
PLACE="Ground"; TASK_PLACE="floor"; ARGS_AT="4º e 5º"; AGENT_NAME="${MAESTRI_TERMINAL_NAME:-}"
# shellcheck source=integrate-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/integrate-common.sh"

integrate_check
integrate_merge
integrate_record

# The floor is integrated: deleting it takes the worktree and the branch along (the command also times out).
"$M" floor delete "$FLOOR" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
    "$M" floor list 2>/dev/null | grep -qF "\"$FLOOR\"" || break
    sleep 5
done
"$M" floor list 2>/dev/null | grep -qF "\"$FLOOR\"" && echo "integrar: aviso: o floor \"$FLOOR\" ainda aparece; apague no canvas"
git worktree prune
git branch -d "$BRANCH" >/dev/null 2>&1 || true

integrate_summary
integrate_panel_result
