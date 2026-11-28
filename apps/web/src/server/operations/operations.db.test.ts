import { randomUUID } from "node:crypto";

import { originalKey } from "@tuti/content";
import { prisma } from "@tuti/db";
import { billingFile, type BrowserUseFake, configFile, type DnsFake, startBrowserUseFake, type GithubFake, type ModelFake, type S3Fake, type SiteFake, startDnsFake, startGithubFake, startModelFake, startS3Fake, startSiteFake, startStripeFake, type StripeFake } from "@tuti/testkit";
import { type ApiDoc, readSpec, settle } from "@tuti/shared/api-reference";
import { type SesFake, startSesFake } from "@tuti/testkit/ses";
import { languageTranslationsDone, translationSource } from "@tuti/jobs";
import { contentHash } from "@tuti/shared";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { DELETE, GET, PATCH, POST } from "@/app/api/v1/[...path]/route";
import { createApiKey } from "@/server/api-keys";
import { upsertProjectUser } from "@/server/project-users";
import { actAs, callerAs, createProject, inGroupNamed, signUp, type TestUser } from "@/test/helpers";

import { allOperations, type OperationName, operations, type PublicOperation } from "./index";
import { errorStatuses } from "./openapi";

/**
 * Every operation on the API surface (REST; MCP serves the same operations with
 * the same key check, see app/api/mcp/mcp.db.test.ts): a read-only key may run reads
 * and is refused writes without changing anything; a read and write key may run
 * everything; another project's key never reaches this project's data. In the
 * app, operations run through server actions, which the authorization matrix
 * (server/authorization.db.test.ts) covers. The type lists every operation, so a
 * new one doesn't compile until it's added here.
 */

