import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(here, "automation-resilience.ts");
const controller = resolve(here, "recovery-controller.ts");
const root = mkdtempSync(join(tmpdir(), "recovery-controller-test-"));
const stateDir = join(root, "controller-state");
const fixture = join(root, "verifier-fixture.json");
const reportPath = join(root, "queue.md");
const env = {
  ...process.env,
  AUTOMATION_RESILIENCE_ROOT: join(root, "runs"),
  AUTOMATION_RECOVERY_STATE_DIR: stateDir,
  AUTOMATION_RECOVERY_VERIFIER_FIXTURE: fixture,
  AUTOMATION_RECOVERY_REPORT: reportPath,
};

function run(script: string, args: string[], expected = 0): Record<string, any> {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  if (result.status !== expected) {
    throw new Error(`Expected ${expected}, got ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function lines(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

try {
  writeFileSync(fixture, JSON.stringify({
    "--subject Weekly Digest": { verifier: "email", outcome: "applied", evidence: "message m1 delivered", observed_at: "2026-01-01T00:00:00Z", details: {} },
    "--subject Alert Report": { verifier: "email", outcome: "ambiguous", evidence: "mailbox search failed", observed_at: "2026-01-01T00:00:00Z", details: {} },
  }));

  const delivered = run(runtime, ["begin", "--automation-id", "digest", "--checkpoint-seconds", "1", "--handoff-seconds", "2"]);
  run(runtime, [
    "side-effect-intent", "--automation-id", "digest", "--session-token", String(delivered.session_token),
    "--key", "digest-email", "--action", "send digest", "--request-digest", "aa",
    "--verify", JSON.stringify({ kind: "email", subject: "Weekly Digest" }),
  ]);
  const ambiguousRun = run(runtime, ["begin", "--automation-id", "alert", "--checkpoint-seconds", "1", "--handoff-seconds", "2"]);
  run(runtime, [
    "side-effect-intent", "--automation-id", "alert", "--session-token", String(ambiguousRun.session_token),
    "--key", "alert-email", "--action", "send alert", "--request-digest", "bb",
    "--verify", JSON.stringify({ kind: "email", subject: "Alert Report" }),
  ]);
  const manualRun = run(runtime, ["begin", "--automation-id", "manual", "--checkpoint-seconds", "1", "--handoff-seconds", "2"]);
  run(runtime, [
    "side-effect-intent", "--automation-id", "manual", "--session-token", String(manualRun.session_token),
    "--key", "trade-1", "--action", "place trade", "--request-digest", "cc",
  ]);
  const live = run(runtime, ["begin", "--automation-id", "live"]);
  run(runtime, [
    "side-effect-intent", "--automation-id", "live", "--session-token", String(live.session_token),
    "--key", "live-email", "--action", "send digest", "--request-digest", "dd",
    "--verify", JSON.stringify({ kind: "email", subject: "Weekly Digest" }),
  ]);
  const finished = run(runtime, ["begin", "--automation-id", "done"]);
  run(runtime, ["finish", "--automation-id", "done", "--session-token", String(finished.session_token)]);
  Bun.sleepSync(2500);

  const scan = run(controller, ["scan"]);
  check(scan.incomplete.length === 4, `scan should list four incomplete runs, got ${scan.incomplete.length}`);
  check(scan.incomplete.every((entry: any) => entry.classification === "side_effect_uncertain"), "all four classify as side_effect_uncertain");

  const dry = run(controller, ["sweep"]);
  const dryActions = Object.fromEntries(dry.decisions.map((decision: any) => [decision.automation_id, decision.action]));
  check(dryActions.digest === "would_adjudicate", "dry sweep reports the adjudication it would make");
  check(run(runtime, ["status", "--automation-id", "digest"]).pending_side_effect !== null, "dry sweep mutates nothing");

  const first = run(controller, ["sweep", "--apply"]);
  const firstActions = Object.fromEntries(first.decisions.map((decision: any) => [decision.automation_id, decision.action]));
  check(firstActions.digest === "adjudicated_and_released", `stale run with applied evidence is adjudicated, got ${firstActions.digest}`);
  check(firstActions.alert === "escalated", "ambiguous evidence escalates");
  check(firstActions.manual === "escalated", "a side effect without a verifier escalates");
  check(firstActions.live === "skipped", `a live in-budget owner is never displaced, got ${firstActions.live}`);
  const digestState = run(runtime, ["status", "--automation-id", "digest"]);
  check(digestState.pending_side_effect === null && digestState.adjudications.length === 1, "applied evidence resolves the intent once");
  check(digestState.reconciliation.active === false, "controller releases ownership after adjudication");
  check(run(runtime, ["status", "--automation-id", "live"]).pending_side_effect.key === "live-email", "the live run keeps its intent");

  const second = run(controller, ["sweep", "--apply"]);
  const secondActions = Object.fromEntries(second.decisions.map((decision: any) => [decision.automation_id, decision.action]));
  check(secondActions.digest === undefined || secondActions.digest === "awaiting_next_occurrence", `a reconciled run is not re-adjudicated, got ${secondActions.digest}`);
  check(secondActions.alert === "escalation_deduplicated", "repeat ambiguous evidence does not re-escalate");
  check(secondActions.manual === "escalation_deduplicated", "repeat manual escalation is deduplicated");
  check(run(runtime, ["status", "--automation-id", "digest"]).adjudications.length === 1, "second sweep adds no adjudication");
  check(lines(join(stateDir, "escalations.jsonl")).length === 2, "exactly two escalations are recorded across both sweeps");

  const resumed = run(runtime, [
    "begin", "--automation-id", "digest", "--recover", "--expected-revision", String(run(runtime, ["status", "--automation-id", "digest"]).revision),
  ]);
  check(resumed.outcome === "resumed", "the automation's next occurrence resumes the reconciled run");
  check(run(runtime, [
    "side-effect-intent", "--automation-id", "digest", "--session-token", String(resumed.session_token),
    "--key", "digest-email", "--action", "send digest", "--request-digest", "aa",
  ], 0).outcome === "intent_recorded", "an applied key is not blocked from a later distinct occurrence-level intent");

  const written = run(controller, ["report"]);
  check(written.path === reportPath && existsSync(reportPath), "report writes the operator queue");
  const markdown = readFileSync(reportPath, "utf8");
  check(markdown.includes("side_effect_uncertain") && markdown.includes("Escalations recorded: 2"), "report surfaces classification and escalation count");

  process.stdout.write("recovery-controller: all tests passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
