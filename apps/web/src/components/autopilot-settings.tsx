"use client";

import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { saveAutopilotRecipients, saveAutopilotSettings, setAutopilotEmails } from "@/server/github";

export type AutopilotSettingsValues = {
  drafts: boolean;
  articleEdits: boolean;
  progress: boolean;
  complete: boolean;
  minSure: number;
  maxReach: number;
  maxViews: number;
  holdHours: number;
};

const SWITCHES = [
  ["drafts", "Write drafts at once", "The changelog line in the running draft, and a new article's draft. Only your team sees them."],
  ["articleEdits", "Publish article edits", "After the hold, when the article hasn't changed since."],
  ["progress", "Post progress updates", "After the hold: the post moves to In progress with Autopilot's update."],
  ["complete", "Complete requests", "After the hold. Completing a post emails the people who asked for it. Off: it asks you first."],
] as const;

/**
 * Settings → Autopilot's own settings (owners; `owner` false: shown, not changed): what goes out by
 * itself, what always waits for someone, and how long the rest waits first.
 */
export function AutopilotSettingsForm({ projectSlug, settings, owner }: { projectSlug: string; settings: AutopilotSettingsValues; owner: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveAutopilotSettings(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Autopilot's settings saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      <fieldset disabled={pending || !owner} className="contents">
        <FieldGroup>
          {SWITCHES.map(([name, label, description]) => (
            <div key={name} className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <label htmlFor={`autopilot-${name}`} className="text-sm font-medium">
                  {label}
                </label>
                <p className="text-sm text-muted-foreground">{description}</p>
              </div>
              <Switch id={`autopilot-${name}`} name={name} defaultChecked={settings[name]} className="mt-0.5" />
            </div>
          ))}
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">Always waits for someone</legend>
            <p className="text-sm text-muted-foreground">Whatever the switches, an update waits for your team when it&apos;s:</p>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="autopilot-min-sure" className="flex-1 font-normal">
                Less sure than (%)
              </FieldLabel>
              <Input id="autopilot-min-sure" name="minSure" type="number" min={50} max={100} required defaultValue={settings.minSure} className="w-24" />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="autopilot-max-reach" className="flex-1 font-normal">
                About a post with this many people or more (author, voters, commenters)
              </FieldLabel>
              <Input id="autopilot-max-reach" name="maxReach" type="number" min={1} required defaultValue={settings.maxReach} className="w-24" />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="autopilot-max-views" className="flex-1 font-normal">
                About an article read this often or more in 30 days
              </FieldLabel>
              <Input id="autopilot-max-views" name="maxViews" type="number" min={1} required defaultValue={settings.maxViews} className="w-24" />
            </Field>
          </fieldset>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="autopilot-hold">The hold (hours)</FieldLabel>
              <FieldDescription>What goes out by itself waits this long first, so your team can stop it. Drafts don&apos;t wait.</FieldDescription>
            </div>
            <Input id="autopilot-hold" name="holdHours" type="number" min={0} max={336} required defaultValue={settings.holdHours} className="w-24" />
          </Field>
          {state.error && <FieldError>{state.error}</FieldError>}
          {owner && (
            <Button type="submit" disabled={pending} className="self-end">
              {pending ? "Saving…" : "Save"}
            </Button>
          )}
        </FieldGroup>
      </fieldset>
    </form>
  );
}

/** Settings → Autopilot → Who's told (owners change it): owners always; admins too, or chosen team members. */
export function AutopilotRecipientsForm({
  projectSlug,
  owner,
  admins,
  members,
}: {
  projectSlug: string;
  owner: boolean;
  admins: boolean;
  /** The team past its owners: each one's name, role and whether they're told. */
  members: { userId: string; name: string; role: "ADMIN" | "MEMBER"; told: boolean }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveAutopilotRecipients(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Who's told saved");
    }
    return result;
  }, {});
  return (
    <form {...keepingFields(action)}>
      <fieldset disabled={pending || !owner} className="contents">
        <FieldGroup>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="admins" defaultChecked={admins} className="size-4 accent-primary" />
            Admins too
          </label>
          {members.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">And these people on the team</legend>
              {members.map((member) => (
                <label key={member.userId} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="told" value={member.userId} defaultChecked={member.told} className="size-4 accent-primary" />
                  {member.name}
                  <span className="text-muted-foreground">{member.role === "ADMIN" ? "Admin" : "Member"}</span>
                </label>
              ))}
            </fieldset>
          )}
          {state.error && <FieldError>{state.error}</FieldError>}
          {owner && (
            <Button type="submit" disabled={pending} className="self-end">
              {pending ? "Saving…" : "Save who's told"}
            </Button>
          )}
        </FieldGroup>
      </fieldset>
    </form>
  );
}

/** Account → Autopilot's email: as each change is analysed, a daily digest, or off. Saved as it's picked. */
export function AutopilotEmailsChoice({ choice }: { choice: "AS_THEY_HAPPEN" | "DIGEST" | "OFF" }) {
  const [pending, startTransition] = useTransition();
  // What's saved: a choice that isn't (signed out meanwhile, say) goes back to it.
  const [saved, setSaved] = useState(choice);
  const [picked, setPicked] = useState(choice);
  // Changed elsewhere (another tab) and the page refreshed: that's what's saved now, unless a save here is on its way.
  const [given, setGiven] = useState(choice);
  if (given !== choice && !pending) {
    setGiven(choice);
    setSaved(choice);
    setPicked(choice);
  }
  return (
    <fieldset disabled={pending} className="flex flex-col gap-2">
      <legend className="sr-only">Autopilot&apos;s email</legend>
      {(
        [
          ["AS_THEY_HAPPEN", "As they happen", "An email when a merged pull request has updates (several merged within ten minutes in one)."],
          ["DIGEST", "A daily digest", "One email each morning (8 am where you are now) with everything still waiting for you; none on a day with nothing."],
          ["OFF", "Off", "None. If you own a project, you still hear what goes out by itself."],
        ] as const
      ).map(([value, label, description]) => (
        <label key={value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="autopilotEmails"
            value={value}
            checked={picked === value}
            className="mt-0.5 size-4 accent-primary"
            onChange={() => {
              setPicked(value);
              startTransition(async () => {
                // The digest comes in the morning where they are: the time zone their browser reports.
                const result = await setAutopilotEmails(value, Intl.DateTimeFormat().resolvedOptions().timeZone);
                if (result.error) {
                  setPicked(saved);
                  toast.error(result.error);
                } else {
                  setSaved(value);
                  toast.success("Saved");
                }
              });
            }}
          />
          <span className="flex flex-col">
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground">{description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
