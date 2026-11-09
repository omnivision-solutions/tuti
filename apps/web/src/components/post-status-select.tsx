"use client";

import type { PostStatus } from "@tuti/db";
import { cn } from "cn";
import { ChevronDownIcon, EllipsisIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { PostStatusBadge, STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { changePostStatus } from "@/server/manage-posts";

const STATUSES = Object.keys(STATUS_LABELS) as PostStatus[];

/** A post being completed: its title, and how many people who asked for it that emails (emailedOnCompletion). */
export type Completing = { title: string; emails: number };

/**
 * A post's status change, Completed asked about first when `completing` says who it emails (as the roadmap
 * does): `pick` takes the status chosen, `asking` holds Completed until it's confirmed or cancelled.
 */
function useStatusChange(projectSlug: string, postId: string, status: PostStatus, completing?: Completing, onChanged?: (status: PostStatus) => void) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const change = (value: PostStatus) =>
    startTransition(async () => {
      const result = await changePostStatus(projectSlug, postId, value);
      setAsking(false);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`Status: ${STATUS_LABELS[value]}`);
        onChanged?.(value);
      }
    });
  const pick = (value: PostStatus) => (value === "COMPLETED" && status !== "COMPLETED" && completing ? setAsking(true) : change(value));
  const ask = completing && (
    <AlertDialog open={asking} onOpenChange={(open) => !open && !pending && setAsking(false)}>
      <AlertDialogContent closeDisabled={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">Mark “{completing.title}” completed?</AlertDialogTitle>
          <AlertDialogDescription>
            {completing.emails
              ? `This emails up to ${completing.emails} ${completing.emails === 1 ? "person" : "people"} who asked for it that it shipped.`
              : "Nobody is emailed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={() => change("COMPLETED")}>
            Mark completed
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { pending, pick, ask };
}

/** Team-only: shows a post's status and changes it. With `completing`, Completed asks first, saying who it emails. */
export function PostStatusSelect({
  projectSlug,
  postId,
  status,
  completing,
  className,
}: {
  projectSlug: string;
  postId: string;
  status: PostStatus;
  completing?: Completing;
  className?: string;
}) {
  const { pending, pick, ask } = useStatusChange(projectSlug, postId, status, completing);

  return (
    <>
      {ask}
      <Select
        items={STATUS_LABELS}
        value={status}
        disabled={pending}
        onValueChange={(value) => pick(value as PostStatus)}
      >
        <SelectTrigger size="sm" className={cn("w-36", className)} aria-label="Status">
          {/* Its colour dot before it, as in the menus and the status pill. */}
          <SelectValue>
            {(value: PostStatus) => (
              <>
                <StatusDot status={value} />
                {STATUS_LABELS[value]}
              </>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              <StatusDot status={s} />
              {STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

/**
 * Team-only, for lists: the status as its badge, which opens a menu to change it. Completed (which emails
 * people) asks first with `completing`, or goes to `onComplete` for the list to ask; `onChanged` hears each change saved.
 * With `badge={false}`, where the list already says the status (a roadmap column), a small button opens the menu instead.
 */
export function PostStatusMenu({
  projectSlug,
  postId,
  status,
  completing,
  onComplete,
  onChanged,
  badge = true,
}: {
  projectSlug: string;
  postId: string;
  status: PostStatus;
  completing?: Completing;
  onComplete?: () => void;
  onChanged?: (status: PostStatus) => void;
  badge?: boolean;
}) {
  const { pending, pick, ask } = useStatusChange(projectSlug, postId, status, completing, onChanged);

  return (
    <>
      {ask}
      <DropdownMenu>
        {badge ? (
          <DropdownMenuTrigger
            disabled={pending}
            aria-label={`Status: ${STATUS_LABELS[status]}`}
            className="group/status shrink-0 cursor-pointer rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
          >
            {/* The chevron says it's a menu. */}
            <span className="inline-flex items-center gap-0.5">
              <PostStatusBadge status={status} />
              <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
            </span>
          </DropdownMenuTrigger>
        ) : (
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" disabled={pending} focusableWhenDisabled aria-label={`Status: ${STATUS_LABELS[status]}`} title="Change status" className="text-muted-foreground" />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
        )}
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuRadioGroup
            value={status}
            onValueChange={(value) => (value === "COMPLETED" && onComplete ? onComplete() : pick(value as PostStatus))}
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
    </>
  );
}
