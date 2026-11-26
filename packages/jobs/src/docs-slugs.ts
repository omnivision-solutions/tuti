import type { Prisma } from "@tuti/db";
import { titleSlug } from "@tuti/shared/post-urls";

/** The docs' addresses (/docs/<slug>): one per tab, collection, API reference and live article in a project, with redirects from old ones. */

/** What has an address. An API reference keeps its own when it's renamed, so no redirect points at one. */
export type DocsPageKind = "tab" | "collection" | "article" | "reference";

/**
 * A slug from `text` for a tab, collection, article or API reference (`page`, when it has one) that no
 * other tab, collection, API reference or live article in the project has, so /docs/<slug> is one page: "getting-started",
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
  kind: DocsPageKind,
  page?: { id: string; slug: string },
  // Sample content (server/sample-content.ts) takes no redirect's slug: the redirect would be gone once it's removed.
  { keepRedirects = false } = {},
) {
  const base = titleSlug(text, kind);
  // A tab's, collection's or API reference's slug is one page in every language: free of every language's article slugs too,
  // current or old. An article's, of the others' current ones: its address in a language it has no version in is its own.
  const taken = await docsSlugsTaken(tx, projectId, { startsWith: base }, page, { languages: kind === "article" ? "current" : "all" });
  const redirects = keepRedirects ? await tx.docsRedirect.findMany({ where: { projectId, slug: { startsWith: base } }, select: { slug: true } }) : [];
  const used = new Set([...(kind === "article" ? RESERVED_ARTICLE_SLUGS : []), ...taken.map((row) => row.slug), ...redirects.map((row) => row.slug)]);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return keepRedirects ? candidate : claimDocsSlug(tx, projectId, candidate, kind, page);
}

/**
 * "new", "insights", "tabs", "collections" and "references" are the team's pages under /app/<project>/docs (a tab's,
 * a collection's and an API reference's are under the last three), and /docs/api is the API reference (Tuti's own is the
 * app's domain, and later each portal's from an OpenAPI file), so no article can have them.
 */
export const RESERVED_ARTICLE_SLUGS = ["new", "insights", "api", "tabs", "collections", "references"];

/**
 * The tabs, collections, API references and live articles in the project (but `page`) whose slug matches `slug`, with their
 * names; with `languages`, the articles' slugs in the other languages too: "all", current or old (for a tab's, collection's or
 * API reference's slug, which is one page in every language: /de/docs/<slug>); "current", other articles' current ones (for
 * an article's default-language slug, which is its address in a language it has no version in).
 */
export async function docsSlugsTaken(
  tx: Prisma.TransactionClient,
  projectId: string,
  slug: Prisma.StringFilter | string,
  page?: { id: string },
  { languages }: { languages?: "all" | "current" } = {},
) {
  // Ids are unique across the four tables (cuids), so `page` needs no kind.
  const where = { projectId, slug, ...(page && { id: { not: page.id } }) };
  return [
    ...(await tx.docsTab.findMany({ where, select: { slug: true, name: true } })).map((tab) => ({ ...tab, kind: "the tab" })),
    ...(await tx.collection.findMany({ where, select: { slug: true, name: true } })).map((c) => ({ ...c, kind: "the collection" })),
    ...(await tx.apiReference.findMany({ where, select: { slug: true, name: true } })).map((r) => ({ ...r, kind: "the API reference" })),
    ...(await tx.article.findMany({ where: { ...where, deletedAt: null }, select: { slug: true, title: true } })).map((a) => ({
      slug: a.slug,
      name: a.title,
      kind: "the article",
    })),
    ...(languages ? await languageSlugsTaken(tx, projectId, slug, languages === "all", page?.id) : []),
  ];
}

/** Live articles' slugs in the project's other languages that match `slug` (with `old`, old ones too; never `articleId`'s), with the article's title. */
async function languageSlugsTaken(tx: Prisma.TransactionClient, projectId: string, slug: Prisma.StringFilter | string, old: boolean, articleId?: string) {
  const article = { select: { title: true } } as const;
  const where = { projectId, slug, article: { deletedAt: null }, ...(articleId && { articleId: { not: articleId } }) };
  const [current, olds] = await Promise.all([
    tx.articleTranslation.findMany({ where, select: { slug: true, article } }),
    old ? tx.articleOldSlug.findMany({ where, select: { slug: true, article } }) : [],
  ]);
  return [...current, ...olds].map((row) => ({ slug: row.slug!, name: row.article.title, kind: "the article" }));
}

/**
 * What a language's article slug can't be: reserved, or a tab's, collection's or API reference's slug, current or old (they
 * keep one slug in every language, so /de/docs/<slug> is one page), matching `slug`.
 */
async function sharedSlugsTaken(tx: Prisma.TransactionClient, projectId: string, slug: Prisma.StringFilter | string): Promise<string[]> {
  const where = { projectId, slug };
  const [tabs, collections, references, redirects] = await Promise.all([
    tx.docsTab.findMany({ where, select: { slug: true } }),
    tx.collection.findMany({ where, select: { slug: true } }),
    tx.apiReference.findMany({ where, select: { slug: true } }),
    tx.docsRedirect.findMany({ where: { ...where, articleId: null }, select: { slug: true } }),
  ]);
  return [...RESERVED_ARTICLE_SLUGS, ...[...tabs, ...collections, ...references, ...redirects].map((row) => row.slug)];
}