type Fixture = Awaited<ReturnType<typeof createFixture>>;
/** An API reference's spec, with one operation (key "GET /matrix"). */
const MATRIX_SPEC = JSON.stringify({ openapi: "3.1.0", info: { title: "Matrix API", version: "1" }, paths: { "/matrix": { get: { summary: "List matrix" } } } });
/** A valid call: path values and the rest of the input. */
const cases: Record<OperationName, (f: Fixture) => Record<string, unknown>> = {
  "aiFirst.get": () => ({}),
  // Each changed from the fixture's, so a refused write would show.
  "aiFirst.update": () => ({ widget: false, email: true, name: "Ada" }),
  // Like usage.get: admins only in the app (each feature's AI model, under Settings → AI).
  "aiModels.get": () => ({}),
  "aiModels.setting": () => ({ group: "changelog" }),
  "aiModels.update": () => ({ answers: "acme/tiny", changelog: "" }),
  "apiReferences.create": () => ({ name: "Public API", spec: MATRIX_SPEC }),
  "apiReferences.delete": () => ({ slug: "matrix-reference" }),
  "apiReferences.get": () => ({ slug: "matrix-reference", spec: true }),
  "apiReferences.list": () => ({}),
  "apiReferences.replace": () => ({ slug: "matrix-reference", spec: MATRIX_SPEC.replace("List matrix", "List them") }),
  "apiReferences.sync": () => ({ slug: "matrix-url-reference" }),
  "apiReferences.update": () => ({ slug: "matrix-reference", name: "Renamed by the matrix", hide: ["GET /matrix"] }),
  "articles.create": () => ({ title: "From the matrix", body: "Read me", collection: "basics" }),
  "articles.delete": () => ({ slug: "matrix-article" }),
  "articles.discardChanges": () => ({ slug: "matrix-article" }),
  "articles.feedback": () => ({ slug: "matrix-article", helpful: false, comment: "From the matrix", author: { id: "matrix-reader" } }),
  "articles.get": () => ({ slug: "matrix-article" }),
  "articles.getTranslation": () => ({ slug: "matrix-article", language: "de" }),
  // Turned off (as the fixture's German is, or becomes): from the read's `version`, as articles.getTranslation gives it.
  "articles.keepTranslationUpToDate": (f) => ({ slug: "matrix-article", language: "de", keepUpToDate: false, version: f.translationVersion }),
  "articles.languageSlug": () => ({ slug: "matrix-article", language: "de", newSlug: "matrix-seite" }),
  "articles.list": () => ({}),
  "articles.publish": (f) => ({ slug: "matrix-draft", revision: f.revisionId }),
  "articles.publishChanges": () => ({ slug: "matrix-article" }),
  "articles.publishTranslation": () => ({ slug: "matrix-article", language: "de" }),
  "articles.reorder": () => ({ slug: "matrix-draft", collection: "basics", position: 0 }),
  "articles.restore": (f) => ({ slug: "matrix-draft", revision: f.revisionId }),
  "articles.revisions": () => ({ slug: "matrix-article" }),
  "articles.saveTranslation": (f) => ({ slug: "matrix-article", language: "de", version: f.translationVersion, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Von der Matrix." }] }] } }),
  "articles.screenshotsStatus": () => ({ slug: "matrix-screenshots" }),
  "articles.search": () => ({ q: "matrix" }),
  "articles.takeScreenshots": () => ({ slug: "matrix-screenshots", shots: [{ show: "The dashboard" }] }),
  "articles.unpublish": () => ({ slug: "matrix-article" }),
  "articles.update": () => ({ slug: "matrix-draft", title: "Renamed by the matrix", collection: null }),
  // Its one section (the text before any heading), translated again in the background (see the write's case below).
  "articles.updateTranslation": () => ({ slug: "matrix-article", language: "de", sections: ["\u001f0"] }),
  "articles.verifications": () => ({ slug: "matrix-article" }),
  // With AI on (see below) and a repository: GitHub isn't set up here, so the run stops there, unread.
  "articles.verify": () => ({ slug: "matrix-article" }),
  // People only: every key is refused (below).
  "articles.verifyAll": () => ({}),
  "assistant.get": () => ({}),
  // Like widget.update: admins only in the app (see the authorization matrix).
  "assistant.update": () => ({ tone: "Plain", length: "short", instructions: "Say hi", offLimits: ["refund"] }),
  "boards.getTranslations": () => ({ slug: "feature-requests" }),
  "boards.list": () => ({}),
  "boards.updateTranslation": () => ({ slug: "feature-requests", language: "de", keepUpToDate: false, name: "Funktionswünsche" }),
  "branding.get": () => ({}),
  // Like widget.update: admins only in the app (see the authorization matrix).
  "branding.update": () => ({ color: "#5b21b6", headerLinks: [{ label: "Docs", url: "https://docs.example.com" }], poweredBy: true }),
  "changelog.addPullRequests": () => ({ pullRequests: [{ repo: "acme/matrix", number: 5 }] }),
  "changelog.composeCover": () => ({ number: 1 }),
  "changelog.cover": () => ({ number: 1, design: "title" }),
  "changelog.create": () => ({ title: "From the matrix", body: "Shipped", tags: ["new"], posts: [1] }),
  "changelog.delete": () => ({ number: 1 }),
  "changelog.draft": () => ({ number: 2 }),
  "changelog.editSection": () => ({ number: 1, append: true, markdown: "Added by the matrix." }),
  "changelog.get": () => ({ number: 1 }),
  // The published entry's German (Manual in the fixture): read it, then turn Keep up to date off (a write that needs no `version`).
  "changelog.getTranslation": () => ({ number: 1, language: "de" }),
  "changelog.list": () => ({}),
  "changelog.missingChanges": () => ({}),
  "changelog.publish": () => ({ number: 1 }),
  "changelog.react": () => ({ number: 1, reaction: "tada", reacted: true }),
  "changelog.removePullRequest": () => ({ number: 2, url: "https://github.com/acme/matrix/pull/4" }),
  "changelog.saveTranslation": (f) => ({ number: 1, language: "de", keepUpToDate: false, version: f.changelogVersion }),
  // The editors' polls while screenshots are taken, and the covers to pick from.
  "changelog.screenshotsStatus": () => ({ number: 3 }),
  "changelog.seen": () => ({ at: "2026-10-20T09:00:00Z", author: { id: "matrix-reader" } }),
  "changelog.takeScreenshots": () => ({ number: 3, shots: [{ show: "The dashboard" }] }),
  "changelog.unpublish": () => ({ number: 1 }),
  "changelog.update": () => ({ number: 1, title: "Renamed by the matrix" }),
  "changelogComments.create": () => ({ number: 1, body: "From the matrix" }),
  "changelogComments.delete": (f) => ({ number: 1, id: f.entryCommentId }),
  "changelogComments.list": () => ({ number: 1 }),
  // The key's creator wrote it.
  "changelogComments.update": (f) => ({ number: 1, id: f.entryCommentId, body: "Edited by the matrix" }),
  "changelogStyle.cover": () => ({ design: "title" }),
  "changelogStyle.get": () => ({}),
  "changelogStyle.settings": () => ({}),
  "changelogStyle.update": () => ({ tone: "Friendly", examples: [1] }),
  "changelogSubscribers.add": () => ({ emails: ["e2e-matrix-subscriber@example.com"] }),
  "changelogSubscribers.list": () => ({}),
  "changelogSubscribers.remove": () => ({ emails: ["e2e-matrix-subscriber@example.com"] }),
  "codeChangeActions.apply": (f) => ({ id: f.linkActionId }),
  "codeChangeActions.applyMany": (f) => ({ actions: [{ id: f.linkActionId }] }),
  "codeChangeActions.dismiss": (f) => ({ id: f.dismissActionId, reason: "Not this one" }),
  "codeChangeActions.publishNow": (f) => ({ id: f.scheduledActionId }),
  "codeChangeActions.stop": (f) => ({ id: f.stoppableActionId }),
  "codeChangeActions.undo": (f) => ({ id: f.appliedActionId }),
  // With AI on (see below); its repository isn't the project's, so it stops there, unread.
  "codeChanges.analyse": (f) => ({ id: f.codeChangeId }),
  "codeChanges.button": (f) => ({ id: f.codeChangeId, actions: [f.linkActionId] }),
  "codeChanges.get": (f) => ({ id: f.codeChangeId }),
  "codeChanges.list": () => ({}),
  // With AI on and nothing paused, it resumes none.
  "codeChanges.resume": () => ({}),
  "codeChanges.target": (f) => ({ type: "feedback", id: f.postId }),
  "codeChanges.targets": () => ({}),
  // Owners only in the app; a key works while whoever created it owns the project (see code-changes-tuning.db.test.ts).
  "codeChangesTuning.get": () => ({}),
  "codeChangesTuning.update": () => ({ "decide.rounds": 6 }),
  "collections.create": () => ({ name: "Billing" }),
  "collections.delete": () => ({ slug: "basics" }),
  // German, which the fixture adds: the team's own (keeping it up to date would queue the labels job).
  "collections.getTranslations": () => ({ slug: "guides" }),
  "collections.list": () => ({}),
  "collections.reorder": () => ({ slug: "guides", parent: "basics", position: 0 }),
  "collections.update": () => ({ slug: "basics", name: "The basics", parent: "guides" }),
  "collections.updateTranslation": () => ({ slug: "guides", language: "de", keepUpToDate: false, name: "Anleitungen" }),
  "comments.create": () => ({ number: 1, body: "From the matrix" }),
  "comments.like": (f) => ({ number: 1, id: f.commentId, liked: true }),
  "comments.list": () => ({ number: 1 }),
  "companies.list": () => ({}),
  "conversations.activity": () => ({ number: 1 }),
  "conversations.articles": () => ({ number: 1, q: "matrix" }),
  "conversations.assignees": () => ({}),
  "conversations.create": () => ({ email: "e2e-matrix-asker@example.com", body: "From the matrix" }),
  "conversations.get": () => ({ number: 1 }),
  "conversations.linkPost": () => ({ number: 1, post: 1 }),
  "conversations.list": () => ({ status: "open", q: "matrix" }),
  "conversations.markRead": () => ({ number: 1, seen: new Date().toISOString() }),
  "conversations.person": () => ({ number: 1 }),
  "conversations.reply": () => ({ number: 1, body: "From the matrix", requestId: `matrix-${randomUUID()}` }),
  // No message's translation failed in the fixture: nothing is queued.
  "conversations.retryTranslation": () => ({ number: 1 }),
  // Nothing in the fixture's docs is close to what was asked: no draft, and the model isn't asked.
  "conversations.suggestReply": () => ({ number: 1 }),
  "conversations.summarize": () => ({ number: 1 }),
  // Translation is off in the fixture: not_translated, and the model isn't asked.
  "conversations.translateReply": () => ({ number: 1, body: "From the matrix" }),
  "conversations.unlinkPost": () => ({ number: 1, post: 1 }),
  "conversations.update": () => ({ number: 1, status: "closed" }),
  // People only: every key is refused (below).
  "conversations.upload": () => ({ filename: "matrix.pdf", contentType: "application/pdf", size: 1000 }),
  "conversations.views": () => ({}),
  // Like usage.get: admins only in the app (Settings → Billing).
  "credits.get": () => ({}),
  // Like credits.get: admins only in the app (Buy credits); a Stripe Checkout page from the local fake.
  "credits.topUp": () => ({ dollars: 10 }),
  "customize.preview": () => ({ path: "/" }),
  // People only too, and a device only from the app's session (devices.db.test.ts).
  "devices.register": () => ({ deviceId: "matrix-phone", token: "ExponentPushToken[matrix]", platform: "ios" }),
  "devices.remove": () => ({ deviceId: "matrix-phone" }),
  "docs.ask": () => ({ q: "How do I invite my team?" }),
  "docs.dismissGap": () => ({ question: "How do I invite?" }),
  // A question the read and write key asked (another key's question is refused: see docs-escalate.db.test.ts).
  "docs.escalate": (f) => ({ questionId: f.questionId, email: `e2e-${crypto.randomUUID()}@example.com`, note: "From the matrix" }),
  "docs.insights": () => ({}),
  "domain.get": () => ({}),
  "domain.remove": () => ({}),
  // Like portal.update: admins only in the app.
  "domain.set": () => ({ hostname: "help.example.org" }),
  "domain.verify": () => ({}),
  "duplicates.dismiss": (f) => ({ id: f.suggestionId }),
  "duplicates.list": () => ({}),
  "emailPreferences.update": () => ({ followedPosts: false, author: { id: "matrix-reader" } }),
  // Connecting GitHub (the /api/github routes): a state that isn't ours finishes nothing ("expired").
  "githubConnect.finish": () => ({ state: "not-a-state" }),
  "githubConnect.get": () => ({}),
  "githubRepositories.list": () => ({}),
  "glossary.get": () => ({}),
  "glossary.update": () => ({ terms: [{ term: "Acme", keep: true }, { term: "Board", translations: { de: "Tafel" } }] }),
  // Like portal.update: admins only in the app.
  "groups.create": () => ({ name: "Enterprise", conditions: [{ property: "plan", op: "is_any_of", value: ["enterprise", "custom"] }] }),
  "groups.delete": () => ({ group: "beta" }),
  "groups.list": () => ({}),
  "groups.preview": () => ({ conditions: [{ property: "plan", op: "is", value: "pro" }] }),
  "groups.update": () => ({ group: "beta", name: "Beta testers", conditions: [{ property: "beta", op: "is", value: "true" }] }),
  "groups.values": () => ({ property: "plan" }),
  "images.generate": () => ({ prompt: "A lighthouse", width: 320, height: 200 }),
  "imports.get": () => ({}),
  // People only: every key is refused (below).
  "imports.start": () => ({ source: "featurebase", key: "sk_matrix", parts: ["contacts"] }),
  // Internal (tRPC only): through the caller, below.
  "inbox.conversation": () => ({ number: 1, view: "closed", q: "matrix" }),
  "inbox.findPosts": () => ({ q: "matrix" }),
  "inbox.language": () => ({ number: 1 }),
  // Internal (the app's only, through tRPC): run through the caller as a teammate, below.
  "inbox.list": () => ({ q: "matrix", overview: true }),
  "inbox.newConversationEmails": () => ({ on: false }),
  "languages.get": () => ({}),
  // German, which the fixture adds (Manual for new pages, so nothing is asked of the model).
  "languages.retranslate": () => ({ code: "de", waiting: true }),
  "languages.update": () => ({ languages: [{ code: "de", instructions: "Use du." }] }),
  // Like branding.update: admins only in the app (Check now, Customize → Branding → Powered by tuti).
  "license.check": () => ({}),
  "links.remove": (f) => ({ number: 1, id: f.linkId }),
  "live.inbox": () => ({}),
  // A key reads its creator's.
  "notifications.get": () => ({}),
  "notifications.update": () => ({ showMessageText: false }),
  // Off on the free plan: nothing to remove (adding it is in plans.db.test.ts).
  "plan.badge": () => ({ on: false }),
  // Like credits.topUp, with plans on for it only; plan.manage opens Stripe's portal for the project's customer (see beforeAll).
  "plan.get": () => ({}),
  "plan.manage": () => ({}),
  "plan.subscribe": () => ({ plan: "pro", interval: "month" }),
  "portal.access": () => ({}),
  // Like branding.update: admins only in the app. The team's keys keep working on a private portal (portal-access.db.test.ts).
  "portal.get": () => ({}),
  "portal.update": () => ({ access: "private", home: "docs" }),
  "portalReaders.add": () => ({ emails: ["e2e-matrix-reader@example.com"] }),
  // Like portal.update: admins only in the app.
  "portalReaders.list": () => ({}),
  "portalReaders.remove": () => ({ email: "e2e-reader@example.com" }),
  "posts.create": () => ({ board: "feature-requests", title: "From the matrix" }),
  "posts.get": () => ({ number: 1 }),
  "posts.list": () => ({}),
  "posts.merge": () => ({ number: 2, into: 1 }),
  // Internal (tRPC only): through the caller, below.
  "posts.similar": () => ({ title: "Dark mode please" }),
  "posts.update": () => ({ number: 1, status: "planned" }),
  "project.get": () => ({}),
  "project.update": () => ({ name: "Renamed by the matrix" }),
  "propertyFormats.update": () => ({ formats: { mrr: { label: "MRR", format: "money" } } }),
  // Like the rest of Customize: admins only in the app.
  "redirects.create": () => ({ from: "/hc/en-us/articles/1", to: "/docs" }),
  "redirects.delete": (f) => ({ id: f.redirectId }),
  "redirects.list": () => ({}),
  "reports.get": () => ({}),
  "roadmap.get": () => ({}),
  // Like the rest of Settings: admins only in the app. The agent is Browser Use's fake; the secret never comes back.
  "screenshotSettings.get": () => ({}),
  "screenshotSettings.scan": () => ({}),
  "screenshotSettings.signInDomains": () => ({}),
  "screenshotSettings.test": () => ({}),
  "screenshotSettings.update": () => ({ signIn: "password", username: "e2e-demo@example.com", password: "matrix-password", window: "phone" }),
  "screenshots.get": (f) => ({ id: f.screenshotRunId }),
  "screenshots.take": () => ({ shots: [{ show: "The dashboard" }] }),
  "settings.access": () => ({}),
  "settings.asking": () => ({}),
  "settings.groups": () => ({}),
  "settings.portal": () => ({}),
  "site.get": () => ({}),
  "site.remove": () => ({}),
  // Like domain.set: admins only in the app.
  "site.set": () => ({ url: `${site.origin}/help` }),
  "site.verify": () => ({}),
  "spam.get": () => ({}),
  "spam.try": () => ({ sender: "e2e-matrix-kim@example.com", subject: "Facebook Admin", text: "Your page will be disabled." }),
  "spam.update": () => ({ addRules: [{ field: "subject_or_body", matcher: "contains", value: "facebook admin" }], block: ["spam.example"], allow: ["e2e-matrix-forms@example.com"] }),
  "sso.disable": () => ({}),
  "sso.get": () => ({}),
  "sso.rotate": () => ({}),
  "sso.update": () => ({ signInUrl: "https://app.example.com/login" }),
  "subscriptions.set": () => ({ number: 1, subscribed: true }),
  "support.checkEmailDomain": () => ({}),
  // Like widget.update: admins only in the app (Settings → Inbox and email).
  "support.get": () => ({}),
  "support.removeEmailDomain": () => ({}),
  // With Amazon SES (the fake; see below): the fixture's project sends from matrix.example.com, so another project can't take it.
  "support.setEmailDomain": () => ({ address: "help@matrix.example.com" }),
  // Off: the fixture has it on (for docs.escalate), so a refused write would show.
  "support.update": () => ({ inbox: false }),
  "tabs.create": () => ({ name: "API" }),
  "tabs.delete": () => ({ slug: "docs" }),
  // German, which the fixture adds: the team's own (keeping it up to date would queue the labels job).
  "tabs.getTranslations": () => ({ slug: "docs" }),
  "tabs.list": () => ({}),
  "tabs.reorder": () => ({ slug: "docs", position: 0 }),
  "tabs.update": () => ({ slug: "docs", name: "Documentation" }),
  "tabs.updateTranslation": () => ({ slug: "docs", language: "de", keepUpToDate: false, name: "Dokumentation" }),
  "team.list": () => ({}),
  "uploads.create": () => ({ type: "image/png", size: 1000 }),
  "uploads.finish": (f) => ({ mediaId: f.uploadId }),
  "uploads.status": (f) => ({ mediaId: f.uploadId }),
  // Like license.check: admins only in the app (Settings → Usage).
  "usage.get": () => ({ months: 3 }),
  "users.delete": () => ({ user: "matrix-user" }),
  "users.get": () => ({ user: "matrix-user" }),
  "users.list": () => ({}),
  // Like groups.create: admins only in the app.
  "users.sync": () => ({ users: [{ id: "matrix-user", properties: { plan: "pro" } }, { id: "matrix-new", email: "e2e-matrix-user@example.com" }] }),
  "votes.set": () => ({ number: 1, voted: true }),
  "widget.get": () => ({}),
  // Keys act as the team (only owners and admins create them); in the app, widget.update is admins only (see the authorization matrix).
  "widget.update": () => ({ label: "Matrix", color: "#5b21b6", links: [{ label: "Status", url: "https://status.example.com" }] }),
  // For a group the fixture has. Owners and admins only in the app (see the authorization matrix).
  "workflows.create": () => ({ name: "Beta first", trigger: "conversation_started", conditions: [{ kind: "in_group", group: "beta" }], actions: [{ kind: "mark_priority" }] }),
  "workflows.delete": (f) => ({ id: f.workflowId }),
  "workflows.get": (f) => ({ id: f.workflowId }),
  "workflows.list": () => ({}),
  "workflows.move": (f) => ({ id: f.workflowId, position: 0 }),
  "workflows.update": (f) => ({ id: f.workflowId, name: "Renamed by the matrix", trigger: "user_replied", enabled: false }),
};

let owner: TestUser;
let model: ModelFake;
let dns: DnsFake;
let site: SiteFake;
let stripe: StripeFake;
let ses: SesFake;
let s3: S3Fake;
let github: GithubFake;
let browserUse: BrowserUseFake;
let keys: { read: string; write: string; otherWrite: string };
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  model = await startModelFake();
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  dns = await startDnsFake();
  vi.stubEnv("TUTI_CONFIG", configFile({ customDomains: { target: "customers.example.net" } }));
  vi.stubEnv("DNS_LOOKUP_URL", dns.url);
  // Portals under a path of a site: on, and the site is local.
  site = await startSiteFake();
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  // license.check asks the local site, which has no licence server (its own 404): "unreachable".
  vi.stubEnv("LICENSE_SERVER_URL", site.origin);
  // Top-ups pay on Stripe: the local fake (with credits on, only for credits.topUp; see below).
  stripe = await startStripeFake();
  for (const [name, value] of Object.entries(stripe.env)) {
    vi.stubEnv(name, value);
  }
  ses = await startSesFake();
  s3 = await startS3Fake();
  browserUse = await startBrowserUseFake();
  // GitHub, for the changelog's pull requests: a merged one on the fixture's repository.
  github = await startGithubFake();
  github.pullRequest("acme/matrix", { number: 5, title: "Add a dark theme" });
  // The one entry #2 has, which taking it out reads (what it is, to keep the team's word on).
  github.pullRequest("acme/matrix", { number: 4, title: "Speed up search" });
  owner = await signUp("Olive Owner");
  actAs(owner);
  project = await createProject(owner);
  // A Stripe customer (it had a plan once), for plan.manage.
  await prisma.project.update({ where: { id: project.id }, data: { stripeCustomerId: "cus_matrix" } });
  const other = await createProject(owner);
  keys = {
    read: (await createApiKey(project.slug, "Read", "READ")).key!,
    write: (await createApiKey(project.slug, "Write", "WRITE")).key!,
    otherWrite: (await createApiKey(other.slug, "Other", "WRITE")).key!,
  };
});

