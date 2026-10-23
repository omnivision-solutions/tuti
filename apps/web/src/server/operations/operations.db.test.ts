import { prisma } from "@tuti/db";
import { type DnsFake, FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, type SiteFake, startDnsFake, startModelFake, startOpenAIFake, startSiteFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { DELETE, GET, PATCH, POST } from "@/app/api/v1/[...path]/route";
import { createApiKey } from "@/server/api-keys";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { type Operation, type OperationName, operations } from "./index";

/**
 * Every operation on the API surface (REST; MCP serves the same operations with
 * the same key check, see app/mcp/mcp.db.test.ts): a read-only key may run reads
 * and is refused writes without changing anything; a read and write key may run
 * everything; another project's key never reaches this project's data. In the
 * app, operations run through server actions, which the authorization matrix
 * (server/authorization.db.test.ts) covers. The type lists every operation, so a
 * new one doesn't compile until it's added here.
 */

type Fixture = Awaited<ReturnType<typeof createFixture>>;
/** A valid call: path values and the rest of the input. */
const cases: Record<OperationName, (f: Fixture) => Record<string, unknown>> = {
  "project.get": () => ({}),
  "team.list": () => ({}),
  "votes.set": () => ({ number: 1, voted: true }),
  "duplicates.list": () => ({}),
  "duplicates.dismiss": (f) => ({ id: f.suggestionId }),
  "boards.list": () => ({}),
  "roadmap.get": () => ({}),
  "changelog.list": () => ({}),
  "changelog.get": () => ({ number: 1 }),
  "changelog.react": () => ({ number: 1, reaction: "tada", reacted: true }),
  "changelog.seen": () => ({ at: "2026-10-20T09:00:00Z", author: { id: "matrix-reader" } }),
  "changelog.create": () => ({ title: "From the matrix", body: "Shipped", tags: ["new"], posts: [1] }),
  "changelog.update": () => ({ number: 1, title: "Renamed by the matrix" }),
  "changelog.draft": () => ({ number: 2 }),
  "changelog.rewrite": () => ({ number: 2, mode: "shorten" }),
  "changelog.publish": () => ({ number: 1 }),
  "changelog.unpublish": () => ({ number: 1 }),
  "changelog.delete": () => ({ number: 1 }),
  "changelogStyle.get": () => ({}),
  "changelogStyle.update": () => ({ tone: "Friendly", examples: [1] }),
  "articles.list": () => ({}),
  "articles.get": () => ({ slug: "matrix-article" }),
  "articles.search": () => ({ q: "matrix" }),
  "articles.feedback": () => ({ slug: "matrix-article", helpful: false, comment: "From the matrix", author: { id: "matrix-reader" } }),
  "docs.insights": () => ({}),
  "docs.dismissGap": () => ({ question: "How do I invite?" }),
  "docs.ask": () => ({ q: "How do I invite my team?" }),
  // A question the read and write key asked (another key's question is refused: see docs-escalate.db.test.ts).
  "docs.escalate": (f) => ({ questionId: f.questionId, email: `e2e-${crypto.randomUUID()}@example.com`, note: "From the matrix" }),
  "assistant.get": () => ({}),
  // Like widget.update: admins only in the app (see the authorization matrix).
  "assistant.update": () => ({ tone: "Plain", length: "short", instructions: "Say hi", offLimits: ["refund"] }),
  "articles.create": () => ({ title: "From the matrix", body: "Read me", collection: "basics" }),
  "articles.update": () => ({ slug: "matrix-draft", title: "Renamed by the matrix", collection: null }),
  "articles.publish": () => ({ slug: "matrix-draft" }),
  "articles.publishChanges": () => ({ slug: "matrix-article" }),
  "articles.discardChanges": () => ({ slug: "matrix-article" }),
  "articles.unpublish": () => ({ slug: "matrix-article" }),
  "articles.delete": () => ({ slug: "matrix-article" }),
  "articles.revisions": () => ({ slug: "matrix-article" }),
  "articles.restore": (f) => ({ slug: "matrix-draft", revision: f.revisionId }),
  "collections.list": () => ({}),
  "collections.create": () => ({ name: "Billing" }),
  "articles.reorder": () => ({ slug: "matrix-draft", collection: "basics", position: 0 }),
  "collections.update": () => ({ slug: "basics", name: "The basics", parent: "guides" }),
  "collections.reorder": () => ({ slug: "guides", parent: "basics", position: 0 }),
  "collections.delete": () => ({ slug: "basics" }),
  "tabs.list": () => ({}),
  "tabs.create": () => ({ name: "API" }),
  "tabs.update": () => ({ slug: "docs", name: "Documentation" }),
  "tabs.reorder": () => ({ slug: "docs", position: 0 }),
  "tabs.delete": () => ({ slug: "docs" }),
  "groups.list": () => ({}),
  // Like portal.update: admins only in the app.
  "groups.create": () => ({ name: "Enterprise", conditions: [{ attribute: "plan", op: "is_one_of", value: ["enterprise", "custom"] }] }),
  "groups.update": () => ({ group: "beta", name: "Beta testers", claim: null, conditions: [{ attribute: "beta", op: "is", value: "true" }] }),
  "groups.delete": () => ({ group: "beta" }),
  "posts.list": () => ({}),
  "posts.get": () => ({ number: 1 }),
  "comments.list": () => ({ number: 1 }),
  "posts.create": () => ({ board: "feature-requests", title: "From the matrix" }),
  "comments.create": () => ({ number: 1, body: "From the matrix" }),
  "posts.update": () => ({ number: 1, status: "planned" }),
  "posts.merge": () => ({ number: 2, into: 1 }),
  "links.remove": (f) => ({ number: 1, id: f.linkId }),
  "widget.get": () => ({}),
  // Keys act as the team (only owners and admins create them); in the app, widget.update is admins only (see the authorization matrix).
  "widget.update": () => ({ label: "Matrix", color: "#5b21b6", links: [{ label: "Status", url: "https://status.example.com" }] }),
  "branding.get": () => ({}),
  // Like widget.update: admins only in the app (see the authorization matrix).
  "branding.update": () => ({ color: "#5b21b6", headerLinks: [{ label: "Docs", url: "https://docs.example.com" }], poweredBy: true }),
  // Like branding.update: admins only in the app (Check now, Customize → Powered by).
  "license.check": () => ({}),
  // Like branding.update: admins only in the app. The team's keys keep working on a private portal (portal-access.db.test.ts).
  "portal.get": () => ({}),
  "portal.update": () => ({ access: "private", home: "docs" }),
  // Like portal.update: admins only in the app.
  "portalReaders.list": () => ({}),
  "portalReaders.add": () => ({ emails: ["e2e-matrix-reader@example.com"] }),
  "portalReaders.remove": () => ({ email: "e2e-reader@example.com" }),
  "domain.get": () => ({}),
  // Like portal.update: admins only in the app.
  "domain.set": () => ({ hostname: "help.example.org" }),
  "domain.verify": () => ({}),
  "domain.remove": () => ({}),
  "site.get": () => ({}),
  // Like domain.set: admins only in the app.
  "site.set": () => ({ url: `${site.origin}/help` }),
  "site.verify": () => ({}),
  "site.remove": () => ({}),
  "redirects.list": () => ({}),
  // Like the rest of Customize: admins only in the app.
  "redirects.create": () => ({ from: "/hc/en-us/articles/1", to: "/docs" }),
  "redirects.delete": (f) => ({ id: f.redirectId }),
};

let owner: TestUser;
let model: ModelFake;
let openai: OpenAIFake;
let dns: DnsFake;
let site: SiteFake;
let keys: { read: string; write: string; otherWrite: string };
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  model = await startModelFake();
  openai = await startOpenAIFake();
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  dns = await startDnsFake();
  vi.stubEnv("CUSTOM_DOMAIN_TARGET", "customers.example.net");
  vi.stubEnv("DNS_LOOKUP_URL", dns.url);
  // Portals under a path of a site: on, and the site is local.
  site = await startSiteFake();
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  // license.check asks the local site, which has no licence server (its own 404): "unreachable".
  vi.stubEnv("LICENSE_SERVER_URL", site.origin);
  owner = await signUp("Olive Owner");
  actAs(owner);
  project = await createProject(owner);
  const other = await createProject(owner);
  keys = {
    read: (await createApiKey(project.slug, "Read", "READ")).key!,
    write: (await createApiKey(project.slug, "Write", "WRITE")).key!,
    otherWrite: (await createApiKey(other.slug, "Other", "WRITE")).key!,
  };
});

