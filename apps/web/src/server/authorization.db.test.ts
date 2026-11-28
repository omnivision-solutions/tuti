import { readdirSync, readFileSync } from "node:fs";

import { imageKey, imageWidths } from "@tuti/content/media";
import { type TeamRole, prisma } from "@tuti/db";
import { importsSettled, languageTranslationsDone, resumeToken, translationSource } from "@tuti/jobs";
import { contentHash } from "@tuti/shared";
import { SignJWT } from "jose";
import sharp from "sharp";
import { billingFile, type BrowserUseFake, configFile, startBrowserUseFake, type DnsFake, FAKE_FEATUREBASE_KEY, type FeaturebaseFake, type GithubFake, type ModelFake, type S3Fake, type SiteFake, startDnsFake, startFeaturebaseFake, startGithubFake, startModelFake, startS3Fake, startSiteFake, startStripeFake, startWebhookReceiver, type StripeFake, type WebhookReceiver } from "@tuti/testkit";
import { startSesFake } from "@tuti/testkit/ses";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { hashInvitationToken } from "@tuti/jobs";
import { generateSsoSecret } from "@/server/auth/sso";
import { widgetToken } from "@/server/auth/widget-session";
import { claimToken } from "@/server/appsumo";
import { upsertProjectUser } from "@/server/project-users";
import { actAs, callerAs, createProject, inGroupNamed, onPortal, signUp, type TestUser } from "@/test/helpers";
import { testLicensePrivateKey } from "@/test/license";
import { mailbox } from "@/test/mailbox";
import { TRPCError } from "@trpc/server";
import type { OperationName } from "./operations";
import { request } from "@/test/next-headers";

import * as aiModels from "./ai-models";
import * as apiKeys from "./api-keys";
import * as articleVersions from "./article-versions";
import { call as callOperation } from "./operations/run";
import { getTranslation } from "./operations/translations";
import * as apiReferences from "./api-references";
import * as appSearch from "./app-search";
import * as appWidget from "./app-widget";
import * as assistant from "./assistant";
import * as boards from "./boards";
import * as branding from "./branding";
import * as changelog from "./changelog";
import * as changelogSeen from "./changelog-seen";
import * as changelogSubscribe from "./changelog-subscribe";
import * as codeChanges from "./code-changes";
import * as codeChangesTuning from "./code-changes-tuning";
import * as credits from "./credits";
import * as github from "./github";
import * as docs from "./docs";
import * as docsReaders from "./docs-readers";
import * as emailPause from "./email-pause";
import * as emailPreferences from "./email-preferences";
import * as groups from "./groups";
import * as images from "./images";
import * as imports from "./imports";
import * as inbox from "./inbox";
import { getMembership } from "./membership";
import * as invitations from "./invitations";
import * as glossary from "./glossary";
import * as labelTranslations from "./label-translations";
import * as languages from "./languages";
import * as licenseCheckout from "./license-checkout";
import * as managePosts from "./manage-posts";
import * as media from "./media";
import * as portalHandoff from "./portal-handoff";
import * as passwordReset from "./password-reset";
import * as planLicenses from "./plan-licenses";
import * as portalSettings from "./portal-settings";
import * as posts from "./posts";
import * as projects from "./projects";
import * as readerLanguage from "./reader-language";
import * as rewrite from "./rewrite";
import * as screenshots from "./screenshots";
import * as signInLink from "./sign-in-link";
import * as spamSettings from "./spam-settings";
import * as similarPosts from "./similar-posts";
import * as ssoSettings from "./sso-settings";
import * as team from "./team";
import * as webhooks from "./webhooks";
import * as widget from "./widget";
import * as widgetInbox from "./widget-inbox";
import * as workflows from "./workflows";
import { createApiReference } from "./operations/api-references";
import { call } from "./operations/run";

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
  "changelog-subscribe": changelogSubscribe,
  "code-changes": codeChanges,
  "code-changes-tuning": codeChangesTuning,
  credits,
  "ai-models": aiModels,
  "api-keys": apiKeys,
  "api-references": apiReferences,
  "app-search": appSearch,
  "app-widget": appWidget,
  assistant,
  boards,
  branding,
  github,
  docs,
  "docs-readers": docsReaders,
  "article-versions": articleVersions,
  "email-pause": emailPause,
  "email-preferences": emailPreferences,
  groups,
  images,
  imports,
  inbox,
  invitations,
  glossary,
  "label-translations": labelTranslations,
  languages,
  "license-checkout": licenseCheckout,
  "manage-posts": managePosts,
  media,
  "password-reset": passwordReset,
  "plan-licenses": planLicenses,
  "portal-handoff": portalHandoff,
  "portal-settings": portalSettings,
  posts,
  projects,
  "reader-language": readerLanguage,
  rewrite,
  screenshots,
  "similar-posts": similarPosts,
  "sign-in-link": signInLink,
  "spam-settings": spamSettings,
  "sso-settings": ssoSettings,
  team,
  webhooks,
  widget,
  "widget-inbox": widgetInbox,
  workflows,
};

