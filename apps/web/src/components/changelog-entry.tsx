import type { ChangelogTag } from "@tuti/db";
import { RichText } from "@tuti/content/react";
import { excerpt as excerptOf, type Doc, type MediaUrls } from "@tuti/content";
import { ArrowRightIcon, LightbulbIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { ChangelogReactions } from "@/components/changelog-reactions";
import { TagBadge } from "@/components/changelog-tag";
import { PortalPageHeader } from "@/components/portal-page-header";
import { SampleBadge } from "@/components/sample-badge";
import { formatDate } from "@/lib/format";
import { withBase } from "@/lib/portal-base";
import { postPath } from "@/lib/post-urls";
import type { Reaction, ReactionCounts } from "@/lib/reactions";
import { cn } from "@/lib/utils";

/** "7 Nov 2026": the timeline's margin (every month three letters, as "Sep", not "Sept"). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (date: Date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/** The list's excerpts: the newest entry's medium one (up to eight lines), the others' two or three; in characters. */
const EXCERPT = { medium: 600, short: 300 };

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
  back,
  excerpt,
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
  /** Its own page on the portal: the shared page header (this way back, the 36px title, its tags and date under it). */
  back?: ReactNode;
  /** The changelog's list: its text as an excerpt linking to its page, "medium" (with its cover; the newest) or "short". */
  excerpt?: "medium" | "short";
}) {
  const Title = heading;
  // The portal's own pages (its list, or an entry's page, which has the reactions): a reading size and bigger (still grey)
  // tags; the widget's panel (an h1 too) keeps the base.
  const onPage = dateMargin || !!react;
  const at = (path: string) => withBase(base, path);
  // In the list, short ("7 Nov 2026"), as in its margin.
  const date = <time dateTime={entry.publishedAt.toISOString()}>{dateMargin ? shortDate(entry.publishedAt) : formatDate(entry.publishedAt)}</time>;
  // Its tags (grey; Breaking red) and, on phones or its own page, its date: above the title, or under it on its page.
  const meta = (
    <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      {entry.tags.map((tag) => (
        <TagBadge key={tag} tag={tag} className={cn(onPage && "h-6 rounded-md px-2 text-[0.8125rem] font-semibold")} />
      ))}
      <span className={cn("font-medium", dateMargin && "lg:hidden")}>{date}</span>
      {entry.sample && <SampleBadge />}
    </span>
  );
  return (
    <article className="flex gap-6" aria-labelledby={`entry-${entry.number}`}>
      {/* On the list's timeline (wide screens): the date in a margin, a dot by it on the line down the list. */}
      {dateMargin && (
        <p className="relative hidden w-[6.875rem] shrink-0 pt-[2.375rem] pl-4 text-sm font-medium whitespace-nowrap text-muted-foreground tabular-nums lg:block">
          <time dateTime={entry.publishedAt.toISOString()}>{shortDate(entry.publishedAt)}</time>
          <span aria-hidden className="absolute top-[2.875rem] left-0 size-[0.5625rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-background shadow-[0_0_0_1.5px_var(--color-muted-foreground),0_0_0_5px_var(--color-background)]" />
        </p>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {back ? (
          <PortalPageHeader back={back} title={entry.title} titleId={`entry-${entry.number}`} description={meta} className="mb-4" />
        ) : (
          <>
            {meta}
            <Title
              id={`entry-${entry.number}`}
              className={cn(
                "font-heading font-semibold tracking-tight break-words",
                onPage ? "-mt-1 text-2xl leading-tight font-[650] tracking-[-0.022em] sm:text-[1.75rem]" : "text-xl",
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
          </>
        )}
        {entry.cover && excerpt !== "short" && (
          <RichText
            doc={entry.cover}
            mediaUrls={mediaUrls}
            className={cn("rich-text", onPage && "[&_img]:rounded-xl [&_img]:border-0 [&_img]:shadow-card [&_img]:ring-1 [&_img]:ring-card-edge")}
          />
        )}
        {excerpt ? (
          <Excerpt entry={entry} size={excerpt} href={at(`/changelog/${entry.number}`)} />
        ) : (
          <RichText doc={entry.doc} mediaUrls={mediaUrls} className={cn("rich-text break-words", onPage && "text-base leading-7 text-foreground/85")} />
        )}
        {onPage && entry.posts.length > 0 ? (
          // The ideas it shipped, with how many asked: a pill each. One idea: the entry's title says which (its title is read
          // out after the pill's words); more than one: each pill shows its idea's title.
          <ul className="flex flex-wrap gap-2">
            {entry.posts.map((post) => (
              <li key={post.number} className="min-w-0 max-w-full">
                <Link
                  href={at(postPath(post))}
                  target={linkTarget}
                  className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-secondary px-3 text-[0.8125rem] font-semibold text-secondary-foreground transition-colors hover:bg-secondary-hover [&>svg]:text-muted-foreground"
                >
                  <LightbulbIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">
                    {entry.posts.length > 1 ? post.title : "Built from an idea"} · {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
                    {entry.posts.length === 1 && <span className="sr-only">: {post.title}</span>}
                  </span>
                  <ArrowRightIcon aria-hidden className="size-3.5 shrink-0" />
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

/**
 * An entry's text in the list: plain (no images, embeds or code), cut at a word's end, the medium one fading out where
 * it's cut; the rest is on its page, which it links to (the title is the link for keyboards and screen readers).
 */
function Excerpt({ entry, size, href }: { entry: PublishedEntry; size: "medium" | "short"; href: string }) {
  const { text, cut } = excerptOf(entry.doc, EXCERPT[size]);
  if (!text) {
    return null;
  }
  return (
    <Link href={href} tabIndex={-1} className="block">
      <p
        className={cn(
          "text-base leading-7 break-words whitespace-pre-line text-foreground/85",
          size === "medium" ? "line-clamp-8" : "line-clamp-3",
          size === "medium" && cut && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
        )}
      >
        {text}
      </p>
    </Link>
  );
}
