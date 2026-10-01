import { redirect } from "next/navigation";

import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";
import { listMyWorkspaces } from "@/server/members";
import { getSession } from "@/server/session";

export default async function AppHome() {
  const session = await getSession();
  const [first] = session ? await listMyWorkspaces(session.user.id) : [];
  if (first) {
    redirect(`/app/${first.slug}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Create your first workspace</CardTitle>
          <CardDescription>A workspace is your team&apos;s home for feedback, with its own public portal.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateWorkspaceForm portalExample={portalUrl("acme")} />
        </CardContent>
      </Card>
    </main>
  );
}