afterAll(() => Promise.all([model.close(), dns.close(), site.close(), stripe.close(), ses.close(), s3.close(), github.close(), browserUse.close()]));
// Refused calls never reach the model; the allowed one uses its reply.
afterEach(() => model.done());

/** Fresh posts #1 and #2 (with a link on #1) for each case; numbers restart per fixture. */
async function createFixture(own: "domain" | "site" = "domain") {
  // The project sends from its own domain (support.checkEmailDomain checks it; support.removeEmailDomain removes it).
  await prisma.emailDomain.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, domain: "matrix.example.com", address: "support@matrix.example.com", dkimTokens: ["matrixtoken1"] },
    update: {},
  });
  ses.identities.set("matrix.example.com", { tags: { "tuti-project": project.id }, tokens: ["matrixtoken1"], configurationSet: "tuti-test", verified: true });
  await prisma.post.deleteMany({ where: { projectId: project.id } });
  await prisma.projectLanguage.upsert({ where: { projectId_code: { projectId: project.id, code: "de" } }, create: { projectId: project.id, code: "de", automatic: false }, update: {} });
  await prisma.changelogEntry.deleteMany({ where: { projectId: project.id } });
  // Who's asking on `seats`, so companies.list has a total to return.
  await prisma.project.update({ where: { id: project.id }, data: { postCount: 2, changelogCount: 3, askingProperty: "seats" } });
  // A published entry #1, so reads find it (and unpublish has something to do), a draft #2 to draft with AI, and a
  // draft #3 with a line asking for a screenshot.
  await prisma.changelogEntry.createMany({
    data: [
      { projectId: project.id, number: 1, title: "Matrix entry", publishedAt: new Date() },
      { projectId: project.id, number: 2, title: "Matrix draft", body: "Shipped" },
      { projectId: project.id, number: 3, title: "Matrix screenshots", body: "[Screenshot: The dashboard]" },
    ],
  });
  // A merged pull request in the draft, to take out.
  await prisma.changelogEntryPullRequest.create({
    data: { entry: { connect: { projectId_number: { projectId: project.id, number: 2 } } }, url: "https://github.com/acme/matrix/pull/4", repo: "acme/matrix", number: 4, title: "Speed up search" },
  });
  // A comment on #1 by the keys' creator, to edit and delete.
  const entryComment = await prisma.changelogComment.create({
    data: {
      entry: { connect: { projectId_number: { projectId: project.id, number: 1 } } },
      author: { connect: { id: owner.id } },
      body: "A comment",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A comment" }] }] },
    },
  });
  // A tab, a collection in it, a published article in that and a draft.
  await prisma.article.deleteMany({ where: { projectId: project.id } });
  await prisma.collection.deleteMany({ where: { projectId: project.id } });
  await prisma.apiReference.deleteMany({ where: { projectId: project.id } });
  await prisma.docsTab.deleteMany({ where: { projectId: project.id } });
  // A reader group no collection is for.
  await prisma.readerGroup.deleteMany({ where: { projectId: project.id } });
  await prisma.readerGroup.create({ data: { projectId: project.id, key: "beta", name: "Beta", conditions: inGroupNamed("beta") } });
  // One of the project's users, at a company (for companies.list), and none the sync would add.
  await prisma.ssoIdentity.deleteMany({ where: { projectId: project.id, externalId: "matrix-new" } });
  const matrixUser = await upsertProjectUser(project.id, "matrix-user", { name: "Matrix user", properties: { plan: "free", company: "Acme", seats: 5 } });
  // The portal's own address, one or the other like a real project's: the portal on a site, waiting
  // for its check, which the site answers (for site.*); else a custom domain waiting for DNS, with
  // its TXT record there to verify it.
  await prisma.customDomain.deleteMany({ where: { projectId: project.id } });
  await prisma.siteMount.deleteMany({ where: { projectId: project.id } });
  if (own === "site") {
    await prisma.siteMount.create({ data: { projectId: project.id, origin: site.origin, path: "/portal", verificationToken: "matrix" } });
    site.answer("/portal/.well-known/tuti-site", "tuti-site=matrix");
    site.answer("/_tuti/.well-known/tuti-site", "tuti-site=matrix");
  } else {
    await prisma.customDomain.create({ data: { projectId: project.id, hostname: "docs.example.com", verificationToken: "matrix" } });
    dns.txt("_tuti.docs.example.com", ["tuti-verify=matrix"]);
  }
  // A reader, to remove.
  await prisma.portalReader.deleteMany({ where: { projectId: project.id } });
  await prisma.portalReader.create({ data: { projectId: project.id, email: "e2e-reader@example.com" } });
  // A tab with both collections in it.
  const docs = await prisma.docsTab.create({ data: { projectId: project.id, slug: "docs", name: "Docs" } });
  const basics = await prisma.collection.create({ data: { projectId: project.id, slug: "basics", name: "Basics", tabId: docs.id } });
  // Another, to move one into the other.
  await prisma.collection.create({ data: { projectId: project.id, slug: "guides", name: "Guides", order: 1, tabId: docs.id } });
  // An API reference in the tab, as apiReferences.create stores one.
  const reference = JSON.parse(JSON.stringify(settle(null, (readSpec(MATRIX_SPEC) as { doc: ApiDoc }).doc))) as { doc: object; state: object };
  await prisma.apiReference.create({
    data: { projectId: project.id, tabId: docs.id, slug: "matrix-reference", name: "Matrix reference", format: "OPENAPI", spec: MATRIX_SPEC, doc: reference.doc, state: reference.state, operationCount: 1, shownCount: 1 },
  });
  // And one read from a URL (the local site), to sync.
  site.answer("/matrix-openapi.json", MATRIX_SPEC.replace("List matrix", "List them"));
  await prisma.apiReference.create({
    data: {
      ...{ projectId: project.id, tabId: docs.id, slug: "matrix-url-reference", name: "Matrix URL reference", format: "OPENAPI", spec: MATRIX_SPEC, doc: reference.doc, state: reference.state },
      ...{ source: "URL", sourceUrl: `${site.origin}/matrix-openapi.json`, operationCount: 1, shownCount: 1, order: 1 },
    },
  });
  await prisma.article.createMany({
    data: [
      { projectId: project.id, slug: "matrix-article", title: "Matrix article", body: "Matrix text.", publishedAt: new Date(), collectionId: basics.id },
      { projectId: project.id, slug: "matrix-draft", title: "Matrix draft" },
      // A draft with a line asking for a screenshot.
      { projectId: project.id, slug: "matrix-screenshots", title: "Matrix screenshots", body: "[Screenshot: The dashboard]" },
    ],
  });
  // The published article's German version (German is the fixture's language), to give its own slug.
  const matrixArticle = await prisma.article.findFirstOrThrow({ where: { projectId: project.id, slug: "matrix-article" } });
  const translation = await prisma.articleTranslation.create({
    data: {
      articleId: matrixArticle.id,
      projectId: project.id,
      language: "de",
      automatic: false,
      title: "Matrix-Artikel",
      slug: "matrix-artikel",
      publishedAt: new Date(),
      // Unpublished changes, to publish.
      draft: { title: "Matrix-Artikel", titleEdited: false, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Matrix-Text." }] }] }, sections: [] },
    },
  });
  // An earlier version of the draft, to restore.
  const revision = await prisma.articleRevision.create({
    data: { article: { connect: { projectId_slug: { projectId: project.id, slug: "matrix-draft" } } }, title: "Matrix draft, before", body: "Older" },
  });
  // Unpublished changes to the published article, to publish or discard.
  await prisma.articleChanges.create({
    data: { article: { connect: { projectId_slug: { projectId: project.id, slug: "matrix-article" } } }, title: "Matrix article, edited" },
  });
  const board = project.boards[0]!;
  const marker = `matrix-${crypto.randomUUID()}`;
  const [first, second] = await Promise.all(
    [1, 2].map((number) =>
      prisma.post.create({
        data: { projectId: project.id, boardId: board.id, authorId: owner.id, number, title: `${marker} ${number}`, body: "" },
      }),
    ),
  );
  // Conversations #1 (with one of the project's users) and #2 (an email address).
  await prisma.conversation.deleteMany({ where: { projectId: project.id } });
  await prisma.project.update({ where: { id: project.id }, data: { conversationCount: 2 } });
  for (const [number, who] of [[1, { userId: matrixUser }], [2, { email: "e2e-asker@example.com" }]] as const) {
    await prisma.conversation.create({
      data: {
        projectId: project.id,
        number,
        subject: `${marker} ${number}`,
        origin: "API",
        ...who,
        waitingSince: new Date(),
        messages: { create: { projectId: project.id, author: "USER", authorId: "userId" in who ? who.userId : null, channel: "API", body: marker } },
      },
    });
  }
  // A workflow for everyone (no group's, so groups.delete has nothing in its way), second in its list, to move first.
  await prisma.workflow.deleteMany({ where: { projectId: project.id } });
  await prisma.workflow.create({ data: { projectId: project.id, name: "Another", trigger: "conversation_started", position: 0, actions: [{ kind: "mark_priority" }] } });
  const workflow = await prisma.workflow.create({
    data: { projectId: project.id, name: `${marker} workflow`, trigger: "conversation_started", position: 1, actions: [{ kind: "mark_priority" }] },
  });
  const comment = await prisma.comment.create({ data: { projectId: project.id, postId: first!.id, authorId: owner.id, body: "A comment to like" } });
  const link = await prisma.postLink.create({
    data: {
      projectId: project.id,
      postId: first!.id,
      kind: "ISSUE",
      repo: "acme/app",
      number: 9,
      url: "https://github.com/acme/app/issues/9",
      source: "MANUAL",
    },
  });
  const suggestion = await prisma.duplicateSuggestion.create({
    data: { projectId: project.id, postId: second!.id, originalId: first!.id, similarity: 0.9 },
  });
  // "Ask a person" is on (it starts a conversation in the inbox, with a support address to email replies from), and the read and write key just got "I don't know".
  await prisma.project.update({ where: { id: project.id }, data: { supportInbox: true } });
  await prisma.mailSubdomain.upsert({ where: { projectId: project.id }, create: { projectId: project.id, subdomain: "matrix" }, update: {} });
  const writeKey = await prisma.apiKey.findFirstOrThrow({ where: { projectId: project.id, scope: "WRITE" }, select: { id: true } });
  // One at a time: questions count against docs.ask's hourly limit per key.
  await prisma.docsQuestion.deleteMany({ where: { projectId: project.id } });
  const question = await prisma.docsQuestion.create({
    data: { projectId: project.id, askerId: writeKey.id, question: "Can I pay with crypto?", source: "API", status: "NO_ANSWER" },
  });
  // A redirect, to delete (redirects.create adds another, from its own address).
  await prisma.portalRedirect.deleteMany({ where: { projectId: project.id } });
  const redirect = await prisma.portalRedirect.create({ data: { projectId: project.id, from: "/old/matrix", to: "/docs" } });
  // A GitHub repository, for Verify (articles.verify) to read.
  const installation = await prisma.githubInstallation.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, installationId: 77_001, accountLogin: "acme", createdById: owner.id },
    update: {},
  });
  await prisma.githubRepository.upsert({ where: { repoId: 77_001 }, create: { connectionId: installation.id, repoId: 77_001, fullName: "acme/matrix" }, update: {} });
  // A merged pull request's code change, with a link to apply and a proposal to dismiss.
  await prisma.codeChange.deleteMany({ where: { projectId: project.id } });
  const codeChange = await prisma.codeChange.create({
    data: {
      projectId: project.id,
      repoId: 1,
      repo: "acme/app",
      number: 1,
      url: "https://github.com/acme/app/pull/1",
      title: marker,
      author: "octo",
      mergedAt: new Date(),
      state: "READY",
      actions: {
        create: [
          { kind: "LINKS", postId: first!.id, probability: 0.9 },
          // Approved already, to undo (it put nothing back to put back).
          { kind: "RESOLVES", postId: first!.id, probability: 0.9, status: "APPLIED", payload: { undo: { linked: false } } },
          // Going out by itself later: to publish now, and to stop.
          { kind: "MOVES_FORWARD", postId: first!.id, probability: 0.97, status: "SCHEDULED", dueAt: new Date(Date.now() + 86_400_000), payload: { comment: "Out now" } },
          { kind: "ARTICLE_EDIT", probability: 0.97, status: "SCHEDULED", dueAt: new Date(Date.now() + 86_400_000) },
          { kind: "MOVES_FORWARD", postId: second!.id, probability: 0.5, payload: { comment: "Getting there" } },
        ],
      },
    },
    select: { id: true, actions: { select: { id: true, kind: true, status: true } } },
  });
  // Screenshots set up (a demo account), and a run of them to read.
  await prisma.screenshotRun.deleteMany({ where: { projectId: project.id } });
  await prisma.screenshotSettings.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, appUrl: "https://app.example.com" },
    update: { appUrl: "https://app.example.com", signIn: "NONE", username: "", password: null, window: "DESKTOP" },
  });
  // The owner's upload, waiting to be finished (uploads.finish, uploads.status).
  const upload = await prisma.media.create({ data: { projectId: project.id, uploaderId: owner.id, size: 4 } });
  s3.objects.set(originalKey(upload.id), { body: Buffer.from("fake"), contentType: "image/png" });
  const screenshotRun = await prisma.screenshotRun.create({
    data: { projectId: project.id, startedById: owner.id, state: "DONE", screenshots: { create: { projectId: project.id, position: 0, show: marker, failed: "Not reached" } } },
  });
  return {
    marker,
    // What articles.saveTranslation's `version` is for the German version as it is (articles.getTranslation's).
    // What changelog.getTranslation gives for entry #1's German, which has no version yet.
    changelogVersion: contentHash(JSON.stringify([null, translationSource({ title: "Matrix entry", body: "", content: null }).hash])),
    translationVersion: contentHash(JSON.stringify([translation.title, translation.content, translation.draft, translationSource(matrixArticle).hash])),
    screenshotRunId: screenshotRun.id,
    uploadId: upload.id,
    linkId: link.id,
    commentId: comment.id,
    entryCommentId: entryComment.id,
    suggestionId: suggestion.id,
    revisionId: revision.id,
    questionId: question.id,
    redirectId: redirect.id,
    workflowId: workflow.id,
    codeChangeId: codeChange.id,
    postId: first!.id,
    linkActionId: codeChange.actions.find((action) => action.kind === "LINKS")!.id,
    dismissActionId: codeChange.actions.find((action) => action.kind === "MOVES_FORWARD" && action.status === "PENDING")!.id,
    appliedActionId: codeChange.actions.find((action) => action.kind === "RESOLVES")!.id,
    scheduledActionId: codeChange.actions.find((action) => action.kind === "MOVES_FORWARD" && action.status === "SCHEDULED")!.id,
    stoppableActionId: codeChange.actions.find((action) => action.kind === "ARTICLE_EDIT")!.id,
  };
}

