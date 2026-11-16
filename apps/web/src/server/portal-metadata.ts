import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { cache, createElement } from "react";

import { branding } from "@/server/operations/branding";
import { portalAddress } from "@/server/custom-domains";
import { portalHomePath } from "@/server/portal-home";

/**
 * A portal's branding and name (its search listing's title, Customize → SEO, else the project's), read once per request by
 * its layout, its pages' metadata and its share images.
 */
export const portalSite = cache(async (slug: string) => {
  const [brand, project] = await Promise.all([branding({ slug }), prisma.project.findUnique({ where: { slug }, select: { id: true, name: true, portalAccess: true } })]);
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
  const [address, site, home] = await Promise.all([portalAddress(slug), portalSite(slug), portalHomePath(slug)]);
  const url = `${address}${page.path === "/" ? "" : page.path}`;
  // The page the portal opens on is the portal in search results: its own description (Customize → SEO) there, if the team wrote one.
  const description = (page.path === home && site?.brand.seo.description) || page.description || undefined;
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
      // The team's own share image (Customize → SEO) on that page too, as at the portal's address; a card made for every other page.
      images: [
        site?.brand.seoImage && page.path === home
          ? { url: site.brand.seoImage.url, width: site.brand.seoImage.width, height: site.brand.seoImage.height }
          : { url: `${address}/og${page.path === "/" ? "" : page.path}`, ...SHARE_IMAGE, alt: page.title },
      ],
      ...(page.article
        ? { type: "article", ...(publishedTime && { publishedTime: publishedTime.toISOString() }), ...(modifiedTime && { modifiedTime: modifiedTime.toISOString() }) }
        : { type: "website" }),
    },
    ...(page.noindex && { robots: { index: false } }),
  };
}

/** A page that's for the reader alone (signing in, their account, a link from an email): not for search engines. */
export const PRIVATE_PAGE = { robots: { index: false, follow: false } } satisfies Metadata;

/**
 * An article's or changelog entry's schema.org data for search and answer engines (rich results): a `<script
 * type="application/ld+json">` with its headline, description, canonical address (`path` on the portal's real
 * address, as portalPageMetadata), dates and the portal as publisher, and a `BreadcrumbList` of `breadcrumb` (portal
 * paths, the page last). None on a private portal: callers leave out pages that aren't for search engines or signed-out readers.
 */
export async function portalArticleJsonLd(
  slug: string,
  page: {
    type: "TechArticle" | "BlogPosting";
    title: string;
    description?: string | null;
    path: string;
    published?: Date | null;
    modified?: Date | null;
    breadcrumb?: { name: string; path: string }[];
  },
) {
  const [address, site] = await Promise.all([portalAddress(slug), portalSite(slug)]);
  if (!site || site.project.portalAccess !== "PUBLIC") {
    return null;
  }
  const url = `${address}${page.path}`;
  const data: object[] = [
    {
      "@context": "https://schema.org",
      "@type": page.type,
      headline: page.title,
      ...(page.description && { description: page.description }),
      url,
      mainEntityOfPage: url,
      ...(page.published && { datePublished: page.published.toISOString() }),
      ...((page.modified ?? page.published) && { dateModified: (page.modified ?? page.published)!.toISOString() }),
      publisher: { "@type": "Organization", name: site.name, url: address },
    },
  ];
  if (page.breadcrumb) {
    data.push({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: page.breadcrumb.map((crumb, i) => ({ "@type": "ListItem", position: i + 1, name: crumb.name, item: `${address}${crumb.path}` })),
    });
  }
  // `<` as \u003c (still the same JSON): no title can close the script tag.
  return createElement("script", {
    type: "application/ld+json",
    dangerouslySetInnerHTML: { __html: JSON.stringify(data.length === 1 ? data[0] : data).replace(/</g, "\\u003c") },
  });
}
