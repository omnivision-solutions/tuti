import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { CreateProjectForm } from "@/components/create-project-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { listMyProjects } from "@/server/membership";
import { getSession } from "@/server/session";

export default async function AppHome() {
  const session = await getSession();
  const projects = session ? await listMyProjects(session.user.id) : [];
  const lastSlug = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  const target = projects.find((p) => p.slug === lastSlug) ?? projects[0];
  if (target) {
    redirect(`/app/${target.slug}`);
  }

  return (
    <>
      <PageHeader title="Welcome to Tuti" description="Create a project to start collecting feedback." />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Create your first project</CardTitle>
          <CardDescription>A project is your team&apos;s home for feedback, with its own public portal.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateProjectForm portalExample={portalUrl("acme")} />
        </CardContent>
      </Card>
    </>
  );
}
