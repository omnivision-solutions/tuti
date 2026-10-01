"use client";

import { ChevronUpIcon } from "lucide-react";
import { useOptimistic, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { toggleVote } from "@/server/posts";

export function VoteButton({
  postId,
  count,
  voted,
  disabled,
}: {
  postId: string;
  count: number;
  voted: boolean;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ count, voted });

  return (
    <Button
      variant={optimistic.voted ? "default" : "outline"}
      disabled={disabled || pending}
      title={disabled ? "Sign in to vote" : undefined}
      aria-pressed={optimistic.voted}
      aria-label={optimistic.voted ? "Remove vote" : "Upvote"}
      onClick={() =>
        startTransition(async () => {
          setOptimistic((s) => ({ voted: !s.voted, count: s.count + (s.voted ? -1 : 1) }));
          await toggleVote(postId);
        })
      }
      className="h-auto w-12 flex-col gap-0 py-1.5"
    >
      <ChevronUpIcon />
      <span className="font-semibold tabular-nums">{optimistic.count}</span>
    </Button>
  );
}
