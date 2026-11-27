import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { cache, createElement } from "react";

import { branding } from "@/server/operations/branding";
import { portalAddress } from "@/server/custom-domains";
import { portalHomePath } from "@/server/portal-home";
import { languagePrefix } from "@/lib/language-addresses";
import { pageLanguages } from "@/server/language-addresses";
import { portalLanguage } from "@/server/portal-base";

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
/**
 * Whether the share card's fonts can draw `text` (Latin, Cyrillic, Greek and math; see share-card.tsx): not Han, kana or Hangul.
 * ponytail: just the launch languages' scripts the fonts lack; bundling CJK fonts for the card is the upgrade.
 */
const drawable = (text: string) => !/[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u.test(text);

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
    /** An article's, changelog entry's or post's page: its Markdown copy, at <path>.md, listed for AI tools. */
    markdown?: boolean;
    /** The page's own link card (a changelog entry's featured image), in place of the one made for it. */
    image?: { url: string; width: number; height: number } | null;
    /**
     * Where it reads in each language it's in, by language (an article's: the default language's address, and each it's
     * translated into, at its own slug there; see articleAddresses): its canonical and `hreflang` follow them.
     */
    addresses?: Record<string, string>;
  },
): Promise<Metadata> {
  const [address, site, home, languages, { language, prefix }] = await Promise.all([
    portalAddress(slug),
    portalSite(slug),
    portalHomePath(slug),
    pageLanguages(slug),
    portalLanguage(),
  ]);
  const at = (prefix: string, path = page.path) => `${address}${prefix}${path === "/" ? "" : path}`;
  // The languages the page is in (docs/plan.md, Languages): the portal's own pages in each live one; an article's, post's or
  // changelog entry's (the team's or people's words) only in the default language until it has translations (articles from
  // L8, entries from L17; posts never), so its other addresses point search engines to the default's. Under a language that
  // isn't live (the team's preview) none: kept from search engines.
  const preview = !!prefix && !!language && !languages?.live.includes(language);
  // An article with `addresses`: the live languages it's translated into, each at its own path there.
  const pathIn = (code: string) => page.addresses?.[code] ?? page.path;
  const inLanguages = !languages ? [] : page.addresses ? languages.live.filter((code) => code in page.addresses!) : page.markdown || page.article ? [] : languages.live;
  const defaultPath = languages ? pathIn(languages.default) : page.path;
  const current = inLanguages.find((code) => languagePrefix(code) === prefix);
  const url = current ? at(prefix, pathIn(current)) : at("", defaultPath);
  const hreflang =
    inLanguages.length > 0 && languages && !preview
      ? {
          languages: {
            [languages.default]: at("", defaultPath),
            ...Object.fromEntries(inLanguages.map((code) => [code, at(languagePrefix(code), pathIn(code))])),
            "x-default": at("", defaultPath),
          },
        }
      : {};
  // The page the portal opens on is the portal in search results: its own description (Customize → SEO) there, if the team wrote one.
  const description = (page.path === home && site?.brand.seo.description) || page.description || undefined;
  const { publishedTime, modifiedTime } = page.article ?? {};
  return {
    title: page.title,
    ...(description && { description }),
    alternates: { canonical: url, ...hreflang, ...(page.markdown && { types: { "text/markdown": `${url}.md` } }) },
    openGraph: {
      title: page.title,
      ...(description && { description }),
      url,
      ...(site && { siteName: site.name }),
      // The page's own image; the team's share image (Customize → SEO) on the page the portal opens on, as at the
      // portal's address; a card made for every other page. (Twitter's card reads these too: the layout's twitter has no image.)
      images: [
        page.image
          ? { url: page.image.url, width: page.image.width, height: page.image.height, alt: page.title }
          : site?.brand.seoImage && page.path === home
            ? { url: site.brand.seoImage.url, width: site.brand.seoImage.width, height: site.brand.seoImage.height }
            : // A translated page's card is made at its address there, in its language (its title translated).
              // Not when its title is in a script the card's fonts can't draw (Japanese, Korean, Chinese: share-card.tsx), which
              // would show as boxes: the default language's card then.
              { url: current && page.addresses && drawable(page.title) ? `${address}${prefix}/og${pathIn(current)}` : `${address}/og${page.path === "/" ? "" : page.path}`, ...SHARE_IMAGE, alt: page.title },
      ],
      ...(page.article
        ? { type: "article", ...(publishedTime && { publishedTime: publishedTime.toISOString() }), ...(modifiedTime && { modifiedTime: modifiedTime.toISOString() }) }
        : { type: "website" }),
    },
    ...(page.noindex && { robots: { index: false } }),
    ...(preview && { robots: { index: false, follow: false } }),
  };
}

/** A page that's for the reader alone (signing in, their account, a link from an email): not for search engines. */
export const PRIVATE_PAGE = { robots: { index: false, follow: false } } satisfies Metadata;

/**
 * An article's or changelog entry's schema.org data for search and answer engines (rich results): a `<script
 * type="application/ld+json">` with its headline, description, canonical address (`path` on the portal's real
 * address, as portalPageMetadata), dates and the portal as publisher, and a `BreadcrumbList` of `breadcrumb` (portal
 * paths, the page last; with steps before it). None on a private portal: callers leave out pages that aren't for search engines or signed-out readers.
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
  // A trail with steps before the page (one with the page alone says nothing).
  if (page.breadcrumb && page.breadcrumb.length > 1) {
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
