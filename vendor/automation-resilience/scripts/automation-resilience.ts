import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Status = "pending" | "in_progress" | "waiting_worker" | "blocked" | "completed" | "failed";

type SideEffectVerification = {
  kind: string;
  subject?: string;
  recipient?: string;
  reference?: string;
};

type PendingSideEffect = {
  key: string;
  action: string;
  request_digest: string;
  recorded_at: string;
  resolved_at?: string;
  evidence?: string;
  verification?: SideEffectVerification;
};

type SideEffectOutcome = "applied" | "not_applied" | "ambiguous" | "invalidated";
type WorkerOutcome = "completed" | "failed" | "ambiguous" | "invalidated";

type WorkerAdjudication = {
  outcome: WorkerOutcome;
  evidence: string;
  exit_code: number | null;
  adjudicated_at: string;
  by: string;
};

type WorkerState = {
  pid: number;
  status: "running" | "completed" | "failed" | "ambiguous";
  command: string[];
  command_digest: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout_log: string;
  stderr_log: string;
  result_file: string;
  adjudication?: WorkerAdjudication | null;
};

type Adjudication = {
  kind: "side_effect" | "worker";
  key: string;
  outcome: SideEffectOutcome | WorkerOutcome;
  evidence: string;
  verifier: string | null;
  by: string;
  adjudicated_at: string;
  request_digest?: string;
};

type Reconciliation = {
  token: string | null;
  owner: string;
  acquired_at: string;
  released_at: string | null;
  attempts: number;
  staleness: string;
};

type BudgetCheckpoint = {
  recorded_at: string;
  elapsed_seconds: number;
  phase: string;
  completed_criteria: string;
  next_action: string;
  artifacts: string[];
  side_effect_state: PendingSideEffect | null;
};

type BudgetHandoff = {
  key: string;
  recorded_at: string;
  elapsed_seconds: number;
  next_action: string;
};

type Budget = {
  boot_id: string;
  started_uptime: number;
  started_at: string;
  checkpoint_seconds: number;
  handoff_seconds: number;
  checkpoint: BudgetCheckpoint | null;
  handoff: BudgetHandoff | null;
};

type HistoryEntry = {
  at: string;
  event: string;
  detail?: string;
};

type RunState = {
  schema_version: 2;
  automation_id: string;
  run_id: string;
  status: Status;
  last_completed_step: string | null;
  pending_side_effect: PendingSideEffect | null;
  worker: WorkerState | null;
  session_token: string | null;
  budget: Budget | null;
  revision: number;
  created_at: string;
  updated_at: string;
  history: HistoryEntry[];
  blocked_reason?: string;
  failure_reason?: string;
  reconciliation?: Reconciliation | null;
  adjudications?: Adjudication[];
  invalidated_side_effect_keys?: string[];
};

const SIDE_EFFECT_OUTCOMES = new Set<string>(["applied", "not_applied", "ambiguous", "invalidated"]);
const WORKER_OUTCOMES = new Set<string>(["completed", "failed", "ambiguous", "invalidated"]);

class RuntimeError extends Error {
  code: string;
  exitCode: number;

  constructor(code: string, message: string, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const DEFAULT_ROOT = "/home/workspace/.zo/automation-runs";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TERMINAL = new Set<Status>(["completed", "failed"]);
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const UPTIME_PATH = "/proc/uptime";
const DEFAULT_CHECKPOINT_SECONDS = 48 * 60;
const DEFAULT_HANDOFF_SECONDS = 53 * 60;

type Monotonic = { boot_id: string; uptime: number };

function monotonicNow(): Monotonic {
  const bootId = readFileSync(BOOT_ID_PATH, "utf8").trim();
  const uptime = Number.parseFloat(readFileSync(UPTIME_PATH, "utf8").split(/\s+/)[0]);
  if (!bootId || !Number.isFinite(uptime)) {
    throw new RuntimeError("MONOTONIC_UNAVAILABLE", "Host monotonic clock is unreadable");
  }
  return { boot_id: bootId, uptime };
}

function positiveSeconds(args: string[], name: string, fallback: number): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeError("INVALID_BUDGET", `--${name} must be a positive number of seconds`);
  }
  return value;
}

function optionalPositiveSeconds(args: string[], name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeError("INVALID_ESTIMATE", `--${name} must be a positive number of seconds`);
  }
  return value;
}

function newBudget(args: string[]): Budget {
  const clock = monotonicNow();
  const checkpointSeconds = positiveSeconds(args, "checkpoint-seconds", DEFAULT_CHECKPOINT_SECONDS);
  const handoffSeconds = positiveSeconds(args, "handoff-seconds", DEFAULT_HANDOFF_SECONDS);
  if (handoffSeconds <= checkpointSeconds) {
    throw new RuntimeError("INVALID_BUDGET", "--handoff-seconds must exceed --checkpoint-seconds");
  }
  return {
    boot_id: clock.boot_id,
    started_uptime: clock.uptime,
    started_at: now(),
    checkpoint_seconds: checkpointSeconds,
    handoff_seconds: handoffSeconds,
    checkpoint: null,
    handoff: null,
  };
}

