---
name: zo-bridge-kit
description: Install and operate CLI-bridge hosting for Zo automations — write the bridge scripts, set the standing rule that makes bridge hosting the build default, and scaffold a new contract-carrying automation. Use when standing this pattern up on a Zo host, when an automation dies silently at Zo's 120 s per-call ceiling or session cap, or when a scheduled run must outlive its Zo turn.
compatibility: Created for Zo Computer. Requires the Claude Code CLI, bun, and a reachable zo MCP server.
metadata:
  author: marlandoj.zo.computer
  repository: https://github.com/marlandoj/zo-bridge-kit
---

# Zo Bridge Kit

Zo enforces a **120 s ceiling on every model call** and a session cap on every run. An
automation whose work exceeds either dies with nothing surfaced — no error, no email,
and a dead run that looks exactly like a quiet success.

The fix inverts the stack. Instead of Zo owning the agent loop and borrowing Claude as a
model, the **Claude Code CLI owns the loop** and borrows Zo as an MCP tool server. The Zo
turn shrinks to about one second: it launches a detached `claude -p` and returns. No Zo
model call happens, so no Zo model-call limit applies.

```
scheduler tick -> bridge-launch.sh (Zo turn, ~1s, returns)
                    -> claude-code-detached.sh  (setsid nohup)
                         -> claude -p  ..... owns the agent loop
                              <-> zo MCP ... email, SMS, files, shell, apps
```

This skill installs that machinery and keeps it honest. The runtime contract itself —
`begin` / `checkpoint` / `side-effect-intent` / `side-effect-resolve` / `finish`, plus the
recovery controller that adjudicates a run whose owner disappeared — lives in the
`automation-resilience` skill. This kit does not reimplement it; it moves it inside the
bridge and wires the two together.

## Install

```bash
set -a; . /root/.zo_secrets; set +a         # scripts need ZO_MCP_API_KEY

python3 scripts/preflight.py                # claude, bun, zo MCP, writable dirs
python3 scripts/install.py                  # dry run: show what would change
python3 scripts/install.py --apply          # write bridge-launch.sh + claude-code-detached.sh
python3 scripts/set-bridge-rule.py --apply  # make bridge hosting the create_automation default
```

`install.py` is dry-run by default and prints a unified diff for anything that differs.
It **refuses to replace an existing script whose contents differ** unless `--force` is
passed, because live automations reference the launcher by absolute path — replacing it
silently changes their behavior. `--force` keeps a timestamped backup.

`set-bridge-rule.py` is idempotent: an existing rule is matched by signature phrase and
edited in place, so repeated runs never leave two competing standards. `--variant portable`
(default) substitutes your install paths into a generic rule body; `--variant canonical`
installs the host-proven text verbatim. Either way the rule is **read back and compared**
after writing, because a Zo host lifecycle fault can surface after a mutation has landed.

## Build a new automation

```bash
python3 scripts/new-bridge-automation.py \
  --title '[SYS] Sweep Stale Leases' \
  --rrule 'FREQ=DAILY;BYHOUR=7;BYMINUTE=40;BYSECOND=0' \
  --job sweep-stale-leases --spec my-spec.md --apply
```

The spec is markdown with `## Purpose`, `## Work`, and `## Delivery` sections. The script
creates the automation, writes the contract-carrying prompt from
`assets/prompt-template.md`, rewrites the Zo instruction to the single launcher line, and
asserts the schedule is live.

The automation is created **before** the prompt file because the prompt must name its own
automation ID — `bridge-launch.sh` reads that ID out of the prompt so the runner can
reconcile the contract after the CLI exits. Between create and rewrite the instruction is
an inert "report READY and stop", so an early fire is harmless.

Two refusals are built in: a `--job` that is not a lowercase slug, and any `COUNT=` in the
rrule. Zo normalizes an rrule to a `DTSTART` at the edit moment and drops
`BYHOUR`/`BYMINUTE`, so `COUNT=1` consumes the only occurrence and leaves `next_run` null
on an automation that still reads `active` — a silently dead schedule.

