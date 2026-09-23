#!/usr/bin/env bash
# Detached harness runner for Zo automations.
#
# Launches one headless agent CLI in a new session so it outlives the Zo turn that
# started it. The harness owns the agent loop; Zo is reached only as an MCP tool
# server, so no Zo model call happens and neither the 120 s per-call ceiling nor the
# session cap applies. Delivery must be done by the harness itself through the zo MCP
# server — the automation's delivery_method only sees a one-line launch result.
#
# Usage: harness-detached.sh <harness> "<prompt>" <job-name> [workdir]
#   harness: claude | codex | gemini | kimi | opencode | hermes | pi
#
# Env:
#   BRIDGE_MODEL           model for any harness (overrides the per-harness variable)
#   CLAUDE_CODE_MODEL      default claude-opus-5
#   CODEX_MODEL            default: codex config
#   GEMINI_MODEL           default: gemini config
#   KIMI_MODEL             default: kimi config
#   OPENCODE_MODEL         provider/model, default: opencode config
#   HERMES_MODEL           default: hermes config
#   HERMES_PROVIDER        e.g. openrouter; pairs with HERMES_MODEL
#   PI_MODEL               default openrouter/moonshotai/kimi-k3
#   PI_MCP_EXTENSION       path to pi-mcp-adapter/index.ts; default: the global npm install.
#                          Pi has no built-in MCP, so without the adapter it has no Zo tools
#   OPENCODE_CONFIG_CONTENT inline OpenCode config; default {"snapshot":false}, because
#                          OpenCode otherwise git-snapshots the whole workdir every turn
#                          and stalls for minutes on a large workspace
#   BRIDGE_TIMEOUT         seconds, default 3600 (CLAUDE_CODE_TIMEOUT honored for compatibility)
#   BRIDGE_BIN             override the harness binary path
#   RESILIENCE_RUNTIME     path to automation-resilience.ts (contract reconcile)
#   BRIDGE_RUN_DIR         receipt directory, default /home/workspace/.zo/cli-bridge-runs

set -euo pipefail

HARNESS="${1:?Usage: harness-detached.sh <harness> \"prompt\" <job-name> [workdir]}"
PROMPT="${2:?prompt required}"
JOB="${3:?job-name required}"
WORKDIR="${4:-/home/workspace}"
TIMEOUT="${BRIDGE_TIMEOUT:-${CLAUDE_CODE_TIMEOUT:-3600}}"
AUTOMATION_ID="${AUTOMATION_ID:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESILIENCE="${RESILIENCE_RUNTIME:-}"
if [ -z "$RESILIENCE" ]; then
  for c in "${HERE}/automation-resilience.ts" \
           "/home/workspace/Skills/automation-resilience/scripts/automation-resilience.ts"; do
    if [ -r "$c" ]; then RESILIENCE="$c"; break; fi
  done
fi
STATUS_DIR="${BRIDGE_RUN_DIR:-/home/workspace/.zo/cli-bridge-runs}"

case "$HARNESS" in
  claude)   BIN_NAME=claude;   MODEL="${BRIDGE_MODEL:-${CLAUDE_CODE_MODEL:-claude-opus-5}}" ;;
  codex)    BIN_NAME=codex;    MODEL="${BRIDGE_MODEL:-${CODEX_MODEL:-}}" ;;
  gemini)   BIN_NAME=gemini;   MODEL="${BRIDGE_MODEL:-${GEMINI_MODEL:-}}" ;;
  kimi)     BIN_NAME=kimi;     MODEL="${BRIDGE_MODEL:-${KIMI_MODEL:-}}" ;;
  opencode) BIN_NAME=opencode; MODEL="${BRIDGE_MODEL:-${OPENCODE_MODEL:-}}" ;;
  hermes)   BIN_NAME=hermes;   MODEL="${BRIDGE_MODEL:-${HERMES_MODEL:-}}" ;;
  pi)       BIN_NAME=pi;       MODEL="${BRIDGE_MODEL:-${PI_MODEL:-openrouter/moonshotai/kimi-k3}}" ;;
  *) echo "ERROR unknown harness: $HARNESS (claude|codex|gemini|kimi|opencode|hermes|pi)" >&2; exit 1 ;;
