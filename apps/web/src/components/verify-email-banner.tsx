"use client";

import { MailIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { verifyEmailDismissedCookie } from "@/lib/verify-email";

/** A slim strip in /app until the signed-in account's email is verified, or it's dismissed (in this browser). */
export function VerifyEmailBanner({ userId, email }: { userId: string; email: string }) {
  const [dismissed, setDismissed] = useState(false);
  // Rendered by the server while unverified; the session refreshes when the tab
  // regains focus, so verifying in another tab hides it here too.
  const { data } = authClient.useSession();
  if (data?.user.emailVerified || dismissed) {
    return null;
  }

  function dismiss() {
    document.cookie = `${verifyEmailDismissedCookie(userId)}=1; path=/app; max-age=31536000; samesite=lax`;
    setDismissed(true);
  }

  return (
    <div role="status" className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1 pr-1 pl-3 text-sm">
      <MailIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 break-words">
        <span className="font-medium">Verify your email.</span>{" "}
        <span className="text-muted-foreground">We sent a link to {email}.</span>
      </p>
      <ResendVerificationButton email={email} />
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={dismiss}>
        <XIcon />
      </Button>
    </div>
  );
}

/** "Resend email": the verification email again (on the strip, and on Account settings while unverified). */
export function ResendVerificationButton({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function resend() {
    setState("sending");
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/app" });
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
