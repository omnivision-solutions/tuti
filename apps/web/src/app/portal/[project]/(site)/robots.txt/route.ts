import { prisma } from "@tuti/db";

import { portalAddress } from "@/server/custom-domains";

/** Public portals welcome crawlers and point them to the sitemap; private ones keep them out. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/robots.txt">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { portalAccess: true } });
  if (!project) {
    return new Response("Not found", { status: 404 });
  }
  const body =
    project.portalAccess === "PRIVATE"
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nAllow: /\n\nSitemap: ${await portalAddress(slug)}/sitemap.xml\n`;
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
