"use client";

import { useState, useTransition } from "react";

import { SettingRow } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { buyCredits } from "@/server/credits";

const AMOUNTS = [10, 25, 50, 100];

/** "Buy credits", a row of Settings → Billing: an amount in dollars, then Stripe's payment page. */
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
    <SettingRow
      label="Buy credits"
      description={
        <>
          {valid ? `${(dollars * perDollar).toLocaleString("en")} credits` : `From $${min} to $${max.toLocaleString("en")}`}
          {days === null ? ", for good." : `, lasting ${days.toLocaleString("en")} days.`}
        </>
      }
    >
      <div className="flex flex-col gap-2 @min-[34rem]/settings:items-end">
        <div className="flex flex-wrap items-center gap-2">
          {/* An amount: one of the presets, or Other for any other. */}
          <Segmented
            name="amount"
            aria-label="Amount"
            options={[...AMOUNTS.map((amount) => ({ value: String(amount), label: `$${amount}` })), { value: "other", label: "Other" }]}
            value={other ? "other" : String(dollars)}
            onValueChange={(amount) => {
              setOther(amount === "other");
              if (amount !== "other") {
                setDollars(Number(amount));
              }
            }}
          />
          {other && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              $
              <Input
                aria-label="Amount in US dollars"
                aria-invalid={!valid || undefined}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                step={1}
                value={Number.isNaN(dollars) ? "" : dollars}
                onChange={(event) => setDollars(event.target.valueAsNumber)}
                className="w-24 text-foreground"
              />
            </span>
          )}
          <Button type="button" variant="outline" disabled={pending || !valid} focusableWhenDisabled onClick={buy}>
            {pending ? "Opening Stripe…" : "Buy"}
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </div>
    </SettingRow>
  );
}
