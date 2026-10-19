import { prisma } from "@tuti/db";

import { portalUrl } from "@/lib/hosts";

/** Portals are public: crawlers are welcome, and pointed to the sitemap. */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/robots.txt">) {
  const { project: slug } = await params;
  if (!(await prisma.project.findUnique({ where: { slug }, select: { id: true } }))) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${portalUrl(slug)}/sitemap.xml\n`, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
