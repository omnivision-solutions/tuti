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
 * The posts a conversation is about, beside it (once there are some, or some look related): each opens the post or is
 * unlinked; "Looks related": open posts like it (postsLikeConversation), each linked in a click. Another is linked from
 * the top bar's menu (LinkPostButton).
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
  // Where the keyboard's focus goes once the refreshed list has the change (kept till then; dropped if it failed): one
  // linked from "Looks related" moves up into the linked posts, so to its Unlink; one unlinked leaves its row, so to the
  // next Unlink (or the one before), else to its Link if it looks related, else to "More actions", where "Link a post…" is.
  const section = useRef<HTMLElement>(null);
  const moved = useRef<{ post: number; linked: boolean; next: number | null } | null>(null);
  useEffect(() => {
    const change = moved.current;
    if (pending || !change || posts.some((post) => post.number === change.post) !== change.linked) {
      return;
    }
    moved.current = null;
    const targets = change.linked ? [`[data-unlink="${change.post}"]`] : [...(change.next === null ? [] : [`[data-unlink="${change.next}"]`]), `[data-link="${change.post}"]`];
    const target = targets.map((selector) => section.current?.querySelector<HTMLButtonElement>(selector)).find(Boolean);
    (target ?? moreActions())?.focus();
  }, [pending, posts]);
  // The last one unlinked with nothing looking related: the card goes, so the focus goes to "More actions".
  useEffect(
    () => () => {
      if (moved.current && !moved.current.linked) {
        moreActions()?.focus();
      }
    },
    [],
  );

  const link = (post: number, linked: boolean) => {
    const at = posts.findIndex((p) => p.number === post);
    moved.current = { post, linked, next: linked ? null : (posts[at + 1] ?? posts[at - 1])?.number ?? null };
    save(post, linked, (ok) => {
      if (!ok) {
        moved.current = null;
      }
    });
  };

  return (
    // A region named Linked posts only once there are some: before, it holds only what looks related.
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
      <DialogContent>
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
