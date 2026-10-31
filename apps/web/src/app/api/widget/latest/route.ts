import { prisma } from "@tuti/db";
import { liveDomain, projectWith } from "@tuti/jobs";

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
  // Kept apart by the site asking: a browser's copy for the portal isn't reused for the team's site (Get set up counts that one).
  const headers = { "access-control-allow-origin": "*", "cache-control": "public, max-age=60", vary: "Origin" };
  if (!SLUG_PATTERN.test(slug)) {
    return Response.json({ error: "Unknown project" }, { status: 404, headers });
  }
  const [latest, settings, project] = await Promise.all([
    latestAnnouncedAt({ slug, portalAccess: "PUBLIC" }),
    widgetSettings({ slug }),
    prisma.project.findUnique({ where: { slug }, select: { supportInbox: true, plan: true, widgetSeenAt: true } }),
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
  // On a site of the team's (not the app or the portal, at Tuti's address or its own domain): the widget
  // is set up (Home's "Get set up"). Once: the domain is only looked up until then. A portal under a
  // path of the team's site (acme.com/portal) shares that site's origin, which counts.
  const from = siteOrigin(request.headers.get("origin") ?? request.headers.get("referer"));
  if (project && !project.widgetSeenAt && from && from !== appUrl().origin && from !== new URL(portalUrl(slug)).origin && !(await isOwnDomain(slug, from))) {
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

/**
 * Whether `origin` is the project's live custom domain, read from the database now (not the cached
 * address links use, which a mount on the team's site takes first, and another process may still hold).
 */
async function isOwnDomain(slug: string, origin: string): Promise<boolean> {
  if (!process.env.CUSTOM_DOMAIN_TARGET?.trim()) {
    return false;
  }
  const domain = await prisma.customDomain.findFirst({
    where: { hostname: new URL(origin).hostname, project: { slug, ...projectWith("customDomain") }, ...liveDomain },
    select: { hostname: true },
  });
  return domain !== null;
}

/** A request's site (its Origin, or its Referer's origin); null if there isn't one. */
function siteOrigin(header: string | null): string | null {
  try {
    const origin = header ? new URL(header).origin : null;
    // An opaque origin (a browser extension's, a sandboxed frame's) is "null": no site.
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}
