"use client";

import { useEffect, useState } from "react";

import { NewPostForm } from "@/components/new-post-form";
import { Card, CardContent } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { latestOnly } from "@/lib/latest-only";
import { WIDGET_IDENTIFY_MESSAGE, WIDGET_READY_MESSAGE } from "@/lib/widget-messages";
import { widgetCreatePost, widgetSignIn, widgetSignOut } from "@/server/widget";

type SignedIn = { id: string; token: string; name: string; named: boolean; email: string | null };

type SignInResult = { signedIn: SignedIn } | { error: string } | { signedOut: true } | { pending: true };

/** Every useWidgetSignIn on the page, told each token's result: one listener trades each token once, as each works only once. */
const subscribers = new Set<{ projectSlug: string; tell: (result: SignInResult) => void }>();

// One sign-in exchange at a time, the page's latest identity only: a slower one for someone before
// can't set its cookie or tell the panel after nobody, or someone else, is signed in.
const exchange = latestOnly();

function onIdentify(event: MessageEvent) {
  // Only from the page that embeds us; the token proves who it's for, whatever site that is.
  const data = event.data as { type?: unknown; token?: unknown } | null;
  const projectSlug = subscribers.values().next().value?.projectSlug;
  if (event.source !== window.parent || data?.type !== WIDGET_IDENTIFY_MESSAGE || !projectSlug) {
    return;
  }
  const tell = (result: SignInResult) => {
    for (const subscriber of subscribers) {
      subscriber.tell(result);
    }
  };
  // The page signs nobody in.
  if (data.token === null) {
    // Signed out here even if clearing the cookie fails (it lasts until the browser closes or the token expires).
    exchange(() => widgetSignOut().catch(() => {}), () => tell({ signedOut: true }));
    return;
  }
  if (typeof data.token !== "string") {
    return;
  }
  // A token came: someone's signing in, however long trading it takes.
  tell({ pending: true });
  const token = data.token;
  exchange(
    // A failed exchange (the network, the server) signs nobody in, not whoever was before.
    () => widgetSignIn(projectSlug, token).catch(() => ({ error: "Couldn't sign you in" })),
    (result) => tell("error" in result ? { error: result.error } : { signedIn: result }),
  );
}

/**
 * Who the customer's page signs in to the widget (Tuti.identify): asks the page for a sign-in
 * token from the customer's app and trades it for a widget token (with `enabled`, so a page
 * that only might need it doesn't ask for a token it won't use).
 */
export function useWidgetSignIn(projectSlug: string, enabled = true) {
  const [signedIn, setSignedIn] = useState<SignedIn | null>(null);
  const [error, setError] = useState<string>();
  // Whether it's known who's here: the page answered (someone, or nobody), or didn't within 3 seconds
  // (a panel opened on its own, or a page with an older script, which only ever sends tokens).
  const [known, setKnown] = useState(false);
  // A token from the page is being traded.
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const subscriber = {
      projectSlug,
      tell: (result: SignInResult) => {
        // Someone's signing in: until it's traded (even after the 3 seconds), they may not be who's shown.
        if ("pending" in result) {
          clearTimeout(giveUp);
          setPending(true);
          return;
        }
        setPending(false);
        setKnown(true);
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
    // Only if no token comes at all: once one has, it waits for its result.
    const giveUp = setTimeout(() => setKnown(true), 3000);
    return () => {
      clearTimeout(giveUp);
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        window.removeEventListener("message", onIdentify);
      }
    };
  }, [projectSlug, enabled]);

  return { signedIn, error, known: !enabled || known, pending: enabled && pending };
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
  postButton,
  titlePlaceholder,
  detailsPlaceholder,
}: {
  projectSlug: string;
  boardSlug: string;
  defaultTitle?: string;
  postButton?: string;
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
              postButton={postButton}
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
