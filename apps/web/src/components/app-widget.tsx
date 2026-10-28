"use client";

import Script from "next/script";

import { appWidgetToken } from "@/server/app-widget";

declare global {
  interface Window {
    Tuti?: { identify: (getToken: () => Promise<string | null>) => void };
  }
}

/**
 * Tuti's own widget in the team app, for APP_WIDGET_PROJECT (`slug`), installed as any app installs
 * it (docs/widget.md): the script tag, then `Tuti.identify` with a token for the signed-in account.
 */
export function AppWidget({ slug }: { slug: string }) {
  return (
    <Script
      src="/widget.js"
      data-project={slug}
      onLoad={() => window.Tuti?.identify(() => appWidgetToken().then((result) => result.token ?? null))}
    />
  );
}
