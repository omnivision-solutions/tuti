import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { codeChange, handlers, importStep, translateArticle, translateChangelogEntry, translateMessage } from "@tuti/jobs";
import { codeChangesSettings, type JobInput, type JobKey, jobs, log } from "@tuti/shared";

/** A job's definition, as `jobs` (in @tuti/shared) declares them. */
type Job = { name: string; cron?: string; retries?: number; backoff?: { factor: number; maxSeconds: number }; concurrencyKey?: string };

/** Article translations at once on the whole server: each is a few model requests, and the worker's other jobs need slots. */
const TRANSLATE_RUNS = 4;

/**
 * The team's email and push about a customer's message, each at once on the whole server: one may wait in its slot for
 * the message's translation (@tuti/jobs noticeText, up to 10 seconds), which needs a slot of its own; capped, a burst of
 * messages can't fill the worker with waiting notices and hold back the translations they wait for. The rest wait their turn.
 */
const NOTICE_RUNS = 4;
/**
 * How long a capped notice may wait its turn before Hatchet drops it (its default is 5 minutes, which a burst can pass):
 * an email is still news within the hour (and conversation-notices-resubmit finds one dropped); a push is for now.
 */
const NOTICE_QUEUE = { conversationMessage: "1h", conversationPush: "15m" } as const;

/** How long a queued code change may wait for its turn before Hatchet gives up on it (its default is 5 minutes). */
const CODE_CHANGE_QUEUE = "24h" as const;

/**
 * How long an import's run may take (Hatchet's default is 60 seconds): it goes from page to page for 10 minutes
 * (@tuti/jobs IMPORT_RUN), and its last page may take 3 to read (the source's rate limit can hold it up) and, at
 * worst, 3 tries of a minute each to save (imports.ts `locked`): 20 minutes leaves room for both.
 */
const IMPORT_STEP_TIMEOUT = "20m" as const;
/**
 * Imports' runs at once on the whole server: each holds a worker slot for its ten minutes, and the worker's other jobs
 * (emails, webhooks) need theirs. The rest wait their turn, up to an hour rather than Hatchet's 5 minutes; one Hatchet
 * gives up on is queued again when the import is found stuck.
 */
const IMPORT_RUNS = 10;
const IMPORT_QUEUE = "1h" as const;

/**
 * How long indexing an API reference may take (Hatchet's default is 60 seconds): a spec of thousands of operations is
 * embedded a hundred at a time, and each description read through the converter, before its one write.
 */
const API_REFERENCE_INDEX_TIMEOUT = "10m" as const;

/**
 * How long a screenshot run may take: two tries of the agent, 15 minutes each at most (@tuti/jobs screenshots.ts), and
 * keeping its images. A few at once on the whole server: each holds a worker slot that long, and the rest wait their
 * turn up to an hour (SCREENSHOT_QUEUE_MS: a run still queued after it is settled as failed).
 */
const SCREENSHOT_RUN_TIMEOUT = "40m" as const;
const SCREENSHOT_RUNS = 3;
const SCREENSHOT_QUEUE = "1h" as const;

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
    ...(key === "importStep" && {
      executionTimeout: IMPORT_STEP_TIMEOUT,
      scheduleTimeout: IMPORT_QUEUE,
      concurrency: [...(own ? [own] : []), { expression: "'import-step'", maxRuns: IMPORT_RUNS, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN }],
    }),
    // A long article is several requests of up to a minute each, and one more round for segments that failed their
    // checks (Hatchet's default is 60 seconds); a whole language queued at once waits its turn rather than being dropped.
    // A few at once on the whole server, so one project's language (hundreds of pages) never takes every worker slot.
    // A changelog entry's the same, in the same server-wide group: they share the translation provider and the slots.
    ...((key === "translateArticle" || key === "translateChangelogEntry") && {
      executionTimeout: "10m" as const,
      scheduleTimeout: "24h" as const,
      concurrency: [...(own ? [own] : []), { expression: "'translate-article'", maxRuns: TRANSLATE_RUNS, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN }],
    }),
    ...((key === "conversationMessage" || key === "conversationPush") && {
      scheduleTimeout: NOTICE_QUEUE[key],
      concurrency: [...(own ? [own] : []), { expression: `'${job.name}'`, maxRuns: NOTICE_RUNS, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN }],
    }),
    // No read starts after 8 minutes (SYNC_BUDGET_MS), and each has 15 seconds.
    ...(key === "syncApiReferences" && { executionTimeout: "10m" as const }),
    ...(key === "apiReferenceChanged" && { executionTimeout: API_REFERENCE_INDEX_TIMEOUT }),
    ...(key === "screenshotRun" && {
      executionTimeout: SCREENSHOT_RUN_TIMEOUT,
      scheduleTimeout: SCREENSHOT_QUEUE,
      concurrency: [{ expression: "'screenshot-run'", maxRuns: SCREENSHOT_RUNS, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN }],
    }),
  };
}

/** What a task's function is told of its run by Hatchet's context. */
type Run = { retryCount: () => number; cancelled: boolean };

/**
 * A job's function, as its Hatchet task runs it. A code change's run is told whether it's the last try: until then a
 * failure leaves it analysing (it's retried). An import's run stops going from page to page (it queues the next run)
 * once the worker is stopping, or Hatchet has given up on the run.
 */
export function taskFn(key: JobKey, retries: number, stopping: () => boolean) {
  return (input: unknown, ctx: Run) =>
    key === "codeChange"
      ? codeChange(input as JobInput<"codeChange">, log, { lastTry: ctx.retryCount() >= retries })
      : key === "translateMessage"
        ? translateMessage(input as JobInput<"translateMessage">, log, { lastTry: ctx.retryCount() >= retries })
        : key === "translateArticle"
          ? translateArticle(input as JobInput<"translateArticle">, log, { lastTry: ctx.retryCount() >= retries })
          : key === "translateChangelogEntry"
            ? translateChangelogEntry(input as JobInput<"translateChangelogEntry">, log, { lastTry: ctx.retryCount() >= retries })
        : key === "importStep"
        ? importStep(input as JobInput<"importStep">, log, () => stopping() || ctx.cancelled)
        : handlers[key](input as never, log);
}

/**
 * Whether the worker has been asked to stop (a deploy's SIGTERM, Ctrl-C): Hatchet's worker then waits for its runs to
 * end. Listened for once Hatchet's worker has its own listeners (they're what exits): alone, these would keep the
 * process from stopping.
 */
export function stopSignal(on: Pick<NodeJS.Process, "once"> = process) {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    on.once(signal, () => (stopping = true));
  }
  return () => stopping;
}
