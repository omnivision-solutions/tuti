import { CreateProjectForm } from "@/components/create-project-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { portalTemplate } from "@/lib/hosts";

export default function NewProjectPage() {
  return (
    <>
      <PageHeader title="New project" />
      <Card className="max-w-xl">
        <CardContent>
          <CreateProjectForm portalTemplate={portalTemplate()} />
        </CardContent>
      </Card>
    </>
  );
}
