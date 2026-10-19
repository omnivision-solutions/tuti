import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { handlers } from "@tuti/jobs";
import { assertEnv, jobs, type JobKey } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

// HATCHET_CLIENT_TOKEN is checked by the Hatchet client itself when tasks are declared.
assertEnv(["DATABASE_URL", "PORTAL_URL_TEMPLATE"]);

const hatchet = getHatchet();
const tasks = (Object.keys(jobs) as JobKey[]).map((key) => {
  const job: {
    name: string;
    input: (typeof jobs)[JobKey]["input"];
    cron?: string;
    retries?: number;
    backoff?: { factor: number; maxSeconds: number };
    concurrencyKey?: string;
  } = jobs[key];
  return hatchet.task({
    name: job.name,
    inputValidator: job.input,
    retries: job.retries ?? 3,
    ...(job.backoff && { backoff: job.backoff }),
    ...(job.cron && { on: { cron: job.cron } }),
    // Queued behind the run with the same key, not cancelling it (Hatchet's default).
    ...(job.concurrencyKey && {
      concurrency: { expression: job.concurrencyKey, maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN },
    }),
    fn: (input, ctx) => handlers[key](input as never, ctx.logger),
  });
});

const worker = await hatchet.worker("tuti-worker", { workflows: tasks, slots: 20 });

await worker.start();
