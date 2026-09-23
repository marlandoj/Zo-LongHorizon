#!/usr/bin/env python3
"""Scaffold a new CLI-bridge-hosted Zo automation from a work spec.

Creates the automation, writes its contract-carrying prompt file, rewrites the Zo
instruction to the single launcher line, and asserts the schedule is live.

The automation is created first because the prompt file must name its own automation
ID — `bridge-launch.sh` reads that ID out of the prompt so the runner can reconcile
the resilience contract after the CLI exits. Between create and rewrite the
instruction is an inert "report READY and stop", so an early fire is harmless.

  new-bridge-automation.py --title '[SYS] Sweep Stale Leases' \\
      --rrule 'FREQ=DAILY;BYHOUR=7;BYMINUTE=40;BYSECOND=0' \\
      --job sweep-stale-leases --spec spec.md --harness codex --apply

`--harness` picks which agent CLI hosts the run (claude, codex, gemini, kimi, opencode,
hermes, pi); it defaults to claude. The harness must be installed, authenticated, and
carry the zo MCP server — see install-harnesses.py and configure-zo-mcp.py.

The spec is markdown with three optional `## ` sections — Purpose, Work, Delivery.
Anything outside them is treated as Work.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time

from zolib import field, harnesses, list_rows, tool

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(KIT, "assets", "prompt-template.md")
DEFAULT_LAUNCHER = "/home/workspace/Skills/automation-resilience/scripts/bridge-launch.sh"
DEFAULT_PROMPTS = "/home/workspace/Skills/automation-resilience/prompts"
DEFAULT_RUNTIME = "/home/workspace/Skills/automation-resilience/scripts/automation-resilience.ts"
DEFAULT_MODEL = "byok:bd6847f9-1609-403b-b94e-56d11e1f27a5"  # Claude Code - Opus
PREFIXES = ("[ZBR]", "[SYS]", "[MEM]", "[JHF]", "[FFB]", "[BKP]", "[ONE]")
PLACEHOLDER = "Report the single word READY and stop. Call no tools and send nothing."

STAY_SILENT = (
    "Run exactly this command and nothing else:\n\n"
    "```\n{cmd}\n```\n\n"
    "Report only the single line it prints (`DETACHED`, `SKIP overlap`, `SKIP nowork`, or "
    "`ERROR`). Call no other tools and send nothing. The work, the delivery, and the full "
    "AUTOMATION RESILIENCE CONTRACT run inside the detached bridge, not in this turn."
)


def split_spec(text: str) -> dict[str, str]:
    out = {"Purpose": "", "Work": "", "Delivery": ""}
    current, loose = None, []
    for line in text.splitlines():
        m = re.match(r"^##\s+(Purpose|Work|Delivery)\s*$", line.strip(), re.I)
        if m:
            current = m.group(1).title()
            continue
        if current:
            out[current] += line + "\n"
        else:
            loose.append(line)
    if not out["Work"].strip():
        out["Work"] = "\n".join(loose)
    return {k: v.strip() for k, v in out.items()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--title", required=True)
    ap.add_argument("--rrule", required=True, help="e.g. FREQ=DAILY;BYHOUR=7;BYMINUTE=40;BYSECOND=0")
    ap.add_argument("--job", required=True, help="slug used for pidfile, log, and receipt names")
    ap.add_argument("--spec", required=True, help="markdown file with ## Purpose / ## Work / ## Delivery")
    ap.add_argument("--preflight", help="shell test; non-zero exit means no work and no model call")
    ap.add_argument("--harness", default="claude", help="agent CLI that hosts the run (default claude)")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--delivery-method", default="", help="reports the launch line only; delivery is in-bridge")
    ap.add_argument("--launcher", default=DEFAULT_LAUNCHER)
    ap.add_argument("--prompts-dir", default=DEFAULT_PROMPTS)
    ap.add_argument("--runtime", default=DEFAULT_RUNTIME)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    if not re.match(r"^[a-z0-9][a-z0-9-]*$", args.job):
        print("ERROR --job must be a lowercase slug (a-z, 0-9, hyphen)", file=sys.stderr)
        return 2
    if "COUNT=" in args.rrule.upper():
        print("ERROR refusing COUNT= in an rrule: Zo drops BYHOUR/BYMINUTE and the lone "
              "occurrence is consumed, leaving next_run null and the automation silently dead. "
              "Arm a plain recurring rule and delete it after the observed fire.", file=sys.stderr)
        return 2
    reg = harnesses()["harnesses"]
    if args.harness not in reg:
        print(f"ERROR unknown --harness {args.harness!r} (known: {', '.join(reg)})", file=sys.stderr)
        return 2
    h = reg[args.harness]
    if not args.title.startswith(PREFIXES):
        print(f"WARN title has no standard prefix {'/'.join(PREFIXES)}", file=sys.stderr)
    if not os.path.isfile(args.spec):
        print(f"ERROR spec not found: {args.spec}", file=sys.stderr)
        return 2
    if not os.access(args.launcher, os.X_OK):
        print(f"ERROR launcher not executable: {args.launcher}  (run install.py --apply)", file=sys.stderr)
        return 2

    spec = split_spec(open(args.spec, encoding="utf-8").read())
    if not spec["Work"]:
        print("ERROR spec has no Work content", file=sys.stderr)
        return 2

    if not args.apply:
        print(f"would create  {args.title}\n  rrule    {args.rrule}\n  job      {args.job}\n"
              f"  model    {args.model}\n  prompt   {args.prompts_dir}/<new-id8>-{args.job}.md\n"
              f"  preflight {args.preflight or '(none)'}")
        print("\ndry run — nothing written. Re-run with --apply.")
        return 0

    # create_automation's response carries no id, so the new automation is identified by
    # diffing the fleet around the call rather than parsing the return value.
    before = {field(r, "id") for r in list_rows("list_automations")}
    tool("create_automation", {
        "rrule": args.rrule, "instruction": PLACEHOLDER, "model": args.model,
        "delivery_method": args.delivery_method,
    })
    created = ""
    after = {field(r, "id") for r in list_rows("list_automations")}
    new_ids = {i for i in after - before if i}
    if len(new_ids) != 1:
        print(f"ERROR expected exactly one new automation, found {len(new_ids)}: "
              f"{sorted(new_ids)}. Another automation may have been created concurrently; "
              f"reconcile manually before retrying.", file=sys.stderr)
        return 1
    aid = new_ids.pop()
    print(f"created      {aid}")

    prompt = open(TEMPLATE, encoding="utf-8").read()
    for token, value in (("{{TITLE}}", args.title), ("{{AUTOMATION_ID}}", aid),
                         ("{{HARNESS_DISPLAY}}", h["display"]),
                         ("{{TOOL_HINT}}", f" (its tools appear here as `{h['tool_prefix']}<tool>`)"
                          if h["tool_prefix"] else ""),
                         ("{{TOOL_NOTE}}", ("\n" + h["tool_note"]) if h.get("tool_note") else ""),
                         ("{{RUNTIME}}", args.runtime), ("{{PURPOSE}}", spec["Purpose"] or args.title),
                         ("{{WORK}}", spec["Work"]),
                         ("{{DELIVERY}}", spec["Delivery"] or
                          f"Send the result with the zo server's `send_email_to_user` tool from inside this process, "
                          "under a `side-effect-intent` carrying `--verify '{\"kind\":\"email\",\"subject\":\"...\"}'`.")):
        prompt = prompt.replace(token, value)
    os.makedirs(args.prompts_dir, exist_ok=True)
    prompt_path = os.path.join(args.prompts_dir, f"{aid[:8]}-{args.job}.md")
    with open(prompt_path, "w", encoding="utf-8") as fh:
        fh.write(prompt)
    print(f"prompt       {prompt_path}  ({len(prompt)} chars)")

    cmd = f"bash {args.launcher} \\\n  --job {args.job} \\\n  --harness {args.harness} \\\n  --prompt-file {prompt_path}"
    if args.preflight:
        cmd += f" \\\n  --preflight {args.preflight!r}"
    tool("edit_automation", {"automation_id": aid, "title": args.title,
                             "instruction": STAY_SILENT.format(cmd=cmd)})

    # Zo computes next_run asynchronously after an edit, so a single immediate read can
    # report null on a schedule that is about to become live. Poll briefly before failing.
    next_run = None
    for _ in range(6):
        row = tool("get_automation", {"automation_id": aid})
        next_run = field(row, "next_run")
        if next_run:
            break
        time.sleep(4)
    launcher_in_body = args.launcher in (field(row, "instruction") or "")
    if not launcher_in_body:
        print("VERIFY_FAILED — instruction does not carry the launcher", file=sys.stderr)
        return 1
    if not next_run:
        print("VERIFY_FAILED — next_run is null; the schedule is dead. Re-arm with a plain "
              "recurring rrule (no COUNT, no DTSTART).", file=sys.stderr)
        return 1
    print(f"next_run     {next_run}\nok  {aid} is bridge-hosted and scheduled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
