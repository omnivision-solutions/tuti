import { planNeeded, reportingRangeNeeded } from "@tuti/shared";
import { cn } from "cn";
import { ArrowDownRightIcon, ArrowUpRightIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { Children, isValidElement, type ReactNode } from "react";

import { Pane, PaneBody, PaneHeader } from "@/components/pane";
import { ReportRangePicker } from "@/components/report-range-picker";
import { RovingList } from "@/components/roving-list";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { type RangeKey, RANGES, rangeDates, type ReportRange, reportRange } from "@/lib/report-range";

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
/** A Searches tile's line when the range reaches back past the searches kept: "Since Oct 5" (or null). */
export const searchesSince = (day: string | null) => (day ? `Since ${dayLabel(day)}` : null);

const monthLabel = (day: string, month: "short" | "long") =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { month, year: "numeric", timeZone: "UTC" });

/**
 * A report page: a pane titled by the report, the date range picker in its header (the ranges the plan doesn't have, `locked`, shown but
 * not picked), then its content (`ReportBody`) in one centred column.
 */
export function ReportPane({
  title,
  range,
  locked,
  upgrade,
  children,
}: {
  title: string;
  range: ReportRange;
  locked: RangeKey[];
  upgrade: { slug: string; admin: boolean } | null;
  children: ReactNode;
}) {
  // Each range's days as of the page's range's day (its numbers' day): one clock reading for the page, even across midnight.
  const picker = (
    <ReportRangePicker
      current={range.key}
      dates={Object.fromEntries(RANGES.map(({ key }) => [key, rangeDates(reportRange(key, new Date(range.today)))])) as Record<RangeKey, string>}
      locked={locked}
      lockedHint={reportingRangeNeeded()}
    />
  );
  return (
    <Pane aria-label={title}>
      {/* At the header's right; on phones in a row of its own under the title, which keeps its room. */}
      {/* None on a plan without Reporting: its ranges would only redraw the made-up numbers behind the card. */}
      <PaneHeader
        title={title}
        filters={!upgrade && <div className="@min-[48rem]/app:hidden">{picker}</div>}
        actions={!upgrade && <div className="hidden @min-[48rem]/app:contents">{picker}</div>}
      />
      <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <ReportBody upgrade={upgrade}>{children}</ReportBody>
        </div>
      </PaneBody>
    </Pane>
  );
}

/**
 * A report page's content. With `upgrade` (a plan without Reporting: made-up numbers, see reportingPage), blurred and out of reach under a
 * card saying which plan has it, with the way to Billing for owners and admins. Each page decides it, as it decides the numbers: the layout
 * stays as the team moves between pages, so it could disagree with them.
 */
