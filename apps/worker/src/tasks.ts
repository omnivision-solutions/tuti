import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { codeChangesSettings, type JobKey, jobs } from "@tuti/shared";

/** A job's definition, as `jobs` (in @tuti/shared) declares them. */
type Job = { name: string; cron?: string; retries?: number; backoff?: { factor: number; maxSeconds: number }; concurrencyKey?: string };

/** How long a queued code change may wait for its turn before Hatchet gives up on it (its default is 5 minutes). */
const CODE_CHANGE_QUEUE = "24h" as const;

/** How long one page of an import may take (Hatchet's default is 60 seconds): Featurebase's rate limit can hold it up. */
const IMPORT_STEP_TIMEOUT = "5m" as const;

/** A job's Hatchet task options, but its input and function. */
export function taskOptions(key: JobKey, job: Job = jobs[key]) {
  // Queued behind the run with the same key, not cancelling it (Hatchet's default).
  const own = job.concurrencyKey && { expression: job.concurrencyKey, maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN };
  const { limits } = codeChangesSettings();
  return {
    name: job.name,
    retries: job.retries ?? 3,
    ...(job.backoff && { backoff: job.backoff }),
    ...(job.cron && { on: { cron: job.cron } }),
    ...(key === "codeChange"
      ? {
          // Hatchet ends a task after 60 seconds by default: an analysis (the docs agent) has its own time limit, and a
          // few minutes past it to save what it found. A few at once on the whole server (`limits.concurrentAnalyses`),
          // retries included: each holds a worker slot that long and the repository in memory, and the worker's other
          // jobs need their slots. The rest wait their turn, up to a day, rather than Hatchet's 5 minutes.
          executionTimeout: `${limits.timeoutMinutes + 5}m` as const,
          scheduleTimeout: CODE_CHANGE_QUEUE,
          concurrency: [
            ...(own ? [own] : []),
            { expression: "'code-change'", maxRuns: limits.concurrentAnalyses, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN },
          ],
        }
      : own && { concurrency: own }),
    ...(key === "importStep" && { executionTimeout: IMPORT_STEP_TIMEOUT }),
  };
}
