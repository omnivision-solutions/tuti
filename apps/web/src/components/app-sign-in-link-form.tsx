"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * "Open the app" on the page the mobile app's sign-in link opens. A plain form: its post is answered with a redirect to
 * the app (app-link/open/route.ts), which a script's navigation can't do as surely. The link works once, so the button
 * goes off with the first tap: a second post would use nothing and tell the app the link is dead, in place of the first's answer.
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
    </form>
  );
}
