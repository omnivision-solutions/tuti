"use client";

import { useEffect, useRef, useState } from "react";

import { usePreview } from "@/components/customize-shell";
import { textColorOn } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { WIDGET_CLOSE_MESSAGE } from "@/lib/widget-messages";
import { WIDGET_ICONS, type WidgetIcon, type WidgetIconName } from "@/lib/widget-icons";

/** A built-in launcher icon, drawn as the loader draws it (in the text colour). */
export function LauncherIcon({ name, className }: { name: WidgetIconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-7", className)}
    >
      {WIDGET_ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * Customize → Widget's preview: a stand-in for the team's site with the launcher, a round button with its
 * icon, in its corner, closed as readers first see it; clicking it opens the panel above it (the portal's
 * /widget, which any site may frame), and again closes it.
 */
export function WidgetPreview({
  src,
  ...saved
}: {
  src: string;
  label: string;
  color: string;
  position: "bottom-right" | "bottom-left";
  /** As the launcher shows it: "chat" where the plan doesn't include picking one. */
  icon: WidgetIcon;
  iconUrl: string | null;
}) {
  const { version, draft } = usePreview();
  // As the team is setting it, before it's saved.
  const { label, color, position, icon, iconUrl } = draft.widget ?? saved;
  const left = position === "bottom-left";
  const [open, setOpen] = useState(false);
  // The panel's Close (and Escape in it) asks its page to close it, as the loader does on the team's site.
  const panel = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source === panel.current?.contentWindow && event.data === WIDGET_CLOSE_MESSAGE) {
        setOpen(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);
  return (
    <div aria-label="Widget preview" role="figure" className="relative flex flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
      {/* The team's site, sketched. */}
      <div aria-hidden className="flex flex-col gap-3 p-6">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="h-3 w-3/4 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
        <div className="h-3 w-1/2 rounded bg-muted" />
      </div>
      {!open && <p className="px-6 text-sm text-muted-foreground">Click the launcher to open the widget, as your readers will.</p>}
      <div className={cn("absolute bottom-5 flex flex-col gap-3", left ? "left-5 items-start" : "right-5 items-end")}>
        {open && (
          <iframe
            ref={panel}
            key={version}
            title="Widget panel preview"
            src={src}
            className="h-[min(600px,calc(100svh-15rem))] w-[min(400px,calc(100vw-5rem))] rounded-[14px] border bg-background shadow-lg"
          />
        )}
        <button
          type="button"
          aria-label={`Launcher: ${label}`}
          aria-expanded={open}
          title={label}
          onClick={() => setOpen((was) => !was)}
          className="flex size-14 cursor-pointer items-center justify-center rounded-full shadow-md"
          style={{ background: color, color: textColorOn(color) }}
        >
          {icon === "image" && iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
            <img src={iconUrl} alt="" className="size-7 object-contain" />
          ) : (
            <LauncherIcon name={icon === "image" ? "chat" : icon} />
          )}
        </button>
      </div>
    </div>
  );
}
