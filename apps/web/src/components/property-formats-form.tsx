"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, type PropertyFormat, type PropertyFormats } from "@/lib/property-formats";
import { setPropertyFormats } from "@/server/groups";

const FORMATS = { text: "Text", number: "Number", money: "Money", date: "Date" } as const;
const CURRENCY_ITEMS = Object.fromEntries(CURRENCIES.map((currency) => [currency, currency]));

/**
 * Settings → Access → User properties: for each of the users' properties, the name the app shows for it and its format
 * (money in a currency), saved together.
 */
export function PropertyFormatsForm({ projectSlug, properties, formats }: { projectSlug: string; properties: string[]; formats: PropertyFormats }) {
  const [draft, setDraft] = useState(formats);
  // The properties changed here: only those are sent, so what someone else saved since stays.
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const set = (name: string, change: PropertyFormat) => {
    setDraft((current) => ({ ...current, [name]: { ...(Object.hasOwn(current, name) ? current[name] : {}), ...change } }));
    setChanged((current) => new Set(current).add(name));
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const changes = Object.fromEntries([...changed].map((name) => [name, draft[name]!]));
          const result = await setPropertyFormats(projectSlug, changes).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
          if (result.error) {
            toast.error(result.error);
          } else {
            setChanged(new Set());
            toast.success("Saved how properties show");
          }
        });
      }}
    >
      <ul aria-label="User properties" className="flex flex-col divide-y">
        {properties.map((name) => {
          const format = Object.hasOwn(draft, name) ? draft[name]! : {};
          return (
            <li key={name} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
              <code className="min-w-0 text-sm break-all sm:w-40 sm:shrink-0">{name}</code>
              <Input
                value={format.label ?? ""}
                onChange={(event) => set(name, { label: event.target.value })}
                placeholder={name}
                maxLength={64}
                aria-label={`Name shown for ${name}`}
                className="sm:flex-1"
              />
              {/* The same width with or without a currency, so the names line up. */}
              <div className="flex gap-2 sm:w-54 sm:shrink-0">
                <Select items={FORMATS} value={format.format ?? "text"} onValueChange={(value) => set(name, { format: value as keyof typeof FORMATS })}>
                  <SelectTrigger className="w-full sm:flex-1" aria-label={`Format of ${name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(FORMATS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {format.format === "money" && (
                  <Select items={CURRENCY_ITEMS} value={format.currency ?? "USD"} onValueChange={(value) => set(name, { currency: value as (typeof CURRENCIES)[number] })}>
                    <SelectTrigger className="w-full sm:flex-1" aria-label={`Currency of ${name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((currency) => (
                        <SelectItem key={currency} value={currency}>
                          {currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
