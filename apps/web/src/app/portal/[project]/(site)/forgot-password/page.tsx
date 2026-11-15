import type { Metadata } from "next";
import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { ForgotPasswordForm } from "@/components/password-reset-forms";
import { PRIVATE_PAGE } from "@/server/portal-metadata";

/** For the reader alone: not for search engines. */
export const metadata: Metadata = { title: "Reset your password", ...PRIVATE_PAGE };

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
