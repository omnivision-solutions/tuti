"use client";

import { type ReactNode, useActionState, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { type Choice, choiceOf, costLabel, costPerUse, type ListedModel, pickedModel, TIER_NAMES, tiersFor } from "@/lib/model-tiers";
import { AI_FEATURE_NAMES } from "@/lib/usage-format";
import { saveAiModels } from "@/server/ai-models";
import type { FormState } from "@/server/form-state";
import type { AiModels } from "@/server/operations/ai-models";

type Pick = keyof AiModels;

/** Each row: its title, what its model does, and (Autopilot's steps) that it's an agent, so only models with tool calls. */
const ROWS: { pick: Pick; title: string; does: string; agent?: true; off?: true }[] = [
  { pick: "answers", title: AI_FEATURE_NAMES.answers!, does: "Answers to questions in your docs, on the portal and in the widget." },
  { pick: "escalations", title: AI_FEATURE_NAMES.escalations!, does: "The summary sent with a question passed to your team." },
  { pick: "support", title: AI_FEATURE_NAMES.support!, does: "Replies drafted from your docs and summaries of conversations, in your Inbox." },
  { pick: "changelog", title: AI_FEATURE_NAMES.changelog!, does: "Draft with AI and Edit with AI on changelog entries." },
  {
    pick: "code_changes_decide",
    title: "Autopilot decides",
    does: "Reads each merged pull request, its code and your help center, and decides which articles to fix and which new ones you need.",
    agent: true,
  },
  {
    pick: "code_changes_redecide",
    title: "Autopilot double-checks",
    does: "When it proposes a new article, decides again from scratch, so fewer duplicates are written. Off skips it.",
    agent: true,
    off: true,
  },
  {
    pick: "code_changes",
    title: "Autopilot writes",
    does: "Writes each fix and new article, the summary, the changelog line and updates on posts. Verify uses it too.",
    agent: true,
  },
];

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
  children,
}: {
  projectSlug: string;
  models: AiModels;
  /** The endpoint's models, to pick from; empty when the list couldn't be read. */
  listed: ListedModel[];
  /** Where AI is paid with credits, how many a dollar of it costs, to price each choice in them. */
  creditsPerDollar: number | null;
  /** Shown under Autopilot's rows, after Save: its Advanced tuning. */
  children?: ReactNode;
}) {
  // What this page last saw saved: only fields changed since are sent, so a page opened earlier can't undo another admin's pick.
  const saved = useRef(Object.fromEntries(ROWS.map(({ pick }) => [pick, models[pick].model ?? ""])));
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

  const options = (models: ListedModel[]) =>
    models.map((model) => (
      <option key={model.id} value={model.id}>
        {model.input !== null && model.output !== null ? `${model.name}: ${perMillion(model.input)} in, ${perMillion(model.output)} out per million tokens` : model.name}
      </option>
    ));

  return (
    <div className="flex flex-col gap-6">
      <form {...keepingFields(action)}>
        <FieldGroup>
          {ROWS.map((row) => (
            <FeatureModel key={row.pick} row={row} model={models[row.pick]} listed={row.agent ? listed.filter((model) => model.tools) : listed} creditsPerDollar={creditsPerDollar} />
          ))}
          <datalist id="ai-models">{options(listed)}</datalist>
          <datalist id="ai-models-tools">{options(listed.filter((model) => model.tools))}</datalist>
          {state.error && <FieldError>{state.error}</FieldError>}
          <div>
            <Button type="submit" disabled={pending}>
              Save
            </Button>
          </div>
        </FieldGroup>
      </form>
      {children}
    </div>
  );
}

/**
 * One row's choice: its tiers as cards, Off where it can be (Autopilot's double-check), then Custom model with a box for
 * the id. Its field holds the id ("" for Fast).
 */
function FeatureModel({
  row: { pick, title, does, agent, off },
  model,
  listed,
  creditsPerDollar,
}: {
  row: (typeof ROWS)[number];
  model: AiModels[Pick];
  listed: ListedModel[];
  creditsPerDollar: number | null;
}) {
  const tiers = tiersFor(model.default, listed);
  const [choice, setChoice] = useState<Choice>(choiceOf(model.model, tiers));
  const [custom, setCustom] = useState(choice === "custom" ? (model.model ?? "") : "");
  // A tier the endpoint no longer lists (after a refresh) becomes what was saved, as a custom id, once.
  if (choice !== "fast" && choice !== "custom" && choice !== "off" && !tiers.some((option) => option.tier === choice)) {
    setChoice("custom");
    setCustom(model.model ?? "");
  }
  const value = pickedModel(choice, custom, tiers, model.model);
  const byId = new Map(listed.map((listing) => [listing.id, listing]));
  const priced = (id: string) => costLabel(costPerUse(pick, byId.get(id)), creditsPerDollar);
  const name = useId();
  const card = "flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-soft has-focus-visible:ring-2 has-focus-visible:ring-ring";

  return (
    <Field>
      <input type="hidden" name={pick} value={value} />
      <FieldTitle>{title}</FieldTitle>
      <FieldDescription>
        {does}
        {agent && " Only models that can use tools are offered."}
      </FieldDescription>
      <div role="radiogroup" aria-label={title} className="grid gap-2 sm:grid-cols-2">
        {tiers.map((option) => (
          <label key={option.tier} className={card}>
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name={name} className="accent-primary" checked={choice === option.tier} onChange={() => setChoice(option.tier)} />
              {TIER_NAMES[option.tier]}
            </span>
            <span className="break-all text-xs text-muted-foreground">{option.model === "off" ? "Off" : (byId.get(option.model)?.name ?? option.model)}</span>
            {priced(option.model) && <span className="text-xs text-muted-foreground">{priced(option.model)}</span>}
          </label>
        ))}
        {off && model.default !== "off" && (
          <label className={card}>
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name={name} className="accent-primary" checked={choice === "off"} onChange={() => setChoice("off")} />
              Off
            </span>
            <span className="text-xs text-muted-foreground">No double-check: cheaper, more duplicates</span>
          </label>
        )}
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
            aria-label={`${title}: model id`}
            // Empty (or only spaces, trimmed when saved) would save as the default (Fast): pick Fast for that.
            required
            pattern=".*\S.*"
            title="A model id, such as provider/model"
            list={agent ? "ai-models-tools" : "ai-models"}
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
