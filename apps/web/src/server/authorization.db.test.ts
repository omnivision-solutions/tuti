import { readdirSync, readFileSync } from "node:fs";

import { type TeamRole, prisma } from "@tuti/db";
import { resumeToken } from "@tuti/jobs";
import { SignJWT } from "jose";
import {
  type DnsFake,
  type GithubFake,
  startGithubFake,
  type SiteFake,
  startSiteFake,
  FAKE_OPENAI_KEY,
  type ModelFake,
  type OpenAIFake,
  type S3Fake,
  startDnsFake,
  startModelFake,
  startOpenAIFake,
  startS3Fake,
  startStripeFake,
  type StripeFake,
  startWebhookReceiver,
  type WebhookReceiver,
} from "@tuti/testkit";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { hashInvitationToken } from "@/lib/invitations";
import { hashSecret } from "@/lib/portal-handoff";
import { generateSsoSecret } from "@/lib/sso";
import { widgetToken } from "@/lib/widget-session";
import { upsertProjectUser } from "@/server/project-users";
import { actAs, createProject, inGroupNamed, signUp, type TestUser } from "@/test/helpers";
import { testLicensePrivateKey } from "@/test/license";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import * as aiModels from "./ai-models";
import * as apiKeys from "./api-keys";
import * as appSearch from "./app-search";
import * as appWidget from "./app-widget";
import * as assistant from "./assistant";
import * as boards from "./boards";
import * as branding from "./branding";
import * as changelog from "./changelog";
import * as changelogSeen from "./changelog-seen";
import * as codeChanges from "./code-changes";
import * as credits from "./credits";
import * as github from "./github";
import * as docs from "./docs";
import * as docsReaders from "./docs-readers";
import * as emailPause from "./email-pause";
import * as groups from "./groups";
import * as inbox from "./inbox";
import * as invitations from "./invitations";
import * as licenseCheckout from "./license-checkout";
import * as managePosts from "./manage-posts";
import * as media from "./media";
import * as portalHandoff from "./portal-handoff";
import * as passwordReset from "./password-reset";
import * as portalSettings from "./portal-settings";
import * as posts from "./posts";
import * as projectSettings from "./project-settings";
import * as projects from "./projects";
import * as signInLink from "./sign-in-link";
import * as similarPosts from "./similar-posts";
import * as ssoSettings from "./sso-settings";
import * as team from "./team";
import * as webhooks from "./webhooks";
import * as widget from "./widget";
import * as widgetInbox from "./widget-inbox";

/**
 * Every server action, who may call it, and a valid call. The type lists each
 * module's exports, so a new action doesn't compile until it's added here, and
 * the first test fails for a new "use server" file that isn't imported above.
 *
 * Each action must refuse everyone below its level (signed out, other
 * projects' teams, lower roles) without changing anything, and work for the
 * lowest level allowed (so the refusals aren't just bad arguments).
 */
const modules = {
  changelog,
  "changelog-seen": changelogSeen,
  "code-changes": codeChanges,
  credits,
  "ai-models": aiModels,
  "api-keys": apiKeys,
  "app-search": appSearch,
  "app-widget": appWidget,
  assistant,
  boards,
  branding,
  github,
  docs,
  "docs-readers": docsReaders,
  "email-pause": emailPause,
  groups,
  inbox,
  invitations,
  "license-checkout": licenseCheckout,
  "manage-posts": managePosts,
  media,
  "password-reset": passwordReset,
  "portal-handoff": portalHandoff,
  "portal-settings": portalSettings,
  posts,
  "project-settings": projectSettings,
  projects,
  "similar-posts": similarPosts,
  "sign-in-link": signInLink,
  "sso-settings": ssoSettings,
  team,
  webhooks,
  widget,
  "widget-inbox": widgetInbox,
};

type Level = "public" | "signed in" | TeamRole;

type Case = {
  allowed: Level;
  /** Takes ids of the project's records: another project's team must not reach them through their own slug. */
  takesIds?: true;
  /** Users who signed in through another project's SSO can't do this (they only exist on that portal). */
  refusesSsoUsers?: true;
  /** Runs before the allowed call only (e.g. scripting the model's reply). */
  before?: () => void;
  call: (slug: string, fixture: Fixture) => Promise<unknown>;
};

type Matrix = { [M in keyof typeof modules]: { [A in keyof (typeof modules)[M]]: Case } };

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};

/** The inbox on, and a widget token for one of the project's users (what Tuti.identify gets the panel). */
async function inboxToken(slug: string) {
  const project = await prisma.project.update({ where: { slug }, data: { supportInbox: true }, select: { id: true } });
  return { token: widgetToken(project.id, await upsertProjectUser(project.id, "matrix-user", { name: "Matrix user" })) };
}

/** A conversation started with that token, for actions on one; a start that fails is the setup's failure. */
async function startedNumber(slug: string, token: Awaited<ReturnType<typeof inboxToken>>) {
  const started = await widgetInbox.widgetStartConversation(slug, token, "Help");
  if (!("number" in started)) {
    throw new Error(`Couldn't start a conversation: ${started.error}`);
  }
  return started.number;
}

