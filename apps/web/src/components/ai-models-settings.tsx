"use client";

import { useActionState, useRef } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { AI_FEATURE_NAMES } from "@/lib/usage-format";
import { saveAiModels } from "@/server/ai-models";
import type { FormState } from "@/server/form-state";
import type { AiModels } from "@/server/operations/ai-models";

/** What each feature's model writes. */
const WRITES: Record<keyof AiModels, string> = {
  answers: "Answers to questions in your docs, on the portal and in the widget.",
  escalations: "The summary sent with a question passed to your team.",
  changelog: "Draft with AI and Edit with AI on changelog entries.",
  code_changes: "The summary, changelog line and proposals for each merged pull request.",
};

/** A price in dollars per token, per million tokens. */
const perMillion = (dollars: number) => `$${Number((dollars * 1e6).toFixed(4))}`;

/** Settings → AI models: a model id per feature, from the endpoint's list (see aiModels.update); empty uses the default. */
export function AiModelsSettings({
  projectSlug,
  models,
  listed,
}: {
  projectSlug: string;
  models: AiModels;
  /** The endpoint's models, to pick from; empty when the list couldn't be read. */
  listed: { id: string; name: string; input: number | null; output: number | null }[];
}) {
  // What this page last saw saved: only fields changed since are sent, so a page opened earlier can't undo another admin's pick.
  const saved = useRef(Object.fromEntries((Object.keys(WRITES) as (keyof AiModels)[]).map((feature) => [feature, models[feature].model ?? ""])));
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const changed = new FormData();
    for (const [feature, value] of Object.entries(saved.current)) {
      const field = String(formData.get(feature) ?? "").trim();
      if (field !== value) {
        changed.set(feature, field);
      }
    }
    const result = await saveAiModels(projectSlug, prev, changed);
    if (!result.error) {
      for (const [feature, value] of changed) {
        saved.current[feature] = String(value);
      }
      toast.success("AI models saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        {(Object.keys(WRITES) as (keyof AiModels)[]).map((feature) => (
          <Field key={feature}>
            <FieldLabel htmlFor={`model-${feature}`}>{AI_FEATURE_NAMES[feature]}</FieldLabel>
            <FieldDescription>{WRITES[feature]}</FieldDescription>
            <Input
              id={`model-${feature}`}
              name={feature}
              list="ai-models"
              defaultValue={models[feature].model ?? ""}
              placeholder={`Default: ${models[feature].default}`}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ))}
        <datalist id="ai-models">
          {listed.map((model) => (
            <option key={model.id} value={model.id}>
              {model.input !== null && model.output !== null
                ? `${model.name}: ${perMillion(model.input)} in, ${perMillion(model.output)} out per million tokens`
                : model.name}
            </option>
          ))}
        </datalist>
        {state.error && <FieldError>{state.error}</FieldError>}
        <div>
          <Button type="submit" disabled={pending}>
            Save
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
