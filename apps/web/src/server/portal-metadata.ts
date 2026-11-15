import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { cache } from "react";

import { branding } from "@/server/operations/branding";
import { portalAddress } from "@/server/custom-domains";

/**
 * A portal's branding and name (its search listing's title, Customize → SEO, else the project's), read once per request by
 * its layout, its pages' metadata and its share images.
 */
export const portalSite = cache(async (slug: string) => {
  const [brand, project] = await Promise.all([branding({ slug }), prisma.project.findUnique({ where: { slug }, select: { id: true, name: true } })]);
  return brand && project ? { brand, project, name: brand.seo.title || project.name } : null;
});

/** The share image a portal page's link card shows (1200×630): made for it at /og<its path> (the og route). */
export const SHARE_IMAGE = { width: 1200, height: 630 } as const;

/**
 * A public portal page's search listing and link card: its title (the layout adds the portal's name), description,
 * canonical address, Open Graph (an `article` with its dates for articles, posts and changelog entries) and share image,
 * all on the portal's real address (its custom domain, or the path of the team's site it's under). Twitter's card
 * comes from the layout and takes these. `noindex`: kept from search engines (still shareable).
 */
export async function portalPageMetadata(
  slug: string,
  page: {
    title: string;
    description?: string | null;
    /** The portal's own path, e.g. /docs/billing. */
    path: string;
    /** For articles, posts and changelog entries. */
    article?: { publishedTime?: Date | null; modifiedTime?: Date | null };
    noindex?: boolean;
  },
): Promise<Metadata> {
  const [address, site] = await Promise.all([portalAddress(slug), portalSite(slug)]);
  const url = `${address}${page.path === "/" ? "" : page.path}`;
  const description = page.description || undefined;
  const { publishedTime, modifiedTime } = page.article ?? {};
  return {
    title: page.title,
    ...(description && { description }),
    alternates: { canonical: url },
    openGraph: {
      title: page.title,
      ...(description && { description }),
      url,
      ...(site && { siteName: site.name }),
      images: [{ url: `${address}/og${page.path === "/" ? "" : page.path}`, ...SHARE_IMAGE, alt: page.title }],
      ...(page.article
        ? { type: "article", ...(publishedTime && { publishedTime: publishedTime.toISOString() }), ...(modifiedTime && { modifiedTime: modifiedTime.toISOString() }) }
        : { type: "website" }),
    },
    ...(page.noindex && { robots: { index: false } }),
  };
}

/** A page that's for the reader alone (signing in, their account, a link from an email): not for search engines. */
export const PRIVATE_PAGE = { robots: { index: false, follow: false } } satisfies Metadata;
