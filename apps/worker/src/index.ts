import { assertEnv, billingConfig, checkAiProvider, checkConfig, jobs, log, type JobKey } from "@tuti/shared";
import { getHatchet, withRunLogs } from "@tuti/shared/hatchet";
import { assertSesSettings } from "@tuti/shared/ses";

import { waitForMigration } from "./migrations";
import { receiverFromEnv, startSmtpReceiver } from "./smtp-receiver";
import { stopSignal, taskFn, taskOptions } from "./tasks";

// HATCHET_CLIENT_TOKEN is checked by the Hatchet client itself when tasks are declared.
assertEnv(["DATABASE_URL", "PORTAL_URL_TEMPLATE"]);
assertSesSettings();
checkConfig();
// An invalid billing file stops start-up, rather than selling the wrong thing.
billingConfig();
// Not awaited: a slow or wrong AI provider is logged, never holds up the start (AI is optional).
void checkAiProvider();

// Set in builds (tsup.config.ts); when run from source, the developer migrates.
if (process.env.TUTI_SCHEMA_MIGRATION) {
  await waitForMigration(process.env.TUTI_SCHEMA_MIGRATION);
}

const hatchet = getHatchet();
// Asked to stop (a deploy): Hatchet's worker waits for its runs, so an import's hands over after the page it's on.
let stopping = () => false;
const tasks = (Object.keys(jobs) as JobKey[]).map((key) => {
  const options = taskOptions(key);
  return hatchet.task({
    ...options,
    inputValidator: jobs[key].input,
    // `log` (taskFn's) rather than ctx.logger: withRunLogs sends it, and any console output, to this run's logs.
    fn: withRunLogs(taskFn(key, options.retries, () => stopping())),
  });
});

const worker = await hatchet.worker("tuti-worker", { workflows: tasks, slots: 20 });
stopping = stopSignal();

// A self-hosted server's own receiver for the support domain's mail (off without INBOUND_SMTP_PORT).
const receiver = receiverFromEnv();
if (receiver) {
  await startSmtpReceiver(receiver);
  log.info("Receiving the support domain's mail over SMTP", { port: receiver.port, tls: Boolean(receiver.tls) });
}

await worker.start();