/** Operations only a person can run, in the app: API keys (and MCP, with the same keys) get 403. */
const PEOPLE_ONLY = new Set<string>(["articles.verifyAll", "imports.start", "conversations.markRead", "conversations.upload", "devices.register", "devices.remove", "notifications.update"]);

/** Calls an operation over REST like a client would. */
async function call(operation: PublicOperation, input: Record<string, unknown>, key: string) {
  const values = { ...input };
  const path = operation.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = String(values[name]);
    delete values[name];
    return encodeURIComponent(value);
  });
  const url = new URL(`http://tuti.localhost:3100/api/v1${path}`);
  if (operation.method === "GET") {
    for (const [name, value] of Object.entries(values)) {
      url.searchParams.set(name, String(value));
    }
  }
  const request = new Request(url, {
    method: operation.method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(operation.method !== "GET" && { body: JSON.stringify(values) }),
  });
  const handler = { GET, POST, PATCH, DELETE }[operation.method];
  const response = await handler(request, { params: Promise.resolve({ path: url.pathname.split("/").slice(3) }) });
  // Whatever it answers, the spec lists: an error it can give and doesn't list goes in its `errors`.
  expect([200, ...errorStatuses(operation)], `${operation.name} answered ${response.status}`).toContain(response.status);
  return { status: response.status, text: await response.text() };
}

