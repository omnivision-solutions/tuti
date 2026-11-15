import type { MetadataRoute } from "next";

import { FEATURES } from "./features";
import { SITE_URL } from "./metadata";

export const dynamic = "force-dynamic";

/** This site's pages (Tuti's help center, at /help, is the app's). */
export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/pricing", ...FEATURES.map(({ slug }) => `/features/${slug}`), "/privacy", "/terms"].map((path) => ({ url: `${SITE_URL}${path === "/" ? "" : path}` }));
}
