#!/usr/bin/env bash
# Compatibility entry point: the Claude Code runner is now one case of
# harness-detached.sh. Kept so existing callers of
# `claude-code-detached.sh "<prompt>" <job> [workdir]` keep working unchanged.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${HERE}/harness-detached.sh" claude "$@"
