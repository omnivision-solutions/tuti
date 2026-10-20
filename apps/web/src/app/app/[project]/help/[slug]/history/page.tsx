import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/back-link";
import { RestoreVersionButton } from "@/components/help";
import { ItemList, ItemRow } from "@/components/item-list";
import { DiffLines } from "@/components/line-diff";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { diffLines } from "@/lib/line-diff";
import { getMembership } from "@/server/membership";
import { ARTICLE_REVISIONS_KEPT, articleRevisions } from "@/server/operations/help";

export const metadata = { title: "Article history" };

/** An article's saved versions; opening one shows what changed since, and can restore it. */
export default async function ArticleHistoryPage(props: PageProps<"/app/[project]/help/[slug]/history">) {
  const [{ project: slug, slug: articleSlug }, { revision: selectedId }] = await Promise.all([props.params, props.searchParams]);
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const article = await prisma.article.findFirst({
    where: { projectId: membership.project.id, slug: articleSlug, deletedAt: null },
    select: { id: true, slug: true, title: true, body: true, publishedAt: true },
  });
  if (!article) {
    notFound();
  }
  const revisions = await articleRevisions(article.id);
  const selected = revisions.find((revision) => revision.id === selectedId);
  const href = `/app/${slug}/help/${article.slug}`;

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
            <Diff before={selected} after={article} />
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

/** The text's paragraphs, with those taken out since `before` struck through and those added marked. */
function Diff({ before, after }: { before: { title: string; body: string }; after: { title: string; body: string } }) {
  const lines = diffLines(before.body, after.body);
  const changed = before.title !== after.title || lines.some((line) => line.kind !== "same");
  if (!changed) {
    return <p className="text-sm text-muted-foreground">No changes: it&apos;s the same as the current version.</p>;
  }
  return (
    <div className="flex flex-col gap-1 text-sm break-words">
      {before.title !== after.title && (
        <p className="mb-2">
          Title: <del className="bg-destructive/10 text-destructive">{before.title}</del>{" "}
          <ins className="bg-soft text-soft-foreground no-underline">{after.title}</ins>
        </p>
      )}
      <DiffLines lines={lines} />
    </div>
  );
}
