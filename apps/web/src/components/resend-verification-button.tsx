"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { usePortalAuthClient } from "@/components/portal-base";
import { Button } from "@/components/ui/button";
import { PAGE_LANGUAGE_HEADER } from "@/lib/language-addresses";

/**
 * "Resend email": the verification email again (on a portal's Account and a portal board's Get updates), its link coming back to `callbackURL`.
 */
export function ResendVerificationButton({ email, callbackURL = "/app" }: { email: string; callbackURL?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  // In the page's language on a portal.
  const t = useTranslations("account");
  // On a portal under a path of its team's site, its auth API is there too.
  const client = usePortalAuthClient();
  // Its email in this page's language (lib/auth.ts).
  const language = useLocale();

  async function resend() {
    setState("sending");
    const { error } = await client.sendVerificationEmail({ email, callbackURL }, { headers: { [PAGE_LANGUAGE_HEADER]: language } });
    if (error) {
      setState("idle");
      toast.error(error.message ?? t("resendFailed"));
      return;
    }
    setState("sent");
  }

  return (
    <Button size="xs" variant="ghost" onClick={resend} disabled={state !== "idle"} focusableWhenDisabled>
      {state === "sent" ? t("sent") : state === "sending" ? t("sending") : t("resend")}
    </Button>
  );
}
