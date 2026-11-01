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
    // Confirmed and emailed it, as the job decides (getsChangelog): not while they've turned all of the project's emails off.
    receiving: subscriber.confirmedAt !== null && (await getsChangelog(subscriber.projectId, subscriber.id)),
    // Turns the project's emails back on at their address (every account's opt-out there): the changelog comes again,
    // and so do the rest. Only for a confirmed subscription, whose link proves the address is theirs.
    turnEmailsOn: () =>
      prisma.emailOptOut.deleteMany({
        where: {
          projectId: subscriber.projectId,
          user: {
            OR: [
              { email: { equals: subscriber.email, mode: "insensitive" } },
              { ssoIdentity: { projectId: subscriber.projectId, email: { equals: subscriber.email, mode: "insensitive" } } },
            ],
          },
        },
      }),
    // Any confirmation link still out goes too: it can't sign them up again (asking again on the portal can).
    unsubscribe: () =>
      prisma.changelogSubscriber.updateMany({
        where: { id: subscriber.id, token },
        data: { confirmedAt: null, confirmTokenHash: null, confirmExpiresAt: null },
      }),
  };
}

/**
 * The request a confirmation link (`confirm`, its own token) was emailed for: only the latest request's (a newer one
 * replaces it, unsubscribing voids it). Null otherwise. It confirms only while `live` (unused, within
 * CONFIRM_LINK_HOURS); once `used`, it's still known, so opening it again shows the subscription. Confirming checks
 * the same token again as it writes, so a link replaced or used meanwhile confirms nothing.
 */
export async function findConfirmation(projectSlug: string, confirm: string) {
  const confirmTokenHash = hashSecret(confirm);
  const live = () => ({ confirmTokenHash, confirmExpiresAt: { gt: new Date() } });
  const subscriber = confirm
    ? await prisma.changelogSubscriber.findFirst({
        where: { confirmTokenHash, project: { slug: projectSlug } },
        select: { ...select, confirmExpiresAt: true },
      })
    : null;
  if (!subscriber) {
    return null;
  }
  return {
    ...subscriber,
    live: subscriber.confirmExpiresAt !== null && subscriber.confirmExpiresAt > new Date(),
    used: subscriber.confirmedAt !== null && subscriber.confirmExpiresAt === null,
    // Not while the portal's private: nothing is emailed from one (changelogEmailed). Used once: its hash stays, without an expiry.
    confirm: async () =>
      (
        await prisma.changelogSubscriber.updateMany({
          where: { id: subscriber.id, ...live(), project: { portalAccess: "PUBLIC" } },
          data: { confirmedAt: new Date(), confirmExpiresAt: null },
        })
      ).count === 1,
  };
}
