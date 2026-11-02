import { plansEnabled } from "@tuti/shared";
import { StarIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { GithubMark } from "@/components/github-mark";
import { TutiLogo } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/server/session";

import { docsUrl, githubStars, REPO_URL } from "./links";
import { SiteNav } from "./site-nav";

/** Apex site: marketing and team sign-in/up. */
export default async function MarketingLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();

  return (
    <>
      <header className="border-b">
        <div className="mx-auto grid h-16 w-full max-w-6xl grid-cols-[1fr_auto_1fr] items-center gap-4 px-6">
          <Link href="/" aria-label="Tuti home" className="justify-self-start">
            <TutiLogo />
          </Link>
          <SiteNav docs={await docsUrl()} pricing={plansEnabled()} />
          <div className="col-start-3 flex items-center justify-self-end gap-1 sm:gap-2">
            <a href={REPO_URL} className={buttonVariants({ variant: "ghost", className: "gap-1.5 px-2.5" })}>
              <GithubMark className="size-4" />
              <span className="sr-only">Tuti on GitHub</span>
              <Suspense>
                <Stars />
              </Suspense>
            </a>
            {session ? (
              <Link href="/app" className={buttonVariants()}>
                Dashboard
              </Link>
            ) : (
              <>
                <Link href="/sign-in" className={buttonVariants({ variant: "ghost", className: "max-sm:hidden" })}>
                  Sign in
                </Link>
                <Link href="/sign-up" className={buttonVariants()}>
                  Start free
                </Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-10 has-data-wide:max-w-5xl has-data-full:max-w-none has-data-full:p-0">{children}</main>
    </>
  );
}

/** The star count beside the GitHub mark, streamed in so a slow GitHub never holds up the page. */
async function Stars() {
  const stars = await githubStars();
  if (stars === null) return null;
  return (
    <span className="flex items-center gap-1 text-sm tabular-nums">
      <StarIcon aria-hidden className="size-3.5 fill-amber-400 text-amber-400" />
      {new Intl.NumberFormat("en", { notation: "compact" }).format(stars)}
      <span className="sr-only">stars</span>
    </span>
  );
}
