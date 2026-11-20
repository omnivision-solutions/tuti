"use client";

import { cn } from "cn";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";

import { useCustomizeForm, useFieldChanged } from "@/components/customize-shell";
import { SettingsCard, SettingsPane, SettingRow } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { saveCodeChangesTuning } from "@/server/code-changes-tuning";
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
 * Each value's row: its label under its card's title, one line on its tradeoff, and for a number what its field says
 * after it (`unit`; a probability's "%" and a count's range otherwise) with the field's width and the room kept for
 * that. `info`: what takes longer to say.
 */
const ROWS: Record<Key, { label: string; line: string; unit?: string; field?: string; info?: string }> = {
  "propose.edit.maybe": { label: "To fix an article", line: "Lower catches more; higher means fewer to review." },
  "propose.newArticle.maybe": { label: "To write a new article", line: "Lower fills more gaps; higher avoids duplicates." },
  "redecide.whenNewArticle": { label: "To double-check a new article", line: "Lower checks more and costs more." },
  "decide.rounds": { label: "Lookups before deciding", line: "More finds more, costs more." },
  "write.rounds": { label: "Lookups before writing", line: "More is closer to the product, costs more." },
  "decide.reasoning": { label: "Thinking", line: "Better on hard changes, slower." },
  "context.diffChars": {
    label: "Change shown up front",
    line: "Characters of the diff read at once.",
    unit: "chars",
    field: "w-36 pr-14",
    info: "Autopilot looks up the rest for the docs, but what the changelog and posts hear about is decided from this much only (20,000 characters at most).",
  },
};
const KEYS = Object.keys(ROWS) as Key[];

type Props = {
  projectSlug: string;
  tuning: CodeChangesTuning;
  owner: boolean;
};

/**
 * Settings → Autopilot → Advanced tuning: Autopilot's values for this project, as two cards of rows. Owners change
 * them on a plan with it; admins, and everyone on a plan without it, see them read-only (`notice` says why, with the
 * way to Business). Each value keeps the server's range and says "Changed from" the server's. The page saves one way,
 * "Save changes" in its header: Reset and "Reset to defaults" only put the server's value back in their fields for it.
 * After a save that changed something the form starts again from what's stored, so its fields never show text older
 * than the save.
 */
export function CodeChangesTuningSettings({
  back,
  lastChanged,
  notice,
  ...props
}: Props & {
  /** The page it's a part of. */
  back: { href: string; label: string };
  /** Who changed the values last, and when ("by Olive 2 hours ago"), or null. */
  lastChanged: string | null;
  /** Where the plan doesn't include it: what it needs (PlanNotice). */
  notice: ReactNode;
}) {
  const { tuning, owner } = props;
  const editable = owner && tuning.available;
  // What's stored: the form, and what was reset in it, start again as it changes.
  const stored = JSON.stringify([tuning.updatedAt, KEYS.map((key) => tuning.values[key].saved)]);
  // The values reset since the last save: Save sends "" for those, so they follow the server again.
  const [reset, setReset] = useState<{ stored: string; keys: Key[] }>({ stored, keys: [] });
  const resets = reset.stored === stored ? reset.keys : [];
  const setResets = (keys: Key[]) => setReset({ stored, keys });
  const cards = useRef<HTMLDivElement>(null);
  /** Puts the server's value back in each field, for Save. */
  const putBack = (keys: Key[], row = false) => {
    const fields = cards.current?.querySelector("form")?.elements;
    for (const key of keys) {
      const input = fields?.namedItem(key);
      const value = tuning.values[key];
      if (input instanceof HTMLInputElement || input instanceof RadioNodeList) {
        input.value = field(value.default, value.range);
      }
    }
    setResets([...new Set([...resets, ...keys])]);
    // A row's Reset goes once used: focus goes to the field it reset ("Reset to defaults" stays, and keeps it).
    if (row) {
      const input = fields?.namedItem(keys[0]!);
      const target = input instanceof RadioNodeList ? [...input].find((option) => (option as HTMLInputElement).checked) : input;
      (target as HTMLElement | null | undefined)?.focus();
    }
  };
  const resettable = KEYS.filter((key) => tuning.values[key].saved !== null && !resets.includes(key));

  return (
    <SettingsPane
      title="Advanced tuning"
      description={tuning.available && !owner ? "Only owners change these." : undefined}
      back={back}
      actions={
        editable && (
          // There with nothing to reset too, so it keeps focus once used.
          // "Reset" on phones, where the header has no room for the rest beside the way back.
          <Button type="button" variant="ghost" aria-label="Reset to defaults" disabled={resettable.length === 0} focusableWhenDisabled onClick={() => putBack(resettable)}>
            <span className="@max-[48rem]/app:hidden">Reset to defaults</span>
            <span className="@min-[48rem]/app:hidden">Reset</span>
          </Button>
        )
      }
    >
      {notice}
      <div ref={cards} className="flex flex-col gap-7">
        {editable ? (
          <TuningForm key={stored} {...props} resets={resets} setResets={setResets} onReset={(key) => putBack([key], true)} />
        ) : (
          <fieldset disabled className="flex min-w-0 flex-col gap-7">
            <TuningCards tuning={tuning} resets={resets} />
          </fieldset>
        )}
      </div>
      {lastChanged && <p className="-mt-3 text-xs text-muted-foreground">Last changed {lastChanged}</p>}
    </SettingsPane>
  );
}

