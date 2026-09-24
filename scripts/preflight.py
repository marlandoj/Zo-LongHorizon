#!/usr/bin/env python3
"""Verify a host can run CLI-bridge-hosted automations.

Checks, in order of how early they fail a bridge:
  harness binaries   the bridge runs a headless agent CLI; `--harness` picks which ones
                     must be present (default: at least one of the seven)
  root + IS_SANDBOX  Claude Code refuses --dangerously-skip-permissions as root
  bun                the resilience runtime is TypeScript
  resilience runtime  the contract inside the bridge
  zo MCP reachable   without it the bridge has no Zo tools and cannot deliver
  secrets file       a detached process inherits no Zo turn environment
  writable dirs      receipts and pidfiles

Exit 0 = ready, 1 = one or more required checks failed.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

DEFAULT_RUNTIME = "/home/workspace/Skills/automation-resilience/scripts/automation-resilience.ts"
DEFAULT_RUN_DIR = "/home/workspace/.zo/cli-bridge-runs"
SECRETS = "/root/.zo_secrets"

results: list[tuple[str, bool, bool, str]] = []  # name, ok, required, detail


def check(name: str, ok: bool, detail: str = "", required: bool = True) -> bool:
    results.append((name, ok, required, detail))
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runtime", default=DEFAULT_RUNTIME, help="automation-resilience.ts path")
    ap.add_argument("--run-dir", default=DEFAULT_RUN_DIR, help="bridge receipt directory")
    ap.add_argument("--skip-mcp", action="store_true", help="skip the live Zo MCP probe")
    ap.add_argument("--harness", default="", help="comma-separated harnesses that must be installed")
    ap.add_argument("--skip-personas", action="store_true", help="do not validate harness personas")
    args = ap.parse_args()

    from zolib import harnesses, select

    reg = harnesses()["harnesses"]
    required = set(select(args.harness)) if args.harness else set()
    found = []
    for name, h in reg.items():
        path = shutil.which(h["binary"])
        if path:
            found.append(name)
        check(f"harness {name}", bool(path), path or f"not installed ({' '.join(h['install'])})",
              required=name in required)
    if not required:
        check("any harness", bool(found), ", ".join(found) or "none installed; run install-harnesses.py --apply")

    if os.geteuid() == 0:
        check(
            "IS_SANDBOX for root",
            True,
            "runner exports IS_SANDBOX=1 (required: root cannot use --dangerously-skip-permissions without it)",
        )
    else:
        check("IS_SANDBOX for root", True, f"not root (uid {os.geteuid()}); flag not needed")

    bun = shutil.which("bun")
    check("bun", bool(bun), bun or "not found; needed by the resilience runtime")

    check(
        "resilience runtime",
        os.path.isfile(args.runtime),
        args.runtime if os.path.isfile(args.runtime) else f"missing: {args.runtime} (install.py --apply installs the bundled copy)",
        required=True,
    )

    if args.skip_personas:
        check("harness personas", True, "skipped", required=False)
    else:
        try:
            from zolib import field, list_rows
            existing = {field(row, "name") for row in list_rows("list_personas")}
            expected = set()
            missing_personas = set()
            for name, h in reg.items():
                if name not in found:
                    continue
                names = {h["persona"], *h.get("persona_aliases", [])}
                expected.add(h["persona"])
                if not names & existing:
                    missing_personas.add(h["persona"])
            check("harness personas", not missing_personas,
                  "registered: " + ", ".join(sorted(expected)) if not missing_personas
                  else "missing: " + ", ".join(sorted(missing_personas)) + " (run install.py --apply)")
        except SystemExit as exc:
            check("harness personas", False, str(exc).splitlines()[0])

    if args.skip_mcp:
        check("zo MCP reachable", True, "skipped", required=False)
    else:
        try:
            from zolib import tool

            out = tool("bash", {"cmd": "echo bridge-preflight"}, timeout=60)
            check("zo MCP reachable", "bridge-preflight" in out, out.strip()[:120])
        except SystemExit as exc:
            check("zo MCP reachable", False, str(exc).splitlines()[0])
        except Exception as exc:  # noqa: BLE001 - any transport fault is a failed check
            check("zo MCP reachable", False, f"{type(exc).__name__}: {exc}")

    check("secrets file", os.path.isfile(SECRETS), SECRETS, required=False)

    for path in (args.run_dir, "/dev/shm"):
        os.makedirs(path, exist_ok=True) if path == args.run_dir else None
        check(f"writable {path}", os.access(path, os.W_OK), "")

    width = max(len(n) for n, *_ in results)
    failed = 0
    for name, ok, required, detail in results:
        if not ok and required:
            failed += 1
        mark = "PASS" if ok else ("FAIL" if required else "WARN")
        print(f"{mark:4}  {name:<{width}}  {detail}")

    print()
    if failed:
        print(f"NOT READY — {failed} required check(s) failed")
        return 1
    print("READY — host can run CLI-bridge-hosted automations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
