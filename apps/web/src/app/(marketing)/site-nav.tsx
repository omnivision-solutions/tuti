"use client";

import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AUTH_PAGES } from "@/components/theme-provider";
import { buttonVariants } from "@/components/ui/button";

import { SECTIONS } from "./sections";

const links = (pricing: boolean): readonly (readonly [string, string])[] => [...SECTIONS, ...(pricing ? [["Pricing", "/pricing"] as const] : [])];

/** The site's links on wide screens (from `lg`: five links don't fit a tablet's header), beside the logo. Smaller ones get `MobileNav`. */
export function SiteNav({ pricing }: { pricing: boolean }) {
  return (
    <nav aria-label="Site" className="flex gap-7 text-[0.90625rem] font-medium whitespace-nowrap text-foreground/85 max-lg:hidden">
      {links(pricing).map(([label, href]) => (
        <Link key={href} href={href} className="hover:text-foreground">
          {label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The site's links on phones and tablets: a menu button that opens them under the header, with the sign-in buttons
 * full width at the bottom.
 */
export function MobileNav({ pricing, signedIn, docs }: { pricing: boolean; signedIn: boolean; docs: string }) {
  // Open on the page it was opened on, so going anywhere else (Back, a link in the page) closes it.
  const pathname = usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  // Forget it on the way out, so coming back (Back again) doesn't reopen it.
  if (openOn !== null && !open) setOpenOn(null);
  const close = () => setOpenOn(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const row = "flex items-center justify-between border-b py-3.5 font-medium";
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Close menu" : "Menu"}
        ref={button}
        onClick={() => setOpenOn(open ? null : pathname)}
        className={buttonVariants({ variant: "outline", size: "icon-lg", className: "lg:hidden" })}
      >
        {open ? <XIcon /> : <MenuIcon />}
      </button>
      <nav id="mobile-nav" aria-label="Site" hidden={!open} className="absolute inset-x-0 top-full z-40 max-h-[calc(100dvh-4rem)] overflow-y-auto border-b bg-background px-4 pb-6 shadow-lg sm:px-6 lg:hidden">
        {links(pricing).map(([label, href]) => (
          <Link key={href} href={href} onClick={close} className={row}>
            {label}
          </Link>
        ))}
        <a href={docs} onClick={close} className={row}>
          Docs
        </a>
        <div className="mt-6 flex flex-col gap-2">
          {signedIn ? (
            <Link href="/app" onClick={close} className={buttonVariants({ size: "lg" })}>
              Open app
            </Link>
          ) : (
            // Not on the sign-in pages themselves (as the header's SignedOutLinks): the form is the way in there.
            !AUTH_PAGES.has(pathname.split("/")[1] ?? "") && (
            <>
              <Link href="/sign-in" onClick={close} className={buttonVariants({ variant: "outline", size: "lg" })}>
                Sign in
              </Link>
              <Link href="/sign-up" onClick={close} className={buttonVariants({ size: "lg" })}>
                Start free
              </Link>
            </>
            )
          )}
        </div>
      </nav>
    </>
  );
}

/** The header's Sign in and Start free, but not on the sign-in pages themselves: the form is the way in there. */
export function SignedOutLinks() {
  const pathname = usePathname();
  if (AUTH_PAGES.has(pathname.split("/")[1] ?? "")) {
    return null;
  }
  return (
    <>
      <Link href="/sign-in" className={buttonVariants({ variant: "ghost", className: "max-md:hidden" })}>
        Sign in
      </Link>
      {/* On phones too, beside the menu: the page's main action stays in reach. */}
      <Link href="/sign-up" className={buttonVariants()}>
        Start free
      </Link>
    </>
  );
}
