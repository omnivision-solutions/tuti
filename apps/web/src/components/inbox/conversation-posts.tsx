"use client";

import type { PostStatus } from "@tuti/db";
import { LinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { PostPicker, usePostSearch } from "@/components/post-picker";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { findPostsToLink, linkPostToConversation } from "@/server/inbox";

/**
 * The posts a conversation is about, beside it: each opens the post or is unlinked; "Looks related": open posts like it
 * (postsLikeConversation), each linked in a click; "Link post…" searches the project's posts (findPostsToLink) as it's
 * typed in, to pick another.
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const search = usePostSearch((q) => findPostsToLink(projectSlug, q));
  const linked = new Set(posts.map((post) => post.number));

  const link = (post: number, linked: boolean) =>
    startTransition(async () => {
      const result = await linkPostToConversation(projectSlug, number, post, linked).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(linked ? `Linked to #${post}` : `Unlinked #${post}`);
      search.restart(false);
      setOpen(false);
      router.refresh();
    });

  return (
    <section aria-label="Linked posts" className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-muted-foreground">Linked posts</h2>
      {posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Link the posts this is about: it shows on them, beside their voters.</p>
      ) : (
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
              <Button variant="ghost" size="icon-sm" aria-label={`Unlink “${post.title}”`} title="Unlink" disabled={pending} onClick={() => link(post.number, false)}>
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
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
                <Button variant="outline" size="xs" aria-label={`Link “${post.title}”`} disabled={pending} onClick={() => link(post.number, true)}>
                  Link
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          search.restart(next);
        }}
      >
        <DialogTrigger render={<Button variant="outline" size="sm" className="self-start" disabled={pending} />}>
          <LinkIcon />
          Link post…
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link a post</DialogTitle>
            <DialogDescription>Pick the post this conversation is about.</DialogDescription>
          </DialogHeader>
          <PostPicker
            candidates={search.found.filter((post) => !linked.has(post.number))}
            query={search.query}
            onQueryChange={search.onQueryChange}
            onPick={(post) => link(post.number, true)}
            disabled={pending}
            searching={search.searching}
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
