import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { PersonPanel } from "@/components/inbox/person-panel";
import { PageHeader } from "@/components/page-header";
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
    <>
      {/* Who they are in the header: their face, their name, their address. */}
      <PageHeader
        back={{ href: `/app/${slug}/users`, label: "Users" }}
        title={
          <span className="flex items-center gap-3">
            <Avatar aria-hidden className="size-10 text-base sm:size-11">
              {identity.user.image && <AvatarImage src={identity.user.image} alt="" />}
              <AvatarFallback>{initial(identity.user.name)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">{identity.user.name}</span>
          </span>
        }
        description={
          <span className="break-all">
            {identity.email && `${identity.email} · `}id {externalId}
          </span>
        }
      />
      {/* The whole width (data-wide), their profile beside what they did. Their app's address, as it asserted it; what
          they did with every account that is them, as Users counts it. */}
      <div data-wide>
        <PersonPanel
          projectId={projectId}
          slug={slug}
          person={{ userId: identity.userId, email: identity.email, emailVerified: true, accounts: await userAccounts(projectId, identity) }}
          page
        />
      </div>
    </>
  );
}