const MATRIX_SPEC = JSON.stringify({ openapi: "3.1.0", info: { title: "Matrix", version: "1" }, paths: { "/posts": { get: { summary: "List posts", responses: { 200: { description: "OK" } } } } } });

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
  // A token for the account itself (none while ownPortal.widgetProject has SSO off; see app-widget.db.test.ts).
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
    setBoardOff: { allowed: "ADMIN", takesIds: true, call: (slug, f) => boards.setBoardOff(slug, f.emptyBoardId, true) },
  },
  credits: {
    buyCredits: { allowed: "ADMIN", call: (slug) => withEnv({ TUTI_CONFIG: configFile({ customDomains: { target: "customers.example.net" }, credits: { enabled: true } }) }, () => credits.buyCredits(slug, 10)) },
    // Plans on just for that call; Manage plan opens Stripe's portal for the fixture's customer.
    subscribe: { allowed: "ADMIN", call: (slug) => withEnv({ BILLING_CONFIG: billingFile() }, () => credits.subscribe(slug, "pro", "month")) },
    manageSubscription: { allowed: "ADMIN", call: (slug) => credits.manageSubscription(slug) },
    // Off on the free plan: nothing to remove (adding it is in plans.db.test.ts).
    setBadge: { allowed: "ADMIN", call: (slug) => credits.setBadge(slug, false) },
  },
  "ai-models": {
    saveAiModel: { allowed: "ADMIN", call: (slug) => aiModels.saveAiModel(slug, { levels: { changelog: "balanced" } }) },
  },
  // Owners only, like Autopilot's other settings (plans are off here, so every project has it).
  "code-changes-tuning": {
    saveCodeChangesTuning: { allowed: "OWNER", call: (slug) => codeChangesTuning.saveCodeChangesTuning(slug, {}, form({ "decide.rounds": "6" })) },
  },
  assistant: {
    saveAssistantSettings: {
      allowed: "ADMIN",
      call: (slug) => assistant.saveAssistantSettings(slug, {}, form({ length: "short", instructions: "Say hi", offLimits: "refund" })),
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
    // GitHub (the fake): the fixture's repository's merged pull request #5, and #4 in draft #2.
    findMissingChanges: { allowed: "MEMBER", call: (slug) => withEnv(githubFake.env, () => changelog.findMissingChanges(slug)) },
    addChangelogPullRequests: {
      allowed: "MEMBER",
      call: (slug, f) => withEnv(githubFake.env, () => changelog.addChangelogPullRequests(slug, [{ repo: `acme/docs-${f.githubRepoId}`, number: 5 }])),
    },
    removeChangelogPullRequest: {
      allowed: "MEMBER",
      call: (slug, f) => withEnv(githubFake.env, () => changelog.removeChangelogPullRequest(slug, 2, `https://github.com/acme/docs-${f.githubRepoId}/pull/4`)),
    },
    draftChangelogEntry: {
      allowed: "MEMBER",
      before: () => model.reply(JSON.stringify({ title: "Matrix release", notes: "Shipped." })),
      call: (slug) => changelog.draftChangelogEntry(slug, 2),
    },
    publishChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.publishChangelogEntry(slug, 1) },
    composeChangelogCover: { allowed: "MEMBER", call: (slug) => changelog.composeChangelogCover(slug, 1, "title") },
    // Owners and admins, as screenshots.take: what's asked for goes into the agent's task beside the sign-in. Inline, by Browser Use's fake.
    takeChangelogScreenshots: { allowed: "ADMIN", call: (slug) => withEnv(browserUse.env, () => changelog.takeChangelogScreenshots(slug, 3, ["The dashboard"])) },
    // The published entry's German (Manual in the fixture), written from its editor's language pill: a first version, then
    // Keep up to date turned off again.
    saveChangelogVersion: {
      allowed: "MEMBER",
      call: (slug) => {
        const form = new FormData();
        form.set("title", "Matrix-Eintrag");
        form.set("content", JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Von der Matrix." }] }] }));
        // As changelog.getTranslation gives it for no version yet, beside the fixture entry's text.
        form.set("version", contentHash(JSON.stringify([null, translationSource({ title: "Matrix entry", body: "", content: null }).hash])));
        return changelog.saveChangelogVersion(slug, 1, "de", {}, form);
      },
    },
    keepChangelogVersionUpToDate: {
      allowed: "MEMBER",
      call: (slug) => changelog.keepChangelogVersionUpToDate(slug, 1, "de", false, contentHash(JSON.stringify([null, translationSource({ title: "Matrix entry", body: "", content: null }).hash]))),
    },
    unpublishChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.unpublishChangelogEntry(slug, 1) },
    deleteChangelogEntry: { allowed: "MEMBER", call: (slug) => changelog.deleteChangelogEntry(slug, 1) },
    reactToChangelogEntry: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) => changelog.reactToChangelogEntry(slug, 1, "tada", true),
    },
    commentOnChangelogEntry: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug) => changelog.commentOnChangelogEntry(slug, 1, {}, form({ body: "Nice" })),
    },
    // Its author's own: the one allowed to act ("signed in": the other project's owner) wrote it.
    editChangelogComment: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug, f) => changelog.editChangelogComment(slug, 1, f.entryCommentId, {}, form({ body: "Edited" })),
    },
    deleteChangelogComment: {
      allowed: "signed in",
      refusesSsoUsers: true,
      call: (slug, f) => changelog.deleteChangelogComment(slug, 1, f.entryCommentId),
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
  "email-preferences": {
    setEmailPreference: { allowed: "signed in", refusesSsoUsers: true, call: (slug) => emailPreferences.setEmailPreference(slug, "followedPosts", false) },
  },
  // Anyone may ask for a public portal's changelog by email; only the address's owner can confirm (see changelog-subscribers.db.test.ts).
  "changelog-subscribe": {
    subscribeToChangelog: {
      allowed: "public",
      call: (slug) => changelogSubscribe.subscribeToChangelog(slug, form({ email: `e2e-${crypto.randomUUID()}@example.com` })),
    },
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
    // Owners and admins, as screenshots.take. Inline, by Browser Use's fake.
    takeArticleScreenshots: { allowed: "ADMIN", call: (slug) => withEnv(browserUse.env, () => docs.takeArticleScreenshots(slug, "matrix-screenshots", ["The dashboard"])) },
    publishArticleChanges: { allowed: "MEMBER", call: (slug) => docs.publishArticleChanges(slug, "matrix-article") },
    discardArticleChanges: { allowed: "MEMBER", call: (slug) => docs.discardArticleChanges(slug, "matrix-article") },
    unpublishArticle: { allowed: "MEMBER", call: (slug) => docs.unpublishArticle(slug, "matrix-article") },
    deleteArticle: { allowed: "MEMBER", call: (slug) => docs.deleteArticle(slug, "matrix-article") },
    restoreArticle: { allowed: "MEMBER", takesIds: true, call: (slug, f) => docs.restoreArticle(slug, "matrix-draft", f.revisionId) },
    saveCollection: { allowed: "MEMBER", call: (slug) => docs.saveCollection(slug, null, {}, form({ name: "Billing" })) },
    deleteCollection: { allowed: "MEMBER", call: (slug) => docs.deleteCollection(slug, "basics") },
    moveCollection: { allowed: "MEMBER", call: (slug) => docs.moveCollection(slug, "guides", "basics", 0) },
    addApiReference: {
      allowed: "MEMBER",
      call: (slug) => docs.addApiReference(slug, form({ name: "API reference", spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '1'\npaths:\n  /posts:\n    get:\n      summary: List posts\n" })),
    },
    moveArticle: { allowed: "MEMBER", call: (slug) => docs.moveArticle(slug, "matrix-draft", "basics", 0) },
    saveTab: { allowed: "MEMBER", call: (slug) => docs.saveTab(slug, null, {}, form({ name: "API" })) },
    moveTab: { allowed: "MEMBER", call: (slug) => docs.moveTab(slug, "docs", 0) },
    deleteTab: { allowed: "MEMBER", call: (slug) => docs.deleteTab(slug, "docs") },
    dismissDocsGap: { allowed: "MEMBER", call: (slug) => docs.dismissDocsGap(slug, "How do I invite?") },
  },
  "api-references": {
    setApiReferenceShown: { allowed: "MEMBER", call: (slug) => apiReferences.setApiReferenceShown(slug, "matrix-api", "operation", "GET /posts", false) },
    markApiReferenceSeen: { allowed: "MEMBER", call: (slug) => apiReferences.markApiReferenceSeen(slug, "matrix-api", ["GET /posts"]) },
    setApiReferencePublished: { allowed: "MEMBER", call: (slug) => apiReferences.setApiReferencePublished(slug, "matrix-api", false) },
    replaceApiReferenceSpec: { allowed: "MEMBER", call: (slug) => apiReferences.replaceApiReferenceSpec(slug, "matrix-api", form({ spec: MATRIX_SPEC.replace("List posts", "Every post") })) },
    saveApiReferenceSettings: { allowed: "MEMBER", call: (slug) => apiReferences.saveApiReferenceSettings(slug, "matrix-api", { name: "Renamed API", baseUrl: "https://api.example.com", tryIt: false }) },
    syncApiReferenceNow: { allowed: "MEMBER", call: (slug) => apiReferences.syncApiReferenceNow(slug, "matrix-url-api") },
    previewApiReferenceUrl: { allowed: "MEMBER", call: (slug) => apiReferences.previewApiReferenceUrl(slug, `${site.origin}/matrix-openapi.json`) },
    changeApiReferenceUrl: { allowed: "MEMBER", call: (slug) => apiReferences.changeApiReferenceUrl(slug, "matrix-url-api", `${site.origin}/matrix-openapi-2.json`) },
    listApiReferenceRepositories: { allowed: "MEMBER", call: (slug) => apiReferences.listApiReferenceRepositories(slug) },
    // The repository is the fixture's: another project's team naming it from their own project is refused.
    previewApiReferenceGithub: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => withEnv(githubFake.env, () => apiReferences.previewApiReferenceGithub(slug, { repoId: f.specRepoId, path: "openapi.json" })),
    },
    // The repository too: another project's team naming it for their own reference is refused.
    changeApiReferenceGithub: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => withEnv(githubFake.env, () => apiReferences.changeApiReferenceGithub(slug, "matrix-github-api", { repoId: f.specRepoId, path: "openapi-2.json", ref: "main" })),
    },
    deleteApiReference: { allowed: "MEMBER", call: (slug) => apiReferences.deleteApiReference(slug, "matrix-api") },
  },
  // Anyone may choose the portal's language (its default here), signed in or not: a private portal's sign-in page has the switcher.
  "reader-language": {
    chooseLanguage: { allowed: "public", call: (slug) => readerLanguage.chooseLanguage(slug, "en") },
  },
  // Anyone may answer under a published article, count its view, search, ask the AI and rate its answer, signed in or not.
  // The article's German, from its editor's language pill: from the version read (the owner's read, so the token is the
  // fixture's as it is).
  "article-versions": {
    saveArticleVersion: {
      allowed: "MEMBER",
      call: async (slug, f) => {
        const read = await callOperation(getTranslation, { actor: { kind: "user", userId: users.OWNER.id }, projectId: f.projectId }, { slug: "matrix-article", language: "de" });
        const form = new FormData();
        form.set("title", "Matrix-Artikel");
        form.set("content", JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Von der Matrix." }] }] }));
        form.set("version", read.version);
        return articleVersions.saveArticleVersion(slug, "matrix-article", "de", {}, form);
      },
    },
    keepArticleVersionUpToDate: {
      allowed: "MEMBER",
      call: async (slug, f) => {
        const read = await callOperation(getTranslation, { actor: { kind: "user", userId: users.OWNER.id }, projectId: f.projectId }, { slug: "matrix-article", language: "de" });
        return articleVersions.keepArticleVersionUpToDate(slug, "matrix-article", "de", false, read.version);
      },
    },
    updateArticleVersionSections: {
      allowed: "MEMBER",
      // The fixture's German has a section behind (its English went), so there's one to update.
      call: async (slug, f) => {
        const read = await callOperation(getTranslation, { actor: { kind: "user", userId: users.OWNER.id }, projectId: f.projectId }, { slug: "matrix-article", language: "de" });
        return articleVersions.updateArticleVersionSections(slug, "matrix-article", "de", ["Gone\u001f0"], read.version);
      },
    },
  },
  "docs-readers": {
    answerArticle: { allowed: "public", call: (slug) => docsReaders.answerArticle(slug, "matrix-article", false, "From the matrix") },
    countArticleView: { allowed: "public", call: (slug) => docsReaders.countArticleView(slug, "matrix-article") },
    searchDocsAsTyped: { allowed: "public", call: (slug) => docsReaders.searchDocsAsTyped(slug, "matr") },
    logDocsSearch: { allowed: "public", call: (slug) => docsReaders.logDocsSearch(slug, "matrix", 1) },
    askDocs: {
      allowed: "public",
      // Nothing in the fixture is close to the question, so the model isn't asked.
      call: (slug) => docsReaders.askDocs(slug, "How do I invite my team?"),
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
  // Against the Featurebase fake; its pages come across in the background, waited for so the next case starts clean.
  imports: {
    startImport: {
      allowed: "ADMIN",
      call: async (slug) => {
        const started = await imports.startImport(slug, "featurebase", FAKE_FEATUREBASE_KEY, ["contacts"]);
        await importsSettled();
        return started;
      },
    },
  },
  "code-changes": {
    // Analysed inline with AI on (its repository isn't the project's, so it stops there, unread).
    analyseCodeChange: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => codeChanges.analyseCodeChange(slug, f.codeChangeId),
    },
    resumeCodeChanges: { allowed: "MEMBER", call: (slug) => codeChanges.resumeCodeChanges(slug) },
    applyCodeChange: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.applyCodeChange(slug, f.linkActionId) },
    dismissCodeChange: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.dismissCodeChange(slug, f.dismissActionId, "Not this one") },
    approveCodeChanges: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.approveCodeChanges(slug, [{ id: f.linkActionId }]) },
    undoCodeChange: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.undoCodeChange(slug, f.appliedActionId) },
    publishCodeChangesNow: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.publishCodeChangesNow(slug, [f.scheduledActionId]) },
    stopCodeChanges: { allowed: "MEMBER", takesIds: true, call: (slug, f) => codeChanges.stopCodeChanges(slug, [f.stoppableActionId]) },
    // With AI on and a repository: GitHub isn't set up here, so the run stops there, unread.
    verifyArticle: {
      allowed: "MEMBER",
      call: (slug) => codeChanges.verifyArticle(slug, "matrix-article"),
    },
    // Each published article's run stops at GitHub, unread, as Verify's does.
    verifyAll: { allowed: "MEMBER", call: (slug) => codeChanges.verifyAll(slug) },
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
    setAutopilotSwitch: { allowed: "OWNER", call: (slug) => github.setAutopilotSwitch(slug, "complete", true) },
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
        for (const [name, value] of Object.entries({ minSure: "90", maxReach: "30", maxViews: "400", holdHours: "12" })) {
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
    // An invite an import made, not sent yet.
    sendInvitation: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => invitations.sendInvitation(slug, f.unsentInvitationId),
    },
    sendAllInvitations: {
      allowed: "ADMIN",
      call: async (slug) => {
        const result = await invitations.sendAllInvitations(slug);
        // Sending none would pass for refused as much as for allowed.
        return result.sent === 1 ? result : { error: `sent ${result.sent}` };
      },
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
    markConversationRead: { allowed: "MEMBER", call: (slug) => inbox.markConversationRead(slug, 1, new Date().toISOString()) },
    replyInConversation: { allowed: "MEMBER", call: (slug) => inbox.replyInConversation(slug, 1, "Thanks!") },
    // Translation is off in the fixture: no preview, and the model isn't asked.
    previewReplyTranslation: { allowed: "MEMBER", call: (slug) => inbox.previewReplyTranslation(slug, 1, "Thanks!") },
    // No message's translation failed in the fixture: nothing is queued.
    retryTranslation: { allowed: "MEMBER", call: (slug) => inbox.retryTranslation(slug, 1) },
    // Nothing in the docs is close to what was asked: no draft (and why), and the model isn't asked.
    draftReplyWithAi: {
      allowed: "MEMBER",
      call: (slug) => inbox.draftReplyWithAi(slug, 1),
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
    takeOverConversation: { allowed: "MEMBER", call: (slug) => inbox.takeOverConversation(slug, 1) },
    handBackConversation: {
      allowed: "MEMBER",
      // Its user waits on conversation #1, which refuses a hand back for everyone: answered first (as the AI's turn answers)
      // for a teammate's call, so only who may call it is tested. Nobody else's call writes anything (the snapshot checks).
      call: async (slug) => {
        if (await getMembership(slug)) {
          const conversation = await prisma.conversation.findFirstOrThrow({ where: { project: { slug }, number: 1 }, select: { id: true, projectId: true } });
          await prisma.conversationMessage.create({ data: { projectId: conversation.projectId, conversationId: conversation.id, author: "AI", channel: "API", body: "An answer" } });
        }
        return inbox.handBackConversation(slug, 1);
      },
    },
    setConversationPriority: { allowed: "MEMBER", call: (slug) => inbox.setConversationPriority(slug, 1, true) },
    linkPostToConversation: { allowed: "MEMBER", call: (slug) => inbox.linkPostToConversation(slug, 1, 1, true) },
    loadConversationActivity: { allowed: "MEMBER", call: (slug) => inbox.loadConversationActivity(slug, 1, "all") },
    findPostsToLink: { allowed: "MEMBER", call: (slug) => inbox.findPostsToLink(slug, "Post") },
    findArticlesToInsert: { allowed: "MEMBER", call: (slug) => inbox.findArticlesToInsert(slug, 1, "Getting started") },
    // Off: the fixture has it on (for escalateDocs), so a refused write would show.
    setSupportInbox: { allowed: "ADMIN", call: (slug) => inbox.setSupportInbox(slug, false) },
    setTranslation: { allowed: "ADMIN", call: (slug) => inbox.setTranslation(slug, { teamLanguage: "en" }) },
    saveDraftInstructions: { allowed: "ADMIN", call: (slug) => inbox.saveDraftInstructions(slug, {}, form({ instructions: "Keep it short." })) },
    getSupportAddress: { allowed: "ADMIN", call: (slug) => withEnv({ SUPPORT_EMAIL_DOMAIN: "tuti.email" }, () => inbox.getSupportAddress(slug)) },
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
    setPostVisibility: { allowed: "MEMBER", takesIds: true, call: (slug, f) => managePosts.setPostVisibility(slug, f.postId, "private") },
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
    // Their own avatar, from their own upload.
    setAvatar: { allowed: "signed in", call: () => media.setAvatar(null) },
  },
  "label-translations": {
    // German, which the fixture adds: the team's own name there.
    saveCollectionTranslation: {
      allowed: "MEMBER",
      call: (slug) => labelTranslations.saveCollectionTranslation(slug, "guides", "de", { keepUpToDate: false, name: "Anleitungen", description: "" }),
    },
    saveTabTranslation: { allowed: "MEMBER", call: (slug) => labelTranslations.saveTabTranslation(slug, "docs", "de", { keepUpToDate: false, name: "Dokumentation" }) },
    saveBoardTranslation: {
      allowed: "ADMIN",
      call: (slug) => labelTranslations.saveBoardTranslation(slug, "feature-requests", "de", { keepUpToDate: false, name: "Funktionswünsche", description: "" }),
    },
  },
  glossary: {
    saveGlossary: { allowed: "ADMIN", call: (slug) => glossary.saveGlossary(slug, [{ term: "Acme", keep: true, translations: {} }]) },
  },
  languages: {
    // The fixture has German besides English, so the default stays as it is.
    setDefaultLanguage: { allowed: "ADMIN", call: (slug) => languages.setDefaultLanguage(slug, "en") },
    addLanguage: {
      allowed: "ADMIN",
      // French is Automatic for new pages: the published article and changelog entry are translated, in the background
      // (done before the next case).
      before: () => {
        model.otherwise(JSON.stringify({ segments: { "1": "Article de la matrice" } }), "Matrix article");
        model.otherwise(JSON.stringify({ segments: { "1": "Entrée de la matrice" } }), "Matrix entry");
        // Its collection and tab names too (docs/plan.md L13), and its boards' (L14).
        model.otherwise(
          JSON.stringify({ segments: { "0.n": "Bases", "1.n": "Guides pratiques", "2.n": "Documentation", "3.n": "Demandes de fonctionnalités", "4.n": "Vide" } }),
          '"0.n":"Basics"',
        );
      },
      call: async (slug) => {
        const result = await languages.addLanguage(slug, "fr");
        await languageTranslationsDone();
        return result;
      },
    },
    updateLanguage: { allowed: "ADMIN", call: (slug) => languages.updateLanguage(slug, "de", { live: true, instructions: "Use du." }) },
    removeLanguage: { allowed: "ADMIN", call: (slug) => languages.removeLanguage(slug, "de") },
  },
  groups: {
    saveGroup: { allowed: "ADMIN", call: (slug) => groups.saveGroup(slug, null, {}, form({ name: "Enterprise", conditions: JSON.stringify(inGroupNamed("enterprise")) })) },
    deleteGroup: { allowed: "ADMIN", call: (slug) => groups.deleteGroup(slug, "beta") },
    // Names the project's SSO users, like Settings → Groups.
    previewGroup: { allowed: "ADMIN", call: (slug) => groups.previewGroup(slug, [{ property: "plan", op: "is", value: "pro" }]) },
    // The values the project's SSO users have, like the preview.
    suggestValues: { allowed: "ADMIN", call: (slug) => groups.suggestValues(slug, "plan") },
    setAskingProperty: { allowed: "ADMIN", call: (slug) => groups.setAskingProperty(slug, "mrr") },
    setUserColumns: { allowed: "ADMIN", call: (slug) => groups.setUserColumns(slug, ["company", "mrr"]) },
    setPropertyFormats: { allowed: "ADMIN", call: (slug) => groups.setPropertyFormats(slug, { mrr: { label: "MRR", format: "money" } }) },
    removeChangelogSubscriber: { allowed: "ADMIN", call: (slug) => groups.removeChangelogSubscriber(slug, "e2e-matrix-subscriber@example.com") },
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
    setCommentLike: { allowed: "signed in", refusesSsoUsers: true, call: (_slug, f) => posts.setCommentLike(f.commentId, true) },
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
  // Anyone with tuti.so/app/license's link may pay for the licence it names (see license-checkout.db.test.ts).
  "license-checkout": {
    buyLicense: {
      allowed: "public",
      call: () =>
        withEnv({ LICENSE_PRIVATE_KEY: testLicensePrivateKey, APP_URL: "https://app.tuti.example" }, () =>
          licenseCheckout.buyLicense(form({ installation: "matrix-installation", project: "matrix-project" })),
        ),
    },
  },
  // A license is its holder's: the fixture's admin holds one to assign, and another account one on its own project.
  "plan-licenses": {
    assignPlanLicense: { allowed: "ADMIN", takesIds: true, call: (slug, f) => planLicenses.assignPlanLicense(slug, f.planLicenseId) },
    unassignPlanLicense: { allowed: "signed in", refusesSsoUsers: true, call: (_, f) => planLicenses.unassignPlanLicense(f.assignedPlanLicenseId) },
    // A claim for an unclaimed license (from AppSumo's sign-in): it redirects to Licenses once claimed.
    claimPlanLicense: { allowed: "signed in", refusesSsoUsers: true, call: (_, f) => planLicenses.claimPlanLicense(f.planLicenseClaim) },
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
  "spam-settings": {
    addSpamRule: { allowed: "ADMIN", call: (slug) => spamSettings.addSpamRule(slug, { field: "subject_or_body", matcher: "contains", value: "facebook admin" }) },
    removeSpamRule: { allowed: "ADMIN", takesIds: true, call: (slug, f) => spamSettings.removeSpamRule(slug, f.spamRuleId) },
    allowSpamSender: { allowed: "ADMIN", call: (slug) => spamSettings.allowSpamSender(slug, "forms.example") },
    removeSpamSender: { allowed: "ADMIN", call: (slug) => spamSettings.removeSpamSender(slug, "forms.example") },
    setSpamGuidance: { allowed: "ADMIN", call: (slug) => spamSettings.setSpamGuidance(slug, "SEO pitches are spam") },
    trySpam: { allowed: "ADMIN", call: (slug) => spamSettings.trySpam(slug, { from: "Kim <e2e-matrix-kim@example.com>", subject: "Hi", text: "Hello" }) },
  },
  "sso-settings": {
    rotateSsoSecret: { allowed: "ADMIN", call: (slug) => ssoSettings.rotateSsoSecret(slug) },
    disableSso: { allowed: "ADMIN", call: (slug) => ssoSettings.disableSso(slug) },
    setSsoSignInUrl: {
      allowed: "ADMIN",
      call: (slug) => ssoSettings.setSsoSignInUrl(slug, form({ signInUrl: "https://app.example.com/login" })),
    },
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
    widgetAskPerson: {
      allowed: "public",
      // The conversation is the AI's (the matrix's project has articles): handing it over asks for a summary.
      before: () => model.reply("They need help."),
      call: async (slug) => {
        const token = await inboxToken(slug);
        return widgetInbox.widgetAskPerson(slug, token, await startedNumber(slug, token));
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
    // Only the news of whoever the token is for.
    widgetIdeaNews: {
      allowed: "public",
      call: async (slug) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        return widget.widgetIdeaNews(slug, widgetToken(project.id, users.MEMBER.id));
      },
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
    // Reads only what the portal shows whoever's asking.
    widgetIdeas: { allowed: "public", call: (slug) => widget.widgetIdeas(slug, null) },
    widgetVote: {
      allowed: "public",
      takesIds: true,
      call: async (slug, f) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        return widget.widgetVote(slug, widgetToken(project.id, users.MEMBER.id), f.postId, true);
      },
    },
    widgetReacted: { allowed: "public", call: (slug) => widget.widgetReacted(slug, null, 1) },
    widgetReact: {
      allowed: "public",
      call: async (slug) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        return widget.widgetReact(slug, widgetToken(project.id, users.MEMBER.id), 1, "tada", true);
      },
    },
    widgetComments: {
      allowed: "public",
      call: async (slug) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        return widget.widgetComments(slug, widgetToken(project.id, users.MEMBER.id), 1);
      },
    },
    widgetComment: {
      allowed: "public",
      call: async (slug) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        return widget.widgetComment(slug, widgetToken(project.id, users.MEMBER.id), 1, {}, form({ body: "Nice" }));
      },
    },
    // Its author's own: the other project's owner wrote it (see editChangelogComment), its token theirs.
    widgetEditComment: {
      allowed: "public",
      takesIds: true,
      call: async (slug, f) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        return widget.widgetEditComment(slug, widgetToken(project.id, users.outsider.id), 1, f.entryCommentId, {}, form({ body: "Edited" }));
      },
    },
    widgetDeleteComment: {
      allowed: "public",
      takesIds: true,
      call: async (slug, f) => {
        const project = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
        return widget.widgetDeleteComment(slug, widgetToken(project.id, users.outsider.id), 1, f.entryCommentId);
      },
    },
  },
  screenshots: {
    saveScreenshotSettings: {
      allowed: "ADMIN",
      call: (slug) => screenshots.saveScreenshotSettings(slug, {}, form({ appUrl: "https://app.example.com", signIn: "password", username: "e2e-demo@example.com", password: "demo", window: "phone" })),
    },
    // Browser Use (the fake) signs in and takes the screen it lands on, inline; the fixture's project is set up for it.
    testScreenshots: { allowed: "ADMIN", call: (slug) => withEnv(browserUse.env, () => screenshots.testScreenshots(slug)) },
  },
  rewrite: {
    // An article's selection (the model fake answers); nothing is saved.
    rewriteText: {
      allowed: "MEMBER",
      before: () => model.reply(JSON.stringify({ notes: "Shipped." })),
      call: (slug) =>
        rewrite.rewriteText(slug, {
          kind: "article",
          text: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "We shipped it today." }] }] },
          instruction: "Shorter",
        }),
    },
  },
  images: {
    // The model fake makes it; uploads keep it.
    generateImage: {
      allowed: "MEMBER",
      takesIds: true,
      call: (slug, f) => images.generateImage(slug, { prompt: "A lighthouse", width: 320, height: 200, references: [f.imageId] }),
    },
  },
  webhooks: {
    createWebhook: { allowed: "ADMIN", call: (slug) => webhooks.createWebhook(slug, receiver.url, ["post.created"]) },
    deleteWebhook: { allowed: "ADMIN", takesIds: true, call: (slug, f) => webhooks.deleteWebhook(slug, f.webhookId) },
    sendTestWebhook: { allowed: "ADMIN", takesIds: true, call: (slug, f) => webhooks.sendTestWebhook(slug, f.webhookId) },
  },
  // The inbox's workflows are settings: owners and admins only, like Settings → Inbox.
  workflows: {
    // Saving an existing one, so another project's workflow id is refused too (creating, with null, is the same check without an id).
    saveWorkflow: {
      allowed: "ADMIN",
      takesIds: true,
      call: (slug, f) => workflows.saveWorkflow(slug, f.workflowId, { name: "Priority", trigger: "conversation_started", actions: [{ kind: "mark_priority" }] }),
    },
    moveWorkflow: { allowed: "ADMIN", takesIds: true, call: (slug, f) => workflows.moveWorkflow(slug, f.workflowId, 0) },
    deleteWorkflow: { allowed: "ADMIN", takesIds: true, call: (slug, f) => workflows.deleteWorkflow(slug, f.workflowId) },
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
let githubFake: GithubFake;
let stripe: StripeFake;
let featurebaseFake: FeaturebaseFake;
let receiver: WebhookReceiver;
let browserUse: BrowserUseFake;
let users: Record<TeamRole | "outsider" | "ssoUser", TestUser>;
let otherProject: Awaited<ReturnType<typeof createProject>>;

const ses = await startSesFake();

beforeAll(async () => {
  s3 = await startS3Fake();
  // Webhook fixtures deliver to a local fake receiver.
  receiver = await startWebhookReceiver();
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  model = await startModelFake();
  githubFake = await startGithubFake();
  // Buying credits and plans opens the local Stripe fake's pages (with credits or plans on just for that call).
  stripe = await startStripeFake();
  featurebaseFake = await startFeaturebaseFake();
  browserUse = await startBrowserUseFake();
  for (const [name, value] of Object.entries({ ...s3.env, ...model.env, ...stripe.env, ...featurebaseFake.env })) {
    vi.stubEnv(name, value);
  }
  dns = await startDnsFake();
  vi.stubEnv("TUTI_CONFIG", configFile({ customDomains: { target: "customers.example.net" } }));
  vi.stubEnv("DNS_LOOKUP_URL", dns.url);
  site = await startSiteFake();
  // Licence checks ask the local site, never tuti.so: it has no licence server (its own 404), so "unreachable".
  vi.stubEnv("LICENSE_SERVER_URL", site.origin);
  const [OWNER, ADMIN, MEMBER, outsider, ssoUser] = await Promise.all(
    ["Owner", "Admin", "Member", "Outsider", "SSO user"].map((name) => signUp(name)),
  );
  users = { OWNER: OWNER!, ADMIN: ADMIN!, MEMBER: MEMBER!, outsider: outsider!, ssoUser: ssoUser! };
  otherProject = await createProject(users.outsider);
  // The account that's allowed to act on its own email invites (allowedActor for "signed in"), and the ones allowed to
  // send invites (only from a verified address).
  await prisma.user.updateMany({ where: { id: { in: [users.outsider.id, users.OWNER.id, users.ADMIN.id] } }, data: { emailVerified: true } });
  await prisma.ssoIdentity.create({
    data: { projectId: otherProject.id, externalId: "ext-1", userId: users.ssoUser.id },
  });
});

afterAll(() => Promise.all([s3.close(), receiver.close(), model.close(), dns.close(), site.close(), githubFake.close(), stripe.close(), featurebaseFake.close(), ses.close(), browserUse.close()]));
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
  // Replies from its own domain, verified (Settings → Inbox and email), which SES (the fake) has for it.
  const emailDomain = `${project.slug}.example.com`;
  await prisma.emailDomain.create({ data: { projectId, domain: emailDomain, address: `support@${emailDomain}`, dkimTokens: [], verifiedAt: new Date() } });
  ses.identities.set(emailDomain, { tags: { "tuti-project": projectId }, tokens: [], configurationSet: "tuti-test", verified: true });
  await prisma.teamMember.createMany({
    data: [
      { projectId, userId: users.ADMIN.id, role: "ADMIN" },
      { projectId, userId: users.MEMBER.id, role: "MEMBER" },
    ],
  });
  // German besides English (Settings → Languages): Manual for new pages, so publishing asks no model for a translation.
  await prisma.projectLanguage.create({ data: { projectId, code: "de", automatic: false } });
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
  const comment = await prisma.comment.create({ data: { projectId, postId: post!.id, authorId: users.OWNER.id, body: "A comment to like" } });
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
  const unsentInvitation = await prisma.invitation.create({
    data: {
      projectId,
      email: `e2e-${crypto.randomUUID()}@example.com`,
      tokenHash: hashInvitationToken(crypto.randomUUID()),
      createdById: users.OWNER.id,
      expiresAt: new Date(Date.now() + 60_000),
      sentAt: null,
    },
  });
  // An upload by the account that's allowed to act as "signed in", waiting to be finished. Made two
  // hours ago, so one per case doesn't use up that account's hourly upload limit.
  const upload = await prisma.media.create({
    data: { projectId, uploaderId: users.outsider.id, size: 4, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  });
  s3.objects.set(`uploads/${upload.id}`, { body: Buffer.from("fake"), contentType: "image/png" });
  // A finished image (a reference for generateImage), its one stored size in place.
  const image = await prisma.media.create({ data: { projectId, uploaderId: users.OWNER.id, size: 4, status: "READY", width: 32, height: 20 } });
  for (const width of imageWidths(32)) {
    s3.objects.set(imageKey(image.id, width), { body: await sharp({ create: { width, height: 20, channels: 3, background: "#3a7" } }).webp().toBuffer(), contentType: "image/webp" });
  }
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
  await prisma.project.update({ where: { id: projectId }, data: { changelogCount: 3 } });
  await prisma.changelogEntry.createMany({
    data: [
      { projectId, number: 1, title: "Matrix entry", publishedAt: new Date() },
      { projectId, number: 2, title: "Matrix draft", body: "Shipped" },
      // A line asking for a screenshot, for Take screenshots.
      { projectId, number: 3, title: "Matrix screenshots", body: "[Screenshot: The dashboard]" },
    ],
  });
  const entryComment = await prisma.changelogComment.create({
    data: { entry: { connect: { projectId_number: { projectId, number: 1 } } }, author: { connect: { id: users.outsider.id } }, body: "A comment", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A comment" }] }] } },
  });
  await prisma.portalReader.create({ data: { projectId, email: "e2e-reader@example.com" } });
  const redirect = await prisma.portalRedirect.create({ data: { projectId, from: "/old/matrix", to: "/docs" } });
  // A workflow, to move and delete.
  const spamRule = await prisma.spamRule.create({ data: { projectId, field: "subject", matcher: "contains", value: "matrix" } });
  const workflow = await prisma.workflow.create({ data: { projectId, name: "Matrix workflow", trigger: "conversation_started", position: 0, actions: [{ kind: "mark_priority" }] } });
  // Screenshots set up, for their Test.
  await prisma.screenshotSettings.create({ data: { projectId, appUrl: "https://app.example.com" } });
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
  await call(createApiReference, { actor: { kind: "user", userId: users.OWNER.id }, projectId }, { name: "Matrix API", spec: MATRIX_SPEC });
  // One read from a URL (the local site), to sync.
  site.answer("/matrix-openapi.json", MATRIX_SPEC);
  site.answer("/matrix-openapi-2.json", MATRIX_SPEC);
  await call(createApiReference, { actor: { kind: "user", userId: users.OWNER.id }, projectId }, { name: "Matrix URL API", url: `${site.origin}/matrix-openapi.json` });
  // Set up, not something the matrix checks: it doesn't count against the owner's fetch limit (one a project, over many).
  await prisma.apiReferenceFetch.deleteMany({ where: { userId: users.OWNER.id } });
  // A reader group no collection is for.
  await prisma.readerGroup.create({ data: { projectId, key: "beta", name: "Beta", conditions: inGroupNamed("beta") } });
  await prisma.article.createMany({
    data: [
      { projectId, slug: "matrix-article", title: "Matrix article", publishedAt: new Date(), collectionId: basics.id },
      { projectId, slug: "matrix-draft", title: "Matrix draft" },
      // A line asking for a screenshot, for Take screenshots.
      { projectId, slug: "matrix-screenshots", title: "Matrix screenshots", body: "[Screenshot: The dashboard]" },
    ],
  });
  // The published article's German (Manual in the fixture), for its editor's language pill.
  const translated = await prisma.article.findFirstOrThrow({ where: { projectId, slug: "matrix-article" }, select: { id: true } });
  // A section of the team's whose English went since: behind, for Update those sections (the job takes it out).
  const gone = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Weg" }] }, { type: "paragraph", content: [{ type: "text", text: "Nicht mehr da." }] }] };
  await prisma.articleTranslation.create({
    data: { articleId: translated.id, projectId, language: "de", automatic: false, title: "Matrix-Artikel", content: gone, sections: [{ key: "Gone\u001f0", hash: "gone", own: true }], publishedAt: new Date() },
  });
  const question = await prisma.docsQuestion.create({
    data: { projectId, askerId: "matrix-reader", question: "How do I invite?", source: "PORTAL", status: "ANSWERED", answer: "From the Team page." },
  });
  // "Ask a person" is on (it starts a conversation in the inbox), and an anonymous reader just got "I don't know".
  await prisma.project.update({ where: { id: projectId }, data: { supportInbox: true } });
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
      // One included already, for Verify to read.
      // And one an API reference is read from.
      included: {
        create: [
          { repoId: 90_000 + githubRepoId, fullName: `acme/docs-${githubRepoId}` },
          { repoId: 95_000 + githubRepoId, fullName: `acme/spec-${githubRepoId}` },
        ],
      },
    },
  });
  // Merged pull requests on the included repository (GitHub, the fake): #5 to add to the changelog, #4 in draft #2 to take out.
  githubFake.pullRequest(`acme/docs-${githubRepoId}`, { number: 5, title: "Add a dark theme", mergedAt: new Date().toISOString() });
  githubFake.pullRequest(`acme/docs-${githubRepoId}`, { number: 4, title: "Speed up search", mergedAt: new Date().toISOString() });
  await prisma.changelogEntryPullRequest.create({
    data: {
      entry: { connect: { projectId_number: { projectId, number: 2 } } },
      url: `https://github.com/acme/docs-${githubRepoId}/pull/4`,
      repo: `acme/docs-${githubRepoId}`,
      number: 4,
      title: "Speed up search",
    },
  });
  // An API reference read from a file in that repository (GitHub, the fake), to change to another file.
  githubFake.repository(`acme/spec-${githubRepoId}`, { commit: `matrix-${githubRepoId}`, files: { "openapi.json": MATRIX_SPEC, "openapi-2.json": MATRIX_SPEC } });
  await withEnv(githubFake.env, () =>
    call(createApiReference, { actor: { kind: "user", userId: users.OWNER.id }, projectId }, { name: "Matrix GitHub API", github: { repoId: 95_000 + githubRepoId, path: "openapi.json" } }),
  );
  await prisma.apiReferenceFetch.deleteMany({ where: { userId: users.OWNER.id } });
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
  const planLicense = await prisma.planLicense.create({ data: { source: "manual", externalKey: crypto.randomUUID(), plan: "pro", userId: users.ADMIN.id } });
  const unclaimed = await prisma.planLicense.create({ data: { source: "appsumo", externalKey: crypto.randomUUID(), plan: "pro" } });
  const outsiderProject = await createProject(users.outsider);
  const assignedPlanLicense = await prisma.planLicense.create({
    data: { source: "manual", externalKey: crypto.randomUUID(), plan: "pro", userId: users.outsider.id, projectId: outsiderProject.id },
  });
  return {
    slug: project.slug,
    projectId,
    planLicenseId: planLicense.id,
    assignedPlanLicenseId: assignedPlanLicense.id,
    planLicenseClaim: claimToken("appsumo", unclaimed.externalKey),
    codeChangeId: codeChange.id,
    linkActionId: codeChange.actions.find((action) => action.kind === "LINKS")!.id,
    dismissActionId: codeChange.actions.find((action) => action.kind === "MOVES_FORWARD" && action.status === "PENDING")!.id,
    appliedActionId: codeChange.actions.find((action) => action.kind === "RESOLVES")!.id,
    scheduledActionId: codeChange.actions.find((action) => action.kind === "MOVES_FORWARD" && action.status === "SCHEDULED")!.id,
    stoppableActionId: codeChange.actions.find((action) => action.kind === "ARTICLE_EDIT")!.id,
    githubRepoId,
    specRepoId: 95_000 + githubRepoId,
    redirectId: redirect.id,
    workflowId: workflow.id,
    spamRuleId: spamRule.id,
    linkId: link.id,
    webhookId: webhook.id,
    apiKeyId: apiKey.id,
    mediaId: upload.id,
    imageId: image.id,
    emailInvitationId: emailInvitation.id,
    boardId: board.id,
    emptyBoardId: emptyBoard.id,
    postId: post!.id,
    commentId: comment.id,
    entryCommentId: entryComment.id,
    duplicateId: duplicate!.id,
    suggestionId: suggestion.id,
    invitationId: invitation.id,
    invitationToken,
    unsentInvitationId: unsentInvitation.id,
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

/**
 * Procedures (server/trpc), as the app, REST and MCP call them: one per kind of `access`, each refused to everyone below
 * its level without changing anything (signed out, another project's team or single sign-on user, a portal's session,
 * lower roles, a key with another project's slug, a read-only key for a write) and run by the lowest level allowed and
 * by a read and write key. Screens add theirs here as they move onto the router (docs/plan.md, "One way in").
 */
type Caller = Awaited<ReturnType<typeof callerAs>>;
type ProcedureCase = Omit<Case, "call" | "takesIds"> & { scope: "read" | "write"; call: (caller: Caller, slug: string) => Promise<unknown> };

const procedures: { [N in OperationName]?: ProcedureCase } = {
  "aiFirst.get": { allowed: "ADMIN", scope: "read", call: (caller, slug) => caller.aiFirst.get({ project: slug }) },
  "aiFirst.update": { allowed: "ADMIN", scope: "write", call: (caller, slug) => caller.aiFirst.update({ project: slug, widget: false, email: true, name: "Ada" }) },
  "changelog.update": { allowed: "MEMBER", scope: "write", call: (caller, slug) => caller.changelog.update({ project: slug, number: 1, title: "Renamed by the matrix" }) },
  // Owners only (plans are off here, so every project has Advanced tuning).
  "codeChangesTuning.update": { allowed: "OWNER", scope: "write", call: (caller, slug) => caller.codeChangesTuning.update({ project: slug, "decide.rounds": 6 }) },
  // The team's names and roles, and the project's own setup: the team's (a key counts as the team), never anyone signed in.
  // The Inbox's list pane, and a teammate's own "Email me new conversations" (a key: its creator's).
  "inbox.list": { allowed: "MEMBER", scope: "read", call: (caller, slug) => caller.inbox.list({ project: slug, q: "Post", overview: true }) },
  "inbox.newConversationEmails": { allowed: "MEMBER", scope: "write", call: (caller, slug) => caller.inbox.newConversationEmails({ project: slug, on: false }) },
  "team.list": { allowed: "MEMBER", scope: "read", call: (caller, slug) => caller.team.list({ project: slug }) },
  "project.get": { allowed: "MEMBER", scope: "read", call: (caller, slug) => caller.project.get({ project: slug }) },
  "project.update": { allowed: "ADMIN", scope: "write", call: (caller, slug) => caller.project.update({ project: slug, name: "Renamed by the matrix" }) },
  "votes.set": { allowed: "signed in", refusesSsoUsers: true, scope: "write", call: (caller, slug) => caller.votes.set({ project: slug, number: 1, voted: true }) },
};

/** What a procedure call did: ok, or the tRPC error's code (any other failure fails the test). */
async function procedureOutcome(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code;
    }
    throw error;
  }
}

