import { cn } from "@/lib/utils";

type Sure = { kind: string; probability: number; confidence: string };

/** How sure, in three: likely (green) by its kind's threshold; not sure (orange); unlikely (red), under 60%. */
export type Sureness = { percent: number; likely: boolean };

const LEVELS = {
  likely: { word: "Likely", className: "text-primary" },
  unsure: { word: "Not sure", className: "text-highlight-foreground" },
  unlikely: { word: "Unlikely", className: "text-destructive" },
};

/** Its level: likely by its kind's threshold, else under 60% is unlikely. */
const levelOf = ({ percent, likely }: Sureness) => (likely ? "likely" : percent < 60 ? "unlikely" : "unsure");

/** "Not sure: 71% sure". */
export const sureLabel = (sure: Sureness) => `${LEVELS[levelOf(sure)].word}: ${sure.percent}% sure`;

/**
 * How sure Autopilot is of an update: the percent, and whether that's likely by its kind's threshold
 * (`confidence`, worked out on the server: what's ticked as the page opens). Null for the changelog
 * line, which isn't a guess: it only rewords a bullet in a draft.
 */
export function sureness(update: Sure): (Sureness & { label: string }) | null {
  if (update.kind === "changelog_line") {
    return null;
  }
  // Rounded down: 74.6% under a 75% threshold reads 74%, never the likely 75% (past float noise: 0.57 is 57%).
  const percent = Math.floor(update.probability * 100 + 1e-9);
  const likely = update.confidence === "likely";
  return { percent, likely, label: sureLabel({ percent, likely }) };
}

/**
 * A ring filled to how sure Autopilot is, the percent in it: green when likely, orange when not sure, red
 * when unlikely (said in its label too). An update's (`update`), or a change's on average (`sure`, `small`:
 * the list's, the percent without its sign).
 */
export function ConfidenceRing({ update, sure: given, small = false, className }: { update?: Sure; sure?: Sureness; small?: boolean; className?: string }) {
  const sure = given ?? (update && sureness(update));
  if (!sure) {
    return null;
  }
  const level = LEVELS[levelOf(sure)];
  const label = given ? `${sureLabel(sure)} on average` : sureLabel(sure);
  // A radius of 100/2π: the circumference is 100, so the dash is the percent.
  const circle = { cx: 18, cy: 18, r: 15.9155, fill: "none", strokeWidth: 3.5 };
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("relative inline-flex shrink-0 items-center justify-center", small ? "size-7" : "size-9", level.className, className)}
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle {...circle} className="stroke-muted" />
        <circle {...circle} stroke="currentColor" strokeLinecap="round" strokeDasharray={`${sure.percent} 100`} />
      </svg>
      <span className={cn("font-semibold tabular-nums", small ? "text-[0.5625rem]" : "text-[0.625rem]")}>
        {sure.percent}
        {!small && "%"}
      </span>
    </span>
  );
}
