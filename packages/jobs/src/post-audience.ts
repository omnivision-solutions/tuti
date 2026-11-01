import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";

/** Someone a post's email may go to: who they are, the address it goes to, and their unsubscribe token. */
export type Recipient = { id: string; address: string; unsubscribeToken: string };

type Project = { portalAccess: string; plan: Parameters<typeof planIncludes>[0] };

/**
 * Of `ids` (people behind a post: its author, voters, commenters, followers), who a project's email about it may go
 * to, each address once. Only to addresses someone vouched for (verified, or asserted by the project's SSO), never
 * to the team, and not to people who unsubscribed or turned these emails off in their Account (its author by
 * "Posts I wrote", everyone else by "Posts I voted on or follow"). On a private portal, only to people who may still
 * read it (its SSO users and readers); on a plan without private portals, a private portal is the team's only: nobody.
 */
export async function postAudience(projectId: string, project: Project, authorId: string, ids: string[]): Promise<Recipient[]> {
  if (project.portalAccess === "PRIVATE" && !planIncludes(project.plan, "privatePortal")) {
    return [];
  }
  // A private portal's post is only for its readers: past the team, the people its SSO signs in and
  // the readers the team added by email (verified, as server/portal-access.ts asks).
  const readers =
    project.portalAccess === "PRIVATE" ? (await prisma.portalReader.findMany({ where: { projectId }, select: { email: true } })).map((r) => r.email) : [];
  const people = await prisma.user.findMany({
    where: {
      id: { in: [...new Set(ids)] },
      teamMemberships: { none: { projectId } },
      emailOptOuts: { none: { projectId } },
      AND: {
        OR: [
          { id: authorId, emailPreferences: { none: { projectId, ownPosts: false } } },
          { id: { not: authorId }, emailPreferences: { none: { projectId, followedPosts: false } } },
        ],
      },
      ...(project.portalAccess === "PRIVATE" && {
        OR: [
          { ssoIdentity: { projectId } },
          { emailVerified: true, email: { in: readers.filter((r) => !r.startsWith("@")), mode: "insensitive" } },
          // A domain ("@acme.com"): everyone with a verified address there.
          ...readers.filter((r) => r.startsWith("@")).map((domain) => ({ emailVerified: true, email: { endsWith: domain, mode: "insensitive" as const } })),
        ],
      }),
    },
    select: { id: true, email: true, emailVerified: true, unsubscribeToken: true, ssoIdentity: { select: { projectId: true, email: true } } },
  });
  const seen = new Set<string>();
  const audience: Recipient[] = [];
  for (const person of people) {
    const address = person.ssoIdentity?.projectId === projectId ? person.ssoIdentity.email : person.emailVerified ? person.email : null;
    if (!address || address.endsWith(".invalid") || seen.has(address.toLowerCase())) {
      continue;
    }
    seen.add(address.toLowerCase());
    audience.push({ id: person.id, address, unsubscribeToken: person.unsubscribeToken });
  }
  return audience;
}