function budgetObservation(budget: Budget | null): Record<string, unknown> | null {
  if (!budget) return null;
  const clock = monotonicNow();
  if (clock.boot_id !== budget.boot_id) {
    return {
      ...budget,
      phase: "host_restarted",
      elapsed_seconds: null,
      remaining_to_handoff_seconds: null,
      observed_boot_id: clock.boot_id,
    };
  }
  const elapsed = Math.max(0, clock.uptime - budget.started_uptime);
  let phase: string;
  if (budget.handoff) phase = "handed_off";
  else if (elapsed >= budget.handoff_seconds) phase = "handoff_due";
  else if (elapsed >= budget.checkpoint_seconds) phase = budget.checkpoint ? "checkpointed" : "checkpoint_due";
  else phase = "ok";
  return {
    ...budget,
    phase,
    elapsed_seconds: Number(elapsed.toFixed(3)),
    remaining_to_checkpoint_seconds: Number(Math.max(0, budget.checkpoint_seconds - elapsed).toFixed(3)),
    remaining_to_handoff_seconds: Number(Math.max(0, budget.handoff_seconds - elapsed).toFixed(3)),
  };
}

function requireLiveBudget(state: RunState): Budget {
  if (!state.budget) throw new RuntimeError("NO_BUDGET", `Run ${state.run_id} has no turn budget`, 3);
  const clock = monotonicNow();
  if (clock.boot_id !== state.budget.boot_id) {
    throw new RuntimeError("BUDGET_BOOT_MISMATCH", "Host restarted since the budget was armed; re-acquire ownership", 3);
  }
  return state.budget;
}

function elapsedSeconds(budget: Budget): number {
  return Math.max(0, monotonicNow().uptime - budget.started_uptime);
}

function now(): string {
  return new Date().toISOString();
}

function rootPath(): string {
  return resolve(process.env.AUTOMATION_RESILIENCE_ROOT || DEFAULT_ROOT);
}

function validateId(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new RuntimeError("INVALID_IDENTIFIER", `${name} contains unsupported characters`);
  }
  return value;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new RuntimeError("MISSING_OPTION_VALUE", `--${name} requires a value`);
  }
  return value;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new RuntimeError("MISSING_OPTION", `--${name} is required`);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function automationDir(automationId: string): string {
  return join(rootPath(), validateId(automationId, "automation_id"));
}

function latestPath(automationId: string): string {
  return join(automationDir(automationId), "latest.json");
}

function statePath(automationId: string, runId: string): string {
  return join(automationDir(automationId), "runs", validateId(runId, "run_id"), "state.json");
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function migrate(state: RunState): RunState {
  if (state.schema_version < 2) {
    state.budget = null;
    state.schema_version = 2;
  }
  if (state.budget === undefined) state.budget = null;
  if (state.reconciliation === undefined) state.reconciliation = null;
  if (!Array.isArray(state.adjudications)) state.adjudications = [];
  if (!Array.isArray(state.invalidated_side_effect_keys)) state.invalidated_side_effect_keys = [];
  return state;
}

function readLatest(automationId: string): RunState | null {
  const pointer = latestPath(automationId);
  if (!existsSync(pointer)) return null;
  const { run_id } = readJson<{ run_id: string }>(pointer);
  const path = statePath(automationId, run_id);
  if (!existsSync(path)) {
    throw new RuntimeError("BROKEN_POINTER", `Latest pointer references missing run ${run_id}`, 3);
  }
  return migrate(readJson<RunState>(path));
}

function writeState(state: RunState): void {
  state.updated_at = now();
  atomicWrite(statePath(state.automation_id, state.run_id), state);
  atomicWrite(latestPath(state.automation_id), { run_id: state.run_id });
}

function withLock<T>(automationId: string, operation: () => T): T {
  const locks = join(rootPath(), ".locks");
  mkdirSync(locks, { recursive: true });
  const lock = join(locks, `${validateId(automationId, "automation_id")}.lock`);
  try {
    mkdirSync(lock);
  } catch {
    throw new RuntimeError("LOCKED", `Automation ${automationId} has another state transition in progress`, 3);
  }
  try {
    return operation();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function workerObservation(worker: WorkerState | null): Record<string, unknown> | null {
  if (!worker) return null;
  if (existsSync(worker.result_file)) {
    const result = readJson<{ exit_code: number; finished_at: string }>(worker.result_file);
    return {
      ...worker,
      status: result.exit_code === 0 ? "completed" : "failed",
      exit_code: result.exit_code,
      finished_at: result.finished_at,
      alive: false,
    };
  }
  const alive = pidAlive(worker.pid);
  if (!alive && worker.adjudication) {
    return {
      ...worker,
      status: worker.adjudication.outcome,
      exit_code: worker.adjudication.exit_code,
      alive: false,
      adjudicated: true,
    };
  }
  return { ...worker, status: alive ? "running" : "ambiguous", alive };
}

type RecoveryObservation = {
  classification: string;
  age_seconds: number;
  attempts: number;
  owner: string | null;
  reconciliation_active: boolean;
  last_adjudication: Adjudication | null;
  pending_side_effect_key: string | null;
  next_action: string;
};

function recoveryObservation(state: RunState): RecoveryObservation {
  const adjudications = state.adjudications ?? [];
  const last = adjudications.length > 0 ? adjudications[adjudications.length - 1] : null;
  const pending = state.pending_side_effect && !state.pending_side_effect.resolved_at ? state.pending_side_effect : null;
  const worker = workerObservation(state.worker);
  const budget = budgetObservation(state.budget);
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(state.updated_at)) / 1000));
  let classification: string;
  let nextAction: string;
  if (TERMINAL.has(state.status)) {
    classification = "terminal";
    nextAction = "none; the next scheduled occurrence may begin";
  } else if (pending) {
    if (last?.kind === "side_effect" && last.key === pending.key && last.outcome === "ambiguous") {
      classification = "side_effect_ambiguous_escalated";
      nextAction = `operator must adjudicate side effect ${pending.key} from new external evidence`;
    } else {
      classification = "side_effect_uncertain";
      nextAction = `verify side effect ${pending.key} against its system of record, then side-effect-adjudicate`;
    }
  } else if (worker?.status === "running") {
    classification = "worker_running";
    nextAction = "wait for the detached worker to finish";
  } else if (worker?.status === "ambiguous") {
    classification = "worker_ambiguous";
    nextAction = "inspect worker logs and artifacts, then worker-adjudicate";
  } else if (worker?.status === "failed") {
    classification = "worker_failed";
    nextAction = "inspect the failure, then reconcile-close --outcome failed or worker-adjudicate invalidated";
  } else if (budget?.handoff) {
    classification = "handed_off";
    nextAction = "resume with begin --recover at the recorded next action";
  } else if (state.status === "blocked") {
    classification = "blocked";
    nextAction = "resolve the blocked reason, then begin --recover or reconcile-close";
  } else if (budget?.phase === "host_restarted") {
    classification = "owner_lost_host_restart";
    nextAction = "resume with begin --recover; the original session cannot continue";
  } else if (budget?.phase === "handoff_due" || budget?.phase === "handed_off") {
    classification = "owner_stale";
    nextAction = "resume with begin --recover";
  } else {
    classification = "in_progress_live";
    nextAction = "none; the owning session may still be live";
  }
  return {
    classification,
    age_seconds: ageSeconds,
    attempts: state.reconciliation?.attempts ?? 0,
    owner: state.reconciliation?.owner ?? null,
    reconciliation_active: Boolean(state.reconciliation?.token),
    last_adjudication: last,
    pending_side_effect_key: pending?.key ?? null,
    next_action: nextAction,
  };
}

