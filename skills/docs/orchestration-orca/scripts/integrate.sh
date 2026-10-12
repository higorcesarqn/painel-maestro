#!/usr/bin/env bash
# Integrates the branch of a task's Orca worktree into the integration branch, records the task as integrated in
# painel-maestro and removes the worktree with `orca worktree rm`. The Orca sibling of
# orchestration-maestri/scripts/integrate.sh: the same checks, merge and panel record; only the cleanup differs.
#
# Usage (from the maestro's worktree, at the repo's root, on the integration branch, with the user's OK):
#   integrate.sh <task-branch> <integration-branch> [<item> [<task>]]
#
# Refuses: a maestro's worktree off the integration branch or dirty, a task worktree with uncommitted changes, a merge
# that is not a fast-forward (ask the worker to rebase on the integration branch). After the merge: push, check the
# remote, record in the panel, remove the task's worktree and its local branch.
#
# Panel: runs `node "$PAINEL_MAESTRO/bin/flow.js" task integrate <item> <task> --sha <after> --sha-before <before>
# --role maestro --agent maestro`. The item comes from the integration branch (feature/issue-<n> or feature/pbi-<n>)
# and the task from the branch (task/<id>-...), unless they come as arguments. If the panel does not record it, the
# integration still stands: the script exits with 0 and warns "integrar: aviso: o painel não registrou ..." on stderr,
# followed by the command to run again. Recorded: "integrar: painel: task <task> integrada no item <item>".
# The task/<id>-ajuste-final branch (the final adjustment worktree) is not a task: nothing is recorded; the line
# reminds of `flow final-adjustment <item> result`.
#
# Cleanup: `orca worktree rm --worktree branch:<task-branch> --json` (ORCA_CLI, else `orca` on the PATH), which closes
# the worktree's terminals, the worker's included even when it is retained by a user takeover, and deletes the branch.
# The script never calls worker-release nor terminal close. If the Orca does not remove it, the integration still
# stands: exit 0 and "integrar: aviso: o Orca não removeu o worktree ...", followed by the command to run.
# The checks, the merge, the record in the panel and the closing lines are in
# ../../orchestration-maestri/scripts/integrate-common.sh (shared with the Maestri's integrate.sh; both folders are
# installed side by side, ~/.claude/docs/orchestration-*); this script keeps its arguments and the Orca's cleanup.
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.
set -euo pipefail

O="${ORCA_CLI:-orca}"
BRANCH="${1:?branch da task}"; INTEGRATION="${2:?integradora}"; ITEM="${3:-}"; TASK="${4:-}"
PLACE="worktree do maestro"; TASK_PLACE="worktree"; ARGS_AT="3º e 4º"; AGENT_NAME="maestro"
# shellcheck source=../../orchestration-maestri/scripts/integrate-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../orchestration-maestri/scripts/integrate-common.sh"

integrate_check
integrate_merge
integrate_record

# The worktree is integrated: `orca worktree rm` closes its terminals and deletes it with the branch. The removal may
# finish after the answer ("removing": true), so wait for git to stop listing it.
ORCA_MSG=""
if [ -n "$WT" ]; then
    if RM_OUT="$("$O" worktree rm --worktree "branch:$BRANCH" --json 2>&1)" && ! printf '%s' "$RM_OUT" | grep -q '"ok": *false'; then
        for _ in $(seq 1 30); do
            [ -n "$(worktree_of "$BRANCH")" ] || break
            sleep 2
        done
        [ -z "$(worktree_of "$BRANCH")" ] || ORCA_MSG="o worktree ($WT) ainda aparece no git worktree list"
    else
        ORCA_MSG="$(printf '%s' "$RM_OUT" | tr -d '\r' | tr '\n' ' ')"
        ORCA_MSG="o CLI respondeu: ${ORCA_MSG:-sem resposta}"
    fi
fi
git worktree prune
[ -n "$(worktree_of "$BRANCH")" ] || git branch -d "$BRANCH" >/dev/null 2>&1 || true

integrate_summary
if [ -n "$ORCA_MSG" ]; then
    warn "o Orca não removeu o worktree de $BRANCH ($ORCA_MSG). Remova com:"
    echo "  \"\${ORCA_CLI:-orca}\" worktree rm --worktree branch:$BRANCH --json" >&2
fi
integrate_panel_result
