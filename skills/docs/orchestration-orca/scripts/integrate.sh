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
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.
set -euo pipefail

O="${ORCA_CLI:-orca}"
BRANCH="${1:?branch da task}"; INTEGRATION="${2:?integradora}"; ITEM="${3:-}"; TASK="${4:-}"

fail() { echo "integrar: $*" >&2; exit 1; }
warn() { echo "integrar: aviso: $*" >&2; }

git rev-parse --show-toplevel >/dev/null 2>&1 || fail "rode da raiz do repo (worktree do maestro)"
[ "$(git branch --show-current)" = "$INTEGRATION" ] || fail "o worktree do maestro está em '$(git branch --show-current)', não em '$INTEGRATION'"
[ -z "$(git status --porcelain)" ] || fail "o worktree do maestro tem alterações pendentes"
git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null || fail "a branch $BRANCH não existe"

worktree_of() { git worktree list --porcelain | awk -v b="branch refs/heads/$1" '/^worktree /{w=substr($0,10)} $0==b{print w}'; }
WT="$(worktree_of "$BRANCH")"
if [ -n "$WT" ] && [ -n "$(git -C "$WT" status --porcelain)" ]; then
    fail "o worktree ($WT) tem alterações não commitadas"
fi

git merge-base --is-ancestor "$INTEGRATION" "$BRANCH" \
    || fail "$BRANCH não está sobre $INTEGRATION: peça ao trabalhador 'git rebase $INTEGRATION' e um novo gate"

BEFORE="$(git rev-parse --short HEAD)"
git merge --ff-only --quiet "$BRANCH"
AFTER="$(git rev-parse --short HEAD)"
[ "$BEFORE" != "$AFTER" ] || echo "integrar: aviso: a branch não tinha commit novo"

git push -q origin "$INTEGRATION"
git fetch -q origin "$INTEGRATION"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$INTEGRATION")" ] || fail "o push não chegou ao remoto"

# Panel: the merge is already on the remote, so a failure here only warns.
# Branch convention (the same as parseBranch in the panel's bin/flow-repo.js): feature/issue-<n> or
# feature/pbi-<n> is the item's integration branch; task/<item>-ajuste-final is the final adjustment; task/<id>-… is the task.
# Bash 3.2 only ([[ ]] regex through a variable, no sed with GNU extensions).
RE_ITEM='^feature/(issue|pbi)-([0-9]+)$'
RE_FINAL='^task/([0-9]+)-ajuste-final$'
RE_TASK='^task/([0-9]+)(-.*)?$'
if [ -z "$ITEM" ] && [[ $INTEGRATION =~ $RE_ITEM ]]; then ITEM="${BASH_REMATCH[2]}"; fi
FINAL=""
if [[ $BRANCH =~ $RE_FINAL ]]; then
    FINAL=1
    [ -n "$ITEM" ] || ITEM="${BASH_REMATCH[1]}"
elif [ -z "$TASK" ] && [[ $BRANCH =~ $RE_TASK ]]; then
    TASK="${BASH_REMATCH[1]}"
fi
PANEL_OK=""
if [ -n "$FINAL" ]; then
    # The final adjustment is not a task of the graph: the maestro records the result with flow final-adjustment.
    PANEL_OK="integrar: painel: ajuste final integrado; registre o resultado com flow final-adjustment $ITEM result --outcome passed|failed"
elif [ -z "$ITEM" ] || [ -z "$TASK" ]; then
    PANEL_MSG="item ou task não saem das branches '$INTEGRATION' e '$BRANCH': passe <item> <task> como 3º e 4º argumentos"
elif [ -z "${PAINEL_MAESTRO:-}" ]; then
    PANEL_MSG="PAINEL_MAESTRO não está definida (veja o README do painel-maestro)"
else
    if OUTPUT="$(node "$PAINEL_MAESTRO/bin/flow.js" task integrate "$ITEM" "$TASK" --sha "$AFTER" --sha-before "$BEFORE" --role maestro --agent maestro 2>&1)"; then
        PANEL_OK="integrar: painel: task $TASK integrada no item $ITEM"
    else
        PANEL_MSG="o CLI respondeu: $OUTPUT"
    fi
fi

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

echo "integrar: $INTEGRATION $BEFORE -> $AFTER (push ok)"
git log --oneline "$BEFORE..$AFTER"
if [ -n "$ORCA_MSG" ]; then
    warn "o Orca não removeu o worktree de $BRANCH ($ORCA_MSG). Remova com:"
    echo "  \"\${ORCA_CLI:-orca}\" worktree rm --worktree branch:$BRANCH --json" >&2
fi
if [ -n "$PANEL_OK" ]; then
    echo "$PANEL_OK"
else
    warn "o painel não registrou a integração ($PANEL_MSG). Depois de corrigir, rode do worktree do maestro:"
    echo "  node \"\$PAINEL_MAESTRO/bin/flow.js\" task integrate ${ITEM:-<item>} ${TASK:-<task>} --sha $AFTER --sha-before $BEFORE --role maestro --agent maestro" >&2
fi
