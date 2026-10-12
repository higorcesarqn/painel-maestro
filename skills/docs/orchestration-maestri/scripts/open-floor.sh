#!/usr/bin/env bash
# Opens a task's floor and hands the briefing to the worker.
#
# Usage (from the Ground, at the repo's root):
#   open-floor.sh "<floor>" <branch> "<worker>" <briefing.txt> [<integration branch>]
#
# - Creates the floor (the create times out in the CLI and completes: this script waits for it).
# - Recruits the "Claude Code" worker on the floor, without a role (with a role it loses AGENTS.md, skills and permissions).
# - Sends the briefing with maestri ask in the background; the screen's answer goes to <briefing>.ask.log.
# The briefing must start with the slash command (e.g. /mattpocock-skills:implement ...).
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.
set -euo pipefail

M="${MAESTRI_CLI:-maestri}"
FLOOR="${1:?floor}"; BRANCH="${2:?branch}"; WORKER="${3:?trabalhador}"; BRIEF="${4:?briefing}"; INTEGRATION="${5:-}"

fail() { echo "abrir-floor: $*" >&2; exit 1; }

[ -f "$BRIEF" ] || fail "briefing não encontrado: $BRIEF"
head -n 1 "$BRIEF" | grep -q '^/' || echo "abrir-floor: aviso: a 1ª linha do briefing não é um comando de barra" >&2
git rev-parse --show-toplevel >/dev/null 2>&1 || fail "rode da raiz do repo (Ground)"
if [ -n "$INTEGRATION" ] && [ "$(git branch --show-current)" != "$INTEGRATION" ]; then
    fail "o Ground está em '$(git branch --show-current)', não na integradora '$INTEGRATION': o floor partiria do lugar errado"
fi

floor_exists() { "$M" floor list 2>/dev/null | grep -qF "\"$FLOOR\""; }
worktree_locked() { git worktree list 2>/dev/null | grep -F "[$BRANCH]" | grep -q 'locked'; }

if floor_exists; then
    echo "abrir-floor: o floor \"$FLOOR\" já existe; não recrio"
else
    "$M" floor create "$FLOOR" --branch "$BRANCH" >/dev/null 2>&1 || true
fi

for _ in $(seq 1 60); do
    if floor_exists && ! worktree_locked; then break; fi
    sleep 10
done
floor_exists || fail "o floor \"$FLOOR\" não apareceu em 10 min (confira 'maestri floor list' e 'git worktree list')"
worktree_locked && fail "o worktree de $BRANCH segue travado (cópia ainda em andamento?)"

if "$M" list 2>/dev/null | grep -qF "name: \"$WORKER\""; then
    echo "abrir-floor: o trabalhador \"$WORKER\" já existe; não recruto de novo"
else
    "$M" recruit "$WORKER" --preset "Claude Code" --floor "$FLOOR" | tail -n 1
    sleep 20
fi

LOG="${BRIEF%.*}.ask.log"
nohup "$M" ask "$WORKER" "$(cat "$BRIEF")" >"$LOG" 2>&1 &
sleep 30

echo "abrir-floor: worktree: $(git worktree list | grep -F "[$BRANCH]" | awk '{print $1}')"
"$M" floor status --floor "$FLOOR" || true
