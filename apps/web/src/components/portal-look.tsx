"use client";

import { LinkIcon } from "lucide-react";
import Link from "next/link";
import { createContext, useContext } from "react";

import { usePortalPath } from "@/components/portal-base";
import { TutiMark } from "@/components/tuti-logo";
import { DEFAULT_LOOK, type LookImage, type PortalLook, PREVIEW_FRAME } from "@/lib/portal-look";
import { cn } from "@/lib/utils";

/** In Customize's preview: a frame named PREVIEW_FRAME (its own page, or the widget's panel in it). */
export const inPreview = () => window.name === PREVIEW_FRAME && window.parent !== window;

export const LookContext = createContext<PortalLook | null>(null);

/** How the portal looks on this page: what's saved, or in Customize's preview what the team is trying. */
export function usePortalLook(): PortalLook {
  return useContext(LookContext) ?? DEFAULT_LOOK;
}

/**
 * The header's logo (one for dark mode too, if there is one) and its text, or without a logo the
 * project's name; it opens the portal's home, or the team's own address (Customize → Branding).
 */
export function PortalLogo({ name, href }: { name: string; href: string }) {
  const { logo, logoDark, logoText, logoLink } = usePortalLook();
  const image = (image: LookImage, className?: string) => (
    // Narrower on phones, so the header's buttons stay on its first line beside it.
    // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
    <img src={image.url} alt={logoText ? "" : name} width={image.width} height={image.height} className={cn("h-8 w-auto max-w-32 object-contain object-left sm:max-w-48", className)} />
  );
  const contents = logo ? (
    <>
      {image(logo, logoDark ? "dark:hidden" : undefined)}
      {logoDark && image(logoDark, "hidden dark:block")}
      {logoText && <span className="truncate">{logoText}</span>}
    </>
  ) : (
    <>
      {/* Without a logo, a mark of the name's first letter, so the header has the brand's square as every portal's does. */}
      <LetterMark name={logoText || name} className="size-8 rounded-lg text-[0.9375rem]" />
      <span className="truncate">{logoText || name}</span>
    </>
  );
  // It gives way (a long name is cut short with "…") rather than the header's buttons.
  const className = "flex min-w-0 items-center gap-2.5 font-heading text-lg font-bold tracking-[-0.02em]";
  return logoLink ? (
    <a href={logoLink} className={className}>
      {contents}
    </a>
  ) : (
    <Link href={href} className={className}>
      {contents}
    </Link>
  );
}

/** A square in the brand's colour with the name's first letter: the portal's mark where it has no logo. */
function LetterMark({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center bg-primary font-bold text-primary-foreground", className)}>
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The portal's mark over its sign-in: its logo (and dark one), or the letter mark. */
export function PortalMark({ name }: { name: string }) {
  const { logo, logoDark, logoText } = usePortalLook();
  if (!logo) {
    return <LetterMark name={logoText || name} className="mb-2 size-12 rounded-xl text-xl" />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized
  const image = (image: LookImage, className?: string) => <img src={image.url} alt="" className={cn("mb-2 h-12 w-auto max-w-48 object-contain", className)} />;
  return (
    <>
      {image(logo, logoDark ? "dark:hidden" : undefined)}
      {logoDark && image(logoDark, "hidden dark:block")}
    </>
  );
}

/** The team's links above the docs' tree, or alone beside a tab's overview (Customize → Navigation). */
export function DocsSidebarLinks({ className }: { className?: string }) {
  const { sidebarLinks } = usePortalLook();
  if (sidebarLinks.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Links" className={cn("flex flex-col gap-0.5 text-sm", className)}>
      {sidebarLinks.map((link, i) => (
        <li key={i}>
          <a href={link.url} className="flex items-center gap-2 rounded-md px-2 py-1 break-words text-muted-foreground transition-colors hover:text-foreground">
            <LinkIcon aria-hidden className="size-3.5 shrink-0" />
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** `children` only where the team has docs sidebar links (beside a tab's overview, which has no tree). */
export function IfSidebarLinks({ children }: { children: React.ReactNode }) {
  return usePortalLook().sidebarLinks.length > 0 ? children : null;
}

/** The team's links in the header. On phones they get a line of their own. */
export function PortalHeaderLinks() {
  const { headerLinks } = usePortalLook();
  if (headerLinks.length === 0) {
    return null;
  }
  return (
    // On phones and tablets they're in the header's menu (PortalMenu).
    <nav aria-label="Links" className="flex flex-wrap gap-x-4 gap-y-1 max-md:hidden">
      {headerLinks.map((link, i) => (
        <a key={i} href={link.url} className="text-sm text-muted-foreground hover:text-foreground">
          {link.label}
        </a>
      ))}
    </nav>
  );
}

/** Without JavaScript (where the header's menu can't open), on phones and tablets: the team's header links in a row of their own. */
export function PortalLinksRow() {
  const { headerLinks } = usePortalLook();
  if (headerLinks.length === 0) {
    return null;
  }
  return (
    <nav aria-label="Links" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-2 md:hidden">
      {headerLinks.map((link, i) => (
        <a key={i} href={link.url} className="text-sm text-muted-foreground hover:text-foreground">
          {link.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * The footer: the team's links, and "Powered by tuti" unless the project has a licence to hide it.
 * The attribution is required by Tuti's additional licence terms (AGPL section 7(b)): see
 * ADDITIONAL-TERMS.md at the root of the repository.
 */
export function PortalFooter({ docs = false }: { docs?: boolean }) {
  const { footerLinks, poweredBy } = usePortalLook();
  const path = usePortalPath();
  // Docs pages have it under the page, beside the tree (DocsLayout): under the tree's column it would push the tree up as it scrolls into view.
  const onDocs = path === "/docs" || path.startsWith("/docs/");
  if ((footerLinks.length === 0 && !poweredBy) || onDocs !== docs) {
    return null;
  }
  return (
    // Inside <main> on Docs, where a footer isn't the page's footer landmark unless it says so.
    <footer role={docs ? "contentinfo" : undefined} className={cn("portal-footer flex flex-col items-center gap-3", docs ? "mt-auto pt-10" : "border-t px-6 py-6")}>
      {footerLinks.length > 0 && (
        <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-4 gap-y-1">
          {footerLinks.map((link, i) => (
            <a key={i} href={link.url} className="text-xs text-muted-foreground hover:text-foreground">
              {link.label}
            </a>
          ))}
        </nav>
      )}
      {poweredBy && <PoweredByTuti />}
    </footer>
  );
}

/** "Powered by tuti", linking to tuti.so: under the portal's pages and the widget's tabs (see PortalFooter). */
export function PoweredByTuti({ className }: { className?: string }) {
  return (
    <a
      // Tuti's own site on every installation, self-hosted too: it's the badge's whole point.
      href="https://tuti.so"
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground", className)}
    >
      Powered by
      <TutiMark className="size-4" />
      <span className="font-heading font-bold text-foreground">tuti</span>
    </a>
  );
}

