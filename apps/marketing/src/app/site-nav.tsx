"use client";

import { buttonVariants } from "@tuti/ui/button";
import { GithubMark } from "@tuti/ui/github-mark";
import { ChevronDownIcon, MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { FEATURES, GROUPS } from "./features";
import { DOCS, REPO_URL, SIGN_IN, SIGN_UP } from "./links";

/** The site's links on wide screens (from `lg`), beside the logo: the Features menu and Pricing. Smaller ones get `MobileNav`. */
export function SiteNav() {
  return (
    <nav aria-label="Site" className="flex items-center gap-7 text-[0.90625rem] font-medium whitespace-nowrap text-foreground/85 max-lg:hidden">
      <FeaturesMenu />
      <Link href="/pricing" className="hover:text-foreground">
        Pricing
      </Link>
    </nav>
  );
}

// A pointer resting on Features opens it, one leaving closes it, each after a moment: passing over it, or crossing the
// gap to the panel, does neither.
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 250;
// A click this soon after hovering opened the panel is the same intent: it keeps it open rather than closing it.
const CLICK_AFTER_HOVER_MS = 600;

/**
 * "Features": a panel under the header with every feature page (features.ts), by group, each an icon, its name and a
 * line. Opens on hover (mouse only), a click, or Enter, Space or ↓ (↓ also focuses its first link); Tab goes through
 * its links. Escape closes it (focus back on the button), as do a click outside, focus leaving it and going to another page.
 */
function FeaturesMenu() {
  // Open on the page it was opened on, so going anywhere else closes it (as MobileNav).
  const pathname = usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  if (openOn !== null && !open) setOpenOn(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const hoverOpenedAt = useRef(0);
  const focusFirst = useRef(false);
  const later = (run: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) {
      focusFirst.current = false;
      panel.current?.querySelector("a")?.focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      button.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenOn(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const close = () => setOpenOn(null);
  return (
    <div
      ref={root}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        // Back on it while open (from the panel, across the gap): only the pending close is called off.
        if (open) return window.clearTimeout(timer.current);
        later(() => {
          hoverOpenedAt.current = Date.now();
          setOpenOn(pathname);
        }, OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        // With the keyboard in the panel it stays: hiding it would drop the focus; Escape, Tab out or a click closes it.
        later(() => {
          if (!panel.current?.contains(document.activeElement)) close();
        }, CLOSE_DELAY_MS);
      }}
      onBlur={(event) => {
        // Focus going nowhere (a click on the panel's background) leaves it open: a click outside closes it (pointerdown).
        if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node)) close();
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="features-menu"
        onClick={() => {
          window.clearTimeout(timer.current);
          if (open && Date.now() - hoverOpenedAt.current < CLICK_AFTER_HOVER_MS) return;
          setOpenOn(open ? null : pathname);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          if (open) panel.current?.querySelector("a")?.focus();
          else {
            // Focused once the panel shows (the effect above).
            focusFirst.current = true;
            setOpenOn(pathname);
          }
        }}
        className="flex items-center gap-1 hover:text-foreground aria-expanded:text-foreground"
      >
        Features
        <ChevronDownIcon aria-hidden className="size-3.5 transition-transform in-aria-expanded:rotate-180" />
      </button>
      {/* Under the header (sticky, so it holds the panel), centred on the page. */}
      <div
        id="features-menu"
        ref={panel}
        hidden={!open}
        className="absolute top-full left-1/2 mt-2 w-[min(880px,calc(100vw-2.5rem))] -translate-x-1/2 rounded-2xl border bg-card p-5 whitespace-normal shadow-xl"
      >
        <div className="grid grid-cols-3 gap-4">
          {GROUPS.map((group) => (
            <div key={group}>
              <p className="mb-2 px-2.5 group-label">{group}</p>
              <ul className="flex flex-col gap-0.5">
                {FEATURES.filter((f) => f.group === group).map((f) => (
                  <li key={f.slug}>
                    <Link href={`/features/${f.slug}`} onClick={close} className="flex items-start gap-3 rounded-lg p-2.5 hover:bg-accent focus-visible:bg-accent">
                      <span className="grid size-9 flex-none place-items-center rounded-lg border bg-background text-primary">
                        <f.icon aria-hidden className="size-4" />
                      </span>
                      <span>
                        <span className="block text-foreground">{f.name}</span>
                        <span className="block text-sm font-normal text-muted-foreground">{f.line}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
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
        <p className="pt-5 pb-1 group-label">Features</p>
        <ul className="grid grid-cols-2 gap-x-4 border-b pb-2">
          {FEATURES.map((f) => (
            <li key={f.slug}>
              <Link href={`/features/${f.slug}`} onClick={close} className="flex items-center gap-2.5 py-2.5 font-medium">
                <f.icon aria-hidden className="size-4 text-primary" />
                {f.name}
              </Link>
            </li>
          ))}
        </ul>
        <Link href="/pricing" onClick={close} className={row}>
          Pricing
        </Link>
        <a href={DOCS} onClick={close} className={row}>
          Docs
        </a>
        <a href={REPO_URL} onClick={close} className={row}>
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
