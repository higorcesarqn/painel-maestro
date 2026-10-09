#!/usr/bin/env bash
# Integra a branch de um floor na integradora, sem depender do `maestri floor land`
# (que apagava o floor sem fazer o merge).
#
# Uso (do Ground, na raiz do repo, com o OK do usuário):
#   integrar.sh "<floor>" <branch-da-task> <integradora>
#
# Recusa: Ground fora da integradora ou sujo, floor com alteração não commitada, merge que não seja
# fast-forward (peça ao trabalhador rebase sobre a integradora). Depois do merge: push, confere o remoto,
# apaga o floor e a branch local da task.
set -euo pipefail

M="${MAESTRI_CLI:-maestri}"
FLOOR="${1:?floor}"; BRANCH="${2:?branch da task}"; INTEG="${3:?integradora}"

falha() { echo "integrar: $*" >&2; exit 1; }

git rev-parse --show-toplevel >/dev/null 2>&1 || falha "rode da raiz do repo (Ground)"
[ "$(git branch --show-current)" = "$INTEG" ] || falha "o Ground está em '$(git branch --show-current)', não em '$INTEG'"
[ -z "$(git status --porcelain)" ] || falha "o Ground tem alterações pendentes"
git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null || falha "a branch $BRANCH não existe"

WT="$(git worktree list --porcelain | awk -v b="branch refs/heads/$BRANCH" '/^worktree /{w=substr($0,10)} $0==b{print w}')"
if [ -n "$WT" ] && [ -n "$(git -C "$WT" status --porcelain)" ]; then
    falha "o floor ($WT) tem alterações não commitadas"
fi

git merge-base --is-ancestor "$INTEG" "$BRANCH" \
    || falha "$BRANCH não está sobre $INTEG: peça ao trabalhador 'git rebase $INTEG' e um novo gate"

ANTES="$(git rev-parse --short HEAD)"
git merge --ff-only --quiet "$BRANCH"
DEPOIS="$(git rev-parse --short HEAD)"
[ "$ANTES" != "$DEPOIS" ] || echo "integrar: aviso: a branch não tinha commit novo"

git push -q origin "$INTEG"
git fetch -q origin "$INTEG"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$INTEG")" ] || falha "o push não chegou ao remoto"

# O floor já foi integrado: apagá-lo leva junto o worktree e a branch (o comando também estoura o timeout).
"$M" floor delete "$FLOOR" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
    "$M" floor list 2>/dev/null | grep -qF "\"$FLOOR\"" || break
    sleep 5
done
"$M" floor list 2>/dev/null | grep -qF "\"$FLOOR\"" && echo "integrar: aviso: o floor \"$FLOOR\" ainda aparece; apague no canvas"
git worktree prune
git branch -d "$BRANCH" >/dev/null 2>&1 || true

echo "integrar: $INTEG $ANTES -> $DEPOIS (push ok)"
git log --oneline "$ANTES..$DEPOIS"
