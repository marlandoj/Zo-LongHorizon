#!/usr/bin/env python3
"""Convert an existing Zo-hosted automation to bridge hosting on any harness.

The automation's instruction must carry the AUTOMATION RESILIENCE CONTRACT — either the
`<!-- END AUTOMATION RESILIENCE CONTRACT v1 -->` marker or the older plain-text ending
"The original automation instruction begins immediately after this contract." Everything
after that boundary is the work body. It moves into a prompt file rendered from
`assets/prompt-template.md`, and the Zo instruction becomes the one launcher line.

  convert-to-bridge.py --automation-id <full-uuid> --job <slug>                 # dry run
  convert-to-bridge.py --automation-id <full-uuid> --job <slug> --harness gemini --apply

Refuses an automation that is already converted, has no contract boundary, or whose
work body is under 200 characters (a contract placed at the end would otherwise leave
the bridge an empty prompt). The original instruction is backed up beside the prompt,
and the result is read back: the instruction must carry the launcher and `next_run`
must be non-null.

Conversion is a hosting change only. Do not add `--preflight` unless the automation
already had a skip condition — that changes when it does nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

from zolib import KIT, UUID_RE, field, harnesses, tool

TEMPLATE = os.path.join(KIT, "assets", "prompt-template.md")
DEFAULT_LAUNCHER = "/home/workspace/Skills/automation-resilience/scripts/bridge-launch.sh"
DEFAULT_PROMPTS = "/home/workspace/Skills/automation-resilience/prompts"
DEFAULT_RUNTIME = "/home/workspace/Skills/automation-resilience/scripts/automation-resilience.ts"
END_MARK = "<!-- END AUTOMATION RESILIENCE CONTRACT v1 -->"
LEGACY_END = "The original automation instruction begins immediately after this contract."
MIN_BODY_CHARS = 200

STAY_SILENT = (
    "Run exactly this command and nothing else:\n\n"
    "```\n{cmd}\n```\n\n"
    "Report only the single line it prints (`DETACHED`, `SKIP overlap`, `SKIP nowork`, or "
    "`ERROR`). Call no other tools and send nothing, except on `ERROR`: then send one short "
    "email to the user with the ERROR line verbatim. The work, the delivery, and the full "
    "AUTOMATION RESILIENCE CONTRACT run inside the detached bridge, not in this turn."
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--automation-id", required=True, help="FULL uuid; an 8-char prefix does not resolve")
    ap.add_argument("--job", required=True)
    ap.add_argument("--harness", default="claude")
    ap.add_argument("--preflight", default="")
    ap.add_argument("--launcher", default=DEFAULT_LAUNCHER)
    ap.add_argument("--prompts-dir", default=DEFAULT_PROMPTS)
    ap.add_argument("--runtime", default=DEFAULT_RUNTIME)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    if not re.fullmatch(UUID_RE, args.automation_id):
        print("ERROR --automation-id must be the full 36-character UUID", file=sys.stderr)
        return 2
    if not re.match(r"^[a-z0-9][a-z0-9-]*$", args.job):
        print("ERROR --job must be a lowercase slug", file=sys.stderr)
        return 2
    reg = harnesses()["harnesses"]
    if args.harness not in reg:
        print(f"ERROR unknown --harness {args.harness!r} (known: {', '.join(reg)})", file=sys.stderr)
        return 2
    h = reg[args.harness]

    rec = tool("get_automation", {"automation_id": args.automation_id})
    aid, title, instruction = field(rec, "id"), field(rec, "title"), field(rec, "instruction") or ""
    if not aid:
        print(f"ERROR automation not found: {args.automation_id}", file=sys.stderr)
        return 1
    if "bridge-launch.sh" in instruction:
        print(f"ERROR already bridge-hosted: {title}", file=sys.stderr)
        return 1
    boundary = END_MARK if END_MARK in instruction else LEGACY_END if LEGACY_END in instruction else None
    if not boundary:
        print(f"ERROR no resilience contract boundary; convert by hand: {title}", file=sys.stderr)
        return 1
    body = instruction.split(boundary, 1)[1].strip()
    if len(body) < MIN_BODY_CHARS:
        print(f"ERROR work body after the contract is {len(body)} chars (min {MIN_BODY_CHARS}): {title}",
              file=sys.stderr)
        return 1

    m = re.search(r"Agent Purpose Summary:?\s*(.*?)(?:\n\n|$)", body, re.S)
    purpose = m.group(1).strip() if m else title
    prompt = open(TEMPLATE, encoding="utf-8").read()
    for token, value in (("{{TITLE}}", title), ("{{AUTOMATION_ID}}", aid),
                         ("{{HARNESS_DISPLAY}}", h["display"]),
                         ("{{TOOL_HINT}}", f" (its tools appear here as `{h['tool_prefix']}<tool>`)"
                          if h["tool_prefix"] else ""),
                         ("{{RUNTIME}}", args.runtime), ("{{PURPOSE}}", purpose), ("{{WORK}}", body),
                         ("{{DELIVERY}}", "Deliver exactly as the work above specifies, from inside this "
                          "process, each send wrapped in `side-effect-intent` / `side-effect-resolve`.")):
        prompt = prompt.replace(token, value)
    prompt_path = os.path.join(args.prompts_dir, f"{aid[:8]}-{args.job}.md")
    cmd = f"bash {args.launcher} --job {args.job} --harness {args.harness} --prompt-file {prompt_path}"
    if args.preflight:
        cmd += f" --preflight {args.preflight!r}"
    new_instruction = STAY_SILENT.format(cmd=cmd)

    if not args.apply:
        print(f"=== PROMPT {prompt_path} ({len(prompt)} chars) ===\n{prompt}\n=== NEW ZO INSTRUCTION ===\n{new_instruction}")
        print("\ndry run — nothing written. Re-run with --apply.")
        return 0

    os.makedirs(args.prompts_dir, exist_ok=True)
    backup = os.path.join(args.prompts_dir, f"_pre-bridge-{aid[:8]}.instruction.txt")
    with open(backup, "w", encoding="utf-8") as fh:
        fh.write(instruction)
    with open(prompt_path, "w", encoding="utf-8") as fh:
        fh.write(prompt)
    tool("edit_automation", {"automation_id": aid, "instruction": new_instruction})

    next_run, after = None, ""
    for _ in range(6):
        after = tool("get_automation", {"automation_id": aid})
        next_run = field(after, "next_run")
        if next_run:
            break
        time.sleep(4)
    ok_instr = "bridge-launch.sh" in (field(after, "instruction") or "")
    status = "OK" if ok_instr and next_run else "VERIFY_FAILED"
    print(json.dumps({"automation": aid, "title": title, "job": args.job, "harness": args.harness,
                      "prompt_file": prompt_path, "instruction_backup": backup,
                      "instruction_applied": ok_instr, "next_run": next_run, "status": status}, indent=2))
    return 0 if status == "OK" else 1


if __name__ == "__main__":
    sys.exit(main())
