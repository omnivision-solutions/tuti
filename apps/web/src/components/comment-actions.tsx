"use client";

import { ChevronDownIcon, HeartIcon, ReplyIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";

import { CommentForm } from "@/components/comment-form";
import type { EditorUploads } from "@/components/rich-editor";
import { useSignInHref } from "@/components/sign-in-link";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { CommentSort } from "@/lib/comment-threads";
import { cn } from "@/lib/utils";
import { setCommentLike } from "@/server/posts";

/**
 * What a reader may do with a thread's comments: `act` (signed in here: reply and like), `signIn` (signed out on a portal: both
 * ask them to sign in) or `none` (signed in through another project's single sign-on: the counts only).
 */
export type CommentAbility = { can: "act" | "signIn" | "none"; postId: string; portal?: boolean; uploads?: EditorUploads };

const Thread = createContext<{ open: boolean; setOpen: (open: boolean) => void }>({ open: false, setOpen: () => {} });

/** A top-level comment and its replies: Reply on any of them opens one box, under the last reply. */
export function ReplyThread({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Thread.Provider value={{ open, setOpen }}>{children}</Thread.Provider>;
}

/** The thread's reply box, once Reply is pressed; it closes once the reply is posted. */
export function ReplyBox({ ability, replyTo, author }: { ability: CommentAbility; replyTo: string; author: string }) {
  const { open, setOpen } = useContext(Thread);
  if (!open || ability.can !== "act") {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <CommentForm
        postId={ability.postId}
        replyTo={replyTo}
        placeholder={`Reply to ${author}…`}
        signedIn={ability.portal ? true : undefined}
        uploads={ability.uploads}
        autoFocus
        onDone={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

const ACTION = "inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 -mx-1.5 text-sm font-medium text-muted-foreground hover:text-foreground [&_svg]:size-4";

/** Reply and Like under a comment (`author`: whose, for their names: "Reply to Ada", "Like Ada's comment"). */
export function CommentActions({ ability, commentId, author, likes, liked }: { ability: CommentAbility; commentId: string; author: string; likes: number; liked: boolean }) {
  const { setOpen } = useContext(Thread);
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ likes, liked });
  // Only a portal's comments ask anyone to sign in.
  const signIn = useSignInHref();
  const count = `${optimistic.likes} ${optimistic.likes === 1 ? "like" : "likes"}`;
  // The count, or "Like" while there's none.
  const heart = (
    <>
      <HeartIcon aria-hidden className={cn(optimistic.liked && "fill-current")} />
      <span className="tabular-nums">{optimistic.likes > 0 ? optimistic.likes : "Like"}</span>
    </>
  );

  return (
    <div className="flex items-center gap-4">
      {ability.can === "act" && (
        <button type="button" className={ACTION} aria-label={`Reply to ${author}`} onClick={() => setOpen(true)}>
          <ReplyIcon aria-hidden />
          Reply
        </button>
      )}
      {ability.can === "signIn" && (
        <Link href={signIn} className={ACTION} aria-label={`Reply to ${author}, sign in to reply`}>
          <ReplyIcon aria-hidden />
          Reply
        </Link>
      )}
      {ability.can === "act" ? (
        <button
          type="button"
          disabled={pending}
          aria-pressed={optimistic.liked}
          aria-label={`Like ${author}'s comment (${count})`}
          className={cn(ACTION, optimistic.liked && "text-primary hover:text-primary")}
          onClick={() =>
            startTransition(async () => {
              const next = !optimistic.liked;
              setOptimistic((s) => ({ liked: next, likes: s.likes + (next ? 1 : -1) }));
              const result = await setCommentLike(commentId, next);
              if (result.error) {
                toast.error(result.error);
              }
            })
          }
        >
          {heart}
        </button>
      ) : ability.can === "signIn" ? (
        <Link href={signIn} className={ACTION} aria-label={`Like ${author}'s comment (${count}), sign in to like`}>
          {heart}
        </Link>
      ) : (
        optimistic.likes > 0 && (
          <span role="img" className={cn(ACTION, "hover:text-muted-foreground")} aria-label={`${author}'s comment: ${count}`}>
            {heart}
          </span>
        )
      )}
    </div>
  );
}

const SORT_LABELS: Record<CommentSort, string> = { oldest: "Oldest first", newest: "Newest first" };

/** "Oldest first ▾": the thread's order, kept in the page's address (`?sort=newest`). */
export function CommentSortMenu({ sort }: { sort: CommentSort }) {
  const router = useRouter();
  const params = useSearchParams();
  const pick = (value: CommentSort) => {
    const next = new URLSearchParams(params.toString());
    if (value === "oldest") {
      next.delete("sort");
    } else {
      next.set("sort", value);
    }
    // The address as the browser has it (a portal on its own domain or a site's path), with the new query.
    router.replace(`${window.location.pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="text-muted-foreground" aria-label={`Sort comments: ${SORT_LABELS[sort]}`} />}>
        {SORT_LABELS[sort]}
        <ChevronDownIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={sort} onValueChange={(value) => pick(value as CommentSort)}>
          {(Object.keys(SORT_LABELS) as CommentSort[]).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {SORT_LABELS[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
