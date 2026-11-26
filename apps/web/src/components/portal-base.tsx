"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext } from "react";

import { authClientAt } from "@/lib/auth-client";
import { splitLanguage, withLanguage } from "@/lib/language-addresses";
import { withBase } from "@/lib/portal-base";

const PortalBase = createContext({ base: "", slug: "", prefix: "" });

/**
 * The path the portal is under on the team's site (see lib/portal-base.ts) and the page's language's prefix ("/de", or ""; see
 * lib/language-addresses.ts), for client components.
 */
export function PortalBaseProvider({ base, slug, prefix = "", children }: { base: string; slug: string; prefix?: string; children: React.ReactNode }) {
  return <PortalBase.Provider value={{ base, slug, prefix }}>{children}</PortalBase.Provider>;
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
  const internal = `/portal/${slug}`;
  if (slug && (path === internal || path.startsWith(`${internal}/`))) {
    return path.slice(internal.length) || "/";
  }
  const own = base && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || "/" : path;
  const inLanguage = prefix ? splitLanguage(own) : null;
  return inLanguage ? inLanguage.path : own;
}
