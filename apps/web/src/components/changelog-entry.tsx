import type { ChangelogTag } from "@tuti/db";
import { RichText } from "@tuti/content/react";
import type { Doc, MediaUrls } from "@tuti/content";
import { ArrowRightIcon, LightbulbIcon } from "lucide-react";
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

/** Each tag tinted on the portal, so a list can be scanned for what's new: New green, Improved blue, Fixed the orange highlight (Breaking keeps its destructive look). */
const TAG_TINTS: Record<ChangelogTag, string | undefined> = {
  NEW: "border-primary/20 bg-soft text-soft-foreground",
  IMPROVED: "border-tag-improved/25 bg-tag-improved-bg text-tag-improved",
  FIXED: "border-highlight-foreground/25 bg-highlight text-highlight-foreground",
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
  posts: { number: number; title: string; voteCount: number; board: { slug: string } }[];
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
  // In the list, short ("7 Nov 2026"), as in its margin.
  const date = <time dateTime={entry.publishedAt.toISOString()}>{dateMargin ? shortDate(entry.publishedAt) : formatDate(entry.publishedAt)}</time>;
  return (
    <article className="flex gap-6" aria-labelledby={`entry-${entry.number}`}>
      {/* On the list's timeline (wide screens): the date in a margin, a dot by it on the line down the list. */}
      {dateMargin && (
        <p className="relative hidden w-[6.875rem] shrink-0 pt-[2.375rem] pl-4 text-sm font-medium text-muted-foreground tabular-nums lg:block">
          <time dateTime={entry.publishedAt.toISOString()}>{shortDate(entry.publishedAt)}</time>
          <span aria-hidden className="absolute top-[2.875rem] left-0 size-[0.4375rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-4 ring-background" />
        </p>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* Its tags (and on phones, or an entry's page, its date) above the title. */}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {entry.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} className={cn(onPage && TAG_TINTS[tag], onPage && "h-6 rounded-md px-2 text-[0.8125rem] font-semibold")} />
          ))}
          <span className={cn("font-medium", dateMargin && "lg:hidden")}>{date}</span>
          {entry.sample && <SampleBadge />}
        </div>
        <Title
          id={`entry-${entry.number}`}
          className={cn(
            "font-heading font-semibold tracking-tight break-words",
            !onPage ? "text-xl" : heading === "h1" ? "text-[2rem] leading-tight font-[650] tracking-[-0.022em] sm:text-[2.5rem]" : "-mt-1 text-2xl leading-tight font-[650] tracking-[-0.022em] sm:text-[1.75rem]",
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
        {entry.cover && (
          <RichText
            doc={entry.cover}
            mediaUrls={mediaUrls}
            className={cn("rich-text", onPage && "[&_img]:rounded-[0.875rem] [&_img]:border-0 [&_img]:shadow-card [&_img]:ring-1 [&_img]:ring-border")}
          />
        )}
        <RichText doc={entry.doc} mediaUrls={mediaUrls} className={cn("rich-text break-words", onPage && "text-base leading-7 text-foreground/85")} />
        {onPage && entry.posts.length > 0 ? (
          // The ideas it shipped, with how many asked: a pill each (its title in its name, the entry's title says the rest).
          <ul className="flex flex-wrap gap-2">
            {entry.posts.map((post) => (
              <li key={post.number}>
                <Link
                  href={at(postPath(post))}
                  target={linkTarget}
                  title={post.title}
                  aria-label={`Built from an idea: ${post.title}, ${post.voteCount} ${post.voteCount === 1 ? "vote" : "votes"}`}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full bg-soft px-3 text-[0.8125rem] font-semibold text-soft-foreground hover:underline"
                >
                  <LightbulbIcon aria-hidden className="size-3.5" />
                  Built from an idea · {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        ) : entry.posts.length > 0 && (
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
            quiet={dateMargin}
          />
        )}
      </div>
    </article>
  );
}