const REFUSED = /^(UNAUTHORIZED|FORBIDDEN|NOT_FOUND)$/;

test.each(Object.entries(procedures).map(([name, rule]) => ({ name, rule: rule! })))("procedure $name", async ({ rule }) => {
  const fixture = await createFixture();
  const readKey = { apiKeyId: fixture.apiKeyId };
  const writeKey = {
    apiKeyId: (await prisma.apiKey.create({ data: { projectId: fixture.projectId, name: "Write", scope: "WRITE", keyHash: crypto.randomUUID(), prefix: "tuti_w", createdById: users.OWNER.id } })).id,
  };
  // Another project's key, naming this project.
  const otherKey = { apiKeyId: (await prisma.apiKey.create({ data: { projectId: otherProject.id, name: "Other", scope: "WRITE", keyHash: crypto.randomUUID(), prefix: "tuti_o", createdById: users.outsider.id } })).id };
  const before = await snapshot();

  for (const actor of refusedActors({ ...rule, call: async () => {} })) {
    expect({ actor, outcome: await procedureOutcome(rule.call(await callerAs(userFor(actor)), fixture.slug)) }).toEqual({ actor, outcome: expect.stringMatching(REFUSED) });
  }
  // A teammate naming another project's slug, and keys naming a project not theirs.
  expect(await procedureOutcome(rule.call(await callerAs(users.OWNER), otherProject.slug))).toMatch(REFUSED);
  expect(await procedureOutcome(rule.call(await callerAs(writeKey), otherProject.slug))).toMatch(REFUSED);
  expect(await procedureOutcome(rule.call(await callerAs(otherKey), fixture.slug))).toMatch(REFUSED);
  if (rule.scope === "write") {
    expect(await procedureOutcome(rule.call(await callerAs(readKey), fixture.slug))).toBe("FORBIDDEN");
  }
  expect(await snapshot()).toEqual(before);

  // A portal's session, even an owner's: a reader's, never the team's.
  const reader = await signUp("Portal reader");
  await prisma.teamMember.create({ data: { projectId: fixture.projectId, userId: reader.id, role: "OWNER" } });
  await onPortal(reader, { id: fixture.projectId, slug: fixture.slug });
  const asReader = await procedureOutcome(rule.call(await callerAs(reader), fixture.slug));
  if (rule.allowed === "signed in" || rule.allowed === "public") {
    expect(asReader).toBe("ok");
  } else {
    expect(asReader).toMatch(REFUSED);
  }
  request.host = "";

  rule.before?.();
  expect(await procedureOutcome(rule.call(await callerAs(userFor(allowedActor({ ...rule, call: async () => {} }))), fixture.slug))).toBe("ok");
  if (rule.scope === "read") {
    expect(await procedureOutcome(rule.call(await callerAs(readKey), fixture.slug))).toBe("ok");
  }
  expect(await procedureOutcome(rule.call(await callerAs(writeKey), fixture.slug))).toBe("ok");
});
