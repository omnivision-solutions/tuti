"use client";

import { ChevronDownIcon, HeartIcon, ReplyIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
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

type ThreadState = {
  /** Which comment's Reply opened the box (null: it's closed), and whose it is (the box says who it answers). */
  openedBy: string | null;
  openedFor: string;
  /** Bumped by every Reply, so a box already open takes the focus again. */
  asked: number;
  reply: (commentId: string, author: string, button: HTMLButtonElement) => void;
  close: () => void;
};
const Thread = createContext<ThreadState>({ openedBy: null, openedFor: "", asked: 0, reply: () => {}, close: () => {} });

/**
 * A top-level comment and its replies: Reply on any of them opens one box, under the last reply (focused, again on each
 * Reply). Closed (posted or Cancel), the focus goes back to the Reply that opened it.
 */
export function ReplyThread({ children }: { children: React.ReactNode }) {
  const [openedBy, setOpenedBy] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState("");
  const [asked, setAsked] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closing = useRef(false);
  useEffect(() => {
    if (openedBy === null && closing.current) {
      closing.current = false;
      opener.current?.focus();
    }
  }, [openedBy]);
  const reply = (commentId: string, author: string, button: HTMLButtonElement) => {
    opener.current = button;
    setOpenedBy(commentId);
    setOpenedFor(author);
    setAsked((n) => n + 1);
  };
  const close = () => {
    closing.current = true;
    setOpenedBy(null);
  };
  return <Thread.Provider value={{ openedBy, openedFor, asked, reply, close }}>{children}</Thread.Provider>;
}

/** The thread's reply box, once Reply is pressed, naming whose Reply opened it; it closes once the reply is posted. */
export function ReplyBox({ ability, replyTo }: { ability: CommentAbility; replyTo: string }) {
  const { openedBy, openedFor, asked, close } = useContext(Thread);
  const box = useRef<HTMLDivElement>(null);
  // Reply again while it's open: back into the box (as it's made, the editor focuses itself).
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("[contenteditable=true]")?.focus();
  }, [asked]);
  if (openedBy === null || ability.can !== "act") {
    return null;
  }
  return (
    <div ref={box} className="flex flex-col gap-2">
      <CommentForm
        postId={ability.postId}
        replyTo={replyTo}
        placeholder={`Reply to ${openedFor}…`}
        signedIn={ability.portal ? true : undefined}
        uploads={ability.uploads}
        autoFocus
        onDone={close}
        onCancel={close}
      />
    </div>
  );
}

const ACTION = "inline-flex h-8 items-center gap-1.5 rounded-lg px-1.5 -mx-1.5 text-sm font-medium text-muted-foreground hover:text-foreground [&_svg]:size-4";

/** Reply and Like under a comment (`author`: whose, for their names: "Reply to Ada", "Like Ada's comment"). */
export function CommentActions({ ability, commentId, author, likes, liked }: { ability: CommentAbility; commentId: string; author: string; likes: number; liked: boolean }) {
  const { openedBy, reply } = useContext(Thread);
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
        <button
          type="button"
          className={ACTION}
          aria-label={`Reply to ${author}`}
          aria-expanded={openedBy === commentId}
          onClick={(event) => reply(commentId, author, event.currentTarget)}
        >
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
          // Not `disabled` while it saves: that would drop the keyboard's focus. A press meanwhile does nothing.
          aria-disabled={pending}
          aria-pressed={optimistic.liked}
          aria-label={`Like ${author}'s comment (${count})`}
          className={cn(ACTION, optimistic.liked && "text-primary hover:text-primary")}
          onClick={() =>
            !pending &&
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
