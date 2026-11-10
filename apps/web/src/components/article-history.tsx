import { prisma } from "@tuti/db";
import { HistoryIcon } from "lucide-react";
import Link from "next/link";

import { ArticleDiff } from "@/components/article-diff";
import { RestoreVersionButton } from "@/components/docs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { formatDate, timeAgo } from "@/lib/format";
import { articleRevisions } from "@/server/operations/docs";

/** A person's initials, as the sidebar shows them ("OO"). */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Each version's author's photo, by version id (null: none, or their account is gone): people are shown with their
 * photo everywhere, and the API's revisions (`articleRevisions`) say only their name. */
export async function authorPhotos(revisionIds: string[]) {
  const rows = await prisma.articleRevision.findMany({
    where: { id: { in: revisionIds } },
    select: { id: true, author: { select: { image: true } } },
  });
  return new Map(rows.map((r) => [r.id, r.author?.image ?? null]));
}

type Version = {
  title: string;
  body: string;
  content: unknown;
  collection: { name: string } | null;
};

/**
 * An article's saved versions, newest first (in its page's History panel); `selectedId`'s (`?history&revision=…`)
 * shows what changed since, and can be restored. `current` is the version saved last.
 */
export async function ArticleHistory({
  projectSlug,
  article,
  current,
  selectedId,
  keep = "",
}: {
  projectSlug: string;
  /** More of the page's address its links keep (`&from=autopilot`). */
  keep?: string;
  article: { id: string; slug: string; publishedAt: Date | null };
  current: Version;
  selectedId: string | undefined;
}) {
  const revisions = await articleRevisions(article.id);
  const photos = await authorPhotos(revisions.map((r) => r.id));
  const selected = revisions.find((revision) => revision.id === selectedId) ?? (selectedId === undefined ? revisions[1] : undefined);
  return (
    <>
      {/* Each save: who, when, and what it was called then; the open one marked, the newest the current. */}
      <ol aria-label="Versions" className="flex flex-col gap-1">
        {revisions.map((revision, index) => (
          <li key={revision.id}>
            <Link
              href={`?history&revision=${revision.id}${keep}`}
              scroll={false}
              aria-current={revision === selected ? "true" : undefined}
              className="flex items-start gap-2.5 rounded-lg py-2.5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar aria-hidden className="size-8">
                {photos.get(revision.id) && <AvatarImage src={photos.get(revision.id)!} alt="" />}
                <AvatarFallback>{initials(revision.author?.name ?? "?")}</AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <time dateTime={revision.createdAt.toISOString()} title={formatDate(revision.createdAt)}>
                    Saved {timeAgo(revision.createdAt)}
                  </time>
                  {index === 0 && <Badge>Current</Badge>}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[revision.author?.name ?? "Someone whose account is gone", revision.title !== current.title && `Titled “${revision.title}”`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </Link>
            {revision === selected && (
              <section role="region" aria-labelledby="version-title" className="docs-version-diff">
                <h3 id="version-title" className="mb-2 text-xs font-medium text-muted-foreground">
                  Changes since this version
                </h3>
                {selected === revisions[0] && <p className="mb-2 text-xs text-muted-foreground">This is the current version.</p>}
                <ArticleDiff before={selected} after={current} around={0} same="No changes: it's the same as the current version." />
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Show full comparison</summary>
                  <div className="mt-3">
                    <ArticleDiff before={selected} after={current} same="No changes: it's the same as the current version." />
                  </div>
                </details>
                {selected !== revisions[0] && (
                  <div className="mt-3">
                    <RestoreVersionButton
                      projectSlug={projectSlug}
                      slug={article.slug}
                      revision={selected.id}
                      published={article.publishedAt !== null}
                    />
                  </div>
                )}
              </section>
            )}
          </li>
        ))}
      </ol>
      {revisions.length === 1 && (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <HistoryIcon aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No earlier versions yet</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            Each time you save a change, the version before it is kept here, to compare and restore.
          </p>
        </div>
      )}
    </>
  );
}
