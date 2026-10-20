import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { ForgotPasswordForm } from "@/components/password-reset-forms";

export default async function ForgotPasswordPage(props: PageProps<"/forgot-password">) {
  // Reset links need email that really goes out.
  if (!emailConfigured()) {
    notFound();
  }
  const { link } = await props.searchParams;
  return <ForgotPasswordForm failed={link === "failed"} />;
}
