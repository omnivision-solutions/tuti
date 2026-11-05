import { codeChange, handlers } from "@tuti/jobs";
import { assertEnv, checkAiProvider, checkCodeChangesSettings, jobs, log, type JobKey } from "@tuti/shared";
import { getHatchet, withRunLogs } from "@tuti/shared/hatchet";
import { assertSesSettings } from "@tuti/shared/ses";

import { waitForMigration } from "./migrations";
import { receiverFromEnv, startSmtpReceiver } from "./smtp-receiver";
import { taskOptions } from "./tasks";

// HATCHET_CLIENT_TOKEN is checked by the Hatchet client itself when tasks are declared.
assertEnv(["DATABASE_URL", "PORTAL_URL_TEMPLATE"]);
assertSesSettings();
checkCodeChangesSettings();
// Not awaited: a slow or wrong AI provider is logged, never holds up the start (AI is optional).
void checkAiProvider();

// Set in builds (tsup.config.ts); when run from source, the developer migrates.
if (process.env.TUTI_SCHEMA_MIGRATION) {
  await waitForMigration(process.env.TUTI_SCHEMA_MIGRATION);
}

const hatchet = getHatchet();
const tasks = (Object.keys(jobs) as JobKey[]).map((key) => {
  const options = taskOptions(key);
  return hatchet.task({
    ...options,
    inputValidator: jobs[key].input,
    // `log` rather than ctx.logger: withRunLogs sends it, and any console output, to this run's logs.
    // A code change's run is told whether it's the last try: until then a failure leaves it analysing (it's retried).
    fn: withRunLogs((input, ctx) =>
      key === "codeChange" ? codeChange(input as never, log, { lastTry: ctx.retryCount() >= options.retries }) : handlers[key](input as never, log),
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
