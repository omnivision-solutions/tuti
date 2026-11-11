import { prisma } from "@tuti/db";
import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import type { ReactNode } from "react";
import { articleRowDetails, TabContents } from "@/components/docs-article-rows";
import { teamDocs } from "@/server/team-docs";

const render = (node: ReactNode) => new Promise<string>((resolve, reject) => {
  const output = new PassThrough();
  let html = "";
  output.on("data", (chunk) => { html += chunk; });
  output.on("end", () => resolve(html));
  const stream = renderToPipeableStream(node, { onAllReady() { stream.pipe(output); }, onError: reject });
});
import { expect, test, vi } from "vitest";

import TeamDocsLayout from "@/app/app/[project]/docs/layout";
import TeamDocsPage from "@/app/app/[project]/docs/page";
import { ArticleHistory, authorPhotos } from "@/components/article-history";
import { actAs, createProject, signUp } from "@/test/helpers";

vi.mock("@/components/ui/sidebar", () => ({ useSidebar: () => ({ setOpenMobile() {}, setOpen() {}, isMobile: false }) }));

const DAY = 86_400_000;

// Rendered outside Next: the page's address, as the docs' tree reads it.
const at = vi.hoisted(() => ({ pathname: "" }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => at.pathname,
  useSearchParams: () => new URLSearchParams(),
  // Verify all's dialog, in "More actions".
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

test("Docs' list: in reading order, each article's publishing state, views and helpful answers in 30 days; what waits to be published, newest first; and the tree beside it", async () => {
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

  // Read too, but not counted in the strip's totals (as Reporting doesn't): a sample article and a deleted one (unpublished as
  // it was deleted).
  const sample = await prisma.article.create({ data: { projectId: project.id, slug: "sample", title: "A sample", body: "Words.", publishedAt: new Date(), order: 4, sample: true } });
  const gone = await prisma.article.create({ data: { projectId: project.id, slug: "gone", title: "Gone", body: "Words.", order: 5, deletedAt: new Date() } });
  await prisma.articleViewDay.createMany({
    data: [sample, gone].map((a) => ({ articleId: a.id, day: new Date(new Date().toISOString().slice(0, 10)), views: 50 })),
  });
  await prisma.articleFeedback.createMany({ data: [sample, gone].map((a) => ({ articleId: a.id, readerId: `reader-${a.slug}`, helpful: true })) });

  const params = Promise.resolve({ project: project.slug });
  at.pathname = `/app/${project.slug}/docs`;
  const html = await render(await TeamDocsLayout({ params, children: await TeamDocsPage({ params } as never) } as never));
  const text = html.replace(/<[^>]+>/g, "|");
  // The strip's totals: the live articles' views and helpful votes in the window only.
  const strip = text.slice(text.indexOf("Live articles"), text.indexOf("Waiting to publish|"));
  expect(strip).toMatch(/\|5\|+Views/);
  expect(strip).toMatch(/\|2\|+Helpful votes/);
  // What waits to be published: the draft and the one with changes, newest saved first (the changes; the draft's move
  // since isn't a save), each saying when.
  const waiting = (html.match(/<section aria-labelledby="waiting-title"[\s\S]*?<\/section>/)?.[0] ?? "").replace(/<[^>]+>/g, "|");
  expect([...waiting.matchAll(/\|(Inviting your team|Billing|Exports)\|/g)].map((m) => m[1])).toEqual(["Exports", "Billing"]);
  expect(waiting).toMatch(/saved \|*2 hours ago/);
  // The list (articles in no collection here), in reading order, as the tree beside it has them.
  const list = (await render(TabContents({ projectSlug: project.slug, docs: await teamDocs(project.id), details: await articleRowDetails(project.id), tab: null, uncollected: (await teamDocs(project.id)).uncollected }))).replace(/<[^>]+>/g, "|");
  expect([...list.matchAll(/\|(Inviting your team|Billing|Exports)\|/g)].map((m) => m[1])).toEqual(["Inviting your team", "Exports", "Billing"]);
  expect(list).toContain("|Draft|");
  expect(list).toContain("|Unpublished changes|");
  expect(list).toContain("|Published|");
  // Views and helpful answers in the window, as columns (said in full to the ear); none: a dash.
  expect(list.replaceAll("|", "")).toContain("5 views in 30 days");
  expect(list.replaceAll("|", "")).toContain("2 found it helpful");
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
  const html = await render(
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

test("a folded collection's band counts what waits in the collections inside it too", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  // First a collection that opens with the page; then Billing (folded) with nothing of its own waiting, and a draft in
  // Invoices, inside it.
  await prisma.collection.create({ data: { projectId: project.id, slug: "start", name: "Start", order: 0 } });
  const billing = await prisma.collection.create({ data: { projectId: project.id, slug: "billing", name: "Billing", order: 1 } });
  const invoices = await prisma.collection.create({ data: { projectId: project.id, slug: "invoices", name: "Invoices", order: 0, parentId: billing.id } });
  await prisma.article.create({ data: { projectId: project.id, slug: "plans", title: "Plans", body: "Words.", publishedAt: new Date(), collectionId: billing.id } });
  await prisma.article.create({ data: { projectId: project.id, slug: "refunds", title: "Refunds", body: "Words.", collectionId: invoices.id } });

  const docs = await teamDocs(project.id);
  const html = await render(TabContents({ projectSlug: project.slug, docs, details: await articleRowDetails(project.id), tab: null, uncollected: docs.uncollected }));
  const band = html.slice(html.indexOf('role="region" aria-label="Billing"'), html.indexOf("</summary>", html.indexOf('role="region" aria-label="Billing"'))).replace(/<[^>]+>/g, "|");
  expect(band).toMatch(/1\|* unpublished/);
});

test("collection totals exclude sample readership, Updated uses the save time, and Autopilot is credited", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const collection = await prisma.collection.create({ data: { projectId: project.id, slug: "billing", name: "Billing" } });
  const article = await prisma.article.create({ data: { projectId: project.id, collectionId: collection.id, slug: "plans", title: "Plans", body: "Seats.", publishedAt: new Date() } });
  const sample = await prisma.article.create({ data: { projectId: project.id, collectionId: collection.id, slug: "sample", title: "Sample plans", body: "Seats.", sample: true } });
  const action = await prisma.codeChangeAction.create({ data: { articleId: article.id, kind: "ARTICLE_EDIT", probability: 1 } });
  await prisma.articleRevision.create({ data: { articleId: article.id, title: "Plans", body: "Seats.", codeChangeActionId: action.id, createdAt: new Date(Date.now() - 2 * 3_600_000) } });
  await prisma.article.update({ where: { id: article.id }, data: { order: 2 } });
  await prisma.articleViewDay.createMany({ data: [{ articleId: article.id, day: new Date(), views: 7 }, { articleId: sample.id, day: new Date(), views: 100 }] });
  const { default: CollectionPage } = await import("@/app/app/[project]/docs/collections/[collection]/page");
  const params = Promise.resolve({ project: project.slug, collection: collection.slug });
  const html = await render(await TeamDocsLayout({ params, children: await CollectionPage({ params } as never) } as never));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  expect(text).toContain("7 views");
  expect(text).not.toContain("107 views");
  expect(text).toContain("Last edited 2 hours ago by Autopilot");
  expect(html).toMatch(/docs-updated[^>]*>2 hours ago/);
});

test("History shows ten versions at a time and keeps earlier versions reachable", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  actAs(owner);
  const article = await prisma.article.create({ data: { projectId: project.id, slug: "plans", title: "Plans", body: "Seats." } });
  await prisma.articleRevision.createMany({ data: Array.from({ length: 14 }, (_, i) => ({ articleId: article.id, title: "Plans", body: `Paragraph ${i}.`, createdAt: new Date(Date.now() - i * 60_000) })) });
  const props = { projectSlug: project.slug, article, current: { title: "Plans", body: "Seats.", content: null, collection: null }, selectedId: "none" };
  const html = await render(await ArticleHistory(props));
  expect((html.match(/<li>/g) ?? [])).toHaveLength(10);
  expect(html).toContain("Show earlier versions");
  expect(html).toContain("1 paragraph changed");
  expect(html).not.toContain("0 paragraphs changed");
  const earlier = await render(await ArticleHistory({ ...props, limit: 20 }));
  expect((earlier.match(/<li>/g) ?? [])).toHaveLength(14);
  expect(earlier).not.toContain("Show earlier versions");
});