esac

# Resolve with `type -P` so a shell function or alias of the same name (some hosts wrap
# opencode in one) is never mistaken for the binary.
BIN="${BRIDGE_BIN:-${CLAUDE_CODE_BIN:-}}"
[ "$HARNESS" = claude ] || BIN="${BRIDGE_BIN:-}"
if [ -z "$BIN" ]; then
  for c in "$(type -P "$BIN_NAME" 2>/dev/null || true)" "/root/.local/bin/$BIN_NAME" \
           "/usr/local/bin/$BIN_NAME" "/usr/bin/$BIN_NAME" "/bin/$BIN_NAME"; do
    if [ -n "$c" ] && [ -x "$c" ]; then BIN="$c"; break; fi
  done
fi
[ -n "$BIN" ] || { echo "ERROR: $BIN_NAME binary not found (install it or set BRIDGE_BIN)" >&2; exit 1; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="/dev/shm/cli-bridge-${JOB}.log"
ERR="/dev/shm/cli-bridge-${JOB}_err.log"
PIDFILE="/dev/shm/cli-bridge-${JOB}.pid"
STATUS="${STATUS_DIR}/${JOB}-${TS}.json"
mkdir -p "$STATUS_DIR"

PROMPT_FILE="$(mktemp /tmp/cli-bridge-prompt-XXXXXX)"
printf '%s' "$PROMPT" > "$PROMPT_FILE"

# Each harness takes the prompt as one argv element read back from the prompt file at
# run time, so no prompt text is ever interpolated into this generated script.
case "$HARNESS" in
  claude)   INVOKE='"$BIN" -p "$P" --output-format text --dangerously-skip-permissions --model "$MODEL" </dev/null' ;;
  codex)    INVOKE='"$BIN" exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never ${MODEL:+-m "$MODEL"} "$P" </dev/null' ;;
  gemini)   INVOKE='"$BIN" -p "$P" ${MODEL:+-m "$MODEL"} --yolo --sandbox=false --output-format text </dev/null' ;;
  kimi)     INVOKE='"$BIN" --prompt "$P" ${MODEL:+-m "$MODEL"} </dev/null' ;;
  opencode) INVOKE='OPENCODE_CONFIG_CONTENT="${OPENCODE_CONFIG_CONTENT:-{\"snapshot\":false\}}" "$BIN" run --auto ${MODEL:+-m "$MODEL"} "$P" </dev/null' ;;
  hermes)   INVOKE='"$BIN" chat -Q --yolo ${HERMES_PROVIDER:+--provider "$HERMES_PROVIDER"} ${MODEL:+-m "$MODEL"} -q "$P" </dev/null' ;;
  pi)       INVOKE='"$BIN" --print --no-session --approve --model "$MODEL" ${PI_MCP_EXTENSION:+--extension "$PI_MCP_EXTENSION"} "$P" </dev/null' ;;
esac

if [ "$HARNESS" = pi ] && [ -z "${PI_MCP_EXTENSION:-}" ]; then
  NPM_ROOT="$(npm root -g 2>/dev/null || true)"
  if [ -n "$NPM_ROOT" ] && [ -f "$NPM_ROOT/pi-mcp-adapter/index.ts" ]; then
    PI_MCP_EXTENSION="$NPM_ROOT/pi-mcp-adapter/index.ts"
  else
    echo "WARN pi-mcp-adapter not found; Pi will run without Zo tools (install-harnesses.py --harness pi --apply)" >&2
  fi
fi

