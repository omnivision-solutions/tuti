import { jobs, log, type JobInput, type JobKey } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

import { apiReferenceChanged } from "./api-references";
import { articleChanged, purgeArticles } from "./articles";
import { changelogEmailed, resubmitChangelogEmails } from "./changelog-email";
export { conditionsSql, inGroupSql } from "./group-conditions-sql";
export { changelogReach, type ChangelogReach, emailedOf, optedOutOf, optedOutSql, reached, subscriberCount, subscribersLeft } from "./changelog-email";
import { cleanupMedia, releaseMedia } from "./cleanup";
import { pruneDocsSearches } from "./docs-searches";
import { deleteOldHistory } from "./history";
import { grantPlanLicenseCredits } from "./plan-licenses";
export { historySince, inSomePlansHistory, pastConversations, visibleConversations, visibleConversationsSql } from "./history";
import { checkEmailDomains } from "./email-domains";
import { tellEmailPauses } from "./email-pause";
import { codeChange, retryCodeChanges } from "./code-changes";
import { verifyArticle } from "./verify";
import { screenshotRun } from "./screenshots";
import { scanSignInServices } from "./sign-in-hosts";
import { conversationMessage, pruneInboundEmails, resubmitConversationNotices, sendConversationReplies, wakeConversations } from "./conversations";
export { automatedRepliesEmailed, replyRecipient, type ReplyRecipient } from "./conversations";
export { checkPushReceipts, PUSH_TEXT_MAX, RECEIPT_AFTER_MS } from "./push";
import { githubPullRequest, githubRelease } from "./github";
import { imageUploaded } from "./images";
import { failStaleImports, importStep, resumeImports } from "./imports";
import { postCreated } from "./post-created";
import { translateMessage } from "./conversation-translation";
import { retryArticleTranslations, translateArticle, translateChangelogEntry } from "./article-translation";
import { translateLabels } from "./label-translation";
export { type Glossary, glossaryChangedFor, glossaryFor, glossaryIn, projectGlossary } from "./glossary";
export { forgetLabels, labelIn, type LabelTranslation, type LabelTranslations, labelSource, queueLabels, retranslateLabels, translateLabels } from "./label-translation";
export { behindKey, behindSections, docOfSections, editedSections, metaOf, ownedByTeam, type Section, type SectionMeta, sourceSections, standingIn, versionSections, withTranslation } from "./translation-sections";
import { checkPushReceipts, conversationPush } from "./push";
import { commentEmailsDue, commentsEmailed } from "./comment-email";
import { replyEmailed, resubmitReplyEmails } from "./reply-email";
import { postShipped, resubmitShippedEmails } from "./shipped";
import { resubmitWebhookDeliveries, webhookDelivery } from "./webhooks";

