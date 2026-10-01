import { AccountForms } from "@/components/account-forms";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account settings</h1>
        <p className="text-sm text-muted-foreground">{session.user.email}</p>
      </div>
      <AccountForms name={session.user.name} />
    </>
  );
}
