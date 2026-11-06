import { portalTemplate } from "@/lib/hosts";
import { WIDGET_BASE_PARAM, widgetLoader } from "@/lib/widget-loader";

/** The widget's script tag loads this from the app host (see lib/widget-loader.ts); the portal's own under a path, briefly cached (WIDGET_BASE_PARAM). */
export function GET(request: Request) {
  const marked = new URL(request.url).searchParams.has(WIDGET_BASE_PARAM);
  return new Response(widgetLoader(portalTemplate()), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": `public, max-age=${marked ? 60 : 3600}`,
    },
  });
}
