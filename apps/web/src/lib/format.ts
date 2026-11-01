import { formatOf, formatProperty, propertyLabel, type PropertyFormats } from "./property-formats";

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/** "3 days ago", "yesterday", "just now". */
export function timeAgo(date: Date, now = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}

/** A day, like "19 October 2026" (UTC, so server and browser agree). */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** How long since `date`, short: "5m", "3h", "2d" (under a minute is "1m"). */
export function shortDuration(date: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Who's asking: a post's voters' total of a number property ("12,400 mrr"), in the team's name and format for it
 * ("$12,400 MRR"); without a number format, a small one keeps its digits ("0.004 mrr").
 */
export function asking(total: number, property: string, formats: PropertyFormats = {}): string {
  return `${askingTotal(total, property, formats)} ${propertyLabel(formats, property)}`;
}

/** Who's asking's number on its own ("$12,400", "0.004"), as asking() shows it: for a column headed with the property. */
export function askingTotal(total: number, property: string, formats: PropertyFormats = {}): string {
  const format = formatOf(formats, property)?.format;
  const digits = Math.abs(total) < 1 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 };
  return format === "number" || format === "money" ? formatProperty(formats, property, total) : total.toLocaleString("en-US", digits);
}

/** Text as people see its characters: a flag, an emoji with a skin tone or a joined family is one. */
const graphemes = (text: string) => Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text), (part) => part.segment);

/** A message's first line with something on it, cut short past `max` characters (as seen: an emoji stays whole). */
export function firstLine(text: string, max = 140): string | undefined {
  const line = text.split("\n").find((part) => part.trim())?.trim();
  const characters = line === undefined ? [] : graphemes(line);
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : line;
}

/** A name's first character, as an avatar shows it (a whole emoji, not part of one). */
export const initial = (name: string) => (graphemes(name.trim())[0] ?? "?").toUpperCase();

/** A subject from the first line of the first message, when none is given. */
export const subjectFrom = (text: string) => {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * What an Inbox row shows of a conversation's latest message beside its subject: its first line (firstLine), unless it
 * says the same as the subject, or the subject was made from it (subjectFrom, a conversation started without one).
 */
export function rowLine(subject: string, body: string): string | undefined {
  const line = firstLine(body);
  return line !== undefined && line !== subject && subjectFrom(body) !== subject ? line : undefined;
}
