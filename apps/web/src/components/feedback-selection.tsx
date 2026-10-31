"use client";

import type { PostStatus } from "@tuti/db";
import { ChevronDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, use, useState, useTransition } from "react";
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
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { eachPost } from "@/lib/each-post";
import { changePostStatus, mergePost, movePost } from "@/server/manage-posts";

/** A post as the selection keeps it: enough to name it and pick which one stays in a merge. */
type Picked = { id: string; number: number; title: string; voteCount: number };

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

/** A row's checkbox, to pick its post. */
export function SelectPost({ post }: { post: Picked }) {
  const { picked, toggle, pending } = useSelection();
  return (
    <input
      type="checkbox"
      disabled={pending}
      aria-label={`Select ${post.title}`}
      checked={picked.some((p) => p.id === post.id)}
      onChange={(event) => toggle(post, event.currentTarget.checked)}
      className="size-4 shrink-0 accent-primary"
    />
  );
}

const STATUSES = Object.keys(STATUS_LABELS) as PostStatus[];

/**
 * What can be done to the picked posts, once some are: Set status (Completed asks first: it emails their
 * voters), Move to board, Merge (into the one kept, the most voted for by default), Clear. Each post is done
 * as on its own; what fails is said and the rest still go.
 */
export function FeedbackBulk({ projectSlug, boards }: { projectSlug: string; boards: { slug: string; name: string }[] }) {
  const { picked, clear, pending, startTransition } = useSelection();
  const router = useRouter();
  const [completing, setCompleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [keep, setKeep] = useState<string | null>(null);
  if (picked.length === 0) {
    return null;
  }
  const count = `${picked.length} ${picked.length === 1 ? "post" : "posts"}`;

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

  return (
    <div role="toolbar" aria-label="Selected posts" className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
      <span className="font-medium">{picked.length} selected</span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
          Set status
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
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
          Move to board
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
      {picked.length > 1 && (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            // The most voted for, each time it opens.
            setKeep(null);
            setMerging(true);
          }}
        >
          Merge…
        </Button>
      )}
      <Button variant="ghost" size="sm" disabled={pending} onClick={clear} className="ml-auto">
        Clear
      </Button>

      <AlertDialog open={completing} onOpenChange={setCompleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {count} as Completed?</AlertDialogTitle>
            <AlertDialogDescription>Everyone who voted for them is emailed that it shipped, as when one post is completed.</AlertDialogDescription>
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
              Mark Completed
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={merging} onOpenChange={setMerging}>
        <AlertDialogContent>
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
  );
}
