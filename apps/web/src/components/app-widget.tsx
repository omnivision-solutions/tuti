"use client";

import { usePathname } from "next/navigation";
import Script from "next/script";
import { useEffect } from "react";

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
 * Not on Customize, whose previews show the team's own widget: it isn't installed there, and if it
 * came from another page it's closed (on a phone its open panel makes the page inert) and hidden.
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
  const customizing = /^\/app\/[^/]+\/customize(\/|$)/.test(usePathname());
  useEffect(() => {
    if (customizing) {
      window.Tuti?.close();
    }
  }, [customizing]);
  if (customizing) {
    return <style>{`#tuti-widget, body > button[aria-controls="tuti-widget"] { display: none !important; }`}</style>;
  }
  return (
    <>
      {/* The launcher under the app's dialogs, sheets and popovers (z-50), still over the page; on phones the page ends clear
          of it (AppShell, by data-app-widget), as does what's held at the bottom of the screen (the `launcher:` variant).
          Its panel, once open, stays over everything. */}
      <style data-app-widget>{`body > button[aria-controls="tuti-widget"] { z-index: 40 !important; }`}</style>
      <Script src="/widget.js" data-project={slug} onLoad={() => window.Tuti?.identify(getToken)} />
    </>
  );
}
