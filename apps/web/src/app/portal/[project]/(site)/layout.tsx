import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { after } from "next/server";
import { notFound } from "next/navigation";
import { cache } from "react";

import { PortalBaseProvider } from "@/components/portal-base";
import { ColorSchemeScript } from "@/components/color-scheme-script";
import { PortalContact, PortalFooter, PortalHeaderLinks, PortalLinksRow, PortalLogo, PortalLookProvider } from "@/components/portal-look";
import { DocsSearch, PartRows, PortalMain, PortalParts, PortalTop } from "@/components/portal-nav";
import { answersEnabled } from "@/server/operations/docs-ask";
import { askAPerson } from "@/server/operations/docs-escalate";
import { DocsAssistantProvider } from "@/components/docs-assistant";
import { cn } from "@/lib/utils";
import { PortalMenu, PortalMenuProvider } from "@/components/portal-menu";
import { boardPath } from "@/lib/post-urls";
import { SignInLink } from "@/components/sign-in-link";
import { buttonVariants } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import { appUrl, portalUrl, resolveHost } from "@/lib/hosts";
import { withBase } from "@/lib/portal-base";
import { DAY_MS, renewLicense } from "@/server/license-renewal";
import { branding } from "@/server/operations/branding";
import { hasUnseenAnnouncement } from "@/server/operations/changelog-seen";
import { canReadPortal } from "@/server/portal-access";
import { portalBase } from "@/server/portal-base";
import { TeamHtml } from "@/components/team-html";
import { requestTarget, siteMount } from "@/server/custom-domains";
import { getSession } from "@/server/session";

/** Read once per request by both the layout and its metadata. */
const portalBranding = cache((slug: string) => branding({ slug }));

