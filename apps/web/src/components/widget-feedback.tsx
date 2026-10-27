"use client";

import { useEffect, useState } from "react";

import { NewPostForm } from "@/components/new-post-form";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { WIDGET_IDENTIFY_MESSAGE, WIDGET_READY_MESSAGE } from "@/lib/widget-messages";
import { widgetCreatePost, widgetSignIn } from "@/server/widget";

type SignedIn = { id: string; token: string; name: string; email: string | null };

type SignInResult = { signedIn: SignedIn } | { error: string } | { signedOut: true };

/** Every useWidgetSignIn on the page, told each token's result: one listener trades each token once, as each works only once. */
const subscribers = new Set<{ projectSlug: string; tell: (result: SignInResult) => void }>();

async function onIdentify(event: MessageEvent) {
  // Only from the page that embeds us; the token proves who it's for, whatever site that is.
  const data = event.data as { type?: unknown; token?: unknown } | null;
  const projectSlug = subscribers.values().next().value?.projectSlug;
  if (event.source !== window.parent || data?.type !== WIDGET_IDENTIFY_MESSAGE || !projectSlug) {
    return;
  }
  // The page has nobody signed in now (its app gave no token): nobody is, not whoever was before.
  if (data.token === null) {
    for (const subscriber of subscribers) {
      subscriber.tell({ signedOut: true });
    }
    return;
  }
  if (typeof data.token !== "string") {
    return;
  }
  const result = await widgetSignIn(projectSlug, data.token);
  for (const subscriber of subscribers) {
    subscriber.tell("error" in result ? { error: result.error } : { signedIn: result });
  }
}

/**
 * Who the customer's page signs in to the widget (Tuti.identify): asks the page for a sign-in
 * token from the customer's app and trades it for a widget token (with `enabled`, so a page
 * that only might need it doesn't ask for a token it won't use).
 */
export function useWidgetSignIn(projectSlug: string, enabled = true) {
  const [signedIn, setSignedIn] = useState<SignedIn | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const subscriber = {
      projectSlug,
      tell: (result: SignInResult) => {
        // A token that doesn't check out: nobody's signed in, not whoever was before it.
        if ("error" in result) {
          setError(result.error);
          setSignedIn(null);
        } else if ("signedOut" in result) {
          setError(undefined);
          setSignedIn(null);
        } else {
          setError(undefined);
          setSignedIn(result.signedIn);
        }
      },
    };
    if (subscribers.size === 0) {
      window.addEventListener("message", onIdentify);
    }
    subscribers.add(subscriber);
    // Ready for a token (the page may have one; nothing secret in this message).
    window.parent.postMessage({ type: WIDGET_READY_MESSAGE }, "*");
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        window.removeEventListener("message", onIdentify);
      }
    };
  }, [projectSlug, enabled]);

  return { signedIn, error };
}

/**
 * The widget's Feedback tab when the portal's own sign-in cookie isn't there (a
 * customer's site): posts as the person the customer's page signs in (useWidgetSignIn).
 * Without one, it offers signing in on the portal in a new tab.
 */
export function WidgetFeedback({
  projectSlug,
  boardSlug,
  defaultTitle,
  titlePlaceholder,
  detailsPlaceholder,
}: {
  projectSlug: string;
  boardSlug: string;
  defaultTitle?: string;
  titlePlaceholder?: string;
  detailsPlaceholder?: string;
}) {
  const { signedIn, error } = useWidgetSignIn(projectSlug);

  if (signedIn) {
    const token = signedIn.token;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Posting as {signedIn.name}</p>
        <Card>
          <CardContent>
            <NewPostForm
              projectSlug={projectSlug}
              boardSlug={boardSlug}
              // Image uploads need the portal's sign-in; posts from here are text.
              mediaUrls={null}
              linkTarget="_blank"
              submit={(prev, formData) => widgetCreatePost(projectSlug, token, prev, formData)}
              defaultTitle={defaultTitle}
              titlePlaceholder={titlePlaceholder}
              detailsPlaceholder={detailsPlaceholder}
            />
          </CardContent>
        </Card>
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
