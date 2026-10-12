#!/usr/bin/env bash
# Integra a branch de um floor na integradora, sem depender do `maestri floor land`
# (que apagava o floor sem fazer o merge), e registra a task integrada no painel-maestro.
#
# Uso (do Ground, na raiz do repo, com o OK do usuário):
#   integrate.sh "<floor>" <branch-da-task> <integradora> [<item> [<task>]]
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

# Painel: o merge já está no remoto, então uma falha aqui só avisa.
# Convenção de branch (a mesma da parseBranch de bin/flow-repo.js no painel): feature/issue-<n> ou
# feature/pbi-<n> é a integradora do item; task/<item>-ajuste-final é o floor do ajuste final; task/<id>-… é a task.
# Só bash 3.2 (regex de [[ ]] por variável, sem sed com extensões GNU).
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
    # O floor do ajuste final não é task do grafo: o maestro registra o resultado com flow final-adjustment.
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

# O floor já foi integrado: apagá-lo leva junto o worktree e a branch (o comando também estoura o timeout).
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
