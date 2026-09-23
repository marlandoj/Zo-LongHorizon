#!/usr/bin/env python3
"""Report which active Zo automations are not CLI-bridge-hosted.

The bridge pattern is the build standard for any automation whose work is
long-running, dispatch-heavy, or delivery-bearing, because Zo kills every model
call at 120 s. This audit lists active automations, marks the ones already on
the bridge, and flags the rest that carry long-work signals.

Usage:
  python3 audit-bridge-conformance.py [--json] [--all]
Exit: 0 clean, 1 conversion candidates found, 2 audit could not run.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MCP_URL = "https://api.zo.computer/mcp"
BRIDGE_MARKERS = ("bridge-launch.sh", "hosted by the claude code cli bridge")

# Signals that a run cannot be trusted to finish inside one 120 s model call.
LONG_WORK_SIGNALS = [
    ("zo-ask-dispatch", r"/zo/ask|zo_ask|ask_zo"),
    ("consensus-or-moa", r"consensus|moa[\s-]|lineup|panel"),
    ("swarm-or-factory", r"swarm|factory|conveyor|dispatch"),
    ("queue-drain", r"drain|queue|backlog|sweep"),
    ("repo-mutation", r"\bgit \b|gh pr|commit|merge|reindex|autofix"),
    ("delivery", r"send_email|send_sms|email the|report to"),
    ("multi-step-contract", r"AUTOMATION RESILIENCE CONTRACT|automation-resilience\.ts"),
]


def mcp_tool(name, arguments=None, timeout=120, attempts=3):
    """Call one Zo MCP tool over HTTP, retrying transient host faults.

    `snapshot_failed` is a Zo host lifecycle fault, not a bad request; a cold
    endpoint can also exceed the first connect. Both clear on retry.
    """
    key = os.environ.get("ZO_MCP_API_KEY")
    if not key:
        raise SystemExit("ZO_MCP_API_KEY is not set")
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}}}
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(
                MCP_URL, data=json.dumps(body).encode(),
                headers={"Authorization": f"Bearer {key}",
                         "Content-Type": "application/json",
                         "Accept": "application/json, text/event-stream"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode()
            for line in raw.splitlines():
                if line.startswith("data: "):
                    raw = line[6:]
                    break
            payload = json.loads(raw)
            for chunk in payload.get("result", {}).get("content", []):
                if chunk.get("type") == "text":
                    return chunk["text"]
            last = json.dumps(payload)[:300]
        except Exception as exc:
            last = str(exc)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{name} failed after {attempts} attempts: {last}")


def field(record, name):
    """Read a field out of Zo's Python-repr automation record.

    Zo switches to double quotes whenever the value contains an apostrophe, so a
    single-quote-only pattern silently returns None on perfectly good records.
    """
    for quote in ("'", '"'):
        match = re.search(rf"{name}={quote}(.*?){quote}(?=\s+\w+=|$)", record, re.S)
        if match:
            return match.group(1)
    match = re.search(rf"{name}=(\S+)", record)
    return match.group(1) if match else None


def classify(instruction):
    text = (instruction or "").lower()
    if any(marker in text for marker in BRIDGE_MARKERS):
        return "bridge", []
    return "zo-hosted", [name for name, pattern in LONG_WORK_SIGNALS
                         if re.search(pattern, text, re.I)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--all", action="store_true", help="include clean Zo-hosted automations")
    args = parser.parse_args()

    try:
        raw = mcp_tool("list_automations", {})
        records = json.loads(raw) if raw.strip().startswith("[") else [raw]
    except Exception as exc:  # network, auth, or schema drift
        print(f"AUDIT-ERROR {exc}", file=sys.stderr)
        return 2

    active = [r for r in records if field(r, "active") in ("True", "true")]

    # list_automations truncates the instruction at ~200 chars, which hides the
    # bridge launcher in any converted automation. Classification must read the
    # full body, so fetch each one.
    def full_instruction(record):
        automation_id = field(record, "id")
        try:
            return field(mcp_tool("get_automation", {"automation_id": automation_id}), "instruction")
        except Exception:
            return field(record, "instruction")

    with ThreadPoolExecutor(max_workers=4) as pool:
        instructions = list(pool.map(full_instruction, active))

    rows = []
    for record, instruction in zip(active, instructions):
        kind, signals = classify(instruction)
        rows.append({
            "id": field(record, "id"),
            "title": field(record, "title"),
            "hosting": kind,
            "signals": signals,
            "next_run": field(record, "next_run"),
        })

    # Nearly every automation embeds the resilience contract, so that signal alone
    # says nothing about runtime. A conversion candidate needs a signal that implies
    # real work: dispatch, panel, drain, repo mutation, or delivery.
    def strong(row):
        return [s for s in row["signals"] if s != "multi-step-contract"]

    candidates = [r for r in rows if r["hosting"] == "zo-hosted" and strong(r)]
    watch = [r for r in rows if r["hosting"] == "zo-hosted" and not strong(r) and r["signals"]]
    dead = [r for r in rows if r["next_run"] in (None, "None")]

    if args.json:
        print(json.dumps({"total": len(rows),
                          "bridge": sum(1 for r in rows if r["hosting"] == "bridge"),
                          "candidates": candidates,
                          "watch": watch,
                          "dead_schedules": dead,
                          "rows": rows if args.all else None}, indent=2))
    else:
        print(f"active={len(rows)}  bridge-hosted={sum(1 for r in rows if r['hosting'] == 'bridge')}  "
              f"convert={len(candidates)}  watch={len(watch)}  dead-schedules={len(dead)}")
        for row in candidates:
            print(f"  CONVERT  {row['id'][:8]}  {row['title']}  [{', '.join(strong(row))}]")
        for row in watch:
            print(f"  WATCH    {row['id'][:8]}  {row['title']}  (contract only)")
        for row in dead:
            print(f"  DEAD     {row['id'][:8]}  {row['title']}  next_run=None")
        if args.all:
            for row in rows:
                if row not in candidates and row not in dead:
                    print(f"  OK       {row['id'][:8]}  {row['title']}  ({row['hosting']})")

    return 1 if candidates or dead else 0


if __name__ == "__main__":
    sys.exit(main())
