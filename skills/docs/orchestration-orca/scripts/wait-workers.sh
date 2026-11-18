#!/usr/bin/env bash
# Waits for the Workers of the bound Orca Run (step 7 of ../README.md): runs `orca orchestration check --wait` in a
# loop, skips by itself the batches that carry only heartbeats, and ends at the first batch with a message the
# maestro must process (worker_done, question, escalation or any other non-heartbeat type), printed compactly. Run it
# with Bash in the background (run_in_background); Claude Code wakes the maestro up when it ends.
#
# Usage (from the maestro's worktree):
#   wait-workers.sh [--ack <delivery_id>] [--run <run_id>] [--timeout-ms <ms>] [--rounds <n>]
#
# --ack: only for an Orca older than 1.4.258, whose check replays a batch until it is acknowledged: the delivery the
# maestro has just processed (the previous run's "esperar: entrega <id>"), acknowledged on the first check. From 1.4.258
# on, a consuming check marks its batch as read and answers no deliveryId: there is nothing to ack. --rounds: empty waits in a row (timeouts) before giving up, default 3; then exit 3 and the
# command to look at the Workers (`worker-list`). Each check waits --timeout-ms, default 900000.
#
# Output on a delivery (exit 0):
#   esperar: entrega lida (<n> mensagem(ns))             Orca 1.4.258+: the batch is already marked as read
#   esperar: entrega <delivery_id> (<n> mensagem(ns))    older Orca: not acknowledged, run again with --ack <id>
#   --- <type> <message_id> · <subject>
#   payload: <payload as compact JSON, without the question the body already carries>
#   relatório: <reportPath>                                only when the payload has one (worker_done --report-path)
#   <body>
# The check runs with --full: the concise view cuts long bodies and hands the payload over as an object.
# The orchestrator's keep-alive lines are skipped by the parser, so no grep is needed (a grep in a pipeline is
# reformatted by the rtk hook). Exit 1: the CLI failed (its answer goes to stderr).
# Its messages stay in Portuguese (ADR 0004): the skills quote them verbatim.
set -euo pipefail

O="${ORCA_CLI:-orca}"
ACK=""; RUN=""; TIMEOUT=900000; ROUNDS=3
while [ $# -gt 0 ]; do
    case "$1" in
        --ack) ACK="${2:?--ack <delivery_id>}"; shift 2 ;;
        --run) RUN="${2:?--run <run_id>}"; shift 2 ;;
        --timeout-ms) TIMEOUT="${2:?--timeout-ms <ms>}"; shift 2 ;;
        --rounds) ROUNDS="${2:?--rounds <n>}"; shift 2 ;;
        *) echo "esperar: argumento desconhecido: $1" >&2; exit 2 ;;
    esac
done

# The last JSON answer of the output (keep-alive lines and objects skipped), summarized: the first line is
# "<kind> <delivery_id>", kind = deliver | heartbeats | empty | error; the compact messages follow for deliver.
summarize() {
    node -e '
let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
  let last = null, i = 0;
  while ((i = s.indexOf("{", i)) !== -1) {
    try {
      // raw decode from i: find the shortest prefix that parses (answers are small)
      let depth = 0, inStr = false, esc = false, j = i;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; continue; }
        if (ch === "\"") inStr = true; else if (ch === "{") depth++; else if (ch === "}" && --depth === 0) break;
      }
      const o = JSON.parse(s.slice(i, j + 1));
      if (!o._keepalive) last = o;
      i = j + 1;
    } catch { i++; }
  }
  if (!last || last.ok === false || !last.result) { console.log("error -"); return; }
  const r = last.result, msgs = r.messages || [];
  // Orca 1.4.258+ marks the batch as read and answers no deliveryId; an older Orca answers one to ack.
  const delivery = r.deliveryId || "-";
  if (!msgs.length) { console.log("empty -"); return; }
  const real = msgs.filter((m) => m.type !== "heartbeat");
  if (!real.length) { console.log(`heartbeats ${delivery}`); return; }
  console.log(`deliver ${delivery}`);
  console.log(`esperar: entrega ${r.deliveryId || "lida"} (${msgs.length} mensagem(ns))`);
  for (const m of real) {
    console.log(`--- ${m.type} ${m.id} · ${m.subject || ""}`);
    // The full record carries the payload as a JSON string; the concise view, as an object.
    let p = m.payload;
    if (typeof p === "string") { try { p = JSON.parse(p); } catch { /* not JSON: printed as it came */ } }
    if (p && typeof p === "object") {
      const { question, ...rest } = p;
      if (Object.keys(rest).length) console.log(`payload: ${JSON.stringify(rest)}`);
      if (p.reportPath) console.log(`relatório: ${p.reportPath}`);
    } else if (p) {
      console.log(`payload: ${p}`);
    }
    if (m.body) console.log(m.body);
  }
});'
}

empty=0
while :; do
    args=(orchestration check --wait --types "worker_done,escalation,question,heartbeat" --timeout-ms "$TIMEOUT" --full --json)
    [ -n "$RUN" ] && args+=(--run "$RUN")
    [ -n "$ACK" ] && args+=(--ack "$ACK")
    if ! OUT="$("$O" "${args[@]}" 2>&1)"; then
        echo "esperar: o check do Orca falhou: $(printf '%s' "$OUT" | tr -d '\r' | tail -c 2000)" >&2
        exit 1
    fi
    SUMMARY="$(printf '%s' "$OUT" | summarize)"
    read -r kind delivery <<<"$(printf '%s\n' "$SUMMARY" | head -n 1)"
    case "$kind" in
        deliver)
            printf '%s\n' "$SUMMARY" | tail -n +2
            exit 0 ;;
        heartbeats)
            # Older Orca: ack the heartbeat-only batch on the next check; 1.4.258+ already marked it as read.
            if [ "$delivery" = "-" ]; then ACK=""; else ACK="$delivery"; fi
            empty=0 ;;
        empty)
            ACK=""; empty=$((empty + 1))
            if [ "$empty" -ge "$ROUNDS" ]; then
                echo "esperar: $ROUNDS esperas vazias seguidas. Confira os Workers com:"
                echo "  \"\${ORCA_CLI:-orca}\" orchestration worker-list${RUN:+ --run $RUN} --json"
                exit 3
            fi ;;
        *)
            echo "esperar: resposta do check sem JSON válido: $(printf '%s' "$OUT" | tr -d '\r' | tail -c 2000)" >&2
            exit 1 ;;
    esac
done
