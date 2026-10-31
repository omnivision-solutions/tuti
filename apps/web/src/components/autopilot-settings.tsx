"use client";

import { useActionState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { saveAutopilotSettings } from "@/server/github";

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
