import type { Prisma } from "@tuti/db";
import { titleSlug } from "@tuti/shared/post-urls";

/** The docs' addresses (/docs/<slug>): one per tab, collection and live article in a project, with redirects from old ones. */

/**
 * A slug from `text` for a tab, collection or article (`page`, when it has one) that no other tab,
 * collection or live article in the project has, so /docs/<slug> is one page: "getting-started",
 * then "getting-started-2", … Call it with the project locked (lockProject), so two saves can't pick
 * the same one, in the transaction that gives the page the slug. Deleted articles don't hold on to
 * their slugs (a restored one takes the next free one if its own is gone).
 *
 * Redirects (docs_redirect) follow: a slug only a redirect has is free, and taking it drops the
 * redirect; when `page` gets a new slug, its old one (`page.slug`, read under the lock) redirects
 * to it.
 */
export async function freeDocsSlug(
  tx: Prisma.TransactionClient,
  projectId: string,
  text: string,
  kind: "tab" | "collection" | "article",
  page?: { id: string; slug: string },
  // Sample content (server/sample-content.ts) takes no redirect's slug: the redirect would be gone once it's removed.
  { keepRedirects = false } = {},
) {
  const base = titleSlug(text, kind);
  const taken = await docsSlugsTaken(tx, projectId, { startsWith: base }, page);
  const redirects = keepRedirects ? await tx.docsRedirect.findMany({ where: { projectId, slug: { startsWith: base } }, select: { slug: true } }) : [];
  const used = new Set([...(kind === "article" ? RESERVED_ARTICLE_SLUGS : []), ...taken.map((row) => row.slug), ...redirects.map((row) => row.slug)]);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return keepRedirects ? candidate : claimDocsSlug(tx, projectId, candidate, kind, page);
}

/**
 * "new", "insights", "tabs" and "collections" are the team's pages under /app/<project>/docs (a tab's
 * and a collection's are under the last two), and /docs/api is the API reference (Tuti's own is the
 * app's domain, and later each portal's from an OpenAPI file), so no article can have them.
 */
export const RESERVED_ARTICLE_SLUGS = ["new", "insights", "api", "tabs", "collections"];

/** The tabs, collections and live articles in the project (but `page`) whose slug matches `slug`, with their names. */
export async function docsSlugsTaken(tx: Prisma.TransactionClient, projectId: string, slug: Prisma.StringFilter | string, page?: { id: string }) {
  // Ids are unique across the three tables (cuids), so `page` needs no kind.
  const where = { projectId, slug, ...(page && { id: { not: page.id } }) };
  return [
    ...(await tx.docsTab.findMany({ where, select: { slug: true, name: true } })).map((tab) => ({ ...tab, kind: "the tab" })),
    ...(await tx.collection.findMany({ where, select: { slug: true, name: true } })).map((c) => ({ ...c, kind: "the collection" })),
    ...(await tx.article.findMany({ where: { ...where, deletedAt: null }, select: { slug: true, title: true } })).map((a) => ({
      slug: a.slug,
      name: a.title,
      kind: "the article",
    })),
  ];
}

/** Gives a page `candidate` (free, under the lock): a redirect with it goes, and `page`'s old slug redirects to it. */
export async function claimDocsSlug(
  tx: Prisma.TransactionClient,
  projectId: string,
  candidate: string,
  kind: "tab" | "collection" | "article",
  page?: { id: string; slug: string },
) {
  await tx.docsRedirect.deleteMany({ where: { projectId, slug: candidate } });
  if (page && page.slug !== candidate) {
    const to = {
      tabId: kind === "tab" ? page.id : null,
      collectionId: kind === "collection" ? page.id : null,
      articleId: kind === "article" ? page.id : null,
    };
    await tx.docsRedirect.upsert({
      where: { projectId_slug: { projectId, slug: page.slug } },
      create: { projectId, slug: page.slug, ...to },
      update: to,
    });
  }
  return candidate;
}
