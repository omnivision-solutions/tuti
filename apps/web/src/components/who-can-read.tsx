"use client";

import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { SettingBlock, SettingRow } from "@/components/settings-card";
import { buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Access, ANYONE, type WithoutAccess } from "@/lib/read-access";

export type GroupOption = { key: string; name: string };
export type ReadAccessDraft = { access: Access; groups: string[]; noAccess: WithoutAccess };

/**
 * "Who can read" a tab, collection or article, as form fields (`access`, and `groups` for the ticked
 * groups): inherit (`inherit` says from what, and what that allows), signed-in readers, or groups
 * picked from the project's. The groups' ticks stay while another choice is picked; the server
 * action sends them only with "Specific groups". Then, when some people can't read it, "People
 * without access" (`noAccess`): inherit, shown with a lock, or hidden, with "Preview as a reader".
 */
export function WhoCanRead({
  id,
  projectSlug,
  groups,
  inherit,
  defaultAccess = "inherit",
  defaultGroups = [],
  defaultNoAccess = "inherit",
  preview,
  rows = false,
  control,
}: {
  /** Unique on the page, for the fields' ids. */
  id: string;
  projectSlug: string;
  /** The project's reader groups to pick from. */
  groups: GroupOption[];
  /**
   * The first choices: their name ("Inherit", "Inherit from Billing"), who the level above lets read
   * ("Anyone can read it"), and what it shows the rest (AccessChoices' `shows`).
   */
  inherit: { label: string; description: string; shows: "lock" | "hide" };
  defaultAccess?: Access;
  defaultGroups?: string[];
  defaultNoAccess?: WithoutAccess;
  /** The page on the portal, for "Preview as a reader" (none for a page that isn't there yet). */
  preview?: string;
  /** In a settings card (SettingsCard): a row each, the choices as dropdowns, in place of the radios. */
  rows?: boolean;
  /** A parent that survives a panel moving between layouts can own the unsaved choices. */
  control?: { value: ReadAccessDraft; onChange: (value: ReadAccessDraft) => void };
}) {
  const [ownAccess, setOwnAccess] = useState<Access>(defaultAccess);
  const [ownNoAccess, setOwnNoAccess] = useState<WithoutAccess>(defaultNoAccess);
  const access = control?.value.access ?? ownAccess;
  const noAccess = control?.value.noAccess ?? ownNoAccess;
  // The ticked groups, where the rows own them (the radios' boxes keep their own).
  const [ownGroups, setOwnGroups] = useState(defaultGroups);
  const setAccess = (access: Access) => control ? control.onChange({ ...control.value, access }) : setOwnAccess(access);
  const setNoAccess = (noAccess: WithoutAccess) => control ? control.onChange({ ...control.value, noAccess }) : setOwnNoAccess(noAccess);
  const choices: [Access, string, string][] = [
    ["inherit", inherit.label, inherit.description],
    ["signed_in", "Signed-in readers", "Readers must sign in to read it"],
    ["groups", "Specific groups", "Only readers in the groups you pick"],
  ];
  const noAccessChoices: [WithoutAccess, string, string][] = [
    [
      "inherit",
      inherit.label,
      inherit.shows === "lock"
        ? "Shown with a lock, like what it's in"
        : "Hidden (the default)",
    ],
    [
      "lock",
      "Show with a lock",
      "Its title is listed with a lock. Opening it asks them to sign in, or says they don't have access, never showing the content.",
    ],
    [
      "hide",
      "Hide",
      "It isn't listed, and its link says the page wasn't found.",
    ],
  ];
  // Only for a page some people can't read.
  const forSome = access !== "inherit" || inherit.description !== ANYONE;
  if (rows) {
    const ticked = control?.value.groups ?? ownGroups;
    const setTicked = (groups: string[]) => (control ? control.onChange({ ...control.value, groups }) : setOwnGroups(groups));
    return (
      <>
        <SettingRow label="Who can read" htmlFor={`${id}-access`} description={choices.find(([choice]) => choice === access)?.[2]}>
          <Picker id={`${id}-access`} name="access" choices={choices} value={access} onChange={setAccess} />
        </SettingRow>
        {access === "groups" ? (
          <SettingBlock className="gap-2">
            {groups.length > 0 ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">Groups</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  {groups.map((group) => (
                    <label key={group.key} className="flex min-h-8 items-center gap-2 text-sm break-words">
                      <input
                        type="checkbox"
                        name="groups"
                        value={group.key}
                        checked={ticked.includes(group.key)}
                        onChange={(event) => setTicked(event.target.checked ? [...ticked, group.key] : ticked.filter((key) => key !== group.key))}
                        className="size-4 accent-primary"
                      />
                      {group.name}
                    </label>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">With none ticked, only your team can read it.</p>
              </fieldset>
            ) : (
              <p className="text-sm text-muted-foreground">
                You don&apos;t have any groups yet.{" "}
                <Link href={`/app/${projectSlug}/settings/groups`} className="text-primary underline underline-offset-4">
                  Create one
                </Link>
              </p>
            )}
          </SettingBlock>
        ) : (
          // The ticks stay while another choice is picked, and are sent as the boxes were.
          ticked.map((key) => <input key={key} type="hidden" name="groups" value={key} />)
        )}
        {forSome ? (
          <SettingRow
            label="People without access"
            htmlFor={`${id}-no-access`}
            description={noAccess === "inherit" ? noAccessChoices[0]![2] : undefined}
            info={
              <>
                <b>Show with a lock:</b> {noAccessChoices[1]![2]}
                <br />
                <b>Hide:</b> {noAccessChoices[2]![2]}
              </>
            }
          >
            <Picker id={`${id}-no-access`} name="noAccess" choices={noAccessChoices} value={noAccess} onChange={setNoAccess} />
          </SettingRow>
        ) : (
          // Its choice is still sent, so it's kept for when it's for some people again.
          <input type="hidden" name="noAccess" value={noAccess} />
        )}
        {forSome && preview && (
          <SettingRow inline label={<span id={`${id}-preview-label`}>View as a reader</span>} description="See it signed out">
            <a
              id={`${id}-preview`}
              href={preview}
              target="_blank"
              rel="noreferrer"
              aria-labelledby={`${id}-preview ${id}-preview-label`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open
              <ExternalLinkIcon aria-hidden />
            </a>
          </SettingRow>
        )}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Choices
        id={id}
        legend="Who can read"
        name="access"
        choices={choices}
        value={access}
        onChange={setAccess}
      >
        <div hidden={access !== "groups"} className="pl-7">
          {groups.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Groups</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {groups.map((group) => (
                  <label
                    key={group.key}
                    className="flex items-center gap-2 text-sm break-words"
                  >
                    <input
                      type="checkbox"
                      name="groups"
                      value={group.key}
                      {...(control ? {
                        checked: control.value.groups.includes(group.key),
                        onChange: (event) => control.onChange({ ...control.value, groups: event.target.checked ? [...control.value.groups, group.key] : control.value.groups.filter((key) => key !== group.key) }),
                      } : { defaultChecked: defaultGroups.includes(group.key) })}
                      className="size-4 accent-primary"
                    />
                    {group.name}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                With none ticked, only your team can read it.
              </p>
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">
              You don&apos;t have any groups yet.{" "}
              <Link
                href={`/app/${projectSlug}/settings/groups`}
                className="text-primary underline underline-offset-4"
              >
                Create one
              </Link>
            </p>
          )}
        </div>
      </Choices>
      {/* Hidden, its choice is still sent, so it's kept for when it's for some people again. */}
      <div hidden={!forSome}>
        <Choices
          id={`${id}-no-access`}
          legend="People without access"
          name="noAccess"
          choices={noAccessChoices}
          value={noAccess}
          onChange={setNoAccess}
        >
          {preview && (
            <p className="text-sm text-muted-foreground">
              <a
                href={preview}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary underline underline-offset-4"
              >
                Preview as a reader
                <ExternalLinkIcon aria-hidden className="size-3.5" />
              </a>{" "}
              opens its page on your portal as people signed out see it.
            </p>
          )}
        </Choices>
      </div>
    </div>
  );
}

/** A row's dropdown of `choices` (a form field, `name`), named by the row's label and described by its line. */
function Picker<T extends string>({ id, name, choices, value, onChange }: { id: string; name: string; choices: [T, string, string][]; value: T; onChange: (value: T) => void }) {
  const items = choices.map(([choice, label]) => ({ value: choice, label }));
  return (
    <Select name={name} items={items} value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger id={id} aria-describedby={`${id}-description`} className="w-full @min-[34rem]/settings:w-60">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Radio cards: one choice each, with its name and what it means; `children` go after them. */
function Choices<T extends string>({
  id,
  legend,
  name,
  choices,
  value,
  onChange,
  children,
}: {
  id: string;
  legend: string;
  name: string;
  choices: [T, string, string][];
  value: T;
  onChange: (value: T) => void;
  children?: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {choices.map(([choice, label, description]) => (
        <label
          key={choice}
          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={choice}
            checked={value === choice}
            onChange={() => onChange(choice)}
            aria-labelledby={`${id}-${choice}-label`}
            aria-describedby={`${id}-${choice}-description`}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span
              id={`${id}-${choice}-label`}
              className="font-medium break-words"
            >
              {label}
            </span>
            <span
              id={`${id}-${choice}-description`}
              className="break-words text-muted-foreground"
            >
              {description}
            </span>
          </span>
        </label>
      ))}
      {children}
    </fieldset>
  );
}