function publicState(state: RunState | null): Record<string, unknown> {
  if (!state) return { exists: false };
  const { session_token: _secret, reconciliation, ...safe } = state;
  return {
    exists: true,
    ...safe,
    worker: workerObservation(state.worker),
    budget: budgetObservation(state.budget),
    reconciliation: reconciliation ? { ...reconciliation, token: undefined, active: Boolean(reconciliation.token) } : null,
    recovery: recoveryObservation(state),
  };
}

function requireReconcilerState(args: string[]): RunState {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const token = required(args, "reconcile-token");
  const state = readLatest(automationId);
  if (!state) throw new RuntimeError("NO_RUN", `Automation ${automationId} has no run`, 3);
  if (TERMINAL.has(state.status)) throw new RuntimeError("RUN_TERMINAL", `Run ${state.run_id} is ${state.status}`, 3);
  if (!state.reconciliation?.token || state.reconciliation.token !== token) {
    throw new RuntimeError("RECONCILIATION_MISMATCH", `Run ${state.run_id} is not owned by this reconciler`, 3);
  }
  return state;
}

function requireOwnedState(args: string[]): RunState {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const sessionToken = required(args, "session-token");
  const state = readLatest(automationId);
  if (!state) throw new RuntimeError("NO_RUN", `Automation ${automationId} has no run`, 3);
  if (TERMINAL.has(state.status)) throw new RuntimeError("RUN_TERMINAL", `Run ${state.run_id} is ${state.status}`, 3);
  if (state.session_token !== sessionToken) {
    throw new RuntimeError("OWNERSHIP_MISMATCH", `Run ${state.run_id} belongs to another session`, 3);
  }
  return state;
}

function addHistory(state: RunState, event: string, detail?: string): void {
  state.history.push({ at: now(), event, ...(detail ? { detail } : {}) });
  state.revision += 1;
}

function ensureWorkerSafeToProceed(state: RunState): void {
  if (!state.worker) return;
  const observed = workerObservation(state.worker);
  if (observed?.status === "running") {
    throw new RuntimeError("WORKER_RUNNING", `Worker ${state.worker.pid} is still running`, 3);
  }
  if (observed?.status === "ambiguous") {
    throw new RuntimeError("WORKER_AMBIGUOUS", "Worker stopped without durable exit evidence", 3);
  }
  if (observed?.status === "failed") {
    throw new RuntimeError("WORKER_FAILED", `Worker exited ${String(observed.exit_code)}`, 3);
  }
}

