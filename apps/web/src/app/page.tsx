import { prisma } from "@tuti/db";
import Link from "next/link";

import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { getSession } from "@/server/session";

export default async function Home() {
  const session = await getSession();

  if (!session) {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-3xl font-semibold">Feedback your users will actually leave.</h1>
        <p className="text-zinc-500">Collect feature requests, let users vote, and close the loop.</p>
        <Link href="/sign-up" className="btn-primary">
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
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Your workspaces</h1>
        {memberships.length === 0 ? (
          <p className="text-zinc-500">You don&apos;t have a workspace yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {memberships.map(({ workspace }) => (
              <li key={workspace.id}>
                <Link
                  href={`/${workspace.slug}/${workspace.boards[0]?.slug ?? ""}`}
                  className="underline"
                >
                  {workspace.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex max-w-sm flex-col gap-3">
        <h2 className="text-lg font-semibold">Create a workspace</h2>
        <CreateWorkspaceForm />
      </section>
    </div>
  );
}