function ReportBody({ upgrade, children }: { upgrade: { slug: string; admin: boolean } | null; children: ReactNode }) {
  if (!upgrade) {
    return children;
  }
  return (
    <div className="relative flex flex-col gap-6">
      {/* Less blurred on phones, where the chart's bars are thin: more would melt them into a wave. */}
      <div aria-hidden inert className="flex flex-col gap-6 blur-[3px] select-none sm:blur-sm">
        {children}
      </div>
      <div className="absolute inset-0 flex justify-center px-4 pt-16">
        <Card className="sticky top-1/3 h-fit w-full max-w-sm text-center shadow-lg">
          <CardHeader>
            <LockIcon aria-hidden className="mx-auto size-5 text-muted-foreground" />
            <CardTitle>
              <h2>See how your help center, AI and inbox are doing</h2>
            </CardTitle>
            <CardDescription>{planNeeded("reporting")}</CardDescription>
          </CardHeader>
          <CardContent>
            {upgrade.admin ? (
              <Link href={`/app/${upgrade.slug}/settings/billing`} className={buttonVariants()}>
                See plans
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">An owner or admin can upgrade.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * A row of numbers, as `StatStrip` (one card, side by side between lines; under 40rem two tiles to a row), each with what it counts (and, with `href`, a link to its list); with `compared`, a line under them saying what
 * their changes are on (so it's seen without hovering a badge), where one has a change.
 */
export function Stats({ children, compared }: { children: ReactNode; compared?: ReportRange }) {
  const changed = Children.toArray(children).some((child) => isValidElement<{ trend?: Trend }>(child) && child.props.trend?.change);
  return (
    <div className="@container/stats flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 @min-[40rem]/stats:flex @min-[40rem]/stats:gap-0 @min-[40rem]/stats:overflow-hidden @min-[40rem]/stats:rounded-xl @min-[40rem]/stats:shadow-xs @min-[40rem]/stats:ring-1 @min-[40rem]/stats:ring-border">
        {children}
      </div>
      {compared && changed && <p className="text-xs text-muted-foreground">Changes are on {daysBefore(compared)}.</p>}
    </div>
  );
}

/** "the 30 days before" a range ("the day before" one day): what its numbers' changes are on. */
const daysBefore = ({ previous }: ReportRange) => (previous.days.length === 1 ? "the day before" : `the ${count(previous.days.length)} days before`);

/**
 * A tile's change on the previous days (ReportRange's `previous`, as many just before) and its line over the range's (summed as the
 * chart's bars are, a period under way left out: lineBars). `good`: which way is better, coloured so (none: neither); a tile whose rise needs the team (`good: "down"`)
 * draws its line in the orange its chart gives it.
 */
export type Trend = {
  change: { direction: "up" | "down" | "same"; text: string; said: string; tone: "better" | "worse" | "neither" } | null;
  line: (number | null)[];
  good?: "up" | "down";
};

function trend(range: ReportRange, difference: { by: number; text: string } | null, line: (number | null)[], good?: "up" | "down"): Trend {
  if (!difference) {
    return { change: null, line, good };
  }
  const before = daysBefore(range);
  const direction = difference.by > 0 ? "up" : difference.by < 0 ? "down" : "same";
  const tone = direction === "same" || !good ? "neither" : direction === good ? "better" : "worse";
  const said = direction === "same" ? `Same as ${before}` : `${direction === "up" ? "Up" : "Down"} ${difference.text} on ${before}`;
  return { change: { direction, text: difference.text, said, tone }, line, good };
}

/**
 * `now` against `before` in per cent: none from less than one (nothing, or the sliver of a day before today's first hours: a view would
 * read as a rise of thousands of per cent), or not known.
 */
const relative = (now: number | null, before: number | null) => {
  if (now === null || before === null || before < 1) return null;
  const by = Math.round(((now - before) / before) * 100);
  return { by, text: `${count(Math.abs(by))}%` };
};

const sumOf = (values: number[], bar: { from: number; to: number }) => values.slice(bar.from, bar.to).reduce((a, b) => a + b, 0);

/** A tile's line's periods: its chart's bars, without one still under way (it would read as a fall), unless that leaves one. */
function lineBars(range: ReportRange) {
  const { bars } = chartBars(range.days, range.today);
  return bars.length > 2 && bars.at(-1)!.soFar ? bars.slice(0, -1) : bars;
}

/** A count's tile: its total against the previous days' (`before`; null when they aren't known). */
export function countTrend(range: ReportRange, values: number[], before: number | null, good?: "up" | "down"): Trend {
  const line = lineBars(range).map((bar) => sumOf(values, bar));
  return trend(range, relative(sumOf(values, { from: 0, to: values.length }), before), line, good);
}

/** A share's tile (`part` of `whole`, as `percent` shows it): the change in percentage points. */
export function shareTrend(range: ReportRange, part: number[], whole: number[], before: { part: number; whole: number } | null, good?: "up" | "down"): Trend {
  // None of less than one whole, as relative.
  const share = (p: number, w: number) => (w < 1 ? null : Math.round((p / w) * 100));
  const line = lineBars(range).map((bar) => share(sumOf(part, bar), sumOf(whole, bar)));
  const now = share(sumOf(part, { from: 0, to: part.length }), sumOf(whole, { from: 0, to: whole.length }));
  const then = before && share(before.part, before.whole);
  const difference = now === null || then === null ? null : { by: now - then, text: plural(Math.abs(now - then), "pt", "pts") };
  return trend(range, difference, line, good);
}

/** "Found it helpful": readers' answers to "Was this helpful?" that were "Yes", from a docs report's days and the previous days' totals. */
export function helpfulTrend(
  range: ReportRange,
  { daily, before }: { daily: { helpful: number[]; notHelpful: number[] }; before: { helpful: number; notHelpful: number } },
) {
  const answers = daily.helpful.map((helpful, i) => helpful + daily.notHelpful[i]!);
  return shareTrend(range, daily.helpful, answers, { part: before.helpful, whole: before.helpful + before.notHelpful }, "up");
}

/** A time's tile (a median, in seconds): its change in per cent, and no line. */
export const timeTrend = (range: ReportRange, now: number | null, before: number | null, good?: "up" | "down"): Trend =>
  trend(range, relative(now, before), [], good);

const TONES = { better: "soft", worse: "destructive", neither: "secondary" } as const;

/** A tile's line: the range's values, top to bottom of its own (a share's missing days left out); none with fewer than two. */
function Sparkline({ line, good }: { line: (number | null)[]; good?: "up" | "down" }) {
  const known = line.flatMap((value, i) => (value === null ? [] : [{ x: (i / (line.length - 1)) * 100, value }]));
  if (known.length < 2) return null;
  const max = Math.max(...known.map((point) => point.value), 1);
  return (
    <svg aria-hidden viewBox="0 0 100 32" preserveAspectRatio="none" className={cn("mt-auto h-8 w-full overflow-visible", good === "down" ? "text-series-2" : "text-series-1")}>
      <polyline
        points={known.map((point) => `${point.x},${30 - (point.value / max) * 28}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Stat({ label, value, hint, href, trend }: { label: string; value: ReactNode; hint: string; href?: string; trend?: Trend }) {
  const change = trend?.change;
  const Arrow = change?.direction === "down" ? ArrowDownRightIcon : ArrowUpRightIcon;
  const body = (
    <>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-heading text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        {change && (
          <Badge variant={TONES[change.tone]} className="tabular-nums">
            {change.direction !== "same" && <Arrow aria-hidden />}
            <span aria-hidden>{change.text}</span>
            <span className="sr-only">{change.said}</span>
          </Badge>
        )}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
      {trend && <Sparkline line={trend.line} good={trend.good} />}
    </>
  );
  // A group named by its label: the number is found by what it counts.
  return (
    <div
      role="group"
      aria-label={label}
      className="min-w-0 rounded-xl bg-card shadow-xs ring-1 ring-border @min-[40rem]/stats:flex-1 @min-[40rem]/stats:rounded-none @min-[40rem]/stats:shadow-none @min-[40rem]/stats:ring-0 @min-[40rem]/stats:not-first:border-l"
    >
      {href ? (
        <Link href={href} className="flex h-full flex-col gap-1 rounded-[inherit] p-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @min-[40rem]/stats:px-5">
          {body}
        </Link>
      ) : (
        <div className="flex h-full flex-col gap-1 p-4 @min-[40rem]/stats:px-5">{body}</div>
      )}
    </div>
  );
}

const SERIES_COLOURS = ["bg-series-1", "bg-series-2"] as const;
/** A period under way: a dashed outline in its series' colour (as readable as the bar) around a light fill of it. */
const SO_FAR_COLOURS = ["border-2 border-dashed border-series-1 bg-series-1/20", "border-2 border-dashed border-series-2 bg-series-2/20"] as const;

/** The smallest of 1, 2 or 5 times a power of ten at or above `max`: the chart's top line. */
export function niceMax(max: number) {
  if (max <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((step) => step * power).find((top) => top >= max)!;
}

type Bar = { label: string; title: string; from: number; to: number; soFar?: boolean };

/**
 * A chart's bars for `days`: a day each up to a month, a week each (from the first day) up to a quarter, else a calendar month each.
 * `from`/`to`: the days it sums (`to` past its last). The last one is `soFar` when it holds `today` (UTC, `YYYY-MM-DD`): a period still
 * under way, drawn lighter and said so, so it doesn't read as a fall.
 */
export function chartBars(days: string[], today = new Date().toISOString().slice(0, 10)): { unit: "day" | "week" | "month"; bars: Bar[] } {
  const chart = bars(days);
  const last = chart.bars.at(-1);
  if (last && days[last.to - 1] === today) {
    last.soFar = true;
    last.title += " (so far)";
  }
  return chart;
}

function bars(days: string[]): { unit: "day" | "week" | "month"; bars: Bar[] } {
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
  const bars: Bar[] = [];
  days.forEach((day, i) => {
    if (i === 0 || day.slice(0, 7) !== days[i - 1]!.slice(0, 7)) bars.push({ label: monthLabel(day, "short"), title: monthLabel(day, "long"), from: i, to: i + 1 });
    else bars.at(-1)!.to = i + 1;
  });
  // The range's first and last months may be partial: their titles say the days they sum.
  for (const bar of bars) {
    const [first, last] = [days[bar.from]!, days[bar.to - 1]!];
    const monthEnd = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)), 0)).getUTCDate();
    if (first.slice(8) !== "01" || Number(last.slice(8)) !== monthEnd) bar.title = `${dayLabel(first)} – ${dayLabel(last)}, ${first.slice(0, 4)}`;
  }
  return { unit: "month", bars };
}

/**
 * Counts over a range's days as bars (by day, week or month: chartBars), up to two series stacked (the first at the bottom, in
 * Reporting's blue, the second in orange): a legend for two, and a bar's numbers on hover or when it has focus (read out as its label).
 * None for a single day (Today, Yesterday): one bar says nothing the numbers above it don't, and views are only counted by day.
 */
export function DailyChart({ title, days, today, series }: { title: string; days: string[]; today: string; series: { label: string; values: number[] }[] }) {
  if (days.length < 2) {
    return null;
  }
  // The range's own today (ReportRange's), as its tiles have it: not the clock once the report's queries are done.
  const { unit, bars } = chartBars(days, today);
  const values = series.map((s) => ({ label: s.label, values: bars.map((bar) => sumOf(s.values, bar)) }));
  const top = niceMax(Math.max(...bars.map((_, i) => values.reduce((total, s) => total + s.values[i]!, 0))));
  const heading = `${title} by ${unit}`;
  return (
    <Card>
      {/* On phones the legend has a row of its own, under the title. */}
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
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
        <div className="flex gap-2">
          {/* The scale: the top, the middle and 0. */}
          <div aria-hidden className="flex h-40 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums">
            {[top, top / 2, 0].map((value) => (
              <span key={value} className="-my-2">
                {Number.isInteger(value) ? count(value) : ""}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* One Tab stop (the latest bar), ← → to the others; a bar with focus (or tapped on a phone) shows its numbers as hovering does, and is read as them. */}
            {/* Keyed by its days: another range's chart starts afresh, its Tab stop the latest bar (RovingList moves it in the DOM). */}
            <RovingList key={`${days[0]}-${days.length}`} aria-label={heading} className="relative flex h-40 items-end gap-0.5 border-b">
              <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed" />
              <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed" />
              {bars.map((bar, i) => (
                <div
                  key={bar.from}
                  role="listitem"
                  tabIndex={i === bars.length - 1 ? 0 : -1}
                  aria-label={`${bar.title}: ${values.map((s) => `${s.label} ${count(s.values[i]!)}`).join(", ")}`}
                  className="group relative flex h-full flex-1 flex-col justify-end outline-none hover:bg-muted/60 focus:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* Top first: column-reverse would put the first series on top. */}
                  {[...values.keys()].reverse().map((s) =>
                    values[s]!.values[i]! > 0 ? (
                      <div
                        key={s}
                        className={cn("mx-auto w-full max-w-4 shrink-0 not-last:mb-0.5 first:rounded-t", (bar.soFar ? SO_FAR_COLOURS : SERIES_COLOURS)[s])}
                        style={{ height: `${(values[s]!.values[i]! / top) * 100}%` }}
                      />
                    ) : null,
                  )}
                  {/* Over its bar, but kept inside the chart at its ends: from the first bars' left, to the last bars' right. */}
                  <div
                    className={cn(
                      "pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md group-hover:block group-focus:block",
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
            </RovingList>
            <div aria-hidden className="flex justify-between text-xs text-muted-foreground">
              <span>{bars[0]!.label}</span>
              {bars.length > 2 && <span>{bars[Math.floor(bars.length / 2)]!.label}</span>}
              {bars.length > 1 && <span>{bars.at(-1)!.soFar ? `${bars.at(-1)!.label}, so far` : bars.at(-1)!.label}</span>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
