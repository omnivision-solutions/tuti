"use client";

import { CheckIcon, ChevronUpIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { useSignInHref } from "@/components/sign-in-link";
import { errorMessage, useTRPCClient } from "@/components/trpc";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SHAPE = "h-auto w-12 flex-col gap-0 py-1.5";
/**
 * The portal's shapes: `box` (a board's row: the chevron over the count), `chip` (a roadmap card's footer: side by side,
 * small), `upvote` (a post's rail: "Upvote", then the count, the whole width) and `compact` (the widget's rows: a smaller box).
 */
const SHAPES = {
  box: "h-[3.625rem] w-[3.25rem] shrink-0 flex-col gap-0 rounded-xl text-[0.9375rem] font-bold tabular-nums [&_svg]:size-[1.125rem]",
  compact: "h-[2.875rem] w-[2.625rem] shrink-0 flex-col gap-0 rounded-lg text-sm font-bold tabular-nums [&_svg]:size-4",
  chip: "h-9 shrink-0 gap-1 rounded-lg px-2.5 text-[0.9375rem] font-bold tabular-nums",
  upvote: "h-12 gap-2.5 rounded-xl px-5 text-base font-semibold tabular-nums",
} as const;
export type VoteShape = keyof typeof SHAPES;
/**
 * A portal shape's look: a grey fill without an edge, or once voted, the accent's soft tint with a thin inset ring in the
 * accent and the chevron in it (the primary is the post's Upvote, before voting). The ring is the cue that isn't only a
 * fill: with a grey or black accent, or Tuti's green, the tint is close to the grey.
 */
const portalLook = (shape: VoteShape, voted: boolean) =>
  voted
    ? cn("border-transparent bg-soft text-soft-foreground shadow-none ring-1 ring-primary/45 ring-inset hover:bg-soft", shape !== "upvote" && "[&_svg]:text-primary")
    : shape === "upvote"
      ? ""
      : "border-transparent bg-secondary [&_svg]:text-muted-foreground";

/** The words and count inside a portal shape (`upvote` says what it does; the others are the chevron and count). */
function Contents({ shape, count, voted }: { shape?: VoteShape; count: number; voted: boolean }) {
  const t = useTranslations("feedback");
  const number = count.toLocaleString(useLocale());
  if (shape === "upvote") {
    return (
      <>
        {voted ? <CheckIcon /> : <ChevronUpIcon />}
        {voted ? t("upvoted") : t("upvote")}
        <span aria-hidden className="h-5 w-px bg-current opacity-30" />
        <span className="font-bold">{number}</span>
      </>
    );
  }
  return (
    <>
      <ChevronUpIcon />
      <span className="font-semibold tabular-nums">{number}</span>
    </>
  );
}

export function VoteButton({
  project,
  number,
  count,
  voted,
  disabled,
  vote,
  signInHref,
  signedOut,
  shape,
}: {
  /** The post: its project's slug and its number (votes.set). */
  project: string;
  number: number;
  count: number;
  voted: boolean;
  disabled: boolean;
  /** Votes (true) or takes it back instead of votes.set as the page's session (the widget's, which updates `count` and `voted` itself). */
  vote?: (voted: boolean) => Promise<{ error?: string }>;
  /** Signed out, a link to sign in (in a new tab: the widget's) instead of a disabled button. */
  signInHref?: string;
  /** On a portal, signed out: a link to its sign-in page that comes back here (signed in but unable to vote, `disabled`). */
  signedOut?: boolean;
  /** The portal's and the widget's (see SHAPES); without one, the app's. */
  shape?: VoteShape;
}) {
  const [pending, startTransition] = useTransition();
  const client = useTRPCClient();
  const router = useRouter();
  const [optimistic, setOptimistic] = useOptimistic({ count, voted });
  const t = useTranslations("feedback");
  const votes = t("votes", { count: optimistic.count });

  if (signedOut) {
    return <PortalSignInToVote count={optimistic.count} votes={votes} shape={shape} />;
  }
  if (signInHref) {
    return (
      <a
        href={signInHref}
        target="_blank"
        rel="noreferrer"
        aria-label={t("signInToVoteLabel", { votes })}
        className={shape ? cn(buttonVariants({ variant: "secondary" }), SHAPES[shape], portalLook(shape, false)) : cn(buttonVariants({ variant: "outline" }), SHAPE)}
      >
        <Contents count={optimistic.count} voted={false} />
      </a>
    );
  }
  return (
    <Button
      variant={shape ? (shape === "upvote" && !optimistic.voted ? "default" : "secondary") : optimistic.voted ? "default" : "outline"}
      disabled={disabled || pending}
      title={disabled ? t("signInToVote") : undefined}
      aria-pressed={optimistic.voted}
      // The count too: the label replaces the button's text for screen readers.
      // Its words first (the post's says "Upvoted" once voted, for voice control), then the count; aria-pressed says it's on.
      aria-label={optimistic.voted ? (shape === "upvote" ? t("upvotedLabel", { votes }) : t("removeVoteLabel", { votes })) : t("upvoteLabel", { votes })}
      // Disabled while its save goes (`pending`), so two of its saves never overlap: each lands before the next is sent.
      onClick={() =>
        startTransition(async () => {
          const next = !optimistic.voted;
          setOptimistic((s) => ({ voted: next, count: s.count + (next ? 1 : -1) }));
          const result: { error?: string } = vote
            ? await vote(next)
            : await client.votes.set.mutate({ project, number, voted: next }).then(
                // Saved: the page again (its count, who voted). After an await a transition has to be started again, so the
                // refresh is one too: the vote shown stays till the page's new count comes, without flickering back.
                () => (startTransition(() => router.refresh()), {}),
                (error: unknown) => ({ error: errorMessage(error) }),
              );
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
  const t = useTranslations("feedback");
  return (
    <Link
      href={useSignInHref()}
      // The post's says "Upvote": its words first (voice control), then what it does.
      aria-label={shape === "upvote" ? t("upvoteSignInLabel", { votes }) : t("signInToVoteLabel", { votes })}
      className={cn(buttonVariants({ variant: shape === "upvote" ? "default" : shape ? "secondary" : "outline" }), shape ? cn(SHAPES[shape], portalLook(shape, false)) : SHAPE)}
    >
      <Contents shape={shape} count={count} voted={false} />
    </Link>
  );
}

/** A completed idea's votes, as text: it's shipped, so there's nothing left to vote for. */
export function VoteCount({ count, shape }: { count: number; shape?: VoteShape }) {
  const t = useTranslations("feedback");
  const lang = useLocale();
  const number = count.toLocaleString(lang);
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
          {number}
        </span>
        <span className="sr-only">
          {t("votes", { count })}
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
