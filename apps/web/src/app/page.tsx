import { prisma } from "@tuti/db";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";

import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSession } from "@/server/session";

export default async function Home() {
  const session = await getSession();

  if (!session) {
    return (
      <div className="flex flex-col items-start gap-4 py-10">
        <h1 className="text-4xl font-semibold tracking-tight">Feedback your users will actually leave.</h1>
        <p className="text-lg text-muted-foreground">Collect feature requests, let users vote, and close the loop.</p>
        <Link href="/sign-up" className={buttonVariants({ size: "lg" })}>
          Get started
        </Link>
      </div>
    );
  }

  const memberships = await prisma.member.findMany({
    where: { userId: session.user.id },
    include: { workspace: { include: { boards: { take: 1, orderBy: { createdAt: "asc" } } } } },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Your workspaces</CardTitle>
          {memberships.length === 0 && <CardDescription>You don&apos;t have a workspace yet.</CardDescription>}
        </CardHeader>
        {memberships.length > 0 && (
          <CardContent className="flex flex-col">
            {memberships.map(({ workspace }) => (
              <Link
                key={workspace.id}
                href={`/${workspace.slug}/${workspace.boards[0]?.slug ?? ""}`}
                className="-mx-2 flex items-center justify-between rounded-md px-2 py-2 hover:bg-muted"
              >
                <span className="font-medium">{workspace.name}</span>
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </Link>
            ))}
          </CardContent>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Create a workspace</CardTitle>
          <CardDescription>A workspace holds your feedback boards.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateWorkspaceForm />
        </CardContent>
      </Card>
    </div>
  );
}