/** The cards as a form of the page's, saved by "Save changes" in its header. */
function TuningForm({ projectSlug, tuning, resets, setResets, onReset }: Props & { resets: Key[]; setResets: (keys: Key[]) => void; onReset: (key: Key) => void }) {
  const { state, pending, form } = useCustomizeForm({
    save: async (prev, formData) => {
      // Only what differs from what's saved is sent, so a page opened earlier doesn't undo another owner's values: a field
      // typed back to the server's value clears the project's; a reset one clears it even where it only shows as the
      // server's (0.395 shows as 40%); an untouched one that merely shows as the server's isn't sent.
      const changes = new FormData();
      for (const key of KEYS) {
        const { saved, default: fallback, range } = tuning.values[key];
        const sent = formData.get(key);
        if (typeof sent !== "string") {
          continue;
        }
        if (!same(sent, field(saved ?? fallback, range))) {
          changes.set(key, saved !== null && same(sent, field(fallback, range)) ? "" : sent.trim());
        } else if (saved !== null && resets.includes(key) && same(sent, field(fallback, range))) {
          changes.set(key, "");
        }
      }
      const result = await saveCodeChangesTuning(projectSlug, prev, changes);
      if (!result.error) {
        toast.success("Advanced tuning saved");
      }
      return result;
    },
  });
  // What was reset is a field of the form: a reset that leaves a field's text as it was (0.495 shows as the server's
  // 50%) is still a change to save, and "Save changes" hears of each reset, which no one typed.
  const reset = useRef<HTMLInputElement>(null);
  useFieldChanged(reset, resets.join());
  return (
    // Locked while saving: the form is new once saved, so an edit made meanwhile would be lost. `inert`, not disabled
    // fields: those would drop out of what the form holds, which "Save changes" compares with what's saved.
    <form
      {...form}
      inert={pending}
      // A field edited after its Reset is the owner's again: no longer a reset.
      onInput={(event) => {
        const name = (event.target as HTMLInputElement).name as Key;
        if (resets.includes(name)) {
          setResets(resets.filter((key) => key !== name));
        }
      }}
      className="flex flex-col gap-7"
    >
      <input ref={reset} type="hidden" name="resets" value={resets.join()} />
      <TuningCards tuning={tuning} resets={resets} onReset={onReset} />
      {state.error && <FieldError className="-mt-3">{state.error}</FieldError>}
    </form>
  );
}

/** The values' rows in their two cards. `onReset`: they can be changed, so a changed one has its Reset. */
function TuningCards({ tuning, resets, onReset }: { tuning: CodeChangesTuning; resets: Key[]; onReset?: (key: Key) => void }) {
  const row = (key: Key) => {
    const value = tuning.values[key];
    const { range } = value;
    const { label, line, info } = ROWS[key];
    const own = value.saved ?? value.default;
    const id = `tuning-${key}`;
    const changed = overridden(value) && !resets.includes(key);
    const bounds = range.kind === "probability" ? ([percent(range.min, Math.ceil), percent(range.max, Math.floor)] as const) : range.kind === "integer" ? ([range.min, range.max] as const) : null;
    const between = bounds && `from ${bounds.map((bound) => bound.toLocaleString("en-US")).join(" to ")}`;
    const unit = ROWS[key].unit ?? (range.kind === "probability" ? "%" : bounds?.join("–"));
    return (
      <SettingRow
        key={key}
        label={range.kind === "options" ? <span id={`${id}-label`}>{label}</span> : label}
        htmlFor={range.kind === "options" ? undefined : id}
        // The range goes with what's behind the ⓘ, where the field has no room for it.
        info={info && `${info} ${between![0]!.toUpperCase()}${between!.slice(1)}.`}
        // A number beside its label on phones too; Thinking's options go under it there.
        inline={range.kind !== "options"}
        description={
          <span id={`${id}-help`}>
            {line}
            {changed && (
              <span className="block font-medium text-foreground">
                Changed from {shown(value.default, range)}
                {value.clamped && `: saved past this server's range, so it's used as ${shown(value.saved!, range)}`}
              </span>
            )}
          </span>
        }
      >
        {changed && onReset && (
          <Button type="button" variant="ghost" size="xs" onClick={() => onReset(key)} aria-label={`Reset ${label}`}>
            Reset
          </Button>
        )}
        {range.kind === "options" ? (
          <Segmented
            name={key}
            options={range.options.map((option) => ({ value: option, label: shown(option, range) }))}
            defaultValue={String(own)}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-help`}
            className="has-disabled:pointer-events-none has-disabled:opacity-50"
          />
        ) : (
          <span className="relative block">
            <Input
              id={id}
              name={key}
              type="number"
              inputMode="numeric"
              required
              min={bounds![0]}
              max={bounds![1]}
              step={1}
              defaultValue={field(own, range)}
              aria-describedby={`${id}-help ${id}-unit`}
              // No arrows in the field: they'd take the room its number needs (the arrow keys still step it).
              className={cn("[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none", ROWS[key].field ?? (range.kind === "probability" ? "w-24 pr-8" : "w-28 pr-14"))}
            />
            <span id={`${id}-unit`} className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-sm text-muted-foreground">
              {unit}
              {/* The range, where the field doesn't show it. */}
              {unit !== bounds!.join("–") && <span className="sr-only">, {between}</span>}
            </span>
          </span>
        )}
      </SettingRow>
    );
  };
  const sure = KEYS.filter((key) => tuning.values[key].range.kind === "probability");
  return (
    <>
      <SettingsCard title="How sure it must be">{sure.map(row)}</SettingsCard>
      <SettingsCard title="How much it reads">{KEYS.filter((key) => !sure.includes(key)).map(row)}</SettingsCard>
    </>
  );
}
