import { prisma } from "@tuti/db";
import { FAKE_OPENAI_KEY, startOpenAIFake } from "@tuti/testkit";
import { expect, test, vi } from "vitest";

import { articleChanged, embedPublishedArticles, fillArticleVectors } from "./articles";

test("the backfill embeds every published article, carrying on past one that fails", async () => {
  const openai = await startOpenAIFake();
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  try {
    const project = await prisma.project.create({ data: { slug: "backfill", name: "Backfill" } });
    const article = (slug: string, minute: number, published = true) =>
      prisma.article.create({
        data: {
          projectId: project.id,
          slug,
          title: slug,
          body: `About ${slug}.`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)),
          publishedAt: published ? new Date() : null,
        },
      });
    const failing = await article("billing", 1);
    const next = await article("invites", 2);
    const draft = await article("draft", 3, false);

    openai.failNext();
    expect(await embedPublishedArticles({ info: () => {}, warn: () => {} })).toEqual({ articles: 2, embedded: 1, failed: [failing.id] });
    const chunks = (articleId: string) => prisma.articleChunk.count({ where: { articleId } });
    expect([await chunks(failing.id), await chunks(next.id), await chunks(draft.id)]).toEqual([0, 1, 0]);
  } finally {
    vi.unstubAllEnvs();
    await openai.close();
  }
});

test("embedding an article writes its one vector for related articles, the average of its sections; unpublished, it goes", async () => {
  const openai = await startOpenAIFake();
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  try {
    const project = await prisma.project.create({ data: { slug: "vectors", name: "Vectors" } });
    const section = (heading: string, text: string) => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      { type: "paragraph", content: [{ type: "text", text }] },
    ];
    const content = { type: "doc", content: [...section("Roles", "Owners and admins."), ...section("Invites", "Good for 7 days."), ...section("Seats", "One per member.")] };
    const { id } = await prisma.article.create({
      data: { projectId: project.id, slug: "team", title: "Team", body: "", content, publishedAt: new Date() },
    });
    const log = { info: () => {}, warn: () => {} };
    // Its vector is its sections' average (and only one row however many sections it has).
    const vector = () => prisma.$queryRaw<{ sections: number; vectors: number; average: boolean }[]>`
      SELECT (SELECT count(*)::int FROM article_chunk WHERE "articleId" = ${id}) AS sections,
        (SELECT count(*)::int FROM article_vector WHERE "articleId" = ${id}) AS vectors,
        (SELECT embedding FROM article_vector WHERE "articleId" = ${id}) = (SELECT avg(embedding) FROM article_chunk WHERE "articleId" = ${id}) AS average`;

    await articleChanged({ articleId: id }, log);
    expect(await vector()).toEqual([{ sections: 3, vectors: 1, average: true }]);

    await prisma.article.update({ where: { id }, data: { publishedAt: null } });
    await articleChanged({ articleId: id }, log);
    expect(await vector()).toEqual([{ sections: 0, vectors: 0, average: null }]);
  } finally {
    vi.unstubAllEnvs();
    await openai.close();
  }
});

test("fillArticleVectors writes a missing vector, renews one made from other sections, drops one with no sections, and leaves a matching one alone", async () => {
  const project = await prisma.project.create({ data: { slug: "fill", name: "Fill" } });
  const literal = (first: number) => `[${[first, ...Array<number>(1535).fill(0)].join(",")}]`;
  const article = async (slug: string, sections: { hash: string; first: number } | null, vector?: { hash: string; first: number }) => {
    const { id } = await prisma.article.create({ data: { projectId: project.id, slug, title: slug, body: slug, publishedAt: new Date() } });
    if (sections) {
      await prisma.$executeRaw`
        INSERT INTO article_chunk (id, "articleId", "projectId", position, heading, text, model, "contentHash", embedding)
        VALUES (${`fill-${slug}`}, ${id}, ${project.id}, 0, '', ${slug}, 'test', ${sections.hash}, ${literal(sections.first)}::vector)`;
    }
    if (vector) {
      await prisma.$executeRaw`
        INSERT INTO article_vector ("articleId", "contentHash", embedding) VALUES (${id}, ${vector.hash}, ${literal(vector.first)}::vector)`;
    }
    return id;
  };
  // Embedded by the previous release's worker: sections and no vector, or the vector of its old sections.
  const missing = await article("missing", { hash: "new", first: 1 });
  const stale = await article("stale", { hash: "new", first: 1 }, { hash: "old", first: 0.5 });
  // Its sections removed by the previous release (unpublished): a vector and nothing to average.
  const orphan = await article("orphan", null, { hash: "old", first: 1 });
  // Up to date (its stored vector kept as it is, even if it isn't the average).
  const current = await article("current", { hash: "same", first: 1 }, { hash: "same", first: 0.25 });

  await fillArticleVectors(prisma);
  const rows = await prisma.$queryRaw<{ articleId: string; contentHash: string; first: number }[]>`
    SELECT "articleId", "contentHash", (embedding::real[])[1] AS first FROM article_vector WHERE "articleId" = ANY(${[missing, stale, orphan, current]}::text[])`;
  const byId = new Map(rows.map((row) => [row.articleId, { hash: row.contentHash, first: row.first }]));
  expect(byId.get(missing)).toEqual({ hash: "new", first: 1 });
  expect(byId.get(stale)).toEqual({ hash: "new", first: 1 });
  expect(byId.has(orphan)).toBe(false);
  expect(byId.get(current)).toEqual({ hash: "same", first: 0.25 });
});

test("an article whose sections are current but whose vector is missing gets it the next time it's embedded", async () => {
  const openai = await startOpenAIFake();
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  try {
    const project = await prisma.project.create({ data: { slug: "mend", name: "Mend" } });
    const { id } = await prisma.article.create({ data: { projectId: project.id, slug: "sso", title: "SSO", body: "Set up SSO.", publishedAt: new Date() } });
    const log = { info: () => {}, warn: () => {} };
    await articleChanged({ articleId: id }, log);
    // As the previous release's worker leaves it: its sections, no vector.
    await prisma.articleVector.deleteMany({ where: { articleId: id } });

    // Nothing to embed again (its sections are current), but its vector is written.
    expect(await articleChanged({ articleId: id }, log)).toEqual({ skipped: false, embedded: 0 });
    expect(await prisma.articleVector.count({ where: { articleId: id } })).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    await openai.close();
  }
});
