import { prisma } from "@tuti/db";

import { portalAddress } from "@/server/custom-domains";
import { boardPath, postPath } from "@/lib/post-urls";
import { SIGNED_OUT } from "@/lib/read-access";
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
 * roadmap, the changelog and the docs (with their tabs' and collections' pages), each with when it
 * last changed (a tab's or collection's: the newest of itself, the collections in it and the articles listed here in them). Merged posts
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
      changelogEntries: { where: { publishedAt: { not: null }, sample: false }, orderBy: { number: "desc" }, select: { number: true, updatedAt: true } },
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
  const datesOf = (links: DocsArticleLink[]) => links.flatMap((link) => articleDates.get(link.slug) ?? []);
  // A collection's own and the ones in it: their pages show the names and descriptions of the collections in them.
  const datesIn = (collection: DocsCollection): (Date | undefined)[] => [
    collectionDates.get(collection.slug),
    ...datesOf(collection.articles),
    ...collection.collections.flatMap(datesIn),
  ];
  const latestPost = project.posts[0]?.updatedAt;
  const pages: { path: string; lastmod?: Date }[] = [
    { path: "", lastmod: latestPost },
    ...project.boards.map((board) => ({
      path: boardPath(board),
      lastmod: newest([board.updatedAt, ...project.posts.filter((post) => post.boardId === board.id).map((post) => post.updatedAt)]),
    })),
    { path: "/roadmap", lastmod: latestPost },
    { path: "/changelog", lastmod: newest(project.changelogEntries.map((entry) => entry.updatedAt)) },
    ...project.changelogEntries.map((entry) => ({ path: `/changelog/${entry.number}`, lastmod: entry.updatedAt })),
    { path: "/docs", lastmod: newest(articles.map((article) => article.updatedAt)) },
    ...docs.tabs
      .filter((tab) => tab.slug !== docs.home)
      .map((tab) => ({
        path: docsTabPath(docs, tab.slug),
        lastmod: newest([tabDates.get(tab.slug), landingDate(tab), ...tab.collections.flatMap(datesIn), ...datesOf(tab.uncollected)]),
      })),
    ...everyCollection(docs.collections)
      .filter((collection) => !collection.sample)
      .map((collection) => ({
        path: `/docs/${collection.slug}`,
        lastmod: newest(datesIn(collection)),
      })),
    ...articles.map((article) => ({ path: `/docs/${article.slug}`, lastmod: article.updatedAt })),
    // Posts last, newest first: past the limit, the oldest are the ones left out.
    // ponytail: one file of up to 50,000 URLs; a sitemap index of several files when a portal outgrows it.
    ...project.posts.map((post) => ({ path: postPath(post), lastmod: post.updatedAt })),
  ].slice(0, MAX_URLS);
  const portal = await portalAddress(slug);
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map(
      ({ path, lastmod }) =>
        `<url><loc>${`${portal}${path}`.replace(/&/g, "&amp;")}</loc>${lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : ""}</url>`,
    ),
    "</urlset>",
  ].join("\n");
  return new Response(sitemap, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