const matrix: Matrix = {
  // A token for the account itself (none while APP_WIDGET_PROJECT has SSO off; see app-widget.db.test.ts).
  "app-widget": {
    appWidgetToken: { allowed: "signed in", refusesSsoUsers: true, call: () => appWidget.appWidgetToken() },
  },
  "app-search": {
    searchApp: { allowed: "MEMBER", call: (slug) => appSearch.searchApp(slug, "matrix") },
  },
  "api-keys": {
    createApiKey: { allowed: "ADMIN", call: (slug) => apiKeys.createApiKey(slug, "Zapier", "READ") },
    revokeApiKey: { allowed: "ADMIN", takesIds: true, call: (slug, f) => apiKeys.revokeApiKey(slug, f.apiKeyId) },
  },
  boards: {
    createBoard: { allowed: "ADMIN", call: (slug) => boards.createBoard(slug, {}, form({ name: "Ideas", slug: "ideas" })) },
    updateBoard: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => boards.updateBoard(slug, f.boardId, {}, form({ name: "Ideas", slug: "ideas" })),
    },
    deleteBoard: { allowed: "ADMIN", takesIds: true, call: (slug, f) => boards.deleteBoard(slug, f.emptyBoardId) },
  },
  credits: {
    buyCredits: { allowed: "ADMIN", call: (slug) => withEnv({ AI_CREDITS: "on" }, () => credits.buyCredits(slug, 10)) },
    // Plans on just for that call; Manage plan opens Stripe's portal for the fixture's customer.
    subscribe: { allowed: "ADMIN", call: (slug) => withEnv({ PLANS: "on" }, () => credits.subscribe(slug, "pro", "month")) },
    manageSubscription: { allowed: "ADMIN", call: (slug) => credits.manageSubscription(slug) },
    // Off on the free plan: nothing to remove (adding it is in plans.db.test.ts).
    setBadge: { allowed: "ADMIN", call: (slug) => credits.setBadge(slug, false) },
  },
  "ai-models": {
    saveAiModels: { allowed: "ADMIN", call: (slug) => aiModels.saveAiModels(slug, {}, form({ answers: "", changelog: "" })) },
  },
  assistant: {
    saveAssistantSettings: {
      allowed: "ADMIN",
      call: (slug) => assistant.saveAssistantSettings(slug, {}, form({ tone: "Plain", length: "short", instructions: "Say hi", offLimits: "refund" })),
    },
    saveSupportEmail: {
      allowed: "ADMIN",
      call: (slug) => assistant.saveSupportEmail(slug, {}, form({ supportEmail: `e2e-${crypto.randomUUID()}@example.com` })),
    },
    // The emailed token is the permission (see docs-escalate.db.test.ts).
    confirmSupportEmail: {
      allowed: "public",
      call: async (slug) => {
        const token = crypto.randomUUID();
        await prisma.project.update({
          where: { slug },
          data: { supportEmailPending: "e2e-support-new@example.com", supportEmailTokenHash: hashSecret(token) },
        });
        return assistant.confirmSupportEmail(token);
      },
    },
  },
  branding: {
    saveBranding: {
      allowed: "ADMIN",
      call: (slug) => branding.saveBranding(slug, {}, form({ part: "links", headerLinkLabel: "Docs", headerLinkUrl: "https://docs.example.com" })),
    },
    // Asks the local site, which has no licence server (LICENSE_SERVER_URL below): "unreachable".
    checkBrandingLicense: { allowed: "ADMIN", call: (slug) => branding.checkBrandingLicense(slug) },
  },
  changelog: {
    saveChangelogEntry: {
      allowed: "MEMBER",
      call: (slug) => {
        const form = new FormData();
        form.set("title", "From the matrix");
        return changelog.saveChangelogEntry(slug, null, {}, form);
      },
    },
    findPostsToComplete: { allowed: "MEMBER", call: (slug) => changelog.findPostsToComplete(slug, "Post") },
    draftChangelogEntry: {
      allowed: "MEMBER",
      before: () => model.reply(JSON.stringify({ title: "Matrix release", notes: "Shipped." })),
      call: (slug) => changelog.draftChangelogEntry(slug, 2),
    },
    rewriteChangelogEntry: {
      allowed: "MEMBER",
      before: () => model.reply(JSON.stringify({ notes: "Shipped." })),
      call: (slug) => changelog.rewriteChangelogEntry(slug, 2, { mode: "shorten" }),
    },
    acceptChangelogRewrite: {
      allowed: "MEMBER",
      call: async (slug) => {
        const { updatedAt } = await prisma.changelogEntry.findFirstOrThrow({ where: { project: { slug }, number: 2 } });
        const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Shipped." }] }] };
        return changelog.acceptChangelogRewrite(slug, 2, doc, updatedAt.toISOString());
      },
    },
    publishChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.publishChangelogEntry(slug, 1) },
    unpublishChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.unpublishChangelogEntry(slug, 1) },
    deleteChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.deleteChangelogEntry(slug, 1) },
    reactToChangelogEntry: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) => changelog.reactToChangelogEntry(slug, 1, "tada", true),
    },
    saveChangelogStyle: {
      allowed: "ADMIN",
      call: (slug) => {
        const form = new FormData();
        form.set("tone", "Friendly");
        form.append("examples", "1");
        return changelog.saveChangelogStyle(slug, {}, form);
      },
    },
  },
  "changelog-seen": {
    markChangelogSeen: { allowed: "signed in", refusesSsoUsers: true, call: (slug) => changelogSeen.markChangelogSeen(slug, new Date().toISOString()) },
  },
  docs: {
    saveArticle: {
      allowed: "MEMBER",
      call: (slug) => docs.saveArticle(slug, "matrix-draft", {}, form({ title: "Renamed by the matrix", collection: "basics" })),
    },
    saveArticleSettings: {
      allowed: "MEMBER",
      call: (slug) => docs.saveArticleSettings(slug, "matrix-draft", {}, form({ listing: "unlisted", keywords: "matrix", description: "By the matrix" })),
    },
    publishArticle: { allowed: "MEMBER", call: (slug) => docs.publishArticle(slug, "matrix-draft") },
    publishArticleChanges: { allowed: "MEMBER", call: (slug) => docs.publishArticleChanges(slug, "matrix-article") },
    discardArticleChanges: { allowed: "MEMBER", call: (slug) => docs.discardArticleChanges(slug, "matrix-article") },
    unpublishArticle: { allowed: "MEMBER", call: (slug) => docs.unpublishArticle(slug, "matrix-article") },
    deleteArticle: { allowed: "MEMBER", call: (slug) => docs.deleteArticle(slug, "matrix-article") },
    restoreArticle: { allowed: "MEMBER", takesIds: true, call: (slug, f) => docs.restoreArticle(slug, "matrix-draft", f.revisionId) },
    saveCollection: { allowed: "MEMBER", call: (slug) => docs.saveCollection(slug, null, {}, form({ name: "Billing" })) },
    deleteCollection: { allowed: "MEMBER", call: (slug) => docs.deleteCollection(slug, "basics") },
    moveCollection: { allowed: "MEMBER", call: (slug) => docs.moveCollection(slug, "guides", "basics", 0) },
    moveArticle: { allowed: "MEMBER", call: (slug) => docs.moveArticle(slug, "matrix-draft", "basics", 0) },
    saveTab: { allowed: "MEMBER", call: (slug) => docs.saveTab(slug, null, {}, form({ name: "API" })) },
    moveTab: { allowed: "MEMBER", call: (slug) => docs.moveTab(slug, "docs", 0) },
    deleteTab: { allowed: "MEMBER", call: (slug) => docs.deleteTab(slug, "docs") },
    dismissDocsGap: { allowed: "MEMBER", call: (slug) => docs.dismissDocsGap(slug, "How do I invite?") },
  },
  // Anyone may answer under a published article, count its view, search, ask the AI and rate its answer, signed in or not.
  "docs-readers": {
    answerArticle: { allowed: "public", call: (slug) => docsReaders.answerArticle(slug, "matrix-article", false, "From the matrix") },
    countArticleView: { allowed: "public", call: (slug) => docsReaders.countArticleView(slug, "matrix-article") },
    searchDocsAsTyped: { allowed: "public", call: (slug) => docsReaders.searchDocsAsTyped(slug, "matr") },
    logDocsSearch: { allowed: "public", call: (slug) => docsReaders.logDocsSearch(slug, "matrix", 1) },
    askDocs: {
      allowed: "public",
      // With embeddings on (answers need them). Nothing in the fixture is close to the question, so the model isn't asked.
      call: async (slug) => {
        vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
        vi.stubEnv("OPENAI_BASE_URL", openai.url);
        try {
          return await docsReaders.askDocs(slug, "How do I invite my team?");
        } finally {
          vi.stubEnv("OPENAI_API_KEY", "");
        }
      },
    },
    rateDocsAnswer: { allowed: "public", takesIds: true, call: (slug, f) => docsReaders.rateDocsAnswer(slug, f.questionId, false) },
    // Only the asker (here the browser with MATRIX_READER's cookie; someone signed in is known by their account instead).
    escalateDocs: {
      allowed: "public",
      takesIds: true,
      // The summary of what they need.
      before: () => model.reply("They want to pay with crypto."),
      call: async (slug, f) => {
        const cookie = request.cookie;
        request.cookie = [cookie, `tuti_reader=${MATRIX_READER}`].filter(Boolean).join("; ");
        try {
          return await docsReaders.escalateDocs(slug, f.escalatableId, `e2e-${crypto.randomUUID()}@example.com`, "From the matrix");
        } finally {
          request.cookie = cookie;
        }
      },
    },
  },
  "code-changes": {
    // Analysed inline with AI on (its repository isn't the project's, so it stops there, unread).
    analyseCodeChange: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => withEnv({ OPENAI_API_KEY: FAKE_OPENAI_KEY }, () => codeChanges.analyseCodeChange(slug, f.codeChangeId)),
    },
    resumeCodeChanges: { allowed: "MEMBER", call: (slug) => withEnv({ OPENAI_API_KEY: FAKE_OPENAI_KEY }, () => codeChanges.resumeCodeChanges(slug)) },
    applyCodeChange: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.applyCodeChange(slug, f.linkActionId) },
    dismissCodeChange: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.dismissCodeChange(slug, f.dismissActionId, "Not this one") },
    approveCodeChanges: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.approveCodeChanges(slug, [{ id: f.linkActionId }]) },
    undoCodeChange: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.undoCodeChange(slug, f.appliedActionId) },
    publishCodeChangesNow: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.publishCodeChangesNow(slug, [f.scheduledActionId]) },
    stopCodeChanges: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.stopCodeChanges(slug, [f.stoppableActionId]) },
  },
  github: {
    disconnectGithub: { allowed: "ADMIN", call: (slug) => github.disconnectGithub(slug) },
    // Reads the installation's repositories from GitHub (the fake), with the App's own access.
    refreshGithubRepositories: {
      allowed: "ADMIN",
      call: async (slug) => {
        const before = Object.keys(githubFake.env).map((name) => [name, process.env[name] ?? ""] as const);
        for (const [name, value] of Object.entries(githubFake.env)) {
          vi.stubEnv(name, value);
        }
        try {
          return await github.refreshGithubRepositories(slug);
        } finally {
          for (const [name, value] of before) {
            vi.stubEnv(name, value);
          }
        }
      },
    },
    setGithubRepository: { allowed: "ADMIN", takesIds: true, call: (slug, f) => github.setGithubRepository(slug, f.githubRepoId, true) },
    setCodeChangeAnalysis: { allowed: "OWNER", call: (slug) => github.setCodeChangeAnalysis(slug, false) },
    setAutoApplyLinks: { allowed: "OWNER", call: (slug) => github.setAutoApplyLinks(slug, true) },
    saveAutopilotRecipients: {
      allowed: "OWNER",
      call: (slug) => {
        const form = new FormData();
        form.set("admins", "on");
        return github.saveAutopilotRecipients(slug, {}, form);
      },
    },
    setAutopilotEmails: { allowed: "signed in", call: () => github.setAutopilotEmails("OFF") },
    saveAutopilotSettings: {
      allowed: "OWNER",
      call: (slug) => {
        const form = new FormData();
        for (const [name, value] of Object.entries({ minSure: "90", maxReach: "30", maxViews: "400", holdHours: "12", drafts: "on", articleEdits: "on" })) {
          form.set(name, value);
        }
        return github.saveAutopilotSettings(slug, {}, form);
      },
    },
  },
  invitations: {
    createInvitation: {
      allowed: "ADMIN",
      call: (slug) => invitations.createInvitation(slug, `e2e-${crypto.randomUUID()}@example.com`, "MEMBER"),
    },
    revokeInvitation: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => invitations.revokeInvitation(slug, f.invitationId),
    },
    // The token is the permission: anyone signed in who has it may join.
    acceptInvitation: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => invitations.acceptInvitation(f.invitationToken),
    },
    // Only for invites addressed to the account's own verified email (see invitations.db.test.ts).
    acceptInvitationById: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => invitations.acceptInvitationById(f.emailInvitationId),
    },
    declineInvitation: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => invitations.declineInvitation(f.emailInvitationId),
    },
  },
  "email-pause": {
    // The operator's signed link is what allows it.
    resumeEmailSending: {
      allowed: "public",
      call: async (slug) => {
        const { id, emailPausedAt } = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true, emailPausedAt: true } });
        return emailPause.resumeEmailSending(resumeToken(id, emailPausedAt!));
      },
    },
  },
  inbox: {
    replyInConversation: { allowed: "MEMBER", call: (slug) => inbox.replyInConversation(slug, 1, "Thanks!") },
    // Nothing in the docs is close to what was asked: no draft (and why), and the model isn't asked.
    draftReplyWithAi: {
      allowed: "MEMBER",
      call: (slug) => withEnv({ OPENAI_API_KEY: FAKE_OPENAI_KEY, OPENAI_BASE_URL: openai.url }, () => inbox.draftReplyWithAi(slug, 1)),
    },
    summarizeWithAi: { allowed: "MEMBER", before: () => model.reply("They want an invoice."), call: (slug) => inbox.summarizeWithAi(slug, 1) },
    uploadReplyAttachment: {
      allowed: "MEMBER",
      call: (slug) => inbox.uploadReplyAttachment(slug, { filename: "invoice.pdf", contentType: "application/pdf", size: 1000 }),
    },
    setConversationStatus: { allowed: "MEMBER", call: (slug) => inbox.setConversationStatus(slug, 1, "closed") },
    assignConversation: { allowed: "MEMBER", call: (slug) => inbox.assignConversation(slug, 1, users.MEMBER.id) },
    markConversationSpam: { allowed: "MEMBER", call: (slug) => inbox.markConversationSpam(slug, 1, true) },
    snoozeConversation: { allowed: "MEMBER", call: (slug) => inbox.snoozeConversation(slug, 1, new Date(Date.now() + 3_600_000).toISOString()) },
    linkPostToConversation: { allowed: "MEMBER", call: (slug) => inbox.linkPostToConversation(slug, 1, 1, true) },
    findPostsToLink: { allowed: "MEMBER", call: (slug) => inbox.findPostsToLink(slug, "Post") },
    setSupportInbox: { allowed: "ADMIN", call: (slug) => inbox.setSupportInbox(slug, true) },
    getSupportAddress: { allowed: "ADMIN", call: (slug) => withEnv({ SUPPORT_EMAIL_DOMAIN: "tuti.email" }, () => inbox.getSupportAddress(slug)) },
    setNewConversationEmails: { allowed: "MEMBER", call: (slug) => inbox.setNewConversationEmails(slug, false) },
    saveEmailDomain: { allowed: "ADMIN", call: (slug) => withSes(() => inbox.saveEmailDomain(slug, {}, form({ address: `help@${slug}.example.com` }))) },
    checkEmailDomain: { allowed: "ADMIN", call: (slug) => withSes(() => inbox.checkEmailDomain(slug)) },
    // To the local SMTP fake.
    sendEmailDomainTest: { allowed: "ADMIN", call: (slug) => withSes(() => withEnv({ SMTP_HOST: mailbox.host, SMTP_PORT: String(mailbox.port) }, () => inbox.sendEmailDomainTest(slug))) },
    forgetEmailDomain: { allowed: "ADMIN", call: (slug) => withSes(() => inbox.forgetEmailDomain(slug)) },
  },
  "manage-posts": {
    movePost: { allowed: "MEMBER", takesIds: true, call: (slug, f) => managePosts.movePost(slug, f.postId, "empty") },
    setPostOwner: { allowed: "MEMBER", takesIds: true, call: (slug, f) => managePosts.setPostOwner(slug, f.postId, null) },
    setPostEta: { allowed: "MEMBER", takesIds: true, call: (slug, f) => managePosts.setPostEta(slug, f.postId, "2026-12") },
    changePostStatus: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.changePostStatus(slug, f.postId, "PLANNED"),
    },
    mergePost: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.mergePost(slug, f.duplicateId, f.postId),
    },
    dismissDuplicate: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => managePosts.dismissDuplicate(slug, f.suggestionId),
    },
    removePostLink: { allowed: "MEMBER", takesIds: true, call: (slug, f) => managePosts.removePostLink(slug, f.postId, f.linkId) },
  },
  media: {
    // Anyone who may post in the project may upload; finishing and status are the uploader's own.
    createUpload: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) => media.createUpload(slug, { type: "image/png", size: 1000 }),
    },
    finishUpload: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => media.finishUpload(f.mediaId) },
    uploadStatus: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => media.uploadStatus(f.mediaId) },
  },
  groups: {
    saveGroup: { allowed: "ADMIN", call: (slug) => groups.saveGroup(slug, null, {}, form({ name: "Enterprise", conditions: JSON.stringify(inGroupNamed("enterprise")) })) },
    deleteGroup: { allowed: "ADMIN", call: (slug) => groups.deleteGroup(slug, "beta") },
    // Names the project's SSO users, like Settings → Groups.
    previewGroup: { allowed: "ADMIN", call: (slug) => groups.previewGroup(slug, [{ property: "plan", op: "is", value: "pro" }]) },
    setAskingProperty: { allowed: "ADMIN", call: (slug) => groups.setAskingProperty(slug, "mrr") },
    setUserColumns: { allowed: "ADMIN", call: (slug) => groups.setUserColumns(slug, ["company", "mrr"]) },
    setPropertyFormats: { allowed: "ADMIN", call: (slug) => groups.setPropertyFormats(slug, { mrr: { label: "MRR", format: "money" } }) },
  },
  "portal-handoff": {
    // Any Tuti account may sign in to any portal as itself.
    continueToPortal: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) => portalHandoff.continueToPortal(slug, "a".repeat(43), "/"),
    },
  },
  "portal-settings": {
    setPortalAccess: { allowed: "ADMIN", call: (slug) => portalSettings.setPortalAccess(slug, "private") },
    setPortalHome: { allowed: "ADMIN", call: (slug) => portalSettings.setPortalHome(slug, "docs") },
    addPortalReaders: { allowed: "ADMIN", call: (slug) => portalSettings.addPortalReaders(slug, {}, form({ emails: "e2e-matrix-reader@example.com" })) },
    removePortalReader: { allowed: "ADMIN", call: (slug) => portalSettings.removePortalReader(slug, "e2e-reader@example.com") },
    saveRedirect: { allowed: "ADMIN", call: (slug) => portalSettings.saveRedirect(slug, {}, form({ from: "/hc/en-us/articles/1", to: "/docs" })) },
    removeRedirect: { allowed: "ADMIN", takesIds: true, call: (slug, f) => portalSettings.removeRedirect(slug, f.redirectId) },
    saveCustomDomain: { allowed: "ADMIN", call: (slug) => portalSettings.saveCustomDomain(slug, {}, form({ hostname: `help.${slug}.example.org` })) },
    verifyCustomDomain: { allowed: "ADMIN", call: (slug) => portalSettings.verifyCustomDomain(slug) },
    removeCustomDomain: { allowed: "ADMIN", call: (slug) => portalSettings.removeCustomDomain(slug) },
    saveSite: { allowed: "ADMIN", call: (slug) => portalSettings.saveSite(slug, {}, form({ url: `${site.origin}/help` })) },
    verifySiteSetup: { allowed: "ADMIN", call: (slug) => portalSettings.verifySiteSetup(slug) },
    removeSiteMount: { allowed: "ADMIN", call: (slug) => portalSettings.removeSiteMount(slug) },
  },
  posts: {
    createPost: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) =>
        posts.createPost({}, form({ projectSlug: slug, boardSlug: "feature-requests", title: "Dark mode" })),
    },
    toggleVote: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => posts.toggleVote(f.postId) },
    setPostSubscription: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => posts.setPostSubscription(f.postId, true) },
    addComment: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (_slug, f) => posts.addComment({}, form({ postId: f.postId, body: "Me too" })),
    },
  },
  "project-settings": {
    renameProject: { allowed: "ADMIN", call: (slug) => projectSettings.renameProject(slug, {}, form({ name: "Renamed by the matrix" })) },
  },
  projects: {
    createProject: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: () => projects.createProject({}, form({ name: "New project", slug: `new-${crypto.randomUUID().slice(0, 8)}` })),
    },
    setProjectUses: { allowed: "ADMIN", call: (slug) => projects.setProjectUses(slug, ["feedback", "docs"]) },
    addSampleContent: { allowed: "ADMIN", call: (slug) => projects.addSampleContent(slug) },
    removeSampleContent: { allowed: "ADMIN", call: (slug) => projects.removeSampleContent(slug) },
  },
  // Anyone with tuti.so/license's link may pay for the licence it names (see license-checkout.db.test.ts).
  "license-checkout": {
    buyLicense: {
      allowed: "public",
      call: () =>
        withEnv({ LICENSE_PRIVATE_KEY: testLicensePrivateKey, APP_URL: "https://app.tuti.example" }, () =>
          licenseCheckout.buyLicense(form({ installation: "matrix-installation", project: "matrix-project" })),
        ),
    },
  },
  "similar-posts": {
    findSimilarPosts: { allowed: "public", call: (slug) => similarPosts.findSimilarPosts(slug, "Dark mode please") },
  },
  // Signing in: anyone may ask for a link; only the address's owner can use it (see sign-in-link.db.test.ts).
  "sign-in-link": {
    emailSignInLink: {
      allowed: "public",
      call: (slug) => signInLink.emailSignInLink(slug, "/", form({ email: `e2e-${crypto.randomUUID()}@example.com` })),
    },
    // The emailed token is the permission (a dead one goes back to the sign-in page).
    confirmSignInLink: { allowed: "public", call: () => signInLink.confirmSignInLink(form({ token: "not-a-token", next: "/" })) },
  },
  // Anyone may ask for a reset link on a portal or the app; only the address's owner can use it (see password-reset.db.test.ts).
  "password-reset": {
    emailPasswordReset: {
      allowed: "public",
      call: async (slug) => {
        request.host = `${slug}.localhost:3100`;
        try {
          return await passwordReset.emailPasswordReset(form({ email: `e2e-${crypto.randomUUID()}@example.com` }));
        } finally {
          request.host = "";
        }
      },
    },
    // The emailed token is the permission (a dead one goes back to "Forgot your password?").
    setNewPassword: {
      allowed: "public",
      call: () => passwordReset.setNewPassword(form({ token: "not-a-token", password: "a-new-password", confirm: "a-new-password" })),
    },
  },
  "sso-settings": {
    rotateSsoSecret: { allowed: "ADMIN", call: (slug) => ssoSettings.rotateSsoSecret(slug) },
    disableSso: { allowed: "ADMIN", call: (slug) => ssoSettings.disableSso(slug) },
  },
  team: {
    changeTeamRole: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => team.changeTeamRole(slug, f.targetMemberId, "ADMIN"),
    },
    removeMember: { allowed: "ADMIN", takesIds: true, call: (slug, f) => team.removeMember(slug, f.targetMemberId) },
    leaveProject: { allowed: "MEMBER", call: (slug) => team.leaveProject(slug) },
  },
  // Signed in with tokens, not sessions: anyone holding a valid one may act (see widget.db.test.ts).
  // A widget token is who's writing (widget-inbox.db.test.ts covers refusing others').
  "widget-inbox": {
    widgetHere: { allowed: "public", call: async (slug) => widgetInbox.widgetHere(slug, await inboxToken(slug)) },
    widgetConversations: { allowed: "public", call: async (slug) => widgetInbox.widgetConversations(slug, await inboxToken(slug)) },
    widgetConversation: {
      allowed: "public",
      call: async (slug) => {
        const token = await inboxToken(slug);
        return widgetInbox.widgetConversation(slug, token, await startedNumber(slug, token));
      },
    },
    widgetStartConversation: { allowed: "public", call: async (slug) => widgetInbox.widgetStartConversation(slug, await inboxToken(slug), "Help") },
    widgetUploadAttachment: {
      allowed: "public",
      call: async (slug) => widgetInbox.widgetUploadAttachment(slug, await inboxToken(slug), { filename: "error.png", contentType: "image/png", size: 1000 }),
    },
    widgetSendMessage: {
      allowed: "public",
      call: async (slug) => {
        const token = await inboxToken(slug);
        return widgetInbox.widgetSendMessage(slug, token, await startedNumber(slug, token), "More");
      },
    },
  },
  widget: {
    widgetSignIn: {
      allowed: "public",
      call: async (slug) => {
        const secret = generateSsoSecret();
        await prisma.project.update({ where: { slug }, data: { ssoSecret: secret } });
        const now = Math.floor(Date.now() / 1000);
        const jwt = await new SignJWT({ sub: "matrix-user", jti: crypto.randomUUID() })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(new TextEncoder().encode(secret));
        return widget.widgetSignIn(slug, jwt);
      },
    },
    // Only clears the caller's own cookie.
    widgetSignOut: { allowed: "public", call: () => widget.widgetSignOut() },
    saveWidgetSettings: {
      allowed: "ADMIN",
      call: (slug) => widget.saveWidgetSettings(slug, {}, form({ label: "Help", color: "#5b21b6", position: "bottom-left" })),
    },
    widgetCreatePost: {
      allowed: "public",
      call: async (slug) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        const form = new FormData();
        form.set("boardSlug", "feature-requests");
        form.set("title", "From the widget");
        return widget.widgetCreatePost(slug, widgetToken(project.id, users.MEMBER.id), {}, form);
      },
    },
  },
  webhooks: {
    createWebhook: { allowed: "ADMIN", call: (slug) => webhooks.createWebhook(slug, receiver.url, ["post.created"]) },
    deleteWebhook: { allowed: "ADMIN", takesIds: true, call: (slug, f) => webhooks.deleteWebhook(slug, f.webhookId) },
    sendTestWebhook: { allowed: "ADMIN", takesIds: true, call: (slug, f) => webhooks.sendTestWebhook(slug, f.webhookId) },
  },
};

