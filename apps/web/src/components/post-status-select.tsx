"use client";

import type { PostStatus } from "@tuti/db";
import { cn } from "cn";
import { useTransition } from "react";
import { toast } from "sonner";

import { PostStatusBadge, STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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

/** Team-only, for lists: the status as its badge, which opens a menu to change it. */
export function PostStatusMenu({ projectSlug, postId, status }: { projectSlug: string; postId: string; status: PostStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        aria-label={`Status: ${STATUS_LABELS[status]}`}
        className="shrink-0 cursor-pointer rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
      >
        <PostStatusBadge status={status} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuRadioGroup
          value={status}
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
          {STATUSES.map((s) => (
            <DropdownMenuRadioItem key={s} value={s} closeOnClick>
              <StatusDot status={s} />
              {STATUS_LABELS[s]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
