import { prisma } from "@tuti/db";
import { getsChangelog } from "@tuti/jobs";

import { hashSecret } from "@/lib/portal-handoff";

/** How long a changelog confirmation link works (each request's own, used once). */
export const CONFIRM_LINK_HOURS = 24;

const select = {
  id: true,
  email: true,
  confirmedAt: true,
  token: true,
  projectId: true,
  project: { select: { name: true, portalAccess: true } },
} as const;

/**
 * A changelog subscription from the token in every changelog email's unsubscribe link; the link's portal says which
 * project. Null when either is unknown. It only unsubscribes: confirming takes the latest request's own link
 * (findConfirmation). Not a "use server" module: the token is the permission, checked by the pages and routes that take it.
 */
export async function findSubscription(projectSlug: string, token: string) {
  const subscriber = token ? await prisma.changelogSubscriber.findFirst({ where: { token, project: { slug: projectSlug } }, select }) : null;
  if (!subscriber) {
    return null;
  }
  return {
    ...subscriber,
    // Confirmed and still emailed it, as the job decides (getsChangelog): not once they've turned the project's emails off since.
    receiving: subscriber.confirmedAt !== null && (await getsChangelog(subscriber.projectId, subscriber.id)),
    // Any confirmation link still out goes too: it can't sign them up again (asking again on the portal can).
    unsubscribe: () =>
      prisma.changelogSubscriber.updateMany({
        where: { id: subscriber.id, token },
        data: { confirmedAt: null, confirmTokenHash: null, confirmExpiresAt: null },
      }),
  };
}

/**
 * The request a confirmation link (`confirm`, its own token) was emailed for: only the latest request's, unused and
 * within CONFIRM_LINK_HOURS. Null otherwise. Confirming checks the same token again as it writes, so a link replaced
 * or used meanwhile confirms nothing.
 */
export async function findConfirmation(projectSlug: string, confirm: string) {
  const confirmTokenHash = hashSecret(confirm);
  const live = () => ({ confirmTokenHash, confirmExpiresAt: { gt: new Date() } });
  const subscriber = confirm
    ? await prisma.changelogSubscriber.findFirst({ where: { ...live(), project: { slug: projectSlug } }, select })
    : null;
  if (!subscriber) {
    return null;
  }
  return {
    ...subscriber,
    // Not while the portal's private: nothing is emailed from one (changelogEmailed). Used once.
    confirm: async () =>
      (
        await prisma.changelogSubscriber.updateMany({
          where: { id: subscriber.id, ...live(), project: { portalAccess: "PUBLIC" } },
          data: { confirmedAt: new Date(), confirmTokenHash: null, confirmExpiresAt: null },
        })
      ).count === 1,
  };
}
