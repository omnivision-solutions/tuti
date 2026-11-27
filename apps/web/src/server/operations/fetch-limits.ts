import { prisma } from "@tuti/db";

import { type Actor, OperationError } from "./define";

// Its own module: API references and Screenshots' suggestions both count against it, and neither imports the other.

/** Specs the team may have Tuti fetch: per member (across their projects; an API key counts as whoever made it) a minute, and per project an hour. */
export const FETCHES_PER_MEMBER_PER_MINUTE = 10;
export const FETCHES_PER_PROJECT_PER_HOUR = 120;

/**
 * Counts a fetch the team asked for (Fetch, adding from a URL, Sync now) against its limits, or refuses it: each one
 * makes our server wait up to 15 seconds for an address the team picks. One at a time per project, so fetches at once
 * can't overrun the limits together. The 6-hourly sync isn't counted.
 */
export async function countSpecFetch({ actor, projectId }: { actor: Actor; projectId: string }): Promise<void> {
  const userId = actor.kind === "user" ? actor.userId : actor.createdById;
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const over = await prisma.$transaction(async (tx) => {
    // Locks of their own (classes 11 and 12), always in that order: they wait on nothing else of the project's.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(11, hashtext(${projectId}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(12, hashtext(${userId}))`;
    await tx.apiReferenceFetch.deleteMany({ where: { projectId, createdAt: { lt: hourAgo } } });
    const [byMember, byProject] = await Promise.all([
      // Across their projects: being on many is no more fetches a minute.
      tx.apiReferenceFetch.count({ where: { userId, createdAt: { gt: new Date(Date.now() - 60_000) } } }),
      tx.apiReferenceFetch.count({ where: { projectId, createdAt: { gt: hourAgo } } }),
    ]);
    if (byMember >= FETCHES_PER_MEMBER_PER_MINUTE) return "That's a lot of fetches. Try again in a minute.";
    if (byProject >= FETCHES_PER_PROJECT_PER_HOUR) return "This project fetched a lot of specs in the last hour. Try again later.";
    await tx.apiReferenceFetch.create({ data: { projectId, userId } });
    return null;
  });
  if (over) {
    throw new OperationError(429, "rate_limited", over);
  }
}
