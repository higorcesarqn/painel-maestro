# Shared part of the two integration scripts (sourced, never run): orchestration-maestri/scripts/integrate.sh (a
# Maestri floor) and orchestration-orca/scripts/integrate.sh (an Orca worktree, which sources this file from here).
# Each script keeps its arguments and the cleanup of its Host; this file has the checks, the search for the task's
# worktree, the fast-forward merge, the push and its check on the remote, the branch convention, the record in the
# panel and the closing lines.
#
# The script sets, before calling these functions:
#   BRANCH, INTEGRATION, ITEM, TASK   the task branch, the integration branch, and the item and task when given
#   PLACE        where it runs, as the messages name it ("Ground", "worktree do maestro")
#   TASK_PLACE   what holds the task branch, as the messages name it ("floor", "worktree")
#   ARGS_AT      the position of <item> <task> among its arguments ("4º e 5º")
#   AGENT_NAME   the --agent of the record in the panel (empty: none)
# and gets: WT (the task branch's worktree, or empty), BEFORE and AFTER (short SHAs of the integration branch),
# PANEL_OK (the line of a record) or PANEL_MSG (why the panel did not record it).
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.

fail() { echo "integrar: $*" >&2; exit 1; }
warn() { echo "integrar: aviso: $*" >&2; }

# The worktree that has branch $1 checked out (empty when none).
worktree_of() { git worktree list --porcelain | awk -v b="branch refs/heads/$1" '/^worktree /{w=substr($0,10)} $0==b{print w}'; }

# Refuses a place off the integration branch or dirty, a missing task branch, a task worktree with uncommitted changes
# and a merge that is not a fast-forward. Sets WT.
integrate_check() {
    git rev-parse --show-toplevel >/dev/null 2>&1 || fail "rode da raiz do repo ($PLACE)"
    [ "$(git branch --show-current)" = "$INTEGRATION" ] || fail "o $PLACE está em '$(git branch --show-current)', não em '$INTEGRATION'"
    [ -z "$(git status --porcelain)" ] || fail "o $PLACE tem alterações pendentes"
    git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null || fail "a branch $BRANCH não existe"
    WT="$(worktree_of "$BRANCH")"
    if [ -n "$WT" ] && [ -n "$(git -C "$WT" status --porcelain)" ]; then
        fail "o $TASK_PLACE ($WT) tem alterações não commitadas"
    fi
    git merge-base --is-ancestor "$INTEGRATION" "$BRANCH" \
        || fail "$BRANCH não está sobre $INTEGRATION: peça ao trabalhador 'git rebase $INTEGRATION' e um novo gate"
}

# Fast-forwards the integration branch to the task branch, pushes it and checks the remote. Sets BEFORE and AFTER.
integrate_merge() {
    BEFORE="$(git rev-parse --short HEAD)"
    git merge --ff-only --quiet "$BRANCH"
    AFTER="$(git rev-parse --short HEAD)"
    [ "$BEFORE" != "$AFTER" ] || echo "integrar: aviso: a branch não tinha commit novo"
    git push -q origin "$INTEGRATION"
    git fetch -q origin "$INTEGRATION"
    [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$INTEGRATION")" ] || fail "o push não chegou ao remoto"
}

# Records the task as integrated in the panel. The merge is already on the remote, so a failure here only warns.
# Branch convention (the same as parseBranch in the panel's bin/flow-repo.js): feature/issue-<n> or feature/pbi-<n> is
# the item's integration branch; task/<item>-ajuste-final is the final adjustment (not a task: nothing is recorded);
# task/<id>-… is the task. Bash 3.2 only ([[ ]] regex through a variable, no sed with GNU extensions).
integrate_record() {
    local re_item='^feature/(issue|pbi)-([0-9]+)$' re_final='^task/([0-9]+)-ajuste-final$' re_task='^task/([0-9]+)(-.*)?$'
    local final="" output agent=()
    [ -z "$AGENT_NAME" ] || agent=(--agent "$AGENT_NAME")
    if [ -z "$ITEM" ] && [[ $INTEGRATION =~ $re_item ]]; then ITEM="${BASH_REMATCH[2]}"; fi
    if [[ $BRANCH =~ $re_final ]]; then
        final=1
        [ -n "$ITEM" ] || ITEM="${BASH_REMATCH[1]}"
    elif [ -z "$TASK" ] && [[ $BRANCH =~ $re_task ]]; then
        TASK="${BASH_REMATCH[1]}"
    fi
    PANEL_OK=""
    PANEL_MSG=""
    if [ -n "$final" ]; then
        # The final adjustment is not a task of the graph: the maestro records the result with flow final-adjustment.
        PANEL_OK="integrar: painel: ajuste final integrado; registre o resultado com flow final-adjustment $ITEM result --outcome passed|failed"
    elif [ -z "$ITEM" ] || [ -z "$TASK" ]; then
        PANEL_MSG="item ou task não saem das branches '$INTEGRATION' e '$BRANCH': passe <item> <task> como $ARGS_AT argumentos"
    elif [ -z "${PAINEL_MAESTRO:-}" ]; then
        PANEL_MSG="PAINEL_MAESTRO não está definida (veja o README do painel-maestro)"
    elif output="$(node "$PAINEL_MAESTRO/bin/flow.js" task integrate "$ITEM" "$TASK" --sha "$AFTER" --sha-before "$BEFORE" --role maestro ${agent[@]+"${agent[@]}"} 2>&1)"; then
        PANEL_OK="integrar: painel: task $TASK integrada no item $ITEM"
    else
        PANEL_MSG="o CLI respondeu: $output"
    fi
}

# The integration branch before and after, with the commits it gained.
integrate_summary() {
    echo "integrar: $INTEGRATION $BEFORE -> $AFTER (push ok)"
    git log --oneline "$BEFORE..$AFTER"
}

# The last line: the record in the panel or, when it did not record, the warning and the command to run again.
integrate_panel_result() {
    if [ -n "$PANEL_OK" ]; then
        echo "$PANEL_OK"
        return
    fi
    local agent=""
    [ -z "$AGENT_NAME" ] || agent=" --agent $(printf '%q' "$AGENT_NAME")"
    warn "o painel não registrou a integração ($PANEL_MSG). Depois de corrigir, rode do $PLACE:"
    echo "  node \"\$PAINEL_MAESTRO/bin/flow.js\" task integrate ${ITEM:-<item>} ${TASK:-<task>} --sha $AFTER --sha-before $BEFORE --role maestro$agent" >&2
}
