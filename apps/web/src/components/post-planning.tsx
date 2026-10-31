"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setPostEta, setPostOwner } from "@/server/manage-posts";

/** "*" can't be a user's id: it stands for nobody. */
const NOBODY = "*";

/** Team-only: who on the team looks after a post, saved as it's picked. */
export function PostOwnerSelect({ projectSlug, postId, ownerId, team }: { projectSlug: string; postId: string; ownerId: string | null; team: { id: string; name: string }[] }) {
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
      <SelectTrigger size="sm" className="w-full" aria-label="Owner">
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
  const label = (value: string) => new Date(`${value}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return { [NO_ETA]: "No ETA", ...Object.fromEntries(values.map((value) => [value, label(value)])) };
}

/** Team-only: the month the team expects a post, picked from the next two years and saved as it's picked. */
export function PostEtaSelect({ projectSlug, postId, eta }: { projectSlug: string; postId: string; eta: string | null }) {
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
            toast.success(month === null ? "No ETA" : `ETA: ${items[month]}`);
          }
        })
      }
    >
      <SelectTrigger size="sm" className="w-full" aria-label="ETA">
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
