import { CreateProjectForm } from "@/components/create-project-form";
import { Card, CardContent } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";

export default function NewProjectPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
        <p className="text-sm text-muted-foreground">Each project has its own public portal, boards and team.</p>
      </div>
      <Card className="max-w-xl">
        <CardContent>
          <CreateProjectForm portalExample={portalUrl("acme")} />
        </CardContent>
      </Card>
    </>
  );
}
