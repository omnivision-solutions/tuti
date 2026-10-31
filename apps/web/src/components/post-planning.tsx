"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/**
 * Team-only: the month the team expects a post ("2026-12"). Saved once it's a whole month, as the field
 * is left or with Enter (typing a year passes through ones that aren't, and a browser without a month
 * picker is a text box); one save at a time. Left half-typed (blank to a month input), nothing changes:
 * only Clear says none. Follows what's saved when the page reloads (a teammate may have changed it).
 */
export function PostEtaInput({ projectSlug, postId, eta }: { projectSlug: string; postId: string; eta: string | null }) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(eta ?? "");
  const [shown, setShown] = useState(eta);
  // A new value from the server (a reload after someone's change): shown, unless one's being typed.
  if (eta !== shown) {
    setShown(eta);
    setValue(eta ?? "");
  }
  const save = (month: string | null) => {
    if (pending || month === (eta ?? null)) {
      return;
    }
    if (month !== null && !/^\d{4}-\d{2}$/.test(month)) {
      toast.error("Say the month as 2026-12");
      return;
    }
    startTransition(async () => {
      const result = await setPostEta(projectSlug, postId, month);
      if (result.error) {
        toast.error(result.error);
        setValue(eta ?? "");
      } else {
        toast.success(month === null ? "No ETA" : "ETA saved");
      }
    });
  };
  // Blank is a month half-typed, or a field emptied: put back what's saved; Clear is how to say none.
  const commit = () => (value === "" ? setValue(eta ?? "") : save(value));
  return (
    <div className="flex items-center gap-1">
      <Input
        type="month"
        aria-label="ETA"
        placeholder="2026-12"
        className="h-8"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && commit()}
      />
      {eta && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => save(null)}>
          Clear
        </Button>
      )}
    </div>
  );
}
