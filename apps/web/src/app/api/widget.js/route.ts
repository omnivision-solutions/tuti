import { appPortalMount } from "@/lib/app-portal";
import { portalTemplate } from "@/lib/hosts";
import { widgetLoader } from "@/lib/widget-loader";

/** The widget's script tag loads this from the app host (see lib/widget-loader.ts). */
export function GET() {
  const own = appPortalMount();
  return new Response(widgetLoader(portalTemplate(), own && { slug: own.slug, url: own.origin + own.path }), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
