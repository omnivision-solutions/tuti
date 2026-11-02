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

/** A key's words: `company_size`, `companySize` and `company-size` are company, size (as written). */
const keyWords = (name: string) =>
  name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean);

/** Words that read as letters: `mrr` is MRR. */
const ACRONYMS = new Set(["api", "arr", "id", "ltv", "mrr", "nps", "sso", "url"]);

/**
 * A property's name until the team gives it one: its key in words, the first capitalised ("seats" is Seats,
 * "company_size" and "companySize" Company size, "mrr" MRR); a word in capitals keeps them.
 */
export function readableName(name: string): string {
  const words = keyWords(name).map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word === word.toUpperCase() ? word : word.toLowerCase()));
  const label = words.join(" ");
  return label ? label[0]!.toUpperCase() + label.slice(1) : name;
}

/** A key ending in one of these isn't an amount: an id, a time (`created_at`, `renews_on`, `start_date`). */
const NOT_AMOUNT_ENDS = new Set(["id", "at", "on", "date"]);
/** Nor one with one of these anywhere: `founded_year`, `zip_code`, `phone`, `last_login`, `created`, `trial_end`. */
const NOT_AMOUNT_WORDS = new Set([
  ...["year", "zip", "postal", "postcode", "phone", "tel", "mobile"],
  ...["timestamp", "epoch", "ts", "time", "login", "seen", "active", "visit", "created", "updated", "joined", "signup", "expires", "end", "ends"],
]);

/**
 * Whether a number property reads as an amount, so it's shown as a number (and offered to Who's asking) until the team
 * picks its format: not an id (`account_id`, `orgId`), a time (`signed_up_at`, `createdAt`, `last_login`), a year, a
 * zip code or a phone number, which show as they are.
 */
export function isAmount(name: string): boolean {
  const words = keyWords(name).map((word) => word.toLowerCase());
  return !NOT_AMOUNT_ENDS.has(words.at(-1) ?? "") && !words.some((word) => NOT_AMOUNT_WORDS.has(word));
}

/** Who's asking's suggestion: the first property that's a number or money as the team set it, else an amount. */
export const suggestedAsking = (properties: string[], formats: PropertyFormats) =>
  properties.find((name) => {
    const set = formatOf(formats, name)?.format;
    return set ? set === "number" || set === "money" : isAmount(name);
  });

/** A property's name as the team calls it, else its key in words. */
export const propertyLabel = (formats: PropertyFormats, name: string) => formatOf(formats, name)?.label || readableName(name);

/**
 * A property's value as the team formats it: a number with separators, money in its currency, a date (from a
 * timestamp in seconds or milliseconds, or text starting with an ISO date, "2026-12-01…": that calendar day, whatever
 * time zone follows) as a date. A number with no format is a number when it reads as an amount (isAmount); a value that
 * doesn't fit its format, a list or other values with no format show as they are.
 */
export function formatProperty(formats: PropertyFormats, name: string, value: PropertyValue): string {
  const set = formatOf(formats, name);
  const format: PropertyFormat | undefined = !set?.format && typeof value === "number" && isAmount(name) ? { ...set, format: "number" } : set;
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "number" && (format?.format === "number" || format?.format === "money")) {
    const money = format.format === "money" && { style: "currency" as const, currency: format.currency ?? "USD" };
    // Money shows its currency's minor units (cents: $99.50, $0.50; none for yen: ¥1,235), whole amounts and other
    // numbers none they don't need (up to 2). What that would make 0 (a number below 1, money below half its smallest
    // unit) keeps three significant digits ($0.0042).
    const places = money ? new Intl.NumberFormat("en-US", money).resolvedOptions().maximumFractionDigits! : 2;
    const tiny = value !== 0 && Math.abs(value) < (money ? 0.5 / 10 ** places : 1);
    const minimum = money && !Number.isInteger(value) ? places : 0;
    const digits = tiny ? { maximumSignificantDigits: 3 } : { minimumFractionDigits: minimum, maximumFractionDigits: places };
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
