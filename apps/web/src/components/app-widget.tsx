"use client";

import { usePathname } from "next/navigation";
import Script from "next/script";
import { useEffect } from "react";

import { PORTAL_PAGE_PATH } from "@/lib/portal-pages";
import { appWidgetToken } from "@/server/app-widget";

declare global {
  interface Window {
    Tuti?: { identify: (getToken: () => Promise<string | null>) => void; close: () => void };
  }
}

/** Whether the team app is showing: the widget gets the account's token only then. */
let shown = false;

const getToken = () => (shown ? appWidgetToken().then((result) => result.token ?? null) : Promise.resolve(null));

/**
 * Tuti's own widget in the team app, for APP_WIDGET_PROJECT (`slug`), installed as any app installs
 * it (docs/widget.md): the script tag, then `Tuti.identify` with a token for the signed-in account.
 * Leaving the team app (signing out goes to the home page without a reload, where the launcher
 * stays) signs its panels out, as does a script that loads only after that; coming back asks again.
 * Not on Settings' Portal pages, whose previews show the team's own widget, nor in the Inbox, where the team chats with its own
 * customers: it isn't installed there, and if it came from another page it's closed (on a phone its open panel makes
 * the page inert) and hidden.
 */
export function AppWidget({ slug }: { slug: string }) {
  useEffect(() => {
    shown = true;
    window.Tuti?.identify(getToken);
    return () => {
      shown = false;
      window.Tuti?.identify(getToken);
    };
  }, []);
  const pathname = usePathname();
  const away = /^\/app\/[^/]+\/inbox(\/|$)/.test(pathname) || PORTAL_PAGE_PATH.test(pathname);
  useEffect(() => {
    if (away) {
      window.Tuti?.close();
    }
  }, [away]);
  if (away) {
    return <style>{`#tuti-widget, body > button[aria-controls="tuti-widget"] { display: none !important; }`}</style>;
  }
  return (
    <>
      {/* The launcher under the app's dialogs, sheets and popovers (z-50), still over the page; on phones the page ends clear
          of it (AppShell, by data-app-widget), as does what's held at the bottom of the screen (the `launcher:` variant).
          Over the phone tab bar where it's shown (AppTabBar), and its floating panel (wider than 640px) above the launcher. Its panel, once open, stays over everything. */}
      <style data-app-widget>{`body > button[aria-controls="tuti-widget"] { z-index: 40 !important; } @media (width < 48rem) { :root:has([data-tab-bar]) body > button[aria-controls="tuti-widget"] { bottom: calc(5rem + env(safe-area-inset-bottom)) !important; } } @media (640px < width < 48rem) { :root:has([data-tab-bar]) #tuti-widget { bottom: calc(5rem + 68px + env(safe-area-inset-bottom)) !important; max-height: calc(100dvh - 5rem - 68px - 1.5rem - env(safe-area-inset-bottom)) !important; } }`}</style>
      <Script src="/api/widget.js" data-project={slug} onLoad={() => window.Tuti?.identify(getToken)} />
    </>
  );
}
