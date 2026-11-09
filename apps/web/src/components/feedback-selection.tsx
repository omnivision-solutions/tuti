"use client";

import type { PostStatus, PostVisibility } from "@tuti/db";
import { ChevronDownIcon, ChevronUpIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, use, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FADE_AT_MORE, focusClearOfFade, showMore, wheelSideways } from "@/components/sub-nav";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { eachPost } from "@/lib/each-post";
import { cn } from "@/lib/utils";
import { mergeExposure } from "@/lib/visibility-labels";
import { changePostStatus, mergePost, movePost } from "@/server/manage-posts";

/** A post as the selection keeps it: enough to name it and pick which one stays in a merge (`sample`: sample content). */
type Picked = { id: string; number: number; title: string; voteCount: number; emails: number; sample: boolean; visibility?: PostVisibility; authorId?: string };

const Selection = createContext<{
  picked: Picked[];
  toggle: (post: Picked, on: boolean) => void;
  clear: () => void;
  pending: boolean;
  startTransition: (run: () => Promise<void>) => void;
} | null>(null);

const useSelection = () => {
  const selection = use(Selection);
  if (!selection) {
    throw new Error("useSelection is for inside FeedbackSelection");
  }
  return selection;
};

/**
 * Feedback's rows picked for Set status, Move to board and Merge (FeedbackBulk), kept as the list re-renders,
 * as the list has them now (`listed`: their titles and votes as they are). One that leaves the list (a new
 * status from its row, merged from the pane) is let go, not picked again if it comes back. While an action runs
 * (`pending`), the picks stay as they are.
 */
export function FeedbackSelection({ listed, children }: { listed: Picked[]; children: ReactNode }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  // The list changed: picks no longer in it are let go (as it renders, React's way to adjust state to props).
  const ids = listed.map((post) => post.id).join(" ");
  const [seen, setSeen] = useState(ids);
  if (seen !== ids) {
    setSeen(ids);
    setChosen((picks) => picks.filter((id) => listed.some((post) => post.id === id)));
  }
  const picked = listed.filter((post) => chosen.includes(post.id));
  const toggle = (post: Picked, on: boolean) => setChosen((now) => (on ? [...now.filter((id) => id !== post.id), post.id] : now.filter((id) => id !== post.id)));
  return <Selection value={{ picked, toggle, clear: () => setChosen([]), pending, startTransition }}>{children}</Selection>;
}

/**
 * A row's checkbox, to pick its post, in the row's left padding. From tablet width up it shows on the row's hover or
 * focus, and on every row once one is picked (so a list at rest is titles, not boxes). Phones, which can't hover,
 * change posts one at a time.
 */
export function SelectPost({ post }: { post: Picked }) {
  const { picked, toggle, pending } = useSelection();
  return (
    <input
      type="checkbox"
      disabled={pending}
      aria-label={`Select ${post.title}`}
      checked={picked.some((p) => p.id === post.id)}
      onChange={(event) => toggle(post, event.currentTarget.checked)}
      className={cn(
        // Hidden until hover only where there's hover (not on a touch tablet).
        "size-4 shrink-0 accent-primary [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
        picked.length > 0 && "[@media(hover:hover)]:opacity-100",
      )}
    />
  );
}

/**
 * A post's row in Feedback's list, the same at every width: its votes; its board (a small label), the title, a line of
 * the post and the meta line (who, when, comments); at the right its owner's face (from tablet width up) and its status
 * menu. The checkbox in the left padding. Filled while it's open beside the list (`selected`), tinted green while it's
 * picked.
 */
export function PickedRow({
  postId,
  select,
  votes,
  board,
  title,
  badges,
  excerpt,
  meta,
  owner,
  status,
  selected = false,
}: {
  postId: string;
  select: ReactNode;
  votes: ReactNode;
  board: string;
  title: ReactNode;
  badges?: ReactNode;
  excerpt?: string;
  meta: ReactNode;
  owner: ReactNode;
  status: ReactNode;
  selected?: boolean;
}) {
  const { picked } = useSelection();
  const on = picked.some((p) => p.id === postId);
  return (
    <li
      data-selected={selected || on || undefined}
      className={cn(
        "group/row relative flex items-start gap-3 px-4 py-3.5 sm:gap-4 sm:pr-4 sm:pl-9",
        // Filled, it has no line under it (the list's line above it goes too).
        on ? (selected ? "border-transparent bg-primary/15" : "border-transparent bg-primary/8") : selected ? "border-transparent bg-muted" : "hover:bg-muted/50",
      )}
    >
      {/* On phones before the votes; from tablet width up in the row's left padding. */}
      <div className="flex self-center sm:absolute sm:top-1/2 sm:left-2.5 sm:-translate-y-1/2">{select}</div>
      <div className="shrink-0">{votes}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs font-medium tracking-[0.04em] text-muted-foreground uppercase">{board}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-[1.0625rem] leading-snug font-semibold break-words">{title}</span>
          {badges}
        </div>
        {excerpt && <p className="line-clamp-1 text-sm text-muted-foreground">{excerpt}</p>}
        <div className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground", (selected || on) && "text-foreground/70")}>{meta}</div>
      </div>
      <div className="flex w-7 shrink-0 justify-center self-center max-sm:hidden">{owner}</div>
      <div className="flex shrink-0 justify-end self-center sm:min-w-8 sm:opacity-60 sm:transition-opacity sm:group-hover/row:opacity-100 sm:focus-within:opacity-100">{status}</div>
    </li>
  );
}

