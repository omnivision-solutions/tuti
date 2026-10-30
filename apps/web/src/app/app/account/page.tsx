import { cookies } from "next/headers";

import { AccountForms } from "@/components/account-forms";
import { PageHeader } from "@/components/page-header";
import { VerifyEmailBanner } from "@/components/verify-email-banner";
import { verifyEmailDismissedCookie } from "@/lib/verify-email";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }

  // Dismissed elsewhere (where the layout leaves it out), it's still here, with its "Resend email".
  const dismissed = (await cookies()).has(verifyEmailDismissedCookie(session.user.id));

  return (
    <>
      {!session.user.emailVerified && dismissed && <VerifyEmailBanner userId={session.user.id} email={session.user.email} />}
      <PageHeader title="Account settings" description={session.user.email} />
      <AccountForms name={session.user.name} />
    </>
  );
}