function budgetIsStale(state: RunState): string | null {
  if (state.status === "blocked") return "run is blocked";
  if (!state.budget) return "run carries no budget";
  const current = monotonicNow();
  if (current.boot_id !== state.budget.boot_id) return "host restarted since the run began";
  const elapsed = current.uptime - state.budget.started_uptime;
  if (elapsed > state.budget.handoff_seconds) return `elapsed ${Math.round(elapsed)}s exceeds the ${state.budget.handoff_seconds}s handoff budget`;
  return null;
}

function recordAdjudication(state: RunState, entry: Adjudication): void {
  if (!state.adjudications) state.adjudications = [];
  state.adjudications.push(entry);
}

function commandBegin(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  return withLock(automationId, () => {
    const existing = readLatest(automationId);
    const sessionToken = randomUUID();
    if (!existing || TERMINAL.has(existing.status)) {
      const timestamp = now();
      const state: RunState = {
        schema_version: 2,
        automation_id: automationId,
        run_id: randomUUID(),
        status: "in_progress",
        last_completed_step: null,
        pending_side_effect: null,
        worker: null,
        session_token: sessionToken,
        budget: newBudget(args),
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
        history: [{ at: timestamp, event: "began" }],
      };
      writeState(state);
      return {
        outcome: "started",
        run_id: state.run_id,
        session_token: sessionToken,
        revision: state.revision,
        budget: budgetObservation(state.budget),
      };
    }
    if (!hasFlag(args, "recover")) {
      throw new RuntimeError("RECOVERY_REQUIRED", `Run ${existing.run_id} is incomplete at revision ${existing.revision}`, 3);
    }
    const expected = Number(required(args, "expected-revision"));
    if (!Number.isInteger(expected) || expected !== existing.revision) {
      throw new RuntimeError("REVISION_MISMATCH", `Expected revision ${expected}; current revision is ${existing.revision}`, 3);
    }
    if (existing.pending_side_effect && !existing.pending_side_effect.resolved_at) {
      throw new RuntimeError("SIDE_EFFECT_UNCERTAIN", `Side effect ${existing.pending_side_effect.key} requires verification`, 3);
    }
    ensureWorkerSafeToProceed(existing);
    const carried = existing.budget;
    existing.session_token = sessionToken;
    existing.status = "in_progress";
    delete existing.blocked_reason;
    if (existing.reconciliation?.token) {
      existing.reconciliation.token = null;
      existing.reconciliation.released_at = now();
    }
    existing.budget = newBudget(args);
    existing.budget.checkpoint = carried?.checkpoint ?? null;
    addHistory(existing, "recovered", `from revision ${expected}`);
    writeState(existing);
    return {
      outcome: "resumed",
      run_id: existing.run_id,
      session_token: sessionToken,
      revision: existing.revision,
      last_completed_step: existing.last_completed_step,
      resumed_from_checkpoint: existing.budget.checkpoint,
      budget: budgetObservation(existing.budget),
    };
  });
}

function commandStatus(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  return publicState(readLatest(automationId));
}

function commandCheckpoint(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const step = required(args, "step");
  return withLock(automationId, () => {
    const state = requireOwnedState(args);
    if (state.pending_side_effect && !state.pending_side_effect.resolved_at) {
      throw new RuntimeError("SIDE_EFFECT_UNCERTAIN", `Resolve ${state.pending_side_effect.key} before checkpointing`, 3);
    }
    ensureWorkerSafeToProceed(state);
    state.last_completed_step = step;
    state.status = "in_progress";
    addHistory(state, "checkpoint", step);
    writeState(state);
    return { outcome: "checkpointed", run_id: state.run_id, step, revision: state.revision };
  });
}

function commandSideEffectIntent(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  return withLock(automationId, () => {
    const state = requireOwnedState(args);
    if (state.pending_side_effect && !state.pending_side_effect.resolved_at) {
      throw new RuntimeError("SIDE_EFFECT_UNCERTAIN", `Pending side effect ${state.pending_side_effect.key} is unresolved`, 3);
    }
    ensureWorkerSafeToProceed(state);
    const key = required(args, "key");
    if ((state.invalidated_side_effect_keys ?? []).includes(key)) {
      throw new RuntimeError("SIDE_EFFECT_INVALIDATED", `Side effect ${key} was invalidated and must not be replayed`, 3);
    }
    state.pending_side_effect = {
      key,
      action: required(args, "action"),
      request_digest: required(args, "request-digest"),
      recorded_at: now(),
      ...(option(args, "verify") ? { verification: parseVerification(option(args, "verify")!) } : {}),
    };
    addHistory(state, "side_effect_intent", state.pending_side_effect.key);
    writeState(state);
    return { outcome: "intent_recorded", key: state.pending_side_effect.key, revision: state.revision };
  });
}

function commandSideEffectResolve(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  return withLock(automationId, () => {
    const state = requireOwnedState(args);
    const key = required(args, "key");
    if (!state.pending_side_effect || state.pending_side_effect.key !== key || state.pending_side_effect.resolved_at) {
      throw new RuntimeError("NO_MATCHING_SIDE_EFFECT", `No unresolved side effect matches ${key}`, 3);
    }
    state.pending_side_effect.resolved_at = now();
    state.pending_side_effect.evidence = required(args, "evidence");
    recordAdjudication(state, {
      kind: "side_effect",
      key,
      outcome: "applied",
      evidence: state.pending_side_effect.evidence,
      verifier: option(args, "verifier") ?? null,
      by: "session",
      adjudicated_at: state.pending_side_effect.resolved_at,
      request_digest: state.pending_side_effect.request_digest,
    });
    addHistory(state, "side_effect_resolved", key);
    state.pending_side_effect = null;
    writeState(state);
    return { outcome: "side_effect_resolved", key, revision: state.revision };
  });
}

