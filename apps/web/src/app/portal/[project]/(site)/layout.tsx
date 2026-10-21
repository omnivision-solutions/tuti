import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { after } from "next/server";
import { notFound } from "next/navigation";
import { cache } from "react";

import { PortalBaseProvider } from "@/components/portal-base";
import { PortalFooter, PortalHeaderLinks, PortalLogo, PortalLookProvider } from "@/components/portal-look";
import { DocsSearch, PartRows, PortalMain, PortalParts } from "@/components/portal-nav";
import { SignInLink } from "@/components/sign-in-link";
import { buttonVariants } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import { appUrl, resolveHost } from "@/lib/hosts";
import { withBase } from "@/lib/portal-base";
import { DAY_MS, renewLicense } from "@/server/license-renewal";
import { branding } from "@/server/operations/branding";
import { hasUnseenAnnouncement } from "@/server/operations/changelog-seen";
import { canReadPortal } from "@/server/portal-access";
import { portalBase } from "@/server/portal-base";
import { getSession } from "@/server/session";

/** Read once per request by both the layout and its metadata. */
const portalBranding = cache((slug: string) => branding({ slug }));

export async function generateMetadata({ params }: LayoutProps<"/portal/[project]">): Promise<Metadata> {
  const favicon = (await portalBranding((await params).project))?.favicon;
  if (favicon) {
    return { icons: { icon: [{ url: favicon.url, type: "image/webp" }] } };
  }
  // Under a path of a team's site, Tuti's own icon is there too (/icon.svg would be the site's).
  const base = await portalBase();
  return base ? { icons: { icon: [{ url: `${base}/icon.svg`, type: "image/svg+xml" }] } } : {};
}

/**
 * A project's public portal (served on <project>.tuti.so via proxy.ts), in the project's
 * branding (Customize → Branding). Links here are host-relative: "/feedback/ideas", not
 * "/portal/<project>/b/ideas". The header has the portal's parts; under it, the current part's
 * row (`docsTabs`: the docs pages' tabs, from the @docsTabs slot).
 */
export default async function PortalLayout({ children, docsTabs, params }: LayoutProps<"/portal/[project]">) {
  const { project: slug } = await params;
  const [project, brand] = await Promise.all([
    prisma.project.findUnique({
      where: { slug },
      select: { id: true, name: true, boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } } },
    }),
    portalBranding(slug),
  ]);
  if (!project || !brand) {
    notFound();
  }
  // Once the page is sent: renews the project's licence key from tuti.so, at most daily (and only if it has one or asked for one).
  after(() => renewLicense(project.id, { olderThan: DAY_MS }));
  // Portal sessions are per host: this is the user signed in on this portal.
  const session = await getSession();
  const onApp = resolveHost((await headers()).get("host")).kind === "app";
  // On a private portal, the pages anyone may open (signing in) don't show what's on it.
  // proxy.ts keeps them from the rest; this only hides the parts.
  const canRead = await canReadPortal({ id: project.id }, session?.user.id);
  // An announcement they haven't seen anywhere (here, or in the widget on any device).
  const newChangelog = canRead && !!session && (await hasUnseenAnnouncement(project.id, session.user.id));

  const base = await portalBase();
  return (
    <PortalBaseProvider base={base} slug={slug}>
      <PortalLookProvider saved={brand} appOrigin={appUrl().origin}>
        {/* Logo · parts · (on Docs) search · links and the account on the right. On phones the parts, search and links get lines of their own. */}
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b px-6 py-2">
          {/* On the app's own domain, / is the app's: the portal's home is its home page's part there. */}
          <PortalLogo name={project.name} href={withBase(base, "/")} />
          {canRead && <PortalParts boards={project.boards} newChangelog={newChangelog} />}
          {canRead && <DocsSearch />}
          <PortalHeaderLinks />
          {session ? (
            // On the app's own domain (Tuti's own portal) the account, with its password, is the app's.
            <UserMenu name={session.user.name} image={session.user.image ?? null} accountHref={onApp ? `${appUrl().origin}/app/account` : "/account"} />
          ) : (
            <SignInLink className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign in
            </SignInLink>
          )}
        </header>
        {canRead && <PartRows boards={project.boards} docsTabs={docsTabs} />}
        <PortalMain>{children}</PortalMain>
        <PortalFooter />
      </PortalLookProvider>
    </PortalBaseProvider>
  );
}
