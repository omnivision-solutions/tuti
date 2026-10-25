import { jobs, log, type JobInput, type JobKey } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

import { articleChanged, purgeArticles } from "./articles";
import { cleanupMedia, releaseMedia } from "./cleanup";
import { pruneDocsSearches } from "./docs-searches";
import { codeChange } from "./code-changes";
import { githubPullRequest, githubRelease } from "./github";
import { imageUploaded } from "./images";
import { postCreated } from "./post-created";
import { postShipped, resubmitShippedEmails } from "./shipped";
import { resubmitWebhookDeliveries, webhookDelivery } from "./webhooks";

export { signWebhook } from "./webhooks";
export { aiFor, projectModels } from "./ai-usage";
export { aiPaused, creditBalance, type CreditGrant, emailIfCreditsLow, grantCredits, OutOfCredits } from "./credits";
export { confidence, THRESHOLDS } from "./code-change-decisions";
export { addToRunningDraft, lockProject, RUNNING_DRAFT_TITLE, setChangelogLine } from "./running-draft";

export { articleChanged, DELETED_ARTICLE_DAYS, embedPublishedArticles } from "./articles";
export { FAILED_SEARCHES_PER_DAY, INSIGHTS_DAYS } from "./docs-searches";
export { detectDuplicates, embedPosts } from "./duplicates";
export { forgetRepositories, type GithubRepo, includeRepositories, inInstallation, installationRepositories, syncRepositories, listedRepositories, repositoryConnection } from "./github-repositories";
export { liveDomain, portalAddress, type PortalAddress, projectWith } from "./portal-address";
export { fetchSiteCheck } from "./site-check";
export { emitEvent, portalPostUrl, postStatusChanged, queueDeliveries, recordEvent, postSummary, postSummarySelect, toApiStatus, type PostRow } from "./events";

export type JobLogger = { info(message: string): void; warn(message: string): void };

/** Results are small JSON summaries, shown in Hatchet's dashboard. */
export type JobResult = Record<string, string | number | boolean>;

/** What each background job does. The worker runs these on Hatchet; `JOBS_DRIVER=inline` runs them in-process. */
export const handlers: { [K in JobKey]: (input: JobInput<K>, log: JobLogger) => Promise<JobResult> } = {
  postCreated,
  articleChanged,
  imageUploaded,
  cleanupMedia,
  releaseMedia,
  purgeArticles,
  pruneDocsSearches,
  webhookDelivery,
  resubmitWebhookDeliveries,
  githubPullRequest,
  githubRelease,
  codeChange,
  postShipped,
  resubmitShippedEmails,
};

/**
 * Start a background job. With `JOBS_DRIVER=inline` the job runs right here,
 * before this returns, with no retries: for tests and small self-hosted
 * installs without Hatchet; it returns the job's result. Otherwise it's queued
 * on Hatchet for the worker, and there's no result yet (undefined).
 */
export async function enqueue<K extends JobKey>(key: K, input: JobInput<K>): Promise<JobResult | undefined> {
  const job = jobs[key];
  const parsed = job.input.parse(input) as JobInput<K>;
  if (process.env.JOBS_DRIVER === "inline") {
    // ponytail: no `concurrencyKey` here, so overlapping runs of one key can race; use Hatchet if that matters.
    return handlers[key](parsed, log);
  }
  await getHatchet().runNoWait(job.name, parsed);
  return undefined;
}
