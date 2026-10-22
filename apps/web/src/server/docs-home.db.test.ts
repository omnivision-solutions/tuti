import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { SIGNED_OUT } from "@/lib/read-access";
import { createProject, signUp } from "@/test/helpers";

import { docsContents, popularArticles } from "./docs-queries";

/** The docs' home's "Popular articles" (Customize → Docs home): what's most read lately, of what this reader may open. */

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  project = await createProject(await signUp("Owner"));
});

async function article(title: string, views: number, data: { listing?: "UNLISTED"; access?: "SIGNED_IN"; daysAgo?: number } = {}) {
  const slug = title.toLowerCase().replaceAll(" ", "-");
  const { daysAgo = 0, ...rest } = data;
  const { id } = await prisma.article.create({ data: { projectId: project.id, slug, title, body: title, publishedAt: new Date(), ...rest } });
  if (views > 0) {
    await prisma.articleViewDay.create({ data: { articleId: id, day: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000), views } });
  }
  return slug;
}

const popular = async () => popularArticles(project.slug, await docsContents(project.slug, { reader: SIGNED_OUT }));

test("the most-viewed articles of the last 30 days, most first; only ones this reader may open, and listed", async () => {
  await article("Billing", 5);
  await article("Inviting your team", 12);
  await article("Exporting", 1);
  // Not in the lists, or not for signed-out readers, or read long ago, or never.
  await article("Hidden gem", 50, { listing: "UNLISTED" });
  await article("Pro features", 40, { access: "SIGNED_IN" });
  await article("Old news", 30, { daysAgo: 45 });
  await article("Never read", 0);
  expect((await popular()).map((a) => a.title)).toEqual(["Inviting your team", "Billing", "Exporting"]);
});

test("at most five", async () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    await article(`Article ${n}`, n);
  }
  expect((await popular()).map((a) => a.title)).toEqual(["Article 7", "Article 6", "Article 5", "Article 4", "Article 3"]);
});

test("none without articles or views", async () => {
  expect(await popular()).toEqual([]);
  await article("Billing", 0);
  expect(await popular()).toEqual([]);
});
