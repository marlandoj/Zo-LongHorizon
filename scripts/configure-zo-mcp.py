#!/usr/bin/env python3
"""Register the Zo MCP server with every harness, then prove each one connects.

Each harness has its own config file and its own way of reading a bearer token. This
writes one `zo` server entry per harness pointing at https://api.zo.computer/mcp, with
the token always referenced by environment variable (ZO_MCP_API_KEY) and never
inlined, so rotating the token needs no config edit.

  harness   file                                  token form
  claude    <workspace>/.mcp.json                 headers "Bearer ${VAR}" + bearerTokenEnvVar
  codex     ~/.codex/config.toml                  bearer_token_env_var
  gemini    ~/.gemini/settings.json               headers "Bearer ${VAR}"
  kimi      ~/.kimi-code/mcp.json                 bearerTokenEnvVar (no ${VAR} expansion)
  opencode  ~/.config/opencode/opencode.jsonc     headers "Bearer {env:VAR}"
  hermes    ~/.hermes/config.yaml                 headers "Bearer ${VAR}"
  pi        ~/.pi/agent/mcp.json                  headers "Bearer ${VAR}"; needs pi-mcp-adapter (npm -g)

Dry-run by default. `--apply` writes, keeping a timestamped backup of every file it
touches. An existing `zo` entry that differs is reported and left alone unless
`--force` is passed; an entry with an inlined token is always flagged. `--verify`
runs each harness's own MCP status command afterwards.

  configure-zo-mcp.py                       # show the plan for all seven
  configure-zo-mcp.py --apply --verify      # write and prove
  configure-zo-mcp.py --harness pi --apply  # one harness
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

from zolib import expand, harnesses, select

try:
    import tomllib
except ImportError:  # Python < 3.11
    tomllib = None
try:
    import yaml
except ImportError:
    yaml = None

STAMP = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def desired(fmt: str, url: str, var: str):
    bearer = f"Bearer ${{{var}}}"
    return {
        "claude-json": {"type": "http", "url": url, "headers": {"Authorization": bearer},
                        "bearerTokenEnvVar": var},
        "kimi-json": {"url": url, "bearerTokenEnvVar": var,
                      "startupTimeoutMs": 180000, "toolTimeoutMs": 180000},
        "gemini-json": {"url": url, "type": "http", "headers": {"Authorization": bearer},
                        "trust": True, "timeout": 180000},
        "opencode-jsonc": {"type": "remote", "url": url, "enabled": True, "timeout": 60000,
                           "headers": {"Authorization": f"Bearer {{env:{var}}}"}},
        "pi-json": {"url": url, "headers": {"Authorization": bearer}},
        "codex-toml": {"url": url, "bearer_token_env_var": var,
                       "startup_timeout_sec": 90, "tool_timeout_sec": 180},
        "hermes-yaml": {"url": url, "headers": {"Authorization": bearer},
                        "timeout": 180, "connect_timeout": 60},
    }[fmt]


def strip_jsonc(text: str) -> str:
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1]); i += 2; continue
            if c == '"':
                in_str = False
        elif c == '"':
            in_str = True; out.append(c)
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        else:
            out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def inline_secret(entry) -> bool:
    blob = json.dumps(entry)
    m = re.search(r'"Bearer ([^"]+)"', blob)
    return bool(m) and not re.match(r"(\$\{|\{env:|\$env:)", m.group(1))


def read_current(fmt: str, path: str):
    """Return (whole-document, current zo entry or None)."""
    if not os.path.exists(path):
        return None, None
    text = open(path, encoding="utf-8").read()
    if fmt.endswith("json") or fmt == "opencode-jsonc":
        doc = json.loads(strip_jsonc(text)) if text.strip() else {}
        key = "mcp" if fmt == "opencode-jsonc" else "mcpServers"
        return doc, (doc.get(key) or {}).get("zo")
    if fmt == "codex-toml":
        if tomllib is None:
            raise SystemExit("codex config needs Python 3.11+ (tomllib)")
        doc = tomllib.loads(text)
        return text, (doc.get("mcp_servers") or {}).get("zo")
    if fmt == "hermes-yaml":
        if yaml is None:
            raise SystemExit("hermes config needs PyYAML: pip install pyyaml")
        doc = yaml.safe_load(text) or {}
        return text, (doc.get("mcp_servers") or {}).get("zo")
    raise SystemExit(f"unknown format {fmt}")


def render(fmt: str, path: str, doc, want) -> str:
    if fmt.endswith("json") or fmt == "opencode-jsonc":
        doc = dict(doc or {})
        key = "mcp" if fmt == "opencode-jsonc" else "mcpServers"
        if fmt == "opencode-jsonc":
            doc.setdefault("$schema", "https://opencode.ai/config.json")
        servers = dict(doc.get(key) or {})
        servers["zo"] = want
        doc[key] = servers
        return json.dumps(doc, indent=2) + "\n"
    text = doc or ""
    if fmt == "codex-toml":
        text = re.sub(r"(?ms)^\[mcp_servers\.zo(\.[^\]]*)?\]\n.*?(?=^\[|\Z)", "", text).rstrip()
        block = "[mcp_servers.zo]\n" + "".join(f"{k} = {json.dumps(v)}\n" for k, v in want.items())
        return (text + "\n\n" if text else "") + block
    if fmt == "hermes-yaml":
        block = ("  zo:\n"
                 f"    url: {want['url']}\n"
                 "    headers:\n"
                 f"      Authorization: {want['headers']['Authorization']}\n"
                 f"    timeout: {want['timeout']}\n"
                 f"    connect_timeout: {want['connect_timeout']}\n")
        text = re.sub(r"(?ms)^  zo:\n(?:^    .*\n|^\s*\n)*", "", text)
        if re.search(r"(?m)^mcp_servers:\s*(\{\})?\s*$", text):
            return re.sub(r"(?m)^mcp_servers:\s*(\{\})?\s*$", "mcp_servers:\n" + block.rstrip("\n"), text, count=1)
        return text.rstrip() + "\n\nmcp_servers:\n" + block
    raise SystemExit(f"unknown format {fmt}")


def same(fmt: str, cur, want) -> bool:
    if cur is None:
        return False
    return all(cur.get(k) == v for k, v in want.items())


def pi_adapter_installed() -> bool:
    try:
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return False
    return os.path.isfile(os.path.join(root, "pi-mcp-adapter", "index.ts"))


def verify(name: str, h: dict) -> tuple[bool, str]:
    cmd = h["mcp"]["verify"]
    if not shutil.which(cmd[0]):
        return False, f"{cmd[0]} not installed"
    env = dict(os.environ, IS_SANDBOX="1")
    for attempt in range(2):  # a cold Zo endpoint can outlast a harness's connect timeout
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=env, cwd="/home/workspace")
        except subprocess.TimeoutExpired:
            text, code = "timed out", 124
        else:
            text, code = (out.stdout + out.stderr), out.returncode
        needle = h["mcp"].get("verify_needle", "zo")
        bad = re.search(r"(?i)\bzo\b[^\n]*(fail|error|disconnected|✗)", text)
        if code == 0 and needle in text and not bad:
            return True, " ".join(cmd)
    return False, f"{' '.join(cmd)} -> exit {code}: {text.strip()[:160]}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harness", default="all")
    ap.add_argument("--workspace", default="/home/workspace")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true", help="replace a differing zo entry")
    ap.add_argument("--verify", action="store_true", help="run each harness's MCP status command")
    ap.add_argument("--backup-dir", default=f"/home/workspace/Backups/harness-mcp/{STAMP}")
    args = ap.parse_args()

    reg = harnesses()
    url, var = reg["zo_mcp"]["url"], reg["zo_mcp"]["token_env"]
    if not os.environ.get(var):
        print(f"WARN {var} is not set in this shell. Configs reference it by name, so they are "
              f"still correct, but --verify will fail until it is exported (see docs/ZO-MCP-SETUP.md).")

    refused = failed = 0
    for name in select(args.harness):
        h = reg["harnesses"][name]
        fmt, path = h["mcp"]["format"], expand(h["mcp"]["path"], args.workspace)
        want = desired(fmt, url, var)
        doc, cur = read_current(fmt, path)
        if same(fmt, cur, want):
            state = "unchanged"
        elif cur is None:
            state = "add"
        else:
            state = "differs"
        note = "  [inline token — replace with --force]" if cur is not None and inline_secret(cur) else ""
        print(f"{name:<9} {state:<10} {path}{note}")
        if state == "differs" and not args.force:
            print(f"          current: {json.dumps(cur)[:200]}")
            refused += 1
        writable = state == "add" or (state == "differs" and args.force)
        if args.apply and writable:
            if os.path.exists(path):
                os.makedirs(args.backup_dir, exist_ok=True)
                shutil.copy2(path, os.path.join(args.backup_dir, name + "-" + os.path.basename(path)))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(render(fmt, path, doc, want))
            _, after = read_current(fmt, path)
            if not same(fmt, after, want):
                print("          FAILED read-back")
                failed += 1
                continue
            print("          written and read back")
        if name == "pi" and shutil.which("pi") and not pi_adapter_installed():
            step = reg["harnesses"]["pi"]["post_install"]
            if args.apply:
                print("          installing pi-mcp-adapter: " + " ".join(step))
                if subprocess.run(step, timeout=600).returncode != 0:
                    failed += 1
            else:
                print("          would run: " + " ".join(step) + "  (Pi has no built-in MCP)")
        if args.verify:
            ok, detail = verify(name, h)
            print(f"          verify {'PASS' if ok else 'FAIL'}  {detail}")
            failed += 0 if ok else 1

    if not args.apply:
        print("\ndry run — nothing written. Re-run with --apply.")
    if refused and not args.force:
        print(f"\n{refused} differing entr{'y' if refused == 1 else 'ies'} left alone; review, then --force to replace.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
