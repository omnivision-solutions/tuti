"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * "Open the app" on the page the mobile app's sign-in link opens. A plain form: its post is answered with a redirect to
 * the app (app-link/open/route.ts), which a script's navigation can't do as surely. The link works once, so the button
 * goes off with the first tap: a second post would use nothing and tell the app the link is dead, in place of the first's answer. It keeps
 * focus, and a line under it says what's happening and what to do if the app didn't open.
 */
export function AppSignInLinkForm({ token, state }: { token: string; state: string }) {
  const [opening, setOpening] = useState(false);
  return (
    <form method="post" action="/app/auth/app-link/open" onSubmit={(event) => (opening ? event.preventDefault() : setOpening(true))}>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="state" value={state} />
      <Button type="submit" className="w-full" disabled={opening} focusableWhenDisabled>
        Open the app
      </Button>
      {/* Always on the page and never hidden, so a screen reader announces the line when it's filled in (one that
          appears already filled often isn't read). The app may not open (a laptop, the phone's "Open in Tuti?" declined),
          and the link is used up by then. */}
      <p role="status" className="text-sm text-muted-foreground">
        {opening && <span className="mt-3 block">Opening the Tuti app… If it didn&apos;t open, ask for a new link in the app.</span>}
      </p>
    </form>
  );
}
