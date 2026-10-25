import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { RestoreVersionButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { ArticleDiff } from "@/components/article-diff";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { ARTICLE_REVISIONS_KEPT, articleRevisions } from "@/server/operations/docs";

export const metadata = { title: "Article history" };

/** An article's saved versions; opening one shows what changed since, and can restore it. */
export default async function ArticleHistoryPage(props: PageProps<"/app/[project]/docs/[slug]/history">) {
  const [{ project: slug, slug: articleSlug }, { revision: selectedId }] = await Promise.all([props.params, props.searchParams]);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const article = await prisma.article.findFirst({
    where: { projectId: membership.project.id, slug: articleSlug, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      body: true,
      content: true,
      publishedAt: true,
      collection: { select: { name: true } },
      changes: { select: { title: true, body: true, content: true, collection: { select: { name: true } } } },
    },
  });
  if (!article) {
    notFound();
  }
  // The current version is the one saved last: a published article's unpublished changes, if it has some.
  const current = article.changes ?? article;
  const revisions = await articleRevisions(article.id);
  const selected = revisions.find((revision) => revision.id === selectedId);
  const href = `/app/${slug}/docs/${article.slug}`;

  return (
    <>
      <BackLink href={href}>{article.title}</BackLink>
      <PageHeader
        title="History"
        description={`Every save that changed “${article.title}”, newest first. The latest ${ARTICLE_REVISIONS_KEPT} are kept.`}
      />
      {selected && (
        <Card role="region" aria-labelledby="version-title">
          <CardHeader>
            <CardTitle id="version-title">Changes since this version</CardTitle>
            <CardDescription>
              Saved {timeAgo(selected.createdAt)} by {selected.author?.name ?? "someone whose account is gone"}.{" "}
              {selected === revisions[0] ? "This is the current version." : "Paragraphs taken out since are struck through; added ones are highlighted."}
            </CardDescription>
            {selected !== revisions[0] && (
              <CardAction>
                <RestoreVersionButton projectSlug={slug} slug={article.slug} revision={selected.id} published={article.publishedAt !== null} />
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            <ArticleDiff before={selected} after={current} same="No changes: it's the same as the current version." />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          <ItemList>
            {revisions.map((revision, index) => (
              <ItemRow
                key={revision.id}
                title={
                  <Link
                    href={`?revision=${revision.id}`}
                    aria-current={revision === selected ? "true" : undefined}
                    className="hover:underline aria-[current]:underline"
                  >
                    <time dateTime={revision.createdAt.toISOString()} title={revision.createdAt.toISOString()}>
                      Saved {timeAgo(revision.createdAt)}
                    </time>
                  </Link>
                }
                badges={index === 0 && <Badge variant="secondary">Current</Badge>}
                meta={[revision.author?.name ?? "Someone whose account is gone", revision.title, revision.collection?.name].filter(Boolean).join(" · ")}
              />
            ))}
          </ItemList>
        </CardContent>
      </Card>
    </>
  );
}
