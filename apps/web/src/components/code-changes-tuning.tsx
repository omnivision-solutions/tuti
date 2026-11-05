"use client";

import { type ReactNode, startTransition, useActionState, useRef } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { saveCodeChangesTuning } from "@/server/code-changes-tuning";
import type { FormState } from "@/server/form-state";
import type { CodeChangesTuning } from "@/server/operations/code-changes-tuning";

type Value = CodeChangesTuning["values"][keyof CodeChangesTuning["values"]];

/** A value as the page shows it: a probability in percent, a number with separators, an option capitalised. */
function shown(value: Value["value"], range: Value["range"]): string {
  if (typeof value === "string") {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  return range.kind === "probability" ? `${Math.round(value * 100)}%` : value.toLocaleString("en-US");
}

/** A range's bound in whole percents inside it (the server checks the exact range). */
const percent = (n: number, round: (n: number) => number) => round(Number((n * 100).toFixed(6)));

/** The form's value for it: percent for a probability. */
const field = (value: Value["value"], range: Value["range"]) => (typeof value === "number" && range.kind === "probability" ? String(Math.round(value * 100)) : String(value));

/**
 * Settings → AI models, under Autopilot: Advanced tuning (collapsed). Owners change it on a plan with it; admins, and
 * everyone on a plan without it, see the values read-only (`notice` says why, with the way to Business). Each value
 * keeps the server's range, says its tradeoff, "Changed from" the server's and has a Reset.
 */
export function CodeChangesTuningSettings({
  projectSlug,
  tuning,
  rows,
  owner,
  lastChanged,
  notice,
}: {
  projectSlug: string;
  tuning: CodeChangesTuning;
  rows: { key: keyof CodeChangesTuning["values"]; label: string; tradeoff: string }[];
  owner: boolean;
  /** Who changed the values last, and when ("by Olive 2 hours ago"), or null. */
  lastChanged: string | null;
  /** Where the plan doesn't include it: what it needs (PlanNotice). */
  notice: ReactNode;
}) {
  const editable = owner && tuning.available;
  // The form remounts with the saved values (its key), and Reset all goes once nothing is saved: keyboard focus
  // moves to the section's heading, which stays, instead of falling to the page.
  const heading = useRef<HTMLElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    // Only what changed is sent, so a page opened earlier doesn't undo another owner's values.
    const changed = new FormData();
    for (const { key } of rows) {
      const { saved, default: fallback, range } = tuning.values[key];
      const sent = formData.get(key);
      if (typeof sent === "string" && sent.trim() !== field(saved ?? fallback, range)) {
        changed.set(key, sent.trim());
      }
    }
    const result = await saveCodeChangesTuning(projectSlug, prev, changed);
    if (!result.error) {
      // Only from inside this section: someone who moved on during the save keeps their place.
      if (heading.current?.parentElement?.contains(document.activeElement)) {
        heading.current.focus({ preventScroll: true });
      }
      toast.success("Advanced tuning saved");
    }
    return result;
  }, {});
  // Reset: the value goes back to the server's ("" sent).
  const reset = (keys: string[]) => {
    const data = new FormData();
    for (const key of keys) {
      data.set(key, "");
    }
    startTransition(() => action(data));
  };
  const changed = rows.filter(({ key }) => tuning.values[key].saved !== null && tuning.values[key].saved !== tuning.values[key].default);
  const saved = rows.filter(({ key }) => tuning.values[key].saved !== null);

  return (
    <details className="group rounded-xl border px-4 py-3 text-sm">
      <summary ref={heading} className="flex cursor-pointer items-center gap-2 font-medium">
        <span>Advanced tuning</span>
        {!tuning.available && <Badge variant="outline">Available on Business</Badge>}
      </summary>
      <div className="flex flex-col gap-4 pt-3">
        <p className="text-muted-foreground">
          How sure Autopilot must be before it proposes a change, how much it looks up and thinks, for this project only. Each starts as this
          server&apos;s.
          {tuning.available && !owner && " Only owners change these."}
        </p>
        {notice}
        <form {...keepingFields(action)} key={JSON.stringify(tuning.values)} className="flex flex-col gap-4">
          <fieldset disabled={!editable || pending} className="flex flex-col gap-4">
            {rows.map(({ key, label, tradeoff }) => {
              const value = tuning.values[key];
              const { range } = value;
              const own = value.saved ?? value.default;
              const id = `tuning-${key}`;
              return (
                <div key={key} className="flex flex-col gap-1">
                  <label htmlFor={id} className="font-medium">
                    {label}
                  </label>
                  <div className="flex items-center gap-2">
                    {range.kind === "options" ? (
                      <select
                        id={id}
                        name={key}
                        defaultValue={String(own)}
                        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {range.options.map((option) => (
                          <option key={option} value={option}>
                            {shown(option, range)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        id={id}
                        name={key}
                        type="number"
                        required
                        className="w-32"
                        min={range.kind === "probability" ? percent(range.min, Math.ceil) : range.min}
                        max={range.kind === "probability" ? percent(range.max, Math.floor) : range.max}
                        step={1}
                        defaultValue={field(own, range)}
                      />
                    )}
                    {range.kind === "probability" && <span className="text-muted-foreground">%</span>}
                    {changed.some((row) => row.key === key) && editable && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => reset([key])} aria-label={`Reset ${label}`}>
                        Reset
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {tradeoff}
                    {range.kind === "integer" && ` From ${shown(range.min, range)} to ${shown(range.max, range)}.`}
                    {range.kind === "probability" && ` From ${percent(range.min, Math.ceil)}% to ${percent(range.max, Math.floor)}%.`}
                  </p>
                  {value.saved !== null && value.saved !== value.default && (
                    <p className="text-xs font-medium">
                      Changed from {shown(value.default, range)}
                      {value.clamped && `: saved past this server's range, so it's used as ${shown(value.saved, range)}`}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
          {state.error && <FieldError>{state.error}</FieldError>}
          {editable && (
            <div className="flex flex-wrap gap-2">
              {/* Not the page's primary (the models' Save is): it saves the tuning only. */}
              <Button type="submit" variant="secondary" disabled={pending} focusableWhenDisabled>
                Save tuning
              </Button>
              {saved.length > 0 && (
                <Button type="button" variant="outline" disabled={pending} focusableWhenDisabled onClick={() => reset(saved.map(({ key }) => key))}>
                  Reset all
                </Button>
              )}
            </div>
          )}
          {lastChanged && <p className="text-xs text-muted-foreground">Last changed {lastChanged}</p>}
        </form>
      </div>
    </details>
  );
}
