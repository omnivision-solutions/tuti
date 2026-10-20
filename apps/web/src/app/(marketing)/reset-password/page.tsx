import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { NewPasswordForm } from "@/components/password-reset-forms";
import { FAILED_PASSWORD_RESET_PATH, pendingPasswordReset } from "@/server/sign-in-link-lookup";

export const metadata: Metadata = { robots: { index: false } };

/** tuti.so/reset-password?token=… is the link in a reset email asked for on the app (server/password-reset.ts). */
export default async function ResetPasswordPage(props: PageProps<"/reset-password">) {
  const { token } = await props.searchParams;
  const account = typeof token === "string" ? await pendingPasswordReset(null, token) : null;
  if (!account) {
    redirect(FAILED_PASSWORD_RESET_PATH);
  }
  return <NewPasswordForm token={token as string} email={account.email} />;
}
