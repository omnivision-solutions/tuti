"use client";

import { useState } from "react";
import { toast } from "sonner";

import { usePortalAuthClient } from "@/components/portal-base";
import { Button } from "@/components/ui/button";

/**
 * "Resend email": the verification email again (on a portal's Account and a portal board's Get updates), its link coming back to `callbackURL`.
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
