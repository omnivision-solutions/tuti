import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { ForgotPasswordForm } from "@/components/password-reset-forms";
import { safeRedirectPath } from "@/lib/redirects";

export default async function ForgotPasswordPage(props: PageProps<"/app/auth/forgot-password">) {
  // Reset links need email that really goes out.
  if (!emailConfigured()) {
    notFound();
  }
  const { link, portal, next } = await props.searchParams;
  // On the way back to a portal (its sign-in's "Forgot your password?"): asked for it (server/password-reset.ts), and
  // "Back to sign in" keeps that sign-in's way back.
  return (
    <ForgotPasswordForm
      failed={link === "failed"}
      pages="/app/auth"
      portal={typeof portal === "string" ? portal : undefined}
      next={safeRedirectPath(typeof next === "string" ? next : undefined, "") || undefined}
    />
  );
}
