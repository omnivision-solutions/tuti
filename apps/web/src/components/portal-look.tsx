"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { usePortalPath } from "@/components/portal-base";
import { TutiMark } from "@/components/tuti-logo";
import { brandCss } from "@/lib/colors";
import { CUSTOMIZE } from "@/lib/portal-base";
import { DEFAULT_LOOK, type FromPortal, isToPortal, type LookImage, type PortalLook, PREVIEW_FRAME, webOnly } from "@/lib/portal-look";
import { cn } from "@/lib/utils";

const inPreview = () => window.name === PREVIEW_FRAME && window.parent !== window;

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
  const { setTheme } = useTheme();
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
        setTheme(event.data.theme);
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
  }, [appOrigin, setTheme, router]);

  useEffect(() => {
    if (inPreview()) {
      window.parent.postMessage({ type: "tuti:ready", path } satisfies FromPortal, appOrigin);
    }
  }, [appOrigin, path]);

  const look = { ...saved, ...draft };
  const css = brandCss(look.color);
  return (
    <LookContext value={look}>
      {css && <style>{css}</style>}
      {children}
    </LookContext>
  );
}

/** The header's logo (one for dark mode too, if there is one), or the project's name; it opens the portal's home. */
export function PortalLogo({ name, href }: { name: string; href: string }) {
  const { logo, logoDark } = usePortalLook();
  const image = (image: LookImage, className?: string) => (
    // eslint-disable-next-line @next/next/no-img-element -- served from the media host, already resized
    <img src={image.url} alt={name} width={image.width} height={image.height} className={cn("h-8 w-auto max-w-48 object-contain object-left", className)} />
  );
  return (
    <Link href={href} className="font-heading text-lg font-bold tracking-tight">
      {logo ? (
        <>
          {image(logo, logoDark ? "dark:hidden" : undefined)}
          {logoDark && image(logoDark, "hidden dark:block")}
        </>
      ) : (
        name
      )}
    </Link>
  );
}

/** The team's links in the header. On phones they get a line of their own. */
export function PortalHeaderLinks() {
  const { headerLinks } = usePortalLook();
  if (headerLinks.length === 0) {
    return null;
  }
  return (
    <nav aria-label="Links" className="order-last flex w-full flex-wrap gap-x-4 gap-y-1 pb-1 sm:order-none sm:ml-auto sm:w-auto sm:pb-0">
      {headerLinks.map((link, i) => (
        <a key={i} href={link.url} className="text-sm text-muted-foreground hover:text-foreground">
          {link.label}
        </a>
      ))}
    </nav>
  );
}

/** The footer: the team's links, and "Powered by tuti" unless the project has a licence to hide it. */
export function PortalFooter() {
  const { footerLinks, poweredBy } = usePortalLook();
  if (footerLinks.length === 0 && !poweredBy) {
    return null;
  }
  return (
    <footer className="flex flex-col items-center gap-3 px-6 pb-6">
      {footerLinks.length > 0 && (
        <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-4 gap-y-1">
          {footerLinks.map((link, i) => (
            <a key={i} href={link.url} className="text-xs text-muted-foreground hover:text-foreground">
              {link.label}
            </a>
          ))}
        </nav>
      )}
      {poweredBy && (
        <a
          // Tuti's own site on every installation, self-hosted too: it's the badge's whole point.
          href="https://tuti.so"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Powered by
          <TutiMark className="size-4" />
          <span className="font-heading font-bold text-foreground">tuti</span>
        </a>
      )}
    </footer>
  );
}
