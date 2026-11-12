import { Analytics } from "@tuti/ui/analytics";
import { brandFonts } from "@tuti/ui/brand-fonts";
import { TutiLogo } from "@tuti/ui/tuti-logo";
import type { Metadata } from "next";
import Link from "next/link";

import { DOCS, REPO_URL } from "./links";
import { SECTIONS } from "./sections";
import { MobileNav, SignedOutLinks, SiteNav } from "./site-nav";

import "./globals.css";

// Rendered per request, so analytics follows the server's POSTHOG_KEY (@tuti/ui/analytics), not the build's.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tuti",
  description: "The help center that stays in sync with your code.",
};

/**
 * Tuti's marketing site (tuti.so): its pages under one header and footer. Light only (no theme: the app's dark mode is
 * a class this site never sets). The app is another app on the same domain (README, "Production routing").
 */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${brandFonts} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header data-marketing-header className="sticky top-0 z-50 border-b border-border/70 bg-background/85 backdrop-blur-md backdrop-saturate-150">
          <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center gap-9 px-5 md:px-8">
            <Link href="/" aria-label="Tuti home">
              <TutiLogo />
            </Link>
            <SiteNav />
            <div className="ml-auto flex items-center gap-2">
              <SignedOutLinks />
              <MobileNav />
            </div>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-10 has-data-wide:max-w-5xl has-data-full:max-w-none has-data-full:p-0">{children}</main>
        <footer>
          <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-start gap-10 px-5 pt-14 pb-16 text-sm text-muted-foreground md:px-8">
            <div>
              <TutiLogo />
              <p className="mt-3 max-w-72">The help center that stays in sync with your code.</p>
            </div>
            <nav aria-label="Footer" className="flex flex-wrap gap-16 md:ml-auto max-md:gap-9">
              <div className="flex flex-col gap-2.5">
                <p className="mb-1 font-semibold text-foreground">Product</p>
                {SECTIONS.map(([label, href]) => (
                  <Link key={href} href={href} className="hover:text-foreground">
                    {label}
                  </Link>
                ))}
                <Link href="/pricing" className="hover:text-foreground">
                  Pricing
                </Link>
              </div>
              <div className="flex flex-col gap-2.5">
                <p className="mb-1 font-semibold text-foreground">Resources</p>
                <a href={DOCS} className="hover:text-foreground">
                  Docs
                </a>
                <a href={REPO_URL} className="hover:text-foreground">
                  GitHub
                </a>
              </div>
              <div className="flex flex-col gap-2.5">
                <p className="mb-1 font-semibold text-foreground">Company</p>
                <Link href="/privacy" className="hover:text-foreground">
                  Privacy
                </Link>
                <Link href="/terms" className="hover:text-foreground">
                  Terms
                </Link>
              </div>
            </nav>
          </div>
        </footer>
        <Analytics />
      </body>
    </html>
  );
}
