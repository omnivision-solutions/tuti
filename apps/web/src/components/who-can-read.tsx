"use client";

import Link from "next/link";
import { useState } from "react";

import type { Access } from "@/lib/read-access";

export type GroupOption = { key: string; name: string };

/**
 * "Who can read" a tab, collection or article, as form fields (`access`, and `groups` for the ticked
 * groups): inherit (`inherit` says from what, and what that allows), signed-in readers, or groups
 * picked from the project's. The groups' ticks stay while another choice is picked; the server
 * action sends them only with "Specific groups".
 */
export function WhoCanRead({
  id,
  projectSlug,
  groups,
  inherit,
  defaultAccess = "inherit",
  defaultGroups = [],
}: {
  /** Unique on the page, for the fields' ids. */
  id: string;
  projectSlug: string;
  /** The project's reader groups to pick from. */
  groups: GroupOption[];
  /** The first choice: its name ("Inherit", "Inherit from Billing") and who the level above lets read ("Anyone can read it"). */
  inherit: { label: string; description: string };
  defaultAccess?: Access;
  defaultGroups?: string[];
}) {
  const [access, setAccess] = useState<Access>(defaultAccess);
  const choices: [Access, string, string][] = [
    ["inherit", inherit.label, inherit.description],
    ["signed_in", "Signed-in readers", "Readers must sign in to read it"],
    ["groups", "Specific groups", "Only readers in the groups you pick"],
  ];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Who can read</legend>
      {choices.map(([value, label, description]) => (
        <label
          key={value}
          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name="access"
            value={value}
            checked={access === value}
            onChange={() => setAccess(value)}
            aria-labelledby={`${id}-${value}-label`}
            aria-describedby={`${id}-${value}-description`}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span id={`${id}-${value}-label`} className="font-medium break-words">
              {label}
            </span>
            <span id={`${id}-${value}-description`} className="break-words text-muted-foreground">
              {description}
            </span>
          </span>
        </label>
      ))}
      <div hidden={access !== "groups"} className="pl-7">
        {groups.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Groups</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {groups.map((group) => (
                <label key={group.key} className="flex items-center gap-2 text-sm break-words">
                  <input type="checkbox" name="groups" value={group.key} defaultChecked={defaultGroups.includes(group.key)} className="size-4 accent-primary" />
                  {group.name}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">With none ticked, only your team can read it.</p>
          </fieldset>
        ) : (
          <p className="text-sm text-muted-foreground">
            You don&apos;t have any groups yet.{" "}
            <Link href={`/app/${projectSlug}/settings#groups`} className="text-primary underline underline-offset-4">
              Create one
            </Link>
          </p>
        )}
      </div>
    </fieldset>
  );
}
