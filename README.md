# zo-bridge-kit

**The harness owns the loop. Zo MCP becomes the tool server.**

![Architecture: the harness owns the loop, Zo MCP is the tool server](assets/infographic/bridge-architecture.png)

![Workflows: automation and chat both launch through bridge-launch.sh, a detached harness owns the loop, and Zo MCP delivers](assets/infographic/bridge-workflows.png)

Zo Computer enforces a **120-second ceiling on every model call** and a session cap on every
run. A scheduled automation whose work exceeds either one dies with nothing surfaced — no
error, no email, and a dead run that reads exactly like a quiet success.

This kit inverts the stack. Instead of Zo owning the agent loop and borrowing a model, an
**agent CLI owns the loop** and borrows Zo as an **MCP tool server**. The Zo turn shrinks to
about a second: it launches a detached harness and returns. No Zo model call happens, so no
Zo model-call limit applies.

Any of seven harnesses can host the loop — Claude Code, Codex CLI, Gemini CLI, Kimi Code
CLI, OpenCode, Hermes Agent, or Pi — chosen per automation with `--harness`.

```
scheduler tick -> bridge-launch.sh --harness <h>    Zo turn: ~1 s, prints one line, returns
                    -> harness-detached.sh          setsid nohup, outlives the turn
                         -> claude | codex | gemini | kimi | opencode | hermes | pi
                              <-> zo MCP            email, SMS, files, shell, apps
```

## Measured, not theoretical

| | |
|---|---|
| **342 s** | A converted daily scan, exit 0. Its previous Zo-hosted occurrence died at *"Email send timed out after 300 seconds."* |
| **118 s** | A converted queue drain — two seconds inside the margin the 120 s ceiling would have cut. |
| **41 / 51** | Active automations bridge-hosted on the reference deployment, zero outstanding candidates. |
| **6 / 7** | Harnesses that completed a real Zo MCP tool call from a detached run on the reference host (15–25 s each). The seventh, Hermes, was blocked only by its providers' billing. |

## Everything you need is in the repo

A fresh Zo host needs nothing but this repository:

| Needed | Where it comes from |
|---|---|
| The seven agent CLIs | `scripts/install-harnesses.py` installs them from `harnesses/harnesses.json` |
| Zo MCP in every harness | `scripts/configure-zo-mcp.py` writes each config; `docs/ZO-MCP-SETUP.md` explains the token |
| The run contract and recovery controller | bundled in `vendor/automation-resilience/`, installed by `scripts/install.py` |
| The launcher and detached runner | `assets/bridge-launch.sh`, `assets/harness-detached.sh` |
| Harnesses as Zo personas | `scripts/register-personas.py` |
| Bridge hosting as the default for new automations | `scripts/set-bridge-rule.py` |

## Setup

```bash
git clone https://github.com/marlandoj/zo-bridge-kit.git /home/workspace/Skills/zo-bridge-kit
cd /home/workspace/Skills/zo-bridge-kit
```

**1. Zo MCP token.** In Zo, create an access token (Settings → Advanced → Access Tokens) and
save it as the secret `ZO_MCP_API_KEY` (Settings → Advanced → Secrets). Then load secrets
into your shell — every script reads them from the environment:

```bash
set -a; . /root/.zo_secrets; set +a
```

Full walkthrough, per-harness config entries, and troubleshooting: [`docs/ZO-MCP-SETUP.md`](docs/ZO-MCP-SETUP.md).

**2. Harnesses.** Install whichever are missing, then log each one in to its provider:

```bash
python3 scripts/install-harnesses.py            # what is installed, plus each login hint
python3 scripts/install-harnesses.py --apply    # install the missing ones
```

**3. Wire Zo MCP into every harness, and prove it.**

```bash
python3 scripts/configure-zo-mcp.py --apply --verify
python3 scripts/smoke-harnesses.py              # each harness makes a real Zo tool call, detached
```

**4. Install the bridge and the resilience runtime.**

```bash
python3 scripts/preflight.py
python3 scripts/install.py --apply
```

**5. Make it the standard, and register the personas.**

```bash
python3 scripts/set-bridge-rule.py --apply
python3 scripts/register-personas.py --apply --model claude=byok:<full-uuid>
```

Every mutating script is **dry-run by default**, prints what it would change, and reads its
change back before reporting success.

## Build an automation on any harness

```bash
python3 scripts/new-bridge-automation.py \
  --title '[SYS] Sweep Stale Leases' \
  --rrule 'FREQ=DAILY;BYHOUR=7;BYMINUTE=40;BYSECOND=0' \
  --job sweep-stale-leases --harness codex --spec my-spec.md --apply
```

Convert an existing contract-carrying automation:

```bash
python3 scripts/convert-to-bridge.py --automation-id <full-uuid> --job <slug> --harness gemini --apply
```

## What is in the box

| Path | Purpose |
|---|---|
| `assets/bridge-launch.sh` | The whole Zo instruction body. Overlap guard, optional no-work preflight, `--harness`, then `exec` the runner. Prints one of `DETACHED`, `SKIP overlap`, `SKIP nowork`, `ERROR`. |
| `assets/harness-detached.sh` | Detaches any of the seven harnesses headless, loads host secrets, applies each harness's unattended-run fixes, then **reconciles the resilience contract after the CLI exits** and writes a receipt. |
| `assets/claude-code-detached.sh` | Compatibility shim for older Claude-only callers. |
| `vendor/automation-resilience/` | The bundled run contract, recovery controller, mailbox verifier, conformance audit, and their tests. |
| `harnesses/harnesses.json` | One entry per harness: install, headless invocation, model variable, MCP config, persona. |
| `harnesses/persona-template.md` | Prompt for the Zo persona created per harness. |
| `scripts/install-harnesses.py` | Install the agent CLIs. |
| `scripts/configure-zo-mcp.py` | Write and verify the `zo` MCP entry in every harness config. |
| `scripts/smoke-harnesses.py` | Prove each harness can run detached and complete a Zo MCP call. |
| `scripts/install.py` | Install launcher, runner, and runtime; refuses to clobber a differing live script. |
| `scripts/preflight.py` | Check a host is ready. |
| `scripts/register-personas.py` | Create a Zo persona per harness. |
| `scripts/set-bridge-rule.py` | Make bridge hosting the default for new automations. |
| `scripts/new-bridge-automation.py` | Scaffold a new bridge-hosted automation. |
| `scripts/convert-to-bridge.py` | Move an existing automation onto the bridge. |
| `docs/ARCHITECTURE.md` | Why the loop moves, what each limit actually is, why `exit_code` is not the verdict. |
| `docs/HARNESSES.md` | Per-harness install, invocation, authentication, and the fixes each needed. |
| `docs/ZO-MCP-SETUP.md` | Token, secrets, per-harness config, troubleshooting. |

## Judge runs by outcome

Every harness's one-shot mode exits the moment the model stops emitting, so a clean exit can
hide unfinished work. The runner reads the resilience run after the CLI exits and writes an
`outcome` to the receipt: `ok`, `cli_failed`, or `ended_mid_contract` (exit 0 with the
contract still open). Confirm delivery from outside the run — mailbox, file, or queue — not
from the bridge's own report.

## Requirements

A Zo Computer host, Python 3.11+, `bun`, `npm` (and `pip` for Hermes), and a Zo access
token. Each harness needs its own provider login or API key.

The repository root is the skill directory: `SKILL.md` sits at the top level and the
directory name matches its `name:` field.
