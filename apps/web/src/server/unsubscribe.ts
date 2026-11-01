import { prisma } from "@tuti/db";

/**
 * Unsubscribe links (in the emails a project sends) carry the person's
 * unsubscribe token; the link's portal says which project. Null when either is unknown.
 */
export async function findOptOut(projectSlug: string, token: string) {
  const [user, project] = await Promise.all([
    token ? prisma.user.findUnique({ where: { unsubscribeToken: token }, select: { id: true } }) : null,
    prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true } }),
  ]);
  if (!user || !project) {
    return null;
  }
  const where = { userId_projectId: { userId: user.id, projectId: project.id } };
  return {
    project,
    optedOut: (await prisma.emailOptOut.findUnique({ where })) !== null,
    // Again, it's the latest word: a changelog subscription confirmed since gives way to it (changelog-email.ts audience).
    optOut: () => prisma.emailOptOut.upsert({ where, create: { userId: user.id, projectId: project.id }, update: { createdAt: new Date() } }),
  };
}
