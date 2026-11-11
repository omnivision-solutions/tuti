import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { CreateProjectForm } from "@/components/create-project-form";
import { PageHeader } from "@/components/page-header";
import { TutiMark } from "@tuti/ui/tuti-logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalTemplate } from "@/lib/hosts";
import { LAST_PROJECT_COOKIE } from "@/lib/last-project";
import { listMyProjects } from "@/server/membership";
import { getSession } from "@/server/session";

export default async function AppHome() {
  const session = await getSession();
  if (!session) {
    redirect("/app/auth/sign-in");
  }
  const projects = await listMyProjects(session.user.id);
  const lastSlug = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  const target = projects.find((p) => p.slug === lastSlug) ?? projects[0];
  if (target) {
    redirect(`/app/${target.slug}`);
  }

  return (
    <>
      {/* The parrot, once, where someone first meets the app. */}
      <TutiMark className="size-12" />
      <PageHeader title="Welcome to Tuti" description="Feedback, a roadmap, a changelog and docs for your product, kept up to date as you ship." />
      <Card data-narrow>
        <CardHeader>
          <CardTitle>Create your first project</CardTitle>
          <CardDescription>A project is your team&apos;s home for feedback, docs, the changelog and the inbox, with a portal to share them.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateProjectForm portalTemplate={portalTemplate()} />
        </CardContent>
      </Card>
    </>
  );
}
