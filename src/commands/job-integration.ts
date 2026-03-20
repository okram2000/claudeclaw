/**
 * Job system integration with claude-mem
 *
 * After each job completes, records the result as an observation in
 * claude-mem. Jobs can optionally specify `memoryProject` to scope
 * their observations to a specific project.
 *
 * Usage:
 *   import { recordJobResult, withMemoryTracking } from "./commands/job-integration";
 *
 *   // Manual recording
 *   await recordJobResult(jobName, result, { memoryProject: "my-project" });
 *
 *   // Wrapper for job functions
 *   const trackedJob = withMemoryTracking(myJobFn, { memoryProject: "my-project" });
 *   await trackedJob();
 */

import {
  isWorkerRunning,
  recordObservation,
} from "../claude-mem-integration";

export interface JobRecordOptions {
  /** Scope observations to a specific project (default: "claudeclaw") */
  memoryProject?: string;
  /** Additional facts to record alongside the result */
  extraFacts?: string[];
}

/**
 * Record a completed job's result as a claude-mem observation.
 * No-op if the worker is unavailable.
 */
export async function recordJobResult(
  jobName: string,
  result: string,
  options: JobRecordOptions = {},
): Promise<boolean> {
  const { memoryProject = "claudeclaw", extraFacts = [] } = options;

  const workerUp = await isWorkerRunning();
  if (!workerUp) {
    console.log(`[job] claude-mem unavailable, skipping observation for "${jobName}"`);
    return false;
  }

  try {
    const truncated = result.length > 500 ? result.slice(0, 497) + "..." : result;
    const facts = [
      `job: ${jobName}`,
      `completed_at: ${new Date().toISOString()}`,
      `result_length: ${result.length}`,
      ...extraFacts,
    ];

    await recordObservation(
      `Job completed: ${jobName}`,
      truncated,
      facts,
      memoryProject,
    );

    console.log(`[job] Recorded observation for "${jobName}" in project "${memoryProject}"`);
    return true;
  } catch (err: any) {
    console.warn(`[job] Failed to record observation for "${jobName}": ${err.message}`);
    return false;
  }
}

/**
 * Wraps a job function to automatically record its result in claude-mem.
 *
 * The wrapped function runs the original job and records the stringified
 * return value as an observation. If the job throws, the error is recorded
 * and re-thrown.
 */
export function withMemoryTracking<T>(
  jobFn: () => Promise<T>,
  jobName: string,
  options: JobRecordOptions = {},
): () => Promise<T> {
  return async () => {
    let result: T;
    try {
      result = await jobFn();
    } catch (err: any) {
      // Record the failure, then re-throw
      await recordJobResult(jobName, `FAILED: ${err.message ?? err}`, {
        ...options,
        extraFacts: [...(options.extraFacts ?? []), "status: failed"],
      });
      throw err;
    }

    const resultStr =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    await recordJobResult(jobName, resultStr, {
      ...options,
      extraFacts: [...(options.extraFacts ?? []), "status: success"],
    });

    return result;
  };
}
