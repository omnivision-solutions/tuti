import { RichText } from "@tuti/content/react";
import type { PostStatus } from "@tuti/db";
import type { MediaUrls } from "@tuti/content/media";

import { PortalAvatar } from "@/components/portal-avatar";
import { PostStatusBadge, StatusDot, StatusIcon, StatusPill } from "@/components/post-status-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { displayDoc } from "@/server/content";

export type CommentView = {
  id: string;
  body: string;
  content: unknown;
  createdAt: Date;
  author: { id: string; name: string; image: string | null };
  /** An internal note: only the team sees it (the team's view only ever has these). */
  internal?: boolean;
  /** Written with a portal's session (server/session.ts, signedInAsReader): not the team's, even if its author is on it. */
  asReader?: boolean;
};

/** A change of the post's status, in its activity; who made it and how many were emailed only in the team's view. */
export type StatusChangeView = { id: string; from: PostStatus; to: PostStatus; by?: string | null; emailed?: number; createdAt: Date };

/**
 * A post's activity: its comments, and with `events`, its status changes between them. Comments by
 * the project's team stand out: tinted, with a "Team" badge. `mediaUrls`: their images' links (server/media-urls.ts), read by the page.
 */
export function CommentList({
  comments,
  teamUserIds,
  events = [],
  mediaUrls,
  portal = false,
}: {
  comments: CommentView[];
  teamUserIds: Set<string>;
  events?: StatusChangeView[];
  mediaUrls?: MediaUrls | null;
  /** The portal's look: bigger text, neutral faces (the team's green), a status change as its pill with its icon. */
  portal?: boolean;
}) {
  const byTeam = (comment: CommentView) => teamUserIds.has(comment.author.id) && !comment.asReader;
  if (comments.length === 0 && events.length === 0) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>;
  }
  const items = [...comments.map((comment) => ({ at: comment.createdAt, comment })), ...events.map((event) => ({ at: event.createdAt, event }))].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );

  return (
    <ol className={cn("flex flex-col", portal ? "gap-4" : "gap-5")}>
      {items.map((item) =>
        "event" in item ? (
          // On the avatars' line: the dot centred under them, the words where a comment's start.
          <li
            key={item.event.id}
            className={cn("flex items-center gap-3 text-muted-foreground", portal ? "gap-3.5 py-1 text-sm" : "border-l-[3px] border-transparent pl-3 text-xs")}
          >
            <span className={cn("flex shrink-0 justify-center", portal ? "w-[2.125rem]" : "w-8")}>
              {portal ? <StatusIcon status={item.event.to} /> : <StatusDot status={item.event.to} />}
            </span>
            <span>
              {/* A sentence: who moved it where (its status's pill), how many were emailed, when. */}
              <span className={cn("text-foreground", portal && "font-semibold")}>{item.event.by ?? "Moved"}</span>
              {item.event.by ? " moved it to " : " to "}
              {portal ? <StatusPill status={item.event.to} /> : <PostStatusBadge status={item.event.to} />}
              {!!item.event.emailed && ` · ${item.event.emailed} ${item.event.emailed === 1 ? "person" : "people"} emailed`}
              {" · "}
              <time dateTime={item.event.createdAt.toISOString()}>{timeAgo(item.event.createdAt)}</time>
            </span>
          </li>
        ) : (
          <li
            key={item.comment.id}
            className={cn(
              // Every one inset by a line's room, so the team's and a note's line down the left (and light tint) keep the
              // avatars in one column: the team's green, a note the highlight's.
              // The portal's: the faces on the page's edge; the team's on their tint, inset by its rule.
              portal ? "flex gap-3.5 py-2" : "flex gap-3 border-l-[3px] border-transparent pl-3",
              item.comment.internal
                ? "rounded-r-lg border-highlight-foreground/60 bg-highlight/35 py-2.5 pr-3"
                : byTeam(item.comment) &&
                    (portal
                      ? "rounded-r-xl border-l-[3px] border-primary bg-linear-to-r from-soft to-soft/30 py-3.5 pr-4 pl-3"
                      : "rounded-r-lg border-primary/70 bg-primary/8 py-2.5 pr-3"),
            )}
          >
            {portal ? (
              <PortalAvatar person={item.comment.author} team={byTeam(item.comment)} className="size-[2.125rem] text-[0.8125rem]" />
            ) : (
              <Avatar className="size-8">
                {item.comment.author.image && <AvatarImage src={item.comment.author.image} alt="" />}
                <AvatarFallback>{item.comment.author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={portal ? "font-semibold" : "font-medium"}>{item.comment.author.name}</span>
                {/* A note is always the team's: its own badge says enough. */}
                {byTeam(item.comment) && !item.comment.internal && <Badge>Team</Badge>}
                {item.comment.internal && <Badge variant="highlight">Internal note</Badge>}
                <time dateTime={item.comment.createdAt.toISOString()} className={cn("text-muted-foreground", portal ? "text-sm" : "text-xs")}>
                  {timeAgo(item.comment.createdAt)}
                </time>
              </div>
              <RichText doc={displayDoc(item.comment)} mediaUrls={mediaUrls} className={cn("rich-text break-words", portal ? "text-[0.96875rem] leading-relaxed" : "text-sm")} />
            </div>
          </li>
        ),
      )}
    </ol>
  );
}
