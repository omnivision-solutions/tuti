import { cn } from "@/lib/utils";

type Sure = { kind: string; probability: number; confidence: string };

/**
 * How sure Autopilot is of an update: the percent, and whether that's likely by its kind's threshold
 * (`confidence`, worked out on the server: what's ticked as the page opens). Null for the changelog
 * line, which isn't a guess: it only rewords a bullet in a draft.
 */
export function sureness(update: Sure): { percent: number; likely: boolean; label: string } | null {
  if (update.kind === "changelog_line") {
    return null;
  }
  const percent = Math.round(update.probability * 100);
  const likely = update.confidence === "likely";
  return { percent, likely, label: `${likely ? "Likely" : "Not sure"}: ${percent}% sure` };
}

/** A ring filled to how sure Autopilot is, the percent in it: green when likely, orange when not sure (said in its label too). */
export function ConfidenceRing({ update, className }: { update: Sure; className?: string }) {
  const sure = sureness(update);
  if (!sure) {
    return null;
  }
  // A radius of 100/2π: the circumference is 100, so the dash is the percent.
  const circle = { cx: 18, cy: 18, r: 15.9155, fill: "none", strokeWidth: 3.5 };
  return (
    <span
      role="img"
      aria-label={sure.label}
      title={sure.label}
      className={cn("relative inline-flex size-9 shrink-0 items-center justify-center", sure.likely ? "text-primary" : "text-highlight-foreground", className)}
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle {...circle} className="stroke-muted" />
        <circle {...circle} stroke="currentColor" strokeLinecap="round" strokeDasharray={`${sure.percent} 100`} />
      </svg>
      <span className="text-[0.625rem] font-semibold tabular-nums">{sure.percent}%</span>
    </span>
  );
}
