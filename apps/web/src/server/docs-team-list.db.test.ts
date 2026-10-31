import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import TeamDocsLayout from "@/app/app/[project]/docs/layout";
import TeamDocsPage from "@/app/app/[project]/docs/page";
import { actAs, createProject, signUp } from "@/test/helpers";

const DAY = 86_400_000;

// Rendered outside Next: the page's address, as the docs' tree reads it.
const at = vi.hoisted(() => ({ pathname: "" }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), usePathname: () => at.pathname }));

test("Docs' list: a status only when it isn't published as written, drafts and unpublished changes first, and each article's views and helpful answers in 30 days", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const article = (slug: string, title: string, publishedAt: Date | null, order: number) =>
    prisma.article.create({ data: { projectId: project.id, slug, title, body: "Words.", publishedAt, order } });
  // In reading order (not by title): published, then one with changes not published, then a draft.
  const invite = await article("inviting", "Inviting your team", new Date(), 0);
  const exports = await article("exports", "Exports", new Date(), 1);
  await article("billing", "Billing", null, 2);
  await prisma.articleChanges.create({ data: { articleId: exports.id, title: "Exports", body: "New words." } });
  // Read 5 times today and 100 times 40 days ago (outside the window); two found it helpful lately, one didn't.
  await prisma.articleViewDay.createMany({
    data: [
      { articleId: invite.id, day: new Date(new Date().toISOString().slice(0, 10)), views: 5 },
      { articleId: invite.id, day: new Date(Date.now() - 40 * DAY), views: 100 },
    ],
  });
  await prisma.articleFeedback.createMany({
    data: [
      { articleId: invite.id, readerId: "reader-1", helpful: true },
      { articleId: invite.id, readerId: "reader-2", helpful: true },
      { articleId: invite.id, readerId: "reader-3", helpful: false },
      // Helped, but 40 days ago: outside the window.
      { articleId: invite.id, readerId: "reader-4", helpful: true, createdAt: new Date(Date.now() - 40 * DAY), updatedAt: new Date(Date.now() - 40 * DAY) },
    ],
  });

  const params = Promise.resolve({ project: project.slug });
  at.pathname = `/app/${project.slug}/docs`;
  const html = renderToStaticMarkup(await TeamDocsLayout({ params, children: await TeamDocsPage({ params } as never) } as never));
  // The list, after its tabs (the tree beside it lists the articles too).
  const text = html.slice(html.indexOf('aria-label="Docs sections"')).replace(/<[^>]+>/g, "|");
  const rows = [...text.matchAll(/\|(Inviting your team|Billing|Exports)\|/g)].map((m) => m[1]);
  // The two needing work first, in reading order between them.
  expect(rows).toEqual(["Exports", "Billing", "Inviting your team"]);
  expect(text).toContain("|Draft|");
  expect(text).toContain("|Changes not published|");
  expect(text).not.toContain("|Published");
  expect(text).toContain("5 views in 30 days · 2 found it helpful");
  expect(text).toContain("0 views in 30 days");
  // Content and Insights as tabs.
  expect(html).toContain(`href="/app/${project.slug}/docs/insights"`);
});
