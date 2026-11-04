/** Reporting's date ranges (the picker beside each page's title, `?range=`), in whole UTC days, in the picker's groups. */

export const RANGES = [
  { key: "today", label: "Today", group: "day" },
  { key: "yesterday", label: "Yesterday", group: "day" },
  { key: "month", label: "Month to date", group: "month" },
  { key: "last-month", label: "Last month", group: "month" },
  { key: "7d", label: "Past 7 days", group: "past" },
  { key: "14d", label: "Past 14 days", group: "past" },
  { key: "30d", label: "Past 30 days", group: "past" },
  { key: "quarter", label: "Past quarter", group: "past" },
  { key: "year", label: "Past year", group: "past" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];
export const RANGE_KEYS = RANGES.map((range) => range.key) as [RangeKey, ...RangeKey[]];
export const DEFAULT_RANGE: RangeKey = "30d";

/**
 * A range's days: from `since` (its first day, 00:00 UTC) up to `until` (the day after its last), and each day as `YYYY-MM-DD`;
 * `previous`, as many days just before it (up to `since`), that its numbers are compared with; `today`, the day it was worked out on.
 */
export type ReportRange = {
  key: RangeKey;
  label: string;
  since: Date;
  until: Date;
  days: string[];
  previous: { since: Date; days: string[] };
  today: string;
};

const DAY = 86_400_000;
const day = (date: Date) => date.toISOString().slice(0, 10);

/** The range `key` names (the default for anything else), as of `now`. "Past 7 days" and the like end today, today included. */
export function reportRange(key: string | undefined, now = new Date()): ReportRange {
  const range = RANGES.find((r) => r.key === key) ?? RANGES.find((r) => r.key === DEFAULT_RANGE)!;
  const today = new Date(day(now));
  const tomorrow = new Date(today.getTime() + DAY);
  const daysBack = (count: number) => new Date(today.getTime() - (count - 1) * DAY);
  const monthStart = (monthsBack: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1));
  const [since, until] = (
    {
      today: [today, tomorrow],
      yesterday: [new Date(today.getTime() - DAY), today],
      month: [monthStart(0), tomorrow],
      "last-month": [monthStart(1), monthStart(0)],
      "7d": [daysBack(7), tomorrow],
      "14d": [daysBack(14), tomorrow],
      "30d": [daysBack(30), tomorrow],
      quarter: [daysBack(90), tomorrow],
      year: [daysBack(365), tomorrow],
    } satisfies Record<RangeKey, [Date, Date]>
  )[range.key];
  const daysFrom = (start: Date, count: number) => Array.from({ length: count }, (_, i) => day(new Date(start.getTime() + i * DAY)));
  const days = daysFrom(since, Math.round((until.getTime() - since.getTime()) / DAY));
  const previousSince = new Date(since.getTime() - days.length * DAY);
  return { key: range.key, label: range.label, since, until, days, previous: { since: previousSince, days: daysFrom(previousSince, days.length) }, today: day(now) };
}

/** `href` with the range kept (`?range=`, left out for the default), so moving between Reporting's pages keeps it. */
export function withRange(href: string, key: RangeKey) {
  if (key === DEFAULT_RANGE) return href;
  return `${href}${href.includes("?") ? "&" : "?"}range=${key}`;
}

/** The days a range covers, as the picker shows them: "Oct 5 – Nov 3", "Oct 1 – 31", "Nov 3"; the years when it spans two. */
export function rangeDates({ since, until }: ReportRange) {
  const last = new Date(until.getTime() - DAY);
  const year = since.getUTCFullYear() !== last.getUTCFullYear() ? { year: "numeric" as const } : {};
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC", ...year }).formatRange(since, last);
}
