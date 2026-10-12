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
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.
set -euo pipefail

M="${MAESTRI_CLI:-maestri}"
FLOOR="${1:?floor}"; BRANCH="${2:?branch da task}"; INTEGRATION="${3:?integradora}"; ITEM="${4:-}"; TASK="${5:-}"

fail() { echo "integrar: $*" >&2; exit 1; }
warn() { echo "integrar: aviso: $*" >&2; }

git rev-parse --show-toplevel >/dev/null 2>&1 || fail "rode da raiz do repo (Ground)"
[ "$(git branch --show-current)" = "$INTEGRATION" ] || fail "o Ground está em '$(git branch --show-current)', não em '$INTEGRATION'"
[ -z "$(git status --porcelain)" ] || fail "o Ground tem alterações pendentes"
git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null || fail "a branch $BRANCH não existe"

WT="$(git worktree list --porcelain | awk -v b="branch refs/heads/$BRANCH" '/^worktree /{w=substr($0,10)} $0==b{print w}')"
if [ -n "$WT" ] && [ -n "$(git -C "$WT" status --porcelain)" ]; then
    fail "o floor ($WT) tem alterações não commitadas"
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
# feature/pbi-<n> is the item's integration branch; task/<item>-ajuste-final is the final adjustment floor; task/<id>-… is the task.
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
    # The final adjustment floor is not a task of the graph: the maestro records the result with flow final-adjustment.
    PANEL_OK="integrar: painel: ajuste final integrado; registre o resultado com flow final-adjustment $ITEM result --outcome passed|failed"
elif [ -z "$ITEM" ] || [ -z "$TASK" ]; then
    PANEL_MSG="item ou task não saem das branches '$INTEGRATION' e '$BRANCH': passe <item> <task> como 4º e 5º argumentos"
elif [ -z "${PAINEL_MAESTRO:-}" ]; then
    PANEL_MSG="PAINEL_MAESTRO não está definida (veja o README do painel-maestro)"
else
    AGENT=()
    [ -z "${MAESTRI_TERMINAL_NAME:-}" ] || AGENT=(--agent "$MAESTRI_TERMINAL_NAME")
    if OUTPUT="$(node "$PAINEL_MAESTRO/bin/flow.js" task integrate "$ITEM" "$TASK" --sha "$AFTER" --sha-before "$BEFORE" --role maestro ${AGENT[@]+"${AGENT[@]}"} 2>&1)"; then
        PANEL_OK="integrar: painel: task $TASK integrada no item $ITEM"
    else
        PANEL_MSG="o CLI respondeu: $OUTPUT"
    fi
fi

# The floor is integrated: deleting it takes the worktree and the branch along (the command also times out).
"$M" floor delete "$FLOOR" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
    "$M" floor list 2>/dev/null | grep -qF "\"$FLOOR\"" || break
    sleep 5
done
"$M" floor list 2>/dev/null | grep -qF "\"$FLOOR\"" && echo "integrar: aviso: o floor \"$FLOOR\" ainda aparece; apague no canvas"
git worktree prune
git branch -d "$BRANCH" >/dev/null 2>&1 || true

echo "integrar: $INTEGRATION $BEFORE -> $AFTER (push ok)"
git log --oneline "$BEFORE..$AFTER"
if [ -n "$PANEL_OK" ]; then
    echo "$PANEL_OK"
else
    warn "o painel não registrou a integração ($PANEL_MSG). Depois de corrigir, rode do Ground:"
    echo "  node \"\$PAINEL_MAESTRO/bin/flow.js\" task integrate ${ITEM:-<item>} ${TASK:-<task>} --sha $AFTER --sha-before $BEFORE --role maestro" >&2
fi
