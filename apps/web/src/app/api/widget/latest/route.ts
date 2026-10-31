import { prisma } from "@tuti/db";

import { appUrl, portalUrl } from "@/lib/hosts";
import { SLUG_PATTERN } from "@/lib/project-slugs";
import { latestAnnouncedAt } from "@/server/operations/changelog-seen";
import { servedIcon, textColorOn, widgetSettings } from "@/server/operations/widget";

/**
 * For the widget script on customers' sites, read once per page view: when the
 * project's latest announced changelog entry was published (within 30 days), so
 * the launcher can show it's new to this visitor, and how the launcher looks (its
 * name, colour, corner and icon: the chat bubble unless the plan includes picking one;
 * the quick links are the panel's, which reads them itself).
 * Public and the same for everyone, so any site may read it, without cookies; what
 * a signed-in visitor has seen on other devices comes from /api/widget/seen. A private
 * portal says nothing about its changelog here (no latest), since anyone may ask.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const headers = { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" };
  if (!SLUG_PATTERN.test(slug)) {
    return Response.json({ error: "Unknown project" }, { status: 404, headers });
  }
  const [latest, settings, project] = await Promise.all([
    latestAnnouncedAt({ slug, portalAccess: "PUBLIC" }),
    widgetSettings({ slug }),
    prisma.project.findUnique({ where: { slug }, select: { supportInbox: true, plan: true } }),
  ]);
  const launcher = settings && {
    label: settings.label,
    // Null: the loader's brand green, which has a dark-mode shade.
    color: settings.color,
    textColor: settings.color && textColorOn(settings.color),
    position: settings.position,
    // Built-in icons by name; an image by its lasting link.
    ...(project && servedIcon(settings, project.plan)),
  };
  // On a site of the team's (not the app or a portal): the widget is set up (Home's "Get set up"). Once.
  const from = siteOrigin(request.headers.get("origin") ?? request.headers.get("referer"));
  if (project && from && from !== appUrl().origin && from !== new URL(portalUrl(slug)).origin) {
    await prisma.project.updateMany({ where: { slug, widgetSeenAt: null }, data: { widgetSeenAt: new Date() } });
  }
  // With the support inbox on, the script asks /api/widget/seen about the team's messages to whoever the page signs in.
  return Response.json({ latest: latest?.toISOString() ?? null, launcher, inbox: project?.supportInbox ?? false }, { headers });
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

/** A request's site (its Origin, or its Referer's origin); null if there isn't one. */
function siteOrigin(header: string | null): string | null {
  try {
    return header ? new URL(header).origin : null;
  } catch {
    return null;
  }
}
