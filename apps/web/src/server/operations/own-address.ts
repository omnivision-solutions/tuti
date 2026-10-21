import type { Prisma } from "@tuti/db";

/**
 * A portal has one address of the team's own: a domain (domain.set) or a path of their site
 * (site.set), not both. Each checks for the other inside a transaction that starts with this: it
 * holds the project's row until the transaction ends, so the two added at once can't both land.
 */
export async function lockOwnAddress(tx: Prisma.TransactionClient, projectId: string) {
  await tx.$queryRaw`SELECT id FROM "project" WHERE id = ${projectId} FOR UPDATE`;
}
