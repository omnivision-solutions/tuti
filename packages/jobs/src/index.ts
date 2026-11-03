import { jobs, log, type JobInput, type JobKey } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

import { articleChanged, purgeArticles } from "./articles";
import { changelogEmailed, resubmitChangelogEmails } from "./changelog-email";
export { changelogReach, type ChangelogReach, reached, subscriberCount, subscribersLeft } from "./changelog-email";
import { cleanupMedia, releaseMedia } from "./cleanup";
import { pruneDocsSearches } from "./docs-searches";
import { checkEmailDomains } from "./email-domains";
import { tellEmailPauses } from "./email-pause";
import { codeChange } from "./code-changes";
import { verifyArticle } from "./verify";
import { conversationMessage, pruneInboundEmails, resubmitConversationNotices, sendConversationReplies, wakeConversations } from "./conversations";
export { replyRecipient, type ReplyRecipient } from "./conversations";
import { githubPullRequest, githubRelease } from "./github";
import { imageUploaded } from "./images";
import { postCreated } from "./post-created";
import { replyEmailed, resubmitReplyEmails } from "./reply-email";
import { postShipped, resubmitShippedEmails } from "./shipped";
import { resubmitWebhookDeliveries, webhookDelivery } from "./webhooks";

export { UNUSED_UPLOAD_HOURS } from "./cleanup";
export { signWebhook } from "./webhooks";
export { sesTenantHeaders } from "./ses-tenant";
export { mailSubdomain } from "./mail-subdomain";
export { projectEmailWaits, projectSender } from "./project-sender";
export { audienceReach, postAudience, provenAddress, type Reach } from "./post-audience";
export { lastingMediaUrl, lastingMediaUrls } from "./lasting-media";
export { resumePause, resumeToken, tellPaused } from "./email-pause";
export { cappedProjects, claimProjectEmail, NEW_PROJECT_EMAILS_PER_DAY, pauseIfOverLimits, pausing } from "./email-limits";
export { checkEmailDomain, dropEmailDomain, forgetIdentity, UNVERIFIED_FOR_MS, withEmailDomainLocks } from "./email-domains";
export { aiFor, projectModels } from "./ai-usage";
export { aiPaused, creditBalance, type CreditGrant, emailIfCreditsLow, grantCredits, OutOfCredits, takeBackCredits } from "./credits";
export { confidence, THRESHOLDS } from "./code-change-decisions";
export { analysisOn, writeChangelogLine } from "./code-changes";
export { continueVerifyAll, NO_AI, RUN_STALE_MS, settleStale, verifyAllsSettled, WAITING_FIX, NO_REPOSITORY, type Statement, type Verdict, VERIFY_OFF } from "./verify";
export { addToRunningDraft, changelogLineOf, closeRunningDraft, lockProject, onlyPullRequestTitles, RUNNING_DRAFT_TITLE, setChangelogLine, undoChangelogLine } from "./running-draft";
import { autopilotDue } from "./autopilot";
export { emailedAbout, queueAutopilotNotices, sendAutopilotDigests, sendAutopilotEmails, tellOwners } from "./autopilot-email";
export { type AutopilotButton, readAutopilotButton, signAutopilotButton } from "./autopilot";
export { autopilotDue, autopilotDueToken, type AutopilotSettings, articlesViews, autopilotSettingsSelect, composeComment, dueAt, inReview, POST_COMMENT_MAX, POST_UPDATE, postReach, VERIFY_WAITS, postsReach, postUpdate, postVersion, reviewPath, recentViews, scheduleByItself, schedulePost, tooLong, waitsBecause } from "./autopilot";
export { ARTICLE_REVISIONS_KEPT, docOf, editName, hasTeammateEdit, landEdit, LIVE_EDIT, newestRevision, pruneRevisions, sameDoc, scheduleArticle, settleWaitingEdits, takeOut, type TaggedEdit, taggedEdits, WAITING_EDIT, dismissTakenOut, editsInChanges, keepsEdit, mergeSections, newestText, changedSections, withSectionsOf } from "./article-layers";

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
  conversationMessage,
  pruneInboundEmails,
  checkEmailDomains,
  tellEmailPauses,
  sendConversationReplies,
  wakeConversations,
  resubmitConversationNotices,
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
  verifyArticle,
  verifyAllArticle: verifyArticle,
  postShipped,
  resubmitShippedEmails,
  replyEmailed,
  resubmitReplyEmails,
  changelogEmailed,
  resubmitChangelogEmails,
  autopilotDue: () => autopilotDue(),
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
