"use client";

import { ChevronDownIcon, HeartIcon, ReplyIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
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
import { errorMessage, useTRPCClient } from "@/components/trpc";

/**
 * What a reader may do with a thread's comments: `act` (signed in here: reply and like), `signIn` (signed out on a portal: both
 * ask them to sign in) or `none` (signed in through another project's single sign-on: the counts only).
 */
/** `project` and `number`: the post, as its comments' operations name it (comments.create, comments.like). */
export type CommentAbility = { can: "act" | "signIn" | "none"; postId: string; project: string; number: number; portal?: boolean; uploads?: EditorUploads };

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
  const t = useTranslations("feedback");
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
        post={{ project: ability.project, number: ability.number }}
        replyTo={replyTo}
        placeholder={t("replyToPlaceholder", { name: openedFor })}
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
  const client = useTRPCClient();
  const router = useRouter();
  const { openedBy, reply } = useContext(Thread);
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic({ likes, liked });
  // Only a portal's comments ask anyone to sign in.
  const signIn = useSignInHref();
  const t = useTranslations("feedback");
  const lang = useLocale();
  const count = t("likes", { count: optimistic.likes });
  // The count, or "Like" while there's none.
  const heart = (
    <>
      <HeartIcon aria-hidden className={cn(optimistic.liked && "fill-current")} />
      <span className="tabular-nums">{optimistic.likes > 0 ? optimistic.likes.toLocaleString(lang) : t("like")}</span>
    </>
  );

  return (
    <div className="flex items-center gap-4">
      {ability.can === "act" && (
        <button
          type="button"
          className={ACTION}
          aria-label={t("replyTo", { name: author })}
          aria-expanded={openedBy === commentId}
          onClick={(event) => reply(commentId, author, event.currentTarget)}
        >
          <ReplyIcon aria-hidden />
          {t("reply")}
        </button>
      )}
      {ability.can === "signIn" && (
        <Link href={signIn} className={ACTION} aria-label={t("replySignIn", { name: author })}>
          <ReplyIcon aria-hidden />
          {t("reply")}
        </Link>
      )}
      {ability.can === "act" ? (
        <button
          type="button"
          // Not `disabled` while it saves: that would drop the keyboard's focus. A press meanwhile does nothing.
          aria-disabled={pending}
          aria-pressed={optimistic.liked}
          aria-label={t("likeLabel", { name: author, likes: count })}
          className={cn(ACTION, optimistic.liked && "text-primary hover:text-primary")}
          onClick={() =>
            !pending &&
            startTransition(async () => {
              const next = !optimistic.liked;
              setOptimistic((s) => ({ liked: next, likes: s.likes + (next ? 1 : -1) }));
              // Saved: the page again (its counts). After an await a transition has to be started again, so the refresh is
              // one too: the like shown stays till the page's new count comes, without flickering back.
              await client.comments.like.mutate({ project: ability.project, number: ability.number, id: commentId, liked: next }).then(
                () => startTransition(() => router.refresh()),
                (error: unknown) => toast.error(errorMessage(error)),
              );
            })
          }
        >
          {heart}
        </button>
      ) : ability.can === "signIn" ? (
        <Link href={signIn} className={ACTION} aria-label={t("likeSignIn", { name: author, likes: count })}>
          {heart}
        </Link>
      ) : (
        optimistic.likes > 0 && (
          <span role="img" className={cn(ACTION, "hover:text-muted-foreground")} aria-label={t("likesOf", { name: author, likes: count })}>
            {heart}
          </span>
        )
      )}
    </div>
  );
}

const SORT_LABELS = { oldest: "oldestFirst", newest: "newestFirst" } as const satisfies Record<CommentSort, string>;

/** "Oldest first ▾": the thread's order, kept in the page's address (`?sort=newest`). */
export function CommentSortMenu({ sort }: { sort: CommentSort }) {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations("feedback");
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
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="text-muted-foreground" aria-label={t("sortComments", { sort: t(SORT_LABELS[sort]) })} />}>
        {t(SORT_LABELS[sort])}
        <ChevronDownIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={sort} onValueChange={(value) => pick(value as CommentSort)}>
          {(Object.keys(SORT_LABELS) as CommentSort[]).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {t(SORT_LABELS[value])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
