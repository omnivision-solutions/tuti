import { prisma } from "@tuti/db";

/**
 * Unsubscribe links (in the emails a project sends) carry the person's
 * unsubscribe token; the link's portal says which project. Null when either is unknown.
 */
export async function findOptOut(projectSlug: string, token: string) {
  const [user, project] = await Promise.all([
    token
      ? prisma.user.findUnique({ where: { unsubscribeToken: token }, select: { id: true, email: true, ssoIdentity: { select: { projectId: true, email: true } } } })
      : null,
    prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true } }),
  ]);
  if (!user || !project) {
    return null;
  }
  const where = { userId_projectId: { userId: user.id, projectId: project.id } };
  const optOut = await prisma.emailOptOut.findUnique({ where });
  // A changelog subscription they confirmed since (at their address, or the one the project's SSO gives them) brings
  // the changelog back (changelog-email.ts audience): not opted out of everything, so the page offers to again.
  const addresses = [user.email, user.ssoIdentity?.projectId === project.id ? user.ssoIdentity.email : null].filter((a) => a !== null);
  const changelogSince =
    optOut &&
    (await prisma.changelogSubscriber.count({
      where: { projectId: project.id, email: { in: addresses, mode: "insensitive" }, confirmedAt: { gt: optOut.createdAt } },
    })) > 0;
  return {
    project,
    optedOut: optOut !== null && !changelogSince,
    // Again, it's the latest word: a changelog subscription confirmed since gives way to it (changelog-email.ts audience).
    optOut: () => prisma.emailOptOut.upsert({ where, create: { userId: user.id, projectId: project.id }, update: { createdAt: new Date() } }),
  };
}
