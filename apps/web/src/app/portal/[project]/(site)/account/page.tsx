import { redirect } from "next/navigation";

import { ProfileForm } from "@/components/account-forms";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/server/session";

/** The name people show on this portal (e.g. to change the one a sign-in link gave them). */
export default async function PortalAccountPage() {
  const session = await getSession();
  if (!session) {
    redirect(`/sign-in?${new URLSearchParams({ next: "/account" })}`);
  }

  return (
    <>
      <PageHeader title="Account settings" />
      <ProfileForm name={session.user.name} />
    </>
  );
}
