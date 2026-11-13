"use client";

import { useRouter } from "next/navigation";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { usePortalPath } from "@/components/portal-base";
import { PORTAL_FONT_CLASSES } from "@/components/portal-fonts";
import { inPreview, LookContext, showTheme } from "@/components/portal-look";
import { brandCss } from "@/lib/colors";
import { CUSTOMIZE } from "@/lib/portal-base";
import { portalFontStyle } from "@/lib/portal-fonts";
import { type FromPortal, isToPortal, type PortalLook, styleText, webOnly } from "@/lib/portal-look";
import { cn } from "@/lib/utils";

/*
 * The portal's look provider, apart from components/portal-look.tsx: only the portal's own pages ((site)/layout.tsx) import
 * it, and with it the portal's fonts (components/portal-fonts.ts, Inter preloaded as the default), so the widget's page,
 * which uses portal-look's parts, doesn't fetch them.
 */

/**
 * The portal's look (its accent colour as CSS, and for the parts that show it). In Customize's
 * preview (a frame named PREVIEW_FRAME), it also takes changes not saved yet and light or dark mode
 * from the app (`appOrigin` only), says which page is open, keeps the preview at the portal's Tuti
 * address as people click around in it, and opens other sites' links in a new tab.
 */
export function PortalLookProvider({ saved, appOrigin, children }: { saved: PortalLook; appOrigin: string; children: ReactNode }) {
  const [draft, setDraft] = useState<Partial<PortalLook>>({});
  const router = useRouter();
  const path = usePortalPath();

  useEffect(() => {
    if (!inPreview()) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== appOrigin || event.source !== window.parent || !isToPortal(event.data)) {
        return;
      }
      if (event.data.type === "tuti:look") {
        setDraft(webOnly(event.data.look));
      } else if (event.data.type === "tuti:theme") {
        showTheme(event.data.theme);
      }
    };
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const url = new URL(link.href);
      event.preventDefault();
      if (url.origin !== window.location.origin) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      url.searchParams.set(CUSTOMIZE.param, CUSTOMIZE.value);
      router.push(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("message", onMessage);
    // Before Next.js's own link handling, which would drop the preview's param.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("click", onClick, true);
    };
  }, [appOrigin, router]);

  useEffect(() => {
    if (inPreview()) {
      window.parent.postMessage({ type: "tuti:ready", path } satisfies FromPortal, appOrigin);
    }
  }, [appOrigin, path]);

  // The default colour scheme, being tried in the preview: once per change of it, so the preview's own
  // light and dark mode still win until it changes again.
  const tried = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (inPreview() && draft.colorScheme && draft.colorScheme !== tried.current) {
      tried.current = draft.colorScheme;
      showTheme(draft.colorScheme);
    }
  }, [draft.colorScheme]);

  const look = { ...saved, ...draft };
  const css = brandCss(look.color);
  // The team's fonts, else Inter (portalFontStyle): a wrapper that adds nothing to the layout (display: contents) but
  // passes them down.
  const fonts = portalFontStyle(look.fonts) as CSSProperties;
  // What opens over the page (dialogs, menus, toasts) is put at the end of <body>, outside the wrapper: the fonts there too.
  const fontStyle = JSON.stringify(fonts);
  useEffect(() => {
    const body = document.body;
    const classes = PORTAL_FONT_CLASSES.split(" ");
    const style = JSON.parse(fontStyle) as Record<string, string>;
    body.classList.add(...classes);
    for (const [key, value] of Object.entries(style)) {
      body.style.setProperty(key === "fontFamily" ? "font-family" : key, value);
    }
    return () => {
      body.classList.remove(...classes);
      for (const key of Object.keys(style)) {
        body.style.removeProperty(key === "fontFamily" ? "font-family" : key);
      }
    };
  }, [fontStyle]);
  return (
    <LookContext value={look}>
      {css && <style>{css}</style>}
      <div className={cn("contents", PORTAL_FONT_CLASSES)} style={fonts}>
        {children}
      </div>
      {/* The team's own CSS (Customize → Custom code), after everything else. */}
      {look.customCss && <style>{styleText(look.customCss)}</style>}
    </LookContext>
  );
}

