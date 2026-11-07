import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { NewPasswordForm } from "@/components/password-reset-forms";
import { failedPasswordReset, pendingPasswordReset } from "@/server/sign-in-link-lookup";

export const metadata: Metadata = { robots: { index: false } };

/** tuti.so/reset-password?token=… is the link in every reset email, wherever it was asked for (server/password-reset.ts). */
export default async function ResetPasswordPage(props: PageProps<"/reset-password">) {
  const { token } = await props.searchParams;
  const account = typeof token === "string" ? await pendingPasswordReset(token) : null;
  if (!account) {
    redirect(await failedPasswordReset(typeof token === "string" ? token : ""));
  }
  return <NewPasswordForm token={token as string} email={account.email} />;
}
