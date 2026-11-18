import { prisma } from "@tuti/db";
import { readSpec, settle } from "@tuti/shared/api-reference";
import { FAKE_OPENAI_KEY, type OpenAIFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { apiReferenceChanged } from "./api-references";
import { backfillEmbeddings } from "./backfill";

/** Indexing API references' operations for the docs' search and AI answers (apiReferenceChanged), and its backfill. */

const log = { info: () => {}, warn: () => {} };
let openai: OpenAIFake;
beforeAll(async () => {
  openai = await startOpenAIFake();
});
afterAll(() => openai.close());
afterEach(() => vi.unstubAllEnvs());

const withEmbeddings = () => {
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
};

/** An OpenAPI spec with `count` operations, "Get item 0" at GET /items/0 and so on. */
const spec = (count: number) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Items", version: "1" },
    paths: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`/items/${i}`, { get: { summary: `Get item ${i}`, description: `Reads item ${i}.`, responses: { "200": { description: "ok" } } } }]),
    ),
  });

let made = 0;
/** A published reference read from `text`, as apiReferences.create stores one, with nothing indexed yet. */
async function addReference(text: string) {
  const project = await prisma.project.create({ data: { slug: `index-${++made}-${Date.now()}`, name: "Index" } });
  const read = readSpec(text);
  if ("error" in read) throw new Error(read.error);
  const { doc, state } = settle(null, read.doc);
  return prisma.apiReference.create({
    data: {
      projectId: project.id,
      slug: "reference",
      name: "Reference",
      format: "OPENAPI",
      spec: text,
      doc: JSON.parse(JSON.stringify(doc)) as object,
      state: JSON.parse(JSON.stringify(state)) as object,
      operationCount: doc.operations.length,
      shownCount: doc.operations.length,
      publishedAt: new Date(),
    },
    select: { id: true, projectId: true },
  });
}

const entries = (referenceId: string) =>
  prisma.$queryRaw<{ key: string; embedded: boolean }[]>`
    SELECT key, embedding IS NOT NULL AS embedded FROM api_operation_entry WHERE "referenceId" = ${referenceId} ORDER BY key`;

test("a reference of a few hundred operations is written in one go, each embedded", async () => {
  withEmbeddings();
  const reference = await addReference(spec(400));
  expect(await apiReferenceChanged({ referenceId: reference.id }, log)).toEqual({ skipped: false, entries: 400, embedded: 400 });
  const rows = await entries(reference.id);
  expect(rows).toHaveLength(400);
  expect(rows.every((row) => row.embedded)).toBe(true);
  // Again, with nothing changed: every entry keeps its embedding, and none is sent.
  const sent = openai.inputs.length;
  expect(await apiReferenceChanged({ referenceId: reference.id }, log)).toEqual({ skipped: false, entries: 400, embedded: 0 });
  expect(openai.inputs.length).toBe(sent);
  expect((await entries(reference.id)).every((row) => row.embedded)).toBe(true);
}, 30_000);

test("when embedding fails, the entries are still written, without vectors, and it throws to be tried again; the retry embeds them", async () => {
  withEmbeddings();
  const reference = await addReference(spec(3));
  openai.failNext();
  await expect(apiReferenceChanged({ referenceId: reference.id }, log)).rejects.toThrow();
  expect(await entries(reference.id)).toEqual([
    { key: "GET /items/0", embedded: false },
    { key: "GET /items/1", embedded: false },
    { key: "GET /items/2", embedded: false },
  ]);
  expect(await apiReferenceChanged({ referenceId: reference.id }, log)).toMatchObject({ entries: 3, embedded: 3 });
  expect((await entries(reference.id)).every((row) => row.embedded)).toBe(true);
});

test("the backfill indexes every reference without entries, carrying on past one that fails; embedded only with embeddings set up", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  const good = await addReference(spec(2));
  const broken = await addReference(spec(1));
  // Not a doc the readers make: indexing it throws.
  await prisma.apiReference.update({ where: { id: broken.id }, data: { doc: {} } });

  const without = await backfillEmbeddings(log);
  // Without embeddings: posts and articles are skipped, references are indexed for words.
  expect(without.posts).toBeNull();
  expect(without.articles).toBeNull();
  // Only this test's own: others in the file may leave references of their own.
  expect(without.references.failed).toContain(broken.id);
  expect(without.references.failed).not.toContain(good.id);
  expect(await entries(good.id)).toEqual([
    { key: "GET /items/0", embedded: false },
    { key: "GET /items/1", embedded: false },
  ]);

  withEmbeddings();
  const withKey = await backfillEmbeddings(log);
  expect(withKey.references.failed).toContain(broken.id);
  expect(withKey.references.failed).not.toContain(good.id);
  expect((await entries(good.id)).every((row) => row.embedded)).toBe(true);
}, 30_000);

test("the backfill leaves sample posts and articles out: never embedded or suggested as duplicates", async () => {
  withEmbeddings();
  const project = await prisma.project.create({ data: { slug: `samples-${Date.now()}`, name: "Samples" } });
  const author = await prisma.user.create({ data: { id: `samples-${Date.now()}`, name: "Author", email: `e2e-samples-${Date.now()}@example.com` } });
  const board = await prisma.board.create({ data: { projectId: project.id, slug: "ideas", name: "Ideas" } });
  const post = (number: number, title: string, sample: boolean) =>
    prisma.post.create({ data: { projectId: project.id, boardId: board.id, authorId: author.id, number, title, body: title, sample }, select: { id: true } });
  const real = await post(1, "A real dark mode request", false);
  const seeded = await post(2, "A sample dark mode request", true);
  const article = (slug: string, sample: boolean) =>
    prisma.article.create({ data: { projectId: project.id, slug, title: `About ${slug}`, body: `About ${slug}.`, publishedAt: new Date(), sample }, select: { id: true } });
  await article("real-article", false);
  const sampleArticle = await article("sample-article", true);

  const sent = openai.inputs.length;
  await backfillEmbeddings(log);
  const embeddedTexts = openai.inputs.slice(sent).join("\n");
  expect(embeddedTexts).toContain("A real dark mode request");
  expect(embeddedTexts).toContain("About real-article");
  expect(embeddedTexts).not.toContain("A sample dark mode request");
  expect(embeddedTexts).not.toContain("About sample-article");
  expect(await prisma.postEmbedding.count({ where: { postId: { in: [real.id, seeded.id] } } })).toBe(1);
  expect(await prisma.articleChunk.count({ where: { articleId: sampleArticle.id } })).toBe(0);
  expect(await prisma.duplicateSuggestion.count({ where: { OR: [{ postId: seeded.id }, { originalId: seeded.id }] } })).toBe(0);
}, 30_000);
