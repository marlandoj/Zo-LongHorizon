import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, "automation-resilience.ts");
const VERIFIERS = join(HERE, "recovery_verifiers.py");
const DEFAULT_ROOT = "/home/workspace/.zo/automation-runs";
const DEFAULT_STATE_DIR = "/home/.z/automation-recovery";
const DEFAULT_HOST_STATE = "/home/.z/host-resilience/state.json";
const DEFAULT_REPORT = "/home/workspace/Projects/zo-computer-stream-resilience/reports/automation-recovery-queue.md";
const WARMUP_SECONDS = 720;
const OWNER = "automation-recovery-controller";

type Verdict = { verifier: string; outcome: string; evidence: string; observed_at: string; details: Record<string, unknown> };

type RunView = {
  automation_id: string;
  run_id: string;
  status: string;
  revision: number;
  updated_at: string;
  pending_side_effect: { key: string; recorded_at: string; verification?: { kind: string; subject?: string } } | null;
  worker: { status: string } | null;
  budget: { phase: string | null } | null;
  recovery: {
    classification: string;
    age_seconds: number;
    attempts: number;
    reconciliation_active: boolean;
    last_adjudication: { outcome: string; evidence: string; adjudicated_at: string } | null;
    next_action: string;
  };
  adjudications?: Array<{ outcome: string; evidence: string }>;
};

type Decision = {
  at: string;
  automation_id: string;
  run_id: string;
  classification: string;
  action: string;
  detail: string;
  verdict?: Verdict;
};

function rootPath(): string {
  return resolve(process.env.AUTOMATION_RESILIENCE_ROOT || DEFAULT_ROOT);
}

