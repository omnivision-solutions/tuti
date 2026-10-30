"use client";

import { useActionState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { keepingFields } from "@/lib/forms";
import { saveAssistantSettings } from "@/server/assistant";
import type { FormState } from "@/server/form-state";
import type { AssistantSettings as Settings } from "@/server/operations/assistant";

const LENGTHS = [
  ["short", "Short"],
  ["medium", "Medium"],
  ["detailed", "Detailed"],
] as const;

/** Settings → AI answers: how the docs' AI answers: tone, length, standing instructions and off-limits topics (see assistant.update). */
export function AssistantSettings({ projectSlug, settings }: { projectSlug: string; settings: Settings }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveAssistantSettings(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("AI answers saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      {/* Locked while saving: the form is new once saved, so an edit made meanwhile would be lost. */}
      <fieldset disabled={pending} className="contents">
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
          <Button type="submit" disabled={pending} className="self-end">
            {pending ? "Saving…" : "Save"}
          </Button>
        </FieldGroup>
      </fieldset>
    </form>
  );
}
