"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { movePost } from "@/server/manage-posts";

/** Team-only: shows a post's board and moves it to another one. */
export function MovePostSelect({
  projectSlug,
  postId,
  boardSlug,
  boards,
}: {
  projectSlug: string;
  postId: string;
  boardSlug: string;
  boards: { slug: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const labels = Object.fromEntries(boards.map((b) => [b.slug, b.name]));

  return (
    <Select
      items={labels}
      value={boardSlug}
      disabled={pending || boards.length < 2}
      onValueChange={(value) =>
        startTransition(async () => {
          const target = String(value);
          const result = await movePost(projectSlug, postId, target);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Moved to ${labels[target]}`);
          }
        })
      }
    >
      <SelectTrigger size="sm" className="max-w-40" aria-label="Board">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {boards.map((board) => (
          <SelectItem key={board.slug} value={board.slug}>
            {board.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
