"use client";

import { MailIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { usePortalAuthClient } from "@/components/portal-base";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/** A slim strip above every page in /app until the signed-in account's email is verified; it can't be dismissed. */
export function VerifyEmailBanner({ email }: { email: string }) {
  // Rendered by the server while unverified; the session refreshes when the tab
  // regains focus, so verifying in another tab hides it here too.
  const { data } = authClient.useSession();
  if (data?.user.emailVerified) {
    return null;
  }

  return (
    // On a phone its button goes under the words, which keep the width (the address whole, on a line of its own if it must).
    <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/50 py-1 pr-1 pl-3 text-sm">
      <MailIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 basis-56 break-words">
        <span className="font-medium">Verify your email.</span>{" "}
        <span className="text-muted-foreground">We sent a link to {email}.</span>
      </p>
      <ResendVerificationButton email={email} />
    </div>
  );
}

/**
 * "Resend email": the verification email again (on the strip, on Account settings while unverified, and
 * on a portal board's Get updates), its link coming back to `callbackURL`.
 */
export function ResendVerificationButton({ email, callbackURL = "/app" }: { email: string; callbackURL?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  // On a portal under a path of its team's site, its auth API is there too.
  const client = usePortalAuthClient();

  async function resend() {
    setState("sending");
    const { error } = await client.sendVerificationEmail({ email, callbackURL });
    if (error) {
      setState("idle");
      toast.error(error.message ?? "Couldn't send the email. Try again in a minute.");
      return;
    }
    setState("sent");
  }

  return (
    <Button size="xs" variant="ghost" onClick={resend} disabled={state !== "idle"}>
      {state === "sent" ? "Sent" : state === "sending" ? "Sending…" : "Resend email"}
    </Button>
  );
}

/** Account settings' " · Not verified" with "Resend email", gone once the email is verified (here or in another tab). */
export function NotVerified({ email }: { email: string }) {
  const { data } = authClient.useSession();
  if (data?.user.emailVerified) {
    return null;
  }
  return (
    <>
      {" · Not verified "}
      <ResendVerificationButton email={email} />
    </>
  );
}
