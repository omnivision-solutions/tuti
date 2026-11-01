import { z } from "zod";

import type { PropertyValue } from "./user-properties";

/**
 * How the team shows its users' properties (project.update's `propertyFormats`): a name of its own ("MRR" for `mrr`)
 * and a format, set once for everywhere they're shown (Users, the Inbox's person panel, Who's asking).
 */

export const PROPERTY_FORMATS = ["text", "number", "money", "date"] as const;
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "SEK", "INR", "JPY", "BRL"] as const;
export const MAX_PROPERTY_FORMATS = 100;

export const propertyFormat = z.object({
  label: z.string().trim().max(64, "Names are up to 64 characters").optional(),
  format: z.enum(PROPERTY_FORMATS).optional(),
  currency: z.enum(CURRENCIES).optional(),
});
export type PropertyFormat = z.infer<typeof propertyFormat>;
export type PropertyFormats = Record<string, PropertyFormat>;

/** The project's formats as stored; anything unreadable is left out. */
export function storedPropertyFormats(json: unknown): PropertyFormats {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {};
  }
  const formats: [string, PropertyFormat][] = [];
  for (const [name, value] of Object.entries(json)) {
    const parsed = propertyFormat.safeParse(value);
    if (parsed.success) {
      formats.push([name, parsed.data]);
    }
  }
  // fromEntries, so a name like "__proto__" is a property like any other.
  return Object.fromEntries(formats);
}

/** The format the team set for a property, if any (its own, not one every object has). */
export const formatOf = (formats: PropertyFormats, name: string) => (Object.hasOwn(formats, name) ? formats[name] : undefined);

/** A property's name as the team calls it. */
export const propertyLabel = (formats: PropertyFormats, name: string) => formatOf(formats, name)?.label || name;

/**
 * A property's value as the team formats it: a number with separators, money in its currency, a date (from a
 * timestamp in seconds or milliseconds, or text starting with an ISO date, "2026-12-01…": that calendar day, whatever
 * time zone follows) as a date. A value that doesn't fit its format, a list or a property with no format shows as it is.
 */
export function formatProperty(formats: PropertyFormats, name: string, value: PropertyValue): string {
  const format = formatOf(formats, name);
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "number" && (format?.format === "number" || format?.format === "money")) {
    const money = format.format === "money" && { style: "currency" as const, currency: format.currency ?? "USD" };
    // Money with cents shows both digits ($99.50); whole amounts and other numbers none they don't need. Below 1, three
    // significant digits, so a small one isn't 0 ($0.004).
    const cents = money && !Number.isInteger(value) ? 2 : 0;
    const digits = value !== 0 && Math.abs(value) < 1 ? { maximumSignificantDigits: 3 } : { minimumFractionDigits: cents, maximumFractionDigits: 2 };
    return value.toLocaleString("en-US", { ...money, ...digits });
  }
  const isoDay = typeof value === "string" ? /^\d{4}-\d{2}-\d{2}(?![\d])/.exec(value)?.[0] : undefined;
  if (format?.format === "date" && (typeof value === "number" || isoDay)) {
    // Seconds since 1970 until 1e11 (the year 5138), milliseconds past it; a day on its own is read as UTC.
    const date = new Date(typeof value === "number" ? (Math.abs(value) < 1e11 ? value * 1000 : value) : isoDay!);
    // A day that doesn't exist ("2026-02-30", which Date makes 2 March) shows as it is.
    if (!Number.isNaN(date.getTime()) && (isoDay === undefined || date.toISOString().startsWith(isoDay))) {
      return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    }
  }
  return String(value);
}
