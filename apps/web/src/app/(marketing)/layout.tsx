import { plansEnabled } from "@tuti/shared";
import Link from "next/link";

import { TutiLogo } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/server/session";

import { SECTIONS } from "./sections";
import { MobileNav, SignedOutLinks, SiteNav } from "./site-nav";

/** Apex site: marketing and team sign-in/up, every page under one header and footer. */
export default async function MarketingLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/85 backdrop-blur-md backdrop-saturate-150">
        <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center gap-9 px-5 md:px-8">
          <Link href="/" aria-label="Tuti home">
            <TutiLogo />
          </Link>
          <SiteNav pricing={plansEnabled()} />
          <div className="ml-auto flex items-center gap-2">
            {/* Signed in: one way into the app instead of Sign in and Start free. */}
            {session ? (
              <Link href="/app" className={buttonVariants({ className: "max-md:hidden" })}>
                Open app
              </Link>
            ) : (
              <SignedOutLinks />
            )}
            <MobileNav pricing={plansEnabled()} signedIn={!!session} />
          </div>
        </div>
      </header>
      {/* Anchors land below the sticky 64px header (the home page's sections, /docs/api#…). */}
      {/* Centred down the window: a short page (sign-in, forgot password) sits in the middle, not under the header. */}
      <main className="mx-auto flex [&_[id]]:scroll-mt-16 w-full max-w-3xl flex-1 flex-col justify-center px-6 py-10 has-data-wide:max-w-5xl has-data-full:max-w-none has-data-full:p-0">{children}</main>
      <footer>
        <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-start gap-10 px-5 pt-14 pb-16 text-sm text-muted-foreground md:px-8">
          <div>
            <TutiLogo />
            <p className="mt-3 max-w-72">The help center, feature requests and changelog for your product.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-16 md:ml-auto max-md:gap-9">
            <div className="flex flex-col gap-2.5">
              <p className="mb-1 font-semibold text-foreground">Product</p>
              {SECTIONS.map(([label, href]) => (
                <Link key={href} href={href} className="hover:text-foreground">
                  {label}
                </Link>
              ))}
              {plansEnabled() && (
                <Link href="/pricing" className="hover:text-foreground">
                  Pricing
                </Link>
              )}
            </div>
            {plansEnabled() && (
              <div className="flex flex-col gap-2.5">
                <p className="mb-1 font-semibold text-foreground">Company</p>
                <Link href="/privacy" className="hover:text-foreground">
                  Privacy
                </Link>
                <Link href="/terms" className="hover:text-foreground">
                  Terms
                </Link>
              </div>
            )}
          </nav>
        </div>
      </footer>
    </>
  );
}
