import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { AppWidget } from "@/components/app-widget";
import { AppShell } from "@/components/app-shell";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingInvitations } from "@/components/pending-invitations";
import { VerifyEmailBanner } from "@/components/verify-email-banner";
import { portalAddress } from "@/server/custom-domains";
import { appWidgetProject } from "@/lib/app-portal";
import { DOCS_TREE_FOLDED_SCRIPT } from "@/lib/docs-tree-fold";
import { PANE_WIDTHS_SCRIPT } from "@/lib/pane-width";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { asksToVerifyEmail } from "@/lib/verify-email";
import { pendingInvitationsFor } from "@/server/invitation-lookup";
import { listMyProjects } from "@/server/membership";
import { getSession } from "@/server/session";

/** Every /app page: signed-in only, same sidebar shell (components/app-shell.tsx). */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }

  const invitations = await pendingInvitationsFor(session.user);
  const projects = await Promise.all(
    (await listMyProjects(session.user.id)).map(async (project) => ({ ...project, portalUrl: await portalAddress(project.slug) })),
  );
  const cookieStore = await cookies();
  const lastSlug = cookieStore.get(LAST_PROJECT_COOKIE)?.value;
  const fallbackSlug = projects.find((p) => p.slug === lastSlug)?.slug ?? projects[0]?.slug ?? null;
  // Tuti's own widget (its help project's, on tuti.so), when the server names its project.
  const widgetProject = appWidgetProject();

  return (
    <AppShell
      sidebar={
        <>
          {/* Before any page shows: the docs tree folded where it was left folded (DocsTreeFold), on whichever app page
              the browser first opens, so going to Docs later finds it as it was. Pane widths are restored here too. */}
          <script dangerouslySetInnerHTML={{ __html: DOCS_TREE_FOLDED_SCRIPT + PANE_WIDTHS_SCRIPT }} />
          <AppSidebar
            projects={projects}
            fallbackSlug={fallbackSlug}
            user={{ name: session.user.name, email: session.user.email, image: session.user.image ?? null }}
          />
        </>
      }
      header={<AppHeader projects={projects} fallbackSlug={fallbackSlug} />}
      banners={
        <>
          {asksToVerifyEmail(session.user) && <VerifyEmailBanner email={session.user.email} />}
          <PendingInvitations invitations={invitations} />
        </>
      }
    >
      {children}
      {widgetProject && <AppWidget slug={widgetProject} />}
    </AppShell>
  );
}
