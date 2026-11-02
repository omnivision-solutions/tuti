"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ItemList, ItemRow } from "@/components/item-list";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, formatOf, type PropertyFormat, type PropertyFormats, propertyLabel, readableName } from "@/lib/property-formats";
import { setPropertyFormats } from "@/server/groups";

const FORMATS = { text: "Text", number: "Number", money: "Money", date: "Date" } as const;
const CURRENCY_ITEMS = Object.fromEntries(CURRENCIES.map((currency) => [currency, currency]));

/** How a property shows, in words: "Money, EUR", "Text". */
const describe = (format: PropertyFormat | undefined, shown: keyof typeof FORMATS) => (shown === "money" ? `Money, ${format?.currency ?? "USD"}` : FORMATS[shown]);

/**
 * Settings → Access → User properties: each of the users' properties as the app shows it (the team's name for it, else
 * its key in words; its format, else Number for one with number values: `numbers`); Edit changes one.
 */
export function PropertyFormatsList({ projectSlug, properties, numbers, formats }: { projectSlug: string; properties: string[]; numbers: string[]; formats: PropertyFormats }) {
  return (
    <ItemList>
      {properties.map((name) => {
        const format = formatOf(formats, name);
        const shown = format?.format ?? (numbers.includes(name) ? "number" : "text");
        const label = propertyLabel(formats, name);
        return (
          <ItemRow
            key={name}
            title={<span className="break-all">{label}</span>}
            meta={<span className="break-all">{[label !== name && name, describe(format, shown)].filter(Boolean).join(" · ")}</span>}
            actions={<PropertyFormatDialog projectSlug={projectSlug} name={name} format={format ?? {}} shown={shown} />}
          />
        );
      })}
    </ItemList>
  );
}

/**
 * One property's name shown and format (money's currency), saved on its own (on top of the rest: setPropertyFormats).
 * Left as they are, the name and format that show without them (`shown`) aren't saved, so they follow the values.
 */
function PropertyFormatDialog({ projectSlug, name, format, shown }: { projectSlug: string; name: string; format: PropertyFormat; shown: keyof typeof FORMATS }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(format);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Each time it opens, what's kept now.
        if (next) {
          setDraft(format);
        }
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" aria-label={`Edit ${name}`} />}>Edit</DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(async () => {
              const result = await setPropertyFormats(projectSlug, { [name]: draft }).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
              if (result.error) {
                toast.error(result.error);
                return;
              }
              toast.success(`Saved how ${name} shows`);
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <DialogHeader>
            <DialogTitle className="wrap-anywhere">{name}</DialogTitle>
            <DialogDescription>How it shows on Users, beside a conversation and in Who&apos;s asking.</DialogDescription>
          </DialogHeader>
          {/* Still while it saves: an edit made meanwhile wouldn't be in what's sent. */}
          <fieldset disabled={pending} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="property-label">Name shown</FieldLabel>
              <Input id="property-label" value={draft.label ?? ""} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder={readableName(name)} maxLength={64} />
            </Field>
            <div className="flex gap-2">
              <Field className="flex-1">
                <FieldLabel>Format</FieldLabel>
                <Select items={FORMATS} value={draft.format ?? shown} onValueChange={(value) => setDraft({ ...draft, format: value as keyof typeof FORMATS })}>
                  <SelectTrigger className="w-full" aria-label="Format">
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
              </Field>
              {draft.format === "money" && (
                <Field className="flex-1">
                  <FieldLabel>Currency</FieldLabel>
                  <Select items={CURRENCY_ITEMS} value={draft.currency ?? "USD"} onValueChange={(value) => setDraft({ ...draft, currency: value as (typeof CURRENCIES)[number] })}>
                    <SelectTrigger className="w-full" aria-label="Currency">
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
                </Field>
              )}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
