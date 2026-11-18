"use client";

import type { AiRole } from "@tuti/shared";
import { type ReactNode, useActionState, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { type Choice, choiceOf, costLabel, costPerUse, type ListedModel, pickedModel, TIER_NAMES, tiersFor } from "@/lib/model-tiers";
import { saveAiModels } from "@/server/ai-models";
import type { FormState } from "@/server/form-state";
import type { AiModels } from "@/server/operations/ai-models";

/** A role with a row here: the changelog's and AI answers' are on their own pages (Settings → Changelog, AI answers), as each feature's will be (docs/plan.md, R4–R7). */
type RowRole = Exclude<AiRole, "changelog" | "answers" | "escalations">;
/** Each role's row, in the page's order: its title and what its model does. Every such role has one (the type says so). */
const ROW_OF: Record<RowRole, { title: string; does: string }> = {
  support_draft: { title: "Inbox drafts", does: "Replies drafted from your docs, in your Inbox." },
  support_summary: { title: "Inbox summaries", does: "Summaries of conversations, in your Inbox." },
  code_changes_decide: {
    title: "Autopilot decides",
    does: "Reads each merged pull request, its code and your help center, and decides which articles to fix and which new ones you need.",
  },
  code_changes_check: {
    title: "Autopilot checks",
    does: "A second opinion on Autopilot's own work. When it proposes a new article, it decides again from scratch, so fewer duplicates are written. Off skips it.",
  },
  code_changes: {
    title: "Autopilot writes",
    does: "Writes each fix and new article, the summary, the changelog line and updates on posts. Verify uses it too.",
  },
};
const ROLES = Object.keys(ROW_OF) as RowRole[];
/** A row: its role's words, and (from the page, as AI_ROLES says) whether it's an agent's, so only models with tool calls, and whether it can be off. */
type Row = { pick: AiRole; title: string; does: string; agent: boolean; off: boolean };

/** A price in dollars per token, per million tokens. */
const perMillion = (dollars: number) => `$${Number((dollars * 1e6).toFixed(4))}`;

/**
 * Settings → AI models: for each role, Fast (the server's default), Balanced or Best, each with its model
 * and what one use costs, or a custom model id from the endpoint's list (see aiModels.update).
 */
export function AiModelsSettings({
  projectSlug,
  models,
  agents,
  offable,
  listed,
  creditsPerDollar,
  describedBy,
  children,
}: {
  projectSlug: string;
  models: AiModels;
  /** The roles that are an agent's (only models with tool calls), and those a project may switch off. */
  agents: AiRole[];
  offable: AiRole[];
  /** The endpoint's models, to pick from; empty when the list couldn't be read. */
  listed: ListedModel[];
  /** Where AI is paid with credits, how many a dollar of it costs, to price each choice in them. */
  creditsPerDollar: number | null;
  /** The id of the notice saying the plan doesn't include picking models, read out with each row's choices. */
  describedBy?: string;
  /** Shown under Autopilot's rows, after Save: the way to its Advanced tuning. */
  children?: ReactNode;
}) {
  // What this page last saw saved: only fields changed since are sent, so a page opened earlier can't undo another admin's pick.
  const rows: Row[] = ROLES.map((pick) => ({ pick, ...ROW_OF[pick], agent: agents.includes(pick), off: offable.includes(pick) }));
  const saved = useRef(Object.fromEntries(ROLES.map((pick) => [pick, models[pick].model ?? ""])));
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
          {rows.map((row) => (
            <FeatureModel key={row.pick} row={row} model={models[row.pick]} listed={row.agent ? listed.filter((model) => model.tools) : listed} creditsPerDollar={creditsPerDollar} describedBy={describedBy} />
          ))}
          <datalist id="ai-models">{options(listed)}</datalist>
          <datalist id="ai-models-tools">{options(listed.filter((model) => model.tools))}</datalist>
          {state.error && <FieldError>{state.error}</FieldError>}
          <div>
            <Button type="submit" disabled={pending} focusableWhenDisabled>
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
 * One row's choice: its tiers as cards, Off where it can be (Autopilot's checks), then Custom model with a box for
 * the id. Its field holds the id ("" for Fast).
 */
function FeatureModel({
  row: { pick, title, does, agent, off },
  model,
  listed,
  creditsPerDollar,
  describedBy,
}: {
  row: Row;
  model: AiModels[AiRole];
  listed: ListedModel[];
  creditsPerDollar: number | null;
  describedBy?: string;
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
      <div role="radiogroup" aria-label={title} aria-describedby={describedBy} className="grid gap-2 sm:grid-cols-2">
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
            <span className="text-xs text-muted-foreground">No check: cheaper, more duplicates</span>
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
