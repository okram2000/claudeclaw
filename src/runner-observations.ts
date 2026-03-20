/**
 * Runner observation integration for ClaudeClaw
 *
 * Hooks into the daemon lifecycle to record observations after each
 * run() call completes. Designed to be called fire-and-forget from
 * the main loop — never blocks, never throws.
 *
 * Usage in start.ts (or wherever run() results are handled):
 *
 *   import { observeRunResult } from "../src/runner-observations";
 *
 *   // After heartbeat
 *   run("heartbeat", prompt).then(r => {
 *     observeRunResult("heartbeat", "Heartbeat", r);
 *   });
 *
 *   // After job
 *   run(job.name, prompt).then(r => {
 *     observeRunResult("job", `Job: ${job.name}`, r);
 *   });
 *
 *   // After interactive message
 *   runUserMessage("discord", prompt).then(r => {
 *     observeRunResult("message", "Discord message", r);
 *   });
 */

import { recordAsync, type ObservationType } from "./observations";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Record a completed run() as an observation. Fire-and-forget.
 */
export function observeRunResult(
  type: ObservationType,
  title: string,
  result: RunResult,
  extra?: Record<string, unknown>,
): void {
  const success = result.exitCode === 0;
  const output = result.stdout.trim();

  // Skip recording silent heartbeats (HEARTBEAT_OK)
  if (type === "heartbeat" && output.startsWith("HEARTBEAT_OK")) {
    return;
  }

  // Truncate long output for the summary
  const summary = output.length > 500
    ? output.slice(0, 497) + "..."
    : output || (success ? "(completed)" : `exit ${result.exitCode}`);

  const metadata: Record<string, unknown> = {
    exitCode: result.exitCode,
    outputLength: output.length,
    ...extra,
  };

  if (!success && result.stderr) {
    metadata.stderr = result.stderr.slice(0, 300);
  }

  recordAsync(
    success ? type : "error",
    success ? title : `FAILED: ${title}`,
    summary,
    metadata,
  );
}

/**
 * Record a heartbeat result.
 */
export function observeHeartbeat(result: RunResult): void {
  observeRunResult("heartbeat", "Heartbeat", result);
}

/**
 * Record a job result.
 */
export function observeJob(jobName: string, result: RunResult): void {
  observeRunResult("job", `Job: ${jobName}`, result, { jobName });
}

/**
 * Record an interactive message result (Discord, Telegram, etc).
 */
export function observeMessage(
  source: string,
  result: RunResult,
  userId?: string | number,
): void {
  observeRunResult("message", `${source} message`, result, {
    source,
    ...(userId != null ? { userId: String(userId) } : {}),
  });
}

/**
 * Record a system event (startup, shutdown, config change, etc).
 */
export function observeSystem(title: string, summary: string): void {
  recordAsync("system", title, summary);
}
