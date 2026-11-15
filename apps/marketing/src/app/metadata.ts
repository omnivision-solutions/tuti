import type { Metadata } from "next";

/** The site's public address: the app's (APP_URL, the same domain in production; README, "Production routing"). */
export const SITE_URL = new URL(process.env.APP_URL || "https://tuti.so").origin;

export const HOME_TITLE = "Tuti: the open-source help center that stays in sync with your code";
export const HOME_DESCRIPTION =
  "Tuti is an open-source knowledge base with AI answers, an inbox, a feedback board, a roadmap and a changelog, kept in sync with the code you ship.";

/**
 * A page's title, description and canonical address, for search results and for share cards (Open Graph, X). The
 * layout's template adds " · Tuti" to the title, except on the home page. The share image is the page's opengraph-image.tsx.
 */
export function pageMetadata(path: string, title: string, description: string): Metadata {
  return {
    title: path === "/" ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: "Tuti", locale: "en_US", url: path, title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}
