"use client";

import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useState } from "react";

import { usePortalHref, usePortalPath } from "@/components/portal-base";
import { feedbackHref, PORTAL_PARTS } from "@/components/portal-nav";
import { PortalLogo, usePortalLook } from "@/components/portal-look";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";

/** What the page puts in the menu for its part (the docs' tree, from DocsLayout): set by PortalMenuPart. */
const PartContext = createContext<{
  part: ReactNode;
  setPart: (part: ReactNode) => void;
  notFound: boolean;
  setNotFound: (notFound: boolean) => void;
} | null>(null);

/** Around the header and the page, so a page can give the header's menu its part's navigation (and say it's not found). */
export function PortalMenuProvider({ children }: { children: ReactNode }) {
  const [part, setPart] = useState<ReactNode>(null);
  const [notFound, setNotFound] = useState(false);
  return <PartContext.Provider value={{ part, setPart, notFound, setNotFound }}>{children}</PartContext.Provider>;
}

/** On a page not found: no part of the header or its menu is marked as this page's, and no part's row shows. */
export function PortalNotFoundMark() {
  const setNotFound = useContext(PartContext)?.setNotFound;
  useEffect(() => {
    setNotFound?.(true);
    return () => setNotFound?.(false);
  }, [setNotFound]);
  return null;
}

/** Whether the page is a page not found (PortalNotFoundMark). */
export const usePortalNotFound = () => useContext(PartContext)?.notFound ?? false;

/** On a page: `children` go in the header's menu (on phones and tablets) while the page is shown. Nothing shows here. */
export function PortalMenuPart({ children }: { children: ReactNode }) {
  const setPart = useContext(PartContext)?.setPart;
  useEffect(() => {
    setPart?.(children);
    return () => setPart?.(null);
  }, [setPart, children]);
  return null;
}

/** `path` is `href` or a page under it. */
const within = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/**
 * The header's menu on phones and tablets (wider screens show it all already): the current part's
 * navigation (from the page: the docs' tree, the changelog's entries by date; the boards on Feedback), then the team's header links
 * (Customize → Navigation), which the header leaves out at those widths. Opening a link
 * closes it. Left out when there's nothing to put in it.
 */
export function PortalMenu({
  name,
  homeHref,
  boards,
  parts = false,
  newChangelog = false,
}: {
  name: string;
  homeHref: string;
  boards: { slug: string; name: string }[];
  /** The portal's parts too (Feedback, Roadmap, Changelog, Docs): on phones the header leaves them out for this menu. */
  parts?: boolean;
  /** The changelog has an announcement this reader hasn't seen (the header's dot, in the menu on phones). */
  newChangelog?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const path = usePortalPath();
  const at = usePortalHref();
  const { headerLinks } = usePortalLook();
  const page = useContext(PartContext)?.part ?? null;
  const notFound = usePortalNotFound();

  // What the page gave it (the docs' tree, the changelog's entries), or the boards on Feedback.
  const part = page ? (
    page
  ) : within(path, "/feedback") && boards.length > 1 ? (
    <nav aria-label="Boards" className="flex flex-col gap-0.5 text-sm">
      <p className="px-2 py-1 font-heading font-semibold">Boards</p>
      {boards.map((board) => {
        const active = within(path, boardPath(board));
        return (
          <Link
            key={board.slug}
            href={at(boardPath(board))}
            aria-current={active ? "page" : undefined}
            className={cn("rounded-md px-2 py-1.5", active ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}
          >
            {board.name}
          </Link>
        );
      })}
    </nav>
  ) : null;
  if (!part && headerLinks.length === 0 && !parts) {
    return null;
  }

  // Following a link in it closes it: the page under it changes.
  const closeOnLink = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("a")) {
      setOpen(false);
    }
  };
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Menu" className={cn("md:hidden", !part && headerLinks.length === 0 && "sm:hidden")} />}>
        <MenuIcon />
      </SheetTrigger>
      {/* The whole screen wherever it shows (below tablet width), whatever's selected in it closing it if it's a link. */}
      <SheetContent
        side="right"
        showCloseButton={false}
        onClick={closeOnLink}
        className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
      >
        <div className="flex items-center justify-between gap-2 border-b px-6 py-2">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SheetDescription className="sr-only">{name}: where to go from here.</SheetDescription>
          <PortalLogo name={name} href={homeHref} />
          <SheetClose render={<Button variant="ghost" size="icon-sm" aria-label="Close the menu" />}>
            <XIcon />
          </SheetClose>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* On phones, where the header has no room for them: the parts first, big. */}
          {parts && (
            <nav aria-label="Portal" className="flex flex-col gap-0.5 border-b px-4 py-4 sm:hidden">
              {PORTAL_PARTS.map(({ key, label, href }) => {
                if (key === "feedback" && boards.length === 0) {
                  return null;
                }
                const active = !notFound && within(path, href);
                return (
                  <Link
                    key={key}
                    href={at(key === "feedback" ? feedbackHref(boards) : href)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-lg px-3 py-2.5 font-heading text-lg font-semibold",
                      active ? "bg-accent text-foreground" : "text-foreground hover:bg-muted",
                    )}
                  >
                    {label}
                    {key === "changelog" && newChangelog && !active && (
                      <span className="ml-2 inline-block size-2 rounded-full bg-unread align-middle">
                        <span className="sr-only">New</span>
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          )}
          {/* A size up from the sidebar: these are taps on a phone. */}
          {part && <div className="border-b px-4 py-5 [&_nav]:text-base [&_ul[aria-label=Links]]:text-base">{part}</div>}
          {headerLinks.length > 0 && (
            <nav aria-label="Links" className="flex flex-col gap-0.5 px-4 py-5">
              {headerLinks.map((link, i) => (
                <a key={i} href={link.url} className="rounded-md px-2 py-2 break-words text-muted-foreground hover:text-foreground">
                  {link.label}
                </a>
              ))}
            </nav>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