RUNNER="$(mktemp /tmp/cli-bridge-runner-XXXXXX.sh)"
cat > "$RUNNER" <<RUNNER_EOF
#!/usr/bin/env bash
# A Zo host runs everything as root. Claude Code refuses --dangerously-skip-permissions
# as root unless the sandbox flag is set; the other harnesses ignore it.
export IS_SANDBOX=1
export KIMI_DISABLE_TELEMETRY="\${KIMI_DISABLE_TELEMETRY:-1}"
export PI_TELEMETRY="\${PI_TELEMETRY:-0}" PI_SKIP_VERSION_CHECK="\${PI_SKIP_VERSION_CHECK:-1}"
# Prompts that call agent-logger read \$ZO_MODEL, which Zo sets only inside its own turn.
export ZO_MODEL="\${ZO_MODEL:-${HARNESS}:${MODEL:-default}}"
export PI_MCP_EXTENSION="${PI_MCP_EXTENSION:-}" HERMES_PROVIDER="${HERMES_PROVIDER:-}"
# A detached process inherits none of the Zo turn's environment. Load the host secrets
# here so every harness can authenticate to its model provider and to the zo MCP server.
if [ -r /root/.zo_secrets ]; then set -a; . /root/.zo_secrets; set +a; fi
unset CLAUDECODE
export BIN="$BIN" MODEL="$MODEL"
cd "$WORKDIR"
printf '%s %s\\n' \$\$ "\$(cut -d')' -f2- /proc/\$\$/stat | awk '{print \$20}')" > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
export P="\$(cat "$PROMPT_FILE")"
START=\$(date -u +%s)
timeout --signal=TERM --kill-after=30s "$TIMEOUT" bash -c '$INVOKE' _ > "$LOG" 2> "$ERR"
CODE=\$?
END=\$(date -u +%s)
# A clean exit does not mean the work finished. Every harness's one-shot mode ends the
# moment the model stops emitting, so an agent that backgrounded a command or ended its
# turn early exits 0 with the resilience run still open. Reconcile against the run
# record rather than trusting the exit code.
CONTRACT="unknown"
if [ -n "$AUTOMATION_ID" ] && [ -r "$RESILIENCE" ]; then
  CONTRACT="\$(timeout 90 bun "$RESILIENCE" status --automation-id "$AUTOMATION_ID" 2>/dev/null \\
    | grep -oE '"status":"[a-z_]+"' | head -1 | cut -d'"' -f4)"
  [ -n "\$CONTRACT" ] || CONTRACT="unknown"
fi
OUTCOME="ok"
[ "\$CODE" -eq 0 ] || OUTCOME="cli_failed"
if [ "\$CODE" -eq 0 ] && [ "\$CONTRACT" = "in_progress" ]; then OUTCOME="ended_mid_contract"; fi
printf '{"job":"%s","harness":"%s","started_at":"%s","exit_code":%d,"duration_s":%d,"model":"%s","automation_id":"%s","contract_status":"%s","outcome":"%s","log":"%s","err":"%s"}\n' \\
  "$JOB" "$HARNESS" "$TS" "\$CODE" "\$((END-START))" "${MODEL:-default}" "$AUTOMATION_ID" "\$CONTRACT" "\$OUTCOME" "$LOG" "$ERR" > "$STATUS"
rm -f "$PROMPT_FILE" "$RUNNER"
RUNNER_EOF
chmod +x "$RUNNER"

setsid nohup "$RUNNER" >/dev/null 2>&1 &
CHILD=$!
# Claim the job slot before returning. The runner rewrites this with its own PID once it
# starts, but a second launch arriving in that window would otherwise see no pidfile
# and start a duplicate run.
printf '%s %s\n' "$CHILD" "$(cut -d')' -f2- "/proc/${CHILD}/stat" 2>/dev/null | awk '{print $20}')" > "$PIDFILE"
echo "DETACHED job=${JOB} harness=${HARNESS} pid=${CHILD} log=${LOG} status=${STATUS} pidfile=${PIDFILE}"
