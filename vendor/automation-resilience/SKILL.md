---
name: automation-resilience
description: Make Zo automations recoverable across interrupted sessions with durable checkpoints, detached shell workers, and fail-closed handling for uncertain external side effects. Use when creating, hardening, resuming, or diagnosing long-running scheduled automations.
metadata:
  author: marlandoj.zo.computer
---

# Automation Resilience

Use the runtime at `scripts/automation-resilience.ts` to give one logical automation occurrence durable state under `/home/workspace/.zo/automation-runs`.

At the start of a run, inspect `status`. Start a new occurrence with `begin` when none is unfinished. For an incomplete occurrence, inspect its revision, pending side effect, and worker state; use `begin --recover --expected-revision <revision>` only when recovery is safe. Keep the returned `session_token` private to the current execution and pass it to every mutation.

Record each verified milestone with `checkpoint`. Before an email, message, trade, payment, deployment, deletion, publication, or other external mutation, record `side-effect-intent` with a stable key and request digest. Verify the external result, then call `side-effect-resolve` with evidence. Never repeat an unresolved side effect.

Use `worker-start` only for resumable shell work that can continue outside the automation response stream. Poll with `worker-status`; its logs and exit record live inside the run directory. Ordinary Zo tool calls stay in the automation session.

Every run carries a turn budget anchored to the host boot identity and monotonic uptime, so elapsed time survives process restarts and a host restart is detected rather than mismeasured. Defaults are a checkpoint at minute 48 and a handoff at minute 53; override with `--checkpoint-seconds` and `--handoff-seconds` on `begin`. Poll `budget` for the phase: `ok`, `checkpoint_due`, `checkpointed`, `handoff_due`, `handed_off`, or `host_restarted`.

At `checkpoint_due`, call `budget-checkpoint` with the current phase, the acceptance criteria already met, the next action, and absolute artifact paths. It records unresolved side-effect state rather than refusing, so an interruption never loses that evidence. At `handoff_due`, call `budget-handoff` with a stable key; repeating the same key is idempotent, a second distinct key is refused, and the run blocks so no new nonessential work starts. Resuming through `begin --recover` re-anchors the budget to the current boot, carries the checkpoint forward, and still fails closed on an unverified side effect.

Finish with `finish`. Use `block` when evidence is ambiguous and `fail` for a verified failure. If the runtime rejects ownership, revision, worker, or side-effect state, stop rather than bypassing it.

## Recovery after lost ownership

A run whose session ended with an unresolved side effect or an ambiguous worker cannot be resumed with `begin --recover`, and its original token is gone. Reconcile it instead of editing state:

1. `reconcile-begin --automation-id ID --expected-revision N --owner NAME` rotates ownership to a restricted reconcile token. It succeeds only when the run is blocked, the host restarted since the run began, or the run exceeded its handoff budget; otherwise pass `--assume-stale REASON` with evidence that the owner is gone. The token permits only `status`, `side-effect-adjudicate`, `worker-adjudicate`, `reconcile-close`, and `reconcile-release`; it can never checkpoint, open a side effect, or start a worker.
2. Gather evidence with `scripts/recovery_verifiers.py email --subject S --after ISO [--run-id ID]` (recipient mailbox including spam and trash, ignoring platform "Automation failed" notices) or `... worker --automation-id ID [--artifact PATH]` (durable exit record, command digest, artifacts).
3. `side-effect-adjudicate ... --outcome applied|not_applied|ambiguous|invalidated --evidence TEXT`. `applied` resolves the intent; `not_applied` clears it so a resumed session may retry under the same key; `invalidated` clears it and permanently refuses that key; `ambiguous` keeps the intent, blocks the run, and escalates. `worker-adjudicate` supplies the missing receipt with the same outcome discipline.
4. `reconcile-close --outcome completed|failed|blocked --reason TEXT` when the run's outcome is fully verified, or `reconcile-release` so the automation's next occurrence resumes remaining work through `begin --recover`.

Record `--verify '{"kind":"email","subject":"..."}'` on email intents so the controller can verify them automatically. Every adjudication is retained under `adjudications[]`, and `status` exposes a `recovery` block with classification, age, attempts, last evidence, and next action.

`scripts/recovery-controller.ts` runs the restart-triggered controller: `scan`, `sweep [--apply]`, `report`, and `serve --interval 900`. In `serve` mode it sweeps once after each host restart (after the 12-minute warmup) and every 15 minutes otherwise, adjudicates only from verifier evidence, escalates once per distinct evidence to `/home/.z/automation-recovery/escalations.jsonl`, and writes the operator queue to `Projects/zo-computer-stream-resilience/reports/automation-recovery-queue.md`. Runs whose owner may still be live are never displaced.

Run `bun scripts/automation-resilience.ts help`, `bun scripts/recovery-controller.ts help`, and `python3 scripts/recovery_verifiers.py --help` for command syntax.

## Bridge-hosted automations — the default build

Zo enforces a 120 s ceiling on every model call and a ~60 min session cap. Any automation whose work is long-running, dispatch-heavy, or delivery-bearing is built CLI-bridge-hosted: the Zo turn only launches, and the work runs in a detached `claude -p` that owns this contract itself. Evidence from 2026-09-22: a converted daily scan ran 342 s where its prior Zo-hosted occurrence died at "Email send timed out after 300 seconds", and a converted queue drain ran 118 s, inside the margin the ceiling would have killed.

