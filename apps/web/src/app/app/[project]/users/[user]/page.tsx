import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { PersonPanel } from "@/components/inbox/person-panel";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getMembership } from "@/server/membership";

/** One of the project's users, by their id in its app: who they are, their properties, posts, votes and conversations. */
export default async function UserPage(props: PageProps<"/app/[project]/users/[user]">) {
  const { project: slug, user: param } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const identity = await prisma.ssoIdentity.findUnique({
    where: { projectId_externalId: { projectId, externalId: decodeURIComponent(param) } },
    select: { userId: true, email: true, user: { select: { name: true } } },
  });
  if (!identity) {
    notFound();
  }

  return (
    <>
      <PageHeader back={{ href: `/app/${slug}/users`, label: "Users" }} title={identity.user.name} />
      <Card size="sm">
        <CardContent>
          {/* Their app's address, as it asserted it. */}
          <PersonPanel projectId={projectId} slug={slug} person={{ userId: identity.userId, email: identity.email, emailVerified: true }} />
        </CardContent>
      </Card>
    </>
  );
}
