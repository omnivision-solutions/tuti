import type { MetadataRoute } from "next";

import { SITE_URL } from "./metadata";

// Its address is the server's APP_URL, so asked when it's fetched, not built.
export const dynamic = "force-dynamic";

/** tuti.so/robots.txt: the whole domain, the app's paths too (/help is Tuti's own help center); not its API. The help center's
 * own sitemap is named here too: crawlers never read /help/robots.txt, which points to it. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: "/api/" }, sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/help/sitemap.xml`] };
}