const ROLES: TeamRole[] = ["MEMBER", "ADMIN", "OWNER"];
/** The reader cookie of the anonymous reader who asked the fixture's question that can be escalated. */
const MATRIX_READER = "00000000-0000-4000-8000-00000000000a";

/** Who's acting: a role on the project's team, or someone from outside it. */
type Actor = TeamRole | "signed out" | "other project's owner" | "other project's SSO user";

/** Runs `fn` with these env vars, then puts them back. */
/** With Amazon SES (the fake) on: the fixture's project sends from its own verified domain (see createFixture). */
const withSes = <T>(fn: () => Promise<T>): Promise<T> => withEnv({ ...ses.env, SUPPORT_EMAIL_DOMAIN: "tuti.email" }, fn);

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.keys(vars).map((name) => [name, process.env[name] ?? ""] as const);
  for (const [name, value] of Object.entries(vars)) {
    vi.stubEnv(name, value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of before) {
      vi.stubEnv(name, value);
    }
  }
}

let s3: S3Fake;
let dns: DnsFake;
let site: SiteFake;
let model: ModelFake;
let openai: OpenAIFake;
let githubFake: GithubFake;
let stripe: StripeFake;
let receiver: WebhookReceiver;
let users: Record<TeamRole | "outsider" | "ssoUser", TestUser>;
let otherProject: Awaited<ReturnType<typeof createProject>>;

