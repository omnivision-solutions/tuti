import { RichText } from "@tuti/content/react";
import type { PostStatus } from "@tuti/db";
import type { MediaUrls } from "@tuti/content/media";

import { type CommentAbility, CommentActions, ReplyBox, ReplyThread } from "@/components/comment-actions";
import { PortalAvatar } from "@/components/portal-avatar";
import { PostStatusBadge, StatusDot, StatusIcon, StatusPill } from "@/components/post-status-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";
import { type CommentSort, threads } from "@/lib/comment-threads";
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
  /** The top-level comment it replies to (replies are one level deep). */
  parentId?: string | null;
  /** How many like it, and whether the reader does. */
  likes?: number;
  liked?: boolean;
};

/** A change of the post's status, in its activity; who made it and how many were emailed only in the team's view. */
export type StatusChangeView = { id: string; from: PostStatus; to: PostStatus; by?: string | null; emailed?: number; createdAt: Date };

/**
 * A post's activity: its comments, and with `events`, its status changes between them, in `sort`'s order; each comment's
 * replies under it, indented, oldest first. Comments by the project's team stand out: tinted, with a "Team" badge.
 * `mediaUrls`: their images' links (server/media-urls.ts), read by the page. `ability`: Reply and Like under each comment
 * (never a note: only the team sees those).
 */
export function CommentList({
  comments,
  teamUserIds,
  events = [],
  mediaUrls,
  portal = false,
  sort = "oldest",
  ability,
}: {
  comments: CommentView[];
  teamUserIds: Set<string>;
  events?: StatusChangeView[];
  mediaUrls?: MediaUrls | null;
  /** The portal's look: bigger text, neutral faces (the team's green), a status change as its pill with its icon. */
  portal?: boolean;
  sort?: CommentSort;
  ability?: CommentAbility;
}) {
  const byTeam = (comment: CommentView) => teamUserIds.has(comment.author.id) && !comment.asReader;
  if (comments.length === 0 && events.length === 0) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>;
  }
  const items = threads<{ id: string; createdAt: Date; parentId?: string | null; comment?: CommentView; event?: StatusChangeView }>(
    [...comments.map((comment) => ({ id: comment.id, createdAt: comment.createdAt, parentId: comment.parentId, comment })), ...events.map((event) => ({ id: event.id, createdAt: event.createdAt, event }))],
    sort,
  );

  const row = (comment: CommentView) => (
    <div
      className={cn(
        // Every one inset by a line's room, so the team's and a note's line down the left (and light tint) keep the
        // avatars in one column: the team's green, a note the highlight's.
        // The portal's: the faces on the page's edge; the team's on their tint, inset by its rule.
        portal ? "flex gap-3.5 py-2" : "flex gap-3 border-l-[3px] border-transparent pl-3",
        comment.internal
          ? "rounded-r-lg border-highlight-foreground/60 bg-highlight/35 py-2.5 pr-3"
          : byTeam(comment) &&
              (portal
                ? "rounded-r-xl border-l-[3px] border-primary bg-linear-to-r from-soft to-soft/30 py-3.5 pr-4 pl-3"
                : "rounded-r-lg border-primary/70 bg-primary/8 py-2.5 pr-3"),
      )}
    >
      {portal ? (
        <PortalAvatar person={comment.author} team={byTeam(comment)} className="size-[2.125rem] text-[0.8125rem]" />
      ) : (
        <Avatar className="size-8">
          {comment.author.image && <AvatarImage src={comment.author.image} alt="" />}
          <AvatarFallback>{comment.author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={portal ? "font-semibold" : "font-medium"}>{comment.author.name}</span>
          {/* A note is always the team's: its own badge says enough. */}
          {byTeam(comment) && !comment.internal && <Badge>Team</Badge>}
          {comment.internal && <Badge variant="highlight">Internal note</Badge>}
          <time dateTime={comment.createdAt.toISOString()} className={cn("text-muted-foreground", portal ? "text-sm" : "text-xs")}>
            {timeAgo(comment.createdAt)}
          </time>
        </div>
        <RichText doc={displayDoc(comment)} mediaUrls={mediaUrls} className={cn("rich-text break-words", portal ? "text-[0.96875rem] leading-relaxed" : "text-sm")} />
        {ability && !comment.internal && <CommentActions ability={ability} commentId={comment.id} author={comment.author.name} likes={comment.likes ?? 0} liked={comment.liked ?? false} />}
      </div>
    </div>
  );

  return (
    <ol className={cn("flex flex-col", portal ? "gap-4" : "gap-5")}>
      {items.map(({ item, replies }) =>
        item.event ? (
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
          <li key={item.id} className="flex flex-col gap-2">
            <ReplyThread>
              {row(item.comment!)}
              {/* Under the comment, indented to its words. */}
              {(replies.length > 0 || ability) && (
                <div className={cn("flex flex-col gap-2 empty:hidden", portal ? "pl-12" : "pl-14")}>
                  {replies.length > 0 && (
                    <ol aria-label={`Replies to ${item.comment!.author.name}`} className="flex flex-col gap-2">
                      {replies.map((reply) => (
                        <li key={reply.id}>{row(reply.comment!)}</li>
                      ))}
                    </ol>
                  )}
                  {ability && !item.comment!.internal && <ReplyBox ability={ability} replyTo={item.id} author={item.comment!.author.name} />}
                </div>
              )}
            </ReplyThread>
          </li>
        ),
      )}
    </ol>
  );
}
