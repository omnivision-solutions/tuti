"use client";

import { LinkIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, type CSSProperties, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { usePortalPath } from "@/components/portal-base";
import { TutiMark } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { PORTAL_FONT_CLASSES } from "@/components/portal-fonts";
import { brandCss } from "@/lib/colors";
import { fontVariable } from "@/lib/portal-fonts";
import { CUSTOMIZE } from "@/lib/portal-base";
import { DEFAULT_LOOK, type FromPortal, isToPortal, type LookImage, type PortalLook, PREVIEW_FRAME, styleText, webOnly } from "@/lib/portal-look";
import { cn } from "@/lib/utils";

const inPreview = () => window.name === PREVIEW_FRAME && window.parent !== window;

/**
 * Light or dark mode in the preview only: on the page, not where next-themes keeps a reader's pick
 * (the frame shares the portal's storage with the team member's own visits to it).
 */
function showTheme(scheme: PortalLook["colorScheme"]) {
  const mode = scheme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : scheme;
  const html = document.documentElement;
  html.classList.remove("light", "dark");
  html.classList.add(mode);
  html.style.colorScheme = mode;
}

const LookContext = createContext<PortalLook | null>(null);

/** How the portal looks on this page: what's saved, or in Customize's preview what the team is trying. */
export function usePortalLook(): PortalLook {
  return useContext(LookContext) ?? DEFAULT_LOOK;
}

/**
 * The portal's look (its accent colour as CSS, and for the parts that show it). In Customize's
 * preview (a frame named PREVIEW_FRAME), it also takes changes not saved yet and light or dark mode
 * from the app (`appOrigin` only), says which page is open, keeps the preview at the portal's Tuti
 * address as people click around in it, and opens other sites' links in a new tab.
 */
export function PortalLookProvider({ saved, appOrigin, children }: { saved: PortalLook; appOrigin: string; children: ReactNode }) {
  const [draft, setDraft] = useState<Partial<PortalLook>>({});
  const router = useRouter();
  const path = usePortalPath();

  useEffect(() => {
    if (!inPreview()) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== appOrigin || event.source !== window.parent || !isToPortal(event.data)) {
        return;
      }
      if (event.data.type === "tuti:look") {
        setDraft(webOnly(event.data.look));
      } else {
        showTheme(event.data.theme);
      }
    };
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      const url = new URL(link.href);
      event.preventDefault();
      if (url.origin !== window.location.origin) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      url.searchParams.set(CUSTOMIZE.param, CUSTOMIZE.value);
      router.push(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("message", onMessage);
    // Before Next.js's own link handling, which would drop the preview's param.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("click", onClick, true);
    };
  }, [appOrigin, router]);

  useEffect(() => {
    if (inPreview()) {
      window.parent.postMessage({ type: "tuti:ready", path } satisfies FromPortal, appOrigin);
    }
  }, [appOrigin, path]);

  // The default colour scheme, being tried in the preview: once per change of it, so the preview's own
  // light and dark mode still win until it changes again.
  const tried = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (inPreview() && draft.colorScheme && draft.colorScheme !== tried.current) {
      tried.current = draft.colorScheme;
      showTheme(draft.colorScheme);
    }
  }, [draft.colorScheme]);

  const look = { ...saved, ...draft };
  const css = brandCss(look.color);
  // The team's fonts (Customize → Branding → Typography) in place of the page's: a wrapper that adds
  // nothing to the layout (display: contents) but passes them down.
  const { heading, body } = look.fonts;
  const fonts = {
    ...(body && { "--font-sans": `var(${fontVariable(body)})`, fontFamily: `var(${fontVariable(body)})` }),
    ...(heading && { "--font-heading": `var(${fontVariable(heading)})` }),
  } as CSSProperties;
  return (
    <LookContext value={look}>
      {css && <style>{css}</style>}
      <div className={cn("contents", PORTAL_FONT_CLASSES)} style={fonts}>
        {children}
      </div>
      {/* The team's own CSS (Customize → Custom code), after everything else. */}
      {look.customCss && <style>{styleText(look.customCss)}</style>}
    </LookContext>
  );
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
    <span className="truncate">{logoText || name}</span>
  );
  // It gives way (a long name is cut short with "…") rather than the header's buttons.
  const className = "flex min-w-0 items-center gap-2 font-heading text-lg font-bold tracking-tight";
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

/** The header's "Contact us" button (Customize → Navigation), when the team set where it goes. */
export function PortalContact() {
  const { contact } = usePortalLook();
  if (!contact) {
    return null;
  }
  return (
    // On phones and tablets it's in the header's menu (PortalMenu).
    <a href={contact.url} className={buttonVariants({ size: "sm", className: "max-md:hidden" })}>
      {contact.label || "Contact us"}
    </a>
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

/** Without JavaScript (where the header's menu can't open), on phones and tablets: the team's header links and contact button in a row of their own. */
export function PortalLinksRow() {
  const { headerLinks, contact } = usePortalLook();
  if (headerLinks.length === 0 && !contact) {
    return null;
  }
  return (
    <nav aria-label="Links" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-2 md:hidden">
      {headerLinks.map((link, i) => (
        <a key={i} href={link.url} className="text-sm text-muted-foreground hover:text-foreground">
          {link.label}
        </a>
      ))}
      {contact && (
        <a href={contact.url} className={buttonVariants({ size: "sm" })}>
          {contact.label || "Contact us"}
        </a>
      )}
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
    <footer role={docs ? "contentinfo" : undefined} className={cn("portal-footer flex flex-col items-center gap-3", docs ? "mt-auto pt-10" : "px-6 pb-6")}>
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