export { UNUSED_UPLOAD_HOURS } from "./cleanup";
export { COMMENT_BATCH_MINUTES } from "./comment-email";
export { DAILY_INVITE_LIMIT, generateInvitationToken, hashInvitationToken, INVITATION_TTL_DAYS, invitationExpiry, pendingInvitation, teamPlacesTaken, UNSENT_EXPIRY } from "./invitations";
export { featurebase, FeaturebaseError, type FeaturebaseContact } from "./featurebase";
export { contentBudget, FEATUREBASE_ICONS } from "./import-docs";
export { adminMember, contactDetails, contactUsers, continueImport, failStaleImports, handOverOnVerified, handOverPlaceholders, type ImportCounts, importJob, IMPORT_KEY, IMPORT_PARTS, IMPORT_RUN, IMPORT_WAITS, importsSettled, importStale, importStep, importDue, loadAdmins, nextStep, resumeImport, type StepPage, tally, waitBefore } from "./imports";
export { CHANGELOG_PAGE } from "./import-changelog";
export { roomForImage, storeImage, uploadImage, UPLOADS_PER_HOUR_TEAM } from "./import-media";
export { markdownToContent } from "./markdown-content";
export { type ImportPart, IMPORT_SOURCES, type ImportSourceDefinition } from "./import-sources";
export { crawlBudget, crawlPace, SiteError } from "./import-sources/website";
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
export { cappedProjects, claimProjectEmail, type EmailClaim, emailsThisMonth, monthlyLimitReached, NEW_PROJECT_EMAILS_PER_DAY, nextMonth, pauseIfOverLimits, pausing, releaseProjectEmail } from "./email-limits";
export { checkEmailDomain, dropEmailDomain, forgetIdentity, UNVERIFIED_FOR_MS, withEmailDomainLocks } from "./email-domains";
export { inboxDue, inboxDueToken } from "./inbox-due";
export { aiFor, duplicatesMeter, imagesMeter, screenshotsMeter } from "./ai-usage";
export { ANNOUNCEMENT_WAITS_MS, applyGlossaryChanges, behindOf, type GlossaryChanges, type GlossaryPlan, planGlossaryChanges, type BehindList, type Draft, entryTranslationsPending, languageTranslationsDone, lostAfterMs, markProductSettingBehind, nameBatch, nameVersion, otherReasons, PRODUCT_SETTING_CHANGED, queueArticleTranslations, removedChanged, queueChangelogTranslations, queueEntryVersion, queueLanguageTranslations, queueVersion, retryBatch, retryDelay, sourceAdded, sourceChanged, translateArticle, translateChangelogEntry, TRANSLATION_WAITS, translationInstructions, translationSource, versionPublished } from "./article-translation";
export { composerTranslation, DEFAULT_TEAM_LANGUAGE, languageCode, noticeText, noticeWait, replyTranslation, sameLanguage, translateMessage, translationFailed, translationPending, translationSettings } from "./conversation-translation";
export { allowedHosts, dropChangedScreenshotProfile, LANDING_SHOT, SCREENSHOT_ERRORS, SCREENSHOT_SECRET, screenshotTask, settleStaleScreenshotRuns, type ShotResult, startScreenshots, takeScreenshots, WINDOWS, withoutLink } from "./screenshots";
export { markersIn, MAX_SHOW, placeScreenshots, screenshotsAsked } from "./screenshot-lines";
export { foundDomains, partlyScannedFor, scannedFor, scanSignInServices, type SignInService } from "./sign-in-hosts";
export { SCREENSHOT_DECISIONS } from "./stale-screenshots";
export { aiPaused, creditBalance, type CreditGrant, emailIfCreditsLow, grantCredits, OutOfCredits, takeBackCredits } from "./credits";
export { confidence, thresholds } from "./code-change-decisions";
export { type ArticlePlace, draftPlace, placeWords, SCREENSHOT_RULE } from "./code-change-docs";
export { analysisOn, claimCodeChange, codeChange, queueClaimed, GAVE_UP, RETRY_AFTER_MINUTES, retryCodeChanges, writeChangelogLine } from "./code-changes";
export { type MergedPull, mergedPullRequests, mergedPullRequestsByRef } from "./merged-pull-requests";
export { continueVerifyAll, noAi, RUN_STALE_MS, settleStale, verifyAllRunSelect, verifyAllsSettled, verifyAllStuck, WAITING_FIX, NO_REPOSITORY, type Statement, type Verdict, VERIFY_OFF } from "./verify";
export { verifyAfterEdit } from "./verify-decision";
export { addToRunningDraft, autopilotLines, changelogLineOf, closeRunningDraft, knownUrl, lockProject, onlyPullRequestTitles, removePullRequest, RUNNING_DRAFT_TITLE, setChangelogLine, undoChangelogLine } from "./running-draft";
import { autopilotDue } from "./autopilot";
import { inboxDue } from "./inbox-due";
export { queueAutopilotNotices, sendAutopilotDigests, sendAutopilotEmails, tellOwners } from "./autopilot-email";
export { type AutopilotButton, readAutopilotButton, signAutopilotButton } from "./autopilot";
export { autopilotDue, autopilotDueToken, type AutopilotSettings, articlesViews, autopilotSettingsSelect, COMMENT_UNSURE, composeComment, dueAt, holdsForTeam, inReview, POST_COMMENT_MAX, POST_UPDATE, postReach, VERIFY_WAITS, postsReach, postUpdate, postVersion, reviewPath, recentViews, scheduleByItself, schedulePost, SCREENSHOT_WAITS, SCREENSHOTS_RETAKE, tooLong, waitsBecause } from "./autopilot";
export { claimDocsSlug, claimLanguageSlug, docsSlugsTaken, freeDocsSlug, freeLanguageSlug, languageSlugRefused, RESERVED_ARTICLE_SLUGS, restoreLanguageSlugs } from "./docs-slugs";
export { ARTICLE_REVISIONS_KEPT, docOf, recordRevision, versions, editName, hasTeammateEdit, landEdit, LIVE_EDIT, newestRevision, pruneRevisions, revisionsPast, sameDoc, scheduleArticle, settleWaitingEdits, takeOut, type TaggedEdit, taggedEdits, WAITING_EDIT, dismissTakenOut, editsInChanges, keepsEdit, mergeSections, newestText, changedSections, withSectionsOf } from "./article-layers";

export { applyPlanLicense, grantLicenseCredits, grantPlanLicenseCredits, lockPlanLicense, releasePlanLicense } from "./plan-licenses";
export { apiReferenceChanged, dropHidden, indexApiReferences, indexReference } from "./api-references";
export { backfillEmbeddings } from "./backfill";
export { articleChanged, DELETED_ARTICLE_DAYS, embedPublishedArticles, embedTranslation } from "./articles";
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
  conversationPush,
  translateMessage,
  translateArticle,
  translateChangelogEntry,
  translateLabels,
  retryArticleTranslations: () => retryArticleTranslations(),
  checkPushReceipts: (input, log) => checkPushReceipts(input, log),
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
  screenshotRun,
  screenshotSignInScan: (input) => scanSignInServices(input),
  importStep,
  resumeImports: (_, log) => resumeImports(log),
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
  inboxDue: () => inboxDue(),
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
