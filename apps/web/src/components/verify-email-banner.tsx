"use client";

import { MailIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

/** Shown in /app until the signed-in account's email is verified. */
export function VerifyEmailBanner({ email }: { email: string }) {
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
    <Alert>
      <MailIcon />
      <AlertTitle>Verify your email</AlertTitle>
      <AlertDescription>
        We sent a link to {email}. Verifying it lets teams invite you by email.
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={resend} disabled={state !== "idle"}>
          {state === "sent" ? "Sent" : state === "sending" ? "Sending…" : "Resend email"}
        </Button>
      </AlertAction>
    </Alert>
  );
}
