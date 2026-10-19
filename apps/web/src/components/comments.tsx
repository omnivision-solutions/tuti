import { RichText } from "@tuti/content/react";

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

/** A post's comments. Comments by the project's team get a "Team" badge. */
export function CommentList({ comments, teamUserIds }: { comments: CommentView[]; teamUserIds: Set<string> }) {
  if (comments.length === 0) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-4">
      {comments.map((comment) => (
        <li key={comment.id} className="flex gap-3">
          <Avatar className="size-8">
            {comment.author.image && <AvatarImage src={comment.author.image} alt="" />}
            <AvatarFallback>{comment.author.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{comment.author.name}</span>
              {teamUserIds.has(comment.author.id) && <Badge variant="secondary">Team</Badge>}
              <time dateTime={comment.createdAt.toISOString()} className="text-xs text-muted-foreground">
                {timeAgo(comment.createdAt)}
              </time>
            </div>
            <RichText doc={displayDoc(comment)} className="rich-text text-sm break-words" />
          </div>
        </li>
      ))}
    </ol>
  );
}
