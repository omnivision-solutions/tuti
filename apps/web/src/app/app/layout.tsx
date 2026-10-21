import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { PendingInvitations } from "@/components/pending-invitations";
import { VerifyEmailBanner } from "@/components/verify-email-banner";
import { portalAddress } from "@/server/custom-domains";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { pendingInvitationsFor } from "@/server/invitation-lookup";
import { listMyProjects } from "@/server/membership";
import { getSession } from "@/server/session";

/** Every /app page: signed-in only, same sidebar shell. */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }

  const invitations = await pendingInvitationsFor(session.user);
  const projects = await Promise.all(
    (await listMyProjects(session.user.id)).map(async (project) => ({ ...project, portalUrl: await portalAddress(project.slug) })),
  );
  const lastSlug = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  const fallbackSlug = projects.find((p) => p.slug === lastSlug)?.slug ?? projects[0]?.slug ?? null;

  return (
    <SidebarProvider>
      <AppSidebar
        projects={projects}
        fallbackSlug={fallbackSlug}
        user={{ name: session.user.name, email: session.user.email, image: session.user.image ?? null }}
      />
      <SidebarInset>
        <AppHeader projects={projects} fallbackSlug={fallbackSlug} />
        {/* Docs pages take the whole width: their tree is a column of its own (DocsWorkspace). */}
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6 has-data-[slot=docs-layout]:max-w-none">
          {!session.user.emailVerified && <VerifyEmailBanner email={session.user.email} />}
          <PendingInvitations invitations={invitations} />
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
