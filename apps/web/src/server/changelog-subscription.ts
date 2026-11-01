import { prisma } from "@tuti/db";

/**
 * A changelog subscription from the token in its links (confirm, and unsubscribe in every changelog email); the
 * link's portal says which project. Null when either is unknown. Not a "use server" module: the token is the
 * permission, checked by the pages and routes that take it.
 */
export async function findSubscription(projectSlug: string, token: string) {
  const subscriber = token
    ? await prisma.changelogSubscriber.findFirst({
        where: { token, project: { slug: projectSlug } },
        select: { id: true, email: true, confirmedAt: true, unsubscribedAt: true, project: { select: { name: true, portalAccess: true } } },
      })
    : null;
  if (!subscriber) {
    return null;
  }
  const { id } = subscriber;
  return {
    ...subscriber,
    // Not once they've unsubscribed: a link from before (forwarded, say) can't sign them up again; asking again can.
    // Nor while the portal's private: nothing is emailed from one (changelogEmailed).
    confirm: () =>
      prisma.changelogSubscriber.updateMany({
        where: { id, confirmedAt: null, unsubscribedAt: null, project: { portalAccess: "PUBLIC" } },
        data: { confirmedAt: new Date() },
      }),
    unsubscribe: () => prisma.changelogSubscriber.update({ where: { id }, data: { confirmedAt: null, unsubscribedAt: new Date() } }),
  };
}
