"use client";

import { ChevronUpIcon } from "lucide-react";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toggleVote } from "@/server/posts";

const SHAPE = "h-auto w-12 flex-col gap-0 py-1.5";

export function VoteButton({
  postId,
  count,
  voted,
  disabled,
  vote,
  signInHref,
}: {
  postId: string;
  count: number;
  voted: boolean;
  disabled: boolean;
  /** Votes (true) or takes it back instead of toggleVote (the widget's, which updates `count` and `voted` itself). */
  vote?: (voted: boolean) => Promise<{ error?: string }>;
  /** Signed out, a link to sign in (in a new tab: the widget's) instead of a disabled button. */
  signInHref?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ count, voted });
  const votes = `${optimistic.count} ${optimistic.count === 1 ? "vote" : "votes"}`;

  if (signInHref) {
    return (
      <a href={signInHref} target="_blank" rel="noreferrer" aria-label={`Sign in to vote (${votes})`} className={cn(buttonVariants({ variant: "outline" }), SHAPE)}>
        <ChevronUpIcon />
        <span className="font-semibold tabular-nums">{optimistic.count}</span>
      </a>
    );
  }
  return (
    <Button
      variant={optimistic.voted ? "default" : "outline"}
      disabled={disabled || pending}
      title={disabled ? "Sign in to vote" : undefined}
      aria-pressed={optimistic.voted}
      // The count too: the label replaces the button's text for screen readers.
      aria-label={`${optimistic.voted ? "Remove vote" : "Upvote"} (${votes})`}
      onClick={() =>
        startTransition(async () => {
          const next = !optimistic.voted;
          setOptimistic((s) => ({ voted: next, count: s.count + (next ? 1 : -1) }));
          const result = await (vote ? vote(next) : toggleVote(postId));
          if (result.error) {
            toast.error(result.error);
          }
        })
      }
      className={SHAPE}
    >
      <ChevronUpIcon />
      <span className="font-semibold tabular-nums">{optimistic.count}</span>
    </Button>
  );
}
