import { prisma } from "@tuti/db";
import { FAKE_OPENAI_KEY, type ModelFake, type OpenAIFake, startModelFake, startOpenAIFake } from "@tuti/testkit";
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
  "changelog.create": () => ({ title: "From the matrix", body: "Shipped", tags: ["new"], posts: [1] }),
  "changelog.update": () => ({ number: 1, title: "Renamed by the matrix" }),
  "changelog.draft": () => ({ number: 2 }),
  "changelog.publish": () => ({ number: 1 }),
  "changelog.unpublish": () => ({ number: 1 }),
  "changelog.delete": () => ({ number: 1 }),
  "changelogStyle.get": () => ({}),
  "changelogStyle.update": () => ({ tone: "Friendly", examples: [1] }),
  "articles.list": () => ({}),
  "articles.get": () => ({ slug: "matrix-article" }),
  "articles.search": () => ({ q: "matrix" }),
  "articles.feedback": () => ({ slug: "matrix-article", helpful: false, comment: "From the matrix", author: { id: "matrix-reader" } }),
  "help.insights": () => ({}),
  "help.dismissGap": () => ({ question: "How do I invite?" }),
  "help.ask": () => ({ q: "How do I invite my team?" }),
  "articles.create": () => ({ title: "From the matrix", body: "Read me", collection: "basics" }),
  "articles.update": () => ({ slug: "matrix-draft", title: "Renamed by the matrix", collection: null }),
  "articles.publish": () => ({ slug: "matrix-draft" }),
  "articles.unpublish": () => ({ slug: "matrix-article" }),
  "articles.delete": () => ({ slug: "matrix-article" }),
  "articles.revisions": () => ({ slug: "matrix-article" }),
  "articles.restore": (f) => ({ slug: "matrix-draft", revision: f.revisionId }),
  "collections.list": () => ({}),
  "collections.create": () => ({ name: "Billing" }),
  "collections.update": () => ({ slug: "basics", name: "The basics" }),
  "collections.delete": () => ({ slug: "basics" }),
  "posts.list": () => ({}),
  "posts.get": () => ({ number: 1 }),
  "comments.list": () => ({ number: 1 }),
  "posts.create": () => ({ board: "feature-requests", title: "From the matrix" }),
  "comments.create": () => ({ number: 1, body: "From the matrix" }),
  "posts.update": () => ({ number: 1, status: "planned" }),
  "posts.merge": () => ({ number: 2, into: 1 }),
  "links.add": () => ({ number: 1, url: "https://github.com/acme/app/pull/7" }),
  "links.remove": (f) => ({ number: 1, id: f.linkId }),
  "linkSuggestions.list": () => ({}),
  "linkSuggestions.accept": (f) => ({ id: f.linkSuggestionId }),
  "linkSuggestions.dismiss": (f) => ({ id: f.linkSuggestionId }),
  "widget.get": () => ({}),
  // Keys act as the team (only owners and admins create them); in the app, widget.update is admins only (see the authorization matrix).
  "widget.update": () => ({ label: "Matrix", color: "#5b21b6", links: [{ label: "Status", url: "https://status.example.com" }] }),
};

let owner: TestUser;
let model: ModelFake;
let openai: OpenAIFake;
let keys: { read: string; write: string; otherWrite: string };
let project: Awaited<ReturnType<typeof createProject>>;

beforeAll(async () => {
  model = await startModelFake();
  openai = await startOpenAIFake();
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
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

afterAll(() => Promise.all([model.close(), openai.close()]));
// Refused calls never reach the model; the allowed one uses its reply.
afterEach(() => model.done());

/** Fresh posts #1 and #2 (with a link on #1) for each case; numbers restart per fixture. */
async function createFixture() {
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
  // A collection, a published article in it and a draft.
  await prisma.article.deleteMany({ where: { projectId: project.id } });
  await prisma.collection.deleteMany({ where: { projectId: project.id } });
  const basics = await prisma.collection.create({ data: { projectId: project.id, slug: "basics", name: "Basics" } });
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
  const linkSuggestion = await prisma.linkSuggestion.create({
    data: {
      projectId: project.id,
      postId: second!.id,
      repo: "acme/app",
      number: 11,
      url: "https://github.com/acme/app/pull/11",
      title: "Night mode",
      similarity: 0.6,
    },
  });
  return { marker, linkId: link.id, suggestionId: suggestion.id, linkSuggestionId: linkSuggestion.id, revisionId: revision.id };
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
    prisma.linkSuggestion.findMany({ where: { projectId: project.id } }),
    prisma.changelogEntry.findMany({ where: { projectId: project.id }, include: { posts: true, reactions: true } }),
    prisma.project.findUnique({
      where: { id: project.id },
      select: { changelogTone: true, changelogExampleIds: true, widgetLabel: true, widgetColor: true, widgetLinks: true },
    }),
    prisma.article.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" } }),
    prisma.articleRevision.findMany({ where: { article: { projectId: project.id } }, orderBy: { id: "asc" } }),
    prisma.collection.findMany({ where: { projectId: project.id }, orderBy: { slug: "asc" } }),
    prisma.articleFeedback.findMany({ where: { article: { projectId: project.id } } }),
    prisma.helpGapDismissal.findMany({ where: { projectId: project.id } }),
  ]);

test("every operation is in this matrix", () => {
  expect(operations.map((o) => o.name).sort()).toEqual(Object.keys(cases).sort());
});

test.each(operations.map((operation) => ({ name: operation.name, operation })))("$name", async ({ operation }) => {
  const input = () => cases[operation.name as OperationName](fixture);
  let fixture = await createFixture();
  // AI answers need embeddings: on for help.ask only. Nothing is close to its question, so the model isn't asked.
  vi.stubEnv("OPENAI_API_KEY", operation.name === "help.ask" ? FAKE_OPENAI_KEY : "");

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
  fixture = await createFixture();
  if (operation.name === "changelog.draft") {
    model.reply(JSON.stringify({ title: "Matrix release", notes: "Shipped." }));
  }
  expect(await call(operation, input(), keys.write)).toMatchObject({ status: 200 });
});
