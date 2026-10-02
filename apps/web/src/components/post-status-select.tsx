"use client";

import type { PostStatus } from "@tuti/db";
import { cn } from "cn";
import { useTransition } from "react";
import { toast } from "sonner";

import { STATUS_LABELS } from "@/components/post-status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { changePostStatus } from "@/server/manage-posts";

const STATUSES = Object.keys(STATUS_LABELS) as PostStatus[];

/** Team-only: shows a post's status and changes it. */
export function PostStatusSelect({
  projectSlug,
  postId,
  status,
  className,
}: {
  projectSlug: string;
  postId: string;
  status: PostStatus;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Select
      items={STATUS_LABELS}
      value={status}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const result = await changePostStatus(projectSlug, postId, String(value));
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Status: ${STATUS_LABELS[value as PostStatus]}`);
          }
        })
      }
    >
      <SelectTrigger size="sm" className={cn("w-36", className)} aria-label="Status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {STATUS_LABELS[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
