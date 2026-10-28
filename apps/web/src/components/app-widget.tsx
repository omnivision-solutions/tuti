"use client";

import Script from "next/script";
import { useEffect } from "react";

import { appWidgetToken } from "@/server/app-widget";

declare global {
  interface Window {
    Tuti?: { identify: (getToken: () => Promise<string | null>) => void };
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
  return <Script src="/widget.js" data-project={slug} onLoad={() => window.Tuti?.identify(getToken)} />;
}
