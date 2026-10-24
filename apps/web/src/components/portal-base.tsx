"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext } from "react";

import { authClientAt } from "@/lib/auth-client";
import { withBase } from "@/lib/portal-base";

const PortalBase = createContext({ base: "", slug: "" });

/** The path the portal is under on the team's site (see lib/portal-base.ts), for client components. */
export function PortalBaseProvider({ base, slug, children }: { base: string; slug: string; children: React.ReactNode }) {
  return <PortalBase.Provider value={{ base, slug }}>{children}</PortalBase.Provider>;
}

/** The portal's project, for client components. */
export function usePortalSlug() {
  return useContext(PortalBase).slug;
}

/** Makes root-relative portal paths right for where the portal is (/docs → /portal/docs). */
export function usePortalHref() {
  const { base } = useContext(PortalBase);
  return useCallback((path: string) => withBase(base, path), [base]);
}

/** The auth client for where the portal is (its API under the site's path, for one there). */
export function usePortalAuthClient() {
  return authClientAt(useContext(PortalBase).base);
}

/**
 * The portal's own path of this page (/feedback/ideas), whatever the address: on the server it can
 * still be the rewritten /portal/<project>/… (see proxy.ts), in the browser it has the site's path.
 */
export function usePortalPath(): string {
  const { base, slug } = useContext(PortalBase);
  const path = usePathname();
  const internal = `/portal/${slug}`;
  if (slug && (path === internal || path.startsWith(`${internal}/`))) {
    return path.slice(internal.length) || "/";
  }
  if (base && (path === base || path.startsWith(`${base}/`))) {
    return path.slice(base.length) || "/";
  }
  return path;
}
