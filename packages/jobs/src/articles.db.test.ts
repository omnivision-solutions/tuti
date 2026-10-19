import { prisma } from "@tuti/db";
import { FAKE_OPENAI_KEY, startOpenAIFake } from "@tuti/testkit";
import { expect, test, vi } from "vitest";

import { embedPublishedArticles } from "./articles";

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
    expect(await embedPublishedArticles({ info: () => {}, warn: () => {} })).toEqual({ articles: 2, failed: [failing.id] });
    const chunks = (articleId: string) => prisma.articleChunk.count({ where: { articleId } });
    expect([await chunks(failing.id), await chunks(next.id), await chunks(draft.id)]).toEqual([0, 1, 0]);
  } finally {
    vi.unstubAllEnvs();
    await openai.close();
  }
});
