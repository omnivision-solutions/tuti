import { redirect } from "next/navigation";

import { CreateProjectForm } from "@/components/create-project-form";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { Card, CardContent } from "@/components/ui/card";
import { portalTemplate } from "@/lib/hosts";
import { getSession } from "@/server/session";

export default async function NewProjectPage() {
  if (!(await getSession())) {
    redirect("/app/auth/sign-in");
  }
  return (
    <PaneLayout>
      <Pane aria-label="New project">
        <PaneHeader title="New project" />
        <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-7">
          <Card className="mx-auto w-full max-w-2xl">
            <CardContent>
              <CreateProjectForm portalTemplate={portalTemplate()} />
            </CardContent>
          </Card>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
