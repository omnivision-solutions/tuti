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
 * is left (typing a year passes through ones that aren't, and a browser without a month picker is a
 * text box); Clear says none.
 */
export function PostEtaInput({ projectSlug, postId, eta }: { projectSlug: string; postId: string; eta: string | null }) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(eta ?? "");
  const [saved, setSaved] = useState(eta ?? "");
  const save = (month: string) => {
    if (month === saved) {
      return;
    }
    if (month !== "" && !/^\d{4}-\d{2}$/.test(month)) {
      toast.error("Say the month as 2026-12");
      return;
    }
    startTransition(async () => {
      const result = await setPostEta(projectSlug, postId, month === "" ? null : month);
      if (result.error) {
        toast.error(result.error);
        setValue(saved);
      } else {
        setSaved(month);
        setValue(month);
        toast.success(month === "" ? "No ETA" : "ETA saved");
      }
    });
  };
  return (
    <div className="flex items-center gap-1">
      <Input
        type="month"
        aria-label="ETA"
        placeholder="2026-12"
        className="h-8"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => save(value)}
        onKeyDown={(event) => event.key === "Enter" && save(value)}
      />
      {value && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => save("")}>
          Clear
        </Button>
      )}
    </div>
  );
}
