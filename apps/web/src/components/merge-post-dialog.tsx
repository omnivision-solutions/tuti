"use client";

import { MergeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { type PickablePost, PostPicker } from "@/components/post-picker";
import { mergePost } from "@/server/manage-posts";

/** Team-only: pick the original post and merge this one into it. */
export function MergePostDialog({
  projectSlug,
  post,
  candidates,
}: {
  projectSlug: string;
  post: { id: string; number: number; title: string };
  candidates: PickablePost[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<PickablePost>();
  const [pending, startTransition] = useTransition();

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setTarget(undefined);
      setQuery("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <MergeIcon />
        Merge into…
      </DialogTrigger>
      <DialogContent>
        {!target ? (
          <>
            <DialogHeader>
              <DialogTitle>Merge #{post.number} into…</DialogTitle>
              <DialogDescription>Pick the post this one duplicates.</DialogDescription>
            </DialogHeader>
            <PostPicker candidates={candidates} query={query} onQueryChange={setQuery} onPick={setTarget} />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                Merge #{post.number} into #{target.number}?
              </DialogTitle>
              <DialogDescription>
                “{post.title}” will be merged into “{target.title}”. Its votes (counted once per person) and comments
                move over, and its link will point to #{target.number}. This can&apos;t be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTarget(undefined)} disabled={pending}>
                Back
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await mergePost(projectSlug, post.id, target.id);
                    if (result.error) {
                      toast.error(result.error);
                      return;
                    }
                    toast.success(`Merged into #${target.number}`);
                    close(false);
                    router.push(`/app/${projectSlug}/p/${target.number}`);
                  })
                }
              >
                Merge
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
