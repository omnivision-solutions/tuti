"use client";

import type { PostStatus } from "@tuti/db";
import { LinkIcon, PlusIcon, SparklesIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { PostPicker, usePostSearch } from "@/components/post-picker";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DetailSection } from "@/components/inbox/detail-section";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { findPostsToLink, linkPostToConversation } from "@/server/inbox";

/** The top bar's "More actions" that shows (one on phones, one from tablet width up): "Link a post…" is behind it. */
const moreActions = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="More actions"]')].find((button) => button.checkVisibility());

/** Links a post to the conversation (or unlinks it), saying so, and the page refreshes with it. */
function useLink(projectSlug: string, number: number) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const link = (post: number, linked: boolean, done?: (ok: boolean) => void) =>
    startTransition(async () => {
      const result = await linkPostToConversation(projectSlug, number, post, linked).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(linked ? `Linked to #${post}` : `Unlinked #${post}`);
        router.refresh();
      }
      done?.(!result.error);
    });
  return { pending, link };
}

/**
 * The posts a conversation is about, beside it, in a card (once there are some, or some look related): each opens the
 * post or is unlinked; "Looks related": open posts like it (postsLikeConversation), each linked in a click. Another is
 * linked from the top bar's menu (LinkPostButton). Kept mounted without a card, so what it does with the keyboard's focus
 * after the last one is unlinked still happens.
 */
