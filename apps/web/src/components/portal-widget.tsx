"use client";

import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

/**
 * The project's own widget on its portal (Customize → Widget): the loader's tag, in the page as sent, for readers who may
 * read the portal (`shown`); its panel at the portal's address, under `base` for one under a path of the team's site. Its launcher and panel are the loader's, outside React, and outlive client navigations. Once
 * who's reading changes (signing in or out, `viewer`) or the page may no longer show the portal, a panel opened before has
 * the last reader's page in it: a full load starts afresh. Never opened, it has nothing of theirs (on a private portal its
 * panel would only ask them to sign in; signing out of one is a full load anyway, to its sign-in page).
 * Its launcher and panel go over the page and its sticky header (z-40), under the portal's sheets and dialogs (z-50: the
 * assistant, the menu), which cover an open panel until they close; the panel stays a level over the launcher, as the
 * loader has them (on a phone it's the whole screen). On phones the page ends clear of the launcher.
 */
export function PortalWidget({
  src,
  slug,
  base,
  launcher,
  shown,
  viewer,
}: {
  src: string;
  slug: string;
  base: string;
  /** Its launcher; without it (turned off on the portal), the panel opens only for Ask AI. */
  launcher: boolean;
  shown: boolean;
  viewer: string | null;
}) {
  // Its panel in the page's light or dark mode (a reader's pick on the portal's footer switch), not only the default's.
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" | null = resolvedTheme === "dark" || resolvedTheme === "light" ? resolvedTheme : null;
  useEffect(() => {
    if (!theme) {
      return;
    }
    const follow = () => window.Tuti?.setTheme?.(theme);
    if (window.Tuti) {
      follow();
      return;
    }
    // The loader still loading (an async tag; React's onLoad on it would keep it from running): once it has.
    const tag = document.querySelector("script[data-on-portal]");
    tag?.addEventListener("load", follow, { once: true });
    return () => tag?.removeEventListener("load", follow);
  }, [theme]);
  const last = useRef({ shown, viewer });
  useEffect(() => {
    if (shown === last.current.shown && viewer === last.current.viewer) {
      return;
    }
    last.current = { shown, viewer };
    if (document.querySelector("#tuti-widget iframe")) {
      window.location.reload();
    }
  }, [shown, viewer]);
  if (!shown) {
    return null;
  }
  return (
    <>
      {/* Room at the end of the page on phones only for a launcher there is. While the panel is the whole screen (the
          loader's `data-covering`), no room kept for a scrollbar: the fixed panel would stop short of it, leaving a strip
          of the portal down its side. Closed, the room stays, so the header doesn't shift between pages. (Unlayered, over
          the portal's base rule.) */}
      <style>{`body > button[aria-controls="tuti-widget"] { z-index: 45 !important; } #tuti-widget { z-index: 46 !important; } @media (width <= 640px) { html:has(#tuti-widget[data-covering]) { scrollbar-gutter: auto; } }${launcher ? " @media (width < 48rem) { body { padding-bottom: 5.5rem; } }" : ""}`}</style>
      <script src={src} data-project={slug} data-on-portal={base} {...(!launcher && { "data-hide-launcher": "" })} async />
    </>
  );
}
