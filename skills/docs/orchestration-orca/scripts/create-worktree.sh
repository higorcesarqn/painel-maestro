#!/usr/bin/env bash
# Creates a task's Orca worktree from the integration branch, as a child of the maestro's worktree, and renames its
# branch to the convention task/<id>-<slug> (the Orca creates <GitHub user>/task-<id>-<slug>). Step 6 (items 1 and 2) of
# ../README.md; also the final adjustment's worktree (`create-worktree.sh <n> ajuste-final <integration>`).
#
# Usage (from the maestro's worktree, at the repo's root, on the integration branch):
#   create-worktree.sh <id> <slug> <integration-branch>
#
# The rename always runs on the absolute path the Orca answered, never on a path held in a shell variable of the
# caller: a variable that comes out empty turns `git -C "" branch -m` into a rename of the maestro's own branch (it
# happened in PBI #3194). Refuses: a maestro's worktree off the integration branch, an empty answer path or the
# maestro's own path, and a rename that leaves the maestro off the integration branch (it renames it back and stops).
#
# Prints, on success, the three values the next steps take:
#   worktree: <worktree id>      (worker-start --worktree "id:<worktree id>")
#   path: <worktree path>
#   branch: task/<id>-<slug>     (flow task dispatch --branch)
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.
set -euo pipefail

O="${ORCA_CLI:-orca}"
ID="${1:?id da task}"; SLUG="${2:?slug}"; INTEGRATION="${3:?integradora}"
NAME="task-$ID-$SLUG"; BRANCH="task/$ID-$SLUG"

die() { echo "worktree: $*" >&2; exit 1; }
norm() { printf '%s' "$1" | tr '\\' '/' | sed 's#/*$##' | tr '[:upper:]' '[:lower:]'; }

CURRENT="$(git branch --show-current)"
[ "$CURRENT" = "$INTEGRATION" ] || die "o worktree do maestro está em \"$CURRENT\", não na integradora $INTEGRATION."
TOP="$(git rev-parse --show-toplevel)"

OUT="$("$O" worktree create --name "$NAME" --base-branch "$INTEGRATION" --parent-worktree current --json 2>&1)" \
    || die "o Orca não criou o worktree $NAME: $(printf '%s' "$OUT" | tr -d '\r' | tr '\n' ' ')"

# id and path from the answer (node: the flow already requires it).
read_field() {
    printf '%s' "$OUT" | node -e '
let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
  try { const w = JSON.parse(s).result.worktree; process.stdout.write(String(w[process.argv[1]] || "")); } catch { }
});' "$1"
}
WT_ID="$(read_field id)"; WT_PATH="$(read_field path)"
[ -n "$WT_ID" ] && [ -n "$WT_PATH" ] || die "a resposta do Orca não traz o id e o path do worktree: $(printf '%s' "$OUT" | tr -d '\r' | tr '\n' ' ')"
[ "$(norm "$WT_PATH")" != "$(norm "$TOP")" ] || die "o Orca respondeu o path do próprio worktree do maestro ($WT_PATH)."
[ -d "$WT_PATH" ] || die "o path que o Orca respondeu não existe: $WT_PATH"

git -C "$WT_PATH" branch -m "$BRANCH"

if [ "$(git branch --show-current)" != "$INTEGRATION" ]; then
    git branch -m "$INTEGRATION" 2>/dev/null || true
    die "o rename atingiu o worktree do maestro; a integradora $INTEGRATION foi restaurada. Confira com git worktree list."
fi
[ "$(git -C "$WT_PATH" branch --show-current)" = "$BRANCH" ] || die "o worktree $WT_PATH não ficou na branch $BRANCH."

echo "worktree: $WT_ID"
echo "path: $WT_PATH"
echo "branch: $BRANCH"
