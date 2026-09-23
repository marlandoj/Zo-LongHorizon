#!/usr/bin/env python3
"""Evidence verifiers for automation recovery.

Each subcommand prints one JSON object with a verdict: applied, not_applied, or
ambiguous (for side effects) and completed, failed, running, or ambiguous (for
workers). Verifiers only read systems of record; they never mutate state.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

MCP_URL = os.environ.get("ZO_MCP_URL", "https://api.zo.computer/mcp")
DEFAULT_ROOT = os.environ.get("AUTOMATION_RESILIENCE_ROOT", "/home/workspace/.zo/automation-runs")
SKEW = timedelta(minutes=5)


def now() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def verdict(verifier: str, outcome: str, evidence: str, **details) -> dict:
    return {
        "verifier": verifier,
        "outcome": outcome,
        "evidence": evidence,
        "observed_at": now().isoformat().replace("+00:00", "Z"),
        "details": details,
    }


def mcp_call(name: str, arguments: dict, timeout: int = 60) -> str:
    token = os.environ.get("ZO_CLIENT_IDENTITY_TOKEN")
    if not token:
        raise RuntimeError("ZO_CLIENT_IDENTITY_TOKEN is not available to the verifier")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode()
    request = urllib.request.Request(
        MCP_URL,
        data=body,
        headers={"authorization": token, "content-type": "application/json", "accept": "application/json, text/event-stream"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode())
    if payload.get("error"):
        raise RuntimeError(f"MCP {name} failed: {payload['error'].get('message')}")
    content = payload.get("result", {}).get("content") or []
    return "".join(part.get("text", "") for part in content if isinstance(part, dict))


def extract_ret(text: str):
    match = re.search(r"\bret=(\[.*?\]|None)\s+stash_id=", text, re.S)
    if not match:
        raise RuntimeError("Gmail tool output did not contain a ret= list")
    return ast.literal_eval(match.group(1)) or []


def gmail_search(query: str, max_results: int = 25) -> list[dict]:
    text = mcp_call(
        "use_app_gmail",
        {
            "tool_name": "gmail-find-email",
            "configured_props": {
                "q": query,
                "includeSpamTrash": True,
                "maxResults": max_results,
                "fields": ["subject", "sender", "date", "labelIds"],
            },
        },
    )
    if text.startswith("Error") or "error" in text[:80].lower() and "ret=" not in text:
        raise RuntimeError(text[:400])
    return extract_ret(text)


def verify_email(args: argparse.Namespace) -> dict:
    after = parse_iso(args.after)
    subject = args.subject.strip()
    day = (after - SKEW).strftime("%Y/%m/%d")
    quoted = subject.replace('"', "")
    queries = [f'subject:"{quoted}" after:{day}']
    if args.run_id:
        queries.append(f'"{args.run_id}" after:{day}')
    try:
        messages: dict[str, dict] = {}
        for query in queries:
            for message in gmail_search(query):
                messages[message["id"]] = message
    except (RuntimeError, urllib.error.URLError, TimeoutError, ValueError, SyntaxError) as error:
        return verdict("email", "ambiguous", f"mailbox search failed: {error}", queries=queries)
    matches = []
    for message in messages.values():
        sent = parse_iso(message["date"])
        if sent < after - SKEW:
            continue
        message_subject = str(message.get("subject", ""))
        if re.match(r"^(re:\s*)?automation failed:", message_subject, re.I):
            continue
        subject_hit = subject.lower() in message_subject.lower()
        run_hit = bool(args.run_id) and args.run_id in json.dumps(message)
        if subject_hit or run_hit:
            matches.append({"id": message["id"], "date": message["date"], "subject": message.get("subject"), "sender": message.get("sender"), "labels": message.get("labelIds")})
    if matches:
        first = sorted(matches, key=lambda item: item["date"])[0]
        evidence = f"Gmail message {first['id']} '{first['subject']}' delivered at {first['date']}, after the intent at {args.after}; search included spam and trash"
        return verdict("email", "applied", evidence, matches=matches, queries=queries)
    age_hours = (now() - after).total_seconds() / 3600
    if age_hours >= args.min_age_hours:
        evidence = f"no message matching subject '{subject}' after {args.after} in the recipient mailbox including spam and trash after {age_hours:.1f}h"
        return verdict("email", "not_applied", evidence, queries=queries, age_hours=round(age_hours, 2))
    return verdict("email", "ambiguous", f"no match yet and only {age_hours:.1f}h elapsed (minimum {args.min_age_hours}h)", queries=queries, age_hours=round(age_hours, 2))


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def verify_worker(args: argparse.Namespace) -> dict:
    root = Path(args.root)
    pointer = root / args.automation_id / "latest.json"
    if not pointer.exists():
        return verdict("worker-receipt", "ambiguous", "automation has no latest run")
    run_id = json.loads(pointer.read_text())["run_id"]
    state = json.loads((root / args.automation_id / "runs" / run_id / "state.json").read_text())
    worker = state.get("worker")
    if not worker:
        return verdict("worker-receipt", "ambiguous", "run has no detached worker", run_id=run_id)
    expected = hashlib.sha256(json.dumps(worker["command"], separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    digest_ok = expected == worker["command_digest"]
    artifacts = {path: Path(path).exists() for path in args.artifact}
    result_file = Path(worker["result_file"])
    if result_file.exists():
        result = json.loads(result_file.read_text())
        outcome = "completed" if result.get("exit_code") == 0 else "failed"
        if not digest_ok:
            outcome = "ambiguous"
        missing = [path for path, present in artifacts.items() if not present]
        if missing and outcome == "completed":
            outcome = "ambiguous"
        evidence = f"durable exit record exit_code={result.get('exit_code')} finished_at={result.get('finished_at')} digest_match={digest_ok} missing_artifacts={missing}"
        return verdict("worker-receipt", outcome, evidence, run_id=run_id, pid=worker["pid"], exit_code=result.get("exit_code"), artifacts=artifacts, digest_match=digest_ok)
    if pid_alive(int(worker["pid"])):
        return verdict("worker-receipt", "running", f"worker pid {worker['pid']} is alive", run_id=run_id, pid=worker["pid"])
    stdout_size = Path(worker["stdout_log"]).stat().st_size if Path(worker["stdout_log"]).exists() else None
    return verdict(
        "worker-receipt",
        "ambiguous",
        f"worker pid {worker['pid']} is gone and no exit record exists; stdout_bytes={stdout_size} artifacts={artifacts}",
        run_id=run_id,
        pid=worker["pid"],
        artifacts=artifacts,
        stdout_bytes=stdout_size,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    email = commands.add_parser("email", help="verify an operator email against the recipient mailbox")
    email.add_argument("--subject", required=True)
    email.add_argument("--after", required=True, help="ISO-8601 intent time")
    email.add_argument("--run-id", default=None)
    email.add_argument("--min-age-hours", type=float, default=24.0)
    email.set_defaults(handler=verify_email)
    worker = commands.add_parser("worker", help="verify a detached worker receipt and artifacts")
    worker.add_argument("--automation-id", required=True)
    worker.add_argument("--artifact", action="append", default=[])
    worker.add_argument("--root", default=DEFAULT_ROOT)
    worker.set_defaults(handler=verify_worker)
    args = parser.parse_args()
    result = args.handler(args)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
