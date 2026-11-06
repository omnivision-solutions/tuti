import type { Doc } from "@tuti/content";
import type { LinkRenderer } from "@tuti/content/react";

import { ArticleLink, type ArticlePreview } from "@/components/article-link";
import { articleDescription, docLinks, portalDocsLink } from "@/lib/article-links";
import { portalUrl } from "@/lib/hosts";
import { portalAddress } from "@/server/custom-domains";
import { movedArticle, publishedArticle } from "@/server/docs-queries";

/** How many of an article's links to other articles are looked up for a preview (a lookup each); the rest are plain links. */
const MAX_PREVIEWS = 20;

/**
 * How an article's links to the portal's own docs pages render (RichText's `link`), whichever of the portal's addresses they
 * name: in the same tab at `href` (null: the usual new-tab link), with a preview of an article this reader may open, where it
 * is now if its slug changed. Other links are the usual ones.
 */
export async function articleLinks(
  projectSlug: string,
  doc: Doc,
  href: (page: { slug: string; hash: string; article: boolean }) => string | null,
): Promise<LinkRenderer> {
  const addresses = [...new Set([portalUrl(projectSlug), await portalAddress(projectSlug)])];
  const pages = new Map(docLinks(doc).flatMap((link) => {
    const page = portalDocsLink(link, addresses);
    return page ? [[link, page] as const] : [];
  }));
  const slugs = [...new Set([...pages.values()].map((page) => page.slug))].slice(0, MAX_PREVIEWS);
  const articles = new Map(
    await Promise.all(
      slugs.map(async (asked) => {
        const slug = (await publishedArticle(projectSlug, asked)) ? asked : await movedArticle(projectSlug, asked);
        const article = slug ? await publishedArticle(projectSlug, slug) : null;
        const preview: ArticlePreview | null = article && { title: article.title, description: articleDescription(article), collection: article.collection?.name ?? null };
        return [asked, slug && preview ? { slug, preview } : null] as const;
      }),
    ),
  );
  return function articleLink(link, text) {
    const page = pages.get(link);
    if (!page) {
      return null;
    }
    const article = articles.get(page.slug);
    const to = href({ slug: article?.slug ?? page.slug, hash: page.hash, article: !!article });
    return to === null ? null : (
      <ArticleLink href={to} preview={article?.preview ?? null}>
        {text}
      </ArticleLink>
    );
  };
}
