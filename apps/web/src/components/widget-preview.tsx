"use client";

import { usePreview } from "@/components/customize-shell";
import { textColorOn } from "@/lib/colors";
import { cn } from "@/lib/utils";

/**
 * Customize → Widget's preview: the widget open on a stand-in for the team's site, its panel (the
 * portal's /widget, which any site may frame) above the launcher, in its corner.
 */
export function WidgetPreview({ src, ...saved }: { src: string; label: string; color: string; position: "bottom-right" | "bottom-left" }) {
  const { version, draft } = usePreview();
  // As the team is setting it, before it's saved.
  const { label, color, position } = draft.widget ?? saved;
  const left = position === "bottom-left";
  return (
    <div aria-label="Widget preview" role="figure" className="relative flex flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
      {/* The team's site, sketched. */}
      <div aria-hidden className="flex flex-col gap-3 p-6">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="h-3 w-3/4 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
        <div className="h-3 w-1/2 rounded bg-muted" />
      </div>
      <div className={cn("absolute bottom-5 flex flex-col gap-3", left ? "left-5 items-start" : "right-5 items-end")}>
        <iframe
          key={version}
          title="Widget panel preview"
          src={src}
          className="h-[min(600px,calc(100svh-14rem))] w-[min(400px,calc(100vw-5rem))] rounded-[14px] border bg-background shadow-lg"
        />
        <span
          className="rounded-full px-[18px] py-3 text-sm leading-none font-semibold shadow-md"
          style={{ background: color, color: textColorOn(color) }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}