## What goes in the automation, and what does not

The Zo instruction body is one launcher line plus a stay-silent contract:

```
bash <install-dir>/bridge-launch.sh \
  --job <job> \
  --prompt-file <prompts-dir>/<automation-id8>-<job>.md \
  [--preflight '<cheap test that exits non-zero when there is no work>']
```

Report only the single line it prints — `DETACHED`, `SKIP overlap`, `SKIP nowork`, or
`ERROR` — call no other tools, and send nothing.

Everything else lives in the prompt file. Three rules govern that prompt:

**Run synchronously in the foreground.** `claude -p` exits the moment the model stops
emitting, so a backgrounded command, a `run_in_background` task, or a monitor armed "to
notify me" is killed unfinished and nothing wakes the agent. There is no per-call ceiling
inside the bridge — that is the entire point — so block on long commands instead of
detaching them.

**Never call `worker-start`.** The bridge *is* the long-lived worker. Do not build parallel
orphan detection either: a bridge that dies mid-run already classifies as
`side_effect_uncertain` or `owner_lost_host_restart`, both of which the recovery controller
sweeps and adjudicates.

**Deliver from inside the bridge**, through `mcp__zo__send_email_to_user` or the relevant Zo
MCP tool. The automation's `delivery_method` only ever sees the one-second launch line, so
it can never carry the output. A detached process also inherits none of the Zo turn's
environment — the prompt's first step must source the host secrets file before anything
reads an API key.

## Verify

1. `next_run` is non-null after any create or edit. Null on an active automation is a dead
   schedule, and it looks identical to a schedule that simply has not fired yet.
2. No `COUNT=` one-shots. Arm a plain recurring rule and delete it after the observed fire.
3. After the first real fire, a receipt under the run directory whose **`outcome` is `ok`**,
   and delivery confirmed independently — mailbox, file, or queue state — not from the
   bridge's own self-report.

Judge a run by `outcome`, never by `exit_code` alone. A clean CLI exit with the contract
still `in_progress` is `ended_mid_contract`, which is a failure that exits 0.

## When not to bridge

Keep an automation on the plain Zo path only when the whole run is one short model turn:
no dispatch to another agent, no consensus panel, no queue drain, no repo mutation, and
total runtime comfortably under the 120 s ceiling. Short, cheap automations gain nothing
from the bridge and add a process to supervise. When in doubt, bridge it.

## Files

| Path | Purpose |
|---|---|
| `scripts/preflight.py` | Verify a host can run bridge-hosted automations |
| `scripts/install.py` | Install both bridge scripts; dry-run, diff, refuse-to-clobber |
| `scripts/set-bridge-rule.py` | Create or update the standing Zo rule, idempotently |
| `scripts/new-bridge-automation.py` | Scaffold a new bridge-hosted automation from a spec |
| `scripts/render-infographic.py` | Render the architecture infographic to PNG |
| `scripts/zolib.py` | Zo MCP over HTTP + Python-repr field parsing |
| `scripts/zo-mcp.py` | One-shot Zo MCP tool call from the shell |
| `assets/bridge-launch.sh` | The launcher a Zo automation calls |
| `assets/claude-code-detached.sh` | The detached runner that owns the loop |
| `assets/prompt-template.md` | Contract-carrying prompt skeleton |
| `assets/rule-bridge-portable.json` | Generic standing-rule body with path tokens |
| `assets/rule-bridge-standard.json` | Host-proven standing-rule body, verbatim |
| `docs/ARCHITECTURE.md` | Why the loop moves, and what each limit actually is |

On a host that already runs `automation-resilience`, convert existing automations with that
skill's `convert-to-bridge.py` and watch for drift with its `audit-bridge-conformance.py`.
This kit covers standing the pattern up and building new automations on it.