/**
 * A slug in `language` for an article's version (`version`, with its current slug), from `text` (its translated title):
 * free in the project and language (another live article's version doesn't have it, nor its default-language slug, which is
 * its address in a language it has no version in) and of every tab's, collection's and API reference's slug, current or old:
 * "abrechnung", then "abrechnung-2", … A title with no Latin letters to make one of
 * (Japanese, Korean, Chinese) starts from the article's default-language slug (`fallback`). Call it with the project locked,
 * in the transaction that gives the version the slug (claimLanguageSlug follows, as claimDocsSlug does for the default's).
 */
export async function freeLanguageSlug(
  tx: Prisma.TransactionClient,
  projectId: string,
  language: string,
  text: string,
  version: { id: string; articleId: string; slug: string | null },
  fallback: string,
) {
  const base = titleSlug(text, "") || fallback;
  const [shared, versions, articles] = await Promise.all([
    sharedSlugsTaken(tx, projectId, { startsWith: base }),
    tx.articleTranslation.findMany({ where: { projectId, language, slug: { startsWith: base }, id: { not: version.id }, article: { deletedAt: null } }, select: { slug: true } }),
    tx.article.findMany({ where: { projectId, slug: { startsWith: base }, id: { not: version.articleId }, deletedAt: null }, select: { slug: true } }),
  ]);
  const used = new Set([...shared, ...versions.map((row) => row.slug!), ...articles.map((row) => row.slug)]);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}-${n}`;
  }
  return claimLanguageSlug(tx, projectId, language, candidate, version);
}

/**
 * Why `slug` can't be an article's own slug in `language` (the team's, `customSlug`), or null when it can: reserved, a tab's,
 * collection's or API reference's (current or old), or another live article's in that language or in the default one.
 */
export async function languageSlugRefused(
  tx: Prisma.TransactionClient,
  projectId: string,
  language: string,
  slug: string,
  version: { id: string; articleId: string },
): Promise<{ reason: "reserved" | "taken"; message: string } | null> {
  if (RESERVED_ARTICLE_SLUGS.includes(slug)) {
    return { reason: "reserved", message: `“${slug}” is reserved; pick another` };
  }
  if ((await sharedSlugsTaken(tx, projectId, slug)).includes(slug)) {
    return { reason: "taken", message: "That address is taken by a tab, collection or API reference" };
  }
  const other = await tx.articleTranslation.findFirst({ where: { projectId, language, slug, id: { not: version.id }, article: { deletedAt: null } }, select: { article: { select: { title: true } } } });
  const article = other?.article ?? (await tx.article.findFirst({ where: { projectId, slug, id: { not: version.articleId }, deletedAt: null }, select: { title: true } }));
  return article ? { reason: "taken", message: `That address is taken by the article “${article.title}”` } : null;
}

/**
 * Gives an article's version in `language` the slug `candidate` (free, under the lock): an old slug with it in the language
 * goes, a deleted article's version holding it lets it go (deleted articles keep no slugs), and the version's own old slug,
 * if it had one, stays as an old slug in the language.
 */
export async function claimLanguageSlug(
  tx: Prisma.TransactionClient,
  projectId: string,
  language: string,
  candidate: string,
  version: { id: string; articleId: string; slug: string | null },
) {
  await tx.articleOldSlug.deleteMany({ where: { projectId, language, slug: candidate } });
  await tx.articleTranslation.updateMany({ where: { projectId, language, slug: candidate, id: { not: version.id } }, data: { slug: null } });
  if (version.slug && version.slug !== candidate) {
    await tx.articleOldSlug.upsert({
      where: { projectId_language_slug: { projectId, language, slug: version.slug } },
      create: { projectId, language, slug: version.slug, articleId: version.articleId },
      update: { articleId: version.articleId },
    });
  }
  return candidate;
}

/** Gives a page `candidate` (free, under the lock): a redirect with it goes, and `page`'s old slug redirects to it (an API reference's doesn't). */
export async function claimDocsSlug(
  tx: Prisma.TransactionClient,
  projectId: string,
  candidate: string,
  kind: DocsPageKind,
  page?: { id: string; slug: string },
) {
  await tx.docsRedirect.deleteMany({ where: { projectId, slug: candidate } });
  if (kind !== "reference" && page && page.slug !== candidate) {
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

/**
 * A deleted article brought back (articles.restore): each of its versions keeps its slug while it's still free there, else
 * (taken since, as deleted articles keep no slugs, or let go to another) gets one from its title, as a new version would.
 * Call it with the project locked, after the article has its default-language slug back.
 */
export async function restoreLanguageSlugs(tx: Prisma.TransactionClient, projectId: string, articleId: string) {
  const [article, versions] = await Promise.all([
    tx.article.findUniqueOrThrow({ where: { id: articleId }, select: { slug: true } }),
    tx.articleTranslation.findMany({ where: { articleId, publishedAt: { not: null } }, select: { id: true, language: true, slug: true, title: true } }),
  ]);
  // Its old slugs too: one taken meanwhile (a tab's, a collection's or API reference's, another article's default-language
  // one, or its current one in that language) goes, else it would lead away from that page.
  const olds = await tx.articleOldSlug.findMany({ where: { articleId }, select: { id: true, language: true, slug: true } });
  for (const old of olds) {
    const other = { id: "", articleId };
    if (await languageSlugRefused(tx, projectId, old.language, old.slug, other)) {
      await tx.articleOldSlug.delete({ where: { id: old.id } });
    }
  }
  for (const version of versions) {
    const own = { id: version.id, articleId };
    if (version.slug && !(await languageSlugRefused(tx, projectId, version.language, version.slug, own))) {
      continue;
    }
    // Its old address isn't kept: another article may have it now.
    const slug = await freeLanguageSlug(tx, projectId, version.language, version.title, { ...own, slug: null }, article.slug);
    await tx.articleTranslation.update({ where: { id: version.id }, data: { slug, customSlug: false } });
  }
}
