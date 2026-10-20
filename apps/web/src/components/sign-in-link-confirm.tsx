"use client";

import { SubmitButton } from "@/components/submit-button";
import { confirmSignInLink } from "@/server/sign-in-link";

/**
 * The "Sign in" button on the page a sign-in link opens. After the action, the browser
 * loads the next page itself: a full load, so the portal's routes (not the app's) render
 * it, and with the new session.
 */
export function SignInLinkConfirm({ token, next }: { token: string; next: string }) {
  return (
    <form
      className="w-full"
      action={async (form) => {
        const { location } = await confirmSignInLink(form);
        window.location.assign(location);
      }}
    >
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="next" value={next} />
      <SubmitButton className="w-full">Sign in</SubmitButton>
    </form>
  );
}
