import type { ChangelogTag } from "@tuti/db";
import { RichText } from "@tuti/content/react";
import type { Doc } from "@tuti/content";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { postPath } from "@/lib/post-urls";

const TAG_LABELS: Record<ChangelogTag, string> = { NEW: "New", IMPROVED: "Improved", FIXED: "Fixed", BREAKING: "Breaking" };

export type PublishedEntry = {
  number: number;
  title: string;
  tags: ChangelogTag[];
  publishedAt: Date;
  doc: Doc;
  posts: { number: number; title: string }[];
};

/** A published changelog entry on the portal: date, tags, title (linking to its page), text and what it completes. */
export function ChangelogEntryView({ entry, mediaBaseUrl, heading = "h2" }: { entry: PublishedEntry; mediaBaseUrl: string | null; heading?: "h1" | "h2" }) {
  const Title = heading;
  return (
    <article className="flex flex-col gap-3" aria-labelledby={`entry-${entry.number}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <time dateTime={entry.publishedAt.toISOString()}>{formatDate(entry.publishedAt)}</time>
        {entry.tags.map((tag) => (
          <Badge key={tag} variant={tag === "BREAKING" ? "destructive" : "secondary"}>
            {TAG_LABELS[tag]}
          </Badge>
        ))}
      </div>
      <Title id={`entry-${entry.number}`} className="font-heading text-xl font-bold tracking-tight break-words">
        {heading === "h2" ? (
          <Link href={`/changelog/${entry.number}`} className="hover:underline">
            {entry.title}
          </Link>
        ) : (
          entry.title
        )}
      </Title>
      <RichText doc={entry.doc} mediaBaseUrl={mediaBaseUrl} className="rich-text break-words" />
      {entry.posts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Completes{" "}
          {entry.posts.map((post, i) => (
            <span key={post.number}>
              {i > 0 && ", "}
              <Link href={postPath(post)} className="text-foreground hover:underline">
                {post.title}
              </Link>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}
