"use client";

import { useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { buyCredits } from "@/server/credits";

const AMOUNTS = [10, 25, 50, 100];

/** "Buy credits" (Settings → Billing): an amount in dollars, then Stripe's payment page. */
export function BuyCredits({
  projectSlug,
  perDollar,
  days,
  min,
  max,
}: {
  projectSlug: string;
  /** Credits a dollar buys. */
  perDollar: number;
  /** How long they last; null for good. */
  days: number | null;
  min: number;
  max: number;
}) {
  const [dollars, setDollars] = useState(25);
  const [other, setOther] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const buy = () =>
    startTransition(async () => {
      const result = await buyCredits(projectSlug, dollars);
      setError(result.error);
      if (result.url) {
        window.location.assign(result.url);
      }
    });
  const valid = Number.isInteger(dollars) && dollars >= min && dollars <= max;

  return (
    <div className="flex flex-col gap-4">
      {/* An amount: one of the presets, or Other for any other. Native radios: arrow keys move between them. */}
      <div role="radiogroup" aria-label="Amount" className="flex flex-wrap gap-2">
        {[...AMOUNTS, "other" as const].map((amount) => (
          <label
            key={amount}
            className={buttonVariants({
              variant: "outline",
              className: "cursor-pointer has-checked:border-primary has-checked:bg-soft has-checked:text-soft-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
            })}
          >
            <input
              type="radio"
              name="amount"
              className="sr-only"
              checked={amount === "other" ? other : !other && dollars === amount}
              onChange={() => {
                setOther(amount === "other");
                if (amount !== "other") {
                  setDollars(amount);
                }
              }}
            />
            {amount === "other" ? "Other amount" : `$${amount}`}
          </label>
        ))}
      </div>
      <Field data-invalid={error ? true : undefined}>
        {other && <FieldLabel htmlFor="topup-dollars">Amount in US dollars</FieldLabel>}
        {other && (
          <Input
            id="topup-dollars"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={Number.isNaN(dollars) ? "" : dollars}
            onChange={(event) => setDollars(event.target.valueAsNumber)}
            className="w-40"
          />
        )}
        <FieldDescription>
          {valid ? `${(dollars * perDollar).toLocaleString("en")} AI credits` : `From $${min} to $${max.toLocaleString("en")}`}
          {days === null ? ", for good." : `, lasting ${days.toLocaleString("en")} days.`} You pay on Stripe.
        </FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <div>
        <Button type="button" variant="outline" disabled={pending || !valid} onClick={buy}>
          {pending ? "Opening Stripe…" : "Buy credits"}
        </Button>
      </div>
    </div>
  );
}
