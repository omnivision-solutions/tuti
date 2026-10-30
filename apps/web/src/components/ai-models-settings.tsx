"use client";

import { useActionState, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { choiceOf, costLabel, costPerUse, type ListedModel, pickedModel, TIER_NAMES, tiersFor } from "@/lib/model-tiers";
import { AI_FEATURE_NAMES } from "@/lib/usage-format";
import { saveAiModels } from "@/server/ai-models";
import type { FormState } from "@/server/form-state";
import type { AiModels } from "@/server/operations/ai-models";

/** What each feature's model writes. */
const WRITES: Record<keyof AiModels, string> = {
  answers: "Answers to questions in your docs, on the portal and in the widget.",
  escalations: "The summary sent with a question passed to your team.",
  support: "Replies drafted from your docs and summaries of conversations, in your Inbox.",
  changelog: "Draft with AI and Edit with AI on changelog entries.",
  code_changes: "The summary, changelog line and proposals for each merged pull request.",
};

/** A price in dollars per token, per million tokens. */
const perMillion = (dollars: number) => `$${Number((dollars * 1e6).toFixed(4))}`;

/**
 * Settings → AI models: for each feature, Fast (the server's default), Balanced or Best, each with its model
 * and what one use costs, or a custom model id from the endpoint's list (see aiModels.update).
 */
export function AiModelsSettings({
  projectSlug,
  models,
  listed,
  creditsPerDollar,
}: {
  projectSlug: string;
  models: AiModels;
  /** The endpoint's models, to pick from; empty when the list couldn't be read. */
  listed: ListedModel[];
  /** Where AI is paid with credits, how many a dollar of it costs, to price each choice in them. */
  creditsPerDollar: number | null;
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
          <FeatureModel key={feature} feature={feature} model={models[feature]} listed={listed} creditsPerDollar={creditsPerDollar} />
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

/** One feature's choice: its tiers as cards, then Custom model with a box for the id. Its field holds the id ("" for Fast). */
function FeatureModel({
  feature,
  model,
  listed,
  creditsPerDollar,
}: {
  feature: keyof AiModels;
  model: AiModels[keyof AiModels];
  listed: ListedModel[];
  creditsPerDollar: number | null;
}) {
  const tiers = tiersFor(model.default, listed);
  const [choice, setChoice] = useState(choiceOf(model.model, tiers));
  const [custom, setCustom] = useState(choice === "custom" ? (model.model ?? "") : "");
  // A tier the endpoint no longer lists (after a refresh) becomes what was saved, as a custom id, once.
  if (choice !== "fast" && choice !== "custom" && !tiers.some((option) => option.tier === choice)) {
    setChoice("custom");
    setCustom(model.model ?? "");
  }
  const value = pickedModel(choice, custom, tiers, model.model);
  const byId = new Map(listed.map((listing) => [listing.id, listing]));
  const priced = (id: string) => costLabel(costPerUse(feature, byId.get(id)), creditsPerDollar);
  const name = useId();
  const card = "flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-soft has-focus-visible:ring-2 has-focus-visible:ring-ring";

  return (
    <Field>
      <input type="hidden" name={feature} value={value} />
      <FieldTitle>{AI_FEATURE_NAMES[feature]}</FieldTitle>
      <FieldDescription>{WRITES[feature]}</FieldDescription>
      <div role="radiogroup" aria-label={AI_FEATURE_NAMES[feature]} className="grid gap-2 sm:grid-cols-2">
        {tiers.map((option) => (
          <label key={option.tier} className={card}>
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name={name} className="accent-primary" checked={choice === option.tier} onChange={() => setChoice(option.tier)} />
              {TIER_NAMES[option.tier]}
            </span>
            <span className="break-all text-xs text-muted-foreground">{byId.get(option.model)?.name ?? option.model}</span>
            {priced(option.model) && <span className="text-xs text-muted-foreground">{priced(option.model)}</span>}
          </label>
        ))}
        <label className={card}>
          <span className="flex items-center gap-2 font-medium">
            <input type="radio" name={name} className="accent-primary" checked={choice === "custom"} onChange={() => setChoice("custom")} />
            Custom model
          </span>
          <span className="text-xs text-muted-foreground">Any other model id</span>
        </label>
      </div>
      {choice === "custom" && (
        <>
          <Input
            aria-label={`${AI_FEATURE_NAMES[feature]}: model id`}
            // Empty would save as the default (Fast): pick Fast for that.
            required
            list="ai-models"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="provider/model"
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
          />
          {priced(custom.trim()) && <FieldDescription>{priced(custom.trim())}</FieldDescription>}
        </>
      )}
    </Field>
  );
}
