import { portalTemplate } from "@/lib/hosts";
import { widgetLoader } from "@/lib/widget-loader";

/** The widget's script tag loads this from the app host (see lib/widget-loader.ts). */
export function GET() {
  return new Response(widgetLoader(portalTemplate()), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
