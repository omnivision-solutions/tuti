import { jobs, log, type JobInput, type JobKey } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

import { apiReferenceChanged } from "./api-references";
import { articleChanged, purgeArticles } from "./articles";
import { changelogEmailed, resubmitChangelogEmails } from "./changelog-email";
export { changelogReach, type ChangelogReach, reached, subscriberCount, subscribersLeft } from "./changelog-email";
import { cleanupMedia, releaseMedia } from "./cleanup";
import { pruneDocsSearches } from "./docs-searches";
import { deleteOldHistory } from "./history";
import { grantPlanLicenseCredits } from "./plan-licenses";
export { historySince, inSomePlansHistory, pastConversations, visibleConversations, visibleConversationsSql } from "./history";
import { checkEmailDomains } from "./email-domains";
import { tellEmailPauses } from "./email-pause";
import { codeChange, retryCodeChanges } from "./code-changes";
import { verifyArticle } from "./verify";
import { conversationMessage, pruneInboundEmails, resubmitConversationNotices, sendConversationReplies, wakeConversations } from "./conversations";
export { replyRecipient, type ReplyRecipient } from "./conversations";
import { githubPullRequest, githubRelease } from "./github";
import { imageUploaded } from "./images";
import { failStaleImports, importStep } from "./imports";
import { postCreated } from "./post-created";
import { commentEmailsDue, commentsEmailed } from "./comment-email";
import { replyEmailed, resubmitReplyEmails } from "./reply-email";
import { postShipped, resubmitShippedEmails } from "./shipped";
import { resubmitWebhookDeliveries, webhookDelivery } from "./webhooks";

export { UNUSED_UPLOAD_HOURS } from "./cleanup";
export { COMMENT_BATCH_MINUTES } from "./comment-email";
export { DAILY_INVITE_LIMIT, generateInvitationToken, hashInvitationToken, INVITATION_TTL_DAYS, invitationExpiry, pendingInvitation, teamPlacesTaken, UNSENT_EXPIRY } from "./invitations";
export { featurebase, FeaturebaseError, type FeaturebaseContact } from "./featurebase";
export { contentBudget, FEATUREBASE_ICONS } from "./import-docs";
export { adminMember, contactDetails, contactUsers, continueImport, failStaleImports, handOverOnVerified, handOverPlaceholders, type ImportCounts, importJob, IMPORT_KEY, IMPORT_PARTS, importsSettled, importStale, importStep, importStuck, loadAdmins, nextStep, resumeImport, type StepPage, tally } from "./imports";
export { CHANGELOG_PAGE } from "./import-changelog";
export { type ImportPart, IMPORT_SOURCES, type ImportSourceDefinition } from "./import-sources";
export { crawlBudget, crawlPace } from "./import-sources/website";
export { FEEDBACK_PAGE } from "./import-feedback";
export { NOLT_PAGE } from "./import-sources/nolt";
export { cutImportedQuotes } from "./import-inbox";
export { isUniqueViolation, placeholderEmail, syncUsers, syncUsersIn, TooManyProperties, upsertProjectUser, type UserDetails } from "./project-users";
export { lockConflict, withLockRetries } from "./lock-retries";
export { signWebhook } from "./webhooks";
export { sesTenantHeaders } from "./ses-tenant";
export { mailSubdomain } from "./mail-subdomain";
export { projectEmailWaits, projectSender } from "./project-sender";
export { audienceReach, postAudience, projectUnsubscribeToken, provenAddress, type Reach, SEEN_AS_SQL, seenAs } from "./post-audience";
export { lastingMediaUrl, lastingMediaUrls } from "./lasting-media";
export { emailBrand } from "./email-brand";
export { resumePause, resumeToken, tellPaused } from "./email-pause";
export { cappedProjects, claimProjectEmail, emailsThisMonth, monthlyLimitReached, NEW_PROJECT_EMAILS_PER_DAY, nextMonth, pauseIfOverLimits, pausing, releaseProjectEmail } from "./email-limits";
export { checkEmailDomain, dropEmailDomain, forgetIdentity, UNVERIFIED_FOR_MS, withEmailDomainLocks } from "./email-domains";
export { aiFor } from "./ai-usage";
export { aiPaused, creditBalance, type CreditGrant, emailIfCreditsLow, grantCredits, OutOfCredits, takeBackCredits } from "./credits";
export { confidence, thresholds } from "./code-change-decisions";
export { type ArticlePlace, draftPlace, placeWords } from "./code-change-docs";
export { analysisOn, codeChange, GAVE_UP, RETRY_AFTER_MINUTES, retryCodeChanges, writeChangelogLine } from "./code-changes";
export { continueVerifyAll, noAi, RUN_STALE_MS, settleStale, verifyAllRunSelect, verifyAllsSettled, verifyAllStuck, WAITING_FIX, NO_REPOSITORY, type Statement, type Verdict, VERIFY_OFF } from "./verify";
export { verifyAfterEdit } from "./verify-decision";
export { addToRunningDraft, autopilotLines, changelogLineOf, closeRunningDraft, lockProject, onlyPullRequestTitles, RUNNING_DRAFT_TITLE, setChangelogLine, undoChangelogLine } from "./running-draft";
import { autopilotDue } from "./autopilot";
export { queueAutopilotNotices, sendAutopilotDigests, sendAutopilotEmails, tellOwners } from "./autopilot-email";
export { type AutopilotButton, readAutopilotButton, signAutopilotButton } from "./autopilot";
export { autopilotDue, autopilotDueToken, type AutopilotSettings, articlesViews, autopilotSettingsSelect, COMMENT_UNSURE, composeComment, dueAt, holdsForTeam, inReview, POST_COMMENT_MAX, POST_UPDATE, postReach, VERIFY_WAITS, postsReach, postUpdate, postVersion, reviewPath, recentViews, scheduleByItself, schedulePost, tooLong, waitsBecause } from "./autopilot";
export { claimDocsSlug, docsSlugsTaken, freeDocsSlug, RESERVED_ARTICLE_SLUGS } from "./docs-slugs";
export { ARTICLE_REVISIONS_KEPT, docOf, recordRevision, versions, editName, hasTeammateEdit, landEdit, LIVE_EDIT, newestRevision, pruneRevisions, revisionsPast, sameDoc, scheduleArticle, settleWaitingEdits, takeOut, type TaggedEdit, taggedEdits, WAITING_EDIT, dismissTakenOut, editsInChanges, keepsEdit, mergeSections, newestText, changedSections, withSectionsOf } from "./article-layers";