The automation's instruction body is one launcher line plus a stay-silent contract:

```
bash /home/workspace/Skills/automation-resilience/scripts/bridge-launch.sh \
  --job <job> \
  --prompt-file /home/workspace/Skills/automation-resilience/prompts/<automation-id>-<job>.md \
  [--preflight '<cheap test that exits non-zero when there is no work>']
```

Report only the single line it prints — `DETACHED`, `SKIP overlap`, `SKIP nowork`, or `ERROR` — call no other tools, and send nothing.

The prompt must tell the agent to run everything synchronously in the foreground. `claude -p` ends the moment the model stops emitting output, so a backgrounded command, a `run_in_background` task, or a monitor armed "to notify me" is killed unfinished and nothing wakes the agent back up. Observed 2026-09-23: the conformance audit's first bridge run spawned a second audit in the background, ended its turn waiting for a notification, and exited 0 after 348 s with the resilience run still `in_progress` and no output written. There is no per-call ceiling inside the bridge — that is the whole point — so long commands should block, not detach.

Because of that, a receipt's `exit_code` alone cannot be trusted. `bridge-launch.sh` extracts the automation id from the prompt and the runner reconciles the resilience run after the CLI exits, writing `contract_status` and an `outcome` of `ok`, `cli_failed`, or `ended_mid_contract`. Judge a run by `outcome`, not by `exit_code`.

The work and the full contract live in the prompt file under `prompts/`. Inside the bridge the lifecycle is `begin` -> `checkpoint` -> `side-effect-intent` -> `side-effect-resolve` -> `finish`, exactly as above, with one change: the prompt must forbid `worker-start`, because the bridge is the long-lived worker. Do not add parallel orphan detection. A bridge that dies mid-run already classifies as `side_effect_uncertain` or `owner_lost_host_restart`, and `recovery-controller sweep` adjudicates both.

Delivery happens from inside the bridge through the Zo MCP tools. The automation's `delivery_method` only reports what the one-second Zo turn produced, so it can never carry the output.

Convert an existing automation with `scripts/convert-to-bridge.py --automation-id <uuid> --job <job>` (dry-run by default; `--apply` commits). It splits the instruction at the contract boundary, writes the prompt file, backs up the original instruction under `prompts/_pre-bridge-<id8>.instruction.txt`, and re-asserts `next_run`.

Two contract shapes exist in the fleet and both split cleanly. Newer instructions carry the HTML-comment markers; ones written before them carry the same contract in plain text ending in the sentence "The original automation instruction begins immediately after this contract." The converter aborts before touching the automation if neither boundary is present, or if the body after the boundary is under 200 characters — that means the contract sits at the end rather than the top, and converting would leave a rewritten Zo instruction pointing at an empty prompt.

Convert every outstanding candidate with `scripts/batch-convert.py --from-audit --apply`, which runs the audit, slugs each candidate title into a job name, and records one result row per automation. Pass `--plan <file.json>` instead to retry a subset or override a slug. Keep parallelism low; each conversion is three MCP round trips.

Do not add a `--preflight` while converting unless the automation already had a skip condition. A preflight changes when the automation does nothing, which is a behavior change rather than a hosting change, and it should be decided separately.

Verification order after any create, edit, or conversion:

1. `next_run` is non-null. A null `next_run` on an `active` automation is a silently dead schedule.
2. No `COUNT=1` one-shots. Zo normalizes the rrule to a `DTSTART` at the edit moment and drops `BYHOUR`/`BYMINUTE`, consuming the only occurrence. Arm a plain recurring rule and delete it after the observed fire.
3. After the first real fire, a receipt under `/home/workspace/.zo/cli-bridge-runs/` with exit 0, and delivery confirmed independently — mailbox, file, or queue state — not from the bridge's own self-report. `automation-resilience.ts status` needs the full automation UUID; an 8-char prefix returns `{"exists":false}`, which is indistinguishable from a run that never happened.

Keep an automation on the plain Zo path only when the whole run is one short model turn with no `/zo/ask` dispatch, no consensus panel, no queue drain, and no repo mutation. `scripts/audit-bridge-conformance.py` reports which active automations still need conversion.

Drift is watched on a schedule by `[SYS] Audit Bridge Conformance` (`4de40924-7880-4688-b01a-ad6ff110855e`), weekly Monday 07:40 Arizona and itself bridge-hosted. It runs the audit, diffs it against `/home/workspace/.zo/automation-bridge-baseline.json`, and emails only on drift: a conversion candidate that is not in the baseline, any dead schedule, or an automation that was bridge-hosted and is now Zo-hosted. It reports and never converts — conversion rewrites an instruction body and stays an operator decision.

Bridge prerequisites on this host: `IS_SANDBOX=1` must be exported before spawning `claude -p`, since everything runs as root and Claude Code otherwise refuses `--dangerously-skip-permissions`; and the `zo` MCP server must be reachable so the bridge can call Zo tools. Every harness on this host now carries that server — see `Skills/zo-swarm-orchestrator/SKILL.md` for the per-harness config paths.
