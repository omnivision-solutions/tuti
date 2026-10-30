import { AccountForms } from "@/components/account-forms";
import { PageHeader } from "@/components/page-header";
import { ResendVerificationButton } from "@/components/verify-email-banner";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }

  return (
    <>
      <PageHeader
        title="Account settings"
        description={
          <>
            {session.user.email}
            {/* Always here while unverified, so the email can be sent again after the strip is dismissed. */}
            {!session.user.emailVerified && (
              <>
                {" · Not verified "}
                <ResendVerificationButton email={session.user.email} />
              </>
            )}
          </>
        }
      />
      <AccountForms name={session.user.name} />
    </>
  );
}
