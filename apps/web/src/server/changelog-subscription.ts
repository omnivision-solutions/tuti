import { randomBytes } from "node:crypto";

import { prisma } from "@tuti/db";
import { changelogConfirmEmail, sendEmail } from "@tuti/email";
import { getsChangelog, optedOutAddresses, projectSender } from "@tuti/jobs";
import { log } from "@tuti/shared";

import { hashSecret } from "@/lib/portal-handoff";
import { portalAddress } from "@/server/custom-domains";


/** How long a changelog confirmation link works (each request's own, used once). */
export const CONFIRM_LINK_HOURS = 24;

const select = {
  id: true,
  email: true,
  confirmedAt: true,
  token: true,
  projectId: true,
  project: { select: { name: true, slug: true, portalAccess: true } },
} as const;

/** Whether `email` has turned all of the project's emails off (which wins over the changelog: optedOutAddresses). */
const optedOut = async (projectId: string, email: string) => (await optedOutAddresses(projectId, [email])).has(email);

/**
 * Emails a subscriber a confirmation link of their own (32 random bytes, stored hashed like sign-in links), used once,
 * for CONFIRM_LINK_HOURS. It replaces any link sent before, so an old one (forwarded, say) confirms nothing. To an
 * address that's turned all of the project's emails off, it says so and turns them back on, rather than promising the
 * changelog. Callers count it against the emailed links' limits first (countEmailedLink).
 */
export async function emailConfirmation(
  project: { id: string; name: string; slug: string },
  subscriber: { id: string; email: string },
): Promise<{ error?: string }> {
  const confirm = randomBytes(32).toString("base64url");
  await prisma.changelogSubscriber.update({
    where: { id: subscriber.id },
    data: { confirmTokenHash: hashSecret(confirm), confirmExpiresAt: new Date(Date.now() + CONFIRM_LINK_HOURS * 3_600_000), confirmUsedAt: null },
  });
  const url = new URL(`${await portalAddress(project.slug)}/changelog/subscription`);
  url.searchParams.set("confirm", confirm);
  try {
    await sendEmail({
      to: subscriber.email,
      ...changelogConfirmEmail({ projectName: project.name, url: url.toString(), optedOut: await optedOut(project.id, subscriber.email) }),
      ...(await projectSender(project.id)),
    });
  } catch (error) {
    log.error("Sending a changelog confirmation failed", { error });
    return { error: "We couldn't send the email. Try again." };
  }
  return {};
}

/**
 * A changelog subscription from the token in every changelog email's unsubscribe link; the link's portal says which
 * project. Null when either is unknown. That token is long-lived (and in forwarded emails), so it only unsubscribes, or
 * asks for a confirmation link to be emailed to the address: confirming, and turning the project's emails back on,
 * take that link (findConfirmation). Not a "use server" module: the token is the permission, checked by the pages and
 * routes that take it.
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
    // Any confirmation link still out goes too: it can't sign them up again (asking again on the portal can).
    unsubscribe: () =>
      prisma.changelogSubscriber.updateMany({
        where: { id: subscriber.id, token },
        data: { confirmedAt: null, confirmTokenHash: null, confirmExpiresAt: null, confirmUsedAt: null },
      }),
  };
}

/**
 * The request a confirmation link (`confirm`, its own token) was emailed for: only the latest request's (a newer one
 * replaces it, unsubscribing voids it), within CONFIRM_LINK_HOURS. Null otherwise. It confirms only while `live`
 * (unused); once `used`, it only says so. `optedOut`: the address has turned all of the project's emails off, so
 * confirming turns them back on too (the link, emailed to it just now, shows it's theirs).
 */
export async function findConfirmation(projectSlug: string, confirm: string) {
  const confirmTokenHash = hashSecret(confirm);
  const subscriber = confirm
    ? await prisma.changelogSubscriber.findFirst({
        where: { confirmTokenHash, confirmExpiresAt: { gt: new Date() }, project: { slug: projectSlug } },
        select: { ...select, confirmUsedAt: true },
      })
    : null;
  if (!subscriber) {
    return null;
  }
  const { id, projectId, email } = subscriber;
  return {
    ...subscriber,
    live: subscriber.confirmUsedAt === null,
    used: subscriber.confirmUsedAt !== null,
    optedOut: await optedOut(projectId, email),
    /**
     * Confirms (with `emailsOn`, the opted-out page's button, turning the project's emails back on at the address too:
     * every account's opt-out there), once: the same token, unused and unexpired, checked as it writes, so a link
     * replaced or used meanwhile does nothing. Not while the portal's private: nothing is emailed from one (changelogEmailed).
     */
    confirm: (emailsOn: boolean) =>
      prisma.$transaction(async (tx) => {
        const now = new Date();
        const { count } = await tx.changelogSubscriber.updateMany({
          where: { id, confirmTokenHash, confirmExpiresAt: { gt: now }, confirmUsedAt: null, project: { portalAccess: "PUBLIC" } },
          data: { confirmedAt: now, confirmUsedAt: now },
        });
        if (count === 1 && emailsOn) {
          await tx.emailOptOut.deleteMany({
            where: {
              projectId,
              user: {
                OR: [
                  { email: { equals: email, mode: "insensitive" } },
                  { ssoIdentity: { projectId, email: { equals: email, mode: "insensitive" } } },
                ],
              },
            },
          });
        }
        return count === 1;
      }),
  };
}
