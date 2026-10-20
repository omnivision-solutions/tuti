import { SLUG_PATTERN } from "@/lib/project-slugs";
import { latestAnnouncedAt } from "@/server/operations/changelog-seen";
import { textColorOn, widgetSettings } from "@/server/operations/widget";

/**
 * For the widget script on customers' sites, read once per page view: when the
 * project's latest announced changelog entry was published (within 30 days), so
 * the launcher can show it's new to this visitor, and how the launcher looks (its
 * label, colour and corner; the quick links are the panel's, which reads them itself).
 * Public and the same for everyone, so any site may read it, without cookies; what
 * a signed-in visitor has seen on other devices comes from /api/widget/seen.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  const headers = { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" };
  if (!SLUG_PATTERN.test(slug)) {
    return Response.json({ error: "Unknown project" }, { status: 404, headers });
  }
  const [latest, settings] = await Promise.all([latestAnnouncedAt({ slug }), widgetSettings({ slug })]);
  const launcher = settings && {
    label: settings.label,
    // Null: the loader's brand green, which has a dark-mode shade.
    color: settings.color,
    textColor: settings.color && textColorOn(settings.color),
    position: settings.position,
  };
  return Response.json({ latest: latest?.toISOString() ?? null, launcher }, { headers });
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
