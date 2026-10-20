import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { NewPasswordForm } from "@/components/password-reset-forms";
import { FAILED_PASSWORD_RESET_PATH, pendingPasswordReset } from "@/server/sign-in-link-lookup";

export const metadata: Metadata = { robots: { index: false } };

/** <project>.tuti.so/reset-password?token=… is the link in a reset email asked for on this portal (server/password-reset.ts). */
export default async function PortalResetPasswordPage(props: PageProps<"/portal/[project]/reset-password">) {
  const [{ project }, { token }] = await Promise.all([props.params, props.searchParams]);
  const account = typeof token === "string" ? await pendingPasswordReset(project, token) : null;
  if (!account) {
    redirect(FAILED_PASSWORD_RESET_PATH);
  }
  return <NewPasswordForm token={token as string} email={account.email} />;
}