const ses = await startSesFake();

beforeAll(async () => {
  s3 = await startS3Fake();
  // Webhook fixtures deliver to a local fake receiver.
  receiver = await startWebhookReceiver();
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  model = await startModelFake();
  openai = await startOpenAIFake();
  githubFake = await startGithubFake();
  // Buying AI credits and plans opens the local Stripe fake's pages (with AI credits or plans on just for that call).
  stripe = await startStripeFake();
  for (const [name, value] of Object.entries({ ...s3.env, ...model.env, ...stripe.env })) {
    vi.stubEnv(name, value);
  }
  dns = await startDnsFake();
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  vi.stubEnv("DNS_LOOKUP_URL", dns.url);
  site = await startSiteFake();
  // Licence checks ask the local site, never tuti.so: it has no licence server (its own 404), so "unreachable".
  vi.stubEnv("LICENSE_SERVER_URL", site.origin);
  const [OWNER, ADMIN, MEMBER, outsider, ssoUser] = await Promise.all(
    ["Owner", "Admin", "Member", "Outsider", "SSO user"].map((name) => signUp(name)),
  );
  users = { OWNER: OWNER!, ADMIN: ADMIN!, MEMBER: MEMBER!, outsider: outsider!, ssoUser: ssoUser! };
  otherProject = await createProject(users.outsider);
  // The account that's allowed to act on its own email invites (allowedActor for "signed in").
  await prisma.user.update({ where: { id: users.outsider.id }, data: { emailVerified: true } });
  await prisma.ssoIdentity.create({
    data: { projectId: otherProject.id, externalId: "ext-1", userId: users.ssoUser.id },
  });
});

