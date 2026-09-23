#!/usr/bin/env python3
"""Install the bridge scripts onto a Zo host.

Writes `bridge-launch.sh` (the one-line launcher a Zo automation calls) and
`claude-code-detached.sh` (the detached `claude -p` runner that owns the loop) into
one directory, then creates the prompts and receipt directories.

Dry-run by default: prints a unified diff for anything that would change and exits 0
without touching the host. `--apply` commits. An existing file whose contents differ
is refused unless `--force` is passed, because live automations reference the
launcher by absolute path and replacing it changes their behavior.

  install.py                       # show what would change
  install.py --apply               # install, refusing to clobber differing files
  install.py --apply --force       # replace differing files too (backs them up)
"""
from __future__ import annotations

import argparse
import difflib
import os
import shutil
import sys
import time

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(KIT, "assets")
SCRIPTS = ("bridge-launch.sh", "claude-code-detached.sh")
DEFAULT_TARGET = "/home/workspace/Skills/automation-resilience/scripts"
DEFAULT_PROMPTS = "/home/workspace/Skills/automation-resilience/prompts"
DEFAULT_RUN_DIR = "/home/workspace/.zo/cli-bridge-runs"


def plan_one(name: str, target: str) -> tuple[str, str]:
    src = os.path.join(ASSETS, name)
    dst = os.path.join(target, name)
    want = open(src, encoding="utf-8").read()
    if not os.path.exists(dst):
        return "create", want
    have = open(dst, encoding="utf-8").read()
    if have == want:
        return "unchanged", want
    diff = "".join(
        difflib.unified_diff(have.splitlines(True), want.splitlines(True),
                             fromfile=f"{dst} (installed)", tofile=f"{src} (kit)")
    )
    return "differs", diff


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", default=DEFAULT_TARGET, help="directory for both bridge scripts")
    ap.add_argument("--prompts-dir", default=DEFAULT_PROMPTS, help="directory for per-automation prompt files")
    ap.add_argument("--run-dir", default=DEFAULT_RUN_DIR, help="directory for bridge receipts")
    ap.add_argument("--apply", action="store_true", help="write changes")
    ap.add_argument("--force", action="store_true", help="replace an existing file whose contents differ")
    args = ap.parse_args()

    for name in SCRIPTS:
        if not os.path.isfile(os.path.join(ASSETS, name)):
            print(f"ERROR missing kit asset: {ASSETS}/{name}", file=sys.stderr)
            return 2

    plans = {name: plan_one(name, args.target) for name in SCRIPTS}
    blocked = [n for n, (a, _) in plans.items() if a == "differs" and not args.force]

    for name, (action, payload) in plans.items():
        dst = os.path.join(args.target, name)
        if action == "unchanged":
            print(f"unchanged  {dst}")
        elif action == "create":
            print(f"create     {dst}  ({len(payload.splitlines())} lines)")
        else:
            print(f"differs    {dst}" + ("" if args.force else "  [refused without --force]"))
            print(payload)

    for path, label in ((args.prompts_dir, "prompts"), (args.run_dir, "receipts")):
        print(("exists     " if os.path.isdir(path) else "mkdir      ") + f"{path}  ({label})")

    if not args.apply:
        print("\ndry run — nothing written. Re-run with --apply.")
        return 0
    if blocked:
        print(f"\nREFUSED — {', '.join(blocked)} already installed with different contents.", file=sys.stderr)
        print("Review the diff above, then re-run with --force to replace (a backup is kept).", file=sys.stderr)
        return 1

    os.makedirs(args.target, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    for name, (action, _) in plans.items():
        if action == "unchanged":
            continue
        src, dst = os.path.join(ASSETS, name), os.path.join(args.target, name)
        if action == "differs":
            backup = f"{dst}.pre-kit-{stamp}"
            shutil.copy2(dst, backup)
            print(f"backup     {backup}")
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o755)
        print(f"installed  {dst}")
    for path in (args.prompts_dir, args.run_dir):
        os.makedirs(path, exist_ok=True)

    print(f"\nLauncher path for automation instructions:\n  {os.path.join(args.target, 'bridge-launch.sh')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