export function ConversationPosts({
  projectSlug,
  number,
  posts,
  related,
}: {
  projectSlug: string;
  number: number;
  posts: { number: number; title: string; status: PostStatus }[];
  related: { number: number; title: string; status: PostStatus }[];
}) {
  const { pending, link: save } = useLink(projectSlug, number);
  // Where the keyboard's focus goes once a link or unlink saved and the refreshed list has it: one linked from "Looks
  // related" moves up into the linked posts, so to its Unlink; one unlinked leaves its row, so to the next Unlink (or the
  // one before), else to its Link if it looks related, else (the card gone) to "More actions", where "Link a post…" is.
  // Only while the focus is still where it was (on the button, or lost with its row) and in the same conversation: not
  // after they've moved on (opened a post, another conversation, hid the details). A failed one leaves it on its button.
  const section = useRef<HTMLElement>(null);
  const moved = useRef<{ conversation: number; post: number; linked: boolean; next: number | null; saved: boolean; from: Element | null } | null>(null);
  useEffect(() => {
    const change = moved.current;
    if (!change || change.conversation !== number) {
      moved.current = null;
      return;
    }
    if (pending || !change.saved || posts.some((post) => post.number === change.post) !== change.linked) {
      return;
    }
    moved.current = null;
    const focused = document.activeElement;
    // On the button they pressed, or lost with its row; not once they've moved to anything else, in the card or not.
    if (focused && focused !== document.body && focused !== change.from) {
      return;
    }
    const targets = change.linked
      ? [`[data-unlink="${change.post}"]`]
      : [...(change.next === null ? [] : [`[data-unlink="${change.next}"]`]), `[data-link="${change.post}"]`];
    const target = targets.map((selector) => section.current?.querySelector<HTMLButtonElement>(selector)).find(Boolean);
    // Folded (this browser keeps it so), its section opens to show where the focus went.
    const folded = target?.closest("details");
    if (folded) folded.open = true;
    (target ?? moreActions())?.focus();
  }, [pending, posts, number]);

  const link = (post: number, linked: boolean) => {
    const at = posts.findIndex((p) => p.number === post);
    const change = {
      conversation: number,
      post,
      linked,
      next: linked ? null : ((posts[at + 1] ?? posts[at - 1])?.number ?? null),
      saved: false,
      from: document.activeElement,
    };
    moved.current = change;
    save(post, linked, (ok) => {
      if (moved.current === change) {
        moved.current = ok ? { ...change, saved: true } : null;
      }
    });
  };

  return (
    <div className="inbox-posts [&_a]:text-[0.875rem] [&_a]:font-medium">
      {/* A region named Linked posts only once there are some: before, it holds only what looks related. */}
      <section ref={section} aria-label={posts.length > 0 ? "Linked posts" : undefined}>
        <DetailSection title="Linked posts" count={posts.length} icon={LinkIcon} open={posts.length > 0}>
          <ul className="flex flex-col gap-2">
            {posts.map((post) => (
              <li key={post.number} className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link href={`/app/${projectSlug}/p/${post.number}`} className="text-sm break-words hover:underline">
                    {post.title}
                  </Link>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <PostStatusBadge status={post.status} />#{post.number}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Unlink “${post.title}”`}
                  title="Unlink"
                  data-unlink={post.number}
                  disabled={pending}
                  // Keeps the keyboard's focus while it saves; then it moves on (above).
                  focusableWhenDisabled
                  onClick={() => link(post.number, false)}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
          <LinkPostButton projectSlug={projectSlug} number={number} linked={posts.map((post) => post.number)} inline />
        </DetailSection>
        <section aria-label="Looks related">
          <DetailSection title="Looks related" count={related.length} icon={SparklesIcon} open={related.length > 0}>
            <ul className="flex flex-col gap-2">
              {related.map((post) => (
                <li key={post.number} className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Link href={`/app/${projectSlug}/p/${post.number}`} className="text-sm break-words hover:underline">
                      {post.title}
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <PostStatusBadge status={post.status} />#{post.number}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="inbox-related-link ml-auto self-end border-0 bg-transparent px-0 font-normal text-primary shadow-none [&>svg]:size-3.25"
                    aria-label={`Link “${post.title}”`}
                    data-link={post.number}
                    // Keeps the keyboard's focus while it saves (and after, if it failed).
                    focusableWhenDisabled
                    disabled={pending}
                    onClick={() => link(post.number, true)}
                  >
                    <LinkIcon aria-hidden />
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          </DetailSection>
        </section>
      </section>
    </div>
  );
}

/**
 * "Link a post…", in the conversation's top bar menu: searches the project's posts (findPostsToLink) as it's typed in,
 * to pick the one this is about (it shows on the post, beside its voters). `linked`: those it's linked to already.
 */
export function LinkPostButton({ projectSlug, number, linked, inline = false }: { projectSlug: string; number: number; linked: number[]; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const { pending, link } = useLink(projectSlug, number);
  const search = usePostSearch((q) => findPostsToLink(projectSlug, q));
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        search.restart(next);
      }}
    >
      {inline ? (
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              focusableWhenDisabled
              className="inbox-link-post mt-2.5 flex h-auto min-h-6 w-fit p-0 text-xs leading-5 font-normal text-muted-foreground [&>svg]:size-3.5"
              aria-label="Link a post to this conversation"
            />
          }
        >
          <PlusIcon /> Link a post
        </DialogTrigger>
      ) : (
        <DropdownMenuItem disabled={pending} onClick={() => { setOpen(true); search.restart(true); }}>
          <LinkIcon /> Link a post…
        </DropdownMenuItem>
      )}
      {/* Opened from "More actions", which closes as it opens: the focus goes back to that button, not to this one
          (hidden in its closed menu). */}
      <DialogContent finalFocus={inline ? undefined : () => moreActions() ?? true}>
        <DialogHeader>
          <DialogTitle>Link a post</DialogTitle>
          <DialogDescription>Pick the post this conversation is about. It shows on the post, beside its voters.</DialogDescription>
        </DialogHeader>
        <PostPicker
          candidates={search.found.filter((post) => !linked.includes(post.number))}
          query={search.query}
          onQueryChange={search.onQueryChange}
          onPick={(post) =>
            link(post.number, true, (ok) => {
              if (ok) {
                search.restart(false);
                setOpen(false);
              }
            })
          }
          disabled={pending}
          searching={search.searching}
        />
      </DialogContent>
    </Dialog>
  );
}