/**
 * The list's filters: in a row from tablet width up; on phones behind one "Filters" button (with how many are set),
 * opening them in a popover, so the search has the width.
 */
export function FiltersFold({ set, extra, children }: { set: number; /** Under the filters in the popover (phones). */ extra?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="max-sm:hidden">{children}</div>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" className="sm:hidden" />}>
          <SlidersHorizontalIcon />
          Filters
          {set > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">{set}</span>}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 [&_[data-slot=select-trigger]]:w-full [&>div>div]:flex-col [&>div>div]:items-stretch">
          {children}
          {extra}
        </PopoverContent>
      </Popover>
    </>
  );
}

/** A post's votes in the team's lists: the count in a small bordered box under the vote arrow, "votes" for screen readers. */
export function VoteBox({ count }: { count: number }) {
  return (
    <span className="flex w-11 shrink-0 flex-col items-center rounded-lg border bg-card py-1 text-sm leading-tight font-semibold tabular-nums">
      <ChevronUpIcon aria-hidden className="size-4 text-muted-foreground" />
      {count}
      <span className="sr-only">{count === 1 ? " vote" : " votes"}</span>
    </span>
  );
}

const STATUSES = Object.keys(STATUS_LABELS) as PostStatus[];

/**
 * What can be done to the picked posts, once some are: Set status (Completed asks first: it emails their
 * voters), Move to board, Merge (into the one kept, the most voted for by default), Clear. Each post is done
 * as on its own; what fails is said and the rest still go. In place of `children` (the list's filters): both in
 * one grid cell, the filters hidden (and out of reach) while the bar shows, so the cell keeps the taller one's
 * height and the list doesn't move.
 */
export function FeedbackBulk({ projectSlug, boards, children }: { projectSlug: string; boards: { slug: string; name: string }[]; children: ReactNode }) {
  const { picked, clear, pending, startTransition } = useSelection();
  const router = useRouter();
  const [completing, setCompleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [keep, setKeep] = useState<string | null>(null);
  // The bar gone (an action done, Clear) while it held the focus: to the first filter, in its place, the page left
  // where it is. Not when the focus was never in it (Safari doesn't focus a box that's clicked: unticking the last
  // one mustn't scroll the page to the filters). `barHeld`: focus came into the bar and hasn't left it, to elsewhere
  // or to nowhere (a click on the page's background); only its button taken away with it doesn't count.
  const filtersRef = useRef<HTMLDivElement>(null);
  const hadBar = useRef(false);
  const barHeld = useRef(false);
  useEffect(() => {
    if (hadBar.current && picked.length === 0 && barHeld.current && document.activeElement === document.body) {
      // The first one shown (on phones the Filters button; the inline filters are hidden there).
      [...(filtersRef.current?.querySelectorAll<HTMLElement>("button") ?? [])].find((button) => button.getClientRects().length > 0)?.focus({ preventScroll: true });
    }
    hadBar.current = picked.length > 0;
    if (picked.length === 0) {
      barHeld.current = false;
    }
  }, [picked.length]);
  // Which ends of the bar's actions have more past them, for the fade there: as it's shown, scrolled, resized. A
  // mouse's wheel scrolls them sideways, and a button tabbed to under the fade comes clear of it, as the tabs'.
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = actionsRef.current;
    if (!row) return;
    const update = () => showMore(row);
    const wheel = wheelSideways(row);
    const observer = new ResizeObserver(update);
    observer.observe(row);
    row.addEventListener("scroll", update, { passive: true });
    row.addEventListener("wheel", wheel, { passive: false });
    row.addEventListener("focusin", focusClearOfFade);
    return () => {
      observer.disconnect();
      row.removeEventListener("scroll", update);
      row.removeEventListener("wheel", wheel);
      row.removeEventListener("focusin", focusClearOfFade);
    };
  }, [picked.length]);
  const filters = (hidden: boolean) => (
    <div ref={filtersRef} className={hidden ? "invisible" : undefined} inert={hidden}>
      {children}
    </div>
  );
  if (picked.length === 0) {
    return <div className="grid grid-cols-1 *:[grid-area:1/1]">{filters(false)}</div>;
  }
  const count = `${picked.length} ${picked.length === 1 ? "post" : "posts"}`;
  // Who completing them emails, at most (one person asking for two is counted twice).
  const emailing = picked.reduce((sum, post) => sum + post.emails, 0);

  // Each in turn: what went, what didn't (and why), then the list again with none picked.
  const each = (posts: Picked[], run: (post: Picked) => Promise<{ error?: string }>, done: string) =>
    startTransition(async () => {
      const failed = await eachPost(posts, run);
      if (failed.length === 0) {
        toast.success(done);
      } else {
        toast.error(`${posts.length - failed.length} of ${posts.length} done. ${failed.join(" ")}`);
      }
      clear();
      router.refresh();
    });

  const setStatus = (status: PostStatus) =>
    each(picked, (post) => changePostStatus(projectSlug, post.id, status), `${count}: ${STATUS_LABELS[status]}`);
  const kept = picked.find((p) => p.id === keep) ?? [...picked].sort((a, b) => b.voteCount - a.voteCount)[0]!;

  // In a narrow list column (a phone, a post open beside it), shorter words (the same names for screen readers): the
  // bar stays one row.
  return (
    <div className="grid grid-cols-1 *:[grid-area:1/1]">
      {filters(true)}
      <div
        role="toolbar"
        aria-label="Selected posts"
        onFocus={() => (barHeld.current = true)}
        onBlur={(event) => {
          if (event.target.isConnected && !event.currentTarget.contains(event.relatedTarget)) {
            barHeld.current = false;
          }
        }}
        // Narrower still (a post open beside the list on a small laptop): the count stays whole, the actions scroll
        // sideways, faded at the end that has more (as the tabs do; room kept for their focus rings, the bar no taller).
        className="flex items-center gap-2 text-sm @max-md:gap-1.5">
        <span className="shrink-0 font-medium">{picked.length} selected</span>
        <div ref={actionsRef} className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-2 @max-md:-m-1 @max-md:flex-nowrap @max-md:gap-1.5 @max-md:overflow-x-auto @max-md:p-1 [scrollbar-width:none] *:scroll-mx-12", FADE_AT_MORE)}>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} focusableWhenDisabled aria-label="Set status" />}>
              <span className="@max-md:hidden">Set status</span>
              <span className="@md:hidden">Status</span>
              <ChevronDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-auto min-w-40">
              {STATUSES.map((status) => (
                <DropdownMenuItem key={status} onClick={() => (status === "COMPLETED" ? setCompleting(true) : setStatus(status))}>
                  <StatusDot status={status} />
                  {STATUS_LABELS[status]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} focusableWhenDisabled aria-label="Move to board" />}>
              <span className="@max-md:hidden">Move to board</span>
              <span className="@md:hidden">Board</span>
              <ChevronDownIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-auto min-w-40">
              {boards.map((board) => (
                <DropdownMenuItem key={board.slug} onClick={() => each(picked, (post) => movePost(projectSlug, post.id, board.slug), `${count} moved to ${board.name}`)}>
                  {board.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Sample posts merge with sample ones only, the team's with theirs (mergePosts refuses the rest): no Merge for a mix. */}
          {picked.length > 1 && new Set(picked.map((post) => post.sample)).size === 1 && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              focusableWhenDisabled
              onClick={() => {
                // The most voted for, each time it opens.
                setKeep(null);
                setMerging(true);
              }}
            >
              Merge…
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={pending} focusableWhenDisabled onClick={clear} className="ml-auto @max-md:size-7 @max-md:px-0">
            <XIcon className="@md:hidden" />
            <span className="@max-md:sr-only">Clear</span>
          </Button>
        </div>

        <AlertDialog open={completing} onOpenChange={setCompleting}>
          <AlertDialogContent closeDisabled={pending}>
            <AlertDialogHeader>
              <AlertDialogTitle>Mark {count} as Completed?</AlertDialogTitle>
              <AlertDialogDescription>
                {emailing
                  ? `This emails up to ${emailing} ${emailing === 1 ? "person" : "people"} who asked for them that it shipped, as when one post is completed.`
                  : "Nobody is emailed."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={() => {
                  setCompleting(false);
                  setStatus("COMPLETED");
                }}
              >
                Mark completed
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
  
        <AlertDialog open={merging} onOpenChange={setMerging}>
          <AlertDialogContent closeDisabled={pending}>
            <AlertDialogHeader>
              <AlertDialogTitle>Merge {count} into one?</AlertDialogTitle>
              <AlertDialogDescription>
                The others&apos; votes (counted once per person) and comments move to the one you keep, and their links point to it. This
                can&apos;t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1 font-medium">Keep</legend>
              {picked.map((post) => (
                <label key={post.id} className="flex items-baseline gap-2">
                  <input type="radio" name="keep" checked={post.id === kept.id} onChange={() => setKeep(post.id)} className="accent-primary" />
                  <span>
                    #{post.number} {post.title} <span className="text-muted-foreground">· {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {/* Comments that will be seen by people who couldn't see them, as the post page's Merge dialog says. */}
            {picked
              .filter((post) => post.id !== kept.id)
              .flatMap((post) => {
                const exposure = mergeExposure(post, kept, kept.number);
                return exposure ? [<p key={post.id} className="text-sm text-muted-foreground">#{post.number}: {exposure}</p>] : [];
              })}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={() => {
                  setMerging(false);
                  each(
                    picked.filter((post) => post.id !== kept.id),
                    (post) => mergePost(projectSlug, post.id, kept.id),
                    `Merged into #${kept.number}`,
                  );
                }}
              >
                Merge into #{kept.number}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
