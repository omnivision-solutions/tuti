"use client";

import { MailIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { VERIFY_EMAIL_DISMISSED_COOKIE } from "@/lib/verify-email";

/** A slim strip in /app until the signed-in account's email is verified, or it's dismissed (in this browser). */
export function VerifyEmailBanner({ userId, email }: { userId: string; email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [dismissed, setDismissed] = useState(false);
  // Rendered by the server while unverified; the session refreshes when the tab
  // regains focus, so verifying in another tab hides it here too.
  const { data } = authClient.useSession();
  if (data?.user.emailVerified || dismissed) {
    return null;
  }

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

  function dismiss() {
    document.cookie = `${VERIFY_EMAIL_DISMISSED_COOKIE}=${encodeURIComponent(userId)}; path=/app; max-age=31536000; samesite=lax`;
    setDismissed(true);
  }

  return (
    <div role="status" className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1 pr-1 pl-3 text-sm">
      <MailIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 break-words">
        <span className="font-medium">Verify your email.</span>{" "}
        <span className="text-muted-foreground">We sent a link to {email}.</span>
      </p>
      <Button size="xs" variant="ghost" onClick={resend} disabled={state !== "idle"}>
        {state === "sent" ? "Sent" : state === "sending" ? "Sending…" : "Resend email"}
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={dismiss}>
        <XIcon />
      </Button>
    </div>
  );
}
