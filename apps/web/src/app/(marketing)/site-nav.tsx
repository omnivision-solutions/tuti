"use client";

import { NavigationMenu } from "@base-ui/react/navigation-menu";
import {
  BookOpenIcon,
  ChevronDownIcon,
  MenuIcon,
  XIcon,
  CodeIcon,
  FilePenLineIcon,
  LockIcon,
  MapIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  NewspaperIcon,
  SearchIcon,
  SparklesIcon,
  SquareCheckIcon,
  ThumbsUpIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { GithubMark } from "@/components/github-mark";
import { AUTH_PAGES } from "@/components/theme-provider";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Feature = { icon: (props: { className?: string }) => React.ReactNode; title: string; text: string; href: string };

/**
 * The features menu's columns. Each feature points at the part of the home page (or the docs) that shows it.
 * With plans for sale, a paid plan's feature names its plan.
 */
function columns(docs: string, pricing: boolean): { title: string; features: Feature[] }[] {
  return [
    {
      title: "Help center",
      features: [
        { icon: BookOpenIcon, title: "Hosted help center", text: pricing ? "Your domain on Pro, a path of your site on Business" : "Your domain or a path of your site", href: "/#features" },
        { icon: SparklesIcon, title: "AI answers", text: "Instant answers, with sources", href: "/#features" },
        { icon: MessageCircleIcon, title: "In-app widget", text: "Help inside your product", href: "/#features" },
        { icon: LockIcon, title: "Private docs", text: pricing ? "Single sign-on and reader groups, on Business" : "Single sign-on and reader groups", href: "/#features" },
        { icon: SearchIcon, title: "Search insights", text: "See what customers can't find", href: "/#features" },
      ],
    },
    {
      title: "Autopilot",
      features: [
        { icon: FilePenLineIcon, title: "Articles fix themselves", text: "Rewritten when you ship", href: "/#autopilot" },
        { icon: SquareCheckIcon, title: "Feature requests, closed out", text: "Marked done, everyone told", href: "/#autopilot" },
        { icon: NewspaperIcon, title: "Changelog, drafted", text: "From what you shipped", href: "/#autopilot" },
      ],
    },
    {
      title: "Feedback",
      features: [
        { icon: ThumbsUpIcon, title: "Feedback boards", text: "Customers vote on feature requests", href: "/#connected" },
        { icon: MapIcon, title: "Roadmap", text: "Planned, in progress, shipped", href: "/#connected" },
        { icon: MegaphoneIcon, title: "Changelog", text: "Emailed to subscribers", href: "/#connected" },
        { icon: GithubMark, title: "GitHub", text: "Reads each change you ship", href: "/#autopilot" },
        { icon: CodeIcon, title: "API and MCP", text: "Build on Tuti, or work from Claude", href: docs },
      ],
    },
  ];
}

const LINK = buttonVariants({ variant: "ghost", className: "text-[15px] font-medium" });

/** The site's middle links on wider screens: a features menu, then Pricing and Docs. Smaller ones get `MobileNav`. */
export function SiteNav({ docs, pricing }: { docs: string; pricing: boolean }) {
  return (
    <NavigationMenu.Root aria-label="Site" className="max-md:hidden">
      <NavigationMenu.List className="flex items-center gap-1">
        <NavigationMenu.Item>
          <NavigationMenu.Trigger className={cn(LINK, "group data-popup-open:bg-muted")}>
            Features
            <NavigationMenu.Icon className="transition-transform group-data-popup-open:rotate-180">
              <ChevronDownIcon className="size-4" />
            </NavigationMenu.Icon>
          </NavigationMenu.Trigger>
          <NavigationMenu.Content className="w-[min(60rem,calc(100vw-3rem))]">
            <div className="grid gap-8 p-8 md:grid-cols-3">
              {columns(docs, pricing).map((column) => (
                <div key={column.title}>
                  <p className="text-xs font-bold tracking-wider text-soft-foreground uppercase">{column.title}</p>
                  <ul className="mt-4 flex flex-col gap-1">
                    {column.features.map((feature) => (
                      <li key={feature.title}>
                        <NavigationMenu.Link href={feature.href} closeOnClick className="-mx-2 flex items-start gap-3 rounded-lg p-2 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs">
                            <feature.icon className="size-4" />
                          </span>
                          <span className="flex flex-col">
                            <span className="font-medium">{feature.title}</span>
                            <span className="text-sm text-muted-foreground">{feature.text}</span>
                          </span>
                        </NavigationMenu.Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {pricing && (
              <p className="border-t bg-muted/40 px-8 py-4 text-sm">
                Free to start, Autopilot included.{" "}
                <NavigationMenu.Link href="/pricing" closeOnClick className="font-semibold text-soft-foreground hover:underline">
                  See pricing →
                </NavigationMenu.Link>
              </p>
            )}
          </NavigationMenu.Content>
        </NavigationMenu.Item>
        {pricing && (
          <NavigationMenu.Item>
            <NavigationMenu.Link href="/pricing" className={LINK}>
              Pricing
            </NavigationMenu.Link>
          </NavigationMenu.Item>
        )}
        <NavigationMenu.Item>
          <NavigationMenu.Link href={docs} className={LINK}>
            Docs
          </NavigationMenu.Link>
        </NavigationMenu.Item>
      </NavigationMenu.List>
      <NavigationMenu.Portal>
        <NavigationMenu.Positioner sideOffset={10} collisionPadding={24} className="z-50">
          <NavigationMenu.Popup className="overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-xl duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <NavigationMenu.Viewport />
          </NavigationMenu.Popup>
        </NavigationMenu.Positioner>
      </NavigationMenu.Portal>
    </NavigationMenu.Root>
  );
}

/**
 * The site's links on phones and tablets: a menu button that opens them under the header, with features grouped
 * in a fold and the sign-in buttons full width at the bottom.
 */
export function MobileNav({ docs, pricing, signedIn }: { docs: string; pricing: boolean; signedIn: boolean }) {
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
        className={buttonVariants({ variant: "outline", size: "icon-lg", className: "md:hidden" })}
      >
        {open ? <XIcon /> : <MenuIcon />}
      </button>
      <nav id="mobile-nav" aria-label="Site" hidden={!open} className="absolute inset-x-0 top-full z-40 max-h-[calc(100dvh-4rem)] overflow-y-auto border-b bg-background px-4 pb-6 shadow-lg sm:px-6 md:hidden">
        <details className="group border-b">
          <summary className={cn(row, "cursor-pointer list-none border-0 [&::-webkit-details-marker]:hidden")}>
            Features
            <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="flex flex-col gap-5 pb-4">
            {columns(docs, pricing).map((column) => (
              <div key={column.title}>
                <p className="text-xs font-bold tracking-wider text-soft-foreground uppercase">{column.title}</p>
                <ul className="mt-2 flex flex-col">
                  {column.features.map((feature) => (
                    <li key={feature.title}>
                      <a href={feature.href} onClick={close} className="-mx-2 flex items-center gap-3 rounded-lg p-2 hover:bg-muted">
                        <feature.icon className="size-4 shrink-0 text-muted-foreground" />
                        {feature.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
        {pricing && (
          <Link href="/pricing" onClick={close} className={row}>
            Pricing
          </Link>
        )}
        <a href={docs} onClick={close} className={row}>
          Docs
        </a>
        <div className="mt-6 flex flex-col gap-2">
          {signedIn ? (
            <Link href="/app" onClick={close} className={buttonVariants({ size: "lg" })}>
              Open app
            </Link>
          ) : (
            <>
              <Link href="/sign-in" onClick={close} className={buttonVariants({ variant: "outline", size: "lg" })}>
                Sign in
              </Link>
              <Link href="/sign-up" onClick={close} className={buttonVariants({ size: "lg" })}>
                Start free
              </Link>
            </>
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
      <Link href="/sign-up" className={buttonVariants({ className: "max-md:hidden" })}>
        Start free
      </Link>
    </>
  );
}
