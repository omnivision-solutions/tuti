"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { analyseCodeChange, applyCodeChange, applyLikelyCodeChanges, dismissCodeChange } from "@/server/code-changes";
import type { CodeChangeDetail } from "@/server/operations/code-changes";

/** "Analyse anyway" (nothing to do) or "Analyse again" (failed). */
export function AnalyseCodeChangeButton({ projectSlug, codeChangeId, label }: { projectSlug: string; codeChangeId: string; label: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await analyseCodeChange(projectSlug, codeChangeId);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Analysed");
          }
        })
      }
    >
      {pending ? "Analysing…" : label}
    </Button>
  );
}

/** "Apply likely": every waiting feedback proposal Tuti is confident about, after asking. */
export function ApplyLikelyButton({ projectSlug, codeChangeId, count }: { projectSlug: string; codeChangeId: string; count: number }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        Apply likely ({count})
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Apply {count === 1 ? "the likely proposal" : `${count} likely proposals`}?</AlertDialogTitle>
          <AlertDialogDescription>
            Posts it resolves are completed and the people who asked for them get an email. Comments are posted as you.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await applyLikelyCodeChanges(projectSlug, codeChangeId);
                setOpen(false);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success("Applied");
                }
              })
            }
          >
            Apply
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Action = CodeChangeDetail["actions"][number];

const KIND_LABELS: Record<string, string> = { resolves: "Resolves", moves_forward: "Moves forward", links: "Related" };
/** What applying does, named. */
const APPLY_LABELS: Record<string, string> = { resolves: "Mark completed", moves_forward: "Post comment", links: "Link" };
const STATUS_LABELS: Record<string, string> = { open: "Open", under_review: "Under review", planned: "Planned", in_progress: "In progress", completed: "Completed", closed: "Closed" };

/** One proposal about a post: what Tuti proposes and why, with apply and dismiss (or who did, once decided). */
export function PostProposal({ projectSlug, action }: { projectSlug: string; action: Action }) {
  const [pending, startTransition] = useTransition();
  const [comment, setComment] = useState(action.comment ?? "");
  const [reason, setReason] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const post = action.post!;
  const waiting = action.status === "pending";

  const apply = () =>
    startTransition(async () => {
      const result = await applyCodeChange(projectSlug, action.id, action.kind === "moves_forward" ? comment : undefined);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(action.kind === "resolves" ? `#${post.number} completed` : action.kind === "moves_forward" ? `Comment posted on #${post.number}` : `Linked to #${post.number}`);
      }
    });
  const dismiss = () =>
    startTransition(async () => {
      const result = await dismissCodeChange(projectSlug, action.id, reason);
      if (result.error) {
        toast.error(result.error);
      } else {
        setDismissing(false);
        toast.success("Dismissed");
      }
    });

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={`${KIND_LABELS[action.kind]}: ${post.title}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/app/${projectSlug}/p/${post.number}`} className="min-w-0 text-sm font-medium break-words hover:underline">
              {post.title}
            </Link>
            <Badge variant={action.kind === "resolves" ? "default" : action.kind === "moves_forward" ? "soft" : "outline"}>{KIND_LABELS[action.kind]}</Badge>
            {waiting && <Badge variant={action.confidence === "likely" ? "secondary" : "outline"}>{action.confidence === "likely" ? "Likely" : "Maybe"}</Badge>}
          </div>
          <span className="text-xs text-muted-foreground">
            #{post.number} · {post.votes} {post.votes === 1 ? "vote" : "votes"} · {STATUS_LABELS[post.status]}
          </span>
        </div>
        {waiting && (
          <div className="flex shrink-0 items-center gap-2">
            <Popover open={dismissing} onOpenChange={setDismissing}>
              <PopoverTrigger render={<Button variant="ghost" size="sm" disabled={pending} />}>Dismiss</PopoverTrigger>
              <PopoverContent className="flex w-72 flex-col gap-2">
                <Input
                  aria-label="Why not? (optional)"
                  placeholder="Why not? (optional)"
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.currentTarget.value)}
                />
                <Button size="sm" className="self-end" disabled={pending} onClick={dismiss}>
                  Dismiss
                </Button>
              </PopoverContent>
            </Popover>
            <Button size="sm" disabled={pending || (action.kind === "moves_forward" && !comment.trim())} onClick={apply}>
              {APPLY_LABELS[action.kind]}
            </Button>
          </div>
        )}
      </div>
      {action.reason && <p className="text-sm text-muted-foreground">{action.reason}</p>}
      {action.kind === "moves_forward" &&
        (waiting ? (
          <Textarea aria-label={`Comment on #${post.number}`} value={comment} maxLength={5000} onChange={(event) => setComment(event.currentTarget.value)} />
        ) : (
          action.status === "applied" && <p className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{comment}</p>
        ))}
      {!waiting && (
        <span className="text-xs text-muted-foreground">
          {action.status === "applied" ? "Applied" : action.status === "dismissed" ? "Dismissed" : "Out of date"}
          {action.decidedBy && ` by ${action.decidedBy}`}
          {action.dismissReason && `: ${action.dismissReason}`}
        </span>
      )}
    </li>
  );
}
