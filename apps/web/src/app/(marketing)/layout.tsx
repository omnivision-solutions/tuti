import { plansEnabled } from "@tuti/shared";
import Link from "next/link";

import { TutiLogo } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/server/session";

/** Apex site: marketing and team sign-in/up. */
export default async function MarketingLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-2">
        <Link href="/" aria-label="Tuti home">
          <TutiLogo />
        </Link>
        <div className="flex items-center gap-2">
          {plansEnabled() && (
            <Link href="/pricing" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Pricing
            </Link>
          )}
          {session ? (
            <Link href="/app" className={buttonVariants({ size: "sm" })}>
              Open app
            </Link>
          ) : (
            <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign in
            </Link>
          )}
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-10">{children}</main>
    </>
  );
}
