"""Shared helpers for the Zo bridge kit: MCP-over-HTTP calls and Python-repr parsing.

Zo's MCP tools return Python `repr()` strings rather than JSON for automations, rules,
and personas. Values switch from single to double quotes whenever they contain an
apostrophe, so fields are scanned with explicit quote tracking rather than a regex.
"""
from __future__ import annotations

import ast
import json
import os
import re
import urllib.error
import urllib.request

MCP_URL = os.environ.get("ZO_MCP_URL", "https://api.zo.computer/mcp")
UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def api_key() -> str:
    key = os.environ.get("ZO_MCP_API_KEY") or os.environ.get("ZO_CLIENT_IDENTITY_TOKEN")
    if not key:
        raise SystemExit(
            "ZO_MCP_API_KEY not set. Source the host secrets first:\n"
            "  set -a; . /root/.zo_secrets; set +a"
        )
    return key


def rpc(method: str, params: dict | None = None, timeout: int = 120) -> dict:
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(
        MCP_URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {api_key()}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    for line in raw.splitlines():
        if line.startswith("data: "):
            raw = line[6:]
            break
    return json.loads(raw)


def tool(name: str, args: dict | None = None, timeout: int = 120, retries: int = 4) -> str:
    """Call a Zo MCP tool and return its first text content block.

    Retries on transport faults. A Zo host lifecycle fault (`snapshot_failed`) can
    surface mid-call after the mutation already landed, so callers that mutate state
    must verify by reading back rather than trusting a raised error.
    """
    last = None
    for attempt in range(retries):
        try:
            res = rpc("tools/call", {"name": name, "arguments": args or {}}, timeout)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            continue
        out = res.get("result", res)
        if isinstance(out, dict):
            for c in out.get("content", []):
                if c.get("type") == "text":
                    return c["text"]
        return json.dumps(out)
    raise SystemExit(f"MCP call {name} failed after {retries} attempts: {last}")


def _value_starts(row: str) -> dict[str, int]:
    """Index every `name=` that sits outside a quoted string.

    Quoted regions are skipped wholesale: an instruction body can itself contain text
    like `next_run=` or `active=`, and matching that returns a garbage value for a field
    the record actually sets correctly further along.
    """
    pos: dict[str, int] = {}
    i, n = 0, len(row)
    while i < n:
        c = row[i]
        if c in "'\"":
            i += 1
            while i < n:
                if row[i] == "\\":
                    i += 2
                    continue
                if row[i] == c:
                    break
                i += 1
            i += 1
            continue
        m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=", row[i:])
        if m and (i == 0 or row[i - 1] in " ([{,"):
            pos.setdefault(m.group(1), i + len(m.group(1)) + 1)
            i += len(m.group(0))
            continue
        i += 1
    return pos


def field(row: str, name: str):
    """Extract `name=<value>` from a Python-repr row.

    Zo returns three value shapes in one record and conflating them is the classic
    parsing bug here. Strings are quoted, and flip from single to double quotes whenever
    they contain an apostrophe. Datetimes and booleans are bare reprs
    (`next_run=datetime.datetime(...)`, `active=True`) — reading only quoted values makes
    every schedule on the host look dead. A literal `None` returns None.

    Quoted values are returned decoded; bare values are returned as their literal text.
    """
    j = _value_starts(row).get(name)
    if j is None or j >= len(row):
        return None

    if row[j] in "'\"":
        quote, k = row[j], j + 1
        while k < len(row):
            if row[k] == "\\":
                k += 2
                continue
            if row[k] == quote:
                break
            k += 1
        try:
            return ast.literal_eval(row[j : k + 1])
        except (SyntaxError, ValueError):
            return None

    depth, k = 0, j
    while k < len(row):
        c = row[k]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and c == " " and re.match(r"\s+[A-Za-z_][A-Za-z0-9_]*=", row[k:]):
            break
        k += 1
    value = row[j:k].strip().rstrip(",")
    return None if value in ("None", "") else value


def rows(text: str) -> list[str]:
    """Parse a Zo MCP list response into one repr string per record."""
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < start:
        return []
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    return [r for r in parsed if isinstance(r, str)]
