#!/usr/bin/env bash
# Contract-aware launcher for a CLI-bridge-hosted Zo automation.
#
# The calling Zo turn runs this and returns in ~1s. The real work happens in a
# detached headless harness (Claude Code, Codex, Gemini, Kimi, OpenCode, Hermes, or
# Pi) that owns the AUTOMATION RESILIENCE CONTRACT itself, so
# begin/checkpoint/side-effect/finish run inside the long-lived process rather than
# inside a Zo turn that has already returned.
#
# Prints exactly one line:
#   SKIP overlap job=... pid=...   a prior bridge for this job is still running
#   SKIP nowork job=...            preflight said there is nothing to do
#   DETACHED job=... log=... ...   bridge launched
#   ERROR ...                      launch failed (exit 1)
#
# Usage:
#   bridge-launch.sh --job NAME --prompt-file PATH [--harness NAME] [--preflight CMD] [--workdir DIR]
#
# --harness defaults to $BRIDGE_HARNESS, then claude.
# --preflight runs under `bash -c` before launching. A non-zero exit means
# "no work"; the bridge is not launched and no model call is made.

set -uo pipefail

JOB=""; PROMPT_FILE=""; PREFLIGHT=""; WORKDIR="/home/workspace"; HARNESS="${BRIDGE_HARNESS:-claude}"
while [ $# -gt 0 ]; do
  case "$1" in
    --job) JOB="$2"; shift 2 ;;
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --preflight) PREFLIGHT="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --harness) HARNESS="$2"; shift 2 ;;
    *) echo "ERROR unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -n "$JOB" ] || { echo "ERROR --job required" >&2; exit 1; }
[ -n "$PROMPT_FILE" ] || { echo "ERROR --prompt-file required" >&2; exit 1; }
[ -r "$PROMPT_FILE" ] || { echo "ERROR prompt file not readable: $PROMPT_FILE" >&2; exit 1; }
case "$HARNESS" in
  claude|codex|gemini|kimi|opencode|hermes|pi) ;;
  *) echo "ERROR unknown harness: $HARNESS" >&2; exit 1 ;;
esac

PIDFILE="/dev/shm/cli-bridge-${JOB}.pid"
# The pidfile records "<pid> <starttime>" so a recycled PID cannot masquerade as a
# live bridge and stall this job forever behind a permanent SKIP overlap.
if [ -f "$PIDFILE" ]; then
  read -r PRIOR PRIOR_START < "$PIDFILE" 2>/dev/null || true
  if [ -n "${PRIOR:-}" ] && kill -0 "$PRIOR" 2>/dev/null; then
    LIVE_START="$(cut -d')' -f2- "/proc/${PRIOR}/stat" 2>/dev/null | awk '{print $20}')"
    if [ -z "${PRIOR_START:-}" ] || [ "$PRIOR_START" = "$LIVE_START" ]; then
      echo "SKIP overlap job=${JOB} pid=${PRIOR}"
      exit 0
    fi
  fi
  rm -f "$PIDFILE"
fi

if [ -n "$PREFLIGHT" ]; then
  if ! bash -c "$PREFLIGHT" >/dev/null 2>&1; then
    echo "SKIP nowork job=${JOB}"
    exit 0
  fi
fi

# Resolve the detached runner: explicit override, then the harness-neutral runner
# installed beside this script, then the Claude-only runners of older installs.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER=""
for candidate in \
  "${BRIDGE_RUNNER:-}" \
  "${HERE}/harness-detached.sh" \
  "${HERE}/claude-code-detached.sh" \
  "/home/workspace/Skills/zo-swarm-orchestrator/scripts/claude-code-detached.sh"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then RUNNER="$candidate"; break; fi
done
[ -n "$RUNNER" ] || { echo "ERROR detached runner not found (set BRIDGE_RUNNER)" >&2; exit 1; }
case "$(basename "$RUNNER")" in
  harness-detached.sh) RUNNER_ARGS=("$HARNESS") ;;
  *)
    [ "$HARNESS" = claude ] || { echo "ERROR runner $RUNNER only supports --harness claude; install harness-detached.sh" >&2; exit 1; }
    RUNNER_ARGS=() ;;
esac

# The prompt names its own automation in a "Automation ID: `<uuid>`" line. Passing it
# through lets the runner reconcile the resilience run after the CLI exits, so a bridge
# that stopped mid-contract cannot leave behind a receipt that reads like success.
AUTOMATION_ID="$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$PROMPT_FILE" | head -1)"
export AUTOMATION_ID

exec "$RUNNER" "${RUNNER_ARGS[@]}" "$(cat "$PROMPT_FILE")" "$JOB" "$WORKDIR"
