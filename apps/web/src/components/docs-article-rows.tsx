import { prisma } from "@tuti/db";
import { FileTextIcon } from "lucide-react";
import Link from "next/link";
import { cache } from "react";

import { ItemRow } from "@/components/item-list";
import { Badge } from "@/components/ui/badge";
import { type Listing, LISTING_LABELS } from "@/lib/article-listing";
import { levelSelect } from "@/lib/reader-groups";
import { accessChoices } from "@/server/docs-queries";
import { INSIGHTS_DAYS } from "@/server/operations/docs-insights";
import { accessBadgeFor, articleStats } from "@/server/team-docs";

/** What the rows say beyond a title, fetched once per request however many lists a page has. */
const rowDetails = cache(async (projectId: string) => {
  const [details, stats, access] = await Promise.all([
    prisma.article.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, slug: true, publishedAt: true, listing: true, ...levelSelect, changes: { select: { articleId: true } } },
    }),
    articleStats(projectId),
    accessChoices(projectId),
  ]);
  return { detailsOf: new Map(details.map((d) => [d.slug, d])), stats, badge: accessBadgeFor(access) };
});

/**
 * Articles as the team's docs list them (in an ItemList): a status only when one isn't out as written
 * ("Draft", "Changes not published"), those first, otherwise in the order given (reading order); a
 * published row says its views in the last 30 days and how many found it helpful, and who can read it
 * when it isn't inherited.
 */
export async function DocsArticleRows({ projectSlug, projectId, articles }: { projectSlug: string; projectId: string; articles: { slug: string; title: string }[] }) {
  const { detailsOf, stats, badge } = await rowDetails(projectId);
  // What isn't out as written yet: a draft, or a published article with changes not published.
  const status = (articleSlug: string) => {
    const article = detailsOf.get(articleSlug);
    return !article ? null : !article.publishedAt ? "Draft" : article.changes ? "Changes not published" : null;
  };
  return articles
    .toSorted((a, b) => Number(status(b.slug) !== null) - Number(status(a.slug) !== null))
    .map(({ slug: articleSlug, title }) => {
      const article = detailsOf.get(articleSlug);
      const read = article && stats.get(article.id);
      return (
        <ItemRow
          key={articleSlug}
          leading={<FileTextIcon aria-hidden className="size-4 text-muted-foreground" />}
          title={
            <Link href={`/app/${projectSlug}/docs/${articleSlug}`} className="hover:underline">
              {title}
            </Link>
          }
          badges={
            article && (
              <>
                {status(articleSlug) && <Badge variant={article.publishedAt ? "highlight" : "outline"}>{status(articleSlug)}</Badge>}
                {badge(article) && <Badge variant="outline">{badge(article)}</Badge>}
              </>
            )
          }
          meta={
            article?.publishedAt
              ? [
                  `${(read?.views ?? 0).toLocaleString("en")} ${read?.views === 1 ? "view" : "views"} in ${INSIGHTS_DAYS} days`,
                  ...(read?.helpful ? [`${read.helpful.toLocaleString("en")} found it helpful`] : []),
                  ...(article.listing === "EVERYWHERE" ? [] : [LISTING_LABELS[article.listing.toLowerCase() as Listing]]),
                ].join(" · ")
              : undefined
          }
        />
      );
    });
}
