"use client";

import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveAssistantSettings } from "@/server/assistant";
import type { AssistantSettings as Settings } from "@/server/operations/assistant";

const LENGTHS = [
  ["short", "Short"],
  ["medium", "Medium"],
  ["detailed", "Detailed"],
] as const;

/** Customize → AI answers (saved with the panel's "Save changes"): how the docs' AI answers: tone, length, standing instructions and off-limits topics (see assistant.update). */
export function AssistantSettings({ projectSlug, settings }: { projectSlug: string; settings: Settings }) {
  const { state, form } = useCustomizeForm({
    save: (prev, formData) => saveAssistantSettings(projectSlug, prev, formData),
    onSaved: () => toast.success("AI answers saved"),
  });

  return (
    <form {...form}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="assistant-tone">Tone</FieldLabel>
          <Input
            id="assistant-tone"
            name="tone"
            defaultValue={settings.tone}
            maxLength={200}
            placeholder="Friendly and plain; address the reader as you"
            autoComplete="off"
          />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Answer length</legend>
          <div className="flex flex-wrap gap-4">
            {LENGTHS.map(([value, name]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input type="radio" name="length" value={value} defaultChecked={settings.length === value} className="size-4 accent-primary" />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <Field>
          <FieldLabel htmlFor="assistant-instructions">Standing instructions</FieldLabel>
          <FieldDescription>What the AI should always keep in mind, such as what to call your product.</FieldDescription>
          <Textarea id="assistant-instructions" name="instructions" defaultValue={settings.instructions} maxLength={2000} rows={3} />
        </Field>
        <Field>
          <FieldLabel htmlFor="assistant-off-limits">Off-limits topics</FieldLabel>
          <FieldDescription>
            One per line, up to 20. A question with one of these words or phrases gets “I can&apos;t help with that here.” and
            the AI isn&apos;t asked.
          </FieldDescription>
          <Textarea id="assistant-off-limits" name="offLimits" defaultValue={settings.offLimits.join("\n")} rows={3} placeholder={"refund\nlegal advice"} />
        </Field>
        {state.error && <FieldError>{state.error}</FieldError>}
      </FieldGroup>
    </form>
  );
}
