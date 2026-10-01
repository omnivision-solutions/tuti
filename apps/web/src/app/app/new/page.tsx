import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";

import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";

export default function NewWorkspacePage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-2 px-6 py-10">
      <Link href="/app" className={buttonVariants({ variant: "link", size: "sm", className: "self-start px-0 text-muted-foreground" })}>
        <ArrowLeftIcon />
        Back
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>New workspace</CardTitle>
          <CardDescription>Each workspace has its own public portal, boards and team.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateWorkspaceForm portalExample={portalUrl("acme")} />
        </CardContent>
      </Card>
    </main>
  );
}
