#!/usr/bin/env python3
"""Create or update the standing Zo rule that makes bridge hosting the build default.

The rule fires on `create_automation` and carries the full template: a one-line
launcher in the Zo instruction, the work plus the resilience contract in a prompt
file, `worker-start` forbidden, delivery from inside the bridge, the verification
order, and the narrow exception for automations that stay on the plain Zo path.

Idempotent. An existing rule is matched by signature phrase and edited in place, so
repeat runs never leave two competing standards. Dry-run by default.

  set-bridge-rule.py                                  # show what would change
  set-bridge-rule.py --apply                          # create or update
  set-bridge-rule.py --apply --variant canonical      # install the host-proven text
  set-bridge-rule.py --apply --launcher /path/to/bridge-launch.sh
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys

from zolib import UUID_RE, field, rows, tool

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(KIT, "assets")
VARIANTS = {"portable": "rule-bridge-portable.json", "canonical": "rule-bridge-standard.json"}
SIGNATURE = "Build automations CLI-bridge-hosted by default"

DEFAULT_LAUNCHER = "/home/workspace/Skills/automation-resilience/scripts/bridge-launch.sh"
DEFAULT_PROMPTS = "/home/workspace/Skills/automation-resilience/prompts"
DEFAULT_RUN_DIR = "/home/workspace/.zo/cli-bridge-runs"


def find_existing() -> tuple[str | None, str | None, str | None]:
    for row in rows(tool("list_rules", {})):
        inst = field(row, "instruction") or ""
        if SIGNATURE in inst:
            rid = re.search(UUID_RE, row)
            return (rid.group(0) if rid else None), field(row, "condition"), inst
    return None, None, None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variant", choices=sorted(VARIANTS), default="portable")
    ap.add_argument("--file", help="read {condition, instruction} from this JSON file instead")
    ap.add_argument("--launcher", default=DEFAULT_LAUNCHER)
    ap.add_argument("--prompts-dir", default=DEFAULT_PROMPTS)
    ap.add_argument("--run-dir", default=DEFAULT_RUN_DIR)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    path = args.file or os.path.join(ASSETS, VARIANTS[args.variant])
    if not os.path.isfile(path):
        print(f"ERROR rule body not found: {path}", file=sys.stderr)
        return 2
    body = json.load(open(path, encoding="utf-8"))
    subs = {"{{LAUNCHER}}": args.launcher, "{{PROMPTS_DIR}}": args.prompts_dir, "{{RUN_DIR}}": args.run_dir}
    condition, instruction = body["condition"], body["instruction"]
    for token, value in subs.items():
        condition, instruction = condition.replace(token, value), instruction.replace(token, value)
    left = [t for t in subs if t in instruction or t in condition]
    if left:
        print(f"ERROR unsubstituted tokens: {', '.join(left)}", file=sys.stderr)
        return 2

    rule_id, had_cond, had_inst = find_existing()
    if rule_id is None:
        print(f"create rule  ({len(instruction)} chars, variant={args.variant})")
        print(f"  condition: {condition}")
    elif had_inst == instruction and had_cond == condition:
        print(f"unchanged    rule {rule_id} already carries this exact standard")
        return 0
    else:
        print(f"update rule  {rule_id}")
        print("".join(difflib.unified_diff(
            (had_inst or "").splitlines(True), instruction.splitlines(True),
            fromfile="installed", tofile=f"kit:{args.variant}", n=1))[:4000])

    if not args.apply:
        print("\ndry run — nothing written. Re-run with --apply.")
        return 0

    if rule_id is None:
        tool("create_rule", {"condition": condition, "instruction": instruction})
    else:
        tool("edit_rule", {"rule_id": rule_id, "condition": condition, "instruction": instruction})

    # Zo can surface a host lifecycle fault after a mutation has already landed, so the
    # result is read back rather than inferred from the call returning cleanly.
    rid, _, now = find_existing()
    if now != instruction:
        print("VERIFY_FAILED — rule does not read back as written", file=sys.stderr)
        return 1
    print(f"ok  rule {rid} now carries the bridge standard ({len(instruction)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
