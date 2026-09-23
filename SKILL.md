---
name: zo-bridge-kit
description: Stand up and operate harness-hosted Zo automations on any of seven agent CLIs (Claude Code, Codex, Gemini, Kimi, OpenCode, Hermes, Pi) — install the harnesses, wire the Zo MCP server into each, install the bundled automation-resilience runtime and detached bridge, register harness personas, set the standing rule that makes bridge hosting the default, and scaffold or convert contract-carrying automations. Use when setting this pattern up on a Zo host, when an automation dies silently at Zo's 120 s per-call ceiling or session cap, or when a scheduled run must outlive its Zo turn.
compatibility: Created for Zo Computer. Requires Python 3.11+, bun, npm, and a Zo access token stored as ZO_MCP_API_KEY.
metadata:
  author: marlandoj.zo.computer
  repository: https://github.com/marlandoj/zo-bridge-kit
---
# Zo Bridge Kit

Zo enforces a **120 s ceiling on every model call** and a session cap on every run. An
automation whose work exceeds either dies with nothing surfaced — no error, no email, and a
dead run that looks exactly like a quiet success.

The fix inverts the stack. Instead of Zo owning the agent loop and borrowing a model, an
**agent CLI owns the loop** and borrows Zo as an MCP tool server. The Zo turn shrinks to
about one second: it launches a detached harness and returns.

```
scheduler tick -> bridge-launch.sh --harness <h>   (Zo turn, ~1 s, returns)
                    -> harness-detached.sh         (setsid nohup)
                         -> claude | codex | gemini | kimi | opencode | hermes | pi
                              <-> zo MCP ......... email, SMS, files, shell, apps
```

Everything is in this repository: the harness installers and configs, the Zo MCP setup,
and the `automation-resilience` runtime (bundled under `vendor/`). Nothing else has to be
on the host first.

## Set up a host

```bash
set -a; . /root/.zo_secrets; set +a                   # every script reads ZO_MCP_API_KEY

python3 scripts/install-harnesses.py --apply          # install missing agent CLIs
python3 scripts/configure-zo-mcp.py --apply --verify  # zo MCP entry in every harness config
python3 scripts/smoke-harnesses.py                    # real Zo tool call through each harness
python3 scripts/preflight.py                          # harnesses, bun, runtime, zo MCP, dirs
python3 scripts/install.py --apply                    # launcher, runner, resilience runtime
python3 scripts/set-bridge-rule.py --apply            # bridge hosting = create_automation default
python3 scripts/register-personas.py --apply          # one Zo persona per installed harness
```

Before any of that, the operator creates a Zo access token and saves it as the secret
`ZO_MCP_API_KEY` — see `docs/ZO-MCP-SETUP.md`. Each harness also needs its own provider
login or API key; `install-harnesses.py` prints the hint per harness, and
`docs/HARNESSES.md` lists the unattended form of each.

Every mutating script is dry-run by default and reads its change back before reporting
success. `install.py` **refuses to replace an existing script whose contents differ**
unless `--force` is passed, because live automations reference the launcher by absolute
path. `configure-zo-mcp.py` likewise leaves a differing `zo` entry alone without `--force`,
and flags one with an inlined token.

`register-personas.py` cannot create the model provider a persona points at — Zo exposes no
tool for that. Connect it in Settings → AI → Providers first, then pass
`--model <harness>=byok:<full-uuid>`. Existing personas are reported, never edited.

## Build a new automation

```bash
python3 scripts/new-bridge-automation.py \
  --title '[SYS] Sweep Stale Leases' \
  --rrule 'FREQ=DAILY;BYHOUR=7;BYMINUTE=40;BYSECOND=0' \
  --job sweep-stale-leases --harness codex --spec my-spec.md --apply
```

The spec is markdown with `## Purpose`, `## Work`, and `## Delivery` sections. The script
creates the automation, writes the contract-carrying prompt from
`assets/prompt-template.md`, rewrites the Zo instruction to the single launcher line, and
asserts the schedule is live. It refuses a `--job` that is not a lowercase slug and any
`COUNT=` rrule: Zo drops `BYHOUR`/`BYMINUTE` when `COUNT` is present, so a one-shot
consumes its only occurrence and leaves `next_run` null on an automation that still reads
active.

To move an existing automation that carries the resilience contract:

```bash
python3 scripts/convert-to-bridge.py --automation-id <full-uuid> --job <slug> --harness gemini --apply
```

## Choosing a harness

