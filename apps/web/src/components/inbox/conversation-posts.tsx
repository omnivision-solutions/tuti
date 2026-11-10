"use client";

import type { PostStatus } from "@tuti/db";
import { LinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { PostPicker, usePostSearch } from "@/components/post-picker";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
    const targets = change.linked ? [`[data-unlink="${change.post}"]`] : [...(change.next === null ? [] : [`[data-unlink="${change.next}"]`]), `[data-link="${change.post}"]`];
    const target = targets.map((selector) => section.current?.querySelector<HTMLButtonElement>(selector)).find(Boolean);
    (target ?? moreActions())?.focus();
  }, [pending, posts, number]);

  const link = (post: number, linked: boolean) => {
    const at = posts.findIndex((p) => p.number === post);
    const change = { conversation: number, post, linked, next: linked ? null : ((posts[at + 1] ?? posts[at - 1])?.number ?? null), saved: false, from: document.activeElement };
    moved.current = change;
    save(post, linked, (ok) => {
      if (moved.current === change) {
        moved.current = ok ? { ...change, saved: true } : null;
      }
    });
  };

  if (posts.length === 0 && related.length === 0) {
    return null;
  }

  return (
    <Card size="sm">
      <CardContent>
        {/* A region named Linked posts only once there are some: before, it holds only what looks related. */}
        <section ref={section} aria-label={posts.length > 0 ? "Linked posts" : undefined} className="flex flex-col gap-2">
          {posts.length > 0 && (
            <>
              <h2 className="text-xs font-medium text-muted-foreground">Linked posts</h2>
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
            </>
          )}
          {related.length > 0 && (
            <section aria-label="Looks related" className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Looks related</h3>
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
                      variant="outline"
                      size="xs"
                      aria-label={`Link “${post.title}”`}
                      data-link={post.number}
                      // Keeps the keyboard's focus while it saves (and after, if it failed).
                      focusableWhenDisabled
                      disabled={pending}
                      onClick={() => link(post.number, true)}
                    >
                      Link
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * "Link a post…", in the conversation's top bar menu: searches the project's posts (findPostsToLink) as it's typed in,
 * to pick the one this is about (it shows on the post, beside its voters). `linked`: those it's linked to already.
 */
export function LinkPostButton({ projectSlug, number, linked }: { projectSlug: string; number: number; linked: number[] }) {
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
      <DialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>
        <LinkIcon />
        Link a post…
      </DialogTrigger>
      {/* Opened from "More actions", which closes as it opens: the focus goes back to that button, not to this one
          (hidden in its closed menu). */}
      <DialogContent finalFocus={() => moreActions() ?? true}>
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
