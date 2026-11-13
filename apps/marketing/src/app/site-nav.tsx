"use client";

import { buttonVariants } from "@tuti/ui/button";
import { GithubMark } from "@tuti/ui/github-mark";
import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DOCS, REPO_URL, SIGN_IN, SIGN_UP } from "./links";
import { SECTIONS } from "./sections";

const LINKS = [...SECTIONS, ["Pricing", "/pricing"]] as const;

/** The site's links on wide screens (from `lg`: five links don't fit a tablet's header), beside the logo. Smaller ones get `MobileNav`. */
export function SiteNav() {
  return (
    <nav aria-label="Site" className="flex gap-7 text-[0.90625rem] font-medium whitespace-nowrap text-foreground/85 max-lg:hidden">
      {LINKS.map(([label, href]) => (
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
export function MobileNav() {
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
        {LINKS.map(([label, href]) => (
          <Link key={href} href={href} onClick={close} className={row}>
            {label}
          </Link>
        ))}
        <a href={DOCS} onClick={close} className={row}>
          Docs
        </a>
        <a href={REPO_URL} className={row}>
          GitHub
        </a>
        <div className="mt-6 flex flex-col gap-2">
          <a href={SIGN_IN} className={buttonVariants({ variant: "outline", size: "lg" })}>
            Sign in
          </a>
          <a href={SIGN_UP} className={buttonVariants({ size: "lg" })}>
            Start free trial
          </a>
        </div>
      </nav>
    </>
  );
}

/** The header's GitHub, Sign in and Start free trial: plain links, into the app (another app on this domain). */
export function SignedOutLinks() {
  return (
    <>
      {/* Tuti is open source: its repository, from every page. */}
      <a href={REPO_URL} className={buttonVariants({ variant: "ghost", className: "max-md:hidden" })}>
        <GithubMark className="size-4" />
        GitHub
      </a>
      <a href={SIGN_IN} className={buttonVariants({ variant: "ghost", className: "max-md:hidden" })}>
        Sign in
      </a>
      {/* On phones too, beside the menu: the page's main action stays in reach. */}
      <a href={SIGN_UP} className={buttonVariants()}>
        Start free trial
      </a>
    </>
  );
}
