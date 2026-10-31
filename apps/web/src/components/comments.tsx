import { RichText } from "@tuti/content/react";
import type { PostStatus } from "@tuti/db";

import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";
import { displayDoc } from "@/server/content";

export type CommentView = {
  id: string;
  body: string;
  content: unknown;
  createdAt: Date;
  author: { id: string; name: string; image: string | null };
};

/** A change of the post's status, in its activity. */
export type StatusChangeView = { id: string; from: PostStatus; to: PostStatus; by: string | null; emailed: number; createdAt: Date };

/**
 * A post's activity: its comments, and with `events`, its status changes between them (the team's
 * view). Comments by the project's team get a "Team" badge.
 */
export function CommentList({ comments, teamUserIds, events = [] }: { comments: CommentView[]; teamUserIds: Set<string>; events?: StatusChangeView[] }) {
  if (comments.length === 0 && events.length === 0) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>;
  }
  const items = [...comments.map((comment) => ({ at: comment.createdAt, comment })), ...events.map((event) => ({ at: event.createdAt, event }))].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );

  return (
    <ol className="flex flex-col gap-4">
      {items.map((item) =>
        "event" in item ? (
          <li key={item.event.id} className="flex items-center gap-2 pl-2 text-sm text-muted-foreground">
            <StatusDot status={item.event.to} />
            <span>
              <span className="text-foreground">
                {STATUS_LABELS[item.event.from]} → {STATUS_LABELS[item.event.to]}
              </span>
              {item.event.by ? `, by ${item.event.by}` : ""}
              {item.event.emailed > 0 && `, ${item.event.emailed} ${item.event.emailed === 1 ? "person" : "people"} emailed`}
              {" · "}
              <time dateTime={item.event.createdAt.toISOString()}>{timeAgo(item.event.createdAt)}</time>
            </span>
          </li>
        ) : (
          <li key={item.comment.id} className="flex gap-3">
            <Avatar className="size-8">
              {item.comment.author.image && <AvatarImage src={item.comment.author.image} alt="" />}
              <AvatarFallback>{item.comment.author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{item.comment.author.name}</span>
                {teamUserIds.has(item.comment.author.id) && <Badge variant="secondary">Team</Badge>}
                <time dateTime={item.comment.createdAt.toISOString()} className="text-xs text-muted-foreground">
                  {timeAgo(item.comment.createdAt)}
                </time>
              </div>
              <RichText doc={displayDoc(item.comment)} className="rich-text text-sm break-words" />
            </div>
          </li>
        ),
      )}
    </ol>
  );
}
