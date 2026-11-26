import { prisma } from "@tuti/db";

import { visibleEntry } from "@/lib/reader-groups";
import { portalAddress } from "@/server/custom-domains";
import { languagePrefix } from "@/lib/language-addresses";
import { pageLanguages } from "@/server/language-addresses";
import { boardPath, postPath } from "@/lib/post-urls";
import { SIGNED_OUT } from "@/lib/read-access";
import { shownOperations } from "@/server/api-reference-queries";
import {
  type DocsArticleLink,
  type DocsCollection,
  docsContents,
  docsTabPath,
  everyCollection,
  listedArticle,
  readableArticle,
  servedArticle,
  tabLandingSlug,
} from "@/server/docs-queries";
import { PORTAL_BOARDS, SIGNED_OUT_VIEWER, visiblePosts } from "@/server/post-visibility";

// Next.js prerenders routes named sitemap.xml at build time (as metadata routes), where there's no database.
export const dynamic = "force-dynamic";

/** The most URLs a sitemap may list. */
const MAX_URLS = 50_000;

const newest = (dates: (Date | undefined)[]) => dates.reduce<Date | undefined>((a, b) => (!b || (a && a > b) ? a : b), undefined);

/**
 * The portal's public pages for search engines: home, boards, posts, the
 * roadmap, the changelog and the docs (with their tabs', collections' and API references' pages, and each operation's,
 * dated by when its reference's spec last changed), each with when it
 * last changed (a tab's or collection's: the newest of itself, the collections in it and the articles listed here in them, and a tab's
 * references). Merged posts
 * (they redirect), drafts, articles that aren't listed everywhere or block search indexing,
 * pages for signed-in readers or some groups only (and tabs with nothing else), sample content (server/sample-content.ts)
 * and the sign-in pages are left out.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/sitemap.xml">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      id: true,
      boards: { where: PORTAL_BOARDS, orderBy: { createdAt: "asc" }, select: { id: true, slug: true, updatedAt: true } },
      // Public posts only (post-visibility.ts).
      posts: {
        where: { duplicateOfId: null, sample: false, ...visiblePosts(SIGNED_OUT_VIEWER) },
        orderBy: { updatedAt: "desc" },
        take: MAX_URLS,
        select: { boardId: true, number: true, title: true, updatedAt: true, board: { select: { slug: true } } },
      },
      // Not sample collections: the portal shows no name or text of theirs, so their edits change no page.
      collections: { where: { sample: false }, select: { slug: true, updatedAt: true } },
      docsTabs: { select: { slug: true, updatedAt: true } },
      apiReferences: { select: { slug: true, updatedAt: true } },
      changelogEntries: { where: { publishedAt: { not: null }, sample: false, ...visibleEntry(SIGNED_OUT) }, orderBy: { number: "desc" }, select: { number: true, updatedAt: true } },
    },
  });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  // For search engines, like llms.txt: what's for everyone (nothing for signed-in readers or some groups only). The first tab is /docs.
  const [articles, docs] = await Promise.all([
    prisma.article.findMany({
      where: { projectId: project.id, ...listedArticle, noindex: false, sample: false, ...(await readableArticle(project.id, SIGNED_OUT)) },
      orderBy: { slug: "asc" },
      select: { slug: true, updatedAt: true },
    }),
    docsContents(slug, { reader: SIGNED_OUT, locks: false }),
  ]);
  // A tab showing an article in its place (its first, or one the team picked): that article's edits change its page, even
  // when it's unlisted or kept from search engines (still only one everyone may read).
  const landingSlugs = docs.tabs.flatMap((tab) => tabLandingSlug(tab) ?? []);
  const landings = new Map(
    (landingSlugs.length > 0
      ? await prisma.article.findMany({
          where: { projectId: project.id, ...servedArticle, sample: false, slug: { in: landingSlugs }, ...(await readableArticle(project.id, SIGNED_OUT)) },
          select: { slug: true, updatedAt: true },
        })
      : []
    ).map((article) => [article.slug, article.updatedAt]),
  );
  const landingDate = (tab: (typeof docs.tabs)[number]) => {
    const landing = tabLandingSlug(tab);
    return landing ? landings.get(landing) : undefined;
  };
  // Only the articles listed here count: a hidden one's edit never shows in its tab's or collection's date.
  const articleDates = new Map(articles.map((article) => [article.slug, article.updatedAt]));
  const collectionDates = new Map(project.collections.map((collection) => [collection.slug, collection.updatedAt]));
  const tabDates = new Map(project.docsTabs.map((tab) => [tab.slug, tab.updatedAt]));
  // Only the ones docsContents lists (published, with something on the help center, in a tab for everyone).
  const referenceDates = new Map(project.apiReferences.map((reference) => [reference.slug, reference.updatedAt]));
  const referencesDates = (list: { slug: string }[]) => list.map((reference) => referenceDates.get(reference.slug));
  const operations = [...(await shownOperations(slug, docs.references.map((reference) => reference.slug)))].flatMap(([reference, shown]) =>
    shown.operations.map((operation) => ({ path: `/docs/${reference}/${operation.slug}`, lastmod: shown.changedAt })),
  );
  const homeReferences = (docs.tabs.find((tab) => tab.slug === docs.home) ?? (docs.tabs.length === 0 ? docs : null))?.references ?? [];
  const datesOf = (links: DocsArticleLink[]) => links.flatMap((link) => articleDates.get(link.slug) ?? []);
  // A collection's own and the ones in it: their pages show the names and descriptions of the collections in them.
  const datesIn = (collection: DocsCollection): (Date | undefined)[] => [
    collectionDates.get(collection.slug),
    ...datesOf(collection.articles),
    ...collection.collections.flatMap(datesIn),
  ];
  const latestPost = project.posts[0]?.updatedAt;
  // A tab showing an article in its place is that article's page: in the default language alone, as the article's own.
  const showsArticle = (tab: (typeof docs.tabs)[number] | undefined) => {
    const landing = tab && tabLandingSlug(tab);
    return !!landing && landings.has(landing);
  };
  // `teamText`: an article's, post's or changelog entry's page, in the default language only until it has translations (see portalPageMetadata).
  const pages: { path: string; lastmod?: Date; teamText?: boolean }[] = [
    { path: "", lastmod: latestPost },
    ...project.boards.map((board) => ({
      path: boardPath(board),
      lastmod: newest([board.updatedAt, ...project.posts.filter((post) => post.boardId === board.id).map((post) => post.updatedAt)]),
    })),
    { path: "/roadmap", lastmod: latestPost },
    { path: "/changelog", lastmod: newest(project.changelogEntries.map((entry) => entry.updatedAt)) },
    ...project.changelogEntries.map((entry) => ({ path: `/changelog/${entry.number}`, lastmod: entry.updatedAt, teamText: true })),
    {
      path: "/docs",
      lastmod: newest([...articles.map((article) => article.updatedAt), ...referencesDates(homeReferences)]),
      teamText: showsArticle(docs.tabs.find((tab) => tab.slug === docs.home)),
    },
    ...docs.tabs
      .filter((tab) => tab.slug !== docs.home)
      .map((tab) => ({
        path: docsTabPath(docs, tab.slug),
        lastmod: newest([tabDates.get(tab.slug), landingDate(tab), ...tab.collections.flatMap(datesIn), ...datesOf(tab.uncollected), ...referencesDates(tab.references)]),
        teamText: showsArticle(tab),
      })),
    ...docs.references.map((reference) => ({ path: `/docs/${reference.slug}`, lastmod: referenceDates.get(reference.slug) })),
    ...operations,
    ...everyCollection(docs.collections)
      .filter((collection) => !collection.sample)
      .map((collection) => ({
        path: `/docs/${collection.slug}`,
        lastmod: newest(datesIn(collection)),
      })),
    ...articles.map((article) => ({ path: `/docs/${article.slug}`, lastmod: article.updatedAt, teamText: true })),
    // Posts last, newest first: past the limit, the oldest are the ones left out.
    // ponytail: one file of up to 50,000 URLs; a sitemap index of several files when a portal outgrows it.
    ...project.posts.map((post) => ({ path: postPath(post), lastmod: post.updatedAt, teamText: true })),
  ].slice(0, MAX_URLS);
  const [portal, languages] = await Promise.all([portalAddress(slug), pageLanguages(slug)]);
  const live = languages?.live ?? [];
  const escape = (url: string) => url.replace(/&/g, "&amp;");
  // A page in the live languages too (docs/plan.md, Languages): each language's address listed, each with every language's
  // as alternates (and x-default, the default language's).
  const url = (loc: string, lastmod: Date | undefined, alternates: string) =>
    // lastmod before the alternates: the sitemap schema puts its own elements before other namespaces'.
    `<url><loc>${escape(loc)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ""}${alternates}</url>`;
  const alternate = (hreflang: string, href: string) => `<xhtml:link rel="alternate" hreflang="${hreflang}" href="${escape(href)}"/>`;
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...pages
      .flatMap(({ path, lastmod, teamText }) => {
        if (teamText || live.length === 0 || !languages) {
          return [url(`${portal}${path}`, lastmod, "")];
        }
        const addresses = [[languages.default, `${portal}${path}`], ...live.map((code) => [code, `${portal}${languagePrefix(code)}${path}`])];
        const alternates = [...addresses.map(([code, href]) => alternate(code!, href!)), alternate("x-default", `${portal}${path}`)].join("");
        return addresses.map(([, href]) => url(href!, lastmod, alternates));
      })
      // Within the limit with each language's addresses too (the oldest posts left out first).
      .slice(0, MAX_URLS),
    "</urlset>",
  ].join("\n");
  return new Response(sitemap, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
