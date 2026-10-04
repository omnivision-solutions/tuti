import { CreateProjectForm } from "@/components/create-project-form";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";

export default function NewProjectPage() {
  return (
    <>
      <PageHeader title="New project" description="Each project has its own public portal, boards and team." />
      <Card className="max-w-xl">
        <CardContent>
          <CreateProjectForm portalExample={portalUrl("acme")} />
        </CardContent>
      </Card>
    </>
  );
}
