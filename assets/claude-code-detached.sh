#!/usr/bin/env bash
# Detached Claude Code runner for Zo automations.
# The calling Zo turn returns immediately; the CLI owns the agent loop with no
# Zo-side model call, so the 120s per-call ceiling and the session cap do not apply.
# Delivery must be performed by the CLI run itself via mcp__zo__send_email_to_user /
# mcp__zo__send_sms_to_user — the automation's delivery_method sees an empty Zo turn.
#
# Usage: claude-code-detached.sh "<prompt>" <job-name> [workdir]
#
# Env:
#   CLAUDE_CODE_MODEL      default claude-opus-5
#   CLAUDE_CODE_TIMEOUT    seconds, default 3600
#   CLAUDE_CODE_BIN        override binary path
#   RESILIENCE_RUNTIME     path to automation-resilience.ts (contract reconcile)
#   BRIDGE_RUN_DIR         receipt directory, default /home/workspace/.zo/cli-bridge-runs

set -euo pipefail

PROMPT="${1:?Usage: claude-code-detached.sh \"prompt\" <job-name> [workdir]}"
JOB="${2:?job-name required}"
WORKDIR="${3:-/home/workspace}"
MODEL="${CLAUDE_CODE_MODEL:-claude-opus-5}"
TIMEOUT="${CLAUDE_CODE_TIMEOUT:-3600}"
AUTOMATION_ID="${AUTOMATION_ID:-}"
RESILIENCE="${RESILIENCE_RUNTIME:-/home/workspace/Skills/automation-resilience/scripts/automation-resilience.ts}"
STATUS_DIR="${BRIDGE_RUN_DIR:-/home/workspace/.zo/cli-bridge-runs}"

CLAUDE_BIN="${CLAUDE_CODE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  for c in "$(command -v claude 2>/dev/null || true)" /root/.local/bin/claude /usr/local/bin/claude; do
    if [ -n "$c" ] && [ -x "$c" ]; then CLAUDE_BIN="$c"; break; fi
  done
fi
if [ -z "$CLAUDE_BIN" ]; then
  echo "ERROR: claude binary not found" >&2
  exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="/dev/shm/cli-bridge-${JOB}.log"
ERR="/dev/shm/cli-bridge-${JOB}_err.log"
PIDFILE="/dev/shm/cli-bridge-${JOB}.pid"
STATUS="${STATUS_DIR}/${JOB}-${TS}.json"
mkdir -p "$STATUS_DIR"

PROMPT_FILE="$(mktemp /tmp/cli-bridge-prompt-XXXXXX)"
printf '%s' "$PROMPT" > "$PROMPT_FILE"

RUNNER="$(mktemp /tmp/cli-bridge-runner-XXXXXX.sh)"
cat > "$RUNNER" <<RUNNER_EOF
#!/usr/bin/env bash
# Claude Code refuses --dangerously-skip-permissions when running as root unless the
# sandbox flag is set, and everything on a Zo host runs as root.
export IS_SANDBOX=1
# Converted automations carry agent-logger lines that read \$ZO_MODEL, which Zo sets
# in its own turn and the detached process never inherits. Without this the logger
# records an empty model for every bridge-hosted run.
export ZO_MODEL="\${ZO_MODEL:-$MODEL}"
unset CLAUDECODE
cd "$WORKDIR"
printf '%s %s\\n' \$\$ "\$(cut -d')' -f2- /proc/\$\$/stat | awk '{print \$20}')" > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
START=\$(date -u +%s)
timeout "$TIMEOUT" "$CLAUDE_BIN" -p "\$(cat "$PROMPT_FILE")" \\
  --output-format text --dangerously-skip-permissions --model "$MODEL" \\
  > "$LOG" 2> "$ERR"
CODE=\$?
END=\$(date -u +%s)
# A clean CLI exit does not mean the work finished. \`claude -p\` ends the moment the
# model stops emitting, so an agent that backgrounded a command or ended its turn
# early exits 0 with the resilience run still open. Reconcile against the run record
# rather than trusting the exit code.
CONTRACT="unknown"
if [ -n "$AUTOMATION_ID" ] && [ -r "$RESILIENCE" ]; then
  CONTRACT="\$(timeout 90 bun "$RESILIENCE" status --automation-id "$AUTOMATION_ID" 2>/dev/null \\
    | grep -oE '"status":"[a-z_]+"' | head -1 | cut -d'"' -f4)"
  [ -n "\$CONTRACT" ] || CONTRACT="unknown"
fi
OUTCOME="ok"
[ "\$CODE" -eq 0 ] || OUTCOME="cli_failed"
if [ "\$CODE" -eq 0 ] && [ "\$CONTRACT" = "in_progress" ]; then OUTCOME="ended_mid_contract"; fi
printf '{"job":"%s","started_at":"%s","exit_code":%d,"duration_s":%d,"model":"%s","automation_id":"%s","contract_status":"%s","outcome":"%s","log":"%s","err":"%s"}\n' \\
  "$JOB" "$TS" "\$CODE" "\$((END-START))" "$MODEL" "$AUTOMATION_ID" "\$CONTRACT" "\$OUTCOME" "$LOG" "$ERR" > "$STATUS"
rm -f "$PROMPT_FILE" "$RUNNER"
RUNNER_EOF
chmod +x "$RUNNER"

setsid nohup "$RUNNER" >/dev/null 2>&1 &
echo "DETACHED job=${JOB} pid=$! log=${LOG} status=${STATUS} pidfile=${PIDFILE}"
