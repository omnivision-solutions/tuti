"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingRow } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, formatOf, type PropertyFormat, type PropertyFormats, isAmount, readableName } from "@/lib/property-formats";
import { setPropertyFormats } from "@/server/groups";

const FORMATS = { text: "Text", number: "Number", money: "Money", date: "Date" } as const;
/** For an amount with number values, which is a number until it's something else: "text" isn't kept (it's what a property is with nothing set), so it isn't offered. */
const AMOUNT_FORMATS = { number: FORMATS.number, money: FORMATS.money, date: FORMATS.date };
const CURRENCY_ITEMS = Object.fromEntries(CURRENCIES.map((currency) => [currency, currency]));

/** One property's row saved on top of the rest (setPropertyFormats); the error to show, if any. */
async function saveProperty(projectSlug: string, name: string, format: PropertyFormat) {
  const result = await setPropertyFormats(projectSlug, { [name]: format }).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
  if (result.error) {
    toast.error(result.error);
  } else {
    toast.success(`Saved how ${name} shows`);
  }
  return !result.error;
}

/**
 * Settings → Users → User properties: a row for each of the users' properties as the app shows it (the team's name for
 * it, else its key in words; its format, else Number for an amount with number values: `numbers`). Its format (and
 * money's currency) is changed on the row and saved at once; the name under its ⋯ menu.
 */
export function PropertyFormatsList({ projectSlug, properties, numbers, formats }: { projectSlug: string; properties: string[]; numbers: string[]; formats: PropertyFormats }) {
  return (
    <ul className="flex flex-col divide-y">
      {properties.map((name) => (
        <li key={name}>
          <PropertyRow projectSlug={projectSlug} name={name} saved={formatOf(formats, name) ?? {}} amount={numbers.includes(name) && isAmount(name)} />
        </li>
      ))}
    </ul>
  );
}

/** Left as they are, the name and format that show without the team's aren't saved, so they follow the values. */
function PropertyRow({ projectSlug, name, saved, amount }: { projectSlug: string; name: string; saved: PropertyFormat; amount: boolean }) {
  const router = useRouter();
  // What was picked shows while it saves; a save that fails puts back what's kept.
  const [format, setFormat] = useOptimistic(saved);
  const [renaming, setRenaming] = useState(false);
  const shown = format.format ?? (amount ? "number" : "text");
  const offered = amount ? AMOUNT_FORMATS : FORMATS;

  const pick = (change: PropertyFormat) =>
    startTransition(async () => {
      const next = { ...format, ...change };
      setFormat(next);
      if (await saveProperty(projectSlug, name, next)) {
        startTransition(() => router.refresh());
      }
    });

  return (
    <SettingRow label={<span className="break-all">{format.label || readableName(name)}</span>}>
      {/* As wide with a currency as without, so the keys the app sends line up in a column of their own. */}
      <div className="flex items-center gap-2 @min-[34rem]/settings:w-96">
        <code className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">{name}</code>
        <Select items={offered} value={shown} onValueChange={(value) => pick({ format: value as keyof typeof FORMATS })}>
          <SelectTrigger className="w-28 shrink-0" aria-label={`Format of ${name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(offered).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {format.format === "money" && (
          <Select items={CURRENCY_ITEMS} value={format.currency ?? "USD"} onValueChange={(value) => pick({ currency: value as (typeof CURRENCIES)[number] })}>
            <SelectTrigger className="w-22 shrink-0" aria-label={`Currency of ${name}`}>
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
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={`Actions for ${name}`} />}>
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-32">
            <DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Mounted as it opens: each time, the name kept now. */}
        <Dialog open={renaming} onOpenChange={setRenaming}>
          <DialogContent>{renaming && <RenameForm projectSlug={projectSlug} name={name} format={format} close={() => setRenaming(false)} />}</DialogContent>
        </Dialog>
      </div>
    </SettingRow>
  );
}

/** The team's own name for a property, saved with the format it has. */
function RenameForm({ projectSlug, name, format, close }: { projectSlug: string; name: string; format: PropertyFormat; close: () => void }) {
  const router = useRouter();
  const [label, setLabel] = useState(format.label ?? "");
  const [pending, startSaving] = useTransition();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        startSaving(async () => {
          if (await saveProperty(projectSlug, name, { ...format, label })) {
            close();
            router.refresh();
          }
        });
      }}
    >
      <DialogHeader>
        <DialogTitle className="wrap-anywhere">{name}</DialogTitle>
        <DialogDescription>How it shows on Users, beside a conversation and in Who&apos;s asking.</DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="property-label">Name shown</FieldLabel>
        {/* Still while it saves: an edit made meanwhile wouldn't be in what's sent. */}
        <Input id="property-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={readableName(name)} maxLength={64} readOnly={pending} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} focusableWhenDisabled>
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
