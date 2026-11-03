import { cn } from "cn";
import Link from "next/link";
import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Reporting's pages: the numbers of the last 30 days, a chart of them by day, then the lists behind them. */

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

/** A report page's heading, and what it covers. */
export function ReportHeading({ section, title, children }: { section: string; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{section}</p>
      <h2 className="font-heading text-xl font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{children}</p>
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
 * Counts by day as bars, up to two series stacked (the first at the bottom, in Reporting's blue, the second in orange): a legend for two,
 * each day's numbers on hover, and a table of them for screen readers.
 */
export function DailyChart({ title, days, series }: { title: string; days: string[]; series: { label: string; values: number[] }[] }) {
  const totals = days.map((_, i) => series.reduce((total, s) => total + s.values[i]!, 0));
  const top = niceMax(Math.max(...totals));
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>{title}</CardTitle>
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
              {days.map((day, i) => (
                <div key={day} className="group relative flex h-full flex-1 flex-col justify-end hover:bg-muted/60">
                  {/* Top first: column-reverse would put the first series on top. */}
                  {[...series.keys()].reverse().map((s) =>
                    series[s]!.values[i]! > 0 ? (
                      <div
                        key={s}
                        className={cn("mx-auto w-full max-w-4 shrink-0 not-last:mb-0.5 first:rounded-t", SERIES_COLOURS[s])}
                        style={{ height: `${(series[s]!.values[i]! / top) * 100}%` }}
                      />
                    ) : null,
                  )}
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md group-hover:block">
                    <p className="font-medium">{dayLabel(day)}</p>
                    {series.map((s, j) => (
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
              <span>{dayLabel(days[0]!)}</span>
              <span>{dayLabel(days[Math.floor(days.length / 2)]!)}</span>
              <span>{dayLabel(days.at(-1)!)}</span>
            </div>
          </div>
        </div>
        <table className="sr-only">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th>Day</th>
              {series.map((s) => (
                <th key={s.label}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => (
              <tr key={day}>
                <th>{dayLabel(day)}</th>
                {series.map((s) => (
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