/** This project's data, to show refused calls change nothing. */
const snapshot = () =>
  Promise.all([
    prisma.conversationRead.findMany({ where: { conversation: { projectId: project.id } } }),
    prisma.post.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } }),
    prisma.comment.findMany({ where: { projectId: project.id } }),
    prisma.postLink.findMany({ where: { projectId: project.id } }),
    prisma.vote.findMany({ where: { projectId: project.id } }),
    prisma.duplicateSuggestion.findMany({ where: { projectId: project.id } }),
    prisma.changelogEntry.findMany({ where: { projectId: project.id }, include: { posts: true, reactions: true, comments: true } }),
    prisma.project.findUnique({
      where: { id: project.id },
      select: {
        name: true,
        changelogTone: true,
        changelogExampleIds: true,
        widgetLabel: true,
        widgetColor: true,
        widgetLinks: true,
        brandColor: true,
        headerLinks: true,
        poweredBy: true,
        portalAccess: true,
        portalHome: true,
        assistantTone: true,
        assistantLength: true,
        assistantInstructions: true,
        assistantOffLimits: true,
        supportInbox: true,
        spamPhrases: true,
        widgetAiFirst: true,
        emailAiFirst: true,
        aiName: true,
      },
    }),
    prisma.docsQuestion.findMany({ where: { projectId: project.id, escalatedAt: { not: null } } }),
    prisma.article.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" } }),
    prisma.articleRevision.findMany({ where: { article: { projectId: project.id } }, orderBy: { id: "asc" } }),
    prisma.articleChanges.findMany({ where: { article: { projectId: project.id } }, orderBy: { articleId: "asc" } }),
    prisma.collection.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" } }),
    prisma.apiReference.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" } }),
    prisma.readerGroup.findMany({ where: { projectId: project.id }, orderBy: { key: "asc" } }),
    prisma.workflow.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
    prisma.articleFeedback.findMany({ where: { article: { projectId: project.id } } }),
    prisma.docsGapDismissal.findMany({ where: { projectId: project.id } }),
    prisma.changelogSeen.findMany({ where: { projectId: project.id } }),
    prisma.customDomain.findMany({ where: { projectId: project.id } }),
    prisma.siteMount.findMany({ where: { projectId: project.id } }),
    prisma.ssoIdentity.findMany({ where: { projectId: project.id }, include: { user: true }, orderBy: { externalId: "asc" } }),
    prisma.codeChange.findMany({ where: { projectId: project.id }, include: { actions: { orderBy: { id: "asc" } } } }),
    prisma.conversation.findMany({ where: { projectId: project.id }, include: { messages: { orderBy: { id: "asc" } }, posts: true }, orderBy: { number: "asc" } }),
    prisma.emailDomain.findUnique({ where: { projectId: project.id } }),
    prisma.spamSender.findMany({ where: { projectId: project.id }, orderBy: { sender: "asc" } }),
    prisma.spamRule.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
    prisma.verifyAll.findMany({ where: { projectId: project.id } }),
    prisma.dataImport.findMany({ where: { projectId: project.id } }),
    // The keys' creator's phones and notification settings.
    prisma.device.findMany({ where: { userId: owner.id } }),
    prisma.user.findUniqueOrThrow({ where: { id: owner.id }, select: { pushShowsText: true } }),
    prisma.articleVerification.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
    prisma.screenshotSettings.findUnique({ where: { projectId: project.id } }),
    prisma.screenshotRun.findMany({ where: { projectId: project.id }, include: { screenshots: true }, orderBy: { id: "asc" } }),
  ]);

