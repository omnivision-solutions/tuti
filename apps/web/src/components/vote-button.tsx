"use client";

import { CheckIcon, ChevronUpIcon } from "lucide-react";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { useSignInHref } from "@/components/sign-in-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toggleVote } from "@/server/posts";

const SHAPE = "h-auto w-12 flex-col gap-0 py-1.5";
/** The portal's: chevron and count side by side, a pill as wide as its count. */
const PILL = "h-10 w-[4.5rem] shrink-0 gap-1.5 rounded-full px-3 text-[0.9375rem] tabular-nums";

export function VoteButton({
  postId,
  count,
  voted,
  disabled,
  vote,
  signInHref,
  signedOut,
  pill = false,
}: {
  postId: string;
  count: number;
  voted: boolean;
  disabled: boolean;
  /** Votes (true) or takes it back instead of toggleVote (the widget's, which updates `count` and `voted` itself). */
  vote?: (voted: boolean) => Promise<{ error?: string }>;
  /** Signed out, a link to sign in (in a new tab: the widget's) instead of a disabled button. */
  signInHref?: string;
  /** On a portal, signed out: a link to its sign-in page that comes back here (signed in but unable to vote, `disabled`). */
  signedOut?: boolean;
  /** Chevron and count side by side (the portal's). */
  pill?: boolean;
}) {
  const shape = pill ? PILL : SHAPE;
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ count, voted });
  const votes = `${optimistic.count} ${optimistic.count === 1 ? "vote" : "votes"}`;

  if (signedOut) {
    return <PortalSignInToVote count={optimistic.count} votes={votes} shape={shape} />;
  }
  if (signInHref) {
    return (
      <a href={signInHref} target="_blank" rel="noreferrer" aria-label={`Sign in to vote (${votes})`} className={cn(buttonVariants({ variant: "outline" }), shape)}>
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
      className={shape}
    >
      <ChevronUpIcon />
      <span className="font-semibold tabular-nums">{optimistic.count}</span>
    </Button>
  );
}

function PortalSignInToVote({ count, votes, shape }: { count: number; votes: string; shape: string }) {
  return (
    <Link href={useSignInHref()} aria-label={`Sign in to vote (${votes})`} className={cn(buttonVariants({ variant: "outline" }), shape)}>
      <ChevronUpIcon />
      <span className="font-semibold tabular-nums">{count}</span>
    </Link>
  );
}

/** A completed idea's votes, as text: it's shipped, so there's nothing left to vote for. */
export function VoteCount({ count, pill = false }: { count: number; pill?: boolean }) {
  if (pill) {
    return (
      // At least as wide as the vote pill: a check for done, then the count.
      <p className="inline-flex h-10 min-w-[4.5rem] shrink-0 items-center justify-center gap-1 rounded-full bg-status-completed/12 px-3 text-sm text-muted-foreground tabular-nums">
        <CheckIcon aria-hidden className="size-4 text-status-completed" />
        <span className="font-semibold text-foreground">{count}</span>
        <span>{count === 1 ? "vote" : "votes"}</span>
      </p>
    );
  }
  return (
    <p className="flex w-12 shrink-0 flex-col items-center text-muted-foreground">
      <span className="font-semibold text-foreground tabular-nums">{count}</span>
      <span className="text-xs">{count === 1 ? "vote" : "votes"}</span>
    </p>
  );
}
