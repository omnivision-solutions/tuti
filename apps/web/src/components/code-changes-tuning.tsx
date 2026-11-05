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
  // After a save the fields keep what's in them (no remount), so a value typed but not saved yet stays; keyboard focus
  // moves to the section's heading when the button it was on goes (Reset, Reset all).
  const heading = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    // Reset ("$reset": the keys) saves only those, back to the server's (""). Save tuning sends only the fields that
    // differ from what's saved, so a page opened earlier doesn't undo another owner's values; one typed back to the
    // server's value is cleared, so it follows the server again.
    const resets = formData.getAll("$reset").map(String);
    const changes = new FormData();
    for (const { key } of rows) {
      const { saved, default: fallback, range } = tuning.values[key];
      const sent = formData.get(key);
      if (resets.length > 0) {
        if (resets.includes(key)) {
          changes.set(key, "");
        }
      } else if (typeof sent === "string" && sent.trim() !== field(saved ?? fallback, range)) {
        changes.set(key, saved !== null && sent.trim() === field(fallback, range) ? "" : sent.trim());
      }
    }
    const result = await saveCodeChangesTuning(projectSlug, prev, changes);
    if (!result.error) {
      for (const key of resets) {
        const input = form.current?.elements.namedItem(key);
        const value = tuning.values[key as (typeof rows)[number]["key"]];
        if (value && (input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) {
          input.value = field(value.default, value.range);
        }
      }
      // Only from inside this section: someone who moved on during the save keeps their place.
      if (heading.current?.parentElement?.contains(document.activeElement)) {
        heading.current.focus({ preventScroll: true });
      }
      toast.success("Advanced tuning saved");
    }
    return result;
  }, {});
  const reset = (keys: string[]) => {
    const data = new FormData();
    for (const key of keys) {
      data.append("$reset", key);
    }
    startTransition(() => action(data));
  };
  // A clamped value shows even when it lands on the default: what's saved isn't what's used.
  const overridden = (value: (typeof tuning.values)[keyof typeof tuning.values]) => value.saved !== null && (value.saved !== value.default || value.clamped);
  const changed = rows.filter(({ key }) => overridden(tuning.values[key]));
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
        <form ref={form} {...keepingFields(action)} className="flex flex-col gap-4">
          <fieldset disabled={!editable || pending} className="flex flex-col gap-4">
            {rows.map(({ key, label, tradeoff }) => {
              const value = tuning.values[key];
              const { range } = value;
              const own = value.saved ?? value.default;
              const id = `tuning-${key}`;
              const isChanged = overridden(value);
              const described = isChanged ? `${id}-help ${id}-changed` : `${id}-help`;
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
                        aria-describedby={described}
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
                        aria-describedby={described}
                      />
                    )}
                    {range.kind === "probability" && <span className="text-muted-foreground">%</span>}
                    {changed.some((row) => row.key === key) && editable && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => reset([key])} aria-label={`Reset ${label}`}>
                        Reset
                      </Button>
                    )}
                  </div>
                  <p id={`${id}-help`} className="text-xs text-muted-foreground">
                    {tradeoff}
                    {range.kind === "integer" && ` From ${shown(range.min, range)} to ${shown(range.max, range)}.`}
                    {range.kind === "probability" && ` From ${percent(range.min, Math.ceil)}% to ${percent(range.max, Math.floor)}%.`}
                  </p>
                  {value.saved !== null && isChanged && (
                    <p id={`${id}-changed`} className="text-xs font-medium">
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
