import { jobs, log, type JobInput, type JobKey } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

import { cleanupMedia } from "./cleanup";
import { githubPullRequest, githubRelease } from "./github";
import { imageUploaded } from "./images";
import { postCreated } from "./post-created";
import { postShipped } from "./shipped";
import { resubmitWebhookDeliveries, webhookDelivery } from "./webhooks";

export { signWebhook } from "./webhooks";

export { detectDuplicates, embedPosts } from "./duplicates";
export { referencedPosts } from "./github";
export { emitEvent, portalPostUrl, postStatusChanged, postSummary, postSummarySelect, toApiStatus, type PostRow } from "./events";

export type JobLogger = { info(message: string): void; warn(message: string): void };

/** Results are small JSON summaries, shown in Hatchet's dashboard. */
export type JobResult = Record<string, string | number | boolean>;

/** What each background job does. The worker runs these on Hatchet; `JOBS_DRIVER=inline` runs them in-process. */
export const handlers: { [K in JobKey]: (input: JobInput<K>, log: JobLogger) => Promise<JobResult> } = {
  postCreated,
  imageUploaded,
  cleanupMedia,
  webhookDelivery,
  resubmitWebhookDeliveries,
  githubPullRequest,
  githubRelease,
  postShipped,
};

/**
 * Start a background job. With `JOBS_DRIVER=inline` the job runs right here,
 * before this returns, with no retries: for tests and small self-hosted
 * installs without Hatchet. Otherwise it's queued on Hatchet for the worker.
 */
export async function enqueue<K extends JobKey>(key: K, input: JobInput<K>): Promise<void> {
  const job = jobs[key];
  const parsed = job.input.parse(input) as JobInput<K>;
  if (process.env.JOBS_DRIVER === "inline") {
    await handlers[key](parsed, log);
    return;
  }
  await getHatchet().runNoWait(job.name, parsed);
}
