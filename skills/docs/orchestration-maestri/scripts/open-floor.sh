#!/usr/bin/env bash
# Abre o floor de uma task e entrega o briefing ao trabalhador.
#
# Uso (do Ground, na raiz do repo):
#   open-floor.sh "<floor>" <branch> "<trabalhador>" <briefing.txt> [<integradora>]
#
# - Cria o floor (o create estoura o timeout da CLI e conclui: este script espera).
# - Recruta o trabalhador "Claude Code" no floor, sem role (com role ele perde AGENTS.md, skills e permissões).
# - Manda o briefing com maestri ask em segundo plano; a resposta da tela fica em <briefing>.ask.log.
# O briefing deve começar com o comando de barra (ex.: /mattpocock-skills:implement ...).
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
