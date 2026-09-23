#!/usr/bin/env python3
"""Install the agent-CLI harnesses a bridge can host.

Reads `harnesses/harnesses.json` and, for each selected harness, reports whether its
binary is on PATH and at what version. `--apply` installs the missing ones with the
registry's install command (npm for most, pip for Hermes) and runs any post-install
step — Pi needs the `pi-mcp-adapter` package before it can speak MCP at all; the
bridge runner loads it with `--extension`, so Pi's own settings are never modified.

Installed harnesses are left alone unless `--upgrade` is passed. Installing a binary
does not authenticate it: each harness still needs its own provider login or API key,
printed in the report as the `auth` hint.

  install-harnesses.py                          # report every harness
  install-harnesses.py --harness codex,gemini   # report two
  install-harnesses.py --apply                  # install whatever is missing
  install-harnesses.py --apply --upgrade        # reinstall at the latest version
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys

from zolib import harnesses, select


def version(cmd: list[str]) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"? ({type(exc).__name__})"
    text = (out.stdout or out.stderr).strip().splitlines()
    return text[0][:80] if text else "?"


def run(cmd: list[str]) -> bool:
    print("  $ " + " ".join(cmd))
    return subprocess.run(cmd, timeout=900).returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harness", default="all", help="comma-separated list, default all")
    ap.add_argument("--apply", action="store_true", help="install missing harnesses")
    ap.add_argument("--upgrade", action="store_true", help="reinstall harnesses that are already present")
    args = ap.parse_args()

    reg = harnesses()["harnesses"]
    failed = 0
    for name in select(args.harness):
        h = reg[name]
        path = shutil.which(h["binary"])
        state = f"{version(h['version'])}  ({path})" if path else "missing"
        print(f"{name:<9} {h['display']:<16} {state}")
        print(f"          auth: {h['auth']}")
        wanted = not path or args.upgrade
        if not wanted:
            continue
        needs = [h["install"][0]]
        if not all(shutil.which(t) for t in needs):
            print(f"          SKIP — `{needs[0]}` is not installed on this host")
            failed += 1
            continue
        if not args.apply:
            print("          would run: " + " ".join(h["install"]))
            if h.get("post_install"):
                print("          then:      " + " ".join(h["post_install"]))
            continue
        ok = run(h["install"])
        if ok and h.get("post_install"):
            ok = run(h["post_install"])
        if ok and shutil.which(h["binary"]):
            print(f"          installed  {version(h['version'])}")
        else:
            print("          FAILED")
            failed += 1

    if not args.apply:
        print("\ndry run — nothing installed. Re-run with --apply.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
