import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { CreateProjectForm } from "@/components/create-project-form";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
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
    <PaneLayout>
      <Pane aria-label="Welcome to Tuti">
        <PaneHeader title="Welcome to Tuti" />
        <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-7">
          <div className="mx-auto flex max-w-2xl flex-col gap-6">
            {/* The parrot, once, where someone first meets the app. */}
            <TutiMark className="size-12" />
            <p className="text-muted-foreground">Feedback, a roadmap, a changelog and docs for your product, kept up to date as you ship.</p>
            <Card>
              <CardHeader>
                <CardTitle>Create your first project</CardTitle>
                <CardDescription>A project is your team&apos;s home for feedback, docs, the changelog and the inbox, with a portal to share them.</CardDescription>
              </CardHeader>
              <CardContent>
                <CreateProjectForm portalTemplate={portalTemplate()} />
              </CardContent>
            </Card>
          </div>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
