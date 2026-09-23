#!/usr/bin/env python3
"""Install the bridge scripts and the bundled resilience runtime onto a Zo host.

Everything a bridge-hosted automation needs at run time is written into one
directory (default `/home/workspace/Skills/automation-resilience/scripts`):

  bridge-launch.sh              the one-line launcher a Zo automation calls
  harness-detached.sh           the detached runner; drives any of the seven harnesses
  claude-code-detached.sh       compatibility shim for older Claude-only callers
  automation-resilience.ts      the run contract (begin/checkpoint/side-effect/finish)
  recovery-controller.ts        adjudicates runs whose owner disappeared
  recovery_verifiers.py         mailbox and worker evidence for the controller
  audit-bridge-conformance.py   finds automations that drifted off the bridge

The resilience runtime ships in `vendor/automation-resilience/`, so a fresh host needs
nothing else. Its SKILL.md is installed beside the scripts when that skill directory
does not exist yet.

Dry-run by default: prints a unified diff for anything that would change and exits 0
without touching the host. `--apply` commits. An existing file whose contents differ is
refused unless `--force` is passed, because live automations reference these files by
absolute path and replacing one changes their behavior.

  install.py                       # show what would change
  install.py --apply               # install, refusing to clobber differing files
  install.py --apply --force       # replace differing files too (backs them up)
  install.py --apply --only bridge # just the three shell scripts
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
VENDOR = os.path.join(KIT, "vendor", "automation-resilience")

BRIDGE = {
    "bridge-launch.sh": os.path.join(ASSETS, "bridge-launch.sh"),
    "harness-detached.sh": os.path.join(ASSETS, "harness-detached.sh"),
    "claude-code-detached.sh": os.path.join(ASSETS, "claude-code-detached.sh"),
}
RUNTIME = {
    name: os.path.join(VENDOR, "scripts", name)
    for name in ("automation-resilience.ts", "recovery-controller.ts",
                 "recovery_verifiers.py", "audit-bridge-conformance.py")
}
EXECUTABLE = {"bridge-launch.sh", "harness-detached.sh", "claude-code-detached.sh",
              "recovery_verifiers.py", "audit-bridge-conformance.py"}

DEFAULT_TARGET = "/home/workspace/Skills/automation-resilience/scripts"
DEFAULT_PROMPTS = "/home/workspace/Skills/automation-resilience/prompts"
DEFAULT_RUN_DIR = "/home/workspace/.zo/cli-bridge-runs"
DEFAULT_RUNS = "/home/workspace/.zo/automation-runs"


def plan_one(src: str, dst: str) -> tuple[str, str]:
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
    ap.add_argument("--target", default=DEFAULT_TARGET, help="directory for scripts and runtime")
    ap.add_argument("--prompts-dir", default=DEFAULT_PROMPTS, help="directory for per-automation prompt files")
    ap.add_argument("--run-dir", default=DEFAULT_RUN_DIR, help="directory for bridge receipts")
    ap.add_argument("--only", choices=("all", "bridge", "runtime"), default="all")
    ap.add_argument("--apply", action="store_true", help="write changes")
    ap.add_argument("--force", action="store_true", help="replace an existing file whose contents differ")
    ap.add_argument("--quiet-diff", action="store_true", help="list differing files without printing diffs")
    args = ap.parse_args()

    sources: dict[str, str] = {}
    if args.only in ("all", "bridge"):
        sources.update(BRIDGE)
    if args.only in ("all", "runtime"):
        sources.update(RUNTIME)
    missing = [s for s in sources.values() if not os.path.isfile(s)]
    if missing:
        print("ERROR missing kit files:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 2

    plans = {name: plan_one(src, os.path.join(args.target, name)) for name, src in sources.items()}
    blocked = [n for n, (a, _) in plans.items() if a == "differs" and not args.force]

    for name, (action, payload) in plans.items():
        dst = os.path.join(args.target, name)
        if action == "unchanged":
            print(f"unchanged  {dst}")
        elif action == "create":
            print(f"create     {dst}  ({len(payload.splitlines())} lines)")
        else:
            print(f"differs    {dst}" + ("" if args.force else "  [refused without --force]"))
            if not args.quiet_diff:
                print(payload)

    skill_md = os.path.join(os.path.dirname(args.target.rstrip("/")), "SKILL.md")
    want_skill_md = args.only in ("all", "runtime") and not os.path.exists(skill_md)
    if want_skill_md:
        print(f"create     {skill_md}  (bundled automation-resilience SKILL.md)")

    dirs = ((args.prompts_dir, "prompts"), (args.run_dir, "receipts"), (DEFAULT_RUNS, "run records"))
    for path, label in dirs:
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
        dst = os.path.join(args.target, name)
        if action == "differs":
            backup = f"{dst}.pre-kit-{stamp}"
            shutil.copy2(dst, backup)
            print(f"backup     {backup}")
        tmp = f"{dst}.tmp-{os.getpid()}"
        shutil.copyfile(sources[name], tmp)
        os.chmod(tmp, 0o755 if name in EXECUTABLE else 0o644)
        os.replace(tmp, dst)
        print(f"installed  {dst}")
    if want_skill_md:
        shutil.copyfile(os.path.join(VENDOR, "SKILL.md"), skill_md)
        shutil.copyfile(os.path.join(VENDOR, "tsconfig.json"),
                        os.path.join(os.path.dirname(skill_md), "tsconfig.json"))
        print(f"installed  {skill_md}")
    for path, _ in dirs:
        os.makedirs(path, exist_ok=True)

    print(f"\nLauncher path for automation instructions:\n  {os.path.join(args.target, 'bridge-launch.sh')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
