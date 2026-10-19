import { prisma } from "@tuti/db";

import { portalUrl } from "@/lib/hosts";
import { postPath } from "@/lib/post-urls";

/** A sitemap holds up to 50,000 URLs; the rest of them are pages and boards. */
const MAX_POSTS = 45_000;

const newest = (dates: Date[]) => (dates.length > 0 ? new Date(Math.max(...dates.map(Number))) : undefined);

/**
 * The portal's public pages for search engines: home, boards, posts, the
 * roadmap, the changelog and the help center, each with when it last changed.
 * Merged posts (they redirect), drafts and the sign-in pages are left out.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/sitemap.xml">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: {
      boards: { orderBy: { createdAt: "asc" }, select: { id: true, slug: true, updatedAt: true } },
      // ponytail: newest 45,000 posts only; a sitemap index of several files when a portal has more.
      posts: {
        where: { duplicateOfId: null },
        orderBy: { updatedAt: "desc" },
        take: MAX_POSTS,
        select: { boardId: true, number: true, title: true, updatedAt: true },
      },
      changelogEntries: { where: { publishedAt: { not: null } }, orderBy: { number: "desc" }, select: { number: true, updatedAt: true } },
      articles: { where: { publishedAt: { not: null } }, orderBy: { slug: "asc" }, select: { slug: true, updatedAt: true } },
    },
  });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  const latestPost = project.posts[0]?.updatedAt;
  const pages: { path: string; lastmod?: Date }[] = [
    { path: "", lastmod: latestPost },
    ...project.boards.map((board) => ({
      path: `/b/${board.slug}`,
      lastmod: newest([board.updatedAt, ...project.posts.filter((post) => post.boardId === board.id).map((post) => post.updatedAt)]),
    })),
    ...project.posts.map((post) => ({ path: postPath(post), lastmod: post.updatedAt })),
    { path: "/roadmap", lastmod: latestPost },
    { path: "/changelog", lastmod: newest(project.changelogEntries.map((entry) => entry.updatedAt)) },
    ...project.changelogEntries.map((entry) => ({ path: `/changelog/${entry.number}`, lastmod: entry.updatedAt })),
    { path: "/help", lastmod: newest(project.articles.map((article) => article.updatedAt)) },
    ...project.articles.map((article) => ({ path: `/help/${article.slug}`, lastmod: article.updatedAt })),
  ];
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
