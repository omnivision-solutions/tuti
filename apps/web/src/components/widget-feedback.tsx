"use client";

import { useEffect, useState } from "react";

import { NewPostForm } from "@/components/new-post-form";
import { buttonVariants } from "@/components/ui/button";
import { WIDGET_IDENTIFY_MESSAGE, WIDGET_READY_MESSAGE } from "@/lib/widget-messages";
import { widgetCreatePost, widgetSignIn } from "@/server/widget";

type SignedIn = { token: string; name: string };

/**
 * The widget's Feedback tab when the portal's own sign-in cookie isn't there (a
 * customer's site). Asks the page for a sign-in token from the customer's app
 * (Tuti.identify), trades it for a widget token, and posts with that. Without one,
 * it offers signing in on the portal in a new tab.
 */
export function WidgetFeedback({ projectSlug, boardSlug }: { projectSlug: string; boardSlug: string }) {
  const [signedIn, setSignedIn] = useState<SignedIn | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      // Only from the page that embeds us; the token proves who it's for, whatever site that is.
      const data = event.data as { type?: unknown; token?: unknown } | null;
      if (event.source !== window.parent || data?.type !== WIDGET_IDENTIFY_MESSAGE || typeof data.token !== "string") {
        return;
      }
      const result = await widgetSignIn(projectSlug, data.token);
      if ("error" in result) {
        setError(result.error);
      } else {
        setError(undefined);
        setSignedIn(result);
      }
    };
    window.addEventListener("message", onMessage);
    // Ready for a token (the page may have one; nothing secret in this message).
    window.parent.postMessage({ type: WIDGET_READY_MESSAGE }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [projectSlug]);

  if (signedIn) {
    const token = signedIn.token;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Posting as {signedIn.name}</p>
        <NewPostForm
          projectSlug={projectSlug}
          boardSlug={boardSlug}
          // Image uploads need the portal's sign-in; posts from here are text.
          mediaBaseUrl={null}
          linkTarget="_blank"
          submit={(prev, formData) => widgetCreatePost(projectSlug, token, prev, formData)}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">Sign in to post ideas and vote. It opens in a new tab.</p>
      <a href="/sign-in" target="_blank" rel="noreferrer" className={buttonVariants()}>
        Sign in to post feedback
      </a>
    </div>
  );
}
