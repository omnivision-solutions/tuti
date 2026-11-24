"use client";

import { useState } from "react";

import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { confirmAppSignInLink } from "@/server/sign-in-link";

/**
 * "Open the app" on the page the mobile app's sign-in link opens. After the action the browser goes to the app's own
 * link (tuti://…) itself; a browser that won't follow one without a tap shows it as a link to tap.
 */
export function AppSignInLinkConfirm({ token, state }: { token: string; state: string }) {
  const [location, setLocation] = useState<string | null>();
  if (location === null) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        This link doesn&apos;t work any more. Ask for a new one in the Tuti app.
      </p>
    );
  }
  if (location) {
    return (
      <div className="flex w-full flex-col gap-3">
        {/* The button it replaces had the focus: it moves here, so a keyboard or a screen reader is on what to do next. */}
        <a ref={(link) => link?.focus()} className={buttonVariants({ className: "w-full" })} href={location}>
          Open the Tuti app
        </a>
        <p className="text-sm text-muted-foreground">Nothing happened? This works on a phone or tablet with the Tuti app.</p>
      </div>
    );
  }
  return (
    <form
      className="w-full"
      action={async (form) => {
        const { location } = await confirmAppSignInLink(form);
        setLocation(location);
        if (location) {
          window.location.assign(location);
        }
      }}
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="state" value={state} />
      <SubmitButton className="w-full">Open the app</SubmitButton>
    </form>
  );
}
