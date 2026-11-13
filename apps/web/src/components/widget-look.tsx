"use client";

import { ExternalLinkIcon } from "lucide-react";
import { createContext, type ReactNode, use, useEffect, useState } from "react";

import { PORTAL_FONT_CLASSES } from "@/components/portal-fonts";
import { inPreview } from "@/components/portal-look";
import { type FromPortal, isToPortal, WIDGET_ROW, WIDGET_TILE, type WidgetLook, widgetOnly, type WidgetPart } from "@/lib/portal-look";
import { cn } from "@/lib/utils";

const WidgetLookContext = createContext<WidgetLook>({ links: [], title: "", greeting: "", hidden: [] });

/** The panel's settings: as saved, or in the preview as the team is trying them. */
export const useWidgetLook = () => use(WidgetLookContext);

/**
 * The panel's settings as saved; in Customize → Widget's preview (a frame named PREVIEW_FRAME), what the
 * team is trying, from the app (`appOrigin` only), which it tells it's ready for.
 */
export function WidgetLookProvider({ saved, appOrigin, children }: { saved: WidgetLook; appOrigin: string; children: ReactNode }) {
  const [draft, setDraft] = useState<Partial<WidgetLook>>({});
  useEffect(() => {
    if (!inPreview()) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin === appOrigin && event.source === window.parent && isToPortal(event.data) && event.data.type === "tuti:widget") {
        setDraft(widgetOnly(event.data.widget));
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: "tuti:ready", path: window.location.pathname } satisfies FromPortal, appOrigin);
    return () => window.removeEventListener("message", onMessage);
  }, [appOrigin]);
  return <WidgetLookContext value={{ ...saved, ...draft }}>{children}</WidgetLookContext>;
}

/**
 * The panel's fonts (`style`, portalFontStyle's) on <body> too, for what opens over the panel at its end (toasts, dialogs),
 * as PortalLookProvider does on the portal.
 */
export function WidgetBodyFonts({ style }: { style: Record<string, string> }) {
  const json = JSON.stringify(style);
  useEffect(() => {
    const body = document.body;
    const classes = PORTAL_FONT_CLASSES.split(" ");
    const properties = Object.entries(JSON.parse(json) as Record<string, string>).map(([key, value]) => [key === "fontFamily" ? "font-family" : key, value]);
    body.classList.add(...classes);
    for (const [key, value] of properties) {
      body.style.setProperty(key!, value!);
    }
    return () => {
      body.classList.remove(...classes);
      for (const [key] of properties) {
        body.style.removeProperty(key!);
      }
    };
  }, [json]);
  return null;
}

/** `children` (Home's card for a part, or its tab) unless the team turned the part off. */
export function WidgetPart({ part, children }: { part: WidgetPart; children: ReactNode }) {
  return useWidgetLook().hidden.includes(part) ? null : children;
}

/** Home's heading: the team's, or "How can we help?". */
export function WidgetTitle() {
  return <p className="font-heading text-2xl font-bold break-words">{useWidgetLook().title || "How can we help?"}</p>;
}

/** Home's quick links (Customize → Widget), each opening in a new tab: rows in Home's last list. */
export function WidgetQuickLinks() {
  const { links } = useWidgetLook();
  if (links.length === 0) {
    return null;
  }
  return (
    <nav aria-label="Quick links">
      <ul className="flex flex-col divide-y">
        {links.map((link, i) => (
          <li key={i}>
            <a href={link.url} target="_blank" rel="noopener noreferrer" className={cn(WIDGET_ROW, "break-words")}>
              <span className={WIDGET_TILE}>
                <ExternalLinkIcon aria-hidden />
              </span>
              <span className="min-w-0 flex-1 font-medium">{link.label}</span>
              <ExternalLinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
