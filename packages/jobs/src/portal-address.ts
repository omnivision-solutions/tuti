import { type Prisma, prisma } from "@tuti/db";
import { type PlanFeature, plansWith } from "@tuti/shared";

import { portalOrigin } from "./events";

/**
 * A project's portal's public address: the app's own (APP_URL) for Tuti's own portal
 * (APP_PORTAL_PROJECT), its place on the team's site (https://acme.com/portal) once verified, its custom domain once that's live (verified, and its certificate active,
 * or none where the server's own proxy gets certificates), else its Tuti address (PORTAL_URL_TEMPLATE). Every link Tuti makes to a portal uses this one, so people and
 * search engines see one address. Custom domains are only on where CUSTOM_DOMAIN_TARGET is set, and
 * each of the team's own addresses only on a plan that includes it.
 */
/**
 * A custom domain that's live: verified, and its certificate active (or none, where the server's own
 * proxy gets certificates). Only those are served, and only those are linked to.
 */
/** Projects whose plan includes `feature` (every project, without plans): on a lower plan, its own address isn't served or linked to, and its Tuti address is. */
export function projectWith(feature: PlanFeature): Prisma.ProjectWhereInput {
  const plans = plansWith(feature);
  return plans ? { plan: { in: plans } } : {};
}

export const liveDomain = { verifiedAt: { not: null }, OR: [{ certificate: null }, { certificate: "ACTIVE" }] } satisfies Prisma.CustomDomainWhereInput;

export async function portalAddress(projectSlug: string): Promise<PortalAddress> {
  const origin = portalOrigin(projectSlug) as PortalAddress;
  // Tuti's own portal, under its path on the app's domain (APP_PORTAL_PROJECT; see apps/web/src/lib/app-portal.ts).
  if (projectSlug === process.env.APP_PORTAL_PROJECT?.trim().toLowerCase() && process.env.APP_URL) {
    return `${new URL(process.env.APP_URL).origin}/${projectSlug}` as PortalAddress;
  }
  // Under a path of the team's own site, once verified (SiteMount): https://acme.com/portal.
  const mount = await prisma.siteMount.findFirst({
    where: { project: { slug: projectSlug, ...projectWith("sitePath") }, verifiedAt: { not: null } },
    select: { origin: true, path: true },
  });
  if (mount) {
    return `${mount.origin}${mount.path}` as PortalAddress;
  }
  if (!process.env.CUSTOM_DOMAIN_TARGET?.trim()) {
    return origin;
  }
  const domain = await prisma.customDomain.findFirst({
    where: { project: { slug: projectSlug, ...projectWith("customDomain") }, ...liveDomain },
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
