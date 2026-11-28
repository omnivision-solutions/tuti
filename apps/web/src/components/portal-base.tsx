"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useLocale } from "next-intl";
import { createContext, useCallback, useContext } from "react";

import { authClientAt } from "@/lib/auth-client";
import { portalPathOf, withLanguage } from "@/lib/language-addresses";
import { withBase } from "@/lib/portal-base";

const PortalBase = createContext({ base: "", slug: "", prefix: "" });

/**
 * The path the portal is under on the team's site (see lib/portal-base.ts) and the page's language's prefix ("/de", or ""; see
 * lib/language-addresses.ts), for client components.
 */
export function PortalBaseProvider({ base, slug, prefix = "", children }: { base: string; slug: string; prefix?: string; children: React.ReactNode }) {
  return <PortalBase.Provider value={{ base, slug, prefix }}>{children}</PortalBase.Provider>;
}

/** The page's language's prefix ("/de", or "" in the default language). */
export function usePortalLanguagePrefix() {
  return useContext(PortalBase).prefix;
}

/**
 * The page's language when its address is a language's (/de/…), else undefined: what a save through /api/trpc sends as
 * `language` (operations' pageLanguage), since the call's own address isn't the page's.
 */
export function usePageLanguage(): string | undefined {
  const prefix = usePortalLanguagePrefix();
  const locale = useLocale();
  return prefix ? locale : undefined;
}

/** The portal's project, for client components. */
export function usePortalSlug() {
  return useContext(PortalBase).slug;
}

/** Makes root-relative portal paths right for where the portal is and the page's language (/docs → /portal/de/docs). */
export function usePortalHref() {
  const { base, prefix } = useContext(PortalBase);
  return useCallback((path: string) => withBase(base, withLanguage(prefix, path)), [base, prefix]);
}

/** The auth client for where the portal is (its API under the site's path, for one there). */
export function usePortalAuthClient() {
  return authClientAt(useContext(PortalBase).base);
}

/**
 * The portal's own path of this page (/feedback/ideas), whatever the address: on the server it can
 * still be the rewritten /portal/<project>/… (see proxy.ts), in the browser it has the site's path
 * and the language's prefix.
 */
export function usePortalPath(): string {
  const { base, slug, prefix } = useContext(PortalBase);
  const path = usePathname();
  return portalPathOf(path, { base, slug, prefix });
}

/** This page's portal path in its language (/de/feedback/ideas): where signing in (`next`) comes back to. */
export function usePortalHere(): string {
  return withLanguage(useContext(PortalBase).prefix, usePortalPath());
}

/** This page's address in another language, by its prefix ("" for the default language's): the language switcher's. */
export function useAddressIn(): (prefix: string, at?: string) => string {
  const { base } = useContext(PortalBase);
  const path = usePortalPath();
  const search = useSearchParams().toString();
  // `at`: another path for the page there (an article's slug in that language).
  return (prefix, at = path) => `${withBase(base, withLanguage(prefix, at))}${search ? `?${search}` : ""}`;
}
