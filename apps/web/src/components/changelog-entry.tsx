import type { ChangelogTag } from "@tuti/db";
import { RichText } from "@tuti/content/react";
import type { Doc, MediaUrls } from "@tuti/content";
import Link from "next/link";

import { ChangelogReactions } from "@/components/changelog-reactions";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import { withBase } from "@/lib/portal-base";
import { postPath } from "@/lib/post-urls";
import type { Reaction, ReactionCounts } from "@/lib/reactions";

export const TAG_LABELS: Record<ChangelogTag, string> = { NEW: "New", IMPROVED: "Improved", FIXED: "Fixed", BREAKING: "Breaking" };

export type PublishedEntry = {
  number: number;
  title: string;
  tags: ChangelogTag[];
  publishedAt: Date;
  doc: Doc;
  /** Its cover image, as a document of that one image (the entry's title its text), signed with `doc`; null for none. */
  cover: Doc | null;
  posts: { number: number; title: string; board: { slug: string } }[];
  reactions: ReactionCounts;
  /** The ones the signed-in reader left. */
  reacted: Reaction[];
};

/** A published changelog entry on the portal: date, tags, title (linking to its page), text and what it completes. */
export function ChangelogEntryView({
  entry,
  mediaUrls,
  heading = "h2",
  linkTarget,
  react,
  base = "",
}: {
  entry: PublishedEntry;
  mediaUrls: MediaUrls | null;
  heading?: "h1" | "h2";
  /** "_blank" in the widget: links open on the portal, not in the panel. */
  linkTarget?: "_blank";
  /** Shows the reaction buttons (on the portal's pages, not in the widget). */
  react?: { projectSlug: string; signedIn: boolean };
  /** The path the portal is under on the team's site (see lib/portal-base.ts). */
  base?: string;
}) {
  const Title = heading;
  const at = (path: string) => withBase(base, path);
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
          <Link href={at(`/changelog/${entry.number}`)} target={linkTarget} className="hover:underline">
            {entry.title}
          </Link>
        ) : (
          entry.title
        )}
      </Title>
      {entry.cover && <RichText doc={entry.cover} mediaUrls={mediaUrls} className="rich-text" />}
      <RichText doc={entry.doc} mediaUrls={mediaUrls} className="rich-text break-words" />
      {entry.posts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Completes{" "}
          {entry.posts.map((post, i) => (
            <span key={post.number}>
              {i > 0 && ", "}
              <Link href={at(postPath(post))} target={linkTarget} className="text-foreground hover:underline">
                {post.title}
              </Link>
            </span>
          ))}
        </p>
      )}
      {react && (
        <ChangelogReactions
          projectSlug={react.projectSlug}
          number={entry.number}
          counts={entry.reactions}
          reacted={entry.reacted}
          signedIn={react.signedIn}
        />
      )}
    </article>
  );
}
