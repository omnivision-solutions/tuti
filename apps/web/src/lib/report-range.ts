/** Reporting's date ranges (the picker beside each page's title, `?range=`), in whole UTC days. */

export const RANGES = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "month", label: "Month to date" },
  { key: "last-month", label: "Last month" },
  { key: "7d", label: "Past 7 days" },
  { key: "14d", label: "Past 14 days" },
  { key: "30d", label: "Past 30 days" },
  { key: "quarter", label: "Past quarter" },
  { key: "year", label: "Past year" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];
export const RANGE_KEYS = RANGES.map((range) => range.key) as [RangeKey, ...RangeKey[]];
export const DEFAULT_RANGE: RangeKey = "30d";

/** A range's days: from `since` (its first day, 00:00 UTC) up to `until` (the day after its last), and each day as `YYYY-MM-DD`. */
export type ReportRange = { key: RangeKey; label: string; since: Date; until: Date; days: string[] };

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
  const days = Array.from({ length: Math.round((until.getTime() - since.getTime()) / DAY) }, (_, i) => day(new Date(since.getTime() + i * DAY)));
  return { key: range.key, label: range.label, since, until, days };
}

/** `href` with the range kept (`?range=`, left out for the default), so moving between Reporting's pages keeps it. */
export function withRange(href: string, key: RangeKey) {
  if (key === DEFAULT_RANGE) return href;
  return `${href}${href.includes("?") ? "&" : "?"}range=${key}`;
}
