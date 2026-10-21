import { prisma } from "@tuti/db";

import { portalUrl } from "@/lib/hosts";
import { boardPath, postPath } from "@/lib/post-urls";
import { visibleArticle } from "@/lib/reader-groups";
import { listedArticle } from "@/server/help-queries";

// Next.js prerenders routes named sitemap.xml at build time (as metadata routes), where there's no database.
export const dynamic = "force-dynamic";

/** The most URLs a sitemap may list. */
const MAX_URLS = 50_000;

const newest = (dates: Date[]) => dates.reduce<Date | undefined>((a, b) => (a && a > b ? a : b), undefined);

/**
 * The portal's public pages for search engines: home, boards, posts, the
 * roadmap, the changelog and the help center, each with when it last changed.
 * Merged posts (they redirect), drafts, articles that aren't listed everywhere and the
 * sign-in pages are left out.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/sitemap.xml">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      boards: { orderBy: { createdAt: "asc" }, select: { id: true, slug: true, updatedAt: true } },
      posts: {
        where: { duplicateOfId: null },
        orderBy: { updatedAt: "desc" },
        take: MAX_URLS,
        select: { boardId: true, number: true, title: true, updatedAt: true, board: { select: { slug: true } } },
      },
      changelogEntries: { where: { publishedAt: { not: null } }, orderBy: { number: "desc" }, select: { number: true, updatedAt: true } },
      // For search engines: not the ones for some reader groups only.
      articles: { where: { ...listedArticle, ...visibleArticle([]) }, orderBy: { slug: "asc" }, select: { slug: true, updatedAt: true } },
    },
  });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
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
    { path: "/docs", lastmod: newest(project.articles.map((article) => article.updatedAt)) },
    ...project.articles.map((article) => ({ path: `/docs/${article.slug}`, lastmod: article.updatedAt })),
    // Posts last, newest first: past the limit, the oldest are the ones left out.
    // ponytail: one file of up to 50,000 URLs; a sitemap index of several files when a portal outgrows it.
    ...project.posts.map((post) => ({ path: postPath(post), lastmod: post.updatedAt })),
  ].slice(0, MAX_URLS);
  const portal = portalUrl(slug);
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
