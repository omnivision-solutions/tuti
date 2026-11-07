import { timingSafeEqual } from "node:crypto";

import { prisma } from "@tuti/db";
import { projectUnsubscribeToken } from "@tuti/jobs";

const same = (a: string, b: string) => {
  const given = Buffer.from(a);
  const wanted = Buffer.from(b);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};

/** Whether the project has emailed this person (a shipped or reply email sent): the only projects their legacy token works on. */
const emailedBy = async (userId: string, projectId: string) =>
  (await prisma.shippedEmail.count({ where: { userId, sentAt: { not: null }, post: { projectId } }, take: 1 })) > 0 ||
  (await prisma.replyEmail.count({ where: { userId, sentAt: { not: null }, comment: { projectId } }, take: 1 })) > 0;

/**
 * Unsubscribe links (in the emails a project sends) carry the person's unsubscribe token for that project
 * (projectUnsubscribeToken); the link's portal says which project. Null when either is unknown, or the token is
 * another project's.
 *
 * ponytail: links sent before per-project tokens carry the person's bare User.unsubscribeToken, the same for every
 * project; it's taken only on a project that has emailed them. Drop this path 30+ days after the release whose senders
 * switch to projectUnsubscribeToken (see postAudience), once no older worker is left.
 */
export async function findOptOut(projectSlug: string, token: string) {
  const legacy = !token.includes(".");
  const [user, project] = await Promise.all([
    token
      ? prisma.user.findUnique({ where: legacy ? { unsubscribeToken: token } : { id: token.split(".")[0] }, select: { id: true, unsubscribeToken: true } })
      : null,
    prisma.project.findUnique({ where: { slug: projectSlug }, select: { id: true, name: true } }),
  ]);
  if (!user || !project || !(legacy ? await emailedBy(user.id, project.id) : same(token, projectUnsubscribeToken(project.id, user)))) {
    return null;
  }
  const where = { userId_projectId: { userId: user.id, projectId: project.id } };
  return {
    project,
    optedOut: (await prisma.emailOptOut.findUnique({ where })) !== null,
    optOut: () => prisma.emailOptOut.upsert({ where, create: { userId: user.id, projectId: project.id }, update: {} }),
  };
}
