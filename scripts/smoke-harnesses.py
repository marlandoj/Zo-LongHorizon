#!/usr/bin/env python3
"""Prove each harness can own a detached loop and reach Zo through MCP.

For every selected harness this launches `harness-detached.sh` with a one-line task —
call the zo server's `get_space_settings` tool and report the site title — then waits
for the receipt and reads the transcript. A harness passes only when the run exits
cleanly AND the transcript carries `ZO_OK`, which it can produce only by completing a
real Zo MCP tool call. A config that lists the server as connected is not enough:
harnesses differ in connect timeouts and in which agent actually receives MCP tools.

  smoke-harnesses.py                        # all installed harnesses
  smoke-harnesses.py --harness codex,pi     # a subset
  smoke-harnesses.py --timeout 420          # per-run ceiling in seconds

Each run is a real model call on that harness's provider, so it costs a little.
Receipts go to a scratch directory, not the production receipt directory.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

from zolib import KIT, harnesses, select

RUNNER = os.path.join(KIT, "assets", "harness-detached.sh")
PROMPT = ("You are a smoke test. Call the Zo MCP server's get_space_settings tool (it is an MCP "
          "tool on the server named zo; do not use a shell, grep, or curl; if it is not listed directly, "
          "search for it with any tool-search facility you have). Then reply with exactly "
          "one line: ZO_OK <the site title value it returned>. If you cannot reach that tool, reply "
          "exactly: ZO_UNAVAILABLE <reason>, and do nothing else.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harness", default="all")
    ap.add_argument("--timeout", type=int, default=420)
    args = ap.parse_args()

    reg = harnesses()["harnesses"]
    run_dir = tempfile.mkdtemp(prefix="zo-bridge-smoke-")
    env = dict(os.environ, BRIDGE_RUN_DIR=run_dir, BRIDGE_TIMEOUT=str(args.timeout))
    launched = {}
    for name in select(args.harness):
        if not shutil.which(reg[name]["binary"]):
            print(f"{name:<9} SKIP     not installed")
            continue
        job = f"zo-bridge-smoke-{name}"
        out = subprocess.run(["bash", RUNNER, name, PROMPT, job, "/home/workspace"],
                             capture_output=True, text=True, env=env, timeout=60)
        if not out.stdout.startswith("DETACHED"):
            print(f"{name:<9} FAIL     launch: {(out.stdout + out.stderr).strip()[:160]}")
            continue
        launched[name] = job

    deadline = time.time() + args.timeout + 60
    pending = dict(launched)
    failed = 0
    while pending and time.time() < deadline:
        for name, job in list(pending.items()):
            receipts = glob.glob(os.path.join(run_dir, f"{job}-*.json"))
            if not receipts:
                continue
            rec = json.load(open(receipts[0]))
            log = open(rec["log"], encoding="utf-8", errors="replace").read() if os.path.exists(rec["log"]) else ""
            m = re.findall(r"ZO_(?:OK|UNAVAILABLE)[^\n]{0,120}", log)
            verdict = m[-1] if m else "(no ZO_ line in transcript)"
            ok = rec["exit_code"] == 0 and verdict.startswith("ZO_OK")
            failed += 0 if ok else 1
            print(f"{name:<9} {'PASS' if ok else 'FAIL':<8} exit={rec['exit_code']} {rec['duration_s']}s "
                  f"model={rec['model']}  {verdict}")
            if not ok:
                print(f"          transcript {rec['log']}  stderr {rec['err']}")
            del pending[name]
        time.sleep(5)
    for name in pending:
        failed += 1
        print(f"{name:<9} FAIL     no receipt within {args.timeout + 60}s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
