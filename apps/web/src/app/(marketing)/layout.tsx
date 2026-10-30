import { plansEnabled } from "@tuti/shared";
import Link from "next/link";

import { TutiLogo } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/server/session";

import { docsUrl, REPO_URL } from "./links";

/** Apex site: marketing and team sign-in/up. */
export default async function MarketingLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-2">
        <Link href="/" aria-label="Tuti home">
          <TutiLogo />
        </Link>
        <nav aria-label="Site" className="flex items-center gap-1 sm:gap-2">
          {/* On phones only Pricing and GitHub fit beside the sign-in button. */}
          <Link href="/#features" className={buttonVariants({ variant: "ghost", size: "sm", className: "max-sm:hidden" })}>
            Features
          </Link>
          {plansEnabled() && (
            <Link href="/pricing" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Pricing
            </Link>
          )}
          <a href={await docsUrl()} className={buttonVariants({ variant: "ghost", size: "sm", className: "max-sm:hidden" })}>
            Docs
          </a>
          <a href={REPO_URL} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            GitHub
          </a>
          {session ? (
            <Link href="/app" className={buttonVariants({ size: "sm" })}>
              Open app
            </Link>
          ) : (
            <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-10 has-data-wide:max-w-5xl">{children}</main>
    </>
  );
}
