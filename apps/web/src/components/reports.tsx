import { cn } from "cn";
import Link from "next/link";
import type { ReactNode } from "react";

import { ReportRangePicker } from "@/components/report-range-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RangeKey } from "@/lib/report-range";

/** Reporting's pages: a range's numbers, a chart of them over its days, then the lists behind them. */

export const count = (value: number) => value.toLocaleString("en");
export const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;
/** "75%" of `part` in `whole`, or "–" with nothing to divide. */
export const percent = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);

/** "45 min", "3 h 5 min", "2 d 4 h": a time to reply, to the minute. */
export function duration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`;
}

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
const monthLabel = (day: string, month: "short" | "long") =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { month, year: "numeric", timeZone: "UTC" });

/**
 * A report page's heading, as Ferndesk's: its part of Reporting in the primary colour, its title, and the date range picker (no sentence
 * under it: design.md).
 */
export function ReportHeading({ section, title, range }: { section: string; title: string; range: RangeKey }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs font-semibold tracking-wider text-primary uppercase">{section}</p>
        <h2 className="font-heading text-2xl font-semibold tracking-tight">{title}</h2>
      </div>
      <ReportRangePicker current={range} />
    </div>
  );
}

/** A row of numbers, each with what it counts (and, with `href`, a link to its list). */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function Stat({ label, value, hint, href }: { label: string; value: ReactNode; hint: string; href?: string }) {
  const body = (
    <>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </>
  );
  // A group named by its label: the number is found by what it counts.
  return (
    <div role="group" aria-label={label} className="rounded-xl border bg-card">
      {href ? (
        <Link href={href} className="flex h-full flex-col gap-1 rounded-xl p-4 transition-colors hover:bg-muted/50">
          {body}
        </Link>
      ) : (
        <div className="flex h-full flex-col gap-1 p-4">{body}</div>
      )}
    </div>
  );
}

const SERIES_COLOURS = ["bg-series-1", "bg-series-2"] as const;

/** The smallest of 1, 2 or 5 times a power of ten at or above `max`: the chart's top line. */
export function niceMax(max: number) {
  if (max <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((step) => step * power).find((top) => top >= max)!;
}

/**
 * A chart's bars for `days`: a day each up to a month, a week each (from the first day) up to a quarter, else a calendar month each.
 * `from`/`to`: the days it sums (`to` past its last).
 */
export function chartBars(days: string[]): { unit: "day" | "week" | "month"; bars: { label: string; title: string; from: number; to: number }[] } {
  if (days.length <= 31) {
    return { unit: "day", bars: days.map((day, i) => ({ label: dayLabel(day), title: dayLabel(day), from: i, to: i + 1 })) };
  }
  if (days.length <= 92) {
    const bars = [];
    for (let from = 0; from < days.length; from += 7) {
      const to = Math.min(from + 7, days.length);
      bars.push({ label: dayLabel(days[from]!), title: `${dayLabel(days[from]!)} – ${dayLabel(days[to - 1]!)}`, from, to });
    }
    return { unit: "week", bars };
  }
  const bars: { label: string; title: string; from: number; to: number }[] = [];
  days.forEach((day, i) => {
    if (i === 0 || day.slice(0, 7) !== days[i - 1]!.slice(0, 7)) bars.push({ label: monthLabel(day, "short"), title: monthLabel(day, "long"), from: i, to: i + 1 });
    else bars.at(-1)!.to = i + 1;
  });
  return { unit: "month", bars };
}

/**
 * Counts over a range's days as bars (by day, week or month: chartBars), up to two series stacked (the first at the bottom, in
 * Reporting's blue, the second in orange): a legend for two, a bar's numbers on hover, and a table of them for screen readers.
 */
export function DailyChart({ title, days, series }: { title: string; days: string[]; series: { label: string; values: number[] }[] }) {
  const { unit, bars } = chartBars(days);
  const sumOf = (values: number[], bar: { from: number; to: number }) => values.slice(bar.from, bar.to).reduce((a, b) => a + b, 0);
  const values = series.map((s) => ({ label: s.label, values: bars.map((bar) => sumOf(s.values, bar)) }));
  const top = niceMax(Math.max(...bars.map((_, i) => values.reduce((total, s) => total + s.values[i]!, 0))));
  const heading = `${title} by ${unit}`;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>{heading}</CardTitle>
        {series.length > 1 && (
          <ul aria-hidden className="flex gap-4 text-xs text-muted-foreground">
            {series.map((s, i) => (
              <li key={s.label} className="flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", SERIES_COLOURS[i])} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </CardHeader>
      <CardContent>
        <div aria-hidden className="flex gap-2">
          {/* The scale: the top, the middle and 0. */}
          <div className="flex h-40 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums">
            {[top, top / 2, 0].map((value) => (
              <span key={value} className="-my-2">
                {Number.isInteger(value) ? count(value) : ""}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="relative flex h-40 items-end gap-0.5 border-b">
              <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed" />
              <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed" />
              {bars.map((bar, i) => (
                <div key={bar.from} className="group relative flex h-full flex-1 flex-col justify-end hover:bg-muted/60">
                  {/* Top first: column-reverse would put the first series on top. */}
                  {[...values.keys()].reverse().map((s) =>
                    values[s]!.values[i]! > 0 ? (
                      <div
                        key={s}
                        className={cn("mx-auto w-full max-w-4 shrink-0 not-last:mb-0.5 first:rounded-t", SERIES_COLOURS[s])}
                        style={{ height: `${(values[s]!.values[i]! / top) * 100}%` }}
                      />
                    ) : null,
                  )}
                  {/* Over its bar, but kept inside the chart at its ends: from the first bars' left, to the last bars' right. */}
                  <div
                    className={cn(
                      "pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md group-hover:block",
                      i < bars.length / 6 ? "left-0" : i >= bars.length - bars.length / 6 ? "right-0" : "left-1/2 -translate-x-1/2",
                    )}
                  >
                    <p className="font-medium">{bar.title}</p>
                    {values.map((s, j) => (
                      <p key={s.label} className="flex items-center gap-1.5 tabular-nums">
                        {series.length > 1 && <span className={cn("size-2 rounded-full", SERIES_COLOURS[j])} />}
                        {s.label}: {count(s.values[i]!)}
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{bars[0]!.label}</span>
              {bars.length > 2 && <span>{bars[Math.floor(bars.length / 2)]!.label}</span>}
              {bars.length > 1 && <span>{bars.at(-1)!.label}</span>}
            </div>
          </div>
        </div>
        <table className="sr-only">
          <caption>{heading}</caption>
          <thead>
            <tr>
              <th>{unit === "day" ? "Day" : unit === "week" ? "Week" : "Month"}</th>
              {values.map((s) => (
                <th key={s.label}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bars.map((bar, i) => (
              <tr key={bar.from}>
                <th>{bar.title}</th>
                {values.map((s) => (
                  <td key={s.label}>{s.values[i]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
