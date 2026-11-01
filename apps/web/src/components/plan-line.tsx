"use client";

import { CheckIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PlanLine } from "@/lib/pricing-plans";

/** One line of what a plan includes; a line with more to say opens it in a card when clicked. */
export function PlanLineItem({ line }: { line: PlanLine }) {
  return (
    <li className="flex gap-2.5">
      <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={2.5} />
      {line.more ? (
        <Popover>
          <PopoverTrigger className="cursor-pointer text-left underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 hover:decoration-foreground">
            {line.text}
          </PopoverTrigger>
          <PopoverContent className="w-80 p-4">
            <p className="font-semibold">{line.more.title}</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm text-muted-foreground">
              {line.more.points.map((point) => (
                <li key={point} className="flex gap-2">
                  <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  {point}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : (
        line.text
      )}
    </li>
  );
}

/** Monthly or yearly, as native radios (arrow keys move between them). */
export function BilledToggle({ value, onChange, yearlyNote }: { value: "month" | "year"; onChange: (value: "month" | "year") => void; yearlyNote?: string }) {
  return (
    <div role="radiogroup" aria-label="Billed" className="flex w-fit gap-1 rounded-lg bg-muted p-1">
      {(["month", "year"] as const).map((each) => (
        <label
          key={each}
          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input type="radio" name="billed" value={each} checked={value === each} onChange={() => onChange(each)} className="sr-only" />
          {each === "month" ? "Monthly" : "Yearly"}
          {each === "year" && yearlyNote && <span className="rounded-full bg-soft px-2 py-0.5 text-xs font-semibold text-soft-foreground">{yearlyNote}</span>}
        </label>
      ))}
    </div>
  );
}