`--harness` defaults to `claude`. Pick another when the work suits its model or when you
want the run billed to that provider. The runner handles each harness's unattended quirks —
`IS_SANDBOX=1` for Claude Code as root, OpenCode's per-turn workspace snapshot turned off,
Pi's MCP adapter loaded by `--extension`, Hermes run in `chat -Q -q` so provider errors
surface — and `configure-zo-mcp.py` sets the connect timeouts Codex and OpenCode need
against a cold Zo endpoint. Model per harness comes from `CLAUDE_CODE_MODEL`, `CODEX_MODEL`,
`GEMINI_MODEL`, `KIMI_MODEL`, `OPENCODE_MODEL`, `HERMES_MODEL`, `PI_MODEL`, or
`BRIDGE_MODEL` for any; unset means the harness's own default.

Run `smoke-harnesses.py --harness <h>` before pointing a real automation at a harness for
the first time on a host.

## What goes in the automation, and what does not

The Zo instruction body is one launcher line plus a stay-silent contract:

```
bash <install-dir>/bridge-launch.sh \
  --job <job> --harness <harness> \
  --prompt-file <prompts-dir>/<automation-id8>-<job>.md \
  [--preflight '<cheap test that exits non-zero when there is no work>']
```

Report only the single line it prints — `DETACHED`, `SKIP overlap`, `SKIP nowork`, or
`ERROR` — call no other tools, and send nothing.

Everything else lives in the prompt file. Three rules govern it:

**Run synchronously in the foreground.** Every harness's one-shot mode exits the moment the
model stops emitting, so a backgrounded command or a monitor armed "to notify me" is killed
unfinished and nothing wakes the agent. There is no per-call ceiling inside the bridge, so
block on long commands instead of detaching them.

**Never call `worker-start`.** The bridge *is* the long-lived worker. Do not build parallel
orphan detection either: a bridge that dies mid-run already classifies as
`side_effect_uncertain` or `owner_lost_host_restart`, both of which the recovery controller
sweeps and adjudicates.

**Deliver from inside the bridge**, through the `zo` MCP server's `send_email_to_user` (or
the relevant tool). The automation's `delivery_method` only ever sees the one-second launch
line. The runner loads `/root/.zo_secrets` before starting the harness, because a detached
process inherits none of the Zo turn's environment.

## Verify

1. `next_run` is non-null after any create or edit.
2. No `COUNT=` one-shots. Arm a plain recurring rule and delete it after the observed fire.
3. After the first real fire, a receipt under the run directory whose **`outcome` is
   `ok`**, and delivery confirmed independently — mailbox, file, or queue state.

Judge a run by `outcome`, never by `exit_code` alone. A clean exit with the contract still
`in_progress` is `ended_mid_contract`, a failure that exits 0. Receipts record the
`harness` and `model` that ran.

## When not to bridge

Keep an automation on the plain Zo path only when the whole run is one short model turn: no
dispatch to another agent, no consensus panel, no queue drain, no repo mutation, and total
runtime comfortably under 120 s. When in doubt, bridge it.

## Files

| Path | Purpose |
|---|---|
| `scripts/install-harnesses.py` | Install the agent CLIs listed in the registry |
| `scripts/configure-zo-mcp.py` | Write and verify the `zo` MCP entry in each harness config |
| `scripts/smoke-harnesses.py` | Detached run + real Zo MCP call per harness |
| `scripts/preflight.py` | Verify a host can run bridge-hosted automations |
| `scripts/install.py` | Install launcher, runner, and bundled resilience runtime |
| `scripts/register-personas.py` | Create a Zo persona per installed harness |
| `scripts/set-bridge-rule.py` | Create or update the standing Zo rule, idempotently |
| `scripts/new-bridge-automation.py` | Scaffold a new bridge-hosted automation from a spec |
| `scripts/convert-to-bridge.py` | Move an existing contract-carrying automation onto the bridge |
| `scripts/render-infographic.py` | Render the architecture infographic to PNG |
| `scripts/zolib.py` | Zo MCP over HTTP, Python-repr field parsing, harness registry |
| `scripts/zo-mcp.py` | One-shot Zo MCP tool call from the shell |
| `assets/bridge-launch.sh` | The launcher a Zo automation calls |
| `assets/harness-detached.sh` | The detached runner for all seven harnesses |
| `assets/claude-code-detached.sh` | Compatibility shim for older Claude-only callers |
| `assets/prompt-template.md` | Contract-carrying prompt skeleton |
| `assets/rule-bridge-portable.json` | Generic standing-rule body with path tokens |
| `assets/rule-bridge-standard.json` | Reference-host standing-rule body, verbatim |
| `harnesses/harnesses.json` | Install, headless, model, MCP, and persona facts per harness |
| `harnesses/persona-template.md` | Persona prompt per harness |
| `vendor/automation-resilience/` | Bundled run contract, recovery controller, verifiers, audit, tests |
| `docs/ARCHITECTURE.md` | Why the loop moves, and what each limit actually is |
| `docs/HARNESSES.md` | Per-harness install, invocation, auth, and unattended-run fixes |
| `docs/ZO-MCP-SETUP.md` | Token, secrets, per-harness MCP config, troubleshooting |
