import { type PostVisibility, Prisma, prisma } from "@tuti/db";
import { planIncludes, readerEntriesFor } from "@tuti/shared";

/** Someone a post's email may go to: who they are, the address it goes to, and their unsubscribe token. */
export type Recipient = { id: string; address: string; unsubscribeToken: string };

type Project = { portalAccess: string; plan: Parameters<typeof planIncludes>[0] };

/**
 * Whether someone has proven the address the project's emails go to: its single sign-on gave it, or they verified their
 * own. audienceReach's `unconfirmed` otherwise; and only then may they turn the project's emails off for that address
 * (an opt-out stops the changelog's emails to it too, whoever subscribed it).
 */
export function provenAddress(person: { emailVerified: boolean; ssoIdentity: { projectId: string } | null }, projectId: string): boolean {
  return person.ssoIdentity?.projectId === projectId || person.emailVerified;
}

/**
 * Whether a project's email about a post reaches someone, and why not: `team` (never emailed),
 * `optedOut` (unsubscribed from the project's emails), `turnedOff` (turned these off in their
 * Account: the post's author by "Posts I wrote", everyone else by "Posts I voted on or follow"),
 * `notReader` (the portal is private and they aren't one of its readers), `unconfirmed` (their
 * address isn't verified yet), `noAddress` (the project's SSO gave none, or a placeholder).
 */
export type Reach =
  | { status: "emailed"; address: string; unsubscribeToken: string }
  | { status: "team" | "optedOut" | "turnedOff" | "notReader" | "unconfirmed" | "noAddress" };

/**
 * Each of `ids` (people behind a post: its author, voters, commenters, followers) with whether a
 * project's email about a post by `authorId` (null: someone else's, as a board's Get updates asks)
 * reaches them (Reach). The one rule: postAudience emails by it, a portal board's Get updates says it.
 * Only to addresses someone vouched for (verified, or asserted by the project's SSO), never to the
 * team, and not to people who unsubscribed or turned these emails off. On a private portal, only to people who may
 * still read it (its SSO users and readers); on a plan without private portals, a private portal is the
 * team's only: nobody else. Ids of no account aren't in the map. `choices: false` leaves out what each person chose
 * (their opt-out and Account switches: never `optedOut` or `turnedOff`), for whether the project could reach them at all.
 */
export async function audienceReach(
  projectId: string,
  project: Project,
  authorId: string | null,
  ids: string[],
  { choices = true }: { choices?: boolean } = {},
): Promise<Map<string, Reach>> {
  const isPrivate = project.portalAccess === "PRIVATE";
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
      emailPreferences: { where: { projectId }, select: { ownPosts: true, followedPosts: true } },
    },
  });
  // A private portal's post is only for its readers: past the team, the people its SSO signs in and
  // the readers the team added by email (verified, as server/portal-access.ts asks). Only the entries
  // these people's addresses can match (each address, its domain), not the whole list; in any case, as it always matched.
  const entries = isPrivate ? [...new Set(people.filter((person) => person.emailVerified).flatMap((person) => readerEntriesFor(person.email)))] : [];
  const readers = new Set(
    entries.length > 0
      ? (await prisma.portalReader.findMany({ where: { projectId, email: { in: entries, mode: "insensitive" } }, select: { email: true } })).map((r) => r.email.toLowerCase())
      : [],
  );
  const reach = (person: (typeof people)[number]): Reach => {
    if (person.teamMemberships.length > 0) {
      return { status: "team" };
    }
    if (choices && person.emailOptOuts.length > 0) {
      return { status: "optedOut" };
    }
    const preference = person.emailPreferences[0];
    if (choices && preference && !(person.id === authorId ? preference.ownPosts : preference.followedPosts)) {
      return { status: "turnedOff" };
    }
    const sso = person.ssoIdentity?.projectId === projectId ? person.ssoIdentity : null;
    if (isPrivate) {
      // The address itself, or its domain ("@acme.com": everyone with a verified address there).
      const invited = person.emailVerified && readerEntriesFor(person.email).some((entry) => readers.has(entry));
      if (!planIncludes(project.plan, "privatePortal") || !(sso || invited)) {
        return { status: "notReader" };
      }
    }
    const address = sso ? sso.email : person.emailVerified ? person.email : null;
    if (!provenAddress(person, projectId)) {
      return { status: "unconfirmed" };
    }
    return !address || address.endsWith(".invalid") ? { status: "noAddress" } : { status: "emailed", address, unsubscribeToken: person.unsubscribeToken };
  };
  return new Map(people.map((person) => [person.id, reach(person)]));
}

/** Who sees a post outside the team: its own visibility, or Team only on a board turned off (Board.off). */
export const seenAs = (post: { visibility: PostVisibility; board: { off: boolean } }): PostVisibility => (post.board.off ? "TEAM" : post.visibility);

/** seenAs in SQL, for a post's row (`post`, unaliased), as the email claims read it under their lock. */
export const SEEN_AS_SQL = Prisma.sql`CASE WHEN EXISTS (SELECT 1 FROM board WHERE board.id = post."boardId" AND board.off) THEN 'TEAM' ELSE post.visibility::text END`;

/**
 * Of `ids`, who a project's email about `post` goes to (audienceReach's rule), each address once; only people who
 * may see the post (seenAs): a private post's author, nobody about a Team only one (the team isn't emailed).
 */
export async function postAudience(
  projectId: string,
  project: Project,
  post: { authorId: string | null; visibility: PostVisibility; board: { off: boolean } },
  ids: string[],
): Promise<Recipient[]> {
  const visibility = seenAs(post);
  const seeing = visibility === "PUBLIC" ? ids : visibility === "PRIVATE" ? ids.filter((id) => id === post.authorId) : [];
  const seen = new Set<string>();
  const audience: Recipient[] = [];
  for (const [id, reach] of await audienceReach(projectId, project, post.authorId, seeing)) {
    if (reach.status !== "emailed" || seen.has(reach.address.toLowerCase())) {
      continue;
    }
    seen.add(reach.address.toLowerCase());
    audience.push({ id, address: reach.address, unsubscribeToken: reach.unsubscribeToken });
  }
  return audience;
}

/** A post's visibility changed while it was being emailed: the run fails, and its retry reads who may see it now. */
export const visibilityChanged = (postId: string) => new Error(`post ${postId}'s visibility changed while it was emailed; trying again with who may see it now`);
