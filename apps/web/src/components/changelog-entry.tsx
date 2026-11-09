import type { ChangelogTag } from "@tuti/db";
import { RichText } from "@tuti/content/react";
import type { Doc, MediaUrls } from "@tuti/content";
import Link from "next/link";

import { ChangelogReactions } from "@/components/changelog-reactions";
import { TagBadge } from "@/components/changelog-tag";
import { SampleBadge } from "@/components/sample-badge";
import { formatDate } from "@/lib/format";
import { withBase } from "@/lib/portal-base";
import { postPath } from "@/lib/post-urls";
import type { Reaction, ReactionCounts } from "@/lib/reactions";
import { cn } from "@/lib/utils";

/** "7 Nov 2026": the timeline's margin (every month three letters, as "Sep", not "Sept"). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (date: Date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/** Each tag tinted on the portal, so a list can be scanned for what's new (Breaking keeps its destructive look). */
const TAG_TINTS: Record<ChangelogTag, string | undefined> = {
  NEW: "border-transparent bg-primary/14 text-foreground",
  IMPROVED: "border-transparent bg-status-in-progress/16 text-foreground",
  FIXED: "border-transparent bg-status-under-review/20 text-foreground",
  BREAKING: undefined,
};

export type PublishedEntry = {
  id: string;
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
  /** Sample content (server/sample-content.ts): labelled Sample. */
  sample: boolean;
};

/** A published changelog entry on the portal: date, tags, title (linking to its page), text and what it completes. */
export function ChangelogEntryView({
  entry,
  mediaUrls,
  heading = "h2",
  linkTarget,
  react,
  base = "",
  dateMargin = false,
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
  /** On wide screens the date sits in a margin left of the entry (the changelog's list); on phones it stays above the title. */
  dateMargin?: boolean;
}) {
  const Title = heading;
  // The portal's own pages (its list, or an entry's page, which has the reactions): a reading size and tinted tags; the
  // widget's panel (an h1 too) keeps the base.
  const onPage = dateMargin || !!react;
  const at = (path: string) => withBase(base, path);
  const date = <time dateTime={entry.publishedAt.toISOString()}>{formatDate(entry.publishedAt)}</time>;
  return (
    <article className="flex gap-6" aria-labelledby={`entry-${entry.number}`}>
      {/* On the list's timeline (wide screens): the date in a margin, a dot by it on the line down the list. */}
      {dateMargin && (
        <p className="relative hidden w-28 shrink-0 pt-1 text-sm font-medium text-muted-foreground lg:block">
          <time dateTime={entry.publishedAt.toISOString()}>{shortDate(entry.publishedAt)}</time>
          {/* Its tags under it, so the title starts the entry. */}
          {entry.tags.length > 0 && (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {entry.tags.map((tag) => (
                <TagBadge key={tag} tag={tag} className={TAG_TINTS[tag]} />
              ))}
            </span>
          )}
          <span aria-hidden className="absolute top-3 -right-3 size-[0.6875rem] translate-x-1/2 rounded-full bg-primary ring-4 ring-background" />
        </p>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 text-sm text-muted-foreground",
            // In the margin, the date leaves the row: the row goes too when it has no tags.
            dateMargin && !entry.sample && "lg:hidden",
          )}
        >
          <span className={cn("font-medium", dateMargin && "lg:hidden")}>{date}</span>
          {entry.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} className={onPage ? TAG_TINTS[tag] : undefined} />
          ))}
          {entry.sample && <SampleBadge />}
        </div>
        <Title
          id={`entry-${entry.number}`}
          className={cn(
            "font-heading font-semibold tracking-tight break-words",
            !onPage ? "text-xl" : heading === "h1" ? "text-[2rem] leading-tight sm:text-[2.5rem]" : "text-2xl leading-tight sm:text-[1.75rem]",
          )}
        >
          {heading === "h2" ? (
            <Link href={at(`/changelog/${entry.number}`)} target={linkTarget} className="hover:underline">
              {entry.title}
            </Link>
          ) : (
            entry.title
          )}
        </Title>
        {entry.cover && <RichText doc={entry.cover} mediaUrls={mediaUrls} className="rich-text" />}
        <RichText doc={entry.doc} mediaUrls={mediaUrls} className={cn("rich-text break-words", onPage && "text-[1.0625rem] leading-7 text-foreground/85")} />
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
      </div>
    </article>
  );
}
