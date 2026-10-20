"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { buttonVariants } from "@/components/ui/button";
import { WIDGET_IDENTIFY_MESSAGE, WIDGET_READY_MESSAGE } from "@/lib/widget-messages";
import { widgetSignIn } from "@/server/widget";

/**
 * The widget's panel for a private portal, to someone who may not read it. When the customer's
 * page signs its users in (Tuti.identify), its token signs them in here too (widgetSignIn sets the
 * panel's reader cookie) and the panel reloads to show the portal; otherwise they can sign in on
 * the portal in a new tab.
 */
export function WidgetLocked({ projectSlug }: { projectSlug: string }) {
  const router = useRouter();

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const data = event.data as { type?: unknown; token?: unknown } | null;
      if (event.source !== window.parent || data?.type !== WIDGET_IDENTIFY_MESSAGE || typeof data.token !== "string") {
        return;
      }
      if (!("error" in (await widgetSignIn(projectSlug, data.token)))) {
        router.refresh();
      }
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: WIDGET_READY_MESSAGE }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [projectSlug, router]);

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">Sign in to see this. It opens in a new tab.</p>
      <a href="/sign-in" target="_blank" rel="noreferrer" className={buttonVariants()}>
        Sign in
      </a>
    </div>
  );
}
