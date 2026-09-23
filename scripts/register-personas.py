#!/usr/bin/env python3
"""Register each installed harness as a Zo persona.

A Zo persona is a config record — instructions, a model pointer, and tool scopes. This
creates one per harness from `harnesses/persona-template.md`, so the operator can pick
"Codex CLI" or "Gemini CLI" in chat the same way they pick any other persona, and so
bridge-hosted automations have a named identity to run as.

A persona that already exists (matched by name or a registry alias, such as "Hermes"
for Hermes Agent) is reported and left alone: its prompt may carry host-specific
tuning, and Zo's persona edit merges prompts through a model, which is not a safe
thing to do unattended.

The model pointer is the part this script cannot create. Zo exposes no tool for adding
a model provider, so connect it first in Settings > AI > Providers (Claude Code and
Codex subscriptions are native there; other harnesses use a Bring-Your-Own-Key entry),
then pass the resulting id:

  register-personas.py                                     # plan for all harnesses
  register-personas.py --apply --model claude=byok:<uuid> --model codex=byok:<uuid>
  register-personas.py --harness gemini --apply            # Zo's default model until set

Only harnesses whose binary is installed are registered unless `--include-missing`.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys

from zolib import KIT, field, harnesses, list_rows, select, tool

TEMPLATE = os.path.join(KIT, "harnesses", "persona-template.md")


def render(name: str, h: dict) -> str:
    text = open(TEMPLATE, encoding="utf-8").read()
    for token, value in (("{{DISPLAY}}", h["display"]), ("{{VENDOR}}", h["vendor"]),
                         ("{{ACP}}", h["acp"]), ("{{BINARY}}", h["binary"]),
                         ("{{HARNESS}}", name), ("{{HEADLESS}}", h["headless"])):
        text = text.replace(token, value)
    return text.strip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--harness", default="all")
    ap.add_argument("--model", action="append", default=[], metavar="HARNESS=MODEL_ID",
                    help="model pointer per harness, e.g. claude=byok:<full-uuid>")
    ap.add_argument("--scopes", default="all", help="persona tool scopes preset, default all")
    ap.add_argument("--include-missing", action="store_true", help="register harnesses that are not installed")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    models = {}
    for item in args.model:
        key, _, value = item.partition("=")
        if not value:
            print(f"ERROR --model expects HARNESS=MODEL_ID, got {item!r}", file=sys.stderr)
            return 2
        if value.startswith("byok:") and len(value) != len("byok:") + 36:
            print(f"ERROR {item}: BYOK ids need the full 36-character UUID", file=sys.stderr)
            return 2
        models[key] = value

    reg = harnesses()["harnesses"]
    existing: dict[str, list[tuple[str, str]]] = {}
    for row in list_rows("list_personas"):
        name = field(row, "name")
        if name:
            existing.setdefault(name, []).append((field(row, "id"), field(row, "model")))

    failed = 0
    for name in select(args.harness):
        h = reg[name]
        names = [h["persona"], *h.get("persona_aliases", [])]
        hit = next((n for n in names if n in existing), None)
        if hit:
            for pid, model in existing[hit]:
                print(f"{name:<9} exists     {hit!r}  id={pid}  model={model}")
                if name in models and models[name] != model:
                    print("          note: --model differs; change it in Settings > AI > Personas")
            if len(existing[hit]) > 1:
                print(f"          WARN {len(existing[hit])} personas share this name; pick one and retire the rest")
            continue
        if not shutil.which(h["binary"]) and not args.include_missing:
            print(f"{name:<9} skip       {h['binary']} not installed (install-harnesses.py first)")
            continue
        model = models.get(name, "")
        print(f"{name:<9} create     {h['persona']!r}  model={model or '(Zo default)'}")
        if not args.apply:
            continue
        payload = {"name": h["persona"], "prompt": render(name, h)}
        if model:
            payload["model"] = model
        tool("create_persona", payload)
        after = {field(r, "name"): field(r, "id") for r in list_rows("list_personas")}
        pid = after.get(h["persona"])
        if not pid:
            print("          FAILED — persona not present on read-back")
            failed += 1
            continue
        tool("set_persona_scopes", {"persona_id": pid, "scopes": [args.scopes]})
        print(f"          created id={pid}")

    if not args.apply:
        print("\ndry run — nothing created. Re-run with --apply.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
