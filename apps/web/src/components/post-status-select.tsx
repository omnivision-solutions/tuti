"use client";

import type { PostStatus } from "@tuti/db";
import { cn } from "cn";
import { ChevronDownIcon, EllipsisIcon } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { errorMessage, useInOrder, useTRPCClient } from "@/components/trpc";
import { statusPrompt } from "@/lib/status-prompt";

const STATUSES = Object.keys(STATUS_LABELS) as PostStatus[];

/** A post being moved: its title, and how many people who asked for it each move that emails reaches (emailedOnMoves). */
export type Completing = { title: string; emails: Partial<Record<PostStatus, number>> };

/**
 * Saves a post's status: posts.update, the one operation the roadmap, Feedback's list and a post's page change it with,
 * in the page's order (useInOrder: tRPC calls don't wait for each other, as server actions did), then the page again.
 * Nothing, or what it was refused with.
 */
export function useSavePostStatus(projectSlug: string) {
  const client = useTRPCClient();
  const inOrder = useInOrder();
  const router = useRouter();
  return (number: number, status: PostStatus): Promise<{ error?: string }> =>
    inOrder(() => client.posts.update.mutate({ project: projectSlug, number, status: status.toLowerCase() as Lowercase<PostStatus> })).then(
      () => {
        router.refresh();
        return {};
      },
      (error: unknown) => ({ error: errorMessage(error) }),
    );
}

/**
 * A post's status change, a move that emails its people asked about first when `completing` says how many (statusPrompt;
 * the roadmap asks for its own, onAsk): `pick` takes the status chosen, `asking` holds it until it's confirmed or cancelled.
 */
function useStatusChange(projectSlug: string, number: number, status: PostStatus, completing?: Completing, onChanged?: (status: PostStatus) => void) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState<{ status: PostStatus; prompt: string } | null>(null);
  const save = useSavePostStatus(projectSlug);
  const change = (value: PostStatus) =>
    startTransition(async () => {
      const result = await save(number, value);
      setAsking(null);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`Status: ${STATUS_LABELS[value]}`);
        onChanged?.(value);
      }
    });
  const pick = (value: PostStatus) => {
    const prompt = completing && statusPrompt(status, value, completing.emails);
    return prompt ? setAsking({ status: value, prompt }) : change(value);
  };
  // Kept while the dialog closes, so its words don't change as it fades.
  const [shown, setShown] = useState(asking);
  if (asking && asking !== shown) {
    setShown(asking);
  }
  const label = shown && STATUS_LABELS[shown.status].toLowerCase();
  const ask = completing && (
    <AlertDialog open={asking !== null} onOpenChange={(open) => !open && !pending && setAsking(null)}>
      <AlertDialogContent closeDisabled={pending}>
        <AlertDialogHeader>
          <AlertDialogTitle className="wrap-anywhere">
            Mark “{completing.title}” {label}?
          </AlertDialogTitle>
          <AlertDialogDescription>{shown?.prompt}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} focusableWhenDisabled onClick={() => shown && change(shown.status)}>
            Mark {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { pending, pick, ask };
}

/** Team-only: shows a post's status and changes it. With `completing`, a move that emails people asks first, saying how many. */
export function PostStatusSelect({
  projectSlug,
  number,
  status,
  completing,
  className,
}: {
  projectSlug: string;
  /** The post's number. */
  number: number;
  status: PostStatus;
  completing?: Completing;
  className?: string;
}) {
  const { pending, pick, ask } = useStatusChange(projectSlug, number, status, completing);

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
 * Team-only, for lists: the status as its badge, which opens a menu to change it. A move that emails people asks first
 * with `completing`, or goes to `onAsk` for the list to ask (true when it does); `onChanged` hears each change saved.
 * With `badge={false}`, where the list already says the status (a roadmap column), a small button opens the menu instead.
 */
export function PostStatusMenu({
  projectSlug,
  number,
  status,
  completing,
  onAsk,
  onChanged,
  badge = true,
}: {
  projectSlug: string;
  /** The post's number. */
  number: number;
  status: PostStatus;
  completing?: Completing;
  onAsk?: (status: PostStatus) => boolean;
  onChanged?: (status: PostStatus) => void;
  badge?: boolean;
}) {
  const { pending, pick, ask } = useStatusChange(projectSlug, number, status, completing, onChanged);

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
            onValueChange={(value) => {
              if (!onAsk?.(value as PostStatus)) pick(value as PostStatus);
            }}
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
