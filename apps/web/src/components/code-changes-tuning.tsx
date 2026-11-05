"use client";

import { type ReactNode, useActionState, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import { saveCodeChangesTuning } from "@/server/code-changes-tuning";
import type { FormState } from "@/server/form-state";
import type { CodeChangesTuning } from "@/server/operations/code-changes-tuning";

type Key = keyof CodeChangesTuning["values"];
type Value = CodeChangesTuning["values"][Key];

/** A field's text against a value's: numbers as numbers ("06" is 6), options as text. */
function same(text: string, value: string): boolean {
  const typed = text.trim();
  return typed === value || (typed !== "" && value !== "" && Number(typed) === Number(value));
}

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

/** A saved value that differs from the server's in use, or one clamped (what's saved isn't what's used, even at the default). */
const overridden = (value: Value) => value.saved !== null && (value.saved !== value.default || value.clamped);

/**
 * Settings → AI models → Advanced tuning: Autopilot's values for this project. Owners change them on a plan with it;
 * admins, and everyone on a plan without it, see them read-only (`notice` says why, with the way to Business). Each
 * value keeps the server's range, says its tradeoff and "Changed from" the server's. The page saves one way, its Save:
 * Reset and Reset all only put the server's value back in their fields for it. After a save the form starts again from
 * what's stored, so its fields never show text older than the save.
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
  rows: { key: Key; label: string; tradeoff: string }[];
  owner: boolean;
  /** Who changed the values last, and when ("by Olive 2 hours ago"), or null. */
  lastChanged: string | null;
  /** Where the plan doesn't include it: what it needs (PlanNotice). */
  notice: ReactNode;
}) {
  const editable = owner && tuning.available;
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // The values reset since the last save: Save sends "" for those, so they follow the server again.
  const [resets, setResets] = useState<Key[]>([]);
  const [state, action, pending] = useActionState<FormState & { saves?: number }, FormData>(async (prev, formData) => {
    // Only what differs from what's saved is sent, so a page opened earlier doesn't undo another owner's values: a field
    // typed back to the server's value clears the project's; a reset one clears it even where it only shows as the
    // server's (0.395 shows as 40%); an untouched one that merely shows as the server's isn't sent.
    const changes = new FormData();
    for (const { key } of rows) {
      const { saved, default: fallback, range } = tuning.values[key];
      const sent = formData.get(key);
      if (typeof sent !== "string") {
        continue;
      }
      if (!same(sent, field(saved ?? fallback, range))) {
        changes.set(key, saved !== null && same(sent, field(fallback, range)) ? "" : sent.trim());
      } else if (saved !== null && resets.includes(key)) {
        changes.set(key, "");
      }
    }
    const result = await saveCodeChangesTuning(projectSlug, prev, changes);
    if (result.error) {
      return { ...result, saves: prev.saves };
    }
    setResets([]);
    toast.success("Advanced tuning saved");
    // The form starts again (its key) with what's stored now; focus, on a field or button that goes with it, moves to the heading.
    heading.current?.focus({ preventScroll: true });
    return { saves: (prev.saves ?? 0) + 1 };
  }, {});
  /** Puts the server's value back in each field, for Save. */
  const reset = (keys: Key[]) => {
    for (const key of keys) {
      const input = form.current?.elements.namedItem(key);
      const value = tuning.values[key];
      if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
        input.value = field(value.default, value.range);
      }
    }
    setResets((before) => [...new Set([...before, ...keys])]);
    // The Reset goes once used: focus stays on the field it reset, or (Reset all) the heading.
    const target = keys.length === 1 ? form.current?.elements.namedItem(keys[0]!) : heading.current;
    (target instanceof HTMLElement ? target : heading.current)?.focus();
  };
  const changed = rows.filter(({ key }) => overridden(tuning.values[key]) && !resets.includes(key));
  const resettable = rows.filter(({ key }) => tuning.values[key].saved !== null && !resets.includes(key));

  return (
    <Card>
      <CardHeader>
        <h1 ref={heading} tabIndex={-1} className="font-heading text-base leading-snug font-medium outline-none">
          Advanced tuning
        </h1>
        <CardDescription>
          How sure Autopilot must be before it proposes a change, how much it looks up and thinks, for this project only. Each starts as this
          server&apos;s.
          {tuning.available && !owner && " Only owners change these."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {notice}
        <form key={state.saves ?? 0} ref={form} {...keepingFields(action)} className="flex flex-col gap-4">
          <fieldset disabled={!editable || pending} className="flex flex-col gap-4">
            {rows.map(({ key, label, tradeoff }) => {
              const value = tuning.values[key];
              const { range } = value;
              const own = value.saved ?? value.default;
              const id = `tuning-${key}`;
              const isChanged = changed.some((row) => row.key === key);
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
                    {isChanged && editable && (
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
                  {isChanged && (
                    <p id={`${id}-changed`} className="text-xs font-medium">
                      Changed from {shown(value.default, range)}
                      {value.clamped && `: saved past this server's range, so it's used as ${shown(value.saved!, range)}`}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
          {state.error && <FieldError>{state.error}</FieldError>}
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending} focusableWhenDisabled>
                Save
              </Button>
              {resettable.length > 0 && (
                <Button type="button" variant="outline" disabled={pending} focusableWhenDisabled onClick={() => reset(resettable.map(({ key }) => key))}>
                  Reset all
                </Button>
              )}
            </div>
          )}
          {lastChanged && <p className="text-xs text-muted-foreground">Last changed {lastChanged}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