export { applyPlanLicense, grantLicenseCredits, grantPlanLicenseCredits, lockPlanLicense, releasePlanLicense } from "./plan-licenses";
export { apiReferenceChanged, dropHidden, indexApiReferences, indexReference } from "./api-references";
export { backfillEmbeddings } from "./backfill";
export { articleChanged, DELETED_ARTICLE_DAYS, embedPublishedArticles } from "./articles";
export { FAILED_SEARCHES_PER_DAY, INSIGHTS_DAYS, SEARCHES_KEPT_DAYS } from "./docs-searches";
export { detectDuplicates, embedPosts } from "./duplicates";
export { forgetRepositories, type GithubRepo, includeRepositories, inInstallation, installationRepositories, syncRepositories, listedRepositories, repositoryConnection } from "./github-repositories";
export { liveDomain, portalAddress, type PortalAddress, projectWith } from "./portal-address";
export { fetchSiteCheck } from "./site-check";
export { fetchGithubSpec, fetchSpec, GITHUB_NOT_ADDED, repoPathRefusal, type SourceAt, SPEC_FILE_TOO_LARGE, syncMergedApiReferences, readStorable, referenceCounts, respec, SPEC_FETCH_TIMEOUT_MS, SPEC_MAX_REDIRECTS, SPEC_URL_TOO_LARGE, type SpecChanges, specUrlRefusal, syncApiReference, budget as syncBudget, SYNC_BUDGET_MS, SYNC_EVERY_MS, SYNC_ROWS_PER_HOST } from "./api-references";
import { syncApiReferences } from "./api-references";
export { syncApiReferences };
export { emitEvent, portalPostUrl, postGeneration, postStatusChanged, queueDeliveries, recordEvent, postSummary, postSummarySelect, toApiStatus, type PostRow } from "./events";

export type JobLogger = { info(message: string): void; warn(message: string): void };

/** Results are small JSON summaries, shown in Hatchet's dashboard. */
export type JobResult = Record<string, string | number | boolean>;

/** Which try this run is: `lastTry`, none left after it (on Hatchet, its last retry; inline, always: no retries). */
export type JobRun = { lastTry: boolean };

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
  apiReferenceChanged,
  imageUploaded,
  cleanupMedia,
  releaseMedia,
  purgeArticles,
  pruneDocsSearches,
  deleteOldHistory,
  grantPlanLicenseCredits: () => grantPlanLicenseCredits(),
  webhookDelivery,
  resubmitWebhookDeliveries,
  githubPullRequest,
  githubRelease,
  codeChange,
  retryCodeChanges: () => retryCodeChanges(),
  verifyArticle,
  verifyAllArticle: verifyArticle,
  importStep,
  failStaleImports: () => failStaleImports(),
  postShipped,
  resubmitShippedEmails,
  replyEmailed,
  resubmitReplyEmails,
  commentsEmailed,
  commentEmailsDue,
  changelogEmailed,
  resubmitChangelogEmails,
  autopilotDue: () => autopilotDue(),
  syncApiReferences,
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
