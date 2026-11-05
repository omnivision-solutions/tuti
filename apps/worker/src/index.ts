import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { codeChange, handlers } from "@tuti/jobs";
import { assertEnv, checkCodeChangesSettings, codeChangesSettings, jobs, log, type JobKey } from "@tuti/shared";
import { getHatchet, withRunLogs } from "@tuti/shared/hatchet";
import { assertSesSettings } from "@tuti/shared/ses";

import { waitForMigration } from "./migrations";
import { receiverFromEnv, startSmtpReceiver } from "./smtp-receiver";

// HATCHET_CLIENT_TOKEN is checked by the Hatchet client itself when tasks are declared.
assertEnv(["DATABASE_URL", "PORTAL_URL_TEMPLATE"]);
assertSesSettings();
checkCodeChangesSettings();

// Set in builds (tsup.config.ts); when run from source, the developer migrates.
if (process.env.TUTI_SCHEMA_MIGRATION) {
  await waitForMigration(process.env.TUTI_SCHEMA_MIGRATION);
}

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
    // Hatchet ends a task after 60 seconds by default: a code change's analysis (the docs agent) has its own time limit,
    // and a few minutes past it to save what it found.
    ...(key === "codeChange" && { executionTimeout: `${codeChangesSettings().limits.timeoutMinutes + 5}m` }),
    // Queued behind the run with the same key, not cancelling it (Hatchet's default).
    ...(job.concurrencyKey && {
      concurrency: { expression: job.concurrencyKey, maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN },
    }),
    // `log` rather than ctx.logger: withRunLogs sends it, and any console output, to this run's logs.
    // A code change's run is told whether it's the last try: until then a failure leaves it analysing (it's retried).
    fn: withRunLogs((input, ctx) =>
      key === "codeChange" ? codeChange(input as never, log, { lastTry: ctx.retryCount() >= (job.retries ?? 3) }) : handlers[key](input as never, log),
    ),
  });
});

const worker = await hatchet.worker("tuti-worker", { workflows: tasks, slots: 20 });

// A self-hosted server's own receiver for the support domain's mail (off without INBOUND_SMTP_PORT).
const receiver = receiverFromEnv();
if (receiver) {
  await startSmtpReceiver(receiver);
  log.info("Receiving the support domain's mail over SMTP", { port: receiver.port, tls: Boolean(receiver.tls) });
}

await worker.start();
