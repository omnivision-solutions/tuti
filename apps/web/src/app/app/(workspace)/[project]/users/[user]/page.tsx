import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { PersonPanel } from "@/components/inbox/person-panel";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initial } from "@/lib/format";
import { getMembership } from "@/server/membership";
import { userAccounts } from "@/server/operations/users";

/** One of the project's users, by their id in its app: who they are and their properties, beside all their posts, votes and conversations. */
export default async function UserPage(props: PageProps<"/app/[project]/users/[user]">) {
  const { project: slug, user: param } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  // Still encoded (a link cut off mid-escape never gets here: proxy.ts).
  const externalId = decodeURIComponent(param);
  const identity = await prisma.ssoIdentity.findUnique({
    where: { projectId_externalId: { projectId, externalId } },
    select: { userId: true, email: true, user: { select: { name: true, image: true } } },
  });
  if (!identity) {
    notFound();
  }

  return (
    <PaneLayout>
      <Pane aria-label={identity.user.name}>
        <PaneHeader back={{ href: `/app/${slug}/users`, label: "All users" }} title={identity.user.name} />
        <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-7">
          <div className="flex flex-col gap-6">
            {/* Who they are, first: their face, their name, their address and their app's id for them. */}
            <div data-slot="person-header" className="flex min-w-0 items-center gap-3">
              <Avatar aria-hidden className="size-11 text-base">
                {identity.user.image && <AvatarImage src={identity.user.image} alt="" />}
                <AvatarFallback>{initial(identity.user.name)}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <p className="font-heading text-xl font-semibold break-words">{identity.user.name}</p>
                <p className="text-sm break-all text-muted-foreground">
                  {identity.email && `${identity.email} · `}id {externalId}
                </p>
              </div>
            </div>
            {/* Their profile beside what they did. Their app's address, as it asserted it; what they did with every
                account that is them, as Users counts it. */}
            <PersonPanel
              projectId={projectId}
              slug={slug}
              person={{ userId: identity.userId, email: identity.email, emailVerified: true, accounts: await userAccounts(projectId, identity) }}
              page
            />
          </div>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}
