import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { ForgotPasswordForm } from "@/components/password-reset-forms";

export default async function PortalForgotPasswordPage(props: PageProps<"/portal/[project]/forgot-password">) {
  // Reset links need email that really goes out.
  if (!emailConfigured()) {
    notFound();
  }
  const { link } = await props.searchParams;
  return (
    <div data-auth-page className="mx-auto w-full max-w-sm sm:mt-12">
      <ForgotPasswordForm failed={link === "failed"} />
    </div>
  );
}
