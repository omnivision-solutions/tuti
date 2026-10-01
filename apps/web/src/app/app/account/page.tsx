import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";

import { AccountForms } from "@/components/account-forms";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/server/session";

export default async function AccountPage() {
  const session = await getSession();
  if (!session) {
    return null;
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="flex flex-col items-start gap-1">
        <Link href="/app" className={buttonVariants({ variant: "link", size: "sm", className: "px-0 text-muted-foreground" })}>
          <ArrowLeftIcon />
          Back to app
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Account settings</h1>
        <p className="text-sm text-muted-foreground">{session.user.email}</p>
      </div>
      <AccountForms name={session.user.name} />
    </main>
  );
}
