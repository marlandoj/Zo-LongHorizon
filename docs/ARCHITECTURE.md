# Why the loop moves

## A persona is configuration, not a runtime

It is easy to picture a Zo persona as a thing that runs. It is not. A persona is a config
record: instructions, a model pointer (`byok:<uuid>` or `zo:<name>`), and tool scopes. It
has no execution of its own.

`/zo/ask` is an **inbound** entry point *into* the Zo agent runtime — a caller, not
something the runtime calls to reach a model. Chat, SMS, email, and scheduled automations
are sibling entry points. They all converge on the same loop:

```
entry (chat | automation | /zo/ask)
    -> Zo agent runtime          <- owns the loop, the turn, and the clock
        -> persona config
            -> provider -> harness ACP adapter -> model vendor
```

So a persona does not "use /zo/ask to reach the model". `/zo/ask` sits *above* the runtime
and the provider proxy sits *below* it. Every platform limit you are trying to escape lives
in the middle layer.

## The limits, precisely

| Limit | Where it bites | What it looks like when it bites |
|---|---|---|
| **120 s per model call** | Every single turn inside the runtime, including nested `/zo/ask` dispatches, consensus panels, and MoA lineups | The run stops. Frequently no error email. A delivery-bearing automation simply never delivers. |
| **Session cap** | The whole run | Work is cut off mid-flight, often after the expensive part and before the delivery. |
| **ACP pool reclaim** | The BYOK proxy under a quiet run | The proxy is taken back underneath a run that was merely thinking. |

The common failure mode across all three is that they are **silent**. A dead run and a
quiet success are indistinguishable from the automation's own reporting, which is why the
verification steps in this kit all insist on evidence from outside the run.

A nested call inherits the ceiling. Moving an automation's own model to a faster one does
not help if a lineup it dispatches to still pins a slow reasoner — that call times out
inside the bridge-free path just the same.

## Inverting the stack

```
scheduler tick
    -> bridge-launch.sh              Zo turn: ~1 s, prints one line, returns
        -> harness-detached.sh       setsid nohup, survives the turn
            -> claude -p | codex exec | gemini -p | kimi --prompt
               | opencode run | hermes chat -q | pi --print
                                     <- owns the agent loop
                <-> zo MCP           <- tools: email, SMS, files, shell, apps
                    -> the harness's own model provider
```

The Zo turn never approaches any Zo limit because it does no model work. It runs a shell
command and returns a status line. The agent loop happens in a process the platform is not
metering, and Zo re-enters the picture as a **tool server** the CLI calls over MCP.

Any harness works, because the only things the bridge asks of one are a one-shot headless
mode, a way to skip interactive approvals, and an MCP client that can reach
`https://api.zo.computer/mcp`. All seven listed in `docs/HARNESSES.md` meet that bar, and
`scripts/smoke-harnesses.py` proves it per host with a real Zo tool call.

What you gain: no per-call ceiling (the bridge bounds itself at `BRIDGE_TIMEOUT`, default
3600 s), no session cap, no ACP in the path, the full harness loop — whatever subagents,
skills, hooks, and context management that harness has — and the harness's own provider
metering (often a subscription) rather than platform credits.

What you must give back: the platform can no longer tell you the run failed, because from
its side the run succeeded in one second. That is what the resilience contract inside the
bridge is for.

## What the contract does and does not carry across

**Becomes dead weight.** The Zo-side turn budget — checkpoint at minute 48, hand off at 53
— exists for a long Zo turn. Under the bridge the Zo turn is one second. The bridge has its
own bound instead.

**Survives unchanged, and matters more.** `side-effect-intent` / `side-effect-resolve` is
runtime-agnostic: an email, trade, payment, deployment, or deletion still needs "never
repeat an unresolved side effect". It matters *more* under the bridge, because the work
happens outside any Zo conversation and there is no transcript to eyeball.

**Changes shape.** `worker-start` is forbidden — the bridge is the long-lived worker. It is
tempting to add parallel orphan detection to compensate for the missing platform failure
email, and that is the wrong move: a bridge that dies mid-run already lands in the states
the recovery controller sweeps. With an open intent it classifies `side_effect_uncertain`
and the email verifier adjudicates it from the recipient mailbox; after a host recycle it
classifies `owner_lost_host_restart`.

## Why the exit code is not the verdict

Every harness's one-shot mode — `claude -p`, `codex exec`, `gemini -p`, and the rest —
ends the moment the model stops emitting output. An agent that backgrounds a
command, or ends its turn expecting a notification, exits **0** with the work unfinished
and the contract still open. Nothing wakes it.

So the runner reconciles after the CLI exits: `bridge-launch.sh` extracts the automation ID
from the prompt, and the runner reads the resilience run's status into the receipt as
`contract_status`, then writes an `outcome`:

| `outcome` | Meaning |
|---|---|
| `ok` | CLI exited 0 and the contract is not still open |
| `cli_failed` | Non-zero exit, timeout, or crash |
| `ended_mid_contract` | **Exit 0 with the contract still `in_progress`** — a failure that looks like success |

Judge a run by `outcome`. `exit_code` alone will lie to you.

## Operational traps this kit refuses by construction

**`COUNT=1` one-shots.** Zo normalizes any rrule into a `DTSTART` at the edit moment plus a
`RRULE`, and drops `BYHOUR`/`BYMINUTE` when `COUNT` is present. The single allowed
occurrence is consumed before the scheduler evaluates it: `next_run` goes null while the
automation still reads active, and it never fires. Arm a plain recurring rule and delete it
after the observed fire.

**Null `next_run`.** After the intended fire time, `next_run: null` looks identical whether
the run fired or the schedule was never live. Assert it is non-null immediately after any
create or edit, while the distinction is still observable.

**Parsing Zo records with a single-quote regex.** Zo's MCP tools return Python `repr()`
strings. A value containing an apostrophe flips the repr to double quotes, so a
single-quote-only pattern returns `None` and a successful edit reads as a failed one.
`zolib.field()` scans quotes explicitly for this reason.

**Truncated automation IDs.** `automation-resilience.ts status` needs the full UUID. An
8-character prefix returns `{"exists": false}` — indistinguishable from a run that never
happened, and enough to make a healthy bridge look broken.

**Missing environment.** A detached process inherits nothing from the Zo turn: not the
secrets, not `ZO_MODEL`. The runner sources `/root/.zo_secrets` before starting the harness
(so provider keys and `ZO_MCP_API_KEY` are present), exports `IS_SANDBOX=1` (Claude Code
refuses `--dangerously-skip-permissions` as root without it, and a Zo host runs as root),
and exports `ZO_MODEL` as `<harness>:<model>`. The prompt template sources the secrets file
again as its first step, which is harmless and keeps hand-run prompts correct.

**Harness-specific stalls.** Each CLI has one default that breaks unattended runs, and the
runner or `configure-zo-mcp.py` sets the fix: Codex needs a 90 s MCP startup timeout or a
cold Zo endpoint silently drops the server; OpenCode git-snapshots the whole working
directory every turn and must run with `{"snapshot": false}`; Kimi rejects `--auto`
alongside `--prompt`; Hermes' `-z` mode hides provider errors, so the runner uses
`chat -Q -q`; Pi ships without MCP and needs `pi-mcp-adapter` loaded with `--extension`.
Details are in `docs/HARNESSES.md`.
