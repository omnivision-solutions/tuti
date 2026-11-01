import { prisma } from "@tuti/db";
import { FAKE_OPENAI_KEY, startOpenAIFake } from "@tuti/testkit";
import { expect, test, vi } from "vitest";

import { articleChanged, embedPublishedArticles } from "./articles";

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
