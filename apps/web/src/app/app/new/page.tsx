import { redirect } from "next/navigation";

import { CreateProjectForm } from "@/components/create-project-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { portalTemplate } from "@/lib/hosts";
import { getSession } from "@/server/session";

export default async function NewProjectPage() {
  if (!(await getSession())) {
    redirect("/sign-in");
  }
  return (
    <>
      <PageHeader title="New project" />
      <Card data-narrow>
        <CardContent>
          <CreateProjectForm portalTemplate={portalTemplate()} />
        </CardContent>
      </Card>
    </>
  );
}
