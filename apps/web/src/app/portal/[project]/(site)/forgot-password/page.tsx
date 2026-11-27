import type { Metadata } from "next";
import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { ForgotPasswordForm } from "@/components/password-reset-forms";
import { PRIVATE_PAGE } from "@/server/portal-metadata";
import { pageTranslator } from "@/server/portal-language";

/** For the reader alone: not for search engines. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await pageTranslator("auth")).t("resetPassword"), ...PRIVATE_PAGE };
}

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
