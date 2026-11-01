import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";

/** Someone a post's email may go to: who they are, the address it goes to, and their unsubscribe token. */
export type Recipient = { id: string; address: string; unsubscribeToken: string };

type Project = { portalAccess: string; plan: Parameters<typeof planIncludes>[0] };

/**
 * Whether a project's email about a post reaches someone, and why not: `team` (never emailed),
 * `optedOut` (unsubscribed from the project's emails), `notReader` (the portal is private and they
 * aren't one of its readers), `unconfirmed` (their address isn't verified yet), `noAddress` (the
 * project's SSO gave none, or a placeholder).
 */
export type Reach =
  | { status: "emailed"; address: string; unsubscribeToken: string }
  | { status: "team" | "optedOut" | "notReader" | "unconfirmed" | "noAddress" };

/**
 * Each of `ids` (people behind a post: its author, voters, commenters) with whether a project's email
 * about a post reaches them (Reach). The one rule: postAudience emails by it, a portal board's Get
 * updates says it. Only to addresses someone vouched for (verified, or asserted by the project's SSO),
 * never to the team, and not to people who unsubscribed. On a private portal, only to people who may
 * still read it (its SSO users and readers); on a plan without private portals, a private portal is the
 * team's only: nobody else. Ids of no account aren't in the map.
 */
export async function audienceReach(projectId: string, project: Project, ids: string[]): Promise<Map<string, Reach>> {
  const isPrivate = project.portalAccess === "PRIVATE";
  // A private portal's post is only for its readers: past the team, the people its SSO signs in and
  // the readers the team added by email (verified, as server/portal-access.ts asks).
  const readers = isPrivate ? (await prisma.portalReader.findMany({ where: { projectId }, select: { email: true } })).map((r) => r.email.toLowerCase()) : [];
  const people = await prisma.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      unsubscribeToken: true,
      ssoIdentity: { select: { projectId: true, email: true } },
      teamMemberships: { where: { projectId }, select: { id: true } },
      emailOptOuts: { where: { projectId }, select: { userId: true } },
    },
  });
  const reach = (person: (typeof people)[number]): Reach => {
    if (person.teamMemberships.length > 0) {
      return { status: "team" };
    }
    if (person.emailOptOuts.length > 0) {
      return { status: "optedOut" };
    }
    const sso = person.ssoIdentity?.projectId === projectId ? person.ssoIdentity : null;
    if (isPrivate) {
      const email = person.email.toLowerCase();
      // A domain ("@acme.com"): everyone with a verified address there.
      const invited = person.emailVerified && readers.some((reader) => (reader.startsWith("@") ? email.endsWith(reader) : email === reader));
      if (!planIncludes(project.plan, "privatePortal") || !(sso || invited)) {
        return { status: "notReader" };
      }
    }
    const address = sso ? sso.email : person.emailVerified ? person.email : null;
    if (!sso && !person.emailVerified) {
      return { status: "unconfirmed" };
    }
    return !address || address.endsWith(".invalid") ? { status: "noAddress" } : { status: "emailed", address, unsubscribeToken: person.unsubscribeToken };
  };
  return new Map(people.map((person) => [person.id, reach(person)]));
}

/** Of `ids`, who a project's email about a post goes to (audienceReach's rule), each address once. */
export async function postAudience(projectId: string, project: Project, ids: string[]): Promise<Recipient[]> {
  const seen = new Set<string>();
  const audience: Recipient[] = [];
  for (const [id, reach] of await audienceReach(projectId, project, ids)) {
    if (reach.status !== "emailed" || seen.has(reach.address.toLowerCase())) {
      continue;
    }
    seen.add(reach.address.toLowerCase());
    audience.push({ id, address: reach.address, unsubscribeToken: reach.unsubscribeToken });
  }
  return audience;
}
