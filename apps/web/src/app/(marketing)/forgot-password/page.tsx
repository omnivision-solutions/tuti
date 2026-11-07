import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { ForgotPasswordForm } from "@/components/password-reset-forms";

export default async function ForgotPasswordPage(props: PageProps<"/forgot-password">) {
  // Reset links need email that really goes out.
  if (!emailConfigured()) {
    notFound();
  }
  const { link, portal } = await props.searchParams;
  // On the way back to a portal (its sign-in's "Forgot your password?"): asked for it (server/password-reset.ts).
  return <ForgotPasswordForm failed={link === "failed"} portal={typeof portal === "string" ? portal : undefined} />;
}
