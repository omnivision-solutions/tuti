import { prisma } from "@tuti/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BoardTabs } from "@/components/board-tabs";
import { PortalBaseProvider } from "@/components/portal-base";
import { SignInLink } from "@/components/sign-in-link";
import { TutiMark } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import { appUrl, resolveHost } from "@/lib/hosts";
import { withBase } from "@/lib/portal-base";
import { cn } from "@/lib/utils";
import { branding, brandCss } from "@/server/operations/branding";
import { hasUnseenAnnouncement } from "@/server/operations/changelog-seen";
import { canReadPortal } from "@/server/portal-access";
import { portalBase } from "@/server/portal-base";
import { portalHomePath } from "@/server/portal-home";
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
 * branding (Settings → Branding). Links here are host-relative: "/feedback/ideas", not
 * "/portal/<project>/b/ideas".
 */
export default async function PortalLayout({ children, params }: LayoutProps<"/portal/[project]">) {
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
  // Portal sessions are per host: this is the user signed in on this portal.
  const session = await getSession();
  const onApp = resolveHost((await headers()).get("host")).kind === "app";
  const css = brandCss(brand.color);
  const logo = (image: NonNullable<typeof brand.logo>, className?: string) => (
    // eslint-disable-next-line @next/next/no-img-element -- served from the media host, already resized
    <img
      src={image.url}
      alt={project.name}
      width={image.width}
      height={image.height}
      className={cn("h-8 w-auto max-w-48 object-contain object-left", className)}
    />
  );
  // On a private portal, the pages anyone may open (signing in) don't show what's on it.
  // proxy.ts keeps them from the rest; this only hides the tabs.
  const canRead = await canReadPortal({ id: project.id }, session?.user.id);
  // An announcement they haven't seen anywhere (here, or in the widget on any device).
  const newChangelog = canRead && !!session && (await hasUnseenAnnouncement(project.id, session.user.id));

  const base = await portalBase();
  return (
    <PortalBaseProvider base={base} slug={slug}>
      {css && <style>{css}</style>}
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b px-6 py-2">
        {/* On the app's own domain, / is the app's: the portal's home is its home page's part there. */}
        <Link href={onApp ? ((await portalHomePath(slug)) ?? "/") : withBase(base, "/")} className="font-heading text-lg font-bold tracking-tight">
          {brand.logo ? (
            <>
              {logo(brand.logo, brand.logoDark ? "dark:hidden" : undefined)}
              {brand.logoDark && logo(brand.logoDark, "hidden dark:block")}
            </>
          ) : (
            project.name
          )}
        </Link>
        {brand.headerLinks.length > 0 && (
          // On phones the links get a line of their own under the name.
          <nav aria-label="Links" className="order-last flex w-full flex-wrap gap-x-4 gap-y-1 pb-1 sm:order-none sm:w-auto sm:flex-1 sm:pb-0">
            {brand.headerLinks.map((link, i) => (
              <a key={i} href={link.url} className="text-sm text-muted-foreground hover:text-foreground">
                {link.label}
              </a>
            ))}
          </nav>
        )}
        {session ? (
          // On the app's own domain (Tuti's own portal) the account is the app's.
          <UserMenu name={session.user.name} image={session.user.image ?? null} accountHref={onApp ? "/app/account" : "/account"} />
        ) : (
          <SignInLink className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Sign in
          </SignInLink>
        )}
      </header>
      {canRead && <BoardTabs boards={project.boards} newChangelog={newChangelog} />}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">{children}</main>
      {(brand.footerLinks.length > 0 || brand.poweredBy) && (
        <footer className="flex flex-col items-center gap-3 px-6 pb-6">
          {brand.footerLinks.length > 0 && (
            <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-4 gap-y-1">
              {brand.footerLinks.map((link, i) => (
                <a key={i} href={link.url} className="text-xs text-muted-foreground hover:text-foreground">
                  {link.label}
                </a>
              ))}
            </nav>
          )}
          {brand.poweredBy && (
            <a
              href={appUrl().origin}
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
      )}
    </PortalBaseProvider>
  );
}
