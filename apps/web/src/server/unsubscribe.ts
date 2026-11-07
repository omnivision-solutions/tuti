import { timingSafeEqual } from "node:crypto";

import { prisma } from "@tuti/db";
import { projectUnsubscribeToken } from "@tuti/jobs";

const same = (a: string, b: string) => {
  const given = Buffer.from(a);
  const wanted = Buffer.from(b);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};

/**
 * Unsubscribe links (in the emails a project sends) carry the person's unsubscribe token for that project
 * (projectUnsubscribeToken); the link's portal says which project. Null when either is unknown, or the token is
 * another project's.
 */
export async function findOptOut(projectSlug: string, token: string) {
  const [user, project] = await Promise.all([
    token.includes(".") ? prisma.user.findUnique({ where: { id: token.split(".")[0] }, select: { id: true, unsubscribeToken: true } }) : null,
    prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true } }),
  ]);
  if (!user || !project || !same(token, projectUnsubscribeToken(project.id, user))) {
    return null;
  }
  const where = { userId_projectId: { userId: user.id, projectId: project.id } };
  return {
    project,
    optedOut: (await prisma.emailOptOut.findUnique({ where })) !== null,
    optOut: () => prisma.emailOptOut.upsert({ where, create: { userId: user.id, projectId: project.id }, update: {} }),
  };
}
