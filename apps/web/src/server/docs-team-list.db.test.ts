import { prisma } from "@tuti/db";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import TeamDocsLayout from "@/app/app/[project]/docs/layout";
import TeamDocsPage from "@/app/app/[project]/docs/page";
import { ArticleHistory, authorPhotos } from "@/components/article-history";
import { actAs, createProject, signUp } from "@/test/helpers";

const DAY = 86_400_000;

// Rendered outside Next: the page's address, as the docs' tree reads it.
const at = vi.hoisted(() => ({ pathname: "" }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => at.pathname,
  // Verify all's dialog, in "More actions".
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

test("Docs' list: in reading order, a status only when it isn't published as written, each article's views and helpful answers in 30 days; what waits to be published, newest first; and the tree beside it", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const article = (slug: string, title: string, publishedAt: Date | null, order: number) =>
    prisma.article.create({ data: { projectId: project.id, slug, title, body: "Words.", publishedAt, order } });
  // In reading order (not by title): published, then one with changes not published, then a draft.
  const invite = await article("inviting", "Inviting your team", new Date(), 0);
  const exports = await article("exports", "Exports", new Date(), 1);
  const billing = await article("billing", "Billing", null, 2);
  await prisma.articleChanges.create({ data: { articleId: exports.id, title: "Exports", body: "New words." } });
  // Saved: the draft two hours ago, the changes an hour ago. Then the draft is moved (no save), which bumps its `updatedAt`.
  await prisma.articleRevision.createMany({
    data: [
      { articleId: billing.id, title: "Billing", createdAt: new Date(Date.now() - 2 * 3_600_000) },
      { articleId: exports.id, title: "Exports", createdAt: new Date(Date.now() - 3_600_000) },
    ],
  });
  await prisma.article.update({ where: { id: billing.id }, data: { order: 3 } });
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
  const text = html.replace(/<[^>]+>/g, "|");
  // What waits to be published: the draft and the one with changes, newest saved first (the changes; the draft's move
  // since isn't a save), each saying when.
  const waiting = text.slice(text.indexOf("Waiting to publish|"), text.indexOf("Article|"));
  expect([...waiting.matchAll(/\|(Inviting your team|Billing|Exports)\|/g)].map((m) => m[1])).toEqual(["Exports", "Billing"]);
  expect(waiting).toContain("saved 2 hours ago");
  // The list (articles in no collection here), in reading order, as the tree beside it has them.
  const list = text.slice(text.indexOf("Article|"));
  expect([...list.matchAll(/\|(Inviting your team|Billing|Exports)\|/g)].map((m) => m[1])).toEqual(["Inviting your team", "Exports", "Billing"]);
  expect(list).toContain("|Draft|");
  expect(list).toContain("|Unpublished changes|");
  expect(list).not.toContain("|Published|");
  // Views and helpful answers in the window, as columns (said in full to the ear); none: a dash.
  expect(list).toContain("5 views in 30 days");
  expect(list).toContain("2 found it helpful");
  expect(list).toContain("|–|");
  // The docs' tree beside it, as on every Docs page.
  expect(html).toContain("Browse docs");
  // No tabs over it: what readers did is in Reporting.
  expect(html).not.toContain('aria-label="Docs sections"');
});

test("an article's History shows each save's author with their photo, or else their initials", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const withPhoto = await prisma.user.update({ where: { id: owner.id }, data: { image: "https://example.com/olive.png" } });
  const article = await prisma.article.create({ data: { projectId: project.id, slug: "inviting", title: "Inviting your team", body: "Words." } });
  await prisma.articleRevision.createMany({
    data: [
      { articleId: article.id, title: "Inviting your team", authorId: withPhoto.id, createdAt: new Date(Date.now() - 60_000) },
      { articleId: article.id, title: "Inviting your team", authorId: null },
    ],
  });
  const versions = await prisma.articleRevision.findMany({ where: { articleId: article.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
  // Olive's save: her photo; the one whose author is gone: none (the row shows a mark instead).
  expect(await authorPhotos(versions.map((v) => v.id))).toEqual(new Map([[versions[0]!.id, "https://example.com/olive.png"], [versions[1]!.id, null]]));
  const html = renderToStaticMarkup(
    await ArticleHistory({
      projectSlug: project.slug,
      article: { id: article.id, slug: article.slug, publishedAt: null },
      current: { title: article.title, body: article.body, content: null, collection: null },
      selectedId: undefined,
    }),
  );
  // Her initials under the photo while it loads (the browser shows the photo once it has it).
  expect(html).toContain(">OO<");
  expect(html).toContain("Someone whose account is gone");
});