function commandWorkerStart(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const separator = args.indexOf("--");
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  if (command.length === 0) throw new RuntimeError("MISSING_COMMAND", "worker-start requires a command after --");
  return withLock(automationId, () => {
    const state = requireOwnedState(args);
    if (state.pending_side_effect && !state.pending_side_effect.resolved_at) {
      throw new RuntimeError("SIDE_EFFECT_UNCERTAIN", `Resolve ${state.pending_side_effect.key} before starting a worker`, 3);
    }
    ensureWorkerSafeToProceed(state);
    const runDir = dirname(statePath(state.automation_id, state.run_id));
    const resultFile = join(runDir, "worker-result.json");
    const stdoutLog = join(runDir, "worker.stdout.log");
    const stderrLog = join(runDir, "worker.stderr.log");
    rmSync(resultFile, { force: true });
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const childArgs = [
      SCRIPT_PATH,
      "worker-exec",
      "--automation-id",
      state.automation_id,
      "--run-id",
      state.run_id,
      "--session-token",
      required(args, "session-token"),
      "--result-file",
      resultFile,
      "--stdout-log",
      stdoutLog,
      "--stderr-log",
      stderrLog,
      "--",
      ...command,
    ];
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: "ignore" });
    if (!child.pid) throw new RuntimeError("WORKER_SPAWN_FAILED", "Detached worker did not return a PID");
    child.unref();
    state.worker = {
      pid: child.pid,
      status: "running",
      command,
      command_digest: digest,
      started_at: now(),
      finished_at: null,
      exit_code: null,
      stdout_log: stdoutLog,
      stderr_log: stderrLog,
      result_file: resultFile,
    };
    state.status = "waiting_worker";
    addHistory(state, "worker_started", `${child.pid}:${digest}`);
    writeState(state);
    return {
      outcome: "worker_started",
      pid: child.pid,
      command_digest: digest,
      revision: state.revision,
    };
  });
}

function commandWorkerStatus(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const state = readLatest(automationId);
  if (!state) throw new RuntimeError("NO_RUN", `Automation ${automationId} has no run`, 3);
  return { run_id: state.run_id, worker: workerObservation(state.worker), status: state.status, revision: state.revision };
}

function commandWorkerExec(args: string[]): Record<string, unknown> {
  const separator = args.indexOf("--");
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  if (command.length === 0) throw new RuntimeError("MISSING_COMMAND", "worker-exec requires a command after --");
  const stdoutFd = openSync(required(args, "stdout-log"), "a", 0o600);
  const stderrFd = openSync(required(args, "stderr-log"), "a", 0o600);
  const result = spawnSync(command[0], command.slice(1), { stdio: ["ignore", stdoutFd, stderrFd] });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const exitCode = result.status ?? 1;
  const finishedAt = now();
  atomicWrite(required(args, "result-file"), { exit_code: exitCode, finished_at: finishedAt, signal: result.signal });
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  withLock(automationId, () => {
    const state = readLatest(automationId);
    if (!state || state.run_id !== required(args, "run-id") || state.session_token !== required(args, "session-token")) return;
    if (!state.worker || state.worker.pid !== process.pid) return;
    state.worker.status = exitCode === 0 ? "completed" : "failed";
    state.worker.exit_code = exitCode;
    state.worker.finished_at = finishedAt;
    state.status = exitCode === 0 ? "in_progress" : "failed";
    addHistory(state, "worker_finished", String(exitCode));
    writeState(state);
  });
  return { outcome: "worker_finished", exit_code: exitCode };
}

function commandBudget(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const state = readLatest(automationId);
  if (!state) throw new RuntimeError("NO_RUN", `Automation ${automationId} has no run`, 3);
  return { run_id: state.run_id, status: state.status, revision: state.revision, budget: budgetObservation(state.budget) };
}

function parseArtifacts(args: string[]): string[] {
  const raw = option(args, "artifacts");
  if (!raw) return [];
  const paths = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const path of paths) {
    if (!path.startsWith("/")) {
      throw new RuntimeError("INVALID_ARTIFACT", `Artifact path ${path} must be absolute`);
    }
  }
  return paths;
}

function commandBudgetCheckpoint(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  return withLock(automationId, () => {
    const state = requireOwnedState(args);
    const budget = requireLiveBudget(state);
    const artifacts = parseArtifacts(args);
    const checkpoint: BudgetCheckpoint = {
      recorded_at: now(),
      elapsed_seconds: Number(elapsedSeconds(budget).toFixed(3)),
      phase: required(args, "phase"),
      completed_criteria: required(args, "completed-criteria"),
      next_action: required(args, "next-action"),
      artifacts,
      side_effect_state: state.pending_side_effect,
    };
    budget.checkpoint = checkpoint;
    addHistory(state, "budget_checkpoint", `${checkpoint.phase}@${checkpoint.elapsed_seconds}s`);
    writeState(state);
    return { outcome: "budget_checkpointed", run_id: state.run_id, revision: state.revision, checkpoint };
  });
}

