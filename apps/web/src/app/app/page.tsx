import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { CreateProjectForm } from "@/components/create-project-form";
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Tuti</h1>
        <p className="text-sm text-muted-foreground">Create a project to start collecting feedback.</p>
      </div>
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
