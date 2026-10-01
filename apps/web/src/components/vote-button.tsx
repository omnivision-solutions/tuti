"use client";

import { useOptimistic, useTransition } from "react";

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
    <button
      type="button"
      disabled={disabled || pending}
      title={disabled ? "Sign in to vote" : undefined}
      onClick={() =>
        startTransition(async () => {
          setOptimistic((s) => ({ voted: !s.voted, count: s.count + (s.voted ? -1 : 1) }));
          await toggleVote(postId);
        })
      }
      className={`flex w-14 flex-col items-center rounded-md border py-1 text-sm ${
        optimistic.voted
          ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
          : "border-zinc-200 dark:border-zinc-800"
      } disabled:cursor-not-allowed`}
    >
      <span aria-hidden>▲</span>
      <span className="font-semibold">{optimistic.count}</span>
    </button>
  );
}
