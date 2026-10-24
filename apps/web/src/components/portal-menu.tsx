"use client";

import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useState } from "react";

import { usePortalHref, usePortalPath } from "@/components/portal-base";
import { PortalLogo, usePortalLook } from "@/components/portal-look";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { boardPath } from "@/lib/post-urls";
import { cn } from "@/lib/utils";

/** What the page puts in the menu for its part (the docs' tree, from DocsLayout): set by PortalMenuPart. */
const PartContext = createContext<{ part: ReactNode; setPart: (part: ReactNode) => void } | null>(null);

/** Around the header and the page, so a page can give the header's menu its part's navigation. */
export function PortalMenuProvider({ children }: { children: ReactNode }) {
  const [part, setPart] = useState<ReactNode>(null);
  return <PartContext.Provider value={{ part, setPart }}>{children}</PartContext.Provider>;
}

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
 * navigation (the docs' tree, from the page; the boards on Feedback), then the team's header links and
 * contact button (Customize → Navigation), which the header leaves out at those widths. Opening a link
 * closes it. Left out when there's nothing to put in it.
 */
export function PortalMenu({ name, homeHref, boards }: { name: string; homeHref: string; boards: { slug: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const path = usePortalPath();
  const at = usePortalHref();
  const { headerLinks, contact } = usePortalLook();
  const page = useContext(PartContext)?.part ?? null;

  const part = within(path, "/docs") ? (
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
  if (!part && headerLinks.length === 0 && !contact) {
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
      <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Menu" className="md:hidden" />}>
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
          {/* A size up from the sidebar: these are taps on a phone. */}
          {part && <div className="border-b px-4 py-5 [&_nav]:text-base">{part}</div>}
          {(headerLinks.length > 0 || contact) && (
            <div className="flex flex-col gap-1 px-4 py-5">
              {headerLinks.length > 0 && (
                <nav aria-label="Links" className="flex flex-col gap-0.5">
                  {headerLinks.map((link, i) => (
                    <a key={i} href={link.url} className="rounded-md px-2 py-2 break-words text-muted-foreground hover:text-foreground">
                      {link.label}
                    </a>
                  ))}
                </nav>
              )}
              {contact && (
                <a href={contact.url} className={buttonVariants({ size: "lg", className: "mt-3 w-full" })}>
                  {contact.label || "Contact us"}
                </a>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
