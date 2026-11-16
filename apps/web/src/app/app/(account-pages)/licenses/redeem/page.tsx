import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { RedeemLicense } from "@/components/redeem-license";
import { getAccountSession } from "@/server/session";

export const metadata: Metadata = { title: "Redeem your license" };

/**
 * Where AppSumo's sign-in sends a buyer (api/appsumo/redirect), with a claim for their license: signed out, on to sign
 * up (or sign in) and back; signed in, "Add to my account", then Licenses to assign it to a project.
 */
export default async function RedeemPage(props: PageProps<"/app/licenses/redeem">) {
  const { claim, failed } = await props.searchParams;
  if (failed || typeof claim !== "string" || !claim) {
    return <EmptyState title="We couldn't get your license from AppSumo" description="Go back to your AppSumo account and redeem the license again." />;
  }
  const here = `/app/licenses/redeem?claim=${encodeURIComponent(claim)}`;
  const session = await getAccountSession();
  if (!session) {
    redirect(`/app/auth/sign-up?next=${encodeURIComponent(here)}`);
  }
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-bold tracking-tight">Redeem your license</h1>
        <p className="break-words text-muted-foreground">
          Your AppSumo license goes on your Tuti account, signed in as {session.user.email}. Then pick the project it&apos;s for.
        </p>
      </div>
      <RedeemLicense claim={claim} />
      <p className="text-sm text-muted-foreground">
        Not your account?{" "}
        <a href={`/app/auth/sign-in?next=${encodeURIComponent(here)}`} className="font-medium text-primary underline-offset-4 hover:underline">
          Use another account
        </a>
      </p>
    </div>
  );
}
