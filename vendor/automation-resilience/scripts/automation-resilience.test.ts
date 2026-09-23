import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "automation-resilience.ts");
const root = mkdtempSync(join(tmpdir(), "automation-resilience-test-"));
const env = { ...process.env, AUTOMATION_RESILIENCE_ROOT: root };

type Result = { status: number; out?: Record<string, any>; err?: Record<string, any> };

function run(args: string[], expected = 0, extraEnv: Record<string, string> = {}): Result {
  const result = spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  if (result.status !== expected) {
    throw new Error(`Expected ${expected}, got ${result.status}: ${result.stderr || result.stdout}`);
  }
  return {
    status: result.status ?? 1,
    out: result.stdout.trim() ? JSON.parse(result.stdout) : undefined,
    err: result.stderr.trim() ? JSON.parse(result.stderr) : undefined,
  };
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

try {
  const id = "fresh-run";
  check(run(["status", "--automation-id", id]).out?.exists === false, "fresh status should be absent");
  const first = run(["begin", "--automation-id", id]).out!;
  check(first.outcome === "started", "first run should start");
  const token = String(first.session_token);
  run(["checkpoint", "--automation-id", id, "--session-token", token, "--step", "phase-1"]);
  const current = run(["status", "--automation-id", id]).out!;
  check(current.last_completed_step === "phase-1", "checkpoint should persist");
  check(run(["begin", "--automation-id", id], 3).err?.error === "RECOVERY_REQUIRED", "overlap should fail closed");
  const resumed = run([
    "begin", "--automation-id", id, "--recover", "--expected-revision", String(current.revision),
  ]).out!;
  check(resumed.outcome === "resumed" && resumed.run_id === first.run_id, "recovery should reuse the run");
  check(run([
    "checkpoint", "--automation-id", id, "--session-token", token, "--step", "stale-owner",
  ], 3).err?.error === "OWNERSHIP_MISMATCH", "stale owner should be rejected");
  const resumedToken = String(resumed.session_token);
  run(["finish", "--automation-id", id, "--session-token", resumedToken]);
  const second = run(["begin", "--automation-id", id]).out!;
  check(second.run_id !== first.run_id, "completed run should permit a fresh occurrence");

  const sideId = "side-effect";
  const side = run(["begin", "--automation-id", sideId]).out!;
  run([
    "side-effect-intent", "--automation-id", sideId, "--session-token", String(side.session_token),
    "--key", "email-1", "--action", "send email", "--request-digest", "abc123",
  ]);
  const sideStatus = run(["status", "--automation-id", sideId]).out!;
  check(run([
    "begin", "--automation-id", sideId, "--recover", "--expected-revision", String(sideStatus.revision),
  ], 3).err?.error === "SIDE_EFFECT_UNCERTAIN", "uncertain side effect should block recovery");

  const workerId = "detached-worker";
  const worker = run(["begin", "--automation-id", workerId]).out!;
  const artifact = join(root, "worker-artifact.txt");
  run([
    "worker-start", "--automation-id", workerId, "--session-token", String(worker.session_token),
    "--", "/bin/sh", "-c", `printf done > ${artifact}`,
  ]);
  let observed: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    observed = run(["worker-status", "--automation-id", workerId]).out;
    if (observed?.worker?.status !== "running") break;
  }
  check(observed?.worker?.status === "completed", "detached worker should record completion");
  check(readFileSync(artifact, "utf8") === "done", "detached worker should produce its artifact");

  const staleId = "stale-worker";
  const stale = run(["begin", "--automation-id", staleId]).out!;
  const staleStatePath = join(root, staleId, "runs", String(stale.run_id), "state.json");
  const staleState = JSON.parse(readFileSync(staleStatePath, "utf8"));
  staleState.worker = {
    pid: 2147483647,
    status: "running",
    command: ["false"],
    command_digest: "dead",
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    stdout_log: join(root, "missing.out"),
    stderr_log: join(root, "missing.err"),
    result_file: join(root, "missing-result.json"),
  };
  staleState.status = "waiting_worker";
  staleState.revision += 1;
  writeFileSync(staleStatePath, `${JSON.stringify(staleState, null, 2)}\n`);
  const staleStatus = run(["status", "--automation-id", staleId]).out!;
  check(staleStatus.worker?.status === "ambiguous", "dead worker without result should be ambiguous");
  check(run([
    "begin", "--automation-id", staleId, "--recover", "--expected-revision", String(staleStatus.revision),
  ], 3).err?.error === "WORKER_AMBIGUOUS", "ambiguous worker should fail closed");

  const statePathFor = (automationId: string, runId: string) =>
    join(root, automationId, "runs", runId, "state.json");

  const mutateState = (automationId: string, runId: string, mutate: (s: any) => void) => {
    const path = statePathFor(automationId, runId);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    mutate(parsed);
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  };

  // --- ZOU-1624: turn budget ---

  const budgetId = "turn-budget";
  const armed = run(["begin", "--automation-id", budgetId]).out!;
  check(armed.budget?.phase === "ok", "a fresh run arms the budget in the ok phase");
  check(armed.budget?.checkpoint_seconds === 2880, "checkpoint defaults to minute 48");
  check(armed.budget?.handoff_seconds === 3180, "handoff defaults to minute 53");
  check(typeof armed.budget?.started_uptime === "number", "budget anchors to monotonic host uptime");
  const budgetToken = String(armed.session_token);
  const budgetRun = String(armed.run_id);

  check(
    run(["begin", "--automation-id", "bad-budget", "--checkpoint-seconds", "60", "--handoff-seconds", "60"], 2)
      .err?.error === "INVALID_BUDGET",
    "handoff must exceed checkpoint",
  );
  check(
    run(["begin", "--automation-id", "bad-budget", "--checkpoint-seconds", "-1"], 2).err?.error === "INVALID_BUDGET",
    "negative budgets are rejected",
  );

  // Normal completion well inside the budget leaves no checkpoint or handoff behind.
  const insideId = "inside-budget";
  const inside = run(["begin", "--automation-id", insideId]).out!;
  run(["finish", "--automation-id", insideId, "--session-token", String(inside.session_token)]);
  const insideFinal = run(["status", "--automation-id", insideId]).out!;
  check(insideFinal.status === "completed", "a short run completes normally");
  check(insideFinal.budget?.checkpoint === null, "a short run records no budget checkpoint");
  check(insideFinal.budget?.handoff === null, "a short run records no handoff");

  // Rewind the monotonic anchor to simulate arriving at minute 49.
  mutateState(budgetId, budgetRun, (state) => {
    state.budget.started_uptime -= 49 * 60;
  });
  check(run(["budget", "--automation-id", budgetId]).out?.budget?.phase === "checkpoint_due",
    "minute 49 reports checkpoint_due");

  check(
    run([
      "budget-handoff", "--automation-id", budgetId, "--session-token", budgetToken,
      "--key", "h1", "--next-action", "resume phase two",
    ], 3).err?.error === "HANDOFF_WITHOUT_CHECKPOINT",
    "handoff requires a durable checkpoint first",
  );

  run([
    "side-effect-intent", "--automation-id", budgetId, "--session-token", budgetToken,
    "--key", "deploy-1", "--action", "deploy", "--request-digest", "d1",
  ]);

  const artifactA = join(root, "budget-artifact.txt");
  writeFileSync(artifactA, "evidence");
  const checkpointed = run([
    "budget-checkpoint", "--automation-id", budgetId, "--session-token", budgetToken,
    "--phase", "phase-two", "--completed-criteria", "AC1,AC2",
    "--next-action", "verify deploy then continue", "--artifacts", artifactA,
  ]).out!;
  check(checkpointed.checkpoint?.phase === "phase-two", "checkpoint persists the phase");
  check(checkpointed.checkpoint?.completed_criteria === "AC1,AC2", "checkpoint persists completed criteria");
  check(checkpointed.checkpoint?.next_action === "verify deploy then continue", "checkpoint persists next action");
  check(checkpointed.checkpoint?.artifacts?.[0] === artifactA, "checkpoint persists artifact paths");
  check(checkpointed.checkpoint?.side_effect_state?.key === "deploy-1",
    "checkpoint persists unresolved side-effect state instead of refusing");
  check(run(["budget", "--automation-id", budgetId]).out?.budget?.phase === "checkpointed",
    "a recorded checkpoint clears checkpoint_due");

  check(
    run([
      "budget-checkpoint", "--automation-id", budgetId, "--session-token", budgetToken,
      "--phase", "relative", "--completed-criteria", "x", "--next-action", "y", "--artifacts", "relative/path",
    ], 2).err?.error === "INVALID_ARTIFACT",
    "artifact paths must be absolute",
  );

  check(
    run([
      "budget-checkpoint", "--automation-id", budgetId, "--session-token", "not-the-owner",
      "--phase", "p", "--completed-criteria", "c", "--next-action", "n",
    ], 3).err?.error === "OWNERSHIP_MISMATCH",
    "a stale owner cannot write a budget checkpoint",
  );

  // Arrive at minute 54 and hand off exactly once.
  mutateState(budgetId, budgetRun, (state) => {
    state.budget.started_uptime -= 5 * 60;
  });
  check(run(["budget", "--automation-id", budgetId]).out?.budget?.phase === "handoff_due",
    "minute 54 reports handoff_due");

  const handoff = run([
    "budget-handoff", "--automation-id", budgetId, "--session-token", budgetToken,
    "--key", "h1", "--next-action", "verify deploy-1 then resume phase-two",
  ]).out!;
  check(handoff.outcome === "handed_off", "the first handoff is performed");
  check(handoff.unresolved_side_effect === "deploy-1", "handoff surfaces the unresolved side effect");
  const afterHandoff = run(["status", "--automation-id", budgetId]).out!;
  check(afterHandoff.status === "blocked", "handoff stops further work by blocking the run");

  const repeat = run([
    "budget-handoff", "--automation-id", budgetId, "--session-token", budgetToken,
    "--key", "h1", "--next-action", "verify deploy-1 then resume phase-two",
  ]).out!;
  check(repeat.outcome === "already_handed_off", "repeating the same handoff key is idempotent");
  check(repeat.revision === afterHandoff.revision, "an idempotent handoff does not advance the revision");

  check(
    run([
      "budget-handoff", "--automation-id", budgetId, "--session-token", budgetToken,
      "--key", "h2", "--next-action", "something else",
    ], 3).err?.error === "HANDOFF_CONFLICT",
    "a second distinct handoff is refused",
  );

  // The handed-off run still fails closed on the unverified side effect.
  check(
    run(["begin", "--automation-id", budgetId, "--recover", "--expected-revision", String(afterHandoff.revision)], 3)
      .err?.error === "SIDE_EFFECT_UNCERTAIN",
    "recovery after handoff fails closed while the side effect is unverified",
  );
  run([
    "side-effect-resolve", "--automation-id", budgetId, "--session-token", budgetToken,
    "--key", "deploy-1", "--evidence", "deployment 1 confirmed absent",
  ]);
  const resolvedStatus = run(["status", "--automation-id", budgetId]).out!;
  const rearmed = run([
    "begin", "--automation-id", budgetId, "--recover", "--expected-revision", String(resolvedStatus.revision),
  ]).out!;
  check(rearmed.outcome === "resumed", "recovery succeeds once the side effect is verified");
  check(rearmed.budget?.phase === "ok", "recovery re-arms the budget at ownership acquisition");
  check(rearmed.resumed_from_checkpoint?.phase === "phase-two", "recovery carries the durable checkpoint forward");
  check(rearmed.budget?.handoff === null, "a re-armed budget clears the consumed handoff");

  // --- host restart invalidates the monotonic anchor ---

  const restartId = "host-restart";
  const restart = run(["begin", "--automation-id", restartId]).out!;
  mutateState(restartId, String(restart.run_id), (state) => {
    state.budget.boot_id = "00000000-0000-0000-0000-000000000000";
  });
  check(run(["budget", "--automation-id", restartId]).out?.budget?.phase === "host_restarted",
    "a different boot id reports host_restarted");
  check(run(["budget", "--automation-id", restartId]).out?.budget?.elapsed_seconds === null,
    "elapsed time is unknowable across a host restart");
  check(
    run([
      "budget-checkpoint", "--automation-id", restartId, "--session-token", String(restart.session_token),
      "--phase", "p", "--completed-criteria", "c", "--next-action", "n",
    ], 3).err?.error === "BUDGET_BOOT_MISMATCH",
    "checkpointing against a stale boot id fails closed",
  );
  const restartStatus = run(["status", "--automation-id", restartId]).out!;
  const restartResumed = run([
    "begin", "--automation-id", restartId, "--recover", "--expected-revision", String(restartStatus.revision),
  ]).out!;
  check(restartResumed.budget?.phase === "ok", "re-acquiring ownership re-anchors the budget to the current boot");

  // --- schema v1 states migrate forward ---

  const legacyId = "legacy-schema";
  const legacy = run(["begin", "--automation-id", legacyId]).out!;
  mutateState(legacyId, String(legacy.run_id), (state) => {
    state.schema_version = 1;
    delete state.budget;
  });
  const migrated = run(["status", "--automation-id", legacyId]).out!;
  check(migrated.schema_version === 2, "a v1 state migrates to v2 on read");
  check(migrated.budget === null, "a migrated v1 state carries no budget");
  check(
    run([
      "budget-checkpoint", "--automation-id", legacyId, "--session-token", String(legacy.session_token),
      "--phase", "p", "--completed-criteria", "c", "--next-action", "n",
    ], 3).err?.error === "NO_BUDGET",
    "a migrated state without a budget refuses budget operations",
  );

  const reconcileId = "reconcile-email";
  const reconcileRun = run(["begin", "--automation-id", reconcileId]).out!;
  const reconcileSession = String(reconcileRun.session_token);
  run(["checkpoint", "--automation-id", reconcileId, "--session-token", reconcileSession, "--step", "digest-generated"]);
  run([
    "side-effect-intent", "--automation-id", reconcileId, "--session-token", reconcileSession,
    "--key", "digest-email", "--action", "send digest", "--request-digest", "deadbeef",
    "--verify", JSON.stringify({ kind: "email", subject: "Digest" }),
  ]);
  let reconcileState = run(["status", "--automation-id", reconcileId]).out!;
  check(reconcileState.pending_side_effect.verification.subject === "Digest", "verification metadata persists on the intent");
  check(reconcileState.recovery.classification === "side_effect_uncertain", "an unresolved intent classifies as side_effect_uncertain");
  check(run([
    "reconcile-begin", "--automation-id", reconcileId, "--expected-revision", String(reconcileState.revision), "--owner", "drill",
  ], 3).err?.error === "OWNER_MAY_BE_LIVE", "a live in-budget owner cannot be displaced without evidence");
  const reconciled = run([
    "reconcile-begin", "--automation-id", reconcileId, "--expected-revision", String(reconcileState.revision),
    "--owner", "drill", "--assume-stale", "session stream ended",
  ]).out!;
  check(reconciled.outcome === "reconciliation_acquired" && reconciled.attempts === 1, "reconciliation rotates ownership");
  const reconcileToken = String(reconciled.reconcile_token);
  check(run([
    "checkpoint", "--automation-id", reconcileId, "--session-token", reconcileSession, "--step", "late",
  ], 3).err?.error === "OWNERSHIP_MISMATCH", "the original session loses ownership");
  check(run([
    "checkpoint", "--automation-id", reconcileId, "--session-token", reconcileToken, "--step", "late",
  ], 3).err?.error === "OWNERSHIP_MISMATCH", "a reconcile token cannot checkpoint new work");
  check(run([
    "side-effect-intent", "--automation-id", reconcileId, "--session-token", reconcileToken,
    "--key", "digest-email-2", "--action", "resend", "--request-digest", "cafe",
  ], 3).err?.error === "OWNERSHIP_MISMATCH", "a reconcile token cannot open a new side effect");
  check(run([
    "reconcile-begin", "--automation-id", reconcileId, "--expected-revision", String(reconciled.revision), "--owner", "second",
  ], 3).err?.error === "RECONCILIATION_ACTIVE", "a second reconciler is refused while one is active");
  check(run([
    "reconcile-close", "--automation-id", reconcileId, "--reconcile-token", reconcileToken, "--outcome", "completed", "--reason", "x",
  ], 3).err?.error === "SIDE_EFFECT_UNCERTAIN", "closing as completed with an unresolved intent fails closed");
  const ambiguous = run([
    "side-effect-adjudicate", "--automation-id", reconcileId, "--reconcile-token", reconcileToken,
    "--key", "digest-email", "--outcome", "ambiguous", "--evidence", "mailbox search failed",
  ]).out!;
  check(ambiguous.status === "blocked" && ambiguous.recovery.classification === "side_effect_ambiguous_escalated", "ambiguous adjudication blocks and escalates");
  const applied = run([
    "side-effect-adjudicate", "--automation-id", reconcileId, "--reconcile-token", reconcileToken,
    "--key", "digest-email", "--outcome", "applied", "--evidence", "message id abc delivered", "--verifier", "email",
  ]).out!;
  check(applied.recovery.classification === "blocked", "applied adjudication clears the intent but not the block until closed");
  reconcileState = run(["status", "--automation-id", reconcileId]).out!;
  check(reconcileState.pending_side_effect === null, "applied adjudication clears the pending intent");
  check(reconcileState.adjudications.length === 2 && reconcileState.adjudications[1].verifier === "email", "adjudications are retained as evidence");
  check(reconcileState.reconciliation.token === undefined && reconcileState.reconciliation.active === true, "status never exposes the reconcile token");
  const closed = run([
    "reconcile-close", "--automation-id", reconcileId, "--reconcile-token", reconcileToken, "--outcome", "completed", "--reason", "digest delivered once",
  ]).out!;
  check(closed.outcome === "completed", "a fully adjudicated run can be closed as completed");
  check(run(["begin", "--automation-id", reconcileId]).out?.outcome === "started", "the next occurrence starts cleanly after reconciliation");

  const invalidId = "reconcile-invalidated";
  const invalidRun = run(["begin", "--automation-id", invalidId]).out!;
  const invalidSession = String(invalidRun.session_token);
  run([
    "side-effect-intent", "--automation-id", invalidId, "--session-token", invalidSession,
    "--key", "stale-report", "--action", "send stale report", "--request-digest", "0001",
  ]);
  let invalidState = run(["status", "--automation-id", invalidId]).out!;
  const invalidReconciler = run([
    "reconcile-begin", "--automation-id", invalidId, "--expected-revision", String(invalidState.revision),
    "--owner", "drill", "--assume-stale", "drill",
  ]).out!;
  run([
    "side-effect-adjudicate", "--automation-id", invalidId, "--reconcile-token", String(invalidReconciler.reconcile_token),
    "--key", "stale-report", "--outcome", "invalidated", "--evidence", "superseded by later run",
  ]);
  run(["reconcile-release", "--automation-id", invalidId, "--reconcile-token", String(invalidReconciler.reconcile_token)]);
  invalidState = run(["status", "--automation-id", invalidId]).out!;
  check(invalidState.reconciliation.active === false, "release clears reconciliation ownership");
  const invalidResumed = run([
    "begin", "--automation-id", invalidId, "--recover", "--expected-revision", String(invalidState.revision),
  ]).out!;
  check(invalidResumed.outcome === "resumed", "a released run resumes through normal recovery");
  check(run([
    "side-effect-intent", "--automation-id", invalidId, "--session-token", String(invalidResumed.session_token),
    "--key", "stale-report", "--action", "send stale report", "--request-digest", "0001",
  ], 3).err?.error === "SIDE_EFFECT_INVALIDATED", "an invalidated key can never be replayed");
  run([
    "side-effect-intent", "--automation-id", invalidId, "--session-token", String(invalidResumed.session_token),
    "--key", "fresh-report", "--action", "send fresh report", "--request-digest", "0002",
  ]);
  run([
    "side-effect-resolve", "--automation-id", invalidId, "--session-token", String(invalidResumed.session_token),
    "--key", "fresh-report", "--evidence", "delivered",
  ]);
  run(["finish", "--automation-id", invalidId, "--session-token", String(invalidResumed.session_token)]);

  const notAppliedId = "reconcile-not-applied";
  const notAppliedRun = run(["begin", "--automation-id", notAppliedId]).out!;
  run([
    "side-effect-intent", "--automation-id", notAppliedId, "--session-token", String(notAppliedRun.session_token),
    "--key", "alert", "--action", "send alert", "--request-digest", "0003",
  ]);
  let notAppliedState = run(["status", "--automation-id", notAppliedId]).out!;
  const notAppliedReconciler = run([
    "reconcile-begin", "--automation-id", notAppliedId, "--expected-revision", String(notAppliedState.revision),
    "--owner", "drill", "--assume-stale", "drill",
  ]).out!;
  run([
    "side-effect-adjudicate", "--automation-id", notAppliedId, "--reconcile-token", String(notAppliedReconciler.reconcile_token),
    "--key", "alert", "--outcome", "not_applied", "--evidence", "provider returned 500 and mailbox has no message after 48h",
  ]);
  run(["reconcile-release", "--automation-id", notAppliedId, "--reconcile-token", String(notAppliedReconciler.reconcile_token)]);
  notAppliedState = run(["status", "--automation-id", notAppliedId]).out!;
  const notAppliedResumed = run([
    "begin", "--automation-id", notAppliedId, "--recover", "--expected-revision", String(notAppliedState.revision),
  ]).out!;
  run([
    "side-effect-intent", "--automation-id", notAppliedId, "--session-token", String(notAppliedResumed.session_token),
    "--key", "alert", "--action", "send alert", "--request-digest", "0003",
  ]);
  check(run(["status", "--automation-id", notAppliedId]).out?.pending_side_effect.key === "alert", "a not_applied key may be retried under a new session");

  const adjWorkerId = "reconcile-worker";
  const adjWorkerRun = run(["begin", "--automation-id", adjWorkerId]).out!;
  run([
    "worker-start", "--automation-id", adjWorkerId, "--session-token", String(adjWorkerRun.session_token),
    "--", "/bin/sh", "-c", "exit 0",
  ]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = run(["status", "--automation-id", adjWorkerId]).out!;
    if (state.worker?.status !== "running") break;
    Bun.sleepSync(100);
  }
  let adjWorkerState = run(["status", "--automation-id", adjWorkerId]).out!;
  const adjWorkerDir = join(root, adjWorkerId, "runs", String(adjWorkerState.run_id));
  rmSync(join(adjWorkerDir, "worker-result.json"), { force: true });
  adjWorkerState = run(["status", "--automation-id", adjWorkerId]).out!;
  check(adjWorkerState.worker.status === "ambiguous" && adjWorkerState.recovery.classification === "worker_ambiguous", "a lost receipt classifies as worker_ambiguous");
  check(run([
    "begin", "--automation-id", adjWorkerId, "--recover", "--expected-revision", String(adjWorkerState.revision),
  ], 3).err?.error === "WORKER_AMBIGUOUS", "an ambiguous worker still blocks plain recovery");
  const adjWorkerReconciler = run([
    "reconcile-begin", "--automation-id", adjWorkerId, "--expected-revision", String(adjWorkerState.revision),
    "--owner", "drill", "--assume-stale", "drill",
  ]).out!;
  const adjudicatedWorker = run([
    "worker-adjudicate", "--automation-id", adjWorkerId, "--reconcile-token", String(adjWorkerReconciler.reconcile_token),
    "--outcome", "completed", "--evidence", "artifact present and stdout log complete", "--verifier", "worker-receipt",
  ]).out!;
  check(adjudicatedWorker.worker.status === "completed" && adjudicatedWorker.worker.adjudicated === true, "worker adjudication supplies the missing receipt");
  run(["reconcile-release", "--automation-id", adjWorkerId, "--reconcile-token", String(adjWorkerReconciler.reconcile_token)]);
  adjWorkerState = run(["status", "--automation-id", adjWorkerId]).out!;
  const adjWorkerResumed = run([
    "begin", "--automation-id", adjWorkerId, "--recover", "--expected-revision", String(adjWorkerState.revision),
  ]).out!;
  check(adjWorkerResumed.outcome === "resumed", "an adjudicated worker permits recovery");
  run(["finish", "--automation-id", adjWorkerId, "--session-token", String(adjWorkerResumed.session_token)]);

  process.stdout.write("automation-resilience: all tests passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