afterAll(() => Promise.all([s3.close(), receiver.close(), model.close(), openai.close(), dns.close(), site.close(), githubFake.close(), stripe.close(), ses.close()]));
// Refused calls never reach the model; allowed ones use the reply they scripted.
afterEach(() => model.done());

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** Installation ids are unique: one per fixture. */
let installations = 0;

/** A project with one of everything the actions work on. */
async function createFixture(own: "domain" | "site" = "domain") {
  const project = await createProject(users.OWNER);
  const projectId = project.id;
  // A Stripe customer (it had a plan once), for Manage plan; its email paused, for the operator's resume link.
  await prisma.project.update({ where: { id: projectId }, data: { stripeCustomerId: `cus_matrix_${projectId}`, emailPausedAt: new Date(), emailPausedReason: "2.0% of emails bounced" } });
  // Replies from its own domain, verified (Settings → Support), which SES (the fake) has for it.
  const emailDomain = `${project.slug}.example.com`;
  await prisma.emailDomain.create({ data: { projectId, domain: emailDomain, address: `support@${emailDomain}`, dkimTokens: [], verifiedAt: new Date() } });
  ses.identities.set(emailDomain, { tags: { "tuti-project": projectId }, tokens: [], configurationSet: "tuti-test", verified: true });
  await prisma.teamMember.createMany({
    data: [
      { projectId, userId: users.ADMIN.id, role: "ADMIN" },
      { projectId, userId: users.MEMBER.id, role: "MEMBER" },
    ],
  });
  const target = await prisma.user.create({
    data: { id: crypto.randomUUID(), name: "Target", email: `e2e-${crypto.randomUUID()}@example.com` },
  });
  const targetMember = await prisma.teamMember.create({ data: { projectId, userId: target.id, role: "MEMBER" } });
  const board = project.boards[0]!;
  const emptyBoard = await prisma.board.create({ data: { projectId, slug: "empty", name: "Empty" } });
  const [post, duplicate] = await Promise.all(
    [1, 2].map((number) =>
      prisma.post.create({
        data: { projectId, boardId: board.id, authorId: users.OWNER.id, number, title: `Post ${number}`, body: "" },
      }),
    ),
  );
  await prisma.project.update({ where: { id: projectId }, data: { postCount: 2, conversationCount: 1 } });
  // Conversation #1, from an email address.
  await prisma.conversation.create({
    data: {
      projectId,
      number: 1,
      subject: "Help",
      origin: "API",
      email: "e2e-asker@example.com",
      waitingSince: new Date(),
      messages: { create: { projectId, author: "USER", channel: "API", body: "Help" } },
    },
  });
  const suggestion = await prisma.duplicateSuggestion.create({
    data: { projectId, postId: duplicate!.id, originalId: post!.id, similarity: 0.9 },
  });
  const invitationToken = crypto.randomUUID();
  const invitation = await prisma.invitation.create({
    data: {
      projectId,
      tokenHash: hashInvitationToken(invitationToken),
      createdById: users.OWNER.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const emailInvitation = await prisma.invitation.create({
    data: {
      projectId,
      email: users.outsider.email,
      tokenHash: hashInvitationToken(crypto.randomUUID()),
      createdById: users.OWNER.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  // An upload by the account that's allowed to act as "signed in", waiting to be finished. Made two
  // hours ago, so one per case doesn't use up that account's hourly upload limit.
  const upload = await prisma.media.create({
    data: { projectId, uploaderId: users.outsider.id, size: 4, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  });
  s3.objects.set(`uploads/${upload.id}`, { body: Buffer.from("fake"), contentType: "image/png" });
  const apiKey = await prisma.apiKey.create({
    data: { projectId, name: "Key", scope: "READ", keyHash: crypto.randomUUID(), prefix: "tuti_x", createdById: users.OWNER.id },
  });
  const link = await prisma.postLink.create({
    data: {
      projectId,
      postId: post!.id,
      kind: "ISSUE",
      repo: "acme/app",
      number: 9,
      url: "https://github.com/acme/app/issues/9",
      source: "MANUAL",
    },
  });
  await prisma.project.update({ where: { id: projectId }, data: { changelogCount: 2 } });
  await prisma.changelogEntry.createMany({
    data: [
      { projectId, number: 1, title: "Matrix entry", publishedAt: new Date() },
      { projectId, number: 2, title: "Matrix draft", body: "Shipped" },
    ],
  });
  await prisma.portalReader.create({ data: { projectId, email: "e2e-reader@example.com" } });
  const redirect = await prisma.portalRedirect.create({ data: { projectId, from: "/old/matrix", to: "/docs" } });
  // The portal's own address, one or the other like a real project's: the portal on a site, waiting
  // for its check, which the site answers (for the site actions); else a custom domain waiting for
  // DNS, with its TXT record there to verify it.
  if (own === "site") {
    await prisma.siteMount.create({ data: { projectId, origin: site.origin, path: `/${project.slug}`, verificationToken: "matrix" } });
    site.answer(`/${project.slug}/.well-known/tuti-site`, "tuti-site=matrix");
    site.answer("/_tuti/.well-known/tuti-site", "tuti-site=matrix");
  } else {
    const domain = await prisma.customDomain.create({ data: { projectId, hostname: `docs.${project.slug}.example.com`, verificationToken: "matrix" } });
    dns.txt(`_tuti.${domain.hostname}`, ["tuti-verify=matrix"]);
  }
  const tab = await prisma.docsTab.create({ data: { projectId, slug: "docs", name: "Docs" } });
  const basics = await prisma.collection.create({ data: { projectId, slug: "basics", name: "Basics", tabId: tab.id } });
  await prisma.collection.create({ data: { projectId, slug: "guides", name: "Guides", order: 1, tabId: tab.id } });
  // A reader group no collection is for.
  await prisma.readerGroup.create({ data: { projectId, key: "beta", name: "Beta", conditions: inGroupNamed("beta") } });
  await prisma.article.createMany({
    data: [
      { projectId, slug: "matrix-article", title: "Matrix article", publishedAt: new Date(), collectionId: basics.id },
      { projectId, slug: "matrix-draft", title: "Matrix draft" },
    ],
  });
  const question = await prisma.docsQuestion.create({
    data: { projectId, askerId: "matrix-reader", question: "How do I invite?", source: "PORTAL", status: "ANSWERED", answer: "From the Team page." },
  });
  // "Ask a person" is on, and an anonymous reader just got "I don't know".
  await prisma.project.update({ where: { id: projectId }, data: { supportEmail: "e2e-support@example.com" } });
  const escalatable = await prisma.docsQuestion.create({
    data: { projectId, askerId: MATRIX_READER, question: "Can I pay with crypto?", source: "PORTAL", status: "NO_ANSWER", cause: "NO_RELEVANT_SECTION" },
  });
  // An earlier version of the draft, to restore.
  const revision = await prisma.articleRevision.create({
    data: { article: { connect: { projectId_slug: { projectId, slug: "matrix-draft" } } }, title: "Matrix draft, before", body: "Older" },
  });
  // Unpublished changes to the published article, to publish or discard.
  await prisma.articleChanges.create({
    data: { article: { connect: { projectId_slug: { projectId, slug: "matrix-article" } } }, title: "Matrix article, edited" },
  });
  const webhook = await prisma.webhook.create({
    data: { projectId, url: receiver.url, secret: "whsec_x", events: ["post.created"], createdById: users.OWNER.id },
  });
  // A repository it has seen and not included yet.
  const githubRepoId = ++installations;
  await prisma.githubInstallation.create({
    data: {
      projectId,
      installationId: githubRepoId,
      accountLogin: "acme",
      createdById: users.OWNER.id,
      repositories: [{ id: githubRepoId, fullName: `acme/app-${githubRepoId}` }],
    },
  });
  // A merged pull request's code change, with a link to apply and a proposal to dismiss.
  const codeChange = await prisma.codeChange.create({
    data: {
      projectId,
      repoId: githubRepoId,
      repo: `acme/app-${githubRepoId}`,
      number: 1,
      url: `https://github.com/acme/app-${githubRepoId}/pull/1`,
      title: "Matrix pull request",
      author: "octo",
      mergedAt: new Date(),
      state: "READY",
      actions: {
        create: [
          { kind: "LINKS", postId: post!.id, probability: 0.9 },
          // Approved already, to undo (it put nothing back to put back).
          { kind: "RESOLVES", postId: post!.id, probability: 0.9, status: "APPLIED", payload: { undo: { linked: false } } },
          // Going out by itself later: to publish now, and to stop.
          { kind: "MOVES_FORWARD", postId: post!.id, probability: 0.97, status: "SCHEDULED", dueAt: new Date(Date.now() + 86_400_000), payload: { comment: "Out now" } },
          { kind: "ARTICLE_EDIT", probability: 0.97, status: "SCHEDULED", dueAt: new Date(Date.now() + 86_400_000) },
          { kind: "MOVES_FORWARD", postId: duplicate!.id, probability: 0.5, payload: { comment: "Getting there" } },
        ],
      },
    },
    select: { id: true, actions: { select: { id: true, kind: true, status: true } } },
  });
  return {
    slug: project.slug,
    codeChangeId: codeChange.id,
    linkActionId: codeChange.actions.find((action) => action.kind === "LINKS")!.id,
    dismissActionId: codeChange.actions.find((action) => action.kind === "MOVES_FORWARD" && action.status === "PENDING")!.id,
    appliedActionId: codeChange.actions.find((action) => action.kind === "RESOLVES")!.id,
    scheduledActionId: codeChange.actions.find((action) => action.kind === "MOVES_FORWARD" && action.status === "SCHEDULED")!.id,
    stoppableActionId: codeChange.actions.find((action) => action.kind === "ARTICLE_EDIT")!.id,
    githubRepoId,
    redirectId: redirect.id,
    linkId: link.id,
    webhookId: webhook.id,
    apiKeyId: apiKey.id,
    mediaId: upload.id,
    emailInvitationId: emailInvitation.id,
    boardId: board.id,
    emptyBoardId: emptyBoard.id,
    postId: post!.id,
    duplicateId: duplicate!.id,
    suggestionId: suggestion.id,
    invitationId: invitation.id,
    invitationToken,
    targetMemberId: targetMember.id,
    questionId: question.id,
    escalatableId: escalatable.id,
    revisionId: revision.id,
  };
}

function refusedActors(rule: Case): Actor[] {
  if (rule.allowed === "public") {
    return [];
  }
  if (rule.allowed === "signed in") {
    return rule.refusesSsoUsers ? ["signed out", "other project's SSO user"] : ["signed out"];
  }
  return ["signed out", "other project's owner", ...ROLES.slice(0, ROLES.indexOf(rule.allowed))];
}

/** The lowest level that may act, to show the action works. */
function allowedActor(rule: Case): Actor {
  return rule.allowed === "public" ? "signed out" : rule.allowed === "signed in" ? "other project's owner" : rule.allowed;
}

function userFor(actor: Actor): TestUser | null {
  switch (actor) {
    case "signed out":
      return null;
    case "other project's owner":
      return users.outsider;
    case "other project's SSO user":
      return users.ssoUser;
    default:
      return users[actor];
  }
}

/** What an action did: returned an error, redirected, or returned something else. */
async function outcome(action: Promise<unknown>): Promise<string> {
  try {
    const result = await action;
    const error = (result as { error?: string } | undefined)?.error;
    return error ? `error: ${error}` : "ok";
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (digest?.startsWith("NEXT_REDIRECT;")) {
      return "redirect";
    }
    throw error;
  }
}

/** Every table's contents, except sessions (reading a session may refresh it). */
async function snapshot(): Promise<Record<string, string>> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name NOT IN ('session', '_prisma_migrations')`;
  const entries = await Promise.all(
    tables.map(async ({ name }) => {
      const [row] = await prisma.$queryRawUnsafe<{ hash: string }[]>(
        `SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS hash FROM "${name}" t`,
      );
      return [name, row!.hash] as const;
    }),
  );
  return Object.fromEntries(entries);
}

test("every server action module is in the matrix", () => {
  const dir = new URL(".", import.meta.url);
  const serverActionFiles = readdirSync(dir)
    .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
    .filter((file) => /^["']use server["']/.test(readFileSync(new URL(file, dir), "utf8")))
    .map((file) => file.replace(/\.ts$/, ""));
  expect(serverActionFiles.sort()).toEqual(Object.keys(modules).sort());
});

/** The actions for the portal under a path of the team's site, which get a project on one (the rest get one with a custom domain). */
const SITE_ACTIONS = new Set(["portal-settings.saveSite", "portal-settings.verifySiteSetup", "portal-settings.removeSiteMount"]);

const cases = Object.entries(matrix).flatMap(([module, actions]) =>
  Object.entries(actions as Record<string, Case>).map(([name, rule]) => ({ name: `${module}.${name}`, rule })),
);

test.each(cases)("$name", async ({ name, rule }) => {
  const fixture = await createFixture(SITE_ACTIONS.has(name) ? "site" : "domain");
  const before = await snapshot();

  for (const actor of refusedActors(rule)) {
    actAs(userFor(actor));
    expect({ actor, outcome: await outcome(rule.call(fixture.slug, fixture)) }).toEqual({
      actor,
      outcome: expect.stringMatching(/^error: /),
    });
  }
  if (rule.takesIds) {
    // Their own project's slug, with this project's ids.
    actAs(users.outsider);
    expect(await outcome(rule.call(otherProject.slug, fixture))).toMatch(/^error: /);
  }
  expect(await snapshot()).toEqual(before);

  actAs(userFor(allowedActor(rule)));
  rule.before?.();
  expect(await outcome(rule.call(fixture.slug, fixture))).not.toMatch(/^error: /);
});
