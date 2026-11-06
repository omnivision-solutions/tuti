import { plansEnabled } from "@tuti/shared";
import { StarIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { GithubMark } from "@/components/github-mark";
import { TutiLogo, TutiMark } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/server/session";

import { docsUrl, githubStars, REPO_URL } from "./links";
import { MobileNav, SiteNav } from "./site-nav";

/** Apex site: marketing and team sign-in/up, every page under one header and footer. */
export default async function MarketingLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  const docs = await docsUrl();

  return (
    <>
      <header className="relative border-b">
        <div className="mx-auto grid h-16 w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link href="/" aria-label="Tuti home" className="justify-self-start">
            <TutiLogo />
          </Link>
          <SiteNav docs={docs} pricing={plansEnabled()} />
          <div className="col-start-3 flex items-center justify-self-end gap-2">
            <a href={REPO_URL} className={buttonVariants({ variant: "ghost", className: "gap-1.5 px-2.5" })}>
              <GithubMark className="size-4" />
              <span className="sr-only">Tuti on GitHub</span>
              <Suspense>
                <Stars />
              </Suspense>
            </a>
            {/* Signed in, Start free leads to the app and there's no Sign in (/sign-in would go to the app too). */}
            {!session && (
              <Link href="/sign-in" className={buttonVariants({ variant: "ghost", className: "max-md:hidden" })}>
                Sign in
              </Link>
            )}
            <Link href={session ? "/app" : "/sign-up"} className={buttonVariants({ className: "max-md:hidden" })}>
              Start free
            </Link>
            <MobileNav docs={docs} pricing={plansEnabled()} signedIn={!!session} />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-10 has-data-wide:max-w-5xl has-data-full:max-w-none has-data-full:p-0">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-7 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <TutiMark className="size-5" /> Tuti
          </span>
          <nav aria-label="Footer" className="flex gap-4">
            {plansEnabled() && (
              <Link href="/pricing" className="hover:text-foreground">
                Pricing
              </Link>
            )}
            <a href={docs} className="hover:text-foreground">
              Docs
            </a>
            <a href={REPO_URL} className="flex items-center gap-1.5 hover:text-foreground">
              <GithubMark className="size-3.5" /> GitHub
            </a>
            {plansEnabled() && (
              <>
                <Link href="/terms" className="hover:text-foreground">
                  Terms
                </Link>
                <Link href="/privacy" className="hover:text-foreground">
                  Privacy
                </Link>
              </>
            )}
          </nav>
        </div>
      </footer>
    </>
  );
}

/** The star count beside the GitHub mark, streamed in so a slow GitHub never holds up the page. */
async function Stars() {
  const stars = await githubStars();
  if (stars === null) return null;
  return (
    <span className="flex items-center gap-1 text-sm tabular-nums">
      <StarIcon aria-hidden className="size-3.5 fill-highlight-foreground text-highlight-foreground" />
      {new Intl.NumberFormat("en", { notation: "compact" }).format(stars)}
      <span className="sr-only">stars</span>
    </span>
  );
}
