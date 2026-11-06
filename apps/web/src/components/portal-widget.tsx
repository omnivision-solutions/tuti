"use client";

import { useEffect, useRef } from "react";

/**
 * The project's own widget on its portal (Customize → Widget): the loader's tag, in the page as sent, for readers who may
 * read the portal (`shown`). Its launcher and panel are the loader's, outside React, and outlive client navigations. Once
 * who's reading changes (signing in or out, `viewer`) or the page may no longer show the portal, a panel opened before has
 * the last reader's page in it: a full load starts afresh. Never opened, it has nothing of theirs (on a private portal its
 * panel would only ask them to sign in; signing out of one is a full load anyway, to its sign-in page).
 * Its launcher and panel go over the page and its sticky header (z-40), under the portal's sheets and dialogs (z-50: the
 * assistant, the menu), which cover an open panel until they close; the panel stays a level over the launcher, as the
 * loader has them (on a phone it's the whole screen). On phones the page ends clear of the launcher. Under a path of the
 * team's site (`base`, e.g. /help) the loader opens that path's /widget.
 */
export function PortalWidget({ src, slug, base, shown, viewer }: { src: string; slug: string; base: string; shown: boolean; viewer: string | null }) {
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
      <style>{`body > button[aria-controls="tuti-widget"] { z-index: 45 !important; } #tuti-widget { z-index: 46 !important; } @media (width < 48rem) { body { padding-bottom: 5.5rem; } }`}</style>
      <script src={src} data-project={slug} data-on-portal="" data-base={base || undefined} async />
    </>
  );
}