export async function generateMetadata({ params }: LayoutProps<"/portal/[project]">): Promise<Metadata> {
  const slug = (await params).project;
  const [brand, project] = await Promise.all([portalBranding(slug), prisma.project.findUnique({ where: { slug }, select: { name: true } })]);
  // The portal's search listing (Customize → SEO), for its pages that don't have their own.
  const title = brand?.seo.title || project?.name;
  const seo: Metadata = {
    ...(title && { title }),
    ...(brand?.seo.description && { description: brand.seo.description }),
    openGraph: {
      ...(title && { siteName: title }),
      ...(brand?.seo.description && { description: brand.seo.description }),
      ...(brand?.seoImage && { images: [{ url: brand.seoImage.url, width: brand.seoImage.width, height: brand.seoImage.height }] }),
    },
  };
  if (brand?.favicon) {
    return { ...seo, icons: { icon: [{ url: brand.favicon.url, type: "image/webp" }] } };
  }
  // Under a path of a team's site, Tuti's own icon is there too (/icon.svg would be the site's).
  const base = await portalBase();
  return base ? { ...seo, icons: { icon: [{ url: `${base}/icon.svg`, type: "image/svg+xml" }] } } : seo;
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
  const requestHeaders = await headers();
  const onApp = resolveHost(requestHeaders.get("host")).kind === "app";
  // On a private portal, the pages anyone may open (signing in) don't show what's on it.
  // proxy.ts keeps them from the rest; this only hides the parts.
  const canRead = await canReadPortal({ id: project.id }, session?.user.id);
  // An announcement they haven't seen anywhere (here, or in the widget on any device).
  const newChangelog = canRead && !!session && (await hasUnseenAnnouncement(project.id, session.user.id));

  const base = await portalBase();
  // The team's own origin, where their HTML may run: their domain, or the site the portal is under (not
  // Tuti's own portal on the app's domain). Only an expectation: TeamHtml checks the page is there.
  const target = await requestTarget(requestHeaders.get("host"));
  const mount = base ? await siteMount(slug) : null;
  const ownOrigin = onApp
    ? null
    : mount
      ? mount.origin
      : target.kind === "portal" && target.customDomain
        ? `${new URL(portalUrl(slug)).protocol}//${requestHeaders.get("host")}`
        : null;
  // The docs' assistant (AI answers as a conversation), for readers, when the server has AI answers.
  const assistant = canRead && answersEnabled();
  const firstBoard = project.boards[0];
  const assistantProps = assistant
    ? {
        projectName: project.name,
        viewer: session?.user.id ?? null,
        feedbackPath: firstBoard ? boardPath(firstBoard) : null,
        askAPerson: await askAPerson(slug),
      }
    : null;

  return (
    <PortalBaseProvider base={base} slug={slug}>
      {/* Not on the app's own domain (Tuti's own portal): the theme kept there is the app's, its user's pick. */}
      {!onApp && <ColorSchemeScript scheme={brand.colorScheme} />}
      <PortalLookProvider saved={brand} appOrigin={appUrl().origin}>
        {/* Logo · parts · (on Docs) search · links and the account on the right. On phones the parts, search and links get lines of their own. */}
        {/* portal-header, portal-footer: names for teams' own CSS (Customize → Custom code) to go by. */}
        <WithAssistant assistant={assistantProps}>
        <PortalMenuProvider>
        <PortalTop>
        {/* On phones the parts' tabs sit on its bottom edge, under room for the first line. */}
        <header className={cn("portal-header flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-6 pt-3 sm:py-2.5", !canRead && "pb-3")}>
          {/* On the app's own domain, / is the app's: the portal's home is its home page's part there. */}
          {/* On phones it takes what the buttons leave (a long name is cut short), so they share its line. */}
          <div className="flex min-w-0 max-sm:grow max-sm:basis-0">
            <PortalLogo name={project.name} href={withBase(base, "/")} />
          </div>
          {canRead && <PortalParts boards={project.boards} newChangelog={newChangelog} />}
          {/* On the right; on phones and tablets the links and contact button are in the menu. It doesn't shrink: the logo does. */}
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {canRead && <DocsSearch askAI={answersEnabled()} />}
            <PortalHeaderLinks />
            <PortalContact />
            {session ? (
              // On the app's own domain (Tuti's own portal) the account, with its password, is the app's.
              <UserMenu name={session.user.name} image={session.user.image ?? null} accountHref={onApp ? `${appUrl().origin}/app/account` : "/account"} />
            ) : (
              <SignInLink className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Sign in
              </SignInLink>
            )}
            {/* For everyone: on a private portal's sign-in page it has the team's links and contact button (no parts). */}
            <PortalMenu name={project.name} homeHref={withBase(base, "/")} boards={canRead ? project.boards : []} />
          </div>
        </header>
        {canRead && <PartRows boards={project.boards} docsTabs={docsTabs} />}
        </PortalTop>
        {/* Without JavaScript the menu can't open: on phones and tablets, the team's links and contact button under the
            header. Not in it: however many lines they take, the header stays the height its scroll-padding allows for. */}
        <noscript>
          <PortalLinksRow />
        </noscript>
        <PortalMain>{children}</PortalMain>
        <PortalFooter />
        </PortalMenuProvider>
        </WithAssistant>
      </PortalLookProvider>
      {/* The team's HTML (Customize → Custom code): only on their own domain or site, where it runs on their origin (TeamHtml
          checks the page's real origin). Never on a Tuti address (a script there could pass for Tuti) or the app's own domain. */}
      {brand.customHtml && ownOrigin && <TeamHtml html={brand.customHtml} origin={ownOrigin} />}
    </PortalBaseProvider>
  );
}

/** The page inside the docs' assistant, where the portal has one. */
function WithAssistant({ assistant, children }: { assistant: Omit<React.ComponentProps<typeof DocsAssistantProvider>, "children"> | null; children: React.ReactNode }) {
  return assistant ? <DocsAssistantProvider {...assistant}>{children}</DocsAssistantProvider> : children;
}
