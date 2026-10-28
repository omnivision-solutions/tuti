"use client";

import Script from "next/script";
import { useEffect } from "react";

import { appWidgetToken } from "@/server/app-widget";

declare global {
  interface Window {
    Tuti?: { identify: (getToken: () => Promise<string | null>) => void };
  }
}

/**
 * Tuti's own widget in the team app, for APP_WIDGET_PROJECT (`slug`), installed as any app installs
 * it (docs/widget.md): the script tag, then `Tuti.identify` with a token for the signed-in account.
 * Leaving the team app (signing out goes to the home page without a reload, where the launcher
 * stays) signs its panels out: no token. Each time it shows again, it asks for the account's.
 */
export function AppWidget({ slug }: { slug: string }) {
  useEffect(() => () => window.Tuti?.identify(() => Promise.resolve(null)), []);
  return (
    <Script
      src="/widget.js"
      data-project={slug}
      onReady={() => window.Tuti?.identify(() => appWidgetToken().then((result) => result.token ?? null))}
    />
  );
}
