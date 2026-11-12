"use client";

import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";

import { etaToast, formatMonth } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setPostEta, setPostOwner, setPostVisibility } from "@/server/manage-posts";
import { POST_VISIBILITIES, VISIBILITY_DESCRIPTIONS, VISIBILITY_LABELS } from "@/lib/visibility-labels";
import type { PostVisibility } from "@tuti/db";

/** "*" can't be a user's id: it stands for nobody. */
const NOBODY = "*";

/** Team-only: who on the team looks after a post, saved as it's picked. */
export function PostOwnerSelect({ projectSlug, postId, ownerId, team, className }: { projectSlug: string; postId: string; ownerId: string | null; team: { id: string; name: string }[]; className?: string }) {
  const [pending, startTransition] = useTransition();
  const items: Record<string, string> = { [NOBODY]: "Nobody", ...Object.fromEntries(team.map((member) => [member.id, member.name])) };
  return (
    <Select
      items={items}
      value={ownerId ?? NOBODY}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const id = value === NOBODY ? null : String(value);
          const result = await setPostOwner(projectSlug, postId, id);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(id === null ? "Nobody owns it now" : `Owner: ${items[id]}`);
          }
        })
      }
    >
      <SelectTrigger size="sm" className={cn("w-full", className)} aria-label="Owner">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(items).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** "none" can't be a month: it stands for no ETA. */
const NO_ETA = "none";

/**
 * This month and the next 23 (and `keep`, a month already saved outside them), as "2026-12" → "December 2026":
 * in UTC and English, as dates are shown everywhere (see formatDate), so the server's render and the browser's agree.
 */
function months(keep: string | null): Record<string, string> {
  const now = new Date();
  const values = Array.from({ length: 24 }, (_, i) => {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    return month.toISOString().slice(0, 7);
  });
  if (keep && !values.includes(keep)) {
    values.unshift(keep);
  }
  const label = (value: string) => formatMonth(new Date(`${value}-01T00:00:00Z`));
  return { [NO_ETA]: "No ETA", ...Object.fromEntries(values.map((value) => [value, label(value)])) };
}

/** The month the team expects a post (shown on the portal's post), picked from the next two years and saved as it's picked. */
export function PostEtaSelect({ projectSlug, postId, eta, status, className }: { projectSlug: string; postId: string; eta: string | null; status: string; className?: string }) {
  const [pending, startTransition] = useTransition();
  const items = months(eta);
  return (
    <Select
      items={items}
      value={eta ?? NO_ETA}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const month = value === NO_ETA ? null : String(value);
          const result = await setPostEta(projectSlug, postId, month);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(month === null ? "No ETA" : etaToast(month, status));
          }
        })
      }
    >
      <SelectTrigger size="sm" className={cn("w-full", className)} aria-label="ETA">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(items).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Who sees a post besides the team, saved as it's picked; its votes and comments go with it. */
export function PostVisibilitySelect({
  projectSlug,
  postId,
  visibility,
  boardOff = false,
  className,
  quietHint = false,
}: {
  projectSlug: string;
  postId: string;
  visibility: PostVisibility;
  boardOff?: boolean;
  className?: string;
  /** What it means read out and on hover only (a row of properties), not under it. */
  quietHint?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <Select
        items={VISIBILITY_LABELS}
        value={visibility}
        disabled={pending}
        onValueChange={(value) =>
          startTransition(async () => {
            const picked = value as PostVisibility;
            const result = await setPostVisibility(projectSlug, postId, picked.toLowerCase());
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success(`Visibility: ${VISIBILITY_LABELS[picked]}`);
            }
          })
        }
      >
        <SelectTrigger
          size="sm"
          className={cn("w-full", className)}
          aria-label="Visibility"
          aria-describedby={`visibility-${postId}`}
          title={quietHint ? (boardOff ? "Its board is off, so only the team sees it until the board is turned on." : VISIBILITY_DESCRIPTIONS[visibility]) : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {POST_VISIBILITIES.map((value) => (
            <SelectItem key={value} value={value}>
              {VISIBILITY_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`visibility-${postId}`} className={quietHint ? "sr-only" : "text-xs text-muted-foreground"}>
        {/* Its board turned off (Board.off): only the team sees it for now, whatever it's set to. */}
        {boardOff ? "Its board is off, so only the team sees it until the board is turned on." : VISIBILITY_DESCRIPTIONS[visibility]}
      </p>
    </div>
  );
}

/**
 * In a narrow post pane (`@container/post`), a post's properties folded to one line (`summary`: its status, owner and
 * ETA) that opens them; at 56rem and up, beside the post, they're always open and the line isn't there.
 */
export function PhoneFold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide properties" : "Show properties"}
        onClick={() => setOpen(!open)}
        className="-mx-1 flex min-h-9 items-center gap-2 rounded-lg px-1 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 @min-[56rem]/post:hidden"
      >
        {summary}
        <ChevronDownIcon aria-hidden className={cn("ml-auto size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      <div className={cn("flex flex-col gap-1", open ? "@max-[56rem]/post:mt-2 @max-[56rem]/post:border-t @max-[56rem]/post:pt-2" : "@max-[56rem]/post:hidden")}>{children}</div>
    </>
  );
}