function stateDir(): string {
  const dir = resolve(process.env.AUTOMATION_RECOVERY_STATE_DIR || DEFAULT_STATE_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function now(): string {
  return new Date().toISOString();
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function runtime(args: string[]): { ok: boolean; out: Record<string, any>; code: string | null } {
  const result = spawnSync(process.execPath, [RUNTIME, ...args], { encoding: "utf8", env: { ...process.env } });
  if (result.status === 0) return { ok: true, out: JSON.parse(result.stdout), code: null };
  let code: string | null = null;
  try {
    code = JSON.parse(result.stderr).error ?? null;
  } catch {
    code = result.stderr.trim() || "UNKNOWN";
  }
  return { ok: false, out: {}, code };
}

function verifier(args: string[]): Verdict {
  const fixture = process.env.AUTOMATION_RECOVERY_VERIFIER_FIXTURE;
  if (fixture) {
    const table = JSON.parse(readFileSync(fixture, "utf8")) as Record<string, Verdict>;
    const key = args.join(" ");
    const hit = Object.entries(table).find(([pattern]) => key.includes(pattern));
    if (!hit) return { verifier: "fixture", outcome: "ambiguous", evidence: `no fixture for ${key}`, observed_at: now(), details: {} };
    return hit[1];
  }
  const result = spawnSync("python3", [VERIFIERS, ...args], { encoding: "utf8", env: { ...process.env } });
  if (result.status !== 0) {
    return { verifier: args[0], outcome: "ambiguous", evidence: `verifier failed: ${result.stderr.trim().slice(0, 300)}`, observed_at: now(), details: {} };
  }
  return JSON.parse(result.stdout) as Verdict;
}

function listRuns(): RunView[] {
  const root = rootPath();
  if (!existsSync(root)) return [];
  const views: RunView[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!existsSync(join(root, entry.name, "latest.json"))) continue;
    const status = runtime(["status", "--automation-id", entry.name]);
    if (!status.ok || !status.out.exists) continue;
    views.push(status.out as RunView);
  }
  return views;
}

function incomplete(views: RunView[]): RunView[] {
  return views.filter((view) => view.recovery.classification !== "terminal");
}

function logDecision(decision: Decision): void {
  appendFileSync(join(stateDir(), "decisions.jsonl"), `${JSON.stringify(decision)}\n`);
}

function escalate(view: RunView, reason: string, verdict?: Verdict): boolean {
  const path = join(stateDir(), "escalations.jsonl");
  const digest = createHash("sha256").update(`${view.automation_id}:${view.run_id}:${view.recovery.classification}:${reason}`).digest("hex");
  if (existsSync(path)) {
    const seen = readFileSync(path, "utf8").split("\n").filter(Boolean).some((line) => JSON.parse(line).digest === digest);
    if (seen) return false;
  }
  appendFileSync(path, `${JSON.stringify({ at: now(), digest, automation_id: view.automation_id, run_id: view.run_id, classification: view.recovery.classification, reason, verdict: verdict ?? null, next_action: view.recovery.next_action })}\n`);
  return true;
}

function reconcileSideEffect(view: RunView, verdict: Verdict, apply: boolean): Decision {
  const base = { at: now(), automation_id: view.automation_id, run_id: view.run_id, classification: view.recovery.classification, verdict };
  const key = view.pending_side_effect!.key;
  if (verdict.outcome === "ambiguous") {
    if (!apply) return { ...base, action: "would_escalate", detail: verdict.evidence };
    const already = view.recovery.last_adjudication?.outcome === "ambiguous";
    const fresh = escalate(view, verdict.evidence, verdict);
    return { ...base, action: already ? "escalation_repeated" : fresh ? "escalated" : "escalation_deduplicated", detail: verdict.evidence };
  }
  if (!apply) return { ...base, action: "would_adjudicate", detail: `${verdict.outcome}: ${verdict.evidence}` };
  const begin = runtime(["reconcile-begin", "--automation-id", view.automation_id, "--expected-revision", String(view.revision), "--owner", OWNER]);
  if (!begin.ok) return { ...base, action: "skipped", detail: `reconcile-begin refused: ${begin.code}` };
  const token = String(begin.out.reconcile_token);
  const adjudicate = runtime([
    "side-effect-adjudicate", "--automation-id", view.automation_id, "--reconcile-token", token,
    "--key", key, "--outcome", verdict.outcome, "--evidence", verdict.evidence, "--verifier", verdict.verifier,
  ]);
  const release = runtime(["reconcile-release", "--automation-id", view.automation_id, "--reconcile-token", token]);
  if (!adjudicate.ok || !release.ok) {
    escalate(view, `automatic adjudication failed: ${adjudicate.code ?? release.code}`, verdict);
    return { ...base, action: "adjudication_failed", detail: `${adjudicate.code ?? ""} ${release.code ?? ""}`.trim() };
  }
  return { ...base, action: "adjudicated_and_released", detail: `${verdict.outcome}: ${verdict.evidence}` };
}

function sweep(apply: boolean): { observed_at: string; scanned: number; incomplete: number; decisions: Decision[] } {
  const views = listRuns();
  const decisions: Decision[] = [];
  for (const view of incomplete(views)) {
    const classification = view.recovery.classification;
    let decision: Decision;
    if (classification === "side_effect_uncertain" || classification === "side_effect_ambiguous_escalated") {
      const pending = view.pending_side_effect!;
      const verification = pending.verification;
      if (verification?.kind === "email" && verification.subject) {
        const verdict = verifier(["email", "--subject", verification.subject, "--after", pending.recorded_at, "--run-id", view.run_id]);
        decision = reconcileSideEffect(view, verdict, apply);
      } else {
        const fresh = apply ? escalate(view, `side effect ${pending.key} has no automatic verifier; adjudicate manually`) : null;
        decision = { at: now(), automation_id: view.automation_id, run_id: view.run_id, classification, action: fresh === null ? "would_escalate" : fresh ? "escalated" : "escalation_deduplicated", detail: `no verifier for ${pending.key}` };
      }
    } else if (classification === "worker_ambiguous") {
      const verdict = verifier(["worker", "--automation-id", view.automation_id]);
      const fresh = apply ? escalate(view, verdict.evidence, verdict) : null;
      decision = { at: now(), automation_id: view.automation_id, run_id: view.run_id, classification, action: fresh === null ? "would_escalate" : fresh ? "escalated" : "escalation_deduplicated", detail: verdict.evidence, verdict };
    } else if (classification === "worker_running" || classification === "in_progress_live") {
      decision = { at: now(), automation_id: view.automation_id, run_id: view.run_id, classification, action: "observed", detail: "owner or worker may still be live" };
    } else {
      decision = { at: now(), automation_id: view.automation_id, run_id: view.run_id, classification, action: "awaiting_next_occurrence", detail: view.recovery.next_action };
    }
    logDecision(decision);
    decisions.push(decision);
  }
  return { observed_at: now(), scanned: views.length, incomplete: decisions.length, decisions };
}

function arizona(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Phoenix", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function report(): { path: string; incomplete: number } {
  const views = listRuns();
  const open = incomplete(views);
  const lines = [
    "# Automation recovery queue",
    "",
    `Observed ${arizona(now())} Arizona. Latest run states: ${views.length}. Incomplete: ${open.length}.`,
    "",
    "| Automation | Run | Classification | Age | Attempts | Last evidence | Next action |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const view of open) {
    const age = `${Math.round(view.recovery.age_seconds / 3600)}h`;
    const evidence = view.recovery.last_adjudication ? `${view.recovery.last_adjudication.outcome}: ${view.recovery.last_adjudication.evidence.slice(0, 120)}` : "none";
    lines.push(`| ${view.automation_id.slice(0, 8)} | ${view.run_id.slice(0, 8)} | ${view.recovery.classification} | ${age} | ${view.recovery.attempts} | ${evidence.replace(/\|/g, "/")} | ${view.recovery.next_action} |`);
  }
  if (open.length === 0) lines.push("| none | | | | | | |");
  const escalations = join(stateDir(), "escalations.jsonl");
  const count = existsSync(escalations) ? readFileSync(escalations, "utf8").split("\n").filter(Boolean).length : 0;
  lines.push("", `Escalations recorded: ${count} (${escalations}).`, "");
  const path = process.env.AUTOMATION_RECOVERY_REPORT || DEFAULT_REPORT;
  atomicWrite(path, `${lines.join("\n")}\n`);
  return { path, incomplete: open.length };
}

function hostBoot(): { boot_id: string; boot_time: number } | null {
  const path = process.env.HOST_RESILIENCE_STATE_DIR ? join(process.env.HOST_RESILIENCE_STATE_DIR, "state.json") : DEFAULT_HOST_STATE;
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { boot_id: String(parsed.boot_id), boot_time: Number(parsed.boot_time) };
  } catch {
    return null;
  }
}

function heartbeat(payload: Record<string, unknown>): void {
  atomicWrite(join(stateDir(), "controller-last-sweep.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

async function serve(intervalSeconds: number): Promise<void> {
  const seenPath = join(stateDir(), "last-boot.json");
  let seenBoot = existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, "utf8")).boot_id : null;
  let lastSweep = 0;
  for (;;) {
    const boot = hostBoot();
    const nowEpoch = Date.now() / 1000;
    const bootAge = boot ? nowEpoch - boot.boot_time : Number.POSITIVE_INFINITY;
    const restartPending = boot !== null && boot.boot_id !== seenBoot;
    const due = nowEpoch - lastSweep >= intervalSeconds;
    let trigger: string | null = null;
    if (restartPending && bootAge >= WARMUP_SECONDS) trigger = "host_restart";
    else if (!restartPending && due) trigger = "interval";
    if (trigger) {
      try {
        const result = sweep(true);
        const written = report();
        const payload = { event: "automation_recovery.sweep", trigger, boot_id: boot?.boot_id ?? null, ...result, report: written.path };
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        heartbeat(payload);
        lastSweep = nowEpoch;
        if (restartPending && boot) {
          atomicWrite(seenPath, `${JSON.stringify({ boot_id: boot.boot_id, seen_at: now() })}\n`);
          seenBoot = boot.boot_id;
        }
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ event: "automation_recovery.sweep_error", ts: now(), message: String(error instanceof Error ? error.message : error) })}\n`);
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 30_000));
  }
}

function help(): string {
  return [
    "recovery-controller commands:",
    "  scan                      list incomplete runs with classification, age, attempts, evidence, next action",
    "  sweep [--apply]           verify incomplete runs; with --apply adjudicate from verifier evidence, else report only",
    "  report                    write the operator recovery queue markdown",
    "  serve [--interval 900]    sweep after each host restart (post-warmup) and on the interval",
    "State: $AUTOMATION_RECOVERY_STATE_DIR (default /home/.z/automation-recovery)",
  ].join("\n");
}

async function main(): Promise<void> {
  const [, , command = "help", ...args] = process.argv;
  switch (command) {
    case "scan": {
      const views = incomplete(listRuns());
      process.stdout.write(`${JSON.stringify({ observed_at: now(), incomplete: views.map((view) => ({ automation_id: view.automation_id, run_id: view.run_id, status: view.status, ...view.recovery })) })}\n`);
      return;
    }
    case "sweep":
      process.stdout.write(`${JSON.stringify(sweep(args.includes("--apply")))}\n`);
      return;
    case "report":
      process.stdout.write(`${JSON.stringify(report())}\n`);
      return;
    case "serve":
      await serve(Number(option(args, "interval") ?? 900));
      return;
    case "help":
      process.stdout.write(`${help()}\n`);
      return;
    default:
      process.stderr.write(`${JSON.stringify({ error: "UNKNOWN_COMMAND", message: command })}\n`);
      process.exit(2);
  }
}

await main();