/**
 * Every table's contents but what a call itself counts: sessions (reading one may refresh it), API keys (each request
 * counts against its key's rate limit and marks it used) and the day's count of docs searches (articles.search tallies
 * each one for Help center insights, a read counted as the rate limit counts it).
 */
async function everyTable(): Promise<Record<string, string>> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name NOT IN ('session', 'api_key', 'docs_search_day', '_prisma_migrations')`;
  const entries = await Promise.all(
    tables.map(async ({ name }) => {
      const [row] = await prisma.$queryRawUnsafe<{ hash: string }[]>(`SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS hash FROM "${name}" t`);
      return [name, row!.hash] as const;
    }),
  );
  return Object.fromEntries(entries);
}

test("every operation is in this matrix", () => {
  expect(allOperations.map((o) => o.name).sort()).toEqual(Object.keys(cases).sort());
});

/**
 * Internal operations (the app's only: not in REST, MCP or the docs) through the caller, as the app calls them: the
 * project's owner can run each, and a GET leaves every table as it was. Who's refused is the authorization matrix's.
 */
test.each(allOperations.filter((operation) => operation.internal).map((operation) => ({ name: operation.name, operation })))("$name (internal)", async ({ operation }) => {
  const fixture = await createFixture("domain");
  // Uploads, for the uploads.* procedures.
  for (const [key, value] of Object.entries(s3.env)) {
    vi.stubEnv(key, operation.name.startsWith("uploads.") ? value : "");
  }
  const [group, name] = operation.name.split(".") as [string, string];
  const caller = (await callerAs(owner)) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
  const untouched = operation.method === "GET" ? await everyTable() : null;
  await caller[group]![name]!({ project: project.slug, ...cases[operation.name as OperationName](fixture) });
  if (untouched) {
    expect(await everyTable()).toEqual(untouched);
  }
});

test.each(operations.map((operation) => ({ name: operation.name, operation })))("$name", async ({ operation }) => {
  const input = () => cases[operation.name as OperationName](fixture);
  const own = operation.name.startsWith("site.") ? "site" : "domain";
  let fixture = await createFixture(own);
  // Credits on for buying them only: elsewhere a project with none would be refused its AI. Custom domains on, as above.
  vi.stubEnv("TUTI_CONFIG", configFile({ customDomains: { target: "customers.example.net" }, credits: { enabled: operation.name === "credits.topUp" } }));
  vi.stubEnv("BILLING_CONFIG", operation.name === "plan.subscribe" ? billingFile() : "");
  // Email, and Amazon SES for teams' own domains, for the support settings; for a key's escalation, which only email answers.
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", operation.name.startsWith("support.") || operation.name === "docs.escalate" ? "tuti.email" : "");
  for (const [name, value] of Object.entries(ses.env)) {
    vi.stubEnv(name, operation.name.startsWith("support.") ? value : "");
  }
  // Uploads, for the cover an entry's composed one is kept as, AI images and screenshots' images; Browser Use, for screenshots.
  const screenshots = operation.name.startsWith("screenshot") || operation.name.endsWith(".takeScreenshots");
  for (const [name, value] of Object.entries(s3.env)) {
    vi.stubEnv(name, ["changelog.composeCover", "images.generate"].includes(operation.name) || screenshots ? value : "");
  }
  for (const [name, value] of Object.entries(browserUse.env)) {
    vi.stubEnv(name, screenshots ? value : "");
  }
  // Adding a pull request to the changelog would analyse it (inline here, asking the model): off for that one, as a
  // team turns it off (the analysis has its own tests, code-changes.db.test.ts).
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: operation.name !== "changelog.addPullRequests" } });
  // GitHub answers for the changelog's pull requests only: elsewhere it isn't set up (see articles.verify's case).
  for (const [name, value] of Object.entries(github.env)) {
    vi.stubEnv(name, ["changelog.missingChanges", "changelog.addPullRequests", "changelog.removePullRequest"].includes(operation.name) ? value : "");
  }

  if (operation.name === "languages.update" || operation.name === "languages.retranslate") {
    // The collection, tab and board names there are, translated into the language (docs/plan.md L13, L14), whichever project's key.
    model.otherwise(JSON.stringify({ segments: { "0.n": "Abrechnung", "1.n": "Schnittstelle", "2.n": "Funktionswünsche" } }), '"0.n":"Billing"');
  }
  if (operation.name === "languages.update" || operation.name === "languages.retranslate" || operation.name === "glossary.update") {
    // A project whose only label is its first board (L14): the other project's, whichever key.
    model.otherwise(JSON.stringify({ segments: { "0.n": "Funktionswünsche" } }), '"0.n":"Feature requests"');
  }
  // Another project's key: nothing of this project comes back, and nothing changes.
  if (operation.name === "conversations.summarize") {
    // The other project has a conversation #1 too: its own is summarized.
    model.reply("Their own conversation.");
  }
  const before = await snapshot();
  const other = await call(operation, input(), keys.otherWrite);
  expect(other.text).not.toContain(fixture.marker);
  expect(other.text).not.toContain(project.slug);
  expect(await snapshot()).toEqual(before);

  // A read-only key: reads work, writes are refused without changing anything.
  const read = await call(operation, input(), keys.read);
  if (operation.scope === "read") {
    expect(read.status).toBe(200);
  } else {
    expect(read.status).toBe(403);
    expect(await snapshot()).toEqual(before);
  }

  // People only (Verify all costs AI for every article, so a person starts it after seeing what it costs; an import takes another tool's key, pasted in the app): every key is refused.
  if (PEOPLE_ONLY.has(operation.name)) {
    const write = await call(operation, input(), keys.write);
    expect(write.status).toBe(403);
    expect(write.text).toContain("people_only");
    expect(await snapshot()).toEqual(before);
    return;
  }

  // A read and write key can run it.
  fixture = await createFixture(own);
  if (operation.name === "changelog.draft") {
    model.reply(JSON.stringify({ title: "Matrix release", notes: "Shipped." }));
  }
  if (operation.name === "docs.escalate") {
    model.reply("They want to pay with crypto.");
  }
  if (operation.name === "conversations.summarize") {
    model.reply("They want an invoice for October.");
  }
  if (operation.name === "articles.updateTranslation") {
    model.reply(JSON.stringify({ segments: { "1": "Matrix-Artikel", "2": "Matrix-Text." } }));
  }
  const untouched = operation.method === "GET" ? await everyTable() : null;
  const result = await call(operation, input(), keys.write);
  // Its result is checked against its output as it runs (defineOperation).
  expect(result).toMatchObject({ status: 200 });
  // A GET (a tRPC query) writes nothing, starts nothing and spends nothing: every table as it was.
  if (untouched) {
    expect(await everyTable()).toEqual(untouched);
  }
  // What it queued in the background (inline here) is done before the next case.
  await languageTranslationsDone();
});
