"use client";

import { useEffect, useId, useRef, useState } from "react";

import { usePreview } from "@/components/customize-shell";
import { textColorOn } from "@/lib/colors";
import { isFromPortal, PREVIEW_FRAME, type ToPortal } from "@/lib/portal-look";
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
 * Customize → Widget's preview: a stand-in for the team's site, in a browser window, with the launcher, a
 * round button with its icon, in its corner, and the panel open above it (the portal's /widget, which any
 * site may frame, showing the quick links as they're set): what the team came to see. The launcher closes
 * and opens it, as readers will.
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
  const links = draft.widget?.links;
  const left = position === "bottom-left";
  const [open, setOpen] = useState(true);
  // How many times the panel said it's up (each page that opens in it starts from what's saved).
  const [ready, setReady] = useState(0);
  const panelId = useId();
  // The panel's Close (and Escape in it) asks its page to close it, as the loader does on the team's site.
  const panel = useRef<HTMLIFrameElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  // Open from the start, focus stays where it is: only the launcher's click puts it in the panel.
  const clicked = useRef(false);
  // Tuti's own widget in the app is hidden here (below): closed first, so on a phone, where its open panel
  // makes the rest of the page inert, the page is let go.
  useEffect(() => window.Tuti?.close(), []);
  useEffect(() => {
    if (!open) {
      return;
    }
    // Opened, focus goes into the panel, as the loader puts it there on the site.
    if (clicked.current) {
      panel.current?.focus();
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== panel.current?.contentWindow) {
        return;
      }
      if (event.data === WIDGET_CLOSE_MESSAGE) {
        setOpen(false);
        // Focus was in the panel: back to the launcher, as on the site.
        launcher.current?.focus();
      } else if (event.origin === new URL(src).origin && isFromPortal(event.data)) {
        setReady((count) => count + 1);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, src]);
  // The quick links as they're set, to the panel: on each change, and whenever it's up.
  useEffect(() => {
    const target = panel.current?.contentWindow;
    if (ready && target && links) {
      target.postMessage({ type: "tuti:widget", widget: { links } } satisfies ToPortal, new URL(src).origin);
    }
  }, [ready, links, src]);
  return (
    // At least 22rem, so the open panel keeps some 13rem under the window's bar on a short window (the pane scrolls instead).
    <div aria-label="Widget preview" role="figure" className="relative flex min-h-[22rem] flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
      {/* Tuti's own launcher in the app (and its panel) would sit on this one's corner: away while it's here. */}
      <style>{`#tuti-widget, body > button[aria-controls="tuti-widget"] { display: none !important; }`}</style>
      {/* The browser's bar, and the team's site, sketched. */}
      <div aria-hidden className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <span className="flex gap-1.5">
          {[0, 1, 2].map((dot) => (
            <span key={dot} className="size-2.5 rounded-full bg-muted-foreground/25" />
          ))}
        </span>
        <span className="mx-auto h-4 w-1/3 rounded-full bg-muted" />
      </div>
      <div aria-hidden className="flex items-center gap-4 border-b px-6 py-4">
        <div className="h-5 w-20 rounded bg-muted-foreground/25" />
        <div className="ml-auto h-3 w-12 rounded bg-muted" />
        <div className="h-3 w-12 rounded bg-muted" />
        <div className="h-3 w-12 rounded bg-muted" />
      </div>
      <div aria-hidden className="flex flex-col gap-3 px-6 pt-8">
        <div className="h-6 w-1/2 rounded bg-muted-foreground/20" />
        <div className="h-3 w-3/4 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
        <div className="mt-4 grid grid-cols-3 gap-4">
          {[0, 1, 2].map((card) => (
            <div key={card} className="h-20 rounded-lg bg-muted/60" />
          ))}
        </div>
      </div>
      {/* The panel takes up to 600px of the window's height under its bar, above the launcher. */}
      <div className={cn("absolute top-14 bottom-5 flex flex-col justify-end gap-3", left ? "left-5 items-start" : "right-5 items-end")}>
        {open && (
          <iframe
            ref={panel}
            id={panelId}
            key={version}
            // Takes the quick links as they're set, from the app only (see WidgetLookProvider).
            name={PREVIEW_FRAME}
            title="Widget panel preview"
            src={src}
            className="h-[600px] min-h-0 w-[min(400px,calc(100vw-5rem))] rounded-[14px] border bg-background shadow-lg"
          />
        )}
        <button
          ref={launcher}
          type="button"
          aria-label={`Launcher: ${label}`}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          title={label}
          onClick={() => {
            clicked.current = true;
            setOpen((was) => !was);
          }}
          className="flex size-14 shrink-0 cursor-pointer items-center justify-center rounded-full shadow-md"
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
