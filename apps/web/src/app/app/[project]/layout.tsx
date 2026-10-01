import { notFound } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { portalUrl } from "@/lib/hosts";
import { getMembership, listMyProjects } from "@/server/members";
import { getSession } from "@/server/session";

export default async function ProjectLayout({ children, params }: LayoutProps<"/app/[project]">) {
  const { project: slug } = await params;
  const session = await getSession();
  const membership = await getMembership(slug);
  if (!session || !membership) {
    notFound();
  }
  const { project, role } = membership;

  return (
    <SidebarProvider>
      <AppSidebar
        projects={await listMyProjects(session.user.id)}
        current={{ slug: project.slug, name: project.name }}
        portalUrl={portalUrl(project.slug)}
        isAdmin={role === "OWNER" || role === "ADMIN"}
        user={{ name: session.user.name, email: session.user.email, image: session.user.image ?? null }}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <span className="text-sm font-medium">{project.name}</span>
        </header>
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