function commandBudgetHandoff(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const key = required(args, "key");
  return withLock(automationId, () => {
    const state = requireOwnedState(args);
    const budget = requireLiveBudget(state);
    if (budget.handoff) {
      if (budget.handoff.key !== key) {
        throw new RuntimeError("HANDOFF_CONFLICT", `Run ${state.run_id} already handed off under key ${budget.handoff.key}`, 3);
      }
      return {
        outcome: "already_handed_off",
        run_id: state.run_id,
        revision: state.revision,
        handoff: budget.handoff,
      };
    }
    if (!budget.checkpoint) {
      throw new RuntimeError("HANDOFF_WITHOUT_CHECKPOINT", "Record a budget checkpoint before handing off", 3);
    }
    const nextAction = required(args, "next-action");
    budget.handoff = {
      key,
      recorded_at: now(),
      elapsed_seconds: Number(elapsedSeconds(budget).toFixed(3)),
      next_action: nextAction,
    };
    state.status = "blocked";
    state.blocked_reason = `handoff:${key}: ${nextAction}`;
    addHistory(state, "budget_handoff", key);
    writeState(state);
    return {
      outcome: "handed_off",
      run_id: state.run_id,
      revision: state.revision,
      handoff: budget.handoff,
      unresolved_side_effect: state.pending_side_effect && !state.pending_side_effect.resolved_at
        ? state.pending_side_effect.key
        : null,
    };
  });
}

function commandTerminal(args: string[], status: "blocked" | "failed" | "completed"): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  return withLock(automationId, () => {
    const state = requireOwnedState(args);
    if (status === "completed") {
      if (state.pending_side_effect && !state.pending_side_effect.resolved_at) {
        throw new RuntimeError("SIDE_EFFECT_UNCERTAIN", `Resolve ${state.pending_side_effect.key} before finishing`, 3);
      }
      ensureWorkerSafeToProceed(state);
    }
    const reason = status === "completed" ? undefined : required(args, "reason");
    state.status = status;
    if (status === "blocked") state.blocked_reason = reason;
    if (status === "failed") state.failure_reason = reason;
    if (status !== "blocked") state.session_token = null;
    addHistory(state, status, reason);
    writeState(state);
    return { outcome: status, run_id: state.run_id, revision: state.revision };
  });
}

function parseVerification(raw: string): SideEffectVerification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RuntimeError("INVALID_VERIFICATION", "--verify must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeError("INVALID_VERIFICATION", "--verify must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== "string" || !record.kind) {
    throw new RuntimeError("INVALID_VERIFICATION", "--verify requires a string kind");
  }
  const verification: SideEffectVerification = { kind: record.kind };
  for (const field of ["subject", "recipient", "reference"] as const) {
    if (typeof record[field] === "string") verification[field] = record[field] as string;
  }
  return verification;
}

function commandReconcileBegin(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const owner = required(args, "owner");
  return withLock(automationId, () => {
    const state = readLatest(automationId);
    if (!state) throw new RuntimeError("NO_RUN", `Automation ${automationId} has no run`, 3);
    if (TERMINAL.has(state.status)) throw new RuntimeError("RUN_TERMINAL", `Run ${state.run_id} is ${state.status}`, 3);
    const expected = Number(required(args, "expected-revision"));
    if (!Number.isInteger(expected) || expected !== state.revision) {
      throw new RuntimeError("REVISION_MISMATCH", `Expected revision ${expected}; current revision is ${state.revision}`, 3);
    }
    if (state.reconciliation?.token) {
      throw new RuntimeError("RECONCILIATION_ACTIVE", `Run ${state.run_id} is already owned by reconciler ${state.reconciliation.owner}`, 3);
    }
    let staleness = budgetIsStale(state);
    if (!staleness) {
      const assumed = option(args, "assume-stale");
      if (!assumed) {
        throw new RuntimeError("OWNER_MAY_BE_LIVE", `Run ${state.run_id} is inside its budget on the current boot; pass --assume-stale REASON only with evidence the owner is gone`, 3);
      }
      staleness = `assumed stale: ${assumed}`;
    }
    const token = randomUUID();
    const attempts = (state.reconciliation?.attempts ?? 0) + 1;
    state.session_token = null;
    state.reconciliation = { token, owner, acquired_at: now(), released_at: null, attempts, staleness };
    addHistory(state, "reconciliation_acquired", `${owner}#${attempts}: ${staleness}`);
    writeState(state);
    return {
      outcome: "reconciliation_acquired",
      run_id: state.run_id,
      reconcile_token: token,
      revision: state.revision,
      attempts,
      staleness,
      permitted: ["status", "side-effect-adjudicate", "worker-adjudicate", "reconcile-close", "reconcile-release"],
      recovery: recoveryObservation(state),
    };
  });
}

