import { z } from "zod";

/**
 * Background job contracts shared by the web app (which enqueues) and the
 * worker (which implements). Keeping only names + input schemas here means the
 * web bundle never pulls in worker code.
 */
type JobOptions = {
  name: string;
  input: z.ZodType;
  /** Run on this schedule (cron syntax) instead of being enqueued. */
  cron?: string;
  /** Hatchet retries (default 3) and their backoff. */
  retries?: number;
  backoff?: { factor: number; maxSeconds: number };
  /** Runs with the same key (a CEL expression over the input) run one at a time, in order. */
  concurrencyKey?: string;
};

export const jobs = {
  postCreated: {
    name: "post-created",
    input: z.object({
      projectId: z.string(),
      postId: z.string(),
    }),
  },
  /** A user wrote in the support inbox (a new conversation or a reply): email the team members it's for. */
  conversationMessage: {
    name: "conversation-message",
    // `only`: the addresses a first run couldn't reach, tried again on their own (no claim: the first run made it).
    input: z.object({ messageId: z.string(), only: z.array(z.string()).optional() }),
  },
  /** A user wrote in the support inbox: push it to the phones of the team members it's emailed to (packages/jobs push.ts). */
  conversationPush: {
    name: "conversation-push",
    input: z.object({ messageId: z.string() }),
    // A push is worth little late: a couple of quick tries, then it's let go.
    retries: 2,
  },
  /** A customer wrote in another language while the project translates conversations: translate it into the team's (docs/plan.md L22). */
  translateMessage: {
    name: "translate-message",
    input: z.object({ messageId: z.string() }),
    // The provider not answering is tried again a few times; the last try keeps why, for the team's Try again.
    retries: 3,
    backoff: { factor: 4, maxSeconds: 300 },
  },
  /**
   * An article into one of the project's languages (docs/plan.md, Languages, L6): after a publish, a language added,
   * Retranslate, Try again or "Our product is available in" changing (Retranslate marks the page, so its retries send everything too).
   */
  translateArticle: {
    name: "translate-article",
    input: z.object({ articleId: z.string(), language: z.string() }),
    // The provider not answering is tried again a few times; the last try keeps why, and retryArticleTranslations goes on.
    retries: 3,
    backoff: { factor: 4, maxSeconds: 300 },
    // One at a time per page and language: Retranslate twice, or Try again while it's queued, never pays twice at once.
    concurrencyKey: "input.articleId + ':' + input.language",
  },
  /** A published changelog entry into one language kept up to date (docs/plan.md L16): as translateArticle. */
  translateChangelogEntry: {
    name: "translate-changelog-entry",
    input: z.object({ entryId: z.string(), language: z.string() }),
    retries: 3,
    backoff: { factor: 4, maxSeconds: 300 },
    concurrencyKey: "input.entryId + ':' + input.language",
  },
  /**
   * A project's docs labels (collection and tab names) into one of its languages (docs/plan.md L13): new ones and those kept
   * up to date whose text changed. Two quick retries for an unexpected failure (a deadlock, a restart): each label is written as
   * it's translated, so a retry only asks for what's left; what fails for longer, retryArticleTranslations finds, backing off.
   */
  translateLabels: {
    name: "translate-labels",
    input: z.object({ projectId: z.string(), language: z.string() }),
    concurrencyKey: "input.projectId + ':' + input.language",
    retries: 2,
  },
  /** Translations that couldn't be made (no credits, the provider failing) tried again on their own, backing off up to a day. */
  retryArticleTranslations: {
    name: "retry-article-translations",
    input: z.object({}),
    cron: "*/15 * * * *",
  },
  /** Reads Expo's receipts for pushes sent 15 minutes ago or more, dropping devices whose token is no longer registered. */
  checkPushReceipts: {
    name: "check-push-receipts",
    input: z.object({}),
    cron: "*/15 * * * *",
  },
  /** Queues conversation-message again for users' messages the team should have heard about but didn't (queueing failed). */
  resubmitConversationNotices: {
    name: "conversation-notices-resubmit",
    input: z.object({}),
    cron: "*/10 * * * *",
  },
  /** A docs article was published or changed: embed its sections for search (or remove them if it's no longer published). */
  articleChanged: {
    name: "article-changed",
    input: z.object({ articleId: z.string() }),
  },
  /** An API reference was added or replaced, or what's on the help center changed: index its operations for search and AI answers. */
  apiReferenceChanged: {
    name: "api-reference-changed",
    input: z.object({ referenceId: z.string() }),
  },
  imageUploaded: {
    name: "image-uploaded",
    input: z.object({ mediaId: z.string() }),
  },
  /** Sends one webhook delivery; retried with backoff for about a day (at-least-once). */
  webhookDelivery: {
    name: "webhook-delivery",
    input: z.object({ deliveryId: z.string() }),
    retries: 8,
    // Hatchet waits factor^n seconds before retry n, capped: 5s, 25s, 2m, 10m, 52m, 4.3h, 8h, 8h ≈ 21h in all.
    backoff: { factor: 5, maxSeconds: 8 * 60 * 60 },
  },
  /** Queues deliveries again whose job never started (e.g. queueing failed), so none is lost. */
  resubmitWebhookDeliveries: {
    name: "webhook-resubmit",
    input: z.object({}),
    cron: "*/10 * * * *",
  },
  /** A pull request on an included repo was merged: it goes into the changelog's running draft, and becomes a code change. */
  githubPullRequest: {
    name: "github-pull-request",
    input: z.object({
      installationId: z.number().int(),
      action: z.string(),
      /** GitHub's id for the repository (it routes the event to the project that includes it), and its owner/name. */
      repoId: z.number().int(),
      repo: z.string(),
      number: z.number().int(),
      title: z.string(),
      body: z.string(),
      url: z.string(),
      merged: z.boolean().default(false),
      /** Label names; some keep a merged pull request out of the changelog's running draft. */
      labels: z.array(z.string()).default([]),
      /** Its author's GitHub login, and when it merged. */
      author: z.string().default(""),
      mergedAt: z.string().optional(),
      /** The branch it merged into: API references read from that branch of the repository are read again. */
      base: z.string().optional(),
    }),
  },
  /**
   * Reads a merged pull request (its code change) and analyses it; one run at a time per code change.
   * `force` analyses one already done again; `pastGate` skips "does it change anything users see?"
   * ("Analyse anyway"). Both are input, so a retry keeps them.
   */
  codeChange: {
    name: "code-change",
    // `was`: what a claim moved it from (changelog.addPullRequests), to put it back as if the run doesn't happen.
    input: z.object({
      codeChangeId: z.string(),
      force: z.boolean().default(false),
      pastGate: z.boolean().default(false),
      resume: z.boolean().default(false),
      was: z.enum(["READY", "NOTHING_TO_DO"]).optional(),
    }),
    concurrencyKey: "input.codeChangeId",
    retries: 4,
    // 5s, 25s, 2m, 10m: rides out GitHub's or the AI provider's hiccups.
    backoff: { factor: 5, maxSeconds: 15 * 60 },
  },
  /** Queues again the code changes whose analysis the AI provider didn't answer, once their retry is due (`retryAt`). */
  retryCodeChanges: {
    name: "code-change-retries",
    input: z.object({}),
    cron: "*/10 * * * *",
  },
  /**
   * Verify (docs/plan.md, V5): checks an article against its project's repository, the default branch at its latest
   * commit, and writes the fix for what's out of date. Tried once: a run that fails says why, and the team runs it again.
   */
  verifyArticle: {
    name: "verify-article",
    input: z.object({ verificationId: z.string() }),
    retries: 0,
  },
  /**
   * Screenshots (docs/plan.md, Screenshots): an agent in Browser Use's cloud browser signs in to the team's app and takes
   * a run's screenshots (@tuti/jobs screenshots.ts). Tried once: the run tries a second model itself, and a run that
   * fails says why, for the team to try again (a retry would sign in, and pay, all over).
   */
  screenshotRun: {
    name: "screenshot-run",
    input: z.object({ runId: z.string() }),
    retries: 0,
  },
  /**
   * Settings → Screenshots' suggestions: reads the app at `appUrl` for the sign-in services it calls (@tuti/jobs
   * sign-in-hosts.ts) and keeps the answer on the project's screenshot settings. In the worker, not the web server: a
   * read takes up to 15 seconds and 40 MB. Tried once, one at a time per project: the screen's next look starts another.
   */
  screenshotSignInScan: {
    name: "screenshot-sign-in-scan",
    // `claimedAt`: the claim's time (signInScanAt), so the read clears only its own claim, not a later one for the same
    // address; missing from a read the previous release started.
    input: z.object({ projectId: z.string(), appUrl: z.string(), claimedAt: z.string().optional() }),
    retries: 0,
    concurrencyKey: "input.projectId",
  },
  /**
   * One article of a Verify all (docs/plan.md, V7): verifyArticle, then the next article. A key of its own, so during a
   * deploy these wait for the new worker: the previous one's verifyArticle would neither go on nor leave the email to the end.
   */
  verifyAllArticle: {
    name: "verify-all-article",
    input: z.object({ verificationId: z.string() }),
    retries: 0,
  },
  /**
   * An import from another tool (docs/plan.md, Switching from Featurebase), page after page for a while, then the next
   * run. Tried once: the source's client retries what fails for a while, and a page that still fails leaves the import
   * waiting (resume-imports tries it again) or, when it won't pass, fails it. One at a time per import, so a duplicate
   * waits and then finds its page done. `at`: the page the import was at as the run was queued (its step and
   * cursor): once the import is past it (another run, queued for the same page, got there first), this one ends at once.
   */
  importStep: {
    name: "import-step",
    input: z.object({ importId: z.string(), at: z.string().optional() }),
    retries: 0,
    concurrencyKey: "input.importId",
  },
  /** Resumes imports whose wait for their source is over, and stuck ones (their job went away). */
  resumeImports: {
    name: "resume-imports",
    input: z.object({}),
    cron: "* * * * *",
  },
  /** Fails imports that haven't moved for a day, clearing their keys. */
  failStaleImports: {
    name: "fail-stale-imports",
    input: z.object({}),
    cron: "47 3 * * *",
  },
  /** A release was published on an included repo: it closes the changelog's running draft. */
  githubRelease: {
    name: "github-release",
    input: z.object({
      installationId: z.number().int(),
      repoId: z.number().int(),
      repo: z.string(),
      tag: z.string(),
      name: z.string(),
      url: z.string(),
      publishedAt: z.string(),
    }),
  },
  /** A post moved to Planned, In progress or Completed: email the people behind it (each once per status; a retry emails only those not reached). */
  postShipped: {
    name: "post-shipped",
    input: z.object({ postId: z.string() }),
    retries: 5,
    // 5s, 25s, 2m, 10m, then an hour: rides out a mail provider's outage.
    backoff: { factor: 5, maxSeconds: 60 * 60 },
  },
  /** The team replied with Email voters: email the post's voters (each once; a retry emails only those not reached). */
  replyEmailed: {
    name: "reply-emailed",
    input: z.object({ commentId: z.string() }),
    retries: 5,
    // As post-shipped: rides out a mail provider's outage.
    backoff: { factor: 5, maxSeconds: 60 * 60 },
  },
  /** Queues reply-emailed again for replies whose emails are late (never queued, or the run died). */
  resubmitReplyEmails: {
    name: "reply-emails-resubmit",
    input: z.object({}),
    cron: "*/10 * * * *",
  },
  /** Someone else's comments on a post that are due (comment-emails-due): email them to its author, in one email. */
  commentsEmailed: {
    name: "comments-emailed",
    input: z.object({ postId: z.string() }),
    retries: 5,
    // As post-shipped: rides out a mail provider's outage.
    backoff: { factor: 5, maxSeconds: 60 * 60 },
    concurrencyKey: "input.postId",
  },
  /** Queues comments-emailed for posts with comments due to their authors (their batching wait is over, or the run died). */
  commentEmailsDue: {
    name: "comment-emails-due",
    input: z.object({}),
    cron: "* * * * *",
  },
  /** A changelog entry was published with Email subscribers: email it to its confirmed subscribers (each once). */
  changelogEmailed: {
    name: "changelog-emailed",
    input: z.object({ entryId: z.string() }),
    retries: 5,
    // As post-shipped: rides out a mail provider's outage.
    backoff: { factor: 5, maxSeconds: 60 * 60 },
  },
  /** Queues changelog-emailed again for entries whose emails are late (never queued, or the run died). */
  resubmitChangelogEmails: {
    name: "changelog-emails-resubmit",
    input: z.object({}),
    cron: "*/10 * * * *",
  },
  /** Applies Autopilot's updates that are due (its hold is over), through the web app. */
  autopilotDue: {
    name: "autopilot-due",
    input: z.object({}),
    cron: "* * * * *",
  },
  /** Runs what the inbox's path left behind (a deploy, a crash): the spam filter's model checks, through the web app. */
  inboxDue: {
    name: "inbox-due",
    input: z.object({}),
    cron: "* * * * *",
  },
  /** Queues post-shipped again for posts whose emails are late (never queued, or the run died). */
  resubmitShippedEmails: {
    name: "shipped-emails-resubmit",
    input: z.object({}),
    cron: "*/10 * * * *",
  },
  /** Runs on a schedule (the worker registers `cron`), not enqueued. */
  cleanupMedia: {
    name: "cleanup-media",
    input: z.object({}),
    cron: "17 * * * *",
  },
  /** Marks uploads no content uses any more as unused, so `cleanup-media` deletes them and the quota frees. */
  releaseMedia: {
    name: "release-media",
    input: z.object({}),
    cron: "29 3 * * *",
  },
  /** Removes docs articles deleted more than 30 days ago (until then the team can restore them). */
  purgeArticles: {
    name: "purge-articles",
    input: z.object({}),
    cron: "43 * * * *",
  },
  /** Emails users the team's replies they haven't seen a minute on (support inbox), each conversation's in one email. */
  sendConversationReplies: {
    name: "send-conversation-replies",
    input: z.object({}),
    cron: "* * * * *",
  },
  /** Opens the conversations whose snooze is over (they're out of the inbox's views only till then). */
  wakeConversations: {
    name: "wake-conversations",
    input: z.object({}),
    cron: "* * * * *",
  },
  /** Lets go of raw received emails that couldn't be read in 30 days (read ones go as they're read). */
  pruneInboundEmails: {
    name: "prune-inbound-emails",
    input: z.object({}),
    cron: "37 * * * *",
  },
  /** Tells the operator of projects' email pauses they weren't told of yet (telling them failed). */
  tellEmailPauses: {
    name: "tell-email-pauses",
    input: z.object({}),
    cron: "*/10 * * * *",
  },
  /** Asks Amazon SES again whether each team's own email domain may send (support inbox). */
  checkEmailDomains: {
    name: "check-email-domains",
    input: z.object({}),
    cron: "23 5 * * *",
  },
  /** Removes docs searches' counts and failed searches older than a year (SEARCHES_KEPT_DAYS, Reporting's longest range). */
  pruneDocsSearches: {
    name: "prune-docs-searches",
    input: z.object({}),
    cron: "51 4 * * *",
  },
  /** Deletes closed conversations and AI conversations past the longest plan's history (with plans; docs/plan.md, Plans). */
  deleteOldHistory: {
    name: "delete-old-history",
    input: z.object({}),
    cron: "13 4 * * *",
  },
  /** Gives each project with a plan license its month of credits when the last month's are over (packages/jobs/src/plan-licenses.ts). */
  grantPlanLicenseCredits: {
    name: "license-credits",
    input: z.object({}),
    cron: "7 * * * *",
  },
  /** Reads each API reference from a URL again 6 hours after its last try (docs/plan.md, API reference in Docs, A10). */
  syncApiReferences: {
    name: "sync-api-references",
    input: z.object({}),
    cron: "41 * * * *",
  },
} as const satisfies Record<string, JobOptions>;

export type JobKey = keyof typeof jobs;
export type JobInput<K extends JobKey> = z.infer<(typeof jobs)[K]["input"]>;
