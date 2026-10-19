import { prisma } from "@tuti/db";

import { SLUG_PATTERN } from "@/lib/project-slugs";

/** Announcements older than this don't make the widget's button say "new". */
const FRESH_DAYS = 30;

/**
 * For the widget script on customers' sites: when the project's latest announced
 * changelog entry was published (within FRESH_DAYS), so the launcher can show it's
 * new to this visitor. Public and the same for everyone, so any site may read it.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const headers = { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" };
  if (!SLUG_PATTERN.test(slug)) {
    return Response.json({ error: "Unknown project" }, { status: 404, headers });
  }
  const latest = await prisma.changelogEntry.findFirst({
    where: {
      project: { slug },
      announced: true,
      publishedAt: { not: null, gte: new Date(Date.now() - FRESH_DAYS * 24 * 60 * 60 * 1000) },
    },
    orderBy: { publishedAt: "desc" },
    select: { publishedAt: true },
  });
  return Response.json({ latest: latest?.publishedAt?.toISOString() ?? null }, { headers });
}

/** CORS preflight, for browsers that send one (e.g. when extensions or proxies add headers). */
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "*",
      "access-control-max-age": "86400",
    },
  });
}