function commandSideEffectAdjudicate(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const key = required(args, "key");
  const outcome = required(args, "outcome");
  const evidence = required(args, "evidence");
  if (!SIDE_EFFECT_OUTCOMES.has(outcome)) {
    throw new RuntimeError("INVALID_OUTCOME", `Side-effect outcome must be one of ${[...SIDE_EFFECT_OUTCOMES].join(", ")}`);
  }
  return withLock(automationId, () => {
    const state = requireReconcilerState(args);
    const pending = state.pending_side_effect;
    if (!pending || pending.key !== key || pending.resolved_at) {
      throw new RuntimeError("NO_MATCHING_SIDE_EFFECT", `No unresolved side effect matches ${key}`, 3);
    }
    const at = now();
    recordAdjudication(state, {
      kind: "side_effect",
      key,
      outcome: outcome as SideEffectOutcome,
      evidence,
      verifier: option(args, "verifier") ?? null,
      by: state.reconciliation?.owner ?? "reconciler",
      adjudicated_at: at,
      request_digest: pending.request_digest,
    });
    if (outcome === "applied") {
      pending.resolved_at = at;
      pending.evidence = evidence;
      state.pending_side_effect = null;
      delete state.blocked_reason;
    } else if (outcome === "not_applied") {
      state.pending_side_effect = null;
      delete state.blocked_reason;
    } else if (outcome === "invalidated") {
      state.pending_side_effect = null;
      if (!state.invalidated_side_effect_keys) state.invalidated_side_effect_keys = [];
      if (!state.invalidated_side_effect_keys.includes(key)) state.invalidated_side_effect_keys.push(key);
      delete state.blocked_reason;
    } else {
      state.status = "blocked";
      state.blocked_reason = `side effect ${key} ambiguous after adjudication: ${evidence}`;
    }
    addHistory(state, "side_effect_adjudicated", `${key}:${outcome}`);
    writeState(state);
    return {
      outcome: "side_effect_adjudicated",
      key,
      adjudication: outcome,
      run_id: state.run_id,
      revision: state.revision,
      status: state.status,
      recovery: recoveryObservation(state),
    };
  });
}

function commandWorkerAdjudicate(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const outcome = required(args, "outcome");
  const evidence = required(args, "evidence");
  if (!WORKER_OUTCOMES.has(outcome)) {
    throw new RuntimeError("INVALID_OUTCOME", `Worker outcome must be one of ${[...WORKER_OUTCOMES].join(", ")}`);
  }
  return withLock(automationId, () => {
    const state = requireReconcilerState(args);
    if (!state.worker) throw new RuntimeError("NO_WORKER", `Run ${state.run_id} has no detached worker`, 3);
    if (existsSync(state.worker.result_file)) {
      throw new RuntimeError("WORKER_EVIDENCED", "Worker already has a durable exit record; adjudication is unnecessary", 3);
    }
    if (pidAlive(state.worker.pid)) {
      throw new RuntimeError("WORKER_RUNNING", `Worker ${state.worker.pid} is still running`, 3);
    }
    const rawExit = option(args, "exit-code");
    const exitCode = rawExit === undefined ? (outcome === "completed" ? 0 : outcome === "failed" ? 1 : null) : Number(rawExit);
    if (rawExit !== undefined && !Number.isInteger(exitCode)) {
      throw new RuntimeError("INVALID_EXIT_CODE", "--exit-code must be an integer");
    }
    const at = now();
    state.worker.adjudication = { outcome: outcome as WorkerOutcome, evidence, exit_code: exitCode, adjudicated_at: at, by: state.reconciliation?.owner ?? "reconciler" };
    if (outcome === "completed" || outcome === "failed") {
      state.worker.status = outcome;
      state.worker.exit_code = exitCode;
      state.worker.finished_at = at;
      state.status = outcome === "failed" ? "blocked" : "in_progress";
      if (outcome === "failed") state.blocked_reason = `worker adjudicated failed: ${evidence}`;
      else delete state.blocked_reason;
    } else if (outcome === "ambiguous") {
      state.status = "blocked";
      state.blocked_reason = `worker ambiguous after adjudication: ${evidence}`;
    } else {
      state.status = "in_progress";
      delete state.blocked_reason;
    }
    recordAdjudication(state, {
      kind: "worker",
      key: state.worker.command_digest,
      outcome: outcome as WorkerOutcome,
      evidence,
      verifier: option(args, "verifier") ?? null,
      by: state.worker.adjudication.by,
      adjudicated_at: at,
    });
    addHistory(state, "worker_adjudicated", `${state.worker.pid}:${outcome}`);
    writeState(state);
    return {
      outcome: "worker_adjudicated",
      adjudication: outcome,
      run_id: state.run_id,
      revision: state.revision,
      status: state.status,
      worker: workerObservation(state.worker),
      recovery: recoveryObservation(state),
    };
  });
}

