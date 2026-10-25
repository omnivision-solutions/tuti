import Link from "next/link";

import { ArticleDiff } from "@/components/article-diff";
import { RestoreVersionButton } from "@/components/docs";
import { ItemList, ItemRow } from "@/components/item-list";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { articleRevisions } from "@/server/operations/docs";

type Version = { title: string; body: string; content: unknown; collection: { name: string } | null };

/**
 * An article's saved versions, newest first (in its page's History panel); `selectedId`'s (`?history&revision=…`)
 * shows what changed since, and can be restored. `current` is the version saved last.
 */
export async function ArticleHistory({
  projectSlug,
  article,
  current,
  selectedId,
}: {
  projectSlug: string;
  article: { id: string; slug: string; publishedAt: Date | null };
  current: Version;
  selectedId: string | undefined;
}) {
  const revisions = await articleRevisions(article.id);
  const selected = revisions.find((revision) => revision.id === selectedId);
  return (
    <>
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
                <RestoreVersionButton projectSlug={projectSlug} slug={article.slug} revision={selected.id} published={article.publishedAt !== null} />
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
                    href={`?history&revision=${revision.id}`}
                    scroll={false}
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
