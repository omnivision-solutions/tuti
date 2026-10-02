"use client";

import { MergeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { mergePost } from "@/server/manage-posts";

type Candidate = { id: string; number: number; title: string; voteCount: number };

/** Team-only: pick the original post and merge this one into it. */
export function MergePostDialog({
  projectSlug,
  post,
  candidates,
}: {
  projectSlug: string;
  post: { id: string; number: number; title: string };
  candidates: Candidate[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Candidate>();
  const [pending, startTransition] = useTransition();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return candidates
      .filter((c) => !q || c.title.toLowerCase().includes(q) || String(c.number) === q)
      .slice(0, 50);
  }, [candidates, query]);

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
            <Input
              autoFocus
              placeholder="Search by title or #number"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search posts"
            />
            <ul className="-mx-2 max-h-72 overflow-y-auto">
              {matches.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setTarget(c)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="w-10 shrink-0 text-muted-foreground tabular-nums">#{c.number}</span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.voteCount} votes</span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">No matching posts.</li>}
            </ul>
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