function commandReconcileClose(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  const outcome = required(args, "outcome");
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "blocked") {
    throw new RuntimeError("INVALID_OUTCOME", "reconcile-close outcome must be completed, failed, or blocked");
  }
  const reason = required(args, "reason");
  return withLock(automationId, () => {
    const state = requireReconcilerState(args);
    if (outcome === "completed") {
      if (state.pending_side_effect && !state.pending_side_effect.resolved_at) {
        throw new RuntimeError("SIDE_EFFECT_UNCERTAIN", `Adjudicate ${state.pending_side_effect.key} before closing as completed`, 3);
      }
      ensureWorkerSafeToProceed(state);
    }
    state.status = outcome;
    if (outcome === "blocked") state.blocked_reason = reason;
    if (outcome === "failed") state.failure_reason = reason;
    state.session_token = null;
    if (state.reconciliation) {
      state.reconciliation.token = null;
      state.reconciliation.released_at = now();
    }
    addHistory(state, outcome, `reconciled: ${reason}`);
    writeState(state);
    return { outcome, run_id: state.run_id, revision: state.revision, recovery: recoveryObservation(state) };
  });
}

function commandReconcileRelease(args: string[]): Record<string, unknown> {
  const automationId = validateId(required(args, "automation-id"), "automation_id");
  return withLock(automationId, () => {
    const state = requireReconcilerState(args);
    if (state.reconciliation) {
      state.reconciliation.token = null;
      state.reconciliation.released_at = now();
    }
    addHistory(state, "reconciliation_released");
    writeState(state);
    return { outcome: "reconciliation_released", run_id: state.run_id, revision: state.revision, status: state.status, recovery: recoveryObservation(state) };
  });
}

function help(): string {
  return [
    "automation-resilience commands:",
    "  status --automation-id ID",
    "  begin --automation-id ID [--recover --expected-revision N] [--checkpoint-seconds N] [--handoff-seconds N] [--estimated-seconds N]",
    "  checkpoint --automation-id ID --session-token TOKEN --step NAME",
    "  side-effect-intent --automation-id ID --session-token TOKEN --key KEY --action ACTION --request-digest SHA256 [--verify '{\"kind\":\"email\",\"subject\":\"...\"}']",
    "  side-effect-resolve --automation-id ID --session-token TOKEN --key KEY --evidence TEXT [--verifier NAME]",
    "  reconcile-begin --automation-id ID --expected-revision N --owner NAME [--assume-stale REASON]",
    "  side-effect-adjudicate --automation-id ID --reconcile-token TOKEN --key KEY --outcome applied|not_applied|ambiguous|invalidated --evidence TEXT [--verifier NAME]",
    "  worker-adjudicate --automation-id ID --reconcile-token TOKEN --outcome completed|failed|ambiguous|invalidated --evidence TEXT [--exit-code N] [--verifier NAME]",
    "  reconcile-close --automation-id ID --reconcile-token TOKEN --outcome completed|failed|blocked --reason TEXT",
    "  reconcile-release --automation-id ID --reconcile-token TOKEN",
    "  worker-start --automation-id ID --session-token TOKEN [--estimated-seconds N] -- command [args...]",
    "  worker-status --automation-id ID",
    "  budget --automation-id ID",
    "  budget-checkpoint --automation-id ID --session-token TOKEN --phase NAME --completed-criteria TEXT --next-action TEXT [--artifacts /abs/a,/abs/b]",
    "  budget-handoff --automation-id ID --session-token TOKEN --key KEY --next-action TEXT",
    "  block --automation-id ID --session-token TOKEN --reason TEXT",
    "  fail --automation-id ID --session-token TOKEN --reason TEXT",
    "  finish --automation-id ID --session-token TOKEN",
  ].join("\n");
}

function main(): void {
  const [, , command = "help", ...args] = process.argv;
  let output: Record<string, unknown> | string;
  switch (command) {
    case "status": output = commandStatus(args); break;
    case "begin": output = commandBegin(args); break;
    case "checkpoint": output = commandCheckpoint(args); break;
    case "side-effect-intent": output = commandSideEffectIntent(args); break;
    case "side-effect-resolve": output = commandSideEffectResolve(args); break;
    case "reconcile-begin": output = commandReconcileBegin(args); break;
    case "side-effect-adjudicate": output = commandSideEffectAdjudicate(args); break;
    case "worker-adjudicate": output = commandWorkerAdjudicate(args); break;
    case "reconcile-close": output = commandReconcileClose(args); break;
    case "reconcile-release": output = commandReconcileRelease(args); break;
    case "worker-start": output = commandWorkerStart(args); break;
    case "worker-status": output = commandWorkerStatus(args); break;
    case "worker-exec": output = commandWorkerExec(args); break;
    case "budget": output = commandBudget(args); break;
    case "budget-checkpoint": output = commandBudgetCheckpoint(args); break;
    case "budget-handoff": output = commandBudgetHandoff(args); break;
    case "block": output = commandTerminal(args, "blocked"); break;
    case "fail": output = commandTerminal(args, "failed"); break;
    case "finish": output = commandTerminal(args, "completed"); break;
    case "help": output = help(); break;
    default: throw new RuntimeError("UNKNOWN_COMMAND", `Unknown command ${command}`);
  }
  process.stdout.write(typeof output === "string" ? `${output}\n` : `${JSON.stringify(output)}\n`);
}

try {
  main();
} catch (error) {
  if (error instanceof RuntimeError) {
    process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
    process.exit(error.exitCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: "UNEXPECTED", message })}\n`);
  process.exit(1);
}
