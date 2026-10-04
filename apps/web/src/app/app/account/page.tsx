import { AccountForms } from "@/components/account-forms";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }

  return (
    <>
      <PageHeader title="Account settings" description={session.user.email} />
      <AccountForms name={session.user.name} />
    </>
  );
}
