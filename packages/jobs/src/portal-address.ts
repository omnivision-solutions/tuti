import { prisma } from "@tuti/db";

import { portalOrigin } from "./events";

/**
 * A project's portal's public address: its custom domain once that's live (verified, and its
 * certificate active, or none where the server's own proxy gets certificates), else its Tuti
 * address (PORTAL_URL_TEMPLATE). Every link Tuti makes to a portal uses this one, so people and
 * search engines see one address. Custom domains are only on where CUSTOM_DOMAIN_TARGET is set.
 */
export async function portalAddress(projectSlug: string): Promise<PortalAddress> {
  const origin = portalOrigin(projectSlug) as PortalAddress;
  if (!process.env.CUSTOM_DOMAIN_TARGET?.trim()) {
    return origin;
  }
  const domain = await prisma.customDomain.findFirst({
    where: { project: { slug: projectSlug }, verifiedAt: { not: null }, OR: [{ certificate: null }, { certificate: "ACTIVE" }] },
    select: { hostname: true },
  });
  if (!domain) {
    return origin;
  }
  // Served like the Tuti address: same protocol, and its port where there's one (local servers).
  const { protocol, port } = new URL(origin);
  return `${protocol}//${domain.hostname}${port ? `:${port}` : ""}` as PortalAddress;
}

/** A portal's address from portalAddress (not a slug, nor just any URL): what post and article links start with. */
export type PortalAddress = string & { readonly portalAddress: unique symbol };