afterAll(() => Promise.all([model.close(), openai.close(), dns.close(), site.close()]));
// Refused calls never reach the model; the allowed one uses its reply.
afterEach(() => model.done());

/** Fresh posts #1 and #2 (with a link on #1) for each case; numbers restart per fixture. */
async function createFixture(own: "domain" | "site" = "domain") {
  await prisma.post.deleteMany({ where: { projectId: project.id } });
  await prisma.changelogEntry.deleteMany({ where: { projectId: project.id } });
  await prisma.project.update({ where: { id: project.id }, data: { postCount: 2, changelogCount: 2 } });
  // A published entry #1, so reads find it (and unpublish has something to do), and a draft #2 to draft with AI.
  await prisma.changelogEntry.createMany({
    data: [
      { projectId: project.id, number: 1, title: "Matrix entry", publishedAt: new Date() },
      { projectId: project.id, number: 2, title: "Matrix draft", body: "Shipped" },
    ],
  });
  // A tab, a collection in it, a published article in that and a draft.
  await prisma.article.deleteMany({ where: { projectId: project.id } });
  await prisma.collection.deleteMany({ where: { projectId: project.id } });
  await prisma.docsTab.deleteMany({ where: { projectId: project.id } });
  // A reader group no collection is for.
  await prisma.readerGroup.deleteMany({ where: { projectId: project.id } });
  await prisma.readerGroup.create({ data: { projectId: project.id, key: "beta", name: "Beta", claim: "beta" } });
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
  await prisma.article.createMany({
    data: [
      { projectId: project.id, slug: "matrix-article", title: "Matrix article", publishedAt: new Date(), collectionId: basics.id },
      { projectId: project.id, slug: "matrix-draft", title: "Matrix draft" },
    ],
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
  // "Ask a person" is on, and the read and write key just got "I don't know".
  await prisma.project.update({ where: { id: project.id }, data: { supportEmail: "e2e-support@example.com" } });
  const writeKey = await prisma.apiKey.findFirstOrThrow({ where: { projectId: project.id, scope: "WRITE" }, select: { id: true } });
  // One at a time: questions count against docs.ask's hourly limit per key.
  await prisma.docsQuestion.deleteMany({ where: { projectId: project.id } });
  const question = await prisma.docsQuestion.create({
    data: { projectId: project.id, askerId: writeKey.id, question: "Can I pay with crypto?", source: "API", status: "NO_ANSWER" },
  });
  // A redirect, to delete (redirects.create adds another, from its own address).
  await prisma.portalRedirect.deleteMany({ where: { projectId: project.id } });
  const redirect = await prisma.portalRedirect.create({ data: { projectId: project.id, from: "/old/matrix", to: "/docs" } });
  return { marker, linkId: link.id, suggestionId: suggestion.id, revisionId: revision.id, questionId: question.id, redirectId: redirect.id };
}

/** Calls an operation over REST like a client would. */
async function call(operation: Operation, input: Record<string, unknown>, key: string) {
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
  return { status: response.status, text: await response.text() };
}

/** This project's data, to show refused calls change nothing. */
const snapshot = () =>
  Promise.all([
    prisma.post.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } }),
    prisma.comment.findMany({ where: { projectId: project.id } }),
    prisma.postLink.findMany({ where: { projectId: project.id } }),
    prisma.vote.findMany({ where: { projectId: project.id } }),
    prisma.duplicateSuggestion.findMany({ where: { projectId: project.id } }),
    prisma.changelogEntry.findMany({ where: { projectId: project.id }, include: { posts: true, reactions: true } }),
    prisma.project.findUnique({
      where: { id: project.id },
      select: {
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
        supportEmail: true,
        supportEmailPending: true,
      },
    }),
    prisma.docsQuestion.findMany({ where: { projectId: project.id, escalatedAt: { not: null } } }),
    prisma.article.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" } }),
    prisma.articleRevision.findMany({ where: { article: { projectId: project.id } }, orderBy: { id: "asc" } }),
    prisma.articleChanges.findMany({ where: { article: { projectId: project.id } }, orderBy: { articleId: "asc" } }),
    prisma.collection.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" } }),
    prisma.readerGroup.findMany({ where: { projectId: project.id }, orderBy: { claim: "asc" } }),
    prisma.articleFeedback.findMany({ where: { article: { projectId: project.id } } }),
    prisma.docsGapDismissal.findMany({ where: { projectId: project.id } }),
    prisma.changelogSeen.findMany({ where: { projectId: project.id } }),
    prisma.customDomain.findMany({ where: { projectId: project.id } }),
    prisma.siteMount.findMany({ where: { projectId: project.id } }),
  ]);

test("every operation is in this matrix", () => {
  expect(operations.map((o) => o.name).sort()).toEqual(Object.keys(cases).sort());
});

test.each(operations.map((operation) => ({ name: operation.name, operation })))("$name", async ({ operation }) => {
  const input = () => cases[operation.name as OperationName](fixture);
  const own = operation.name.startsWith("site.") ? "site" : "domain";
  let fixture = await createFixture(own);
  // AI answers need embeddings: on for docs.ask only. Nothing is close to its question, so the model isn't asked.
  vi.stubEnv("OPENAI_API_KEY", operation.name === "docs.ask" ? FAKE_OPENAI_KEY : "");

  // Another project's key: nothing of this project comes back, and nothing changes.
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

  // A read and write key can run it.
  fixture = await createFixture(own);
  if (operation.name === "changelog.draft" || operation.name === "changelog.rewrite") {
    model.reply(JSON.stringify({ title: "Matrix release", notes: "Shipped." }));
  }
  if (operation.name === "docs.escalate") {
    model.reply("They want to pay with crypto.");
  }
  expect(await call(operation, input(), keys.write)).toMatchObject({ status: 200 });
});
