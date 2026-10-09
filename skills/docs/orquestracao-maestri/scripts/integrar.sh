#!/usr/bin/env bash
# Integra a branch de um floor na integradora, sem depender do `maestri floor land`
# (que apagava o floor sem fazer o merge), e registra a task integrada no painel-maestro.
#
# Uso (do Ground, na raiz do repo, com o OK do usuário):
#   integrar.sh "<floor>" <branch-da-task> <integradora> [<item> [<task>]]
#
# Recusa: Ground fora da integradora ou sujo, floor com alteração não commitada, merge que não seja
# fast-forward (peça ao trabalhador rebase sobre a integradora). Depois do merge: push, confere o remoto,
# registra no painel, apaga o floor e a branch local da task.
#
# Painel: roda `node "$PAINEL_MAESTRO/bin/flow.js" task integrate <item> <task> --sha <depois> --sha-before <antes>
# --role maestro` (com `--agent "$MAESTRI_TERMINAL_NAME"` quando houver). O item sai da integradora
# (feature/issue-<n> ou feature/pbi-<n>) e a task da branch (task/<id>-...), salvo quando vêm como argumentos.
# Se o painel não gravar, a integração continua valendo: o script sai com 0 e termina com
# "integrar: aviso: o painel não registrou ..." no stderr, seguido do comando para rodar de novo.
# Gravou: a última linha da saída é "integrar: painel: task <task> integrada no item <item>".
# A branch task/<id>-ajuste-final (o floor do ajuste final) não é task: não grava; a última linha lembra o
# `flow final-adjustment <item> result`.
set -euo pipefail

M="${MAESTRI_CLI:-maestri}"
FLOOR="${1:?floor}"; BRANCH="${2:?branch da task}"; INTEG="${3:?integradora}"; ITEM="${4:-}"; TASK="${5:-}"

falha() { echo "integrar: $*" >&2; exit 1; }
aviso() { echo "integrar: aviso: $*" >&2; }

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

# Painel: o merge já está no remoto, então uma falha aqui só avisa.
[ -n "$ITEM" ] || ITEM="$(printf '%s\n' "$INTEG" | sed -n 's#^feature/\(issue\|pbi\)-\([0-9][0-9]*\)$#\2#p')"
[ -n "$TASK" ] || TASK="$(printf '%s\n' "$BRANCH" | sed -n 's#^task/\([0-9][0-9]*\)\(-.*\)\{0,1\}$#\1#p')"
PAINEL_OK=""
if [ "${BRANCH%-ajuste-final}" != "$BRANCH" ]; then
    # O floor do ajuste final não é task do grafo: o maestro registra o resultado com flow final-adjustment.
    PAINEL_OK="integrar: painel: ajuste final integrado; registre o resultado com flow final-adjustment ${ITEM:-$TASK} result --outcome passed|failed"
elif [ -z "$ITEM" ] || [ -z "$TASK" ]; then
    PAINEL_MSG="item ou task não saem das branches '$INTEG' e '$BRANCH': passe <item> <task> como 4º e 5º argumentos"
elif [ -z "${PAINEL_MAESTRO:-}" ]; then
    PAINEL_MSG="PAINEL_MAESTRO não está definida (veja o README do painel-maestro)"
else
    AGENTE=()
    [ -z "${MAESTRI_TERMINAL_NAME:-}" ] || AGENTE=(--agent "$MAESTRI_TERMINAL_NAME")
    if SAIDA="$(node "$PAINEL_MAESTRO/bin/flow.js" task integrate "$ITEM" "$TASK" --sha "$DEPOIS" --sha-before "$ANTES" --role maestro "${AGENTE[@]}" 2>&1)"; then
        PAINEL_OK="integrar: painel: task $TASK integrada no item $ITEM"
    else
        PAINEL_MSG="o CLI respondeu: $SAIDA"
    fi
fi

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
if [ -n "$PAINEL_OK" ]; then
    echo "$PAINEL_OK"
else
    aviso "o painel não registrou a integração ($PAINEL_MSG). Depois de corrigir, rode do Ground:"
    echo "  node \"\$PAINEL_MAESTRO/bin/flow.js\" task integrate ${ITEM:-<item>} ${TASK:-<task>} --sha $DEPOIS --sha-before $ANTES --role maestro" >&2
fi
