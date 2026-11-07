import { timingSafeEqual } from "node:crypto";

import { prisma } from "@tuti/db";
import { projectUnsubscribeToken } from "@tuti/jobs";

/**
 * Unsubscribe links (in the emails a project sends) carry the person's unsubscribe token for that project
 * (projectUnsubscribeToken); the link's portal says which project. Null when either is unknown, or the token is
 * another project's.
 */
export async function findOptOut(projectSlug: string, token: string) {
  const userId = token.split(".")[0];
  const [user, project] = await Promise.all([
    userId ? prisma.user.findUnique({ where: { id: userId }, select: { id: true, unsubscribeToken: true } }) : null,
    prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true } }),
  ]);
  if (!user || !project) {
    return null;
  }
  const given = Buffer.from(token);
  const wanted = Buffer.from(projectUnsubscribeToken(project.id, user));
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return null;
  }
  const where = { userId_projectId: { userId: user.id, projectId: project.id } };
  return {
    project,
    optedOut: (await prisma.emailOptOut.findUnique({ where })) !== null,
    optOut: () => prisma.emailOptOut.upsert({ where, create: { userId: user.id, projectId: project.id }, update: {} }),
  };
}
