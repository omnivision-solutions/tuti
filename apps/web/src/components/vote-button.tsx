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
/**
 * The portal's shapes: `box` (a board's row: the chevron over the count), `chip` (a roadmap card's footer: side by side,
 * small) and `upvote` (a post's rail: "Upvote", then the count, the whole width).
 */
const SHAPES = {
  box: "h-[3.625rem] w-[3.25rem] shrink-0 flex-col gap-0 rounded-xl text-[0.9375rem] font-bold tabular-nums [&_svg]:size-[1.125rem]",
  chip: "h-9 shrink-0 gap-1 rounded-lg px-2.5 text-[0.9375rem] font-bold tabular-nums",
  upvote: "h-12 gap-2.5 rounded-xl px-5 text-base font-semibold tabular-nums",
} as const;
export type VoteShape = keyof typeof SHAPES;
/**
 * A portal shape's look: a grey fill without an edge, or once voted, the accent's soft tint (the primary is the post's
 * Upvote, before voting).
 */
const portalLook = (shape: VoteShape, voted: boolean) =>
  voted
    ? "border-transparent bg-soft text-soft-foreground shadow-none hover:bg-soft"
    : shape === "upvote"
      ? ""
      : "border-transparent bg-secondary [&_svg]:text-muted-foreground";

/** The words and count inside a portal shape (`upvote` says what it does; the others are the chevron and count). */
function Contents({ shape, count, voted }: { shape?: VoteShape; count: number; voted: boolean }) {
  if (shape === "upvote") {
    return (
      <>
        {voted ? <CheckIcon /> : <ChevronUpIcon />}
        {voted ? "Upvoted" : "Upvote"}
        <span aria-hidden className="h-5 w-px bg-current opacity-30" />
        <span className="font-bold">{count}</span>
      </>
    );
  }
  return (
    <>
      <ChevronUpIcon />
      <span className="font-semibold tabular-nums">{count}</span>
    </>
  );
}

export function VoteButton({
  postId,
  count,
  voted,
  disabled,
  vote,
  signInHref,
  signedOut,
  shape,
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
  /** The portal's (see SHAPES); without one, the app's and the widget's. */
  shape?: VoteShape;
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ count, voted });
  const votes = `${optimistic.count} ${optimistic.count === 1 ? "vote" : "votes"}`;

  if (signedOut) {
    return <PortalSignInToVote count={optimistic.count} votes={votes} shape={shape} />;
  }
  if (signInHref) {
    return (
      <a href={signInHref} target="_blank" rel="noreferrer" aria-label={`Sign in to vote (${votes})`} className={cn(buttonVariants({ variant: "outline" }), SHAPE)}>
        <Contents count={optimistic.count} voted={false} />
      </a>
    );
  }
  return (
    <Button
      variant={shape ? (shape === "upvote" && !optimistic.voted ? "default" : "secondary") : optimistic.voted ? "default" : "outline"}
      disabled={disabled || pending}
      title={disabled ? "Sign in to vote" : undefined}
      aria-pressed={optimistic.voted}
      // The count too: the label replaces the button's text for screen readers.
      // Its words first (the post's says "Upvoted" once voted, for voice control), then the count; aria-pressed says it's on.
      aria-label={`${optimistic.voted ? (shape === "upvote" ? "Upvoted" : "Remove vote") : "Upvote"} (${votes})`}
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
      className={shape ? cn(SHAPES[shape], portalLook(shape, optimistic.voted)) : SHAPE}
    >
      <Contents shape={shape} count={optimistic.count} voted={optimistic.voted} />
    </Button>
  );
}

function PortalSignInToVote({ count, votes, shape }: { count: number; votes: string; shape?: VoteShape }) {
  return (
    <Link
      href={useSignInHref()}
      // The post's says "Upvote": its words first (voice control), then what it does.
      aria-label={shape === "upvote" ? `Upvote (${votes}), sign in to vote` : `Sign in to vote (${votes})`}
      className={cn(buttonVariants({ variant: shape === "upvote" ? "default" : shape ? "secondary" : "outline" }), shape ? cn(SHAPES[shape], portalLook(shape, false)) : SHAPE)}
    >
      <Contents shape={shape} count={count} voted={false} />
    </Link>
  );
}

/** A completed idea's votes, as text: it's shipped, so there's nothing left to vote for. */
export function VoteCount({ count, shape }: { count: number; shape?: VoteShape }) {
  if (shape) {
    return (
      // As big as the vote button it stands for: a check for done, then the count.
      <p
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-1 rounded-xl bg-status-completed/10 text-muted-foreground tabular-nums",
          shape === "box" ? "h-[3.625rem] w-[3.25rem] flex-col gap-0" : "h-9 rounded-lg px-2.5",
        )}
      >
        <CheckIcon aria-hidden className="size-4 text-status-completed" />
        <span aria-hidden className="font-bold text-foreground">
          {count}
        </span>
        <span className="sr-only">
          {count} {count === 1 ? "vote" : "votes"}
        </span>
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
